mod common;
use atmusic_storage::*;
use common::*;
#[tokio::test]
async fn event_atomicity() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    // A real checkpoint CHECK failure follows the row write inside the transaction.
    let event = RepositoryEvent {
        checkpoint: Checkpoint {
            relay: "fixture-relay".into(),
            sequence: -1,
            revision: Some("rev1".into()),
            indexed_at: NOW.into(),
        },
        mutations: vec![RecordMutation::Scrobble(row("r01", "rev1"))],
    };
    assert!(repo.apply_event(event).await.is_err());
    assert!(
        repo.scrobble(&row("r01", "rev1").uri)
            .await
            .unwrap()
            .is_none()
    );
    assert!(repo.checkpoint("fixture-relay").await.unwrap().is_none());
    let event = RepositoryEvent {
        checkpoint: Checkpoint {
            relay: "fixture-relay".into(),
            sequence: 1,
            revision: Some("rev1".into()),
            indexed_at: NOW.into(),
        },
        mutations: vec![RecordMutation::Scrobble(row("r01", "rev1"))],
    };
    assert!(repo.apply_event(event).await.unwrap());
    assert_eq!(
        repo.checkpoint("fixture-relay")
            .await
            .unwrap()
            .unwrap()
            .sequence,
        1
    );
    assert!(
        repo.scrobble(&row("r01", "rev1").uri)
            .await
            .unwrap()
            .is_some()
    );
    db.close().await;
}
#[tokio::test]
async fn owner_private_read() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    repo.admit_operation(operation("alice-op", ALICE), None)
        .await
        .unwrap();
    assert!(repo.operation(BOB, "alice-op").await.unwrap().is_none());
    let operation = repo.operation(ALICE, "alice-op").await.unwrap().unwrap();
    assert_eq!(operation.owner, ALICE);
    assert_eq!(operation.state, "pending");
    db.close().await;
}
#[tokio::test]
async fn record_revision() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    let initial = row("r01", "rev1");
    repo.apply_scrobble(initial.clone()).await.unwrap();
    repo.apply_scrobble(initial.clone()).await.unwrap();
    let mut newer = initial.clone();
    newer.revision = "rev2".into();
    newer.artist = "Radiohead".into();
    newer.artist_key = "radiohead".into();
    repo.apply_scrobble(newer).await.unwrap();
    repo.apply_scrobble(initial.clone()).await.unwrap();
    let actual = repo.scrobble(&initial.uri).await.unwrap().unwrap();
    assert_eq!(actual.revision, "rev2");
    assert_eq!(actual.artist, "Radiohead");
    assert_eq!(repo.public_counts(ALICE).await.unwrap().0, 1);
    db.close().await;
}
#[tokio::test]
async fn idempotent_admission_is_atomic_and_never_confirms() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    assert!(matches!(
        repo.admit_operation(operation("one", ALICE), Some("key".into()))
            .await
            .unwrap(),
        Admission::Created(_)
    ));
    assert!(
        matches!(repo.admit_operation(operation("two",ALICE),Some("key".into())).await.unwrap(),Admission::Replayed(o) if o.operation_id=="one")
    );
    let mut changed = operation("three", ALICE);
    changed.canonical_digest = Some("different".into());
    assert!(matches!(
        repo.admit_operation(changed, Some("key".into())).await,
        Err(StorageError::IdempotencyConflict)
    ));
    assert_eq!(repo.outbox_due(NOW, 100).await.unwrap().len(), 1);
    assert_eq!(repo.public_counts(ALICE).await.unwrap().0, 0);
    assert!(
        repo.finish_operation("one".into(), NOW.into(), None, None)
            .await
            .is_err()
    );
    assert_eq!(
        repo.operation(ALICE, "one").await.unwrap().unwrap().state,
        "pending"
    );
    db.close().await;
}
#[tokio::test]
async fn private_material_expiry_and_disconnect() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    repo.put_oauth_state(OAuthState {
        state_hash: "statehash".into(),
        encrypted_material: vec![1, 2],
        issuer: "https://issuer.test".into(),
        did: ALICE.into(),
        created_at: 1000,
        expires_at: 1300,
    })
    .await
    .unwrap();
    assert!(
        repo.consume_oauth_state("statehash".into(), "https://wrong.test".into(), 1001)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        repo.consume_oauth_state("statehash".into(), "https://issuer.test".into(), 1299)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        repo.consume_oauth_state("statehash".into(), "https://issuer.test".into(), 1299)
            .await
            .unwrap()
            .is_none()
    );
    repo.put_session(&Session {
        session_hash: "hash".into(),
        owner: ALICE.into(),
        csrf_hash: "csrfhash".into(),
        encrypted_material: vec![1, 2],
        created_at: 1000,
        expires_at: 1000 + 604800,
    })
    .await
    .unwrap();
    assert!(repo.session("hash", 1000 + 604799).await.unwrap().is_some());
    assert!(repo.session("hash", 1000 + 604800).await.unwrap().is_none());
    repo.apply_scrobble(row("r01", "rev1")).await.unwrap();
    repo.admit_operation(operation("one", ALICE), Some("key".into()))
        .await
        .unwrap();
    repo.disconnect(ALICE.into(), NOW.into()).await.unwrap();
    assert!(repo.user(ALICE).await.unwrap().is_none());
    assert!(repo.session("hash", 1001).await.unwrap().is_none());
    assert!(repo.operation(ALICE, "one").await.unwrap().is_none());
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    repo.apply_scrobble(row("r01", "rev2")).await.unwrap();
    assert!(
        repo.scrobble(&row("r01", "rev2").uri)
            .await
            .unwrap()
            .is_none()
    );
    db.close().await;
}
