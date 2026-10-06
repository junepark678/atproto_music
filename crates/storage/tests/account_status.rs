mod common;

use atmusic_storage::{Database, StorageError, User};
use common::{ALICE, BOB, NOW, Temp};
use std::{future::Future, task::Poll};

async fn owner_state_count(db: &Database) -> i64 {
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM users WHERE did=?) + (SELECT count(*) FROM repo_backfills WHERE did=?) + (SELECT count(*) FROM indexing_status WHERE scope=?)",
    )
    .bind(ALICE)
    .bind(ALICE)
    .bind(ALICE)
    .fetch_one(db.reader_pool())
    .await
    .unwrap()
}

#[tokio::test]
async fn disconnect_then_inactive_does_not_recreate_state() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    let job = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner_state_count(&db).await, 3);

    // Hold the real writer, then enqueue disconnect before both late status results.
    let (release, held) = tokio::sync::oneshot::channel();
    let blocker = db
        .writer()
        .enqueue(move |_| {
            Box::pin(async move {
                held.await.unwrap();
                Ok(())
            })
        })
        .unwrap();
    let disconnect = repo.disconnect(ALICE.into(), NOW.into());
    let inactive = repo.account_inactive(ALICE.into(), NOW.into());
    let generation_inactive =
        repo.account_inactive_generation(ALICE.into(), job.generation, NOW.into());
    tokio::pin!(disconnect, inactive, generation_inactive);
    std::future::poll_fn(|cx| {
        assert!(disconnect.as_mut().poll(cx).is_pending());
        assert!(inactive.as_mut().poll(cx).is_pending());
        assert!(generation_inactive.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    release.send(()).unwrap();
    blocker.wait().await.unwrap();
    disconnect.await.unwrap();
    inactive.await.unwrap();
    assert!(!generation_inactive.await.unwrap());

    assert_eq!(owner_state_count(&db).await, 0);
    assert!(repo.is_suppressed(ALICE).await.unwrap());
    assert!(
        repo.request_backfill_generation(ALICE.into(), job.generation, true, NOW.into())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(owner_state_count(&db).await, 0);
    db.close().await;
}

#[tokio::test]
async fn stale_account_status_preserves_new_generation() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    let old = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    let fresh = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    assert!(fresh.generation > old.generation);
    assert!(repo.user(ALICE).await.unwrap().unwrap().active);

    assert!(
        !repo
            .account_inactive_generation(ALICE.into(), old.generation, NOW.into())
            .await
            .unwrap()
    );
    assert!(
        repo.request_backfill_generation(ALICE.into(), old.generation, true, NOW.into())
            .await
            .unwrap()
            .is_none()
    );
    assert!(repo.user(ALICE).await.unwrap().unwrap().active);
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        fresh.generation
    );
    // A current response still deactivates the owner and invalidates that generation.
    assert!(
        repo.account_inactive_generation(ALICE.into(), fresh.generation, NOW.into())
            .await
            .unwrap()
    );
    assert!(!repo.user(ALICE).await.unwrap().unwrap().active);
    assert!(repo.backfill(ALICE).await.unwrap().unwrap().generation > fresh.generation);
    db.close().await;
}

#[tokio::test]
async fn recreated_account_never_reuses_backfill_generation() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    let old = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    repo.disconnect(ALICE.into(), NOW.into()).await.unwrap();
    assert_eq!(owner_state_count(&db).await, 0);
    db.close().await;

    // The only retained allocation state is a global counter, including across restart.
    let db = temp.database().await;
    let repo = db.repositories();
    repo.reconnect(User::new(ALICE, NOW)).await.unwrap();
    let fresh = repo.backfill(ALICE).await.unwrap().unwrap();
    assert!(fresh.generation > old.generation);
    let before = repo.user(ALICE).await.unwrap().unwrap();
    assert!(
        !repo
            .account_inactive_generation(ALICE.into(), old.generation, NOW.into())
            .await
            .unwrap()
    );
    assert!(
        repo.request_backfill_generation(ALICE.into(), old.generation, true, NOW.into())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        fresh.generation
    );
    assert_eq!(
        repo.user(ALICE).await.unwrap().unwrap().active,
        before.active
    );
    assert!(!repo.is_suppressed(ALICE).await.unwrap());
    db.close().await;
}

#[tokio::test]
async fn backfill_generation_exhaustion_rolls_back_all_state() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    for did in [ALICE, BOB] {
        repo.upsert_user(User::new(did, NOW)).await.unwrap();
        repo.request_backfill(did.into(), false, NOW.into())
            .await
            .unwrap();
    }
    let alice_generation = repo.backfill(ALICE).await.unwrap().unwrap().generation;
    let bob_generation = repo.backfill(BOB).await.unwrap().unwrap().generation;
    db.writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("UPDATE backfill_generation SET last_generation=?")
                    .bind(i64::MAX - 1)
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    // Reserving two generations near the bound fails without promoting an integer to REAL.
    assert!(matches!(
        repo.reject_relay_cursor("relay".into(), "OutdatedCursor".into(), NOW.into())
            .await,
        Err(StorageError::Invariant("backfill generation exhausted"))
    ));
    assert!(repo.relay_recovery("relay").await.unwrap().is_none());
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        alice_generation
    );
    assert_eq!(
        repo.backfill(BOB).await.unwrap().unwrap().generation,
        bob_generation
    );
    let last = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(last.generation, i64::MAX);
    assert!(matches!(
        repo.request_backfill(ALICE.into(), true, NOW.into()).await,
        Err(StorageError::Invariant("backfill generation exhausted"))
    ));
    // account_inactive writes users first, so this also proves rollback of that mutation.
    assert!(matches!(
        repo.account_inactive(ALICE.into(), NOW.into()).await,
        Err(StorageError::Invariant("backfill generation exhausted"))
    ));
    assert!(repo.user(ALICE).await.unwrap().unwrap().active);
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        i64::MAX
    );
    let (counter, kind): (i64, String) =
        sqlx::query_as("SELECT last_generation,typeof(last_generation) FROM backfill_generation")
            .fetch_one(db.reader_pool())
            .await
            .unwrap();
    assert_eq!(counter, i64::MAX);
    assert_eq!(kind, "integer");
    db.close().await;
}

#[tokio::test]
async fn cursor_rejection_allocates_distinct_global_generations() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    for did in [ALICE, BOB] {
        repo.upsert_user(User::new(did, NOW)).await.unwrap();
        repo.request_backfill(did.into(), false, NOW.into())
            .await
            .unwrap();
    }
    let before = repo.backfill(BOB).await.unwrap().unwrap().generation;
    repo.reject_relay_cursor("relay".into(), "OutdatedCursor".into(), NOW.into())
        .await
        .unwrap();
    let alice = repo.backfill(ALICE).await.unwrap().unwrap();
    let bob = repo.backfill(BOB).await.unwrap().unwrap();
    assert!(alice.generation > before);
    assert!(bob.generation > before);
    assert_ne!(alice.generation, bob.generation);
    let next = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    assert!(next.generation > alice.generation.max(bob.generation));
    assert!(
        repo.relay_recovery("relay")
            .await
            .unwrap()
            .unwrap()
            .pending_gap
    );
    db.close().await;
}
