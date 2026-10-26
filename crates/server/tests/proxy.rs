mod common;

use atmusic_server::{AppState, Clock, auth::session};
use atmusic_storage::User;
use common::TestServer;
use std::sync::Arc;

struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        "2026-01-15T12:00:00Z".parse().unwrap()
    }
}

async fn server(cidrs: &[&str]) -> TestServer {
    let cidrs = cidrs
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    TestServer::start_with_state(Arc::new(FixedClock), move |mut state: AppState| {
        let config = state
            .config
            .take()
            .unwrap()
            .as_ref()
            .clone()
            .with_trusted_proxies(&cidrs)
            .unwrap();
        state.config = Some(Arc::new(config));
        state
    })
    .await
}

fn forwarded(server: &TestServer, chain: &str) -> reqwest::RequestBuilder {
    server
        .client
        .get(server.url("/api/v1/meta"))
        .header("x-forwarded-for", chain)
        .header("x-forwarded-proto", "https")
        .header("x-forwarded-host", "music.example")
}

#[tokio::test]
async fn untrusted_forwarded() {
    let server = server(&["192.0.2.0/24"]).await;
    for number in 0..120 {
        assert_eq!(
            forwarded(&server, &format!("198.51.100.{}", number + 1))
                .header("host", "attacker.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        forwarded(&server, "203.0.113.10")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    assert_eq!(
        server.state.limiter.key_count(),
        1,
        "untrusted forwarding cannot create IP quotas"
    );
    let metadata = server
        .client
        .get(server.url("/oauth/client-metadata.json"))
        .header("x-forwarded-proto", "http")
        .header("x-forwarded-host", "attacker.invalid")
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        metadata["client_id"],
        "https://music.example/oauth/client-metadata.json"
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn trusted_proxy() {
    let server = server(&["127.0.0.0/8", "2001:db8:1::/48"]).await;
    for _ in 0..120 {
        assert_eq!(
            forwarded(&server, "203.0.113.7, 2001:db8:1::2")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        forwarded(&server, "198.51.100.99, 203.0.113.7, 2001:db8:1::2")
            .send()
            .await
            .unwrap()
            .status(),
        429,
        "an untrusted intermediate hop defeats a forged leftmost IP"
    );
    assert_eq!(
        forwarded(&server, "2001:db8:2::8, 2001:db8:1::2")
            .send()
            .await
            .unwrap()
            .status(),
        200,
        "a different verified client has its own quota"
    );
    let did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    server
        .database
        .repositories()
        .upsert_user(User::new(did, "2026-01-15T12:00:00Z"))
        .await
        .unwrap();
    let issued = session::issue(
        &server.database,
        server.state.config.as_ref().unwrap().encryption_key(),
        did,
        "2026-01-15T12:00:00Z".parse().unwrap(),
    )
    .await
    .unwrap();
    assert!(issued.cookie.contains("Secure"));
    let logout = server
        .client
        .post(server.url("/api/v1/auth/logout"))
        .header("cookie", issued.cookie.split(';').next().unwrap())
        .header("origin", "https://music.example")
        .header("x-csrf-token", issued.csrf_token)
        .header("x-forwarded-proto", "https")
        .header("x-forwarded-host", "music.example")
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 204);
    assert!(
        logout.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Secure")
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn origin_mismatch() {
    let server = server(&["127.0.0.0/8"]).await;
    let metadata = server
        .client
        .get(server.url("/oauth/client-metadata.json"))
        .header("host", "attacker.invalid")
        .header("x-forwarded-proto", "http")
        .header("x-forwarded-host", "attacker.invalid")
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        metadata["client_id"],
        "https://music.example/oauth/client-metadata.json"
    );
    let response = server
        .client
        .post(server.url("/api/v1/auth/start"))
        .header("origin", "https://attacker.invalid")
        .header("x-forwarded-host", "music.example")
        .header("x-forwarded-proto", "https")
        .json(&serde_json::json!({"handle":"alice.test"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let states: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_states")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        states, 0,
        "wrong Origin cannot begin OAuth even through a trusted proxy"
    );
    for _ in 0..120 {
        assert_eq!(
            forwarded(&server, "not-an-ip")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        forwarded(&server, "203.0.113.8")
            .header("x-forwarded-proto", "http")
            .send()
            .await
            .unwrap()
            .status(),
        429,
        "malformed or inconsistent forwarding falls back to the socket peer"
    );
    assert!(!server.shutdown().await.timed_out);
}
