#[path = "common/account.rs"]
mod account;
mod common;
use account::{ALICE, AccountHarness, BOB};
use atmusic_storage::{NewOperation, OAuthState};
use serde_json::{Value, json};

#[tokio::test]
async fn export_owner() {
    let harness = AccountHarness::new().await;
    let alice = harness.sign_in("alice.test").await;
    harness.seed_read_fixture().await;
    harness
        .server
        .database
        .repositories()
        .set_indexing(
            ALICE.into(),
            atmusic_storage::Indexing {
                state: "current".into(),
                caught_up: true,
                last_indexed_at: Some(account::now().to_rfc3339()),
                lag_seconds: None,
            },
        )
        .await
        .unwrap();
    let response = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .header("cookie", alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=\"music-export.json\""
    );
    let value: Value = response.json().await.unwrap();
    assert_eq!(value.as_object().unwrap().len(), 6);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["did"], ALICE);
    assert_eq!(value["exportedAt"], "2026-01-15T12:00:00.000000000Z");
    assert_eq!(value["indexing"].as_object().unwrap().len(), 4);
    assert_eq!(value["indexing"]["state"], "recovering");
    assert_eq!(value["indexing"]["caughtUp"], false);
    let rows = value["scrobbles"].as_array().unwrap();
    assert_eq!(rows.len(), 7);
    let expected = ["r07", "r01", "r02", "r03", "r04", "r05", "r06"]
        .map(|rkey| format!("at://{ALICE}/com.example.atmusic.scrobble/{rkey}"));
    assert_eq!(
        rows.iter()
            .map(|row| row["uri"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected.iter().map(String::as_str).collect::<Vec<_>>()
    );
    for row in rows {
        assert_eq!(row["did"], ALICE);
        assert!(
            row["cid"]
                .as_str()
                .unwrap()
                .parse::<ipld_core::cid::Cid>()
                .is_ok()
        );
        for key in ["artistKey", "trackKey", "albumKey", "confirmed"] {
            assert!(row.get(key).is_none());
        }
    }
    let follows = value["follows"].as_array().unwrap();
    assert_eq!(follows.len(), 1);
    assert_eq!(follows[0]["actor"], ALICE);
    assert_eq!(follows[0]["subject"], BOB);
    assert_eq!(harness.count("scrobbles").await, 9);
    assert!(!harness.server.shutdown().await.timed_out);
}

#[tokio::test]
async fn export_auth() {
    let harness = AccountHarness::new().await;
    let bob = harness.sign_in("bob.test").await;
    harness.seed_read_fixture().await;
    let response = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "unauthenticated");
    let response = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .query(&[("did", ALICE)])
        .header("cookie", &bob.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["did"], BOB);
    assert_eq!(value["scrobbles"].as_array().unwrap().len(), 1);
    assert!(
        value["scrobbles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["did"] == BOB)
    );
    let response = harness
        .client
        .get(
            harness
                .server
                .url(&format!("/api/v1/account/{ALICE}/export")),
        )
        .header("cookie", bob.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(harness.count("scrobbles").await, 9);
    assert!(!harness.server.shutdown().await.timed_out);
}

#[tokio::test]
async fn export_secret_scan() {
    let harness = AccountHarness::new().await;
    let alice = harness.sign_in("alice.test").await;
    harness.seed_read_fixture().await;
    let markers = [
        "marked-access-secret",
        "marked-refresh-secret",
        "marked-dpop-private-key",
        "marked-state-secret",
        "marked-bob-operation",
    ];
    harness.oauth.token_store().put_oauth_tokens(ALICE,&json!({"did":ALICE,"issuer":"https://authorization.fixture.test","expires_at":account::NOW+3600,"access_token":markers[0],"refresh_token":markers[1],"dpop_private_pem":markers[2]}),account::NOW).await.unwrap();
    harness
        .server
        .database
        .repositories()
        .put_oauth_state(OAuthState {
            state_hash: "marked-state-hash".into(),
            encrypted_material: markers[3].as_bytes().into(),
            issuer: "https://authorization.fixture.test".into(),
            did: ALICE.into(),
            created_at: account::NOW,
            expires_at: account::NOW + 300,
        })
        .await
        .unwrap();
    harness
        .server
        .database
        .repositories()
        .admit_operation(
            NewOperation {
                operation_id: markers[4].into(),
                owner: BOB.into(),
                kind: "scrobble_create".into(),
                created_at: account::now().to_rfc3339(),
                record_uri: Some(format!("at://{BOB}/com.example.atmusic.scrobble/private")),
                collection: "com.example.atmusic.scrobble".into(),
                rkey: "private".into(),
                payload_json: Some(json!({"marker":markers[4]}).to_string()),
                canonical_digest: Some(markers[4].into()),
            },
            Some("marked-bob-idempotency".into()),
        )
        .await
        .unwrap();
    let response = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .header("cookie", &alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let bytes = response.bytes().await.unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["did"], ALICE);
    assert_eq!(value["scrobbles"].as_array().unwrap().len(), 7);
    for marker in markers {
        assert!(!text.contains(marker));
    }
    assert!(!text.contains(&alice.cookie));
    assert!(!text.contains(&alice.csrf));
    for key in [
        "tokens",
        "operations",
        "outbox",
        "sessions",
        "csrfToken",
        "encryptedMaterial",
    ] {
        assert!(value.get(key).is_none());
    }
    assert_eq!(harness.count("oauth_tokens").await, 1);
    assert_eq!(harness.count("operations").await, 1);
    assert!(!harness.server.shutdown().await.timed_out);
}

#[tokio::test]
async fn export_snapshot_interleaving() {
    use std::sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;
    struct ReadBarrier {
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        released: Mutex<bool>,
        wake: Condvar,
        timed_out: AtomicBool,
    }
    impl ReadBarrier {
        fn compare(&self, left: &str, right: &str) -> std::cmp::Ordering {
            if left.starts_with("at://") && right.starts_with("at://") {
                let entered = self.entered.lock().unwrap().take();
                if let Some(entered) = entered {
                    let _ = entered.send(());
                    let (released, _) = self
                        .wake
                        .wait_timeout_while(
                            self.released.lock().unwrap(),
                            Duration::from_secs(10),
                            |released| !*released,
                        )
                        .unwrap();
                    if !*released {
                        self.timed_out.store(true, Ordering::SeqCst);
                    }
                }
            }
            // Identical to SQLite BINARY ordering for valid UTF-8 strings.
            left.cmp(right)
        }
        fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.wake.notify_all();
        }
    }
    const RELAY: &str = "wss://relay.fixture.test/";
    let harness = AccountHarness::new_with_relay(Some(RELAY)).await;
    let alice = harness.sign_in("alice.test").await;
    let fixture=account::signed_repo_for(ALICE,vec![
        (account::PATH.into(),account::record()),
        ("com.example.atmusic.follow/f01".into(),json!({"$type":"com.example.atmusic.follow","subject":BOB,"createdAt":"2026-01-15T11:00:00Z"})),
        ("com.example.atmusic.follow/f02".into(),json!({"$type":"com.example.atmusic.follow","subject":BOB,"createdAt":"2026-01-15T11:00:00Z"})),
    ],1,"3m4zm2ufr2222").await;
    harness.recover(&fixture).await;
    let repository = harness.server.database.repositories();
    repository
        .set_relay_recovery(atmusic_storage::RelayRecovery {
            relay: RELAY.into(),
            pending_gap: false,
            connected: true,
            last_event_at: Some((account::now() - chrono::Duration::seconds(7)).to_rfc3339()),
            prior_sequence: None,
            reason: None,
            updated_at: account::now().to_rfc3339(),
        })
        .await
        .unwrap();
    let baseline = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .header("cookie", &alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(baseline.status(), 200);
    let baseline: Value = baseline.json().await.unwrap();
    assert_eq!(baseline["indexing"]["state"], "current");
    assert_eq!(baseline["indexing"]["caughtUp"], true);
    assert_eq!(baseline["indexing"]["lagSeconds"], 7);

    let (entered, ready) = tokio::sync::oneshot::channel();
    let barrier = Arc::new(ReadBarrier {
        entered: Mutex::new(Some(entered)),
        released: Mutex::new(false),
        wake: Condvar::new(),
        timed_out: AtomicBool::new(false),
    });
    let mut readers = Vec::new();
    for _ in 0..4 {
        let mut reader = harness
            .server
            .database
            .reader_pool()
            .acquire()
            .await
            .unwrap();
        let comparison = barrier.clone();
        reader
            .lock_handle()
            .await
            .unwrap()
            .create_collation("BINARY", move |left, right| comparison.compare(left, right))
            .unwrap();
        readers.push(reader);
    }
    drop(readers);
    let client = harness.client.clone();
    let url = harness.server.url("/api/v1/account/export");
    let cookie = alice.cookie.clone();
    let export = tokio::spawn(async move {
        client
            .get(url)
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    // The reader is executing follow representative selection after pinning its
    // owner/records/freshness snapshot. WAL permits this separate writer commit.
    let disconnected = repository
        .disconnect(ALICE.into(), account::now().to_rfc3339())
        .await;
    barrier.release();
    disconnected.unwrap();
    let response = export.await.unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert!(!barrier.timed_out.load(Ordering::SeqCst));
    assert_eq!(value["scrobbles"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["scrobbles"][0]["cid"],
        fixture.record_cids[0].to_string()
    );
    assert_eq!(value["follows"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["indexing"], baseline["indexing"],
        "concurrent disconnect must not mix new freshness with old records"
    );
    assert!(repository.is_suppressed(ALICE).await.unwrap());
    assert!(repository.user(ALICE).await.unwrap().is_none());
    assert_eq!(harness.count("scrobbles").await, 0);
    assert_eq!(harness.count("follows").await, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM indexing_status WHERE scope=?")
            .bind(ALICE)
            .fetch_one(harness.server.database.reader_pool())
            .await
            .unwrap(),
        0
    );
    let response = harness
        .client
        .get(harness.server.url("/api/v1/account/export"))
        .header("cookie", alice.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert!(!harness.server.shutdown().await.timed_out);
}
