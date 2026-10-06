//! Real HTTP/SQLite feed tests seeded and mutated through production repository verification.
mod common;
#[path = "common/read_projection.rs"]
mod projection;

use std::collections::HashSet;

use atmusic_server::auth::session;
use atmusic_storage::repositories::{NewOperation, User};
use chrono::{DateTime, Utc};
use projection::{
    ALICE, AS_OF, BOB, CANONICAL_AS_OF, CAROL, assert_error, assert_page, items, server, uri,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn feed(
    server: &common::TestServer,
    scope: &str,
    limit: u32,
    token: Option<&str>,
    cookie: Option<&str>,
) -> Value {
    let mut request = server
        .client
        .get(server.url("/api/v1/feed"))
        .query(&[("scope", scope.to_owned()), ("limit", limit.to_string())]);
    if let Some(token) = token {
        request = request.query(&[("cursor", token)]);
    }
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_page(&body);
    assert_eq!(body["asOf"], CANONICAL_AS_OF);
    body
}

async fn cookie(server: &common::TestServer, did: &str) -> String {
    let now = DateTime::parse_from_rfc3339(AS_OF)
        .unwrap()
        .with_timezone(&Utc);
    session::issue(&server.database, &[0x11; 32], did, now)
        .await
        .unwrap()
        .cookie
        .split(';')
        .next()
        .unwrap()
        .into()
}

fn expected() -> Vec<String> {
    [
        (BOB, "r09"),
        (CAROL, "r10"),
        (ALICE, "r07"),
        (ALICE, "r01"),
        (ALICE, "r02"),
        (ALICE, "r03"),
        (ALICE, "r04"),
        (ALICE, "r05"),
        (ALICE, "r06"),
    ]
    .into_iter()
    .map(|(did, rkey)| uri(did, rkey))
    .collect()
}

async fn extra_bob(server: &common::TestServer, fixtures: &mut projection::ReadFixtures) {
    fixtures.put(server, BOB, "r11", json!({
        "artist":"Massive Attack", "track":"Angel", "listenedAt":"2026-01-14T11:30:00Z", "createdAt":AS_OF,
    })).await;
}

#[tokio::test]
async fn page_union() {
    let (server, _) = server().await;
    projection::seed(&server, true).await;
    for limit in [1, 2] {
        let mut token = None;
        let mut result = Vec::new();
        loop {
            let body = feed(&server, "global", limit, token.as_deref(), None).await;
            result.extend(items(&body));
            token = body["nextCursor"].as_str().map(str::to_owned);
            assert!(
                result.len() <= 9,
                "pagination must progress without duplicates"
            );
            if token.is_none() {
                break;
            }
        }
        assert_eq!(result, expected(), "limit={limit}");
        assert_eq!(result.iter().collect::<HashSet<_>>().len(), result.len());
    }
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn global_order() {
    let (server, _) = server().await;
    projection::seed(&server, true).await;
    let response = server
        .client
        .get(server.url("/api/v1/feed"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_page(&body);
    assert_eq!(items(&body), expected());
    assert!(body["nextCursor"].is_null());
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn following_membership() {
    let (server, _) = server().await;
    projection::seed(&server, true).await;
    let cookie = cookie(&server, ALICE).await;
    let following = feed(&server, "following", 20, None, Some(&cookie)).await;
    assert_eq!(items(&following), [uri(BOB, "r09")]);
    assert!(following["nextCursor"].is_null());
    assert_eq!(
        items(&feed(&server, "global", 100, None, Some(&cookie)).await),
        expected()
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn scope_security() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    extra_bob(&server, &mut fixtures).await;
    let alice = cookie(&server, ALICE).await;
    let bob = cookie(&server, BOB).await;
    let first = feed(&server, "following", 1, None, Some(&alice)).await;
    let token = first["nextCursor"].as_str().unwrap();
    let anonymous = server
        .client
        .get(server.url("/api/v1/feed"))
        .query(&[("scope", "following"), ("cursor", token)])
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    assert_error(&anonymous.json::<Value>().await.unwrap(), "unauthenticated");
    for (scope, cookie) in [("following", Some(&bob)), ("global", None)] {
        let mut request = server
            .client
            .get(server.url("/api/v1/feed"))
            .query(&[("scope", scope), ("cursor", token)]);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 400);
        let body = response.json::<Value>().await.unwrap();
        assert_error(&body, "invalid_cursor");
        assert!(body.get("items").is_none());
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        10
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        items(&feed(&server, "following", 1, Some(token), Some(&alice)).await),
        [uri(BOB, "r11")]
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn follow_change() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    extra_bob(&server, &mut fixtures).await;
    let cookie = cookie(&server, ALICE).await;
    let first = feed(&server, "following", 1, None, Some(&cookie)).await;
    assert_eq!(items(&first), [uri(BOB, "r09")]);
    fixtures
        .delete(&server, ALICE, &projection::follow_uri(ALICE, BOB))
        .await;
    let later = feed(
        &server,
        "following",
        1,
        first["nextCursor"].as_str(),
        Some(&cookie),
    )
    .await;
    assert!(items(&later).is_empty());
    assert!(later["nextCursor"].is_null());
    assert_eq!(
        items(&feed(&server, "global", 100, None, None).await).len(),
        10
    );
    assert_eq!(
        server
            .database
            .repositories()
            .history(BOB, Default::default())
            .await
            .unwrap()
            .len(),
        2
    );
    assert!(
        server
            .database
            .repositories()
            .follow_list(ALICE, false, 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn arrival_boundary() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let first = feed(&server, "global", 2, None, None).await;
    fixtures.put(&server, ALICE, "arrival", json!({
        "artist":"Arrival", "track":"New record", "listenedAt":"2026-01-15T11:55:00Z", "createdAt":AS_OF,
    })).await;
    let mut all = items(&first);
    let mut token = first["nextCursor"].as_str().map(str::to_owned);
    while let Some(current) = token {
        let next = feed(&server, "global", 2, Some(&current), None).await;
        all.extend(items(&next));
        token = next["nextCursor"].as_str().map(str::to_owned);
        assert!(all.len() <= 9);
    }
    assert_eq!(all, expected());
    assert_eq!(
        items(&feed(&server, "global", 1, None, None).await),
        [uri(ALICE, "arrival")]
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn external_delete_update() {
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let first = feed(&server, "global", 2, None, None).await;
    let repository = server.database.repositories();
    let mut unreturned = repository
        .scrobble(&uri(ALICE, "r02"))
        .await
        .unwrap()
        .unwrap();
    unreturned.listened_at = "2026-01-15T11:45:00Z".into();
    let mut returned = repository
        .scrobble(&uri(BOB, "r09"))
        .await
        .unwrap()
        .unwrap();
    returned.listened_at = "2026-01-07T12:00:00Z".into();
    fixtures.delete(&server, ALICE, &uri(ALICE, "r07")).await;
    fixtures.update(&server, unreturned).await;
    fixtures.update(&server, returned).await;
    let remaining = feed(&server, "global", 100, first["nextCursor"].as_str(), None).await;
    assert_eq!(
        items(&remaining),
        [
            (ALICE, "r01"),
            (ALICE, "r03"),
            (BOB, "r09"),
            (ALICE, "r04"),
            (ALICE, "r05"),
            (ALICE, "r06")
        ]
        .map(|(owner, rkey)| uri(owner, rkey))
    );
    assert!(remaining["nextCursor"].is_null());
    assert!(
        repository
            .scrobble(&uri(ALICE, "r07"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        items(&feed(&server, "global", 1, None, None).await),
        [uri(ALICE, "r02")]
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn feed_limits() {
    let (server, _) = server().await;
    projection::seed(&server, true).await;
    for (field, value) in [
        ("scope", "unknown"),
        ("scope", ""),
        ("limit", "0"),
        ("limit", "101"),
        ("limit", "-1"),
        ("limit", "1.5"),
    ] {
        let response = server
            .client
            .get(server.url("/api/v1/feed"))
            .query(&[(field, value)])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422);
        let body = response.json::<Value>().await.unwrap();
        assert_error(&body, "invalid_query");
        assert!(body["error"]["fields"][field].is_string());
    }
    let valid = feed(&server, "global", 1, None, None).await;
    assert_eq!(items(&valid), [uri(BOB, "r09")]);
    assert!(valid["nextCursor"].is_string());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        9
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        0
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn feed_visibility() {
    const INACTIVE: &str = "did:plc:dddddddddddddddddddddddd";
    let (server, _) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let repository = server.database.repositories();
    let mut inactive = User::new(INACTIVE, "2025-01-01T00:00:00Z");
    inactive.active = false;
    repository.upsert_user(inactive).await.unwrap();
    fixtures.put(&server, INACTIVE,"inactive", json!({
        "artist":"Inactive", "track":"Hidden", "listenedAt":"2026-01-15T11:59:00Z", "createdAt":AS_OF,
    })).await;
    let pending = json!({"$type":"com.example.atmusic.scrobble","artist":"Pending","track":"Unconfirmed","listenedAt":AS_OF,"createdAt":AS_OF});
    repository
        .admit_operation(
            NewOperation {
                operation_id: uuid::Uuid::new_v4().to_string(),
                owner: ALICE.into(),
                kind: "scrobble_create".into(),
                created_at: AS_OF.into(),
                record_uri: Some(uri(ALICE, "pending")),
                collection: "com.example.atmusic.scrobble".into(),
                rkey: "pending".into(),
                payload_json: Some(pending.to_string()),
                canonical_digest: Some(hex::encode(Sha256::digest(pending.to_string().as_bytes()))),
            },
            None,
        )
        .await
        .unwrap();
    let malformed = json!({"$type":"com.example.atmusic.scrobble","artist":"","track":"Invalid","listenedAt":AS_OF,"createdAt":AS_OF});
    fixtures.put(&server, ALICE, "malformed", malformed).await;
    assert_eq!(
        fixtures.excluded,
        [uri(ALICE, "malformed")],
        "signed invalid record was excluded by the production verifier"
    );
    assert!(
        repository
            .scrobble(&uri(ALICE, "malformed"))
            .await
            .unwrap()
            .is_none()
    );
    let body = feed(&server, "global", 100, None, None).await;
    assert_eq!(items(&body), expected());
    assert!(
        items(&body).contains(&uri(CAROL, "r10")),
        "external projection retained"
    );
    assert!(
        repository
            .scrobble(&uri(ALICE, "pending"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        repository
            .scrobble(&uri(INACTIVE, "inactive"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        repository.outbox_due(AS_OF, 10).await.unwrap().len(),
        1,
        "pending operation retained without public confirmation"
    );
    assert!(!server.shutdown().await.timed_out);
}
