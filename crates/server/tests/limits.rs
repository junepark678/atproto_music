mod common;
use atmusic_server::{
    Clock,
    auth::session,
    http::limits::{Limiter, MAX_KEYS, RateKey},
};
use atmusic_storage::User;
use chrono::{DateTime, Utc};
use common::TestServer;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};

struct Time(Mutex<DateTime<Utc>>);
impl Clock for Time {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}
fn time() -> Arc<Time> {
    Arc::new(Time(Mutex::new("2026-01-15T12:00:00Z".parse().unwrap())))
}

#[tokio::test]
async fn body_boundary() {
    let clock = time();
    let server = TestServer::start_with_clock(clock.clone()).await;
    let did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    server
        .database
        .repositories()
        .upsert_user(User::new(did, clock.now().to_rfc3339()))
        .await
        .unwrap();
    let issued = session::issue(
        &server.database,
        server.state.config.as_ref().unwrap().encryption_key(),
        did,
        clock.now(),
    )
    .await
    .unwrap();
    let request = |size: usize| {
        server
            .client
            .post(server.url("/api/v1/auth/logout"))
            .header("cookie", issued.cookie.split(';').next().unwrap())
            .header("origin", "https://music.example")
            .header("x-csrf-token", &issued.csrf_token)
            .body(" ".repeat(size))
    };
    let response = request(65_537).send().await.unwrap();
    assert_eq!(response.status(), 413);
    let error: serde_json::Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "body_too_large");
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        sessions, 1,
        "the oversized body must not log out the account"
    );
    assert_eq!(request(65_536).send().await.unwrap().status(), 204);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        sessions, 0,
        "the exact boundary reaches the actual mutation handler"
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn rate_boundary() {
    let clock = time();
    let server = TestServer::start_with_clock(clock.clone()).await;
    let did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    server
        .database
        .repositories()
        .upsert_user(User::new(did, clock.now().to_rfc3339()))
        .await
        .unwrap();
    let session = session::issue(
        &server.database,
        server.state.config.as_ref().unwrap().encryption_key(),
        did,
        clock.now(),
    )
    .await
    .unwrap();
    for _ in 0..60 {
        let response = server.client.post(server.url("/api/v1/scrobbles"))
            .header("cookie", session.cookie.split(';').next().unwrap())
            .header("origin", "https://music.example").header("x-csrf-token", &session.csrf_token)
            .header("idempotency-key", "same-intent")
            .json(&serde_json::json!({"artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z"}))
            .send().await.unwrap();
        // A missing production namespace/publisher fails safely without enqueuing.
        assert_eq!(response.status(), 503);
    }
    let response = server
        .client
        .post(server.url("/api/v1/scrobbles"))
        .header("cookie", session.cookie.split(';').next().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "60");
    let error: serde_json::Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "rate_limited");
    for _ in 0..120 {
        assert_eq!(
            server
                .client
                .get(server.url("/api/v1/meta"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let response = server
        .client
        .get(server.url("/api/v1/meta"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "60");
    *clock.0.lock().unwrap() += chrono::Duration::seconds(59);
    let response = server
        .client
        .get(server.url("/api/v1/meta"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "1");
    *clock.0.lock().unwrap() += chrono::Duration::seconds(1);
    assert_eq!(
        server
            .client
            .get(server.url("/api/v1/meta"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM operations")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn bounded_state() {
    let limiter = Limiter::default();
    for number in 0..MAX_KEYS as u32 {
        assert!(
            limiter
                .admit(
                    RateKey::Anonymous(IpAddr::from(number.to_be_bytes())),
                    1_768_478_400
                )
                .is_ok()
        );
    }
    assert_eq!(limiter.key_count(), MAX_KEYS);
    assert_eq!(
        limiter.admit(
            RateKey::Anonymous(IpAddr::from((MAX_KEYS as u32).to_be_bytes())),
            1_768_478_400
        ),
        Err(60)
    );
    assert_eq!(limiter.key_count(), MAX_KEYS);
    assert!(
        limiter
            .admit(
                RateKey::Anonymous(IpAddr::from((MAX_KEYS as u32).to_be_bytes())),
                1_768_478_460
            )
            .is_ok()
    );
    assert_eq!(limiter.key_count(), 1);
    let server = TestServer::start_with_clock(time()).await;
    for number in 0..120 {
        assert_eq!(
            server
                .client
                .get(server.url("/api/v1/meta"))
                .header("x-forwarded-for", format!("192.0.2.{number}"))
                .header("forwarded", format!("for=192.0.2.{number}"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let response = server
        .client
        .get(server.url("/api/v1/meta"))
        .header("x-forwarded-for", "198.51.100.99")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(server.state.limiter.key_count(), 1);
    assert_eq!(
        server
            .client
            .get(server.url("/health/live"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(!server.shutdown().await.timed_out);
}
