use atmusic_atproto::pds::write::{PdsWriteBoundary, WriteOutcome};
use atmusic_core::namespace::OwnershipEvidence;
use atmusic_server::{
    AppState, Clock, auth::session, config::Config, workers::outbox::OutboxWorker,
};
use atmusic_storage::{Database, OutboxItem, User};
use axum::{body::Body, http::Request};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

struct FrozenClock(Mutex<DateTime<Utc>>);
impl Clock for FrozenClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}
// Admission stops before the network barrier; running this boundary never fabricates success.
struct PausedPds(AtomicUsize);
#[async_trait::async_trait]
impl PdsWriteBoundary for PausedPds {
    async fn execute(&self, _: &OutboxItem, _: DateTime<Utc>) -> WriteOutcome {
        self.0.fetch_add(1, Ordering::SeqCst);
        WriteOutcome::Permanent {
            failure_code: "test_send_barrier",
        }
    }
}
struct Harness {
    _directory: tempfile::TempDir,
    database: Database,
    state: AppState,
    issued: session::IssuedSession,
    clock: Arc<FrozenClock>,
    pds: Arc<PausedPds>,
}
impl Harness {
    async fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.sqlite");
        let database = Database::open(&path).await.unwrap();
        let now = DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let alice = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
        database
            .repositories()
            .upsert_user(User::new(alice, now.to_rfc3339()))
            .await
            .unwrap();
        let config = Config::from_values(
            "127.0.0.1:0".parse().unwrap(),
            path,
            "https://music.example",
            &"ab".repeat(32),
            Some("test.music.atmusic"),
            None,
        )
        .unwrap()
        .with_namespace_ownership(OwnershipEvidence {
            domain: "music.test".into(),
            reference: "controlled test-only DNS fixture; never published".into(),
        })
        .unwrap();
        let issued = session::issue(&database, config.encryption_key(), alice, now)
            .await
            .unwrap();
        let pds = Arc::new(PausedPds(AtomicUsize::new(0)));
        let worker = Arc::new(OutboxWorker::new(database.repositories(), pds.clone()));
        let clock = Arc::new(FrozenClock(Mutex::new(now)));
        let state = AppState::new(config, Some(database.clone()))
            .with_clock(clock.clone())
            .with_outbox(worker);
        Self {
            _directory: directory,
            database,
            state,
            issued,
            clock,
            pds,
        }
    }
    async fn post(&self, key: Option<&str>, body: &str) -> (u16, Value, axum::http::HeaderMap) {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/scrobbles")
            .header("origin", "https://music.example")
            .header("x-csrf-token", &self.issued.csrf_token)
            .header("cookie", self.issued.cookie.split(';').next().unwrap())
            .header("content-type", "application/json");
        if let Some(key) = key {
            request = request.header("idempotency-key", key)
        }
        let response = atmusic_server::router_with_state(self.state.clone())
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        (status, body, headers)
    }
    async fn counts(&self) -> (i64, i64) {
        (
            sqlx::query_scalar("SELECT count(*) FROM operations")
                .fetch_one(self.database.reader_pool())
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT count(*) FROM outbox")
                .fetch_one(self.database.reader_pool())
                .await
                .unwrap(),
        )
    }
}
fn valid() -> String {
    json!({"artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z"}).to_string()
}
#[tokio::test]
async fn key_validation() {
    let h = Harness::start().await;
    let too_long = "x".repeat(129);
    for key in [None, Some(""), Some(too_long.as_str()), Some("bad\tkey")] {
        let (status, body, _) = h.post(key, &valid()).await;
        assert_eq!(status, 400);
        assert_eq!(body["error"]["code"], "invalid_idempotency_key");
        assert_eq!(h.counts().await, (0, 0));
        assert_eq!(h.pds.0.load(Ordering::SeqCst), 0);
    }
    assert_eq!(h.post(Some("healthy"), &valid()).await.0, 202);
    assert_eq!(h.counts().await, (1, 1));
    h.database.close().await;
}
#[tokio::test]
async fn retry_collision() {
    let h = Harness::start().await;
    let (status, original, _) = h.post(Some("same"), &valid()).await;
    assert_eq!(status, 202);
    assert_eq!(original["state"], "pending");
    *h.clock.0.lock().unwrap() += chrono::Duration::seconds(30);
    let equivalent =
        json!({"track":" Jóga ","listenedAt":"2026-01-15T11:00:00.000000000Z","artist":" Björk "})
            .to_string();
    assert_eq!(h.post(Some("same"), &equivalent).await.1, original);
    let changed =
        json!({"artist":"Björk","track":"Army of Me","listenedAt":"2026-01-15T11:00:00Z"})
            .to_string();
    let (status, error, _) = h.post(Some("same"), &changed).await;
    assert_eq!(status, 409);
    assert_eq!(error["error"]["code"], "idempotency_conflict");
    assert_eq!(h.counts().await, (1, 1));
    assert_eq!(h.pds.0.load(Ordering::SeqCst), 0);
    // Failure remains owner-visible and replay does not create a second request.
    let id = original["operationId"].as_str().unwrap();
    h.database
        .repositories()
        .finish_operation(
            id.into(),
            h.clock.now().to_rfc3339(),
            Some("upstream_rejected".into()),
            None,
        )
        .await
        .unwrap();
    let (status, body, headers) = h.post(Some("same"), &valid()).await;
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "idempotency_result_unavailable");
    assert_eq!(headers["location"], format!("/api/v1/operations/{id}"));
    assert_eq!(h.counts().await, (1, 0));
    h.database.close().await;
}
#[tokio::test]
async fn owner_and_validation() {
    let h = Harness::start().await;
    for (body, field) in [
        (
            json!({"artist":"A","track":"T","listenedAt":"2026-01-15T11:00:00Z","did":"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"}),
            "did",
        ),
        (
            json!({"artist":"A","track":" ","listenedAt":"2026-01-15T11:00:00Z"}),
            "track",
        ),
        (
            json!({"artist":"A","track":"T","listenedAt":"2026-01-15T12:05:01Z"}),
            "listenedAt",
        ),
    ] {
        let (status, response, _) = h.post(Some("invalid"), &body.to_string()).await;
        assert_eq!(status, 422);
        assert!(response["error"]["fields"][field].is_string());
        assert_eq!(h.counts().await, (0, 0));
        assert_eq!(h.pds.0.load(Ordering::SeqCst), 0);
    }
    let (_, body, _) = h.post(Some("valid"), &valid()).await;
    let id = body["operationId"].as_str().unwrap();
    assert!(
        h.database
            .repositories()
            .operation("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        h.database
            .repositories()
            .operation("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", id)
            .await
            .unwrap()
            .is_none()
    );
    h.database.close().await;
}
#[tokio::test]
async fn body_boundary() {
    let h = Harness::start().await;
    let mut body = valid();
    body.extend(std::iter::repeat_n(' ', 65_536 - body.len()));
    assert_eq!(h.post(Some("boundary"), &body).await.0, 202);
    body.push(' ');
    let (status, error, _) = h.post(Some("oversized"), &body).await;
    assert_eq!(status, 413);
    assert_eq!(error["error"]["code"], "body_too_large");
    assert_eq!(h.counts().await, (1, 1));
    assert_eq!(h.pds.0.load(Ordering::SeqCst), 0);
    h.database.close().await;
}
#[tokio::test]
async fn unavailable_publisher() {
    let mut h = Harness::start().await;
    h.state.outbox = None;
    let (status, error, _) = h.post(Some("no-worker"), &valid()).await;
    assert_eq!(status, 503);
    assert_eq!(error["error"]["code"], "outbox_not_ready");
    assert_eq!(h.counts().await, (0, 0));
    h.database.close().await;
}
