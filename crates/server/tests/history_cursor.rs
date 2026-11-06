//! HTTP/SQLite cursor regressions seeded through production signature/CID/MST verification.
mod common;

use atmusic_core::cursor::{CursorBinding, CursorCodec, CursorPosition, PageCursor};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::HashSet, sync::atomic::Ordering};
#[path = "common/read_projection.rs"]
mod projection;
use projection::{ALICE, AS_OF, BOB, CANONICAL_AS_OF, assert_error, assert_page, items, server};
fn uri(rkey: &str) -> String {
    projection::uri(ALICE, rkey)
}
async fn seed(server: &common::TestServer) -> projection::ReadFixtures {
    projection::seed(server, false).await
}

async fn page(server: &common::TestServer, did: &str, limit: u32, token: Option<&str>) -> Value {
    let mut request = server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/scrobbles")))
        .query(&[("limit", limit.to_string())]);
    if let Some(token) = token {
        request = request.query(&[("cursor", token)]);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_page(&body);
    body
}

#[tokio::test]
async fn equal_timestamp() {
    let (server, clock) = server().await;
    seed(&server).await;
    let mut token = None;
    let mut result = Vec::new();
    let mut pages = 0;
    loop {
        let body = page(&server, ALICE, 1, token.as_deref()).await;
        assert_eq!(body["asOf"], CANONICAL_AS_OF);
        let returned = items(&body);
        assert_eq!(returned.len(), 1);
        result.extend(returned);
        token = body["nextCursor"].as_str().map(str::to_owned);
        pages += 1;
        if token.is_none() {
            break;
        }
        assert!(pages < 10, "cursor must make progress");
        clock.0.fetch_add(60, Ordering::SeqCst);
    }
    assert_eq!(
        result,
        ["r07", "r01", "r02", "r03", "r04", "r05", "r06"].map(uri)
    );
    assert_eq!(result.iter().collect::<HashSet<_>>().len(), result.len());
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn between_pages() {
    let (server, _) = server().await;
    let mut fixtures = seed(&server).await;
    let first = page(&server, ALICE, 2, None).await;
    assert_eq!(items(&first), ["r07", "r01"].map(uri));
    let token = first["nextCursor"].as_str().unwrap();
    let repository = server.database.repositories();
    fixtures.put(&server, ALICE, "arrival", json!({
        "artist":"Arrival", "track":"Newer listen", "listenedAt":"2026-01-15T11:30:00Z", "createdAt":AS_OF,
    })).await;
    fixtures.delete(&server, ALICE, &uri("r02")).await;
    let mut all = items(&first);
    let mut token = Some(token.to_owned());
    while let Some(current) = token {
        let body = page(&server, ALICE, 2, Some(&current)).await;
        assert_eq!(body["asOf"], CANONICAL_AS_OF);
        all.extend(items(&body));
        token = body["nextCursor"].as_str().map(str::to_owned);
        assert!(all.len() <= 7);
    }
    assert_eq!(all, ["r07", "r01", "r03", "r04", "r05", "r06"].map(uri));
    assert_eq!(all.iter().collect::<HashSet<_>>().len(), all.len());
    assert_eq!(
        items(&page(&server, ALICE, 2, None).await),
        ["arrival", "r07"].map(uri)
    );
    assert!(repository.scrobble(&uri("r02")).await.unwrap().is_none());
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn current_record_update_visibility() {
    let (server, _) = server().await;
    let mut fixtures = seed(&server).await;
    let first = page(&server, ALICE, 2, None).await;
    assert_eq!(items(&first), ["r07", "r01"].map(uri));
    let token = first["nextCursor"].as_str().unwrap();
    let repository = server.database.repositories();
    let mut unreturned = repository.scrobble(&uri("r02")).await.unwrap().unwrap();
    unreturned.listened_at = "2026-01-15T11:30:00Z".into();
    fixtures.update(&server, unreturned).await;
    let mut returned = repository.scrobble(&uri("r07")).await.unwrap().unwrap();
    returned.listened_at = "2026-01-07T12:00:00Z".into();
    fixtures.update(&server, returned).await;
    let remaining = page(&server, ALICE, 100, Some(token)).await;
    assert_eq!(remaining["asOf"], CANONICAL_AS_OF);
    assert!(remaining["nextCursor"].is_null());
    assert_eq!(
        items(&remaining),
        ["r03", "r07", "r04", "r05", "r06"].map(uri)
    );
    assert_eq!(
        items(&page(&server, ALICE, 1, None).await),
        ["r02"].map(uri)
    );
    assert!(!server.shutdown().await.timed_out);
}

fn sign_payload(value: &Value) -> String {
    let mut derivation = Hmac::<Sha256>::new_from_slice(&[0x11; 32]).unwrap();
    derivation.update(b"atmusic:cursor:hmac-sha256:v1");
    let key = derivation.finalize().into_bytes();
    let bytes = serde_json::to_vec(value).unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(&bytes);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(bytes),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

#[tokio::test]
async fn cursor_binding() {
    let (server, _) = server().await;
    seed(&server).await;
    let first = page(&server, ALICE, 2, None).await;
    let token = first["nextCursor"].as_str().unwrap();
    let (encoded, signature) = token.split_once('.').unwrap();
    let bytes = URL_SAFE_NO_PAD.decode(encoded).unwrap();
    let mut tampered_bytes = bytes.clone();
    tampered_bytes[0] ^= 1;
    let mut unsupported: Value = serde_json::from_slice(&bytes).unwrap();
    unsupported["version"] = json!(2);
    let mut wrong_scope: Value = serde_json::from_slice(&bytes).unwrap();
    wrong_scope["binding"]["scope"] = json!("following");
    let positions = (
        CursorPosition::new("2026-01-15T11:00:00Z", uri("r07")).unwrap(),
        CursorPosition::new("2026-01-15T11:00:00Z", uri("r01")).unwrap(),
    );
    let private = PageCursor::new(
        CursorBinding::following_feed(ALICE),
        positions.0,
        positions.1,
        AS_OF,
    )
    .unwrap();
    let private_token = CursorCodec::from_application_key(&[0x11; 32])
        .unwrap()
        .encode(&private)
        .unwrap();
    let baseline: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    for (label, did, invalid) in [
        (
            "one_bit",
            ALICE,
            format!("{}.{}", URL_SAFE_NO_PAD.encode(tampered_bytes), signature),
        ),
        ("wrong_did", BOB, token.to_owned()),
        ("wrong_scope", ALICE, sign_payload(&wrong_scope)),
        ("wrong_query_viewer", ALICE, private_token),
        ("unsupported_version", ALICE, sign_payload(&unsupported)),
        ("malformed_base64", ALICE, "*invalid*.e30".into()),
        ("empty_cursor", ALICE, "".into()),
    ] {
        let response = server
            .client
            .get(server.url(&format!("/api/v1/users/{did}/scrobbles")))
            .query(&[("limit", "2"), ("cursor", &invalid)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{label}");
        let body = response.json::<Value>().await.unwrap();
        assert_error(&body, "invalid_cursor");
        assert!(
            body.get("items").is_none(),
            "{label}: no first-page fallback"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap();
        assert_eq!(count, baseline, "{label}: no storage mutation");
    }
    assert_eq!(
        items(&page(&server, ALICE, 2, Some(token)).await),
        ["r02", "r03"].map(uri)
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn lookup_and_limits() {
    let (server, _) = server().await;
    seed(&server).await;
    let encoded: String = url::form_urlencoded::byte_serialize(uri("r01").as_bytes()).collect();
    let response = server
        .client
        .get(server.url(&format!("/api/v1/scrobbles/{encoded}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["scrobble"]["uri"], uri("r01"));
    let encoded: String = url::form_urlencoded::byte_serialize(uri("absent").as_bytes()).collect();
    let response = server
        .client
        .get(server.url(&format!("/api/v1/scrobbles/{encoded}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_error(&response.json::<Value>().await.unwrap(), "not_found");
    for limit in ["0", "101", "-1", "abc", "1.5"] {
        let response = server
            .client
            .get(server.url(&format!("/api/v1/users/{ALICE}/scrobbles")))
            .query(&[("limit", limit)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "limit={limit}");
        let body = response.json::<Value>().await.unwrap();
        assert_error(&body, "invalid_query");
        assert!(body["error"]["fields"]["limit"].is_string());
    }
    assert_eq!(items(&page(&server, ALICE, 100, None).await).len(), 7);
    assert!(!server.shutdown().await.timed_out);
}
