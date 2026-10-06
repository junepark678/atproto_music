mod common;

use atmusic_storage::{DiscoveryAdmission, OAuthTokens, PageBounds, StorageError, User};
use common::{ALICE, BOB, NOW, Temp};
use std::{future::Future, task::Poll};

async fn counter(db: &atmusic_storage::Database) -> i64 {
    sqlx::query_scalar("SELECT last_generation FROM backfill_generation")
        .fetch_one(db.reader_pool())
        .await
        .unwrap()
}
async fn local_owner_rows(db: &atmusic_storage::Database, did: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM users WHERE did=?) + (SELECT count(*) FROM repo_backfills WHERE did=?) + (SELECT count(*) FROM indexing_status WHERE scope=?)",
    )
    .bind(did)
    .bind(did)
    .bind(did)
    .fetch_one(db.reader_pool())
    .await
    .unwrap()
}

#[tokio::test]
async fn unknown_discovery_is_inactive_and_durable() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    let DiscoveryAdmission::Queued(job) = repo
        .discover_repository(ALICE.into(), NOW.into())
        .await
        .unwrap()
    else {
        panic!("unknown owner must receive bounded recovery admission")
    };
    assert!(job.reactivate);
    assert_eq!(job.state, "pending");
    assert!(!job.backfill_complete);
    assert!(job.revision.is_none());
    let user = repo.user(ALICE).await.unwrap().unwrap();
    assert!(!user.active);
    assert!(user.handle.is_none());
    assert!(user.revision.is_none());
    assert!(user.indexed_at.is_none());
    assert_eq!(user.indexing_state, "recovering");
    assert!(repo.active_user(ALICE).await.unwrap().is_none());
    assert!(
        repo.history(ALICE, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        repo.feed(None, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(repo.public_counts(ALICE).await.unwrap(), (0, 0, 0));
    assert!(!repo.indexing(ALICE).await.unwrap().caught_up);
    assert!(repo.checkpoint("relay").await.unwrap().is_none());
    assert_eq!(local_owner_rows(&db, ALICE).await, 3);
    db.close().await;

    let db = temp.database().await;
    let repo = db.repositories();
    assert!(!repo.user(ALICE).await.unwrap().unwrap().active);
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        job.generation
    );
    assert!(matches!(
        repo.discover_repository(ALICE.into(), "2026-01-16T12:00:00Z".into())
            .await
            .unwrap(),
        DiscoveryAdmission::Known
    ));
    let after = repo.backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(after.generation, job.generation);
    assert_eq!(after.updated_at, job.updated_at);
    assert_eq!(counter(&db).await, job.generation);
    db.close().await;
}

#[tokio::test]
async fn known_discovery_preserves_account_policy() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    repo.request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap();
    repo.account_inactive(ALICE.into(), NOW.into())
        .await
        .unwrap();
    let before = repo.backfill(ALICE).await.unwrap().unwrap();
    assert!(!before.reactivate);
    assert!(matches!(
        repo.discover_repository(ALICE.into(), NOW.into())
            .await
            .unwrap(),
        DiscoveryAdmission::Known
    ));
    let after = repo.backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.updated_at, before.updated_at);
    assert!(!after.reactivate);
    assert!(!repo.user(ALICE).await.unwrap().unwrap().active);
    // A known active owner is likewise left active, without implicitly scheduling a job.
    repo.upsert_user(User::new(BOB, NOW)).await.unwrap();
    let before_counter = counter(&db).await;
    assert!(matches!(
        repo.discover_repository(BOB.into(), NOW.into())
            .await
            .unwrap(),
        DiscoveryAdmission::Known
    ));
    assert!(repo.user(BOB).await.unwrap().unwrap().active);
    assert!(repo.backfill(BOB).await.unwrap().is_none());
    assert_eq!(counter(&db).await, before_counter);
    db.close().await;
}

#[tokio::test]
async fn discovery_and_disconnect_are_atomic() {
    for disconnect_first in [false, true] {
        let temp = Temp::new();
        let db = temp.database().await;
        let repo = db.repositories();
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
        let discovery = repo.discover_repository(ALICE.into(), NOW.into());
        let disconnect = repo.disconnect(ALICE.into(), NOW.into());
        tokio::pin!(discovery, disconnect);
        std::future::poll_fn(|cx| {
            if disconnect_first {
                assert!(disconnect.as_mut().poll(cx).is_pending());
                assert!(discovery.as_mut().poll(cx).is_pending());
            } else {
                assert!(discovery.as_mut().poll(cx).is_pending());
                assert!(disconnect.as_mut().poll(cx).is_pending());
            }
            Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        blocker.wait().await.unwrap();
        let admission = discovery.await.unwrap();
        disconnect.await.unwrap();
        assert_eq!(
            matches!(admission, DiscoveryAdmission::Suppressed),
            disconnect_first
        );
        assert_eq!(local_owner_rows(&db, ALICE).await, 0);
        assert!(repo.is_suppressed(ALICE).await.unwrap());
        let before = counter(&db).await;
        assert!(matches!(
            repo.discover_repository(ALICE.into(), NOW.into())
                .await
                .unwrap(),
            DiscoveryAdmission::Suppressed
        ));
        assert_eq!(local_owner_rows(&db, ALICE).await, 0);
        assert_eq!(counter(&db).await, before);
        db.close().await;
    }
}

#[tokio::test]
async fn discovery_busy_rolls_back_owner_and_generation() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    for i in 0..1024 {
        let did = format!("did:fixture:queued{i}");
        assert!(matches!(
            repo.discover_repository(did, NOW.into()).await.unwrap(),
            DiscoveryAdmission::Queued(_)
        ));
    }
    let before = counter(&db).await;
    assert!(matches!(
        repo.discover_repository(ALICE.into(), NOW.into()).await,
        Err(StorageError::ServiceBusy)
    ));
    assert_eq!(local_owner_rows(&db, ALICE).await, 0);
    assert_eq!(counter(&db).await, before);
    assert!(!repo.is_suppressed(ALICE).await.unwrap());
    assert_eq!(repo.pending_backfill_count().await.unwrap(), 1024);
    // Coalescing an already known hint still works at full capacity.
    assert!(matches!(
        repo.discover_repository("did:fixture:queued0".into(), NOW.into())
            .await
            .unwrap(),
        DiscoveryAdmission::Known
    ));
    assert_eq!(counter(&db).await, before);
    db.close().await;
}

#[tokio::test]
async fn discovery_invalid_input_and_allocator_failure() {
    let temp = Temp::new();
    let db = temp.database().await;
    let repo = db.repositories();
    for did in [
        "",
        "alice.test",
        "did:plc:",
        "did:PLC:invalid",
        "did:web:example.test/path",
    ] {
        assert!(matches!(
            repo.discover_repository(did.into(), NOW.into()).await,
            Err(StorageError::Invariant("invalid discovery DID"))
        ));
    }
    assert!(
        repo.discover_repository(ALICE.into(), "invalid-time".into())
            .await
            .is_err()
    );
    assert_eq!(local_owner_rows(&db, ALICE).await, 0);
    assert_eq!(counter(&db).await, 0);
    db.writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("UPDATE backfill_generation SET last_generation=?")
                    .bind(i64::MAX)
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(matches!(
        repo.discover_repository(ALICE.into(), NOW.into()).await,
        Err(StorageError::Invariant("backfill generation exhausted"))
    ));
    assert_eq!(local_owner_rows(&db, ALICE).await, 0);
    assert_eq!(counter(&db).await, i64::MAX);
    db.close().await;
}

#[tokio::test]
async fn concurrent_discovery_coalesces_one_admission() {
    let temp = Temp::new();
    let db = temp.database().await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let repo = db.repositories();
        tasks.spawn(async move {
            repo.discover_repository(ALICE.into(), NOW.into())
                .await
                .unwrap()
        });
    }
    let mut queued = 0;
    let mut known = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            DiscoveryAdmission::Queued(_) => queued += 1,
            DiscoveryAdmission::Known => known += 1,
            DiscoveryAdmission::Suppressed => panic!("no disconnect occurred"),
        }
    }
    assert_eq!(queued, 1);
    assert_eq!(known, 31);
    assert_eq!(counter(&db).await, 1);
    assert_eq!(local_owner_rows(&db, ALICE).await, 3);
    assert!(!db.repositories().user(ALICE).await.unwrap().unwrap().active);
    db.close().await;
}

#[tokio::test]
async fn discovery_and_authorization_preserve_newer_generation() {
    for authorization_first in [false, true] {
        let temp = Temp::new();
        let db = temp.database().await;
        let repo = db.repositories();
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
        let discovery = repo.discover_repository(ALICE.into(), NOW.into());
        // Storage receives opaque ciphertext from the validated OAuth boundary.
        let authorization = repo.install_authorized_oauth(
            User::new(ALICE, NOW),
            OAuthTokens {
                owner: ALICE.into(),
                encrypted_material: b"opaque-authorized-ciphertext".to_vec(),
                generation: 0,
                expires_at: 1768482000,
            },
        );
        tokio::pin!(discovery, authorization);
        std::future::poll_fn(|cx| {
            if authorization_first {
                assert!(authorization.as_mut().poll(cx).is_pending());
                assert!(discovery.as_mut().poll(cx).is_pending());
            } else {
                assert!(discovery.as_mut().poll(cx).is_pending());
                assert!(authorization.as_mut().poll(cx).is_pending());
            }
            Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        blocker.wait().await.unwrap();
        let admission = discovery.await.unwrap();
        authorization.await.unwrap();
        let job = repo.backfill(ALICE).await.unwrap().unwrap();
        assert!(job.reactivate);
        assert!(!repo.user(ALICE).await.unwrap().unwrap().active);
        assert_eq!(
            repo.oauth_tokens(ALICE)
                .await
                .unwrap()
                .unwrap()
                .encrypted_material,
            b"opaque-authorized-ciphertext"
        );
        match admission {
            DiscoveryAdmission::Known => assert!(authorization_first),
            DiscoveryAdmission::Queued(old) => {
                assert!(!authorization_first);
                assert!(job.generation > old.generation);
                assert!(
                    !repo
                        .account_inactive_generation(ALICE.into(), old.generation, NOW.into())
                        .await
                        .unwrap()
                );
            }
            DiscoveryAdmission::Suppressed => panic!("no disconnect occurred"),
        }
        assert_eq!(
            repo.backfill(ALICE).await.unwrap().unwrap().generation,
            job.generation
        );
        assert_eq!(counter(&db).await, job.generation);
        db.close().await;
    }
}
