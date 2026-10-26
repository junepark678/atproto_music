use atmusic_server::{AppState, config::Config};
use atmusic_storage::Database;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

async fn get(state: AppState, path: &str) -> (u16, Value, String) {
    let response = atmusic_server::router_with_state(state)
        .oneshot(
            Request::builder()
                .uri(path)
                .header("x-request-id", "untrusted-value")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let request_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    uuid::Uuid::parse_str(&request_id).unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), request_id)
}
fn config(path: std::path::PathBuf) -> Config {
    Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        path,
        "https://music.example",
        &"ab".repeat(32),
        None,
        Some("wss://relay.example"),
    )
    .unwrap()
}
#[tokio::test]
async fn ready_before_storage() {
    let (status, body, id) = get(AppState::default(), "/health/ready").await;
    assert_eq!(status, 503);
    assert_eq!(body["error"]["code"], "storage_not_ready");
    assert_eq!(body["error"]["requestId"], id);
    assert_eq!(get(AppState::default(), "/health/live").await.0, 200);
}
#[tokio::test]
async fn upstream_outage() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("music.sqlite");
    let database = Database::open(&path).await.unwrap();
    let state = AppState::new(config(path), Some(database.clone()));
    assert_eq!(
        get(state.clone(), "/health/ready").await.1,
        serde_json::json!({"status":"ready"})
    );
    assert_eq!(get(state.clone(), "/health/live").await.0, 200);
    let (_, meta, _) = get(state, "/api/v1/meta").await;
    assert_eq!(meta["stage"], "backend");
    assert_eq!(meta["indexing"]["state"], "recovering");
    assert_eq!(meta["indexing"]["caughtUp"], false);
    assert!(meta["lexiconPrefix"].is_null());
    database.close().await;
}
#[tokio::test]
async fn safe_errors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("private-path.sqlite");
    let database = Database::open(&path).await.unwrap();
    let state = AppState::new(config(path.clone()), Some(database.clone()));
    let (status, body, id) = get(state.clone(), "/api/v1/unknown").await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["requestId"], id);
    database.close().await;
    let (status, body, id) = get(state, "/health/ready").await;
    assert_eq!(status, 503);
    assert_eq!(body["error"]["requestId"], id);
    assert!(!body.to_string().contains(path.to_str().unwrap()));
    assert!(!body.to_string().contains("ab".repeat(32).as_str()));
}
