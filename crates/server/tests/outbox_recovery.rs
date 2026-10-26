#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;
use atmusic_atproto::pds::write::{Jitter, PdsWriteBoundary};
use atmusic_server::{
    AppState, Clock, auth::session, config::Config, workers::outbox::OutboxWorker,
};
use atmusic_storage::{Database, User};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use write_pds::*;
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
async fn prepare(
    initial: Option<Value>,
    replies: Vec<Reply>,
) -> (tempfile::TempDir, Database, WritePds) {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(temp.path().join("music.sqlite"))
        .await
        .unwrap();
    db.repositories()
        .upsert_user(User::new(signed_repo::ALICE, NOW))
        .await
        .unwrap();
    let fixture = WritePds::new(&db, replies, initial).await;
    (temp, db, fixture)
}
#[tokio::test]
async fn crash_after_remote() {
    let (temp, db, fixture) = prepare(None, vec![Reply::CrashAfterCommit]).await;
    let repo = db.repositories();
    repo.admit_operation(operation(), Some("once".into()))
        .await
        .unwrap();
    repo.begin_attempt("operation-one".into(), NOW.into())
        .await
        .unwrap();
    let item = repo.outbox_due(NOW, 10).await.unwrap().pop().unwrap();
    let _lost_result = fixture.client.execute(&item, now()).await;
    assert_eq!(fixture.state.lock().await.calls, 1);
    assert_eq!(repo.public_counts(signed_repo::ALICE).await.unwrap().0, 0);
    assert_eq!(
        repo.operation(signed_repo::ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    db.close().await;
    let reopened = Database::open(temp.path().join("music.sqlite"))
        .await
        .unwrap();
    let client = fixture.rebuild_for(&reopened).await;
    let worker =
        OutboxWorker::new(reopened.repositories(), client).with_jitter(Arc::new(ZeroJitter));
    worker.run_due(now()).await.unwrap();
    let op = reopened
        .repositories()
        .operation(signed_repo::ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.state, "succeeded");
    assert_eq!(op.attempts, 2);
    assert_eq!(fixture.state.lock().await.calls, 1);
    assert_eq!(
        reopened
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        1
    );
    let row = reopened
        .repositories()
        .scrobble(op.record_uri.as_deref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.track, "Jóga");
    reopened.close().await;
}
#[tokio::test]
async fn conflicting_rkey() {
    let (_temp, db, fixture) = prepare(Some(record("Different track")), vec![]).await;
    db.repositories()
        .admit_operation(operation(), Some("once".into()))
        .await
        .unwrap();
    let worker = OutboxWorker::new(db.repositories(), fixture.client.clone())
        .with_jitter(Arc::new(ZeroJitter));
    worker.run_due(now()).await.unwrap();
    let op = db
        .repositories()
        .operation(signed_repo::ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.state, "failed");
    assert_eq!(op.failure_code.as_deref(), Some("remote_record_conflict"));
    let remote = fixture.state.lock().await;
    assert_eq!(remote.calls, 0);
    assert_eq!(
        remote
            .records
            .get(&format!("{PREFIX}.scrobble/{RKEY}"))
            .unwrap()["track"],
        "Different track"
    );
    drop(remote);
    assert_eq!(
        db.repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        0
    );
    db.close().await;
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
        reference: "controlled fixture domain; test-only".into(),
    })
    .unwrap()
}
async fn post(state: AppState, issued: &session::IssuedSession) -> (u16, Value) {
    let response = atmusic_server::router_with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/scrobbles")
                .header("content-type", "application/json")
                .header("origin", "https://app.fixture.test")
                .header("cookie", issued.cookie.split(';').next().unwrap())
                .header("x-csrf-token", &issued.csrf_token)
                .header("idempotency-key", "repeat-request")
                .body(Body::from(
                    json!({"artist":"Björk","track":"Jóga","album":"Homogenic","listenedAt":NOW})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    (status, value)
}
#[tokio::test]
async fn five_retries() {
    let (temp, db, fixture) = prepare(None, vec![Reply::CrashAfterCommit]).await;
    let cfg = config(temp.path().join("music.sqlite"));
    let issued = session::issue(&db, cfg.encryption_key(), signed_repo::ALICE, now())
        .await
        .unwrap();
    let worker = Arc::new(
        OutboxWorker::new(db.repositories(), fixture.client.clone())
            .with_jitter(Arc::new(ZeroJitter)),
    );
    let state = AppState::new(cfg, Some(db.clone()))
        .with_clock(Arc::new(Frozen))
        .with_outbox(worker);
    let mut id = String::new();
    for _ in 0..3 {
        let (status, body) = post(state.clone(), &issued).await;
        assert_eq!(status, 202, "{body}");
        assert_eq!(body["state"], "pending");
        if id.is_empty() {
            id = body["operationId"].as_str().unwrap().into();
        } else {
            assert_eq!(body["operationId"], id);
        }
    }
    let items = db.repositories().outbox_due(NOW, 10).await.unwrap();
    assert_eq!(items.len(), 1);
    let original_rkey = items[0].rkey.clone();
    let original_uri = items[0].record_uri.clone();
    db.repositories()
        .begin_attempt(id.clone(), NOW.into())
        .await
        .unwrap();
    let _lost = fixture.client.execute(&items[0], now()).await;
    assert_eq!(fixture.state.lock().await.calls, 1);
    db.close().await;
    drop(state);
    let reopened = Database::open(temp.path().join("music.sqlite"))
        .await
        .unwrap();
    let worker = Arc::new(
        OutboxWorker::new(
            reopened.repositories(),
            fixture.rebuild_for(&reopened).await,
        )
        .with_jitter(Arc::new(ZeroJitter)),
    );
    let state = AppState::new(
        config(temp.path().join("music.sqlite")),
        Some(reopened.clone()),
    )
    .with_clock(Arc::new(Frozen))
    .with_outbox(worker.clone());
    for _ in 0..2 {
        let (status, body) = post(state.clone(), &issued).await;
        assert_eq!(status, 202, "{body}");
        assert_eq!(body["operationId"], id);
    }
    let rows = reopened.repositories().outbox_due(NOW, 10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].rkey, original_rkey);
    assert_eq!(rows[0].record_uri, original_uri);
    worker.run_due(now()).await.unwrap();
    assert_eq!(
        reopened
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        1
    );
    assert_eq!(fixture.state.lock().await.calls, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM operations")
        .fetch_one(reopened.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    reopened.close().await;
}
