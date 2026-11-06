//! Exact M3.1.2 HTTP history cases over genuinely signed repository projections.
mod common;
#[path = "common/read_projection.rs"]
mod projection;

use async_trait::async_trait;
use atmusic_atproto::{
    pds::reconcile::canonical_digest,
    sync::backfill::{
        BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource,
    },
};
use atmusic_core::namespace::Namespace;
use atmusic_server::auth::session;
use atmusic_storage::{NewOperation, SnapshotOutcome, User};
use chrono::{DateTime, Utc};
use projection::{ALICE, AS_OF, BOB, CANONICAL_AS_OF, CAROL, assert_error, items, signed_repo};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
};

const DAVE: &str = "did:plc:dddddddddddddddddddddddd";
const UNKNOWN: &str = "did:plc:eeeeeeeeeeeeeeeeeeeeeeee";

async fn history(
    server: &common::TestServer,
    did: &str,
    limit: Option<u32>,
    cursor: Option<&str>,
    cookie: Option<&str>,
) -> Value {
    let mut request = server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/scrobbles")));
    if let Some(limit) = limit {
        request = request.query(&[("limit", limit)]);
    }
    if let Some(cursor) = cursor {
        request = request.query(&[("cursor", cursor)]);
    }
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("set-cookie").is_none());
    let page = response.json::<Value>().await.unwrap();
    assert_eq!(page.as_object().unwrap().len(), 4);
    assert_eq!(page["asOf"], CANONICAL_AS_OF);
    assert_eq!(page["indexing"]["state"], "recovering");
    assert_eq!(page["indexing"]["caughtUp"], false);
    assert!(page["indexing"]["lagSeconds"].is_null());
    assert!(page["nextCursor"].is_null() || page["nextCursor"].is_string());
    for item in page["items"].as_array().unwrap() {
        assert_eq!(item["did"], did, "history must stay within its DID scope");
        let cid: ipld_core::cid::Cid = item["cid"].as_str().unwrap().parse().unwrap();
        assert_eq!(cid.codec(), 0x71);
        for private in [
            "confirmed",
            "artistKey",
            "trackKey",
            "albumKey",
            "payloadJson",
            "operationId",
        ] {
            assert!(item.get(private).is_none(), "private field {private}");
        }
    }
    page
}

async fn lookup(server: &common::TestServer, uri: &str, cookie: Option<&str>) -> reqwest::Response {
    let encoded: String = url::form_urlencoded::byte_serialize(uri.as_bytes()).collect();
    let mut request = server
        .client
        .get(server.url(&format!("/api/v1/scrobbles/{encoded}")));
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn history_exact_order() {
    let (server, _) = projection::server().await;
    projection::seed(&server, true).await;
    let expected_pages: [&[&str]; 4] =
        [&["r07", "r01"], &["r02", "r03"], &["r04", "r05"], &["r06"]];
    let mut cursor = None;
    let mut seen = Vec::new();
    for (index, expected) in expected_pages.iter().enumerate() {
        let page = history(&server, ALICE, Some(2), cursor.as_deref(), None).await;
        projection::assert_page(&page);
        let uris = items(&page);
        assert_eq!(
            uris,
            expected
                .iter()
                .map(|key| projection::uri(ALICE, key))
                .collect::<Vec<_>>()
        );
        seen.extend(uris);
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        assert_eq!(cursor.is_some(), index < 3);
        if index == 0 {
            assert_eq!(page["items"][0]["track"], "No Surprises");
            assert_eq!(page["items"][1]["track"], "Jóga");
            assert_eq!(
                page["items"][0]["listenedAt"],
                page["items"][1]["listenedAt"]
            );
        }
    }
    assert_eq!(
        seen,
        ["r07", "r01", "r02", "r03", "r04", "r05", "r06"].map(|key| projection::uri(ALICE, key))
    );
    assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 7);
    let bob = history(&server, BOB, Some(100), None, None).await;
    assert_eq!(items(&bob), [projection::uri(BOB, "r09")]);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn visibility() {
    let (server, clock) = projection::server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let original: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/read_models.json")).unwrap();
    let mut pending = original["scrobbles"][0]["record"].clone();
    pending["artist"] = json!("PRIVATE_PENDING_ARTIST");
    pending["track"] = json!("PRIVATE_PENDING_TRACK");
    server
        .database
        .repositories()
        .admit_operation(
            NewOperation {
                operation_id: "private-pending-r10".into(),
                owner: ALICE.into(),
                kind: "scrobble_create".into(),
                created_at: AS_OF.into(),
                record_uri: Some(projection::uri(ALICE, "r10")),
                collection: "com.example.atmusic.scrobble".into(),
                rkey: "r10".into(),
                payload_json: Some(pending.to_string()),
                canonical_digest: Some(canonical_digest(&pending)),
            },
            Some("pending-r10-once".into()),
        )
        .await
        .unwrap();
    let deleted = original["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["rkey"] == "r08")
        .unwrap()["record"]
        .clone();
    fixtures.put(&server, ALICE, "r08", deleted).await;
    assert_eq!(
        lookup(&server, &projection::uri(ALICE, "r08"), None)
            .await
            .status(),
        200
    );
    fixtures
        .delete(&server, ALICE, &projection::uri(ALICE, "r08"))
        .await;
    fixtures.put(&server, ALICE, "malformed", json!({
        "artist":"   ","track":"Rejected signed record","listenedAt":AS_OF,"createdAt":AS_OF,
    })).await;
    assert_eq!(fixtures.excluded, [projection::uri(ALICE, "malformed")]);
    fixtures.put(&server, ALICE, "future-accepted", json!({
        "artist":"Future boundary","track":"Accepted at plus300","listenedAt":"2026-01-15T12:05:00Z","createdAt":AS_OF,
    })).await;
    assert!(fixtures.excluded.is_empty());
    fixtures.put(&server, ALICE, "future-rejected", json!({
        "artist":"Future boundary","track":"Rejected at plus301","listenedAt":"2026-01-15T12:05:01Z","createdAt":AS_OF,
    })).await;
    assert_eq!(
        fixtures.excluded,
        [projection::uri(ALICE, "future-rejected")]
    );
    let bob_session = session::issue(
        &server.database,
        server.state.config.as_ref().unwrap().encryption_key(),
        BOB,
        server.state.clock.now(),
    )
    .await
    .unwrap();
    let bob_cookie = bob_session.cookie.split(';').next().unwrap();
    let response = server
        .client
        .get(server.url("/api/v1/auth/session"))
        .header("cookie", bob_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["did"], BOB);
    let anonymous = history(&server, ALICE, Some(100), None, None).await;
    let authenticated = history(&server, ALICE, Some(100), None, Some(bob_cookie)).await;
    assert_eq!(anonymous, authenticated);
    assert_eq!(
        items(&anonymous),
        [
            "future-accepted",
            "r07",
            "r01",
            "r02",
            "r03",
            "r04",
            "r05",
            "r06"
        ]
        .map(|key| projection::uri(ALICE, key))
    );
    for cookie in [None, Some(bob_cookie)] {
        for key in ["r10", "r08", "malformed", "future-rejected", "nonexistent"] {
            let response = lookup(&server, &projection::uri(ALICE, key), cookie).await;
            assert_eq!(response.status(), 404, "{key}");
            assert_error(&response.json::<Value>().await.unwrap(), "not_found");
        }
        let future = lookup(&server, &projection::uri(ALICE, "future-accepted"), cookie).await;
        assert_eq!(future.status(), 200);
        assert_eq!(
            future.json::<Value>().await.unwrap()["scrobble"]["listenedAt"],
            "2026-01-15T12:05:00.000000000Z"
        );
        // Same rkey on another DID remains its own public verified record.
        let carol = lookup(&server, &projection::uri(CAROL, "r10"), cookie).await;
        assert_eq!(carol.status(), 200);
        assert_eq!(
            carol.json::<Value>().await.unwrap()["scrobble"]["did"],
            CAROL
        );
    }
    let serialized = anonymous.to_string();
    for private in [
        "PRIVATE_PENDING_ARTIST",
        "PRIVATE_PENDING_TRACK",
        "private-pending-r10",
        &bob_session.csrf_token,
        bob_cookie,
    ] {
        assert!(
            !serialized.contains(private),
            "public history exposed pending/session material"
        );
    }
    let operation = server
        .database
        .repositories()
        .operation(ALICE, "private-pending-r10")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(operation.state, "pending");
    assert_eq!(operation.attempts, 0);
    let stats = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/stats")))
        .send()
        .await
        .unwrap();
    assert_eq!(stats.status(), 200);
    assert_eq!(
        stats.json::<Value>().await.unwrap()["totalScrobbles"],
        7,
        "future public record is excluded from statistics until its listen time"
    );
    clock.0.fetch_add(300, Ordering::SeqCst);
    let stats = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/stats")))
        .send()
        .await
        .unwrap();
    assert_eq!(stats.status(), 200);
    assert_eq!(stats.json::<Value>().await.unwrap()["totalScrobbles"], 8);
    assert!(!server.shutdown().await.timed_out);
}

struct SignedSnapshot(Vec<u8>);
#[async_trait]
impl SnapshotSource for SignedSnapshot {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        assert_eq!(did, DAVE);
        Ok(FetchedSnapshot {
            pds: "https://pds.fixture.test".into(),
            bytes: self.0.clone(),
        })
    }
}
struct FrozenReceipt;
impl ReceiptClock for FrozenReceipt {
    fn now(&self) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(AS_OF)
            .unwrap()
            .with_timezone(&Utc)
    }
}

#[tokio::test]
async fn default_twenty_pages() {
    let (server, _) = projection::server().await;
    server
        .database
        .repositories()
        .upsert_user(User::new(DAVE, AS_OF))
        .await
        .unwrap();
    let records = (0..44).map(|index| (format!("com.example.atmusic.scrobble/listen-{index:02}"), json!({
        "$type":"com.example.atmusic.scrobble", "artist":"Signed history", "track":format!("Listen {index:02}"),
        "listenedAt":"2026-01-15T11:00:00Z", "createdAt":AS_OF,
    }))).collect();
    let signed = signed_repo::signed_repo_for(DAVE, records, 4, "3m3ijqc2abc22").await;
    let coordinator = Arc::new(BackfillCoordinator::new(
        server.database.repositories(),
        Namespace::new("com.example.atmusic").unwrap(),
        Arc::new(SignedSnapshot(signed.event.blocks)),
        Arc::new(signed_repo::FixtureResolver(signed.key)),
        Arc::new(FrozenReceipt),
    ));
    coordinator.schedule(DAVE, false).await.unwrap();
    let results = coordinator.run_batch().await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.as_ref().unwrap(),
        &SnapshotOutcome::Complete
    );
    let expected: Vec<_> = (0..44)
        .rev()
        .map(|index| projection::uri(DAVE, &format!("listen-{index:02}")))
        .collect();
    let mut cursor = None;
    let mut all = Vec::new();
    let mut first_row = None;
    for (index, expected_length) in [20, 20, 4].into_iter().enumerate() {
        let page = history(&server, DAVE, None, cursor.as_deref(), None).await;
        let current = items(&page);
        assert_eq!(current.len(), expected_length);
        assert_eq!(current, expected[all.len()..all.len() + expected_length]);
        if index == 0 {
            first_row = Some(page["items"][0].clone());
        }
        all.extend(current);
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        assert_eq!(cursor.is_some(), index < 2);
    }
    assert_eq!(all, expected);
    assert_eq!(all.iter().collect::<HashSet<_>>().len(), 44);
    let lookup_response = lookup(&server, &projection::uri(DAVE, "listen-43"), None).await;
    assert_eq!(lookup_response.status(), 200);
    assert_eq!(
        lookup_response.json::<Value>().await.unwrap(),
        json!({"scrobble":first_row.unwrap()})
    );
    let missing = lookup(&server, &projection::uri(UNKNOWN, "absent"), None).await;
    assert_eq!(missing.status(), 404);
    assert_error(&missing.json::<Value>().await.unwrap(), "not_found");
    assert!(
        server
            .database
            .repositories()
            .user(UNKNOWN)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        server
            .database
            .repositories()
            .backfill(UNKNOWN)
            .await
            .unwrap()
            .is_none()
    );
    let unknown_history = history(&server, UNKNOWN, None, None, None).await;
    assert!(items(&unknown_history).is_empty());
    assert!(unknown_history["nextCursor"].is_null());
    assert!(
        server
            .database
            .repositories()
            .user(UNKNOWN)
            .await
            .unwrap()
            .is_none(),
        "public read must not create or crawl an unknown account"
    );
    assert!(
        server
            .database
            .repositories()
            .backfill(UNKNOWN)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!server.shutdown().await.timed_out);
}
