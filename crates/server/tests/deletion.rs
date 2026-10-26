//! Full router + authenticated real PDS HTTP boundary + signed CAR absence evidence.
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;
use atmusic_atproto::pds::write::{Jitter, PdsWriteBoundary, WriteOutcome};
use atmusic_server::{
    AppState, Clock, auth::session, config::Config, workers::outbox::OutboxWorker,
};
use atmusic_storage::{Database, OutboxItem, PageBounds, StatisticsWindow, User};
use axum::{
    body::Body,
    http::{HeaderMap, Request},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use write_pds::*;
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
struct ZeroJitter;
impl Jitter for ZeroJitter {
    fn milliseconds(&self, _: u64) -> u64 {
        0
    }
}
struct Frozen;
impl Clock for Frozen {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        now()
    }
}
fn config(path: std::path::PathBuf) -> Config {
    Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path,
        "https://app.fixture.test",
        &"aa".repeat(32),
        Some(PREFIX),
        None,
    )
    .unwrap()
    .with_namespace_ownership(atmusic_core::namespace::OwnershipEvidence {
        domain: "fixture.test".into(),
        reference: "controlled fixture; test-only".into(),
    })
    .unwrap()
}
struct Harness {
    _temp: tempfile::TempDir,
    db: Database,
    pds: WritePds,
    worker: Arc<OutboxWorker>,
    state: AppState,
}
impl Harness {
    async fn new(initial: Option<Value>, replies: Vec<Reply>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("music.sqlite");
        let db = Database::open(&path).await.unwrap();
        for did in [signed_repo::ALICE, BOB] {
            db.repositories()
                .upsert_user(User::new(did, NOW))
                .await
                .unwrap();
        }
        let pds = WritePds::new(&db, replies, initial.clone()).await;
        let worker = Arc::new(
            OutboxWorker::new(db.repositories(), pds.client.clone())
                .with_jitter(Arc::new(ZeroJitter)),
        );
        let state = AppState::new(config(path), Some(db.clone()))
            .with_clock(Arc::new(Frozen))
            .with_outbox(worker.clone());
        let harness = Self {
            _temp: temp,
            db,
            pds,
            worker,
            state,
        };
        if initial.is_some() {
            harness.project(RKEY).await;
        }
        harness
    }
    async fn project(&self, rkey: &str) {
        let value =
            self.pds.state.lock().await.records[&format!("{PREFIX}.scrobble/{rkey}")].clone();
        let item = OutboxItem {
            operation_id: "verified-fixture-read".into(),
            owner: signed_repo::ALICE.into(),
            kind: "scrobble_create".into(),
            attempts: 0,
            collection: format!("{PREFIX}.scrobble"),
            rkey: rkey.into(),
            payload_json: Some(value.to_string()),
            canonical_digest: Some(atmusic_atproto::pds::reconcile::canonical_digest(&value)),
            due_at: NOW.into(),
            locked_at: None,
            record_uri: Some(uri(rkey)),
        };
        match self.pds.client.execute(&item, now()).await {
            WriteOutcome::Confirmed(row) => match *row {
                atmusic_storage::RecordMutation::Scrobble(row) => {
                    self.db.repositories().apply_scrobble(row).await.unwrap()
                }
                _ => panic!("expected verified scrobble"),
            },
            _ => panic!("fixture projection must pass production signed verification"),
        }
    }
    async fn delete(&self, owner: &str, rkey: &str) -> (u16, HeaderMap, Value) {
        self.request("DELETE", owner, &uri(rkey), None).await
    }
    async fn request(
        &self,
        method: &str,
        owner: &str,
        record_uri: &str,
        override_state: Option<AppState>,
    ) -> (u16, HeaderMap, Value) {
        let issued = session::issue(
            &self.db,
            self.state.config.as_ref().unwrap().encryption_key(),
            owner,
            now(),
        )
        .await
        .unwrap();
        let encoded: String = url::form_urlencoded::byte_serialize(record_uri.as_bytes()).collect();
        route_request(
            override_state.unwrap_or_else(|| self.state.clone()),
            Request::builder()
                .method(method)
                .uri(format!("/api/v1/scrobbles/{encoded}"))
                .header("origin", "https://app.fixture.test")
                .header("cookie", issued.cookie.split(';').next().unwrap())
                .header("x-csrf-token", issued.csrf_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }
}
async fn route_request(state: AppState, request: Request<Body>) -> (u16, HeaderMap, Value) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        axum::serve(listener, atmusic_server::router_with_state(state))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let (parts, body) = request.into_parts();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client
        .request(
            reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap(),
            format!("http://{address}{}", parts.uri),
        )
        .headers(parts.headers)
        .header("connection", "close")
        .body(body.collect().await.unwrap().to_bytes())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.unwrap();
    drop(client);
    shutdown_tx.send(()).unwrap();
    serving.await.unwrap();
    (
        status,
        headers,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
fn uri(rkey: &str) -> String {
    format!("at://{}/{PREFIX}.scrobble/{rkey}", signed_repo::ALICE)
}
async fn assert_hidden(db: &Database, rkey: &str) {
    let repo = db.repositories();
    assert!(repo.scrobble(&uri(rkey)).await.unwrap().is_none());
    assert!(
        repo.history(signed_repo::ALICE, PageBounds::default())
            .await
            .unwrap()
            .iter()
            .all(|row| row.uri != uri(rkey))
    );
    assert!(
        repo.feed(None, PageBounds::default())
            .await
            .unwrap()
            .iter()
            .all(|row| row.uri != uri(rkey))
    );
}
#[tokio::test]
async fn wrong_owner() {
    let h = Harness::new(Some(record("Jóga")), vec![]).await;
    let initial_reads = h.pds.state.lock().await.reads;
    let (status, _, body) = h.delete(BOB, RKEY).await;
    assert_eq!(status, 403, "{body}");
    assert!(
        h.db.repositories()
            .scrobble(&uri(RKEY))
            .await
            .unwrap()
            .is_some()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tombstones")
        .fetch_one(h.db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let remote = h.pds.state.lock().await;
    assert_eq!(remote.calls, 0);
    assert_eq!(remote.reads, initial_reads);
    drop(remote);
    h.db.close().await;
}
#[tokio::test]
async fn hide_immediately() {
    let h = Harness::new(Some(record("Jóga")), vec![Reply::Timeout]).await;
    let (status, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    assert_eq!(status, 202, "{body}");
    assert_hidden(&h.db, RKEY).await;
    assert_eq!(
        h.db.repositories()
            .statistics(signed_repo::ALICE, StatisticsWindow::All, now(), 20)
            .await
            .unwrap()
            .total_scrobbles,
        0
    );
    h.worker.run_due(now()).await.unwrap();
    assert_hidden(&h.db, RKEY).await;
    let op =
        h.db.repositories()
            .operation(signed_repo::ALICE, body["operationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(op.state, "pending");
    assert!(
        h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    h.db.close().await;
}
#[tokio::test]
async fn pending_create_delete() {
    let h = Harness::new(None, vec![]).await;
    h.db.repositories()
        .admit_operation(operation(), None)
        .await
        .unwrap();
    let (status, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap()
            .failure_code
            .as_deref(),
        Some("cancelled_before_publish")
    );
    assert!(
        !h.db
            .repositories()
            .begin_attempt("operation-one".into(), NOW.into())
            .await
            .unwrap()
    );
    h.worker.run_due(now()).await.unwrap();
    assert_eq!(h.pds.state.lock().await.calls, 0);
    assert!(
        !h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    assert!(
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .is_empty()
    );
    assert_hidden(&h.db, RKEY).await;
    h.db.close().await;
}
#[tokio::test]
async fn already_absent() {
    let h = Harness::new(None, vec![]).await;
    let (status, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    assert_eq!(status, 202, "{body}"); // Local absence requires remote proof.
    let id = body["operationId"].as_str().unwrap();
    assert_eq!(
        h.delete(signed_repo::ALICE, RKEY).await.2["operationId"],
        id
    );
    h.worker.run_due(now()).await.unwrap();
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_eq!(h.delete(signed_repo::ALICE, RKEY).await.0, 204);
    assert_eq!(h.pds.state.lock().await.calls, 0);
    assert!(h.pds.state.lock().await.reads >= 2);
    h.db.close().await;
}
#[tokio::test]
async fn create_in_flight() {
    let pause = Arc::new(Pause::default());
    let h = Harness::new(None, vec![Reply::PauseAfterCommit(pause.clone())]).await;
    h.db.repositories()
        .admit_operation(operation(), None)
        .await
        .unwrap();
    let worker = h.worker.clone();
    let create = tokio::spawn(async move { worker.run_due(now()).await.unwrap() });
    pause.committed.notified().await;
    assert!(
        h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    let (status, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    assert_eq!(status, 202, "{body}");
    assert_hidden(&h.db, RKEY).await;
    assert!(
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .iter()
            .all(|op| op.kind != "scrobble_delete")
    );
    pause.release.notify_one();
    create.await.unwrap();
    assert_hidden(&h.db, RKEY).await;
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    h.worker.run_due(now()).await.unwrap();
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, body["operationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert!(
        !h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    assert_hidden(&h.db, RKEY).await;
    h.db.close().await;
}
#[tokio::test]
async fn delete_restart() {
    let h = Harness::new(Some(record("Jóga")), vec![Reply::CrashAfterCommit]).await;
    let (_, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    let id = body["operationId"].as_str().unwrap().to_string();
    h.db.repositories()
        .begin_attempt(id.clone(), NOW.into())
        .await
        .unwrap();
    let item =
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .pop()
            .unwrap();
    let _lost = h.pds.client.execute(&item, now()).await;
    assert_eq!(h.pds.state.lock().await.calls, 1);
    assert_hidden(&h.db, RKEY).await;
    h.db.close().await;
    let reopened = Database::open(h._temp.path().join("music.sqlite"))
        .await
        .unwrap();
    let worker = OutboxWorker::new(reopened.repositories(), h.pds.rebuild_for(&reopened).await)
        .with_jitter(Arc::new(ZeroJitter));
    worker.run_due(now()).await.unwrap();
    let op = reopened
        .repositories()
        .operation(signed_repo::ALICE, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.state, "succeeded");
    assert_eq!(op.attempts, 2);
    assert_eq!(h.pds.state.lock().await.calls, 1);
    assert_hidden(&reopened, RKEY).await;
    reopened.close().await;
}
#[tokio::test]
async fn remote_failure_status() {
    let h = Harness::new(
        Some(record("Jóga")),
        vec![Reply::Permanent("InvalidRequest")],
    )
    .await;
    let (_, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    let id = body["operationId"].as_str().unwrap();
    h.worker.run_due(now()).await.unwrap();
    let op =
        h.db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(op.state, "failed");
    assert_hidden(&h.db, RKEY).await;
    let (status, headers, error) = h.delete(signed_repo::ALICE, RKEY).await;
    assert_eq!(status, 502, "{error}");
    assert_eq!(headers["location"], format!("/api/v1/operations/{id}"));
    assert!(
        h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    h.db.close().await;
}
#[tokio::test]
async fn unverified_absence_and_acknowledgement() {
    let h = Harness::new(Some(record("Jóga")), vec![Reply::AcknowledgeWithoutCommit]).await;
    let (_, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    h.worker.run_due(now()).await.unwrap();
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, body["operationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert_hidden(&h.db, RKEY).await;
    h.pds.state.lock().await.hide_records = true;
    let item =
        h.db.repositories()
            .outbox_due("2026-01-15T12:00:30Z", 20)
            .await
            .unwrap()
            .pop()
            .unwrap();
    assert!(!matches!(
        h.pds.client.reconcile(&item, now()).await,
        WriteOutcome::Confirmed(_)
    )); // RecordNotFound contradicted by signed MST.
    h.pds.state.lock().await.snapshot_override = Some(b"malformed signed CAR".to_vec());
    assert!(matches!(
        h.pds.client.reconcile(&item, now()).await,
        WriteOutcome::Permanent {
            failure_code: "repository_verification_failed"
        }
    ));
    h.db.close().await;
}
#[tokio::test]
async fn missing_worker_does_not_queue() {
    let h = Harness::new(Some(record("Jóga")), vec![]).await;
    let mut state = h.state.clone();
    state.outbox = None;
    let (status, _, body) = h
        .request("DELETE", signed_repo::ALICE, &uri(RKEY), Some(state))
        .await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(body["error"]["code"], "outbox_not_ready");
    assert!(
        h.db.repositories()
            .scrobble(&uri(RKEY))
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .is_empty()
    );
    h.db.close().await;
}
async fn canonical_seven(h: &Harness) {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/read_models.json")).unwrap();
    let records: Vec<_> = fixture["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["owner"] == signed_repo::ALICE && row["state"] == "confirmed")
        .map(|row| {
            let mut record = row["record"].clone();
            record["$type"] = json!(format!("{PREFIX}.scrobble"));
            (
                format!("{PREFIX}.scrobble/{}", row["rkey"].as_str().unwrap()),
                record,
            )
        })
        .collect();
    assert_eq!(records.len(), 7);
    h.pds.seed_records(records).await;
    for key in ["r01", "r02", "r03", "r04", "r05", "r06", "r07"] {
        h.project(key).await;
    }
}
async fn assert_six(h: &Harness, key: &str) {
    assert_hidden(&h.db, key).await;
    let history =
        h.db.repositories()
            .history(signed_repo::ALICE, PageBounds::default())
            .await
            .unwrap();
    assert_eq!(history.len(), 6);
    let stats =
        h.db.repositories()
            .statistics(signed_repo::ALICE, StatisticsWindow::All, now(), 20)
            .await
            .unwrap();
    assert_eq!(stats.total_scrobbles, 6);
    assert_eq!(
        stats
            .top_albums
            .iter()
            .find(|album| atmusic_core::music_key::normalize(&album.album) == "homogenic")
            .unwrap()
            .scrobble_count,
        1
    );
}
#[tokio::test]
async fn read_model_removal() {
    let h = Harness::new(None, vec![]).await;
    canonical_seven(&h).await;
    let (status, _, body) = h.delete(signed_repo::ALICE, "r01").await;
    assert_eq!(status, 202, "{body}");
    assert_six(&h, "r01").await;
    h.worker.run_due(now()).await.unwrap();
    assert_six(&h, "r01").await;
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, body["operationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert!(
        !h.pds
            .state
            .lock()
            .await
            .records
            .contains_key(&format!("{PREFIX}.scrobble/r01"))
    );
    h.db.close().await;
}
#[tokio::test]
async fn external_delete() {
    use atmusic_atproto::sync::verify::{VerifiedMutation, verify_commit};
    use atmusic_storage::{Checkpoint, RecordMutation, RepositoryEvent};
    let h = Harness::new(None, vec![]).await;
    canonical_seven(&h).await;
    let mut remote = h.pds.state.lock().await;
    let path = format!("{PREFIX}.scrobble/r02");
    let successor =
        signed_repo::signed_mutation(&remote.fixture, &path, None, 7, "3m4zm2ufr2224").await;
    let verified = verify_commit(
        &successor.event,
        signed_repo::ALICE,
        &namespace(),
        now(),
        &signed_repo::FixtureResolver(successor.key.clone()),
    )
    .await
    .unwrap();
    let mutations: Vec<_> = verified
        .mutations()
        .iter()
        .map(|mutation| match mutation {
            VerifiedMutation::Delete { uri } => RecordMutation::Delete {
                uri: uri.clone(),
                owner: verified.did().into(),
                revision: verified.revision().into(),
                indexed_at: NOW.into(),
            },
            _ => panic!("expected genuine verified deletion"),
        })
        .collect();
    assert_eq!(mutations.len(), 1);
    remote.records.remove(&path);
    remote.cids.remove(&path);
    remote.fixture = successor;
    drop(remote);
    h.db.repositories()
        .apply_event(RepositoryEvent {
            checkpoint: Checkpoint {
                relay: "verified-external-delete".into(),
                sequence: 2,
                revision: Some(verified.revision().into()),
                indexed_at: NOW.into(),
            },
            mutations,
        })
        .await
        .unwrap();
    assert_six(&h, "r02").await;
    assert_eq!(h.pds.state.lock().await.calls, 0);
    assert!(
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .is_empty()
    );
    h.db.close().await;
}
#[tokio::test]
async fn owner_authentication_and_uri_validation() {
    let h = Harness::new(Some(record("Jóga")), vec![]).await;
    let encoded: String = url::form_urlencoded::byte_serialize(uri(RKEY).as_bytes()).collect();
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/scrobbles/{encoded}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(route_request(h.state.clone(), request).await.0, 401);
    let issued = session::issue(
        &h.db,
        h.state.config.as_ref().unwrap().encryption_key(),
        signed_repo::ALICE,
        now(),
    )
    .await
    .unwrap();
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/scrobbles/{encoded}"))
        .header("origin", "https://app.fixture.test")
        .header("cookie", issued.cookie.split(';').next().unwrap())
        .body(Body::empty())
        .unwrap();
    assert_eq!(route_request(h.state.clone(), request).await.0, 403);
    for invalid in [
        uri("."),
        uri(".."),
        format!(
            "at://{}/other.namespace.scrobble/{RKEY}",
            signed_repo::ALICE
        ),
    ] {
        assert_eq!(
            h.request("DELETE", signed_repo::ALICE, &invalid, None)
                .await
                .0,
            400
        );
    }
    assert!(
        h.db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        h.db.repositories()
            .scrobble(&uri(RKEY))
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(h.pds.state.lock().await.calls, 0);
    h.db.close().await;
}
#[tokio::test]
async fn record_changed_before_delete_retries_with_verified_cid() {
    let h = Harness::new(
        Some(record("Jóga")),
        vec![Reply::ChangeBeforeDelete(record("Unravel"))],
    )
    .await;
    let (_, _, body) = h.delete(signed_repo::ALICE, RKEY).await;
    let id = body["operationId"].as_str().unwrap();
    h.worker.run_due(now()).await.unwrap();
    let op =
        h.db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(op.state, "pending");
    assert_eq!(op.attempts, 1);
    assert_hidden(&h.db, RKEY).await;
    assert_eq!(
        h.pds.state.lock().await.records[&format!("{PREFIX}.scrobble/{RKEY}")]["track"],
        "Unravel"
    );
    h.worker
        .run_due(now() + chrono::Duration::seconds(30))
        .await
        .unwrap();
    assert_eq!(
        h.db.repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "succeeded"
    );
    assert_hidden(&h.db, RKEY).await;
    let remote = h.pds.state.lock().await;
    assert_eq!(remote.calls, 2);
    assert_ne!(
        remote.payloads[0]["swapRecord"],
        remote.payloads[1]["swapRecord"]
    );
    assert!(
        !remote
            .records
            .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
    );
    drop(remote);
    h.db.close().await;
}
