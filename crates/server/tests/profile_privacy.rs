//! Public profile field and cache contracts exercised through real HTTP/SQLite.
mod common;
#[path = "common/identity.rs"]
mod identity;
#[path = "common/read_projection.rs"]
mod projection;

use atmusic_atproto::oauth::token_store::TokenStore;
use atmusic_server::auth::session;
use atmusic_storage::NewOperation;
use identity::{ALICE, BOB, ControlledIdentity};
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
async fn profile(server: &common::TestServer, cookie: Option<&str>) -> reqwest::Response {
    let request = server
        .client
        .get(server.url(&format!("/api/v1/users/{ALICE}/profile")));
    match cookie {
        Some(cookie) => request.header("cookie", cookie),
        None => request,
    }
    .send()
    .await
    .unwrap()
}
async fn issue(server: &common::TestServer, did: &str) -> session::IssuedSession {
    session::issue(
        &server.database,
        server.state.config.as_ref().unwrap().encryption_key(),
        did,
        server.state.clock.now(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn sensitive_fields() {
    let (server, _identity) = server().await;
    projection::seed(&server, true).await;
    let store = TokenStore::new(
        server.database.repositories(),
        server.state.config.as_ref().unwrap().encryption_key(),
    )
    .unwrap();
    let tokens = json!({"did":ALICE,"issuer":"https://issuer.test","expires_at":1_768_482_000,
        "access_token":"DUMMY_PRIVATE_ACCESS_TOKEN","refresh_token":"DUMMY_PRIVATE_REFRESH_TOKEN",
        "dpop_private_pem":"DUMMY_PRIVATE_SIGNING_KEY","email":"DUMMY_PRIVATE_EMAIL@example.test"});
    store
        .put_oauth_tokens(ALICE, &tokens, 1_768_478_400)
        .await
        .unwrap();
    let issued = issue(&server, ALICE).await;
    server.database.repositories().admit_operation(NewOperation {
        operation_id:"DUMMY_PRIVATE_OPERATION_ID".into(), owner:ALICE.into(), kind:"scrobble_create".into(),
        created_at:projection::AS_OF.into(), record_uri:Some(projection::uri(ALICE,"private-listen")), collection:"com.example.atmusic.scrobble".into(),
        rkey:"private-listen".into(), payload_json:Some(json!({"privatePayload":"DUMMY_PRIVATE_OPERATION_PAYLOAD","email":"DUMMY_PRIVATE_EMAIL@example.test"}).to_string()),
        canonical_digest:Some("DUMMY_PRIVATE_DIGEST".into()),
    },None).await.unwrap();
    let response = profile(&server, None).await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("set-cookie").is_none());
    assert_eq!(response.headers()["cache-control"], "no-store");
    let text = response.text().await.unwrap();
    for forbidden in [
        "DUMMY_PRIVATE_ACCESS_TOKEN",
        "DUMMY_PRIVATE_REFRESH_TOKEN",
        "DUMMY_PRIVATE_SIGNING_KEY",
        "DUMMY_PRIVATE_EMAIL",
        "DUMMY_PRIVATE_OPERATION_PAYLOAD",
        "DUMMY_PRIVATE_OPERATION_ID",
        "DUMMY_PRIVATE_DIGEST",
        "access_token",
        "accessToken",
        "refresh_token",
        "refreshToken",
        "dpop_private_pem",
        "email",
        "session",
        "csrfToken",
        "privatePayload",
        "payload_json",
        "encrypted_material",
        &issued.csrf_token,
        issued
            .cookie
            .split('=')
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap(),
    ] {
        assert!(
            !text.contains(forbidden),
            "public profile exposed {forbidden}"
        );
    }
    let body: Value = serde_json::from_str(&text).unwrap();
    let keys: std::collections::BTreeSet<_> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "did",
            "handle",
            "joinedAt",
            "indexedAt",
            "totalScrobbles",
            "followerCount",
            "followingCount",
            "indexing"
        ]
        .into_iter()
        .collect()
    );
    assert_eq!(
        body["totalScrobbles"], 7,
        "private pending listen must not affect counts"
    );
    assert_eq!(store.get_oauth_tokens(ALICE).await.unwrap(), Some(tokens));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        1
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn owner_equality() {
    let (server, _identity) = server().await;
    projection::seed(&server, true).await;
    let alice = issue(&server, ALICE).await;
    let bob = issue(&server, BOB).await;
    // Prove both cookies are authenticated through the real session route.
    for (issued, did) in [(&alice, ALICE), (&bob, BOB)] {
        let session = server
            .client
            .get(server.url("/api/v1/auth/session"))
            .header("cookie", &issued.cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(session.status(), 200);
        assert_eq!(session.json::<Value>().await.unwrap()["did"], did);
    }
    let mut payloads = Vec::new();
    for cookie in [None, Some(alice.cookie.as_str()), Some(bob.cookie.as_str())] {
        let response = profile(&server, cookie).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(response.headers().get("set-cookie").is_none());
        payloads.push(response.json::<Value>().await.unwrap());
    }
    assert_eq!(payloads[0], payloads[1]);
    assert_eq!(payloads[1], payloads[2]);
    assert_eq!(payloads[0]["totalScrobbles"], 7);
    assert_eq!(payloads[0]["followingCount"], 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions")
            .fetch_one(server.database.reader_pool())
            .await
            .unwrap(),
        2
    );
    assert!(!server.shutdown().await.timed_out);
}

#[tokio::test]
async fn cache_invalidation() {
    let (server, identity) = server().await;
    let mut fixtures = projection::seed(&server, true).await;
    let initial = profile(&server, None).await;
    assert_eq!(initial.headers()["cache-control"], "no-store");
    assert_eq!(initial.json::<Value>().await.unwrap()["totalScrobbles"], 7);
    let identity_calls = identity.calls();
    let new_uri = projection::uri(ALICE, "cache-listen");
    fixtures.put(&server,ALICE,"cache-listen",json!({"artist":"Cache Artist","track":"Fresh Listen","listenedAt":projection::AS_OF,"createdAt":projection::AS_OF})).await;
    let created = profile(&server, None).await;
    assert_eq!(created.headers()["cache-control"], "no-store");
    assert_eq!(created.json::<Value>().await.unwrap()["totalScrobbles"], 8);
    assert!(
        server
            .database
            .repositories()
            .scrobble(&new_uri)
            .await
            .unwrap()
            .is_some()
    );
    fixtures.delete(&server, ALICE, &new_uri).await;
    let deleted = profile(&server, None).await;
    assert_eq!(deleted.headers()["cache-control"], "no-store");
    assert_eq!(deleted.json::<Value>().await.unwrap()["totalScrobbles"], 7);
    assert!(
        server
            .database
            .repositories()
            .scrobble(&new_uri)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        identity.calls(),
        identity_calls,
        "confirmed changes visible while identity cache is still fresh"
    );
    // At 299s the old round trip can still be cached; precisely 300s refreshes.
    identity.rename(ALICE, "fresh-alias.test");
    identity.clock.set(299);
    assert_eq!(
        profile(&server, None).await.json::<Value>().await.unwrap()["handle"],
        "alice.test"
    );
    assert_eq!(identity.calls(), identity_calls);
    identity.clock.set(300);
    let refreshed = profile(&server, None).await.json::<Value>().await.unwrap();
    assert_eq!(refreshed["handle"], "fresh-alias.test");
    assert_eq!(refreshed["totalScrobbles"], 7);
    assert_eq!(identity.calls(), identity_calls + 2);
    assert!(!server.shutdown().await.timed_out);
}
