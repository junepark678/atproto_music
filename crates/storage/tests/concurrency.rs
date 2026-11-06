mod common;
use atmusic_storage::StorageError;
use common::*;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::sync::Arc;
use tokio::sync::Notify;
#[tokio::test]
async fn concurrent_writes() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let mut tasks = Vec::new();
    for task in 0..10 {
        let repo = db.repositories();
        tasks.push(tokio::spawn(async move {
            for i in 0..10 {
                repo.apply_scrobble(row(&format!("r{task:02}{i:02}"), "rev1"))
                    .await
                    .unwrap();
            }
            10
        }));
    }
    let mut acks = 0;
    for task in tasks {
        acks += task.await.unwrap();
    }
    assert_eq!(acks, 100);
    assert_eq!(db.repositories().public_counts(ALICE).await.unwrap().0, 100);
    assert_eq!(db.writer().unfinished(), 0);
    db.close().await;
}
#[tokio::test]
async fn queue_full() {
    let temp = Temp::new();
    let db = temp.database().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let block = db
        .writer()
        .enqueue({
            let entered = entered.clone();
            let release = release.clone();
            move |_| {
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(())
                })
            }
        })
        .unwrap();
    entered.notified().await;
    let mut pending = Vec::new();
    for _ in 0..1024 {
        pending.push(db.writer().enqueue(|_| Box::pin(async { Ok(()) })).unwrap());
    }
    let error = db
        .writer()
        .enqueue(|_| Box::pin(async { Ok(()) }))
        .err()
        .unwrap();
    assert_eq!(error.code(), "service_busy");
    assert_eq!(db.writer().unfinished(), 1025);
    release.notify_one();
    block.wait().await.unwrap();
    for request in pending {
        request.wait().await.unwrap();
    }
    assert_eq!(db.writer().unfinished(), 0);
    db.close().await;
}
#[tokio::test]
async fn locked_database() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let mut external =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&temp.path))
            .await
            .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut external)
        .await
        .unwrap();
    let request=db.writer().enqueue(|c|Box::pin(async move {sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:fixture:first','2026-01-15T12:00:00Z')").execute(c).await?;Ok(())})).unwrap();
    sqlx::query("ROLLBACK")
        .execute(&mut external)
        .await
        .unwrap();
    request.wait().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut external)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let result=db.writer().execute(|c|Box::pin(async move {sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:fixture:second','2026-01-15T12:00:00Z')").execute(c).await?;Ok(())})).await;
    assert!(matches!(result, Err(StorageError::StorageBusy)));
    assert!(started.elapsed() >= std::time::Duration::from_millis(4500));
    assert!(started.elapsed() < std::time::Duration::from_secs(8));
    sqlx::query("ROLLBACK")
        .execute(&mut external)
        .await
        .unwrap();
    assert!(
        db.repositories()
            .user("did:fixture:first")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        db.repositories()
            .user("did:fixture:second")
            .await
            .unwrap()
            .is_none()
    );
    external.close().await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn close_finishes_connection_and_checkpoint() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let pending=db.writer().enqueue({
        let entered=entered.clone();let release=release.clone();
        move |connection|Box::pin(async move{
            sqlx::query("INSERT INTO users(did,joined_at) VALUES('did:fixture:close','2026-01-15T12:00:00Z')").execute(connection).await?;
            entered.notify_one();release.notified().await;Ok(())
        })
    }).unwrap();
    entered.notified().await;
    assert!(temp.path.with_extension("sqlite-wal").exists());
    let closing = tokio::spawn({
        let db = db.clone();
        async move {
            db.close().await;
        }
    });
    release.notify_one();
    pending.wait().await.unwrap();
    closing.await.unwrap();
    assert!(db.writer().is_closed());
    assert!(!db.is_ready());
    assert!(
        !temp.path.with_extension("sqlite-wal").exists(),
        "close must complete the final WAL checkpoint"
    );
    assert!(
        !temp.path.with_extension("sqlite-shm").exists(),
        "no owned SQLite connection may retain shared memory"
    );
    // Immediate independent reopen in DELETE mode requires all WAL connections released.
    let mut reopened = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&temp.path)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
            .busy_timeout(std::time::Duration::ZERO),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE did='did:fixture:close'")
        .fetch_one(&mut reopened)
        .await
        .unwrap();
    assert_eq!(count, 1);
    for entry in std::fs::read_dir(&temp.dir).unwrap() {
        let _ = std::fs::read(entry.unwrap().path()).unwrap();
    }
    reopened.close().await.unwrap();
    // Waiting again observes the completed close and does not depend on a consumed notification.
    db.close().await;
}
