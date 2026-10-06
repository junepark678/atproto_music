//! Profile reads from signed and verified repository fixtures. Discovery and
//! verified alias round trips remain separate identity requirements.
mod common;
#[path = "common/identity.rs"]
mod identity;
#[path = "common/read_projection.rs"]
mod projection;

use atmusic_storage::Indexing;
use chrono::DateTime;
use projection::{ALICE, BOB, CANONICAL_AS_OF};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::AtomicI64};

async fn server() -> (common::TestServer, identity::ControlledIdentity) {
    let identity = identity::ControlledIdentity::start().await;
    let clock = Arc::new(projection::FixedClock(AtomicI64::new(1_768_478_400)));
    let server = common::TestServer::start_with_state(clock, |state| {
        state.with_identity(identity.resolver.clone())
    })
    .await;
    (server, identity)
}

async fn profile(server: &common::TestServer, did: &str) -> Value {
    let response = server
        .client
        .get(server.url(&format!("/api/v1/users/{did}/profile")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

#[tokio::test]
async fn profile_fields() {
    let (server, _identity) = server().await;
    projection::seed(&server, true).await;
    let repository = server.database.repositories();
    repository
        .set_indexing(
            ALICE.into(),
            Indexing {
                state: "current".into(),
                caught_up: true,
                last_indexed_at: Some(CANONICAL_AS_OF.into()),
                lag_seconds: Some(0),
            },
        )
        .await
        .unwrap();
    let body = profile(&server, ALICE).await;
    assert_eq!(
        body,
        json!({"did":ALICE,"handle":"alice.test","joinedAt":"2025-01-01T00:00:00.000000000Z",
        "indexedAt":CANONICAL_AS_OF,"totalScrobbles":7,"followerCount":0,"followingCount":1,
        "indexing":{"state":"recovering","caughtUp":false,"lastIndexedAt":CANONICAL_AS_OF,"lagSeconds":null}})
    );
    for field in ["joinedAt", "indexedAt"] {
        assert_eq!(
            DateTime::parse_from_rfc3339(body[field].as_str().unwrap())
                .unwrap()
                .offset()
                .local_minus_utc(),
            0
        );
    }
    let bob = profile(&server, BOB).await;
    assert_eq!(bob["totalScrobbles"], 1);
    assert_eq!(bob["followerCount"], 1);
    assert_eq!(bob["followingCount"], 0);
    assert_eq!(bob["handle"], "bob.test");
    let response = server
        .client
        .get(server.url("/api/v1/users/did:web:unknown.test/profile"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    projection::assert_error(&response.json().await.unwrap(), "not_found");
    let mut alice = repository.user(ALICE).await.unwrap().unwrap();
    alice.active = false;
    repository.upsert_user(alice).await.unwrap();
    let response = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/profile")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(profile(&server, BOB).await["followerCount"], 0);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn handle_rename() {
    let (server, identity) = server().await;
    projection::seed(&server, true).await;
    let repository = server.database.repositories();
    let before = profile(&server, ALICE).await;
    let history_path = format!("/api/v1/users/{ALICE}/scrobbles");
    let history_before: Value = server
        .client
        .get(server.url(&history_path))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let users_before: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(server.database.reader_pool())
        .await
        .unwrap();
    identity.rename(ALICE, "renamed.test");
    identity.clock.set(300);
    let resolved = server
        .client
        .get(server.url("/api/v1/resolve?handle=renamed.test"))
        .send()
        .await
        .unwrap();
    assert_eq!(resolved.status(), 200);
    assert_eq!(
        resolved.json::<Value>().await.unwrap(),
        json!({"did":ALICE,"handle":"renamed.test","verified":true})
    );
    let after = profile(&server, ALICE).await;
    assert_eq!(after["handle"], "renamed.test");
    for field in [
        "did",
        "joinedAt",
        "totalScrobbles",
        "followerCount",
        "followingCount",
    ] {
        assert_eq!(
            after[field], before[field],
            "handle refresh preserves {field}"
        );
    }
    let history_after: Value = server
        .client
        .get(server.url(&history_path))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history_after, history_before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        users_before
    );
    assert_eq!(repository.public_counts(ALICE).await.unwrap().0, 7);
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn unverified_alias() {
    let (server, identity) = server().await;
    projection::seed(&server, false).await;
    let repository = server.database.repositories();
    let mut user = repository.user(ALICE).await.unwrap().unwrap();
    user.handle = Some("alice.test".into());
    repository.upsert_user(user).await.unwrap();
    identity.alias(ALICE, "attacker.test");
    let response = server
        .client
        .get(server.url("/api/v1/resolve?handle=alice.test"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
    let error: Value = response.json().await.unwrap();
    projection::assert_error(&error, "identity_mismatch");
    assert!(error["error"]["fields"]["handle"].is_string());
    let body = profile(&server, ALICE).await;
    assert_eq!(body["handle"], Value::Null);
    assert_eq!(body["totalScrobbles"], 7);
    assert_eq!(body["did"], ALICE);
    assert_eq!(
        repository
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .handle
            .as_deref(),
        Some("alice.test")
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn resolve_status_contract() {
    let (server, identity) = server().await;
    let response = server
        .client
        .get(server.url("/api/v1/resolve?handle=Alice.TEST"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"did":ALICE,"handle":"alice.test","verified":true})
    );
    for query in [
        "",
        "?handle=not-a-handle",
        "?handle=did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa",
        "?handle=alice.test&extra=x",
        "?handle=alice.test&handle=bob.test",
    ] {
        let calls = identity.calls();
        let response = server
            .client
            .get(server.url(&format!("/api/v1/resolve{query}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "query {query}");
        let error: Value = response.json().await.unwrap();
        projection::assert_error(&error, "invalid_query");
        assert!(error["error"]["fields"]["handle"].is_string());
        assert_eq!(identity.calls(), calls);
    }
    let unresolved = server
        .client
        .get(server.url("/api/v1/resolve?handle=unknown.test"))
        .send()
        .await
        .unwrap();
    assert_eq!(unresolved.status(), 404);
    projection::assert_error(&unresolved.json().await.unwrap(), "not_found");
    identity.fail_upstream(true);
    let failure = server
        .client
        .get(server.url("/api/v1/resolve?handle=bob.test"))
        .send()
        .await
        .unwrap();
    assert_eq!(failure.status(), 502);
    let body = failure.text().await.unwrap();
    assert!(!body.contains("fixture-upstream-private-detail"));
    projection::assert_error(
        &serde_json::from_str(&body).unwrap(),
        "upstream_unavailable",
    );
    for table in [
        "users",
        "oauth_tokens",
        "oauth_states",
        "outbox",
        "operations",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(server.database.reader_pool())
                .await
                .unwrap(),
            0,
            "resolution must not populate {table}"
        );
    }
    let calls = identity.calls();
    let mut limited = None;
    for _ in 0..=120 {
        let response = server
            .client
            .get(server.url("/api/v1/resolve?handle=alice.test"))
            .send()
            .await
            .unwrap();
        if response.status() == 429 {
            limited = Some(response);
            break;
        }
        assert_eq!(response.status(), 200);
    }
    let limited = limited.expect("resolve must enforce the anonymous read quota");
    let retry = limited.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!((1..=60).contains(&retry));
    projection::assert_error(&limited.json().await.unwrap(), "rate_limited");
    assert_eq!(
        identity.calls(),
        calls,
        "cached and quota-denied lookups send no identity HTTP"
    );
    assert!(!server.shutdown().await.timed_out);
}
