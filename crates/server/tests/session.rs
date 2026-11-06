use atmusic_server::{AppState, Clock, auth::session};
use atmusic_storage::{Database, User};
use axum::{
    body::Body,
    http::{HeaderMap, Request},
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

struct FixedClock(Mutex<DateTime<Utc>>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

async fn setup() -> (
    tempfile::TempDir,
    Database,
    AppState,
    Arc<FixedClock>,
    session::IssuedSession,
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("music.sqlite");
    let database = Database::open(&path).await.unwrap();
    let now = DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    database
        .repositories()
        .upsert_user(User::new(
            "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
            now.to_rfc3339(),
        ))
        .await
        .unwrap();
    let config = atmusic_server::config::Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path,
        "https://music.example",
        &"ab".repeat(32),
        None,
        None,
    )
    .unwrap();
    let issued = session::issue(
        &database,
        config.encryption_key(),
        "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        now,
    )
    .await
    .unwrap();
    let clock = Arc::new(FixedClock(Mutex::new(now)));
    let state = AppState::new(config, Some(database.clone())).with_clock(clock.clone());
    (directory, database, state, clock, issued)
}
fn headers(issued: &session::IssuedSession) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        issued.cookie.split(';').next().unwrap().parse().unwrap(),
    );
    headers
}
#[tokio::test]
async fn cookie_and_hash() {
    let (directory, database, state, _, issued) = setup().await;
    for flag in [
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=604800",
    ] {
        assert!(issued.cookie.contains(flag));
    }
    let raw = issued
        .cookie
        .split(';')
        .next()
        .unwrap()
        .split('=')
        .nth(1)
        .unwrap();
    let mut request = Request::builder()
        .uri("/api/v1/auth/session")
        .body(Body::empty())
        .unwrap();
    *request.headers_mut() = headers(&issued);
    let response = atmusic_server::router_with_state(state)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["csrfToken"], issued.csrf_token);
    assert_eq!(body["did"], "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    assert!(!String::from_utf8_lossy(&bytes).contains(raw));
    database.close().await;
    for entry in std::fs::read_dir(directory.path()).unwrap() {
        let data = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(
            !data
                .windows(raw.len())
                .any(|window| window == raw.as_bytes())
        );
    }
}
#[tokio::test]
async fn session_expiry() {
    let (_directory, database, state, clock, issued) = setup().await;
    let id = atmusic_server::http::error::RequestId(uuid::Uuid::new_v4().to_string());
    *clock.0.lock().unwrap() = issued.expires_at - chrono::Duration::seconds(1);
    let authenticated = session::authenticate(&state, &headers(&issued), &id)
        .await
        .unwrap();
    assert_eq!(authenticated.expires_at, issued.expires_at);
    *clock.0.lock().unwrap() = issued.expires_at;
    assert_eq!(
        session::authenticate(&state, &headers(&issued), &id)
            .await
            .err()
            .unwrap()
            .status,
        401
    );
    database.close().await;
}
#[tokio::test]
async fn csrf_matrix() {
    let (_directory, database, state, _clock, issued) = setup().await;
    let id = atmusic_server::http::error::RequestId(uuid::Uuid::new_v4().to_string());
    let mut valid = headers(&issued);
    valid.insert("origin", "https://music.example".parse().unwrap());
    valid.insert("x-csrf-token", issued.csrf_token.parse().unwrap());
    let authenticated = session::authenticate(&state, &valid, &id).await.unwrap();
    for mutation in 0..3 {
        let mut invalid = valid.clone();
        match mutation {
            0 => {
                invalid.remove("x-csrf-token");
            }
            1 => {
                invalid.insert("x-csrf-token", "invalid".parse().unwrap());
            }
            _ => {
                invalid.insert("origin", "https://attacker.example".parse().unwrap());
            }
        }
        assert_eq!(
            authenticated
                .require_csrf(&invalid, &state, &id)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operations")
                .fetch_one(database.reader_pool())
                .await
                .unwrap(),
            0
        );
    }
    authenticated.require_csrf(&valid, &state, &id).unwrap();
    database.close().await;
}
