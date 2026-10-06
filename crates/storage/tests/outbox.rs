mod common;
use common::*;
#[tokio::test]
async fn admission_atomic() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let mut input = operation("bad", ALICE);
    input.canonical_digest = None; // Outbox CHECK fails after operation insert.
    assert!(
        db.repositories()
            .admit_operation(input, None)
            .await
            .is_err()
    );
    for table in ["operations", "outbox", "idempotency"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(db.reader_pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    db.repositories()
        .admit_operation(operation("good", ALICE), None)
        .await
        .unwrap();
    assert_eq!(
        db.repositories().outbox_due(NOW, 10).await.unwrap().len(),
        1
    );
    db.close().await;
}
#[tokio::test]
async fn rkey_persistence() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let mut input = operation("one", ALICE);
    input.rkey = "3lh5234mwy222".into();
    input.record_uri = Some(format!(
        "at://{ALICE}/com.example.atmusic.scrobble/{}",
        input.rkey
    ));
    db.repositories()
        .admit_operation(input.clone(), Some("once".into()))
        .await
        .unwrap();
    let before = db
        .repositories()
        .outbox_due(NOW, 10)
        .await
        .unwrap()
        .pop()
        .unwrap();
    db.close().await;
    let reopened = temp.database().await;
    let after = reopened
        .repositories()
        .outbox_due(NOW, 10)
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(after.rkey, before.rkey);
    assert_eq!(after.record_uri, before.record_uri);
    assert_eq!(after.canonical_digest, before.canonical_digest);
    assert_eq!(after.attempts, 0);
    let mut replay = input;
    replay.rkey = "3lh5234mwy223".into();
    reopened
        .repositories()
        .admit_operation(replay, Some("once".into()))
        .await
        .unwrap();
    let rows = reopened.repositories().outbox_due(NOW, 10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].rkey, "3lh5234mwy222");
    reopened.close().await;
}
#[tokio::test]
async fn replay_factory_allocates_once() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let allocations = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let repo = db.repositories();
        let allocations = allocations.clone();
        tasks.push(tokio::spawn(async move {
            repo.admit_scrobble_factory(
                ALICE.into(),
                "one-key".into(),
                "canonical-input".into(),
                move || {
                    allocations.fetch_add(1, Ordering::SeqCst);
                    Ok(operation("one", ALICE))
                },
            )
            .await
            .unwrap()
        }));
    }
    for task in tasks {
        let _ = task.await.unwrap();
    }
    assert_eq!(allocations.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.repositories().outbox_due(NOW, 100).await.unwrap().len(),
        1
    );
    assert_eq!(db.repositories().public_counts(ALICE).await.unwrap().0, 0);
    db.close().await;
}
#[tokio::test]
async fn confirmation_owner_uri_and_delete_race() {
    use atmusic_storage::RecordMutation;
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    repo.admit_operation(operation("one", ALICE), None)
        .await
        .unwrap();
    let mut wrong = row("one", "rev1");
    wrong.did = BOB.into();
    wrong.uri = format!("at://{BOB}/com.example.atmusic.scrobble/one");
    assert!(
        repo.finish_operation(
            "one".into(),
            NOW.into(),
            None,
            Some(RecordMutation::Scrobble(wrong))
        )
        .await
        .is_err()
    );
    assert_eq!(repo.public_counts(BOB).await.unwrap().0, 0);
    assert_eq!(repo.outbox_due(NOW, 10).await.unwrap().len(), 1);
    let mut deletion = operation("delete", ALICE);
    deletion.kind = "scrobble_delete".into();
    deletion.rkey = "one".into();
    deletion.record_uri = Some(row("one", "rev1").uri);
    deletion.payload_json = None;
    deletion.canonical_digest = None;
    repo.request_deletion(deletion).await.unwrap();
    repo.finish_operation(
        "one".into(),
        NOW.into(),
        None,
        Some(RecordMutation::Scrobble(row("one", "rev1"))),
    )
    .await
    .unwrap();
    assert_eq!(
        repo.operation(ALICE, "one").await.unwrap().unwrap().state,
        "succeeded"
    );
    assert_eq!(
        repo.public_counts(ALICE).await.unwrap().0,
        0,
        "pending deletion stays hidden after create confirmation"
    );
    repo.finish_operation(
        "delete".into(),
        NOW.into(),
        None,
        Some(RecordMutation::Delete {
            uri: row("one", "rev1").uri,
            owner: ALICE.into(),
            revision: "rev2".into(),
            indexed_at: NOW.into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(repo.public_counts(ALICE).await.unwrap().0, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}
