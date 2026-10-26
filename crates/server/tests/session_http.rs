mod common;

use std::sync::Arc;

use atmusic_server::{Clock, auth::session};
use atmusic_storage::User;
use chrono::{DateTime, Utc};
use reqwest::header::{HeaderMap, HeaderValue};

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

async fn fixture() -> (common::TestServer, session::IssuedSession) {
    let now = DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let server = common::TestServer::start_with_clock(Arc::new(FixedClock(now))).await;
    server
        .database
        .repositories()
        .upsert_user(User::new(
            "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
            now.to_rfc3339(),
        ))
        .await
        .unwrap();
    let issued = session::issue(
        &server.database,
        &[0x11; 32],
        "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        now,
    )
    .await
    .unwrap();
    (server, issued)
}

fn valid_headers(issued: &session::IssuedSession) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        issued.cookie.split(';').next().unwrap().parse().unwrap(),
    );
    headers.insert("origin", "https://music.example".parse().unwrap());
    headers.insert("x-csrf-token", issued.csrf_token.parse().unwrap());
    headers
}

async fn error_response(response: reqwest::Response, status: u16, code: &str) {
    assert_eq!(response.status().as_u16(), status);
    let id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    uuid::Uuid::parse_str(&id).unwrap();
    let body = response.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["error"]["code"], code);
    assert_eq!(body["error"]["requestId"], id);
}

#[tokio::test]
async fn logout_local() {
    let (server, issued) = fixture().await;
    let valid = valid_headers(&issued);
    for mutation in 0..7 {
        let mut headers = valid.clone();
        match mutation {
            0 => {
                headers.remove("origin");
            }
            1 => {
                headers.insert("origin", "https://attacker.example".parse().unwrap());
            }
            2 => {
                headers.insert("origin", "null".parse().unwrap());
            }
            3 => {
                headers.remove("x-csrf-token");
            }
            4 => {
                headers.insert("x-csrf-token", "00".repeat(32).parse().unwrap());
            }
            5 => {
                headers.append("origin", "https://music.example".parse().unwrap());
            }
            _ => {
                headers.append("x-csrf-token", issued.csrf_token.parse().unwrap());
            }
        }
        let response = server
            .client
            .post(server.url("/api/v1/auth/logout"))
            .headers(headers)
            .send()
            .await
            .unwrap();
        error_response(response, 403, "csrf_failed").await;
        let counts = sqlx::query_as::<_, (i64,i64,i64)>(
            "SELECT (SELECT COUNT(*) FROM sessions),(SELECT COUNT(*) FROM operations),(SELECT COUNT(*) FROM outbox)"
        ).fetch_one(server.database.reader_pool()).await.unwrap();
        assert_eq!(
            counts,
            (1, 0, 0),
            "mutation {mutation} changed persistent state before admission"
        );
        let response = server
            .client
            .get(server.url("/api/v1/auth/session"))
            .headers(valid.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            200,
            "session unusable after rejection {mutation}"
        );
        let body = response.json::<serde_json::Value>().await.unwrap();
        assert_eq!(body["csrfToken"], issued.csrf_token);
        assert_eq!(body["did"], "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    }
    let response = server
        .client
        .post(server.url("/api/v1/auth/logout"))
        .headers(valid.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    let cleared = response.headers()["set-cookie"].to_str().unwrap();
    for attribute in [
        "atmusic_session=",
        "Max-Age=0",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
    ] {
        assert!(
            cleared.contains(attribute),
            "missing logout cookie attribute {attribute}"
        );
    }
    assert!(response.bytes().await.unwrap().is_empty());
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let response = server
        .client
        .get(server.url("/api/v1/auth/session"))
        .headers(valid)
        .send()
        .await
        .unwrap();
    error_response(response, 401, "unauthenticated").await;
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn malformed_or_ambiguous_cookies_are_unauthenticated() {
    let (server, issued) = fixture().await;
    let valid = valid_headers(&issued);
    for mutation in 0..5 {
        let mut headers = valid.clone();
        match mutation {
            0 => {
                headers.remove("cookie");
            }
            1 => {
                headers.insert("cookie", "atmusic_session=short".parse().unwrap());
            }
            2 => {
                headers.append("cookie", valid["cookie"].clone());
            }
            3 => {
                headers.insert(
                    "cookie",
                    format!("atmusic_session={}", "x".repeat(64))
                        .parse()
                        .unwrap(),
                );
            }
            _ => {
                headers.append("cookie", HeaderValue::from_bytes(b"other=\xff").unwrap());
            }
        }
        let response = server
            .client
            .get(server.url("/api/v1/auth/session"))
            .headers(headers)
            .send()
            .await
            .unwrap();
        error_response(response, 401, "unauthenticated").await;
        let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap();
        assert_eq!(count, 1, "malformed cookie deleted the valid session");
    }
    assert!(!server.shutdown().await.timed_out);
}
