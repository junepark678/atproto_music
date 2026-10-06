#[path = "support/signed_repo.rs"]
mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::{
    http::safe_client::{DnsResolver, FetchError, HttpResponse, HttpTransport, SafeClient},
    identity::IdentityResolver,
    sync::{
        accounts::{AccountReconciler, AccountSource, AccountStatus, PdsAccountSource},
        apply::{ApplyContext, apply_commit},
        backfill::{
            BackfillCoordinator, BackfillError, FetchedSnapshot, PdsSnapshotSource, ReceiptClock,
            SnapshotSource,
        },
        verify::{
            SigningKeyResolver, TrustedSigningKey, UnavailableSigningKeyResolver, VerificationError,
        },
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_storage::{Database, PageBounds, SnapshotOutcome, User};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use signed_repo::{
    ALICE, FixtureResolver, SignedFixture, signed_mutation, signed_repo, signed_repo_for,
};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use url::Url;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
struct Clock;
impl ReceiptClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        now()
    }
}
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
fn record(track: &str) -> Value {
    json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":track,"listenedAt":"2026-01-14T11:00:00Z","createdAt":"2026-01-14T11:00:00Z"})
}
fn records() -> Vec<(String, Value)> {
    vec![
        ("com.example.atmusic.scrobble/r01".into(), record("Jóga")),
        (
            "com.example.atmusic.scrobble/r02".into(),
            record("Army of Me"),
        ),
    ]
}
async fn db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("fixture.sqlite"))
        .await
        .unwrap();
    db.repositories()
        .upsert_user(User::new(ALICE, now().to_rfc3339()))
        .await
        .unwrap();
    (dir, db)
}
async fn rows(db: &Database) -> Vec<atmusic_storage::ScrobbleRow> {
    db.repositories()
        .history(
            ALICE,
            PageBounds {
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

struct Source {
    bytes: Mutex<Vec<u8>>,
}
#[async_trait]
impl SnapshotSource for Source {
    async fn fetch(&self, _: &str) -> Result<FetchedSnapshot, BackfillError> {
        Ok(FetchedSnapshot {
            pds: "https://pds.fixture.music/".into(),
            bytes: self.bytes.lock().unwrap().clone(),
        })
    }
}
fn coordinator(
    db: &Database,
    source: Arc<dyn SnapshotSource>,
    resolver: Arc<dyn SigningKeyResolver>,
) -> Arc<BackfillCoordinator> {
    Arc::new(BackfillCoordinator::new(
        db.repositories(),
        namespace(),
        source,
        resolver,
        Arc::new(Clock),
    ))
}

#[tokio::test]
async fn historical_seed() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let worker = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(fixture.event.blocks),
        }),
        Arc::new(FixtureResolver(fixture.key)),
    );
    assert!(rows(&db).await.is_empty());
    worker.schedule(ALICE, false).await.unwrap();
    let results = worker.run_batch().await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    let actual = rows(&db).await;
    assert_eq!(actual.len(), 2);
    assert!(
        actual
            .iter()
            .all(|r| r.confirmed && r.revision == signed_repo::REVISION && !r.cid.is_empty())
    );
    let status = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(status.backfill_complete);
    assert_eq!(status.state, "complete");
    db.close().await;
}

#[tokio::test]
async fn snapshot_live_race() {
    let (_dir, db) = db().await;
    let old = signed_repo(records(), 7).await;
    let updated = signed_mutation(
        &old,
        "com.example.atmusic.scrobble/r01",
        Some(record("New verified title")),
        7,
        "3m4zm2ufr2223",
    )
    .await;
    let deleted = signed_mutation(
        &updated,
        "com.example.atmusic.scrobble/r02",
        None,
        7,
        "3m4zm2ufr2224",
    )
    .await;
    let source = Arc::new(Source {
        bytes: Mutex::new(old.event.blocks.clone()),
    });
    let resolver = Arc::new(FixtureResolver(old.key.clone()));
    let worker = coordinator(&db, source.clone(), resolver.clone());
    worker.schedule(ALICE, false).await.unwrap();
    worker.run_batch().await.unwrap();
    worker.schedule(ALICE, false).await.unwrap();
    for event in [&updated.event, &deleted.event] {
        apply_commit(
            &db.repositories(),
            event,
            ApplyContext {
                relay: "fixture",
                expected_did: ALICE,
                namespace: &namespace(),
                receipt_time: now(),
                resolver: resolver.as_ref(),
            },
        )
        .await
        .unwrap();
    }
    let result = worker.run_batch().await.unwrap();
    assert_eq!(result[0].result.as_ref().unwrap(), &SnapshotOutcome::Stale);
    let actual = rows(&db).await;
    assert_eq!(actual.len(), 1);
    assert_eq!(actual[0].track, "New verified title");
    assert_eq!(actual[0].revision, "3m4zm2ufr2223");
    assert!(
        !db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    *source.bytes.lock().unwrap() = deleted.event.blocks;
    worker.run_batch().await.unwrap();
    let actual = rows(&db).await;
    assert_eq!(actual.len(), 1);
    assert_eq!(actual[0].track, "New verified title");
    assert_eq!(actual[0].revision, "3m4zm2ufr2224");
    assert!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    assert_eq!(
        db.repositories()
            .checkpoint("fixture")
            .await
            .unwrap()
            .unwrap()
            .sequence,
        3
    );
    db.close().await;
}

struct Keys(Mutex<BTreeMap<String, TrustedSigningKey>>);
#[async_trait]
impl SigningKeyResolver for Keys {
    async fn resolve_for_revision(
        &self,
        did: &str,
        _: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        self.0
            .lock()
            .unwrap()
            .get(did)
            .cloned()
            .ok_or(VerificationError::UntrustedIdentity)
    }
}
struct HeldSource {
    snapshots: BTreeMap<String, Vec<u8>>,
    entered: AtomicUsize,
    gate: tokio::sync::Semaphore,
}
#[async_trait]
impl SnapshotSource for HeldSource {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let permit = self.gate.acquire().await.unwrap();
        permit.forget();
        Ok(FetchedSnapshot {
            pds: "https://pds.fixture.music/".into(),
            bytes: self.snapshots.get(did).unwrap().clone(),
        })
    }
}
#[tokio::test]
async fn backfill_limits() {
    let (_dir, db) = db().await;
    let mut snapshots = BTreeMap::new();
    let mut keys = BTreeMap::new();
    let actors: Vec<_> = (0..4)
        .map(|i| format!("did:web:active{i}.fixture.music"))
        .collect();
    for (i, did) in actors.iter().enumerate() {
        db.repositories()
            .upsert_user(User::new(did, now().to_rfc3339()))
            .await
            .unwrap();
        let f = signed_repo_for(did, records(), i as u8 + 7, signed_repo::REVISION).await;
        snapshots.insert(did.clone(), f.event.blocks);
        keys.insert(did.clone(), f.key);
    }
    let source = Arc::new(HeldSource {
        snapshots,
        entered: AtomicUsize::new(0),
        gate: tokio::sync::Semaphore::new(0),
    });
    let worker = coordinator(&db, source.clone(), Arc::new(Keys(Mutex::new(keys))));
    for did in &actors {
        worker.schedule(did, false).await.unwrap();
    }
    let task = {
        let w = worker.clone();
        tokio::spawn(async move { w.run_batch().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while source.entered.load(Ordering::SeqCst) < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(worker.active(), 4);
    for i in 0..1025 {
        let did = format!("did:web:queued{i}.fixture.music");
        db.repositories()
            .upsert_user(User::new(&did, now().to_rfc3339()))
            .await
            .unwrap();
        let result = worker.schedule(&did, false).await;
        if i < 1024 {
            assert!(result.unwrap().is_some());
        } else {
            assert!(matches!(result, Err(BackfillError::Busy)));
        }
    }
    let queued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM repo_backfills WHERE state='pending'")
            .fetch_one(db.reader_pool())
            .await
            .unwrap();
    assert_eq!(queued, 1024);
    assert_eq!(worker.active(), 4);
    assert_eq!(source.entered.load(Ordering::SeqCst), 4);
    source.gate.add_permits(4);
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.len(), 4);
    assert!(
        result
            .iter()
            .all(|r| matches!(r.result, Ok(SnapshotOutcome::Complete)))
    );
    assert_eq!(worker.active(), 0);
    db.close().await;
}

struct Dns;
#[async_trait]
impl DnsResolver for Dns {
    async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, FetchError> {
        Ok(vec!["93.184.216.34".parse().unwrap()])
    }
    async fn txt(&self, _: &str) -> Result<Vec<String>, FetchError> {
        Ok(vec![])
    }
}
struct Network {
    bytes: Mutex<Vec<u8>>,
    migrated: AtomicBool,
    active: AtomicBool,
    requests: Mutex<Vec<Url>>,
}
#[async_trait]
impl HttpTransport for Network {
    async fn fetch(&self, url: &Url, _: &[SocketAddr]) -> Result<HttpResponse, FetchError> {
        self.requests.lock().unwrap().push(url.clone());
        let pds = if self.migrated.load(Ordering::SeqCst) {
            "https://pds-b.fixture.music"
        } else {
            "https://pds-a.fixture.music"
        };
        let (mime, body) = if url.host_str() == Some("plc.directory") {
            ("application/json",serde_json::to_vec(&json!({"id":ALICE,"service":[{"id":"#atproto_pds","type":"AtprotoPersonalDataServer","serviceEndpoint":pds}]})).unwrap())
        } else if url.path().ends_with("getRepoStatus") {
            (
                "application/json",
                serde_json::to_vec(
                    &json!({"did":ALICE,"active":self.active.load(Ordering::SeqCst)}),
                )
                .unwrap(),
            )
        } else {
            assert_eq!(url.host_str(), Url::parse(pds).unwrap().host_str());
            (
                "application/vnd.ipld.car",
                self.bytes.lock().unwrap().clone(),
            )
        };
        Ok(HttpResponse {
            status: 200,
            headers: BTreeMap::from([("content-type".into(), mime.into())]),
            body,
        })
    }
}
async fn network_worker(
    db: &Database,
    fixture: &SignedFixture,
) -> (Arc<Network>, Arc<BackfillCoordinator>, AccountReconciler) {
    let network = Arc::new(Network {
        bytes: Mutex::new(fixture.event.blocks.clone()),
        migrated: AtomicBool::new(false),
        active: AtomicBool::new(true),
        requests: Mutex::new(vec![]),
    });
    let client = SafeClient::new(Arc::new(Dns), network.clone());
    let identity = IdentityResolver::new(client.clone());
    let backfills = coordinator(
        db,
        Arc::new(PdsSnapshotSource::new(identity.clone(), client.clone())),
        Arc::new(FixtureResolver(fixture.key.clone())),
    );
    let accounts = AccountReconciler::new(
        db.repositories(),
        Arc::new(PdsAccountSource::new(identity, client)),
        backfills.clone(),
    );
    (network, backfills, accounts)
}
#[tokio::test]
async fn pds_migration() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let (network, worker, accounts) = network_worker(&db, &fixture).await;
    worker.schedule(ALICE, false).await.unwrap();
    worker.run_batch().await.unwrap();
    let before = rows(&db).await;
    assert_eq!(before.len(), 2);
    network.migrated.store(true, Ordering::SeqCst);
    accounts
        .reconcile(ALICE, &now().to_rfc3339())
        .await
        .unwrap();
    worker.run_batch().await.unwrap();
    let after = rows(&db).await;
    assert_eq!(
        after.iter().map(|r| (&r.uri, &r.cid)).collect::<Vec<_>>(),
        before.iter().map(|r| (&r.uri, &r.cid)).collect::<Vec<_>>()
    );
    assert!(after.iter().all(|r| r.did == ALICE));
    let requests = network.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .any(|u| u.host_str() == Some("pds-b.fixture.music") && u.path().ends_with("getRepo"))
    );
    assert_eq!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .pds
            .as_deref(),
        Some("https://pds-b.fixture.music/")
    );
    drop(requests);
    db.close().await;
}
#[tokio::test]
async fn deactivate_reactivate() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let (network, worker, accounts) = network_worker(&db, &fixture).await;
    worker.schedule(ALICE, false).await.unwrap();
    worker.run_batch().await.unwrap();
    assert_eq!(rows(&db).await.len(), 2);
    network.active.store(false, Ordering::SeqCst);
    accounts
        .reconcile(ALICE, &now().to_rfc3339())
        .await
        .unwrap();
    assert!(rows(&db).await.is_empty());
    assert!(
        db.repositories()
            .feed(
                None,
                PageBounds {
                    limit: 100,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .is_empty()
    );
    network.active.store(true, Ordering::SeqCst);
    accounts
        .reconcile(ALICE, &now().to_rfc3339())
        .await
        .unwrap();
    assert!(rows(&db).await.is_empty());
    assert!(!db.repositories().indexing(ALICE).await.unwrap().caught_up);
    worker.run_batch().await.unwrap();
    assert_eq!(rows(&db).await.len(), 2);
    assert_eq!(
        db.repositories()
            .feed(
                None,
                PageBounds {
                    limit: 100,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .len(),
        2
    );
    db.repositories()
        .disconnect(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    accounts
        .reconcile(ALICE, &now().to_rfc3339())
        .await
        .unwrap();
    assert!(worker.schedule(ALICE, true).await.unwrap().is_none());
    assert!(worker.run_batch().await.unwrap().is_empty());
    assert!(rows(&db).await.is_empty());
    db.close().await;
}
#[tokio::test]
async fn untrusted_snapshot_cannot_complete_or_reactivate() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let worker = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(fixture.event.blocks),
        }),
        Arc::new(UnavailableSigningKeyResolver),
    );
    worker.schedule(ALICE, true).await.unwrap();
    let result = worker.run_batch().await.unwrap();
    assert!(matches!(
        result[0].result,
        Err(BackfillError::Verification(
            VerificationError::UntrustedIdentity
        ))
    ));
    assert!(rows(&db).await.is_empty());
    assert!(
        db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_none()
    );
    let status = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(status.state, "failed");
    assert!(!status.backfill_complete);
    db.close().await;
}

#[tokio::test]
async fn incomplete_signed_snapshot_cannot_prove_deletions() {
    use atmusic_atproto::sync::verify::content_addressed_car_blocks;
    use atrium_repo::blockstore::{AsyncBlockStoreWrite, CarStore};
    use ipld_core::{cid::Cid, ipld::Ipld};
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let blocks = content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let Ipld::Map(commit) =
        serde_ipld_dagcbor::from_slice(&blocks[&fixture.event.commit.to_string()]).unwrap()
    else {
        panic!("commit map")
    };
    let Ipld::Link(data) = commit["data"] else {
        panic!("MST link")
    };
    let mut sliced = Vec::new();
    let mut car =
        CarStore::create_with_roots(std::io::Cursor::new(&mut sliced), [fixture.event.commit])
            .await
            .unwrap();
    for (cid, bytes) in blocks {
        let cid: Cid = cid.parse().unwrap();
        if cid != data {
            assert_eq!(
                car.write_block(cid.codec(), 0x12, &bytes).await.unwrap(),
                cid
            );
        }
    }
    drop(car);
    let worker = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(sliced),
        }),
        Arc::new(FixtureResolver(fixture.key)),
    );
    worker.schedule(ALICE, false).await.unwrap();
    let result = worker.run_batch().await.unwrap();
    assert!(result[0].result.is_err());
    assert!(rows(&db).await.is_empty());
    assert!(
        !db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    db.close().await;
}

#[tokio::test]
async fn snapshot_completion_fault_rolls_back_projection() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let worker = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(fixture.event.blocks),
        }),
        Arc::new(FixtureResolver(fixture.key)),
    );
    worker.schedule(ALICE, false).await.unwrap();
    db.writer().execute(|c|Box::pin(async move {sqlx::query("CREATE TRIGGER reject_backfill_completion BEFORE UPDATE ON repo_backfills WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END").execute(c).await?;Ok(())})).await.unwrap();
    let result = worker.run_batch().await.unwrap();
    assert!(result[0].result.is_err());
    assert!(rows(&db).await.is_empty());
    let status = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(status.state, "failed");
    assert!(!status.backfill_complete);
    db.writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_backfill_completion")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    worker.run_batch().await.unwrap();
    assert_eq!(rows(&db).await.len(), 2);
    assert!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    db.close().await;
}

#[tokio::test]
async fn newer_deactivation_invalidates_in_flight_reactivation() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let source = Arc::new(HeldSource {
        snapshots: BTreeMap::from([(ALICE.into(), fixture.event.blocks)]),
        entered: AtomicUsize::new(0),
        gate: tokio::sync::Semaphore::new(0),
    });
    let worker = coordinator(&db, source.clone(), Arc::new(FixtureResolver(fixture.key)));
    worker.schedule(ALICE, true).await.unwrap();
    let task = {
        let w = worker.clone();
        tokio::spawn(async move { w.run_batch().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while source.entered.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    db.repositories()
        .account_inactive(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    source.gate.add_permits(1);
    let result = task.await.unwrap().unwrap();
    assert_eq!(
        result[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Superseded
    );
    assert!(
        db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_none()
    );
    assert!(rows(&db).await.is_empty());
    assert!(
        !db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    db.close().await;
}

#[tokio::test]
async fn cancelled_running_backfill_is_durable_and_retryable() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let source = Arc::new(HeldSource {
        snapshots: BTreeMap::from([(ALICE.into(), fixture.event.blocks.clone())]),
        entered: AtomicUsize::new(0),
        gate: tokio::sync::Semaphore::new(0),
    });
    let resolver = Arc::new(FixtureResolver(fixture.key));
    let worker = coordinator(&db, source.clone(), resolver.clone());
    worker.schedule(ALICE, false).await.unwrap();
    let task = {
        let w = worker.clone();
        tokio::spawn(async move { w.run_batch().await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while source.entered.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while worker.active() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let durable = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(durable.state, "running");
    assert!(!durable.backfill_complete);
    let restarted = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(fixture.event.blocks),
        }),
        resolver,
    );
    let result = restarted.run_batch().await.unwrap();
    assert_eq!(
        result[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    assert_eq!(rows(&db).await.len(), 2);
    db.close().await;
}

#[tokio::test]
async fn ordinary_recovery_preserves_pending_reactivation() {
    let (_dir, db) = db().await;
    let fixture = signed_repo(records(), 7).await;
    let expected_cids: Vec<_> = fixture
        .record_cids
        .iter()
        .map(ToString::to_string)
        .collect();
    let worker = coordinator(
        &db,
        Arc::new(Source {
            bytes: Mutex::new(fixture.event.blocks),
        }),
        Arc::new(FixtureResolver(fixture.key)),
    );
    let authorized = worker.schedule(ALICE, true).await.unwrap().unwrap();
    assert!(authorized.reactivate);
    assert!(rows(&db).await.is_empty());
    let recovery = worker.schedule(ALICE, false).await.unwrap().unwrap();
    assert!(
        recovery.reactivate,
        "ordinary recovery must preserve explicit authorization"
    );
    assert!(recovery.generation > authorized.generation);
    assert!(
        db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_none()
    );
    let result = worker.run_batch().await.unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        result[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    assert!(
        db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_some()
    );
    let actual = rows(&db).await;
    assert_eq!(actual.len(), 2);
    assert!(actual.iter().all(|row| expected_cids.contains(&row.cid)));
    let completed = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert!(completed.backfill_complete);

    // Explicit account deactivation clears authorization to reactivate. An ordinary
    // complete recovery may refresh rows while public visibility stays inactive.
    db.repositories()
        .account_inactive(ALICE.into(), now().to_rfc3339())
        .await
        .unwrap();
    assert!(
        !db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .reactivate
    );
    let inactive_recovery = worker.schedule(ALICE, false).await.unwrap().unwrap();
    assert!(!inactive_recovery.reactivate);
    let result = worker.run_batch().await.unwrap();
    assert_eq!(
        result[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    assert!(
        db.repositories()
            .active_user(ALICE)
            .await
            .unwrap()
            .is_none()
    );
    assert!(rows(&db).await.is_empty());
    assert!(
        db.repositories()
            .feed(None, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles WHERE did=?")
            .bind(ALICE)
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        2
    );
    assert!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    db.close().await;
}

struct HeldAccountStatus {
    active: bool,
    entered: tokio::sync::Notify,
    gate: tokio::sync::Semaphore,
    calls: AtomicUsize,
}
impl HeldAccountStatus {
    fn new(active: bool) -> Self {
        Self {
            active,
            entered: tokio::sync::Notify::new(),
            gate: tokio::sync::Semaphore::new(0),
            calls: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl AccountSource for HeldAccountStatus {
    async fn current(&self, did: &str) -> Result<AccountStatus, BackfillError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.gate.acquire().await.unwrap().forget();
        Ok(AccountStatus {
            did: did.into(),
            pds: "https://pds.fixture.music/".into(),
            active: self.active,
        })
    }
}

#[tokio::test]
async fn stale_account_reconciliation_preserves_fresh_authorization() {
    use atmusic_atproto::oauth::token_store::TokenStore;
    // Exercise stale inactive and active results, both pending and completed authorization.
    for (status_active, disconnect, complete_first) in [
        (false, false, false),
        (false, true, true),
        (true, true, true),
    ] {
        let (_dir, db) = db().await;
        let fixture = signed_repo(records(), 7).await;
        let worker = coordinator(
            &db,
            Arc::new(Source {
                bytes: Mutex::new(fixture.event.blocks),
            }),
            Arc::new(FixtureResolver(fixture.key)),
        );
        worker.schedule(ALICE, false).await.unwrap();
        worker.run_batch().await.unwrap();
        assert_eq!(rows(&db).await.len(), 2);
        if !disconnect {
            // A pending explicit reactivation survives reauthorization of an existing owner.
            worker.schedule(ALICE, true).await.unwrap();
        }
        let old_generation = db
            .repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .generation;
        let source = Arc::new(HeldAccountStatus::new(status_active));
        let accounts = Arc::new(AccountReconciler::new(
            db.repositories(),
            source.clone(),
            worker.clone(),
        ));
        let task = {
            let accounts = accounts.clone();
            tokio::spawn(async move { accounts.reconcile(ALICE, &now().to_rfc3339()).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), source.entered.notified())
            .await
            .unwrap();
        if disconnect {
            db.repositories()
                .disconnect(ALICE.into(), now().to_rfc3339())
                .await
                .unwrap();
        }
        let store = TokenStore::new(db.repositories(), &[9; 32]).unwrap();
        let tokens = json!({"did":ALICE,"issuer":"https://issuer.fixture.music","access_token":"fresh-authorization","expires_at":now().timestamp()+3600});
        store
            .put_authorized_oauth_tokens(ALICE, &tokens, now().timestamp())
            .await
            .unwrap();
        let fresh = db.repositories().backfill(ALICE).await.unwrap().unwrap();
        assert!(fresh.generation > old_generation);
        assert!(fresh.reactivate);
        assert!(!db.repositories().user(ALICE).await.unwrap().unwrap().active);
        if complete_first {
            let result = worker.run_batch().await.unwrap();
            assert_eq!(
                result[0].result.as_ref().unwrap(),
                &SnapshotOutcome::Complete
            );
            assert_eq!(rows(&db).await.len(), 2);
        }
        source.gate.add_permits(1);
        assert!(matches!(
            task.await.unwrap(),
            Err(BackfillError::AccountChanged)
        ));
        let after = db.repositories().backfill(ALICE).await.unwrap().unwrap();
        assert_eq!(after.generation, fresh.generation);
        assert!(after.reactivate);
        assert_eq!(after.backfill_complete, complete_first);
        assert_eq!(
            db.repositories().user(ALICE).await.unwrap().unwrap().active,
            complete_first
        );
        assert_eq!(store.get_oauth_tokens(ALICE).await.unwrap(), Some(tokens));
        if !complete_first {
            let result = worker.run_batch().await.unwrap();
            assert_eq!(
                result[0].result.as_ref().unwrap(),
                &SnapshotOutcome::Complete
            );
            assert_eq!(rows(&db).await.len(), 2);
        }
        db.close().await;
    }
}

#[tokio::test]
async fn disconnect_during_account_reconciliation_keeps_local_state_removed() {
    for status_active in [false, true] {
        let (_dir, db) = db().await;
        let fixture = signed_repo(records(), 7).await;
        let worker = coordinator(
            &db,
            Arc::new(Source {
                bytes: Mutex::new(fixture.event.blocks),
            }),
            Arc::new(FixtureResolver(fixture.key)),
        );
        // No job initially: reconciliation must establish its durable generation before await.
        assert!(db.repositories().backfill(ALICE).await.unwrap().is_none());
        let source = Arc::new(HeldAccountStatus::new(status_active));
        let accounts = Arc::new(AccountReconciler::new(
            db.repositories(),
            source.clone(),
            worker.clone(),
        ));
        let task = {
            let accounts = accounts.clone();
            tokio::spawn(async move { accounts.reconcile(ALICE, &now().to_rfc3339()).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), source.entered.notified())
            .await
            .unwrap();
        assert!(db.repositories().backfill(ALICE).await.unwrap().is_some());
        db.repositories()
            .disconnect(ALICE.into(), now().to_rfc3339())
            .await
            .unwrap();
        source.gate.add_permits(1);
        assert!(matches!(
            task.await.unwrap(),
            Err(BackfillError::AccountChanged)
        ));
        assert!(db.repositories().user(ALICE).await.unwrap().is_none());
        assert!(db.repositories().backfill(ALICE).await.unwrap().is_none());
        assert!(db.repositories().is_suppressed(ALICE).await.unwrap());
        let scope_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM indexing_status WHERE scope=?")
                .bind(ALICE)
                .fetch_one(db.reader_pool())
                .await
                .unwrap();
        assert_eq!(scope_count, 0);
        assert!(worker.run_batch().await.unwrap().is_empty());
        // Unknown/suppressed DIDs do not cause another upstream lookup.
        accounts
            .reconcile(ALICE, &now().to_rfc3339())
            .await
            .unwrap();
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        db.close().await;
    }
}
