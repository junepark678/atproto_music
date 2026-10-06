use std::path::PathBuf;

use atmusic_server::{
    AppState,
    config::Config,
    http::{error, oauth_metadata},
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::get,
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

fn config(namespace: Option<&str>) -> Config {
    Config::from_values(
        "127.0.0.1:0".parse().unwrap(),
        PathBuf::from("data/test.sqlite"),
        "https://music.example",
        &"41".repeat(32),
        namespace,
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn metadata_origin() {
    let application = Router::new()
        .route(
            "/oauth/client-metadata.json",
            get(oauth_metadata::client_metadata),
        )
        .with_state(AppState::new(config(Some("com.example.atmusic")), None))
        .layer(middleware::from_fn(error::request_id));
    let response = application
        .oneshot(
            Request::builder()
                .uri("/oauth/client-metadata.json")
                .header("host", "attacker.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body["client_id"],
        "https://music.example/oauth/client-metadata.json"
    );
    assert_eq!(
        body["redirect_uris"],
        serde_json::json!(["https://music.example/api/v1/auth/callback"])
    );
}

#[test]
fn metadata_contract() {
    let metadata = oauth_metadata::document(&config(None)).unwrap();
    assert_eq!(
        metadata["grant_types"],
        serde_json::json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(metadata["response_types"], serde_json::json!(["code"]));
    assert_eq!(metadata["application_type"], "web");
    assert_eq!(metadata["dpop_bound_access_tokens"], true);
    assert_eq!(metadata["require_pushed_authorization_requests"], true);
    assert_eq!(metadata["token_endpoint_auth_method"], "none");
}

#[test]
fn scope_inventory() {
    assert_eq!(
        oauth_metadata::scopes(&config(Some("net.operator.music"))),
        vec![
            "atproto",
            "repo:net.operator.music.scrobble",
            "repo:net.operator.music.follow"
        ]
    );
    assert_eq!(oauth_metadata::scopes(&config(None)), vec!["atproto"]);
    assert!(
        !oauth_metadata::document(&config(Some("net.operator.music"))).unwrap()["scope"]
            .as_str()
            .unwrap()
            .contains("transition:")
    );
}
