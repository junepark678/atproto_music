#[path = "support/federation.rs"]
mod federation;
use atmusic_atproto::sync::backfill::{BackfillCoordinator, SnapshotSource};
use atmusic_server::http::index_status;
use atmusic_storage::{Database, NewOperation};
use federation::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn independent_write() {
    let h = Harness::new().await;
    h.alice
        .create(SCROBBLE, "r01", record("Björk", "Jóga"))
        .await;
    h.index().await;
    let published = h
        .carol
        .create(SCROBBLE, "r10", record("Portishead", "Roads"))
        .await;
    h.index().await;
    let feed = h.app.get("api/v1/feed?scope=global&limit=100").await;
    assert!(
        feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["uri"] == published["uri"] && row["cid"] == published["cid"])
    );
    assert_eq!(h.carol.counts.create.load(Ordering::SeqCst), 1);
    assert_eq!(h.alice.counts.create.load(Ordering::SeqCst), 1);
    assert_eq!(h.app.counts.app_posts.load(Ordering::SeqCst), 0);
    h.assert_converged().await;
    h.close().await;
}

#[tokio::test]
async fn independent_mutation() {
    let h = Harness::new().await;
    h.carol
        .create(SCROBBLE, "r10", record("Portishead", "Roads"))
        .await;
    h.index().await;
    let updated = h
        .carol
        .update(SCROBBLE, "r10", record("  Portishead  ", "Roads live"))
        .await;
    h.index().await;
    let history = h
        .app
        .get(&format!("api/v1/users/{CAROL}/scrobbles?limit=100"))
        .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["cid"], updated["cid"]);
    assert_eq!(history["items"][0]["artist"], "  Portishead  ");
    assert_eq!(history["items"][0]["track"], "Roads live");
    assert_eq!(h.db.repositories().public_counts(CAROL).await.unwrap().0, 1);
    h.carol.delete(SCROBBLE, "r10").await;
    h.index().await;
    let history = h
        .app
        .get(&format!("api/v1/users/{CAROL}/scrobbles?limit=100"))
        .await;
    assert!(history["items"].as_array().unwrap().is_empty());
    assert_eq!(h.db.repositories().public_counts(CAROL).await.unwrap().0, 0);
    assert_eq!(h.app.counts.app_posts.load(Ordering::SeqCst), 0);
    assert_eq!(h.carol.counts.update.load(Ordering::SeqCst), 1);
    assert_eq!(h.carol.counts.delete.load(Ordering::SeqCst), 1);
    h.assert_converged().await;
    h.close().await;
}

#[tokio::test]
async fn coverage_failure() {
    let h = Harness::new().await;
    h.relay.covered.lock().unwrap().remove(CAROL);
    h.alice
        .create(SCROBBLE, "r01", record("Björk", "Jóga"))
        .await;
    let published = h
        .carol
        .create(SCROBBLE, "r10", record("Portishead", "Roads"))
        .await;
    h.index().await;
    let feed = h.app.get("api/v1/feed?scope=global&limit=100").await;
    assert!(
        !feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["uri"] == published["uri"])
    );
    assert_eq!(feed["indexing"]["caughtUp"], false);
    assert_eq!(feed["indexing"]["state"], "recovering");
    let snapshot = h.source.fetch(CAROL).await.unwrap();
    let verified = atmusic_atproto::sync::verify::verify_snapshot(
        &snapshot.bytes,
        CAROL,
        &namespace(),
        now(),
        h.keys.as_ref(),
    )
    .await
    .unwrap();
    assert_eq!(verified.mutations().len(), 1);
    let evidence = json!({"result":"blocked","code":"indexing_unavailable","reason":"configured relay excludes second PDS","fixtureOnly":true});
    assert_eq!(evidence["code"], "indexing_unavailable");
    assert_ne!(evidence["result"], "passed");
    assert_eq!(h.app.counts.app_posts.load(Ordering::SeqCst), 0);
    let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/live/federation_check.py");
    let output = std::process::Command::new("python3")
        .arg(script)
        .arg("--live")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let message = String::from_utf8(output.stdout).unwrap();
    assert!(message.contains("BLOCKED"));
    assert!(message.contains("historical_event_trust_or_safe_current_head_recovery"));
    assert!(message.contains("production_relay_progress_and_subscription_coverage"));
    assert!(!message.contains("authenticated_revision_key_resolver"));
    assert!(message.contains("live_federation_acceptance_runner"));
    assert!(!message.contains("production_websocket_transport"));
    assert!(!message.contains("PASS"));
    h.close().await;
}

#[tokio::test]
async fn convergence() {
    let h = Harness::new().await;
    h.alice
        .create(SCROBBLE, "r01", record("Björk", "Jóga"))
        .await;
    h.alice.create(FOLLOW, "f01", follow(CAROL)).await;
    h.carol
        .create(SCROBBLE, "r10", record("Portishead", "Roads"))
        .await;
    let duplicate = h.carol.repository().await.event;
    h.relay.push(&duplicate);
    let result = h.worker.run_session().await.unwrap();
    assert_eq!(result.applied, 3);
    assert_eq!(result.replayed, 1);
    h.assert_converged().await;
    let stale = h.carol.repository().await.event.blocks;
    h.backfills.schedule(CAROL, false).await.unwrap();
    h.source
        .overrides
        .lock()
        .unwrap()
        .insert(CAROL.into(), stale);
    h.carol
        .update(SCROBBLE, "r10", record("Portishead", "Roads new"))
        .await;
    h.alice.delete(FOLLOW, "f01").await;
    h.index().await;
    let results = h.backfills.run_batch().await.unwrap();
    assert_eq!(
        results
            .iter()
            .find(|result| result.did == CAROL)
            .unwrap()
            .result
            .as_ref()
            .unwrap(),
        &atmusic_storage::SnapshotOutcome::Stale
    );
    h.source.overrides.lock().unwrap().clear();
    h.backfills.run_batch().await.unwrap();
    h.assert_converged().await;
    let rotated = h.carol.rotate(10, &h.keys).await;
    h.relay.identity(CAROL);
    h.index().await;
    h.backfills.run_batch().await.unwrap();
    assert_ne!(rotated.key.did_key, h.alice.repository().await.key.did_key);
    h.assert_converged().await;
    h.relay.error("OutdatedCursor");
    let result = h.worker.run_session().await.unwrap();
    assert!(result.recovery_requested);
    assert!(
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .pending_gap
    );
    let results = h.backfills.run_batch().await.unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|r| r.result.is_ok()));
    h.worker.run_session().await.unwrap();
    assert!(
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .prior_sequence
            .is_some()
    );
    h.assert_converged().await;
    assert_eq!(h.app.counts.app_posts.load(Ordering::SeqCst), 0);
    h.close().await;
}

#[tokio::test]
async fn signature_failure() {
    let h = Harness::new().await;
    h.alice
        .create(SCROBBLE, "r01", record("Björk", "Jóga"))
        .await;
    h.index().await;
    let current = h.alice.repository().await;
    let mut invalid = federation::signed_repo::signed_mutation(
        &current,
        "com.example.atmusic.scrobble/poison",
        Some(record("Invalid", "Must never appear")),
        11,
        "3m4zm2ufr2224",
    )
    .await;
    h.relay.publish(&mut invalid.event);
    h.alice
        .update(SCROBBLE, "r01", record("Björk", "Jóga recovered"))
        .await;
    assert!(h.worker.run_session().await.is_err());
    assert!(
        h.db.repositories()
            .scrobble(&format!("at://{ALICE}/{SCROBBLE}/poison"))
            .await
            .unwrap()
            .is_none()
    );
    let recovery =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(recovery.pending_gap);
    assert_eq!(
        recovery.reason.as_deref(),
        Some("repository_verification_failed")
    );
    let status = index_status::read(&h.db.repositories(), Some(RELAY), "global", now())
        .await
        .unwrap();
    assert!(!status.indexing.caught_up);
    assert_eq!(status.indexing.state, "recovering");
    h.recover().await;
    h.assert_converged().await;
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 1);
    h.close().await;
}

#[tokio::test]
async fn worker_restart() {
    let h = Harness::new().await;
    h.alice
        .create(SCROBBLE, "r01", record("Björk", "Jóga"))
        .await;
    h.carol
        .create(SCROBBLE, "r10", record("Portishead", "Roads"))
        .await;
    h.index().await;
    let cursor =
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence;
    h.db.repositories()
        .admit_operation(
            NewOperation {
                operation_id: "durable-operation".into(),
                owner: ALICE.into(),
                kind: "scrobble_create".into(),
                created_at: now().to_rfc3339(),
                record_uri: Some(format!("at://{ALICE}/{SCROBBLE}/pending")),
                collection: SCROBBLE.into(),
                rkey: "pending".into(),
                payload_json: Some(record("Queued", "Retain me").to_string()),
                canonical_digest: Some("fixture-input-digest".into()),
            },
            None,
        )
        .await
        .unwrap();
    let Harness {
        directory,
        db,
        relay,
        keys,
        alice,
        carol,
        source,
        backfills,
        worker,
        app,
    } = h;
    drop(app);
    drop(worker);
    drop(backfills);
    db.close().await;
    drop(db);
    let db = Database::open(directory.path().join("federation.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        cursor
    );
    assert_eq!(
        db.repositories()
            .operation(ALICE, "durable-operation")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert_eq!(
        db.repositories()
            .outbox_due(&now().to_rfc3339(), 32)
            .await
            .unwrap()
            .len(),
        1
    );
    carol
        .update(SCROBBLE, "r10", record("Portishead", "Roads after restart"))
        .await;
    let backfills = Arc::new(BackfillCoordinator::new(
        db.repositories(),
        namespace(),
        source.clone(),
        keys.clone(),
        Arc::new(Clock),
    ));
    let worker = make_worker(&db, relay.clone(), keys.clone(), source, backfills);
    let app = App::start(&db).await;
    worker.run_session().await.unwrap();
    assert_eq!(
        relay.requests.lock().unwrap().last().unwrap().query(),
        Some(format!("cursor={cursor}").as_str())
    );
    assert_exact(&db, &[&alice, &carol], keys.as_ref()).await;
    assert_eq!(
        db.repositories()
            .operation(ALICE, "durable-operation")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert_eq!(
        app.get("api/v1/feed?scope=global&limit=100").await["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(app.counts.app_posts.load(Ordering::SeqCst), 0);
    drop(app);
    drop(worker);
    db.close().await;
}
