#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
use async_trait::async_trait;
use atmusic_atproto::sync::{
    backfill::{BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource},
    frames::{Action, CommitEvent, MAX_FRAME_BYTES},
    stream::{ReconnectClock, ReconnectJitter, RelayConnection, RelayTransport, StreamError},
    verify::{SigningKeyResolver, UnavailableSigningKeyResolver},
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_server::{
    http::index_status,
    workers::relay::{RelayDependencies, RelayObserver, RelayWorker},
};
use atmusic_storage::{Database, Indexing, PageBounds, User};
use chrono::{DateTime, Utc};
use ipld_core::ipld::Ipld;
use serde_json::json;
use signed_repo::{ALICE, FixtureResolver, SignedFixture, signed_repo as signed};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use url::Url;
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
const RELAY: &str = "wss://relay.fixture.music/";
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
struct Clock {
    waits: Mutex<Vec<Duration>>,
}
impl ReceiptClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        now()
            + chrono::Duration::seconds(
                self.waits
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_secs() as i64)
                    .sum(),
            )
    }
}
#[async_trait]
impl ReconnectClock for Clock {
    async fn sleep(&self, delay: Duration) {
        self.waits.lock().unwrap().push(delay);
        tokio::task::yield_now().await;
    }
}
struct ZeroJitter;
impl ReconnectJitter for ZeroJitter {
    fn millis(&self, _: Duration) -> u64 {
        0
    }
}
struct Source(Vec<u8>);
#[async_trait]
impl SnapshotSource for Source {
    async fn fetch(&self, _: &str) -> Result<FetchedSnapshot, BackfillError> {
        Ok(FetchedSnapshot {
            pds: "https://pds.fixture.music/".into(),
            bytes: self.0.clone(),
        })
    }
}
struct Connection {
    frames: VecDeque<Vec<u8>>,
}
#[async_trait]
impl RelayConnection for Connection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        Ok(self.frames.pop_front())
    }
}
struct Transport {
    sessions: Mutex<VecDeque<Vec<Vec<u8>>>>,
    requests: Mutex<Vec<Url>>,
    fail: bool,
}
#[async_trait]
impl RelayTransport for Transport {
    async fn connect(
        &self,
        url: &Url,
        max: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        assert_eq!(max, MAX_FRAME_BYTES);
        self.requests.lock().unwrap().push(url.clone());
        if self.fail {
            Err(StreamError::Transport)
        } else {
            Ok(Box::new(Connection {
                frames: self
                    .sessions
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_default()
                    .into(),
            }))
        }
    }
}
struct Observer(AtomicUsize);
impl RelayObserver for Observer {
    fn verification_rejected(&self, _: &str) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
fn map(fields: impl IntoIterator<Item = (&'static str, Ipld)>) -> Ipld {
    Ipld::Map(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn frame(header: Ipld, body: Ipld) -> Vec<u8> {
    let mut bytes = serde_ipld_dagcbor::to_vec(&header).unwrap();
    bytes.extend(serde_ipld_dagcbor::to_vec(&body).unwrap());
    bytes
}
fn error(code: &str) -> Vec<u8> {
    frame(
        map([("op", Ipld::Integer(-1))]),
        map([("error", Ipld::String(code.into()))]),
    )
}
fn commit(event: &CommitEvent) -> Vec<u8> {
    let ops = event
        .operations
        .iter()
        .map(|op| {
            map([
                (
                    "action",
                    Ipld::String(
                        match op.action {
                            Action::Create => "create",
                            Action::Update => "update",
                            Action::Delete => "delete",
                        }
                        .into(),
                    ),
                ),
                ("path", Ipld::String(op.path.clone())),
                ("cid", op.cid.map(Ipld::Link).unwrap_or(Ipld::Null)),
            ])
        })
        .collect();
    frame(
        map([
            ("op", Ipld::Integer(1)),
            ("t", Ipld::String("#commit".into())),
        ]),
        map([
            ("seq", Ipld::Integer(event.sequence.into())),
            ("repo", Ipld::String(event.did.clone())),
            ("rev", Ipld::String(event.revision.clone())),
            (
                "since",
                event.since.clone().map(Ipld::String).unwrap_or(Ipld::Null),
            ),
            ("commit", Ipld::Link(event.commit)),
            ("time", Ipld::String(event.time.clone())),
            ("blocks", Ipld::Bytes(event.blocks.clone())),
            ("ops", Ipld::List(ops)),
            ("tooBig", Ipld::Bool(false)),
        ]),
    )
}
async fn fixture() -> SignedFixture {
    signed(vec![("com.example.atmusic.scrobble/r01".into(),json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"}))],7).await
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
fn worker(
    db: &Database,
    f: &SignedFixture,
    transport: Arc<Transport>,
    clock: Arc<Clock>,
    resolver: Arc<dyn SigningKeyResolver>,
) -> (RelayWorker, Arc<BackfillCoordinator>) {
    let backfills = Arc::new(BackfillCoordinator::new(
        db.repositories(),
        namespace(),
        Arc::new(Source(f.event.blocks.clone())),
        resolver.clone(),
        clock.clone(),
    ));
    (
        RelayWorker::new(
            db.repositories(),
            RELAY.into(),
            namespace(),
            RelayDependencies {
                transport,
                resolver,
                clock,
                backfills: backfills.clone(),
            },
        )
        .with_jitter(Arc::new(ZeroJitter)),
        backfills,
    )
}

#[tokio::test]
async fn resume() {
    let (_dir, db) = db().await;
    let mut f = fixture().await;
    f.event.sequence = 42;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([
            vec![commit(&f.event)],
            vec![commit(&f.event)],
        ])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, _) = worker(
        &db,
        &f,
        transport.clone(),
        clock,
        Arc::new(FixtureResolver(f.key.clone())),
    );
    let first = worker.run_session().await.unwrap();
    assert_eq!(first.applied, 1);
    assert_eq!(
        db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        42
    );
    let second = worker.run_session().await.unwrap();
    assert_eq!(second.applied, 0);
    assert_eq!(second.replayed, 1);
    assert_eq!(
        db.repositories()
            .history(
                ALICE,
                PageBounds {
                    limit: 100,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .len(),
        1
    );
    let requests = transport.requests.lock().unwrap().clone();
    assert_eq!(requests[0].query(), None);
    assert_eq!(requests[1].query(), Some("cursor=42"));
    drop(requests);
    db.close().await;
}
#[tokio::test]
async fn expired_cursor() {
    for code in ["FutureCursor", "OutdatedCursor"] {
        let (_dir, db) = db().await;
        let mut f = fixture().await;
        f.event.sequence = 42;
        let transport = Arc::new(Transport {
            sessions: Mutex::new(VecDeque::from([vec![commit(&f.event)], vec![error(code)]])),
            requests: Mutex::new(vec![]),
            fail: false,
        });
        let clock = Arc::new(Clock {
            waits: Mutex::new(vec![]),
        });
        let (worker, backfills) = worker(
            &db,
            &f,
            transport,
            clock,
            Arc::new(FixtureResolver(f.key.clone())),
        );
        worker.run_session().await.unwrap();
        let result = worker.run_session().await.unwrap();
        assert!(result.recovery_requested);
        let recovery = db
            .repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
        assert!(recovery.pending_gap);
        assert!(!recovery.connected);
        assert_eq!(recovery.reason.as_deref(), Some(code));
        let job = db.repositories().backfill(ALICE).await.unwrap().unwrap();
        assert!(!job.backfill_complete);
        assert_eq!(job.state, "pending");
        assert_eq!(
            db.repositories()
                .checkpoint(RELAY)
                .await
                .unwrap()
                .unwrap()
                .sequence,
            42
        );
        assert!(worker.run_session().await.is_err());
        assert_eq!(
            db.repositories()
                .checkpoint(RELAY)
                .await
                .unwrap()
                .unwrap()
                .sequence,
            42
        );
        assert_eq!(backfills.run_batch().await.unwrap().len(), 1);
        assert!(
            db.repositories()
                .backfill(ALICE)
                .await
                .unwrap()
                .unwrap()
                .backfill_complete
        );
        worker.run_session().await.unwrap();
        assert!(db.repositories().checkpoint(RELAY).await.unwrap().is_none());
        let recovery = db
            .repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovery.prior_sequence, Some(42));
        assert!(recovery.pending_gap);
        db.close().await;
    }
}
#[tokio::test]
async fn bounded_reconnect() {
    let (_dir, db) = db().await;
    let f = fixture().await;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::new()),
        requests: Mutex::new(vec![]),
        fail: true,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, _) = worker(
        &db,
        &f,
        transport.clone(),
        clock.clone(),
        Arc::new(FixtureResolver(f.key.clone())),
    );
    let start = clock.now();
    let expected = [1, 2, 4, 8, 16, 32, 60, 60, 60];
    for seconds in expected {
        assert!(worker.run_session().await.is_err());
        assert_eq!(
            worker.wait_to_reconnect().await,
            Duration::from_secs(seconds)
        );
    }
    assert_eq!(
        *clock.waits.lock().unwrap(),
        expected.map(Duration::from_secs)
    );
    assert_eq!(transport.requests.lock().unwrap().len(), expected.len());
    assert_eq!(
        (clock.now() - start).num_seconds(),
        expected.iter().sum::<u64>() as i64
    );
    db.close().await;
}
#[tokio::test]
async fn status_truth() {
    let (_dir, db) = db().await;
    let f = fixture().await;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([vec![commit(&f.event)]])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, backfills) = worker(
        &db,
        &f,
        transport,
        clock,
        Arc::new(FixtureResolver(f.key.clone())),
    );
    worker.run_session().await.unwrap();
    db.repositories()
        .set_indexing(
            "global".into(),
            Indexing {
                state: "current".into(),
                caught_up: true,
                last_indexed_at: Some(now().to_rfc3339()),
                lag_seconds: Some(0),
            },
        )
        .await
        .unwrap();
    let status = index_status::read(&db.repositories(), Some(RELAY), "global", now())
        .await
        .unwrap();
    assert!(status.pending_gap);
    assert_eq!(status.last_sequence, Some(1));
    assert_eq!(
        DateTime::parse_from_rfc3339(status.last_event_at.as_deref().unwrap())
            .unwrap()
            .with_timezone(&Utc),
        now()
    );
    assert_eq!(status.indexing.lag_seconds, Some(0));
    assert!(!status.indexing.caught_up);
    assert_eq!(status.indexing.state, "recovering");
    backfills.schedule(ALICE, false).await.unwrap();
    let status = index_status::read(&db.repositories(), Some(RELAY), ALICE, now())
        .await
        .unwrap();
    assert_eq!(status.pending_backfills, 1);
    assert!(!status.indexing.caught_up);
    assert_eq!(status.indexing.state, "recovering");
    db.close().await;
}
#[tokio::test]
async fn untrusted_live_commit_records_rejection_and_preserves_checkpoint() {
    let (_dir, db) = db().await;
    let f = fixture().await;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([vec![commit(&f.event)]])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, _) = worker(
        &db,
        &f,
        transport,
        clock,
        Arc::new(UnavailableSigningKeyResolver),
    );
    let observer = Arc::new(Observer(AtomicUsize::new(0)));
    let worker = worker.with_observer(observer.clone());
    assert!(worker.run_session().await.is_err());
    assert_eq!(observer.0.load(Ordering::SeqCst), 1);
    assert!(db.repositories().checkpoint(RELAY).await.unwrap().is_none());
    assert!(
        db.repositories()
            .history(
                ALICE,
                PageBounds {
                    limit: 100,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .pending_gap
    );
    db.close().await;
}

#[tokio::test]
async fn schema_exclusion_counts_once_after_atomic_apply() {
    let (_dir, db) = db().await;
    let f = fixture().await;
    let invalid=signed_repo::signed_mutation(&f,"com.example.atmusic.scrobble/r01",Some(json!({"$type":"com.example.atmusic.scrobble","artist":"   ","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"})),7,"3m4zm2ufr2223").await;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([
            vec![commit(&f.event)],
            vec![commit(&invalid.event)],
            vec![commit(&invalid.event)],
        ])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, _) = worker(
        &db,
        &f,
        transport,
        clock,
        Arc::new(FixtureResolver(f.key.clone())),
    );
    let observer = Arc::new(Observer(AtomicUsize::new(0)));
    let worker = worker.with_observer(observer.clone());
    worker.run_session().await.unwrap();
    assert_eq!(observer.0.load(Ordering::SeqCst), 0);
    worker.run_session().await.unwrap();
    assert_eq!(observer.0.load(Ordering::SeqCst), 1);
    assert!(
        db.repositories()
            .history(
                ALICE,
                PageBounds {
                    limit: 100,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .is_empty()
    );
    let replay = worker.run_session().await.unwrap();
    assert_eq!(replay.replayed, 1);
    assert_eq!(observer.0.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        2
    );
    db.close().await;
}

#[tokio::test]
async fn outage_and_suppression_status_survive_missing_relay() {
    let (_dir, db) = db().await;
    for state in ["stale", "suppressed"] {
        db.repositories()
            .set_indexing(
                "global".into(),
                Indexing {
                    state: state.into(),
                    caught_up: true,
                    last_indexed_at: Some(now().to_rfc3339()),
                    lag_seconds: None,
                },
            )
            .await
            .unwrap();
        let actual = index_status::app_indexing(
            &atmusic_server::AppState::default(),
            &db.repositories(),
            "global",
        )
        .await
        .unwrap();
        assert_eq!(actual.state, state);
        assert!(!actual.caught_up);
    }
    db.close().await;
}

#[tokio::test]
async fn expired_cursor_restart_requires_fresh_snapshot_coverage() {
    let (_dir, db) = db().await;
    let mut f = fixture().await;
    f.event.sequence = 42;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([vec![commit(&f.event)]])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let resolver = Arc::new(FixtureResolver(f.key.clone()));
    let (initial_worker, backfills) =
        worker(&db, &f, transport.clone(), clock.clone(), resolver.clone());
    initial_worker.run_session().await.unwrap();
    backfills.schedule(ALICE, false).await.unwrap();
    backfills.run_batch().await.unwrap();
    assert!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    // Simulate process loss after durable rejection and before any coordinator queue admission.
    db.repositories()
        .reject_relay_cursor(RELAY.into(), "OutdatedCursor".into(), now().to_rfc3339())
        .await
        .unwrap();
    assert!(
        !db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    );
    assert!(
        !db.repositories()
            .prepare_relay_resume(RELAY.into(), now().to_rfc3339())
            .await
            .unwrap()
    );
    assert_eq!(
        db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        42
    );
    drop(initial_worker);
    drop(backfills);
    let (worker, backfills) = worker(&db, &f, transport.clone(), clock, resolver);
    assert!(worker.run_session().await.is_err());
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    assert_eq!(
        db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    backfills.run_batch().await.unwrap();
    worker.run_session().await.unwrap();
    assert!(db.repositories().checkpoint(RELAY).await.unwrap().is_none());
    assert_eq!(
        db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .prior_sequence,
        Some(42)
    );
    db.close().await;
}

#[tokio::test]
async fn expired_cursor_queue_backpressure_does_not_reuse_stale_coverage() {
    let (_dir, db) = db().await;
    let mut f = fixture().await;
    f.event.sequence = 42;
    let transport = Arc::new(Transport {
        sessions: Mutex::new(VecDeque::from([
            vec![commit(&f.event)],
            vec![error("OutdatedCursor")],
        ])),
        requests: Mutex::new(vec![]),
        fail: false,
    });
    let clock = Arc::new(Clock {
        waits: Mutex::new(vec![]),
    });
    let (worker, backfills) = worker(
        &db,
        &f,
        transport,
        clock,
        Arc::new(FixtureResolver(f.key.clone())),
    );
    worker.run_session().await.unwrap();
    backfills.schedule(ALICE, false).await.unwrap();
    backfills.run_batch().await.unwrap();
    for i in 0..1024 {
        let did = format!("did:web:queued{i}.fixture.music");
        db.repositories()
            .upsert_user(User::new(&did, now().to_rfc3339()))
            .await
            .unwrap();
        db.repositories()
            .request_backfill(did, false, now().to_rfc3339())
            .await
            .unwrap();
    }
    let error = worker.run_session().await.unwrap_err();
    assert!(format!("{error:?}").contains("backfill_busy"));
    let old = db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(old.state, "complete");
    assert!(!old.backfill_complete);
    assert_eq!(
        db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        42
    );
    let queued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM repo_backfills WHERE state IN ('pending','failed')",
    )
    .fetch_one(db.reader_pool())
    .await
    .unwrap();
    assert_eq!(queued, 1024);
    // Remove the filler fixture accounts; Alice's pre-error success alone still cannot reset cursor.
    db.writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("DELETE FROM users WHERE did LIKE 'did:web:queued%.fixture.music'")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        !db.repositories()
            .prepare_relay_resume(RELAY.into(), now().to_rfc3339())
            .await
            .unwrap()
    );
    assert!(worker.run_session().await.is_err());
    backfills.run_batch().await.unwrap();
    worker.run_session().await.unwrap();
    assert!(db.repositories().checkpoint(RELAY).await.unwrap().is_none());
    assert_eq!(
        db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .prior_sequence,
        Some(42)
    );
    db.close().await;
}
