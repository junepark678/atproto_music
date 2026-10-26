#[path = "../../atproto/tests/support/oauth_pds.rs"]
mod oauth_pds;

use atmusic_atproto::oauth::{
    service::{OAuthConfig, OAuthService, TokenMaterial},
    token_store::TokenStore,
};
use atmusic_server::{AppState, Clock, config::Config};
use atmusic_storage::{Database, NewOperation};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use oauth_pds::{ALICE, BOB, ControlledPds, NOW};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

struct FakeClock(AtomicI64);
impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::SeqCst), 0).unwrap()
    }
}
struct Harness {
    fixture: ControlledPds,
    database: Database,
    config: Config,
    service: Arc<OAuthService>,
    clock: Arc<FakeClock>,
    application: Router,
    _directory: tempfile::TempDir,
}
impl Harness {
    async fn new() -> Self {
        let fixture = ControlledPds::start().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.sqlite");
        let database = Database::open(&path).await.unwrap();
        let config = Config::from_values(
            "127.0.0.1:0".parse().unwrap(),
            path,
            "https://music.example",
            &"41".repeat(32),
            None,
            None,
        )
        .unwrap();
        let store = TokenStore::new(database.repositories(), config.encryption_key()).unwrap();
        let service = Arc::new(OAuthService::new(
            fixture.client(),
            store,
            OAuthConfig::new(&config.public_origin, vec!["atproto".into()]).unwrap(),
        ));
        let clock = Arc::new(FakeClock(AtomicI64::new(NOW)));
        let application = atmusic_server::router_with_state(
            AppState::new(config.clone(), Some(database.clone()))
                .with_clock(clock.clone())
                .with_oauth(service.clone()),
        );
        Self {
            fixture,
            database,
            config,
            service,
            clock,
            application,
            _directory: directory,
        }
    }
    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(self.database.reader_pool())
            .await
            .unwrap()
    }
    async fn start(&self, handle: &str) -> (String, String, String) {
        let response = self
            .application
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/start")
                    .header("origin", "https://music.example")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"handle":handle}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body(response).await;
        assert_eq!(body.as_object().unwrap().len(), 1);
        self.fixture
            .authorize(body["authorizationUrl"].as_str().unwrap())
            .await
    }
    async fn callback(&self, code: &str, state: &str, issuer: &str) -> axum::response::Response {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", code)
            .append_pair("state", state)
            .append_pair("iss", issuer)
            .finish();
        self.application
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/auth/callback?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn signin(&self, handle: &str) -> String {
        let (code, state, issuer) = self.start(handle).await;
        let response = self.callback(&code, &state, &issuer).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()["location"], "https://music.example/feed");
        assert_eq!(response.headers()["cache-control"], "no-store");
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.contains("Secure; HttpOnly; SameSite=Lax"));
        assert!(!cookie.contains("fixture-refresh"));
        cookie.split(';').next().unwrap().to_owned()
    }
}
async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn wrong_origin() {
    let harness = Harness::new().await;
    for origin in [None, Some("https://attacker.example")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/start")
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin)
        }
        let response = harness
            .application
            .clone()
            .oneshot(
                request
                    .body(Body::from(json!({"handle":"alice.test"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let error = body(response).await;
        assert_eq!(error["error"]["code"], "origin_forbidden");
        assert!(error["error"]["requestId"].is_string());
    }
    assert_eq!(harness.count("oauth_states").await, 0);
    assert_eq!(harness.count("sessions").await, 0);
    assert_eq!(harness.fixture.state.lock().unwrap().par_calls, 0);
    assert!(!harness.signin("alice.test").await.is_empty());
    assert_eq!(harness.count("sessions").await, 1);
}
#[tokio::test]
async fn security_matrix() {
    for case in ["stale", "issuer", "subject", "proof"] {
        let harness = Harness::new().await;
        let (code, state, issuer) = harness.start("alice.test").await;
        let mut callback_issuer = issuer.clone();
        match case {
            "stale" => harness.clock.0.store(NOW + 300, Ordering::SeqCst),
            "issuer" => callback_issuer = "https://attacker.example".into(),
            "subject" => harness.fixture.state.lock().unwrap().faults.wrong_subject = true,
            "proof" => harness.fixture.state.lock().unwrap().faults.corrupt_proof = true,
            _ => unreachable!(),
        }
        let response = harness.callback(&code, &state, &callback_issuer).await;
        assert_eq!(
            response.status(),
            if case == "stale" { 400 } else { 401 },
            "{case}"
        );
        assert!(response.headers().get("set-cookie").is_none());
        let error = body(response).await;
        assert!(error["error"]["code"].is_string());
        assert!(error["error"]["requestId"].is_string());
        assert_eq!(harness.count("sessions").await, 0, "{case}");
        assert_eq!(harness.count("oauth_tokens").await, 0, "{case}");
        assert_eq!(harness.count("users").await, 0, "{case}");
        assert_eq!(harness.count("outbox").await, 0, "{case}");
        assert!(harness.fixture.state.lock().unwrap().records.is_empty());
    }
    let harness = Harness::new().await;
    let (code, state, issuer) = harness.start("alice.test").await;
    let first = harness.callback(&code, &state, &issuer).await;
    assert_eq!(first.status(), 303);
    assert_eq!(harness.count("sessions").await, 1);
    let replay = harness.callback(&code, &state, &issuer).await;
    assert_eq!(replay.status(), 400);
    assert_eq!(harness.count("sessions").await, 1);
    assert_eq!(harness.fixture.state.lock().unwrap().token_calls, 1);
}
#[tokio::test]
async fn refresh_persistence() {
    let harness = Harness::new().await;
    let cookie = harness.signin("alice.test").await;
    harness.clock.0.store(NOW + 3600, Ordering::SeqCst);
    {
        let mut fixture = harness.fixture.state.lock().unwrap();
        fixture.now = NOW + 3600;
        fixture.faults.rotate_refresh = true;
    }
    let rotated = harness.service.refresh(ALICE, NOW + 3600).await.unwrap();
    assert_eq!(harness.fixture.state.lock().unwrap().refresh_calls, 1);
    harness.database.close().await;
    let database = Database::open(&harness.config.database_path).await.unwrap();
    let store = TokenStore::new(database.repositories(), harness.config.encryption_key()).unwrap();
    let service = Arc::new(OAuthService::new(
        harness.fixture.client(),
        store,
        OAuthConfig::new(&harness.config.public_origin, vec!["atproto".into()]).unwrap(),
    ));
    let application = atmusic_server::router_with_state(
        AppState::new(harness.config.clone(), Some(database.clone()))
            .with_clock(harness.clock.clone())
            .with_oauth(service.clone()),
    );
    let response = application
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/session")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body(response).await["did"], ALICE);
    let persisted: TokenMaterial = service.refresh(ALICE, NOW + 3600).await.unwrap();
    assert_eq!(persisted.refresh_token, rotated.refresh_token);
    assert_eq!(harness.fixture.state.lock().unwrap().refresh_calls, 1);
    database.close().await;
}
#[tokio::test]
async fn cross_owner() {
    let harness = Harness::new().await;
    let alice = harness.signin("alice.test").await;
    let bob = harness.signin("bob.test").await;
    for (owner, id) in [(ALICE, "alice-operation"), (BOB, "bob-operation")] {
        harness
            .database
            .repositories()
            .admit_operation(
                NewOperation {
                    operation_id: id.into(),
                    owner: owner.into(),
                    kind: "scrobble_delete".into(),
                    created_at: DateTime::from_timestamp(NOW, 0).unwrap().to_rfc3339(),
                    record_uri: Some(format!("at://{owner}/com.example.atmusic.scrobble/{id}")),
                    collection: "com.example.atmusic.scrobble".into(),
                    rkey: id.into(),
                    payload_json: None,
                    canonical_digest: None,
                },
                None,
            )
            .await
            .unwrap();
    }
    for (cookie, id, expected) in [
        (&alice, "alice-operation", 200),
        (&bob, "bob-operation", 200),
        (&alice, "bob-operation", 403),
        (&bob, "alice-operation", 403),
    ] {
        let response = harness
            .application
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/operations/{id}"))
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let value = body(response).await;
        if expected == 200 {
            assert_eq!(value["operationId"], id)
        } else {
            assert_eq!(value["error"]["code"], "forbidden")
        }
    }
    let response = harness
        .application
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/operations/alice-operation")
                .header("cookie", "atmusic_session=invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(harness.count("operations").await, 2);
    assert_eq!(harness.fixture.state.lock().unwrap().records.len(), 0);
}
#[tokio::test]
async fn auth_start_error_contract() {
    let harness = Harness::new().await;
    for (payload, expected, field) in [
        ("not-json", 400, None),
        ("{}", 422, Some("body")),
        (
            "{\"handle\":\"alice.test\",\"extra\":true}",
            422,
            Some("body"),
        ),
        ("{\"handle\":\" invalid \"}", 422, Some("handle")),
        ("{\"handle\":\"missing.test\"}", 404, None),
    ] {
        let response = harness
            .application
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/start")
                    .header("origin", "https://music.example")
                    .header("content-type", "application/json")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let error = body(response).await;
        if let Some(field) = field {
            assert!(error["error"]["fields"][field].is_string())
        } else {
            assert!(error["error"].get("fields").is_none())
        }
    }
    assert_eq!(harness.count("oauth_states").await, 0);
    assert_eq!(harness.fixture.state.lock().unwrap().par_calls, 0);
}
