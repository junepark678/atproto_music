mod common;
use common::*;
#[tokio::test]
async fn unique_record() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    db.repositories()
        .apply_scrobble(row("r01", "rev1"))
        .await
        .unwrap();
    let result = db
        .writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("INSERT INTO scrobbles SELECT * FROM scrobbles WHERE uri LIKE '%/r01'")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await;
    assert!(result.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM scrobbles")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    db.close().await;
}
#[tokio::test]
async fn idempotency_scope() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    for (id, owner) in [("a1", ALICE), ("a2", ALICE), ("b1", BOB)] {
        db.repositories()
            .admit_operation(operation(id, owner), None)
            .await
            .unwrap();
    }
    async fn insert(
        db: &atmusic_storage::Database,
        owner: &str,
        id: &str,
    ) -> Result<(), atmusic_storage::StorageError> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        db.writer().execute(move |c| Box::pin(async move { sqlx::query("INSERT INTO idempotency(owner,key,digest,operation_id) VALUES(?,'shared','digest',?)").bind(owner).bind(id).execute(c).await?; Ok(()) })).await
    }
    insert(&db, ALICE, "a1").await.unwrap();
    assert!(insert(&db, ALICE, "a2").await.is_err());
    insert(&db, BOB, "b1").await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM idempotency")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 2);
    db.close().await;
}
#[tokio::test]
async fn foreign_key() {
    let temp = Temp::new();
    let db = temp.database().await;
    assert!(
        db.repositories()
            .admit_operation(operation("missing", ALICE), None)
            .await
            .is_err()
    );
    for table in ["operations", "outbox"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(db.reader_pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);
    db.close().await;
}
