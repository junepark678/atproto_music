use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

async fn get(path: &str) -> (u16, String, Value) {
    let response = atmusic_server::router()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        content_type,
        serde_json::from_slice(&bytes).unwrap(),
    )
}

#[tokio::test]
async fn liveness_does_not_claim_readiness() {
    let (status, content_type, body) = get("/health/live").await;
    assert_eq!(status, 200);
    assert_eq!(content_type, "application/json");
    assert_eq!(body, serde_json::json!({"status": "live"}));

    let (status, _, body) = get("/health/ready").await;
    assert_eq!(status, 503);
    assert_eq!(body["error"]["code"], "not_initialized");
    uuid::Uuid::parse_str(body["error"]["requestId"].as_str().unwrap()).unwrap();
}

#[tokio::test]
async fn metadata_advertises_no_implemented_music_capabilities() {
    let (status, _, body) = get("/api/v1/meta").await;
    assert_eq!(status, 200);
    assert_eq!(body["stage"], "scaffold");
    assert_eq!(body["capabilities"], serde_json::json!([]));
}

#[tokio::test]
async fn unimplemented_api_and_deep_links_return_json_404() {
    for path in ["/api/v1/scrobbles", "/users/example", "/assets/missing.js"] {
        let (status, content_type, body) = get(path).await;
        assert_eq!(status, 404, "{path}");
        assert_eq!(content_type, "application/json");
        assert_eq!(body["error"]["code"], "not_found");
    }
}

#[tokio::test]
async fn root_serves_embedded_placeholder_html() {
    let response = atmusic_server::router()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("Music features are not implemented yet."));
}
