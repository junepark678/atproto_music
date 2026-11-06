use atmusic_server::{AppState, config::Config};
use axum::{
    body::Body,
    http::{Method, Request},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn router() -> axum::Router {
    let config = Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        "unused.sqlite".into(),
        "https://music.example",
        &"11".repeat(32),
        None,
        None,
    )
    .unwrap();
    atmusic_server::router_with_state(AppState::new(config, None))
}

async fn request(method: Method, path: &str) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    let response = router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

#[tokio::test]
async fn asset_missing_traversal() {
    // The runtime has no asset-directory argument: only compile-time bytes can be served.
    for path in [
        "/assets/missing.js",
        "/%2e%2e/secret",
        "/assets/%2E%2E/secret",
        "/assets%2f..%2fsecret",
        "/assets/%252e%252e/secret",
        "/unknown/api",
        "/api/v1/unimplemented",
        "/oauth/missing",
        "/health/missing",
        "/secret.txt",
    ] {
        let (status, headers, body) = request(Method::GET, path).await;
        assert_eq!(status, 404, "{path}");
        assert_eq!(headers["content-type"], "application/json", "{path}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "not_found");
        assert_eq!(
            json["error"]["requestId"],
            headers["x-request-id"].to_str().unwrap()
        );
        assert!(!String::from_utf8(body).unwrap().contains("<!doctype html>"));
    }
}

#[tokio::test]
async fn spa_deep_link() {
    let (_, _, index) = request(Method::GET, "/").await;
    for path in ["/users/Alice-DID", "/feed"] {
        let (status, headers, body) = request(Method::GET, path).await;
        assert_eq!(status, 200);
        assert_eq!(headers["content-type"], "text/html; charset=utf-8");
        assert_eq!(body, index);
    }
    let (status, headers, body) = request(Method::POST, "/feed").await;
    assert_eq!(status, 404);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["error"]["code"],
        "not_found"
    );
}

#[tokio::test]
async fn asset_cache() {
    let (status, headers, body) = request(Method::GET, "/assets/placeholder.77f5eec3.js").await;
    assert_eq!(status, 200);
    assert_eq!(
        headers["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        headers["content-type"],
        "application/javascript; charset=utf-8"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(body, b"\"use strict\";\n");
    for path in ["/", "/index.html", "/feed", "/oauth/client-metadata.json"] {
        let (status, headers, _) = request(Method::GET, path).await;
        assert_eq!(status, 200, "{path}");
        assert_eq!(headers["cache-control"], "no-cache", "{path}");
    }
}
