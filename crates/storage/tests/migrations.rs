mod common;
use atmusic_storage::{Database, StorageError};
use common::*;
use sqlx::{
    Connection, SqliteConnection,
    migrate::{Migration, MigrationType, Migrator},
    sqlite::SqliteConnectOptions,
};
use std::borrow::Cow;
#[tokio::test]
async fn fresh_and_reopen() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    db.repositories()
        .apply_scrobble(row("r01", "rev1"))
        .await
        .unwrap();
    let version = db.schema_version().await.unwrap();
    assert_eq!(version, atmusic_storage::migrations::SCHEMA_VERSION);
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(journal, "wal");
    let timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(timeout, 5000);
    assert_eq!(db.reader_pool().options().get_max_connections(), 4);
    db.close().await;
    let reopened = temp.database().await;
    assert_eq!(reopened.schema_version().await.unwrap(), version);
    assert!(
        reopened
            .repositories()
            .scrobble(&row("r01", "rev1").uri)
            .await
            .unwrap()
            .is_some()
    );
    reopened.close().await;
}
#[tokio::test]
async fn migration_rollback() {
    let temp = Temp::new();
    let db = temp.database().await;
    db.close().await;
    let mut c = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&temp.path))
        .await
        .unwrap();
    let migration = Migration::new(
        atmusic_storage::migrations::SCHEMA_VERSION + 1,
        Cow::Borrowed("broken fixture"),
        MigrationType::Simple,
        Cow::Borrowed(
            "CREATE TABLE should_rollback(id INTEGER); THIS IS INVALID SQL; PRAGMA user_version=2;",
        ),
        false,
    );
    let mut list = atmusic_storage::migrations::embedded()
        .migrations
        .into_owned();
    list.push(migration);
    let migrator = Migrator {
        migrations: Cow::Owned(list),
        ..Migrator::DEFAULT
    };
    assert!(migrator.run(&mut c).await.is_err());
    let table_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='should_rollback'")
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(table_count, 0);
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(version, atmusic_storage::migrations::SCHEMA_VERSION);
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(version, atmusic_storage::migrations::SCHEMA_VERSION);
    c.close().await.unwrap();
}
#[tokio::test]
async fn future_schema() {
    let temp = Temp::new();
    let mut c = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&temp.path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE preserve_me(value TEXT); INSERT INTO preserve_me VALUES('unchanged'); PRAGMA user_version=999;").execute(&mut c).await.unwrap();
    c.close().await.unwrap();
    let before = std::fs::read(&temp.path).unwrap();
    assert!(matches!(
        Database::open(&temp.path).await,
        Err(StorageError::SchemaTooNew { found: 999, .. })
    ));
    assert_eq!(std::fs::read(&temp.path).unwrap(), before);
    assert!(!temp.path.with_extension("sqlite-wal").exists());
}

#[tokio::test]
async fn forward_upgrade_preserves_owned_rows() {
    let temp = Temp::new();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&temp.path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    let first = atmusic_storage::migrations::embedded()
        .migrations
        .into_owned()
        .remove(0);
    Migrator {
        migrations: Cow::Owned(vec![first]),
        ..Migrator::DEFAULT
    }
    .run(&mut connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users(did,joined_at) VALUES(?,?); INSERT INTO operations(operation_id,owner,kind,created_at,updated_at) VALUES('old-operation',?,'scrobble_create',?,?)")
        .bind(ALICE).bind(NOW).bind(ALICE).bind(NOW).bind(NOW).execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let db = temp.database().await;
    assert_eq!(
        db.schema_version().await.unwrap(),
        atmusic_storage::migrations::SCHEMA_VERSION
    );
    assert_eq!(
        db.repositories()
            .operation(ALICE, "old-operation")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    assert!(
        db.repositories()
            .request_backfill(ALICE.into(), false, NOW.into())
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _sqlx_migrations")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        atmusic_storage::migrations::SCHEMA_VERSION
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operation_dependencies")
            .fetch_one(db.reader_pool())
            .await
            .unwrap(),
        0
    );
    db.close().await;
}

#[tokio::test]
async fn generation_upgrade_starts_above_existing_jobs() {
    let temp = Temp::new();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&temp.path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    let mut prior = atmusic_storage::migrations::embedded()
        .migrations
        .into_owned();
    prior.truncate(3);
    Migrator {
        migrations: Cow::Owned(prior),
        ..Migrator::DEFAULT
    }
    .run(&mut connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users(did,joined_at) VALUES(?,?); INSERT INTO repo_backfills(did,state,generation,updated_at) VALUES(?,'pending',1000,?)")
        .bind(ALICE).bind(NOW).bind(ALICE).bind(NOW).execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let db = temp.database().await;
    let repo = db.repositories();
    assert_eq!(
        repo.backfill(ALICE).await.unwrap().unwrap().generation,
        1000
    );
    let next = repo
        .request_backfill(ALICE.into(), false, NOW.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.generation, 1001);
    assert_eq!(db.schema_version().await.unwrap(), 4);
    db.close().await;
}
