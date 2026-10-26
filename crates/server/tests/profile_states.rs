//! Public state transitions never trigger unknown-user repository discovery.
mod common;
#[path = "common/identity.rs"]
mod identity;
#[path = "common/read_projection.rs"]
mod projection;

use atmusic_storage::{Indexing, User};
use identity::{ALICE, BOB, CAROL, ControlledIdentity};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::AtomicI64};

async fn server() -> (common::TestServer, ControlledIdentity) {
    let identity = ControlledIdentity::start().await;
    let server = common::TestServer::start_with_state(
        Arc::new(projection::FixedClock(AtomicI64::new(1_768_478_400))),
        |state| state.with_identity(identity.resolver.clone()),
    )
    .await;
    (server, identity)
}
async fn profile(server: &common::TestServer, did: &str) -> reqwest::Response {
    server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/profile")))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn unknown_empty() {
    let (server, identity) = server().await;
    let repository = server.database.repositories();
    let unknown = profile(&server, "did:plc:dddddddddddddddddddddddd").await;
    assert_eq!(unknown.status(), 404);
    projection::assert_error(&unknown.json().await.unwrap(), "not_found");
    assert_eq!(
        identity.calls(),
        0,
        "unknown profile must not trigger identity HTTP"
    );
    assert!(
        repository
            .user("did:plc:dddddddddddddddddddddddd")
            .await
            .unwrap()
            .is_none()
    );
    repository
        .upsert_user(User::new(BOB, "2025-01-01T00:00:00Z"))
        .await
        .unwrap();
    let known = profile(&server, BOB).await;
    assert_eq!(known.status(), 200);
    assert_eq!(known.headers()["cache-control"], "no-store");
    let body: Value = known.json().await.unwrap();
    assert_eq!(body["did"], BOB);
    assert_eq!(body["handle"], "bob.test");
    for field in ["totalScrobbles", "followerCount", "followingCount"] {
        assert_eq!(body[field], 0);
    }
    assert_eq!(body["indexedAt"], Value::Null);
    assert_eq!(
        body["indexing"],
        json!({"state":"recovering","caughtUp":false,"lastIndexedAt":null,"lagSeconds":null})
    );
    let history = server
        .client
        .get(server.url(&format!("/api/v1/users/{BOB}/scrobbles")))
        .send()
        .await
        .unwrap();
    assert_eq!(history.status(), 200);
    let history: Value = history.json().await.unwrap();
    assert_eq!(history["items"], json!([]));
    assert_eq!(history["nextCursor"], Value::Null);
    assert_eq!(
        repository
            .history(BOB, Default::default())
            .await
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn backfill_state() {
    let (server, _identity) = server().await;
    let repository = server.database.repositories();
    repository
        .upsert_user(User::new(CAROL, "2025-01-01T00:00:00Z"))
        .await
        .unwrap();
    repository
        .set_indexing(
            CAROL.into(),
            Indexing {
                state: "recovering".into(),
                caught_up: false,
                last_indexed_at: Some(projection::CANONICAL_AS_OF.into()),
                lag_seconds: Some(120),
            },
        )
        .await
        .unwrap();
    let response = profile(&server, CAROL).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["indexing"],
        json!({"state":"recovering","caughtUp":false,"lastIndexedAt":projection::CANONICAL_AS_OF,"lagSeconds":null})
    );
    assert_eq!(body["indexedAt"], Value::Null);
    assert_eq!(body["totalScrobbles"], 0);
    assert_eq!(body["handle"], "carol.test");
    assert!(body.get("completeHistory").is_none());
    assert!(!repository.indexing(CAROL).await.unwrap().caught_up);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn inactive_state() {
    let (server, identity) = server().await;
    projection::seed(&server, true).await;
    let repository = server.database.repositories();
    let active = profile(&server, ALICE).await;
    assert_eq!(active.status(), 200);
    assert_eq!(active.json::<Value>().await.unwrap()["totalScrobbles"], 7);
    let calls = identity.calls();
    let mut alice = repository.user(ALICE).await.unwrap().unwrap();
    alice.active = false;
    repository.upsert_user(alice).await.unwrap();
    let hidden = profile(&server, ALICE).await;
    assert_eq!(hidden.status(), 404);
    assert_eq!(hidden.headers()["cache-control"], "no-store");
    let body: Value = hidden.json().await.unwrap();
    projection::assert_error(&body, "not_found");
    assert!(body.get("totalScrobbles").is_none());
    assert_eq!(
        identity.calls(),
        calls,
        "inactive profile must not resolve cached identity"
    );
    assert_eq!(repository.public_counts(ALICE).await.unwrap(), (0, 0, 0));
    assert_eq!(
        profile(&server, BOB).await.json::<Value>().await.unwrap()["followerCount"],
        0
    );
    let history = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/scrobbles")))
        .send()
        .await
        .unwrap();
    assert_eq!(history.status(), 200);
    assert_eq!(history.json::<Value>().await.unwrap()["items"], json!([]));
    let global = server
        .client
        .get(server.url("/api/v1/feed?scope=global"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        global["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["did"] != ALICE)
    );
    assert!(!server.shutdown().await.timed_out);
}
