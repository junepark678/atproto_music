#[path = "common/account.rs"]
mod account;
mod common;
use account::{ALICE, AccountHarness, BOB, PATH};
use atmusic_storage::{NewOperation, OAuthState, User};
use serde_json::{Value, json};

async fn populated() -> (AccountHarness, account::Login, account::SignedFixture) {
    let harness = AccountHarness::new().await;
    let alice = harness.sign_in("alice.test").await;
    let fixture = account::signed().await;
    harness.recover(&fixture).await;
    harness
        .fixture
        .state
        .lock()
        .unwrap()
        .records
        .insert(format!("at://{ALICE}/{PATH}"), account::record());
    (harness, alice, fixture)
}
async fn pending(harness: &AccountHarness) {
    harness
        .server
        .database
        .repositories()
        .admit_operation(
            NewOperation {
                operation_id: "pending-private-operation".into(),
                owner: ALICE.into(),
                kind: "scrobble_create".into(),
                created_at: account::now().to_rfc3339(),
                record_uri: Some(format!("at://{ALICE}/com.example.atmusic.scrobble/pending")),
                collection: "com.example.atmusic.scrobble".into(),
                rkey: "pending".into(),
                payload_json: Some(json!({"artist":"pending","track":"unpublished"}).to_string()),
                canonical_digest: Some("pending-digest".into()),
            },
            Some("pending-idempotency".into()),
        )
        .await
        .unwrap();
    harness
        .server
        .database
        .repositories()
        .put_oauth_state(OAuthState {
            state_hash: "incomplete-authorization".into(),
            encrypted_material: b"marked-state".to_vec(),
            issuer: "https://authorization.fixture.test".into(),
            did: ALICE.into(),
            created_at: account::NOW,
            expires_at: account::NOW + 300,
        })
        .await
        .unwrap();
}
#[tokio::test]
async fn disconnect_effect() {
    let (harness, alice, _fixture) = populated().await;
    pending(&harness).await;
    harness
        .server
        .database
        .repositories()
        .upsert_user(User::new(BOB, account::now().to_rfc3339()))
        .await
        .unwrap();
    let bob = atmusic_server::auth::session::issue(
        &harness.server.database,
        harness
            .server
            .state
            .config
            .as_ref()
            .unwrap()
            .encryption_key(),
        BOB,
        account::now(),
    )
    .await
    .unwrap();
    let before = harness.remote_counts();
    let remote = harness.fixture.state.lock().unwrap().records.clone();
    // Origin and CSRF are enforced before the destructive local transaction.
    let denied = harness
        .client
        .delete(harness.server.url("/api/v1/account/local-data"))
        .header("cookie", &alice.cookie)
        .header("origin", "https://attacker.example")
        .header("x-csrf-token", &alice.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    assert_eq!(harness.count("operations").await, 1);
    assert_eq!(harness.count("scrobbles").await, 1);
    let response = harness.disconnect(&alice).await;
    assert_eq!(response.status(), 204);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    for flag in ["Secure", "HttpOnly", "SameSite=Lax", "Max-Age=0"] {
        assert!(cookie.contains(flag));
    }
    assert!(response.bytes().await.unwrap().is_empty());
    let repo = harness.server.database.repositories();
    assert!(repo.is_suppressed(ALICE).await.unwrap());
    assert!(repo.user(ALICE).await.unwrap().is_none());
    assert!(repo.oauth_tokens(ALICE).await.unwrap().is_none());
    assert!(
        repo.operation(ALICE, "pending-private-operation")
            .await
            .unwrap()
            .is_none()
    );
    for table in [
        "scrobbles",
        "follows",
        "operations",
        "outbox",
        "idempotency",
        "oauth_tokens",
        "oauth_states",
        "repo_backfills",
    ] {
        assert_eq!(harness.count(table).await, 0, "{table}");
    }
    assert_eq!(
        harness.count("sessions").await,
        1,
        "Bob's session survives Alice disconnect"
    );
    let response = harness
        .client
        .get(harness.server.url("/api/v1/auth/session"))
        .header("cookie", &alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let response = harness
        .client
        .get(harness.server.url("/api/v1/auth/session"))
        .header("cookie", bob.cookie.split(';').next().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["did"], BOB);
    assert_eq!(harness.remote_counts(), before);
    assert_eq!(harness.fixture.state.lock().unwrap().records, remote);
    assert!(!harness.server.shutdown().await.timed_out);
}
#[tokio::test]
async fn suppression() {
    let (harness, alice, _fixture) = populated().await;
    let before = harness.remote_counts();
    assert_eq!(harness.disconnect(&alice).await.status(), 204);
    let update=account::signed_repo_for(ALICE,vec![(PATH.into(),json!({"$type":"com.example.atmusic.scrobble","artist":"new remote artist","track":"remote update","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T11:00:00Z"}))],1,"3m4zm2ufr2223").await;
    harness.apply(&update, "post-disconnect-relay").await;
    let repo = harness.server.database.repositories();
    assert!(repo.is_suppressed(ALICE).await.unwrap());
    assert!(repo.user(ALICE).await.unwrap().is_none());
    assert_eq!(harness.count("scrobbles").await, 0);
    assert_eq!(
        repo.checkpoint("post-disconnect-relay")
            .await
            .unwrap()
            .unwrap()
            .sequence,
        update.event.sequence as i64
    );
    assert!(
        repo.request_backfill(ALICE.into(), false, account::now().to_rfc3339())
            .await
            .unwrap()
            .is_none()
    );
    assert!(harness.oauth.refresh(ALICE, account::NOW).await.is_err());
    let denied = harness
        .client
        .post(harness.server.url("/api/v1/scrobbles"))
        .header("cookie", alice.cookie)
        .header("origin", "https://music.example")
        .header("x-csrf-token", alice.csrf)
        .header("idempotency-key", "after-disconnect")
        .json(&json!({"artist":"blocked","track":"blocked","listenedAt":"2026-01-15T11:00:00Z"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    assert_eq!(harness.count("operations").await, 0);
    assert_eq!(harness.count("outbox").await, 0);
    assert_eq!(harness.remote_counts(), before);
    assert_eq!(
        harness
            .fixture
            .state
            .lock()
            .unwrap()
            .records
            .get(&format!("at://{ALICE}/{PATH}")),
        Some(&account::record())
    );
    assert!(!harness.server.shutdown().await.timed_out);
}
#[tokio::test]
async fn explicit_reconnect() {
    let (harness, alice, fixture) = populated().await;
    assert_eq!(harness.disconnect(&alice).await.status(), 204);
    assert!(
        harness
            .server
            .database
            .repositories()
            .is_suppressed(ALICE)
            .await
            .unwrap()
    );
    let fresh = harness.sign_in("alice.test").await;
    assert_ne!(fresh.cookie, alice.cookie);
    let repo = harness.server.database.repositories();
    assert!(!repo.is_suppressed(ALICE).await.unwrap());
    let user = repo.user(ALICE).await.unwrap().unwrap();
    assert!(!user.active);
    assert_eq!(user.indexing_state, "recovering");
    let job = repo.backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(job.state, "pending");
    assert!(!job.backfill_complete);
    assert!(job.reactivate);
    assert_eq!(harness.count("scrobbles").await, 0);
    assert_eq!(harness.count("oauth_tokens").await, 1);
    harness.recover(&fixture).await;
    let row = repo
        .scrobble(&format!("at://{ALICE}/{PATH}"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.artist, "Björk");
    assert_eq!(row.cid, fixture.record_cids[0].to_string());
    assert_eq!(row.revision, fixture.event.revision);
    assert!(repo.user(ALICE).await.unwrap().unwrap().active);
    let job = repo.backfill(ALICE).await.unwrap().unwrap();
    assert!(job.backfill_complete);
    assert_eq!(job.state, "complete");
    assert_eq!(repo.indexing(ALICE).await.unwrap().state, "current");
    let response = harness
        .client
        .get(harness.server.url("/api/v1/auth/session"))
        .header("cookie", alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(harness.fixture.state.lock().unwrap().token_calls, 2);
    assert_eq!(harness.fixture.state.lock().unwrap().records.len(), 1);
    assert!(!harness.server.shutdown().await.timed_out);
}

#[tokio::test]
async fn incoming_follow_ownership() {
    let (harness, alice, fixture) = populated().await;
    let repo = harness.server.database.repositories();
    repo.upsert_user(User::new(BOB, account::now().to_rfc3339()))
        .await
        .unwrap();
    let rkey = atmusic_core::follow::follow_rkey(ALICE).unwrap();
    let incoming=account::signed_repo_for(BOB,vec![(format!("com.example.atmusic.follow/{rkey}"),json!({"$type":"com.example.atmusic.follow","subject":ALICE,"createdAt":"2026-01-15T11:00:00Z"}))],2,"3m4zm2ufr2222").await;
    harness.apply(&incoming, "bob-incoming-follow").await;
    assert_eq!(
        repo.follow_page(ALICE, true, Default::default())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(harness.disconnect(&alice).await.status(), 204);
    assert_eq!(
        harness.count("follows").await,
        1,
        "Bob retains ownership of his indexed record"
    );
    assert!(
        repo.follow_page(ALICE, true, Default::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(repo.public_counts(BOB).await.unwrap().2, 0);
    assert!(
        repo.export_account(BOB, &account::now().to_rfc3339())
            .await
            .unwrap()
            .follows
            .is_empty()
    );
    harness.sign_in("alice.test").await;
    assert!(
        repo.follow_page(ALICE, true, Default::default())
            .await
            .unwrap()
            .is_empty(),
        "reconnect stays inactive until verified backfill"
    );
    harness.recover(&fixture).await;
    assert_eq!(
        repo.follow_page(ALICE, true, Default::default())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        repo.export_account(BOB, &account::now().to_rfc3339())
            .await
            .unwrap()
            .follows
            .len(),
        1
    );
    assert!(!harness.server.shutdown().await.timed_out);
}
