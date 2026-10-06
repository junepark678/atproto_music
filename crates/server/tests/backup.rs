use atmusic_atproto::oauth::token_store::{TokenStore, TokenStoreError};
use atmusic_storage::{Database, User, backup};
use sqlx::Row;
use tokio::sync::oneshot;

const DID: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const NOW: &str = "2026-01-15T12:00:00Z";

async fn seed(database: &Database) {
    database
        .repositories()
        .upsert_user(User::new(DID, NOW))
        .await
        .unwrap();
    database.writer().execute(|connection| Box::pin(async move {
        sqlx::query("INSERT INTO scrobbles(uri,cid,did,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key) VALUES ('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/a','cid',?,'rev','Artist','Track',?,?,?,'artist','track')").bind(DID).bind(NOW).bind(NOW).bind(NOW).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at) VALUES ('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.follow/f','cid',?,'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb','rev',?,?)").bind(DID).bind(NOW).bind(NOW).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO operations(operation_id,owner,kind,created_at,updated_at) VALUES('backup-op',?,'scrobble_create',?,?)").bind(DID).bind(NOW).bind(NOW).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO outbox(operation_id,owner,collection,rkey,due_at) VALUES('backup-op',?,'com.example.atmusic.scrobble','pending',?)").bind(DID).bind(NOW).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO relay_checkpoints(relay,sequence,revision,indexed_at) VALUES ('wss://relay.example',42,'rev',?)").bind(NOW).execute(connection).await?;
        Ok(())
    })).await.unwrap();
}

fn token_payload() -> serde_json::Value {
    serde_json::json!({"did":DID,"issuer":"https://auth.example","access_token":"backup-access-only-fixture","refresh_token":"backup-refresh-only-fixture","expires_at":1800000000})
}

#[tokio::test]
async fn backup_during_write() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("live.sqlite");
    let database = Database::open(&source).await.unwrap();
    let (started, active) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let write = database
        .writer()
        .enqueue(move |connection| {
            Box::pin(async move {
                for did in [
                    "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
                    "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
                ] {
                    sqlx::query("INSERT INTO users(did,joined_at) VALUES (?,?)")
                        .bind(did)
                        .bind(NOW)
                        .execute(&mut *connection)
                        .await?;
                }
                let _ = started.send(());
                let _ = released.await;
                Ok(())
            })
        })
        .unwrap();
    active.await.unwrap();
    let before = directory.path().join("before.sqlite");
    backup::snapshot(&source, &before).await.unwrap();
    release.send(()).unwrap();
    write.wait().await.unwrap();
    let after = directory.path().join("after.sqlite");
    backup::snapshot(&source, &after).await.unwrap();
    for (snapshot, count, name) in [(&before, 0, "before-restore"), (&after, 2, "after-restore")] {
        let path = backup::restore(snapshot, directory.path().join(name))
            .await
            .unwrap();
        let restored = Database::open(path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
                .fetch_one(restored.reader_pool())
                .await
                .unwrap(),
            count
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(restored.reader_pool())
                .await
                .unwrap(),
            "ok"
        );
        restored.close().await;
    }
    database.close().await;
}

#[tokio::test]
async fn restore_state() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("live.sqlite");
    let database = Database::open(&source).await.unwrap();
    seed(&database).await;
    let store = TokenStore::new(database.repositories(), &[0x11; 32]).unwrap();
    store
        .put_oauth_tokens(DID, &token_payload(), 1768478400)
        .await
        .unwrap();
    let snapshot = directory.path().join("backup.sqlite");
    backup::snapshot(&source, &snapshot).await.unwrap();
    let restored_path = backup::restore(&snapshot, directory.path().join("restored"))
        .await
        .unwrap();
    let restored = Database::open(&restored_path).await.unwrap();
    for table in [
        "scrobbles",
        "follows",
        "operations",
        "outbox",
        "relay_checkpoints",
        "oauth_tokens",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(restored.reader_pool())
                .await
                .unwrap(),
            1,
            "{table}"
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT sequence FROM relay_checkpoints")
            .fetch_one(restored.reader_pool())
            .await
            .unwrap(),
        42
    );
    let restored_store = TokenStore::new(restored.repositories(), &[0x11; 32]).unwrap();
    assert_eq!(
        restored_store.get_oauth_tokens(DID).await.unwrap(),
        Some(token_payload())
    );
    let bytes = std::fs::read(&snapshot).unwrap();
    assert!(
        !bytes
            .windows(b"backup-access-only-fixture".len())
            .any(|window| window == b"backup-access-only-fixture")
    );
    assert!(
        backup::restore(&snapshot, directory.path().join("restored"))
            .await
            .is_err()
    );
    assert!(backup::snapshot(&source, &snapshot).await.is_err());
    assert_eq!(std::fs::read(&snapshot).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&restored_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(restored_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    restored.close().await;
    database.close().await;
}

#[tokio::test]
async fn wrong_key() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("live.sqlite");
    let database = Database::open(&source).await.unwrap();
    database
        .repositories()
        .upsert_user(User::new(DID, NOW))
        .await
        .unwrap();
    TokenStore::new(database.repositories(), &[0x11; 32])
        .unwrap()
        .put_oauth_tokens(DID, &token_payload(), 1768478400)
        .await
        .unwrap();
    let snapshot = directory.path().join("backup.sqlite");
    backup::snapshot(&source, &snapshot).await.unwrap();
    let path = backup::restore(&snapshot, directory.path().join("restore"))
        .await
        .unwrap();
    let restored = Database::open(path).await.unwrap();
    assert!(matches!(
        TokenStore::new(restored.repositories(), &[]),
        Err(TokenStoreError::InvalidKey)
    ));
    let encrypted_before = sqlx::query("SELECT encrypted_material,generation FROM oauth_tokens")
        .fetch_one(restored.reader_pool())
        .await
        .unwrap();
    let wrong = TokenStore::new(restored.repositories(), &[0x22; 32]).unwrap();
    assert!(matches!(
        wrong.get_oauth_tokens(DID).await,
        Err(TokenStoreError::Authentication)
    ));
    let encrypted_after = sqlx::query("SELECT encrypted_material,generation FROM oauth_tokens")
        .fetch_one(restored.reader_pool())
        .await
        .unwrap();
    assert_eq!(
        encrypted_before.get::<Vec<u8>, _>("encrypted_material"),
        encrypted_after.get::<Vec<u8>, _>("encrypted_material")
    );
    assert_eq!(
        encrypted_before.get::<i64, _>("generation"),
        encrypted_after.get::<i64, _>("generation")
    );
    assert_eq!(
        TokenStore::new(restored.repositories(), &[0x11; 32])
            .unwrap()
            .get_oauth_tokens(DID)
            .await
            .unwrap(),
        Some(token_payload())
    );
    restored.close().await;
    database.close().await;
}

#[tokio::test]
async fn corrupt_or_newer_restore_preserves_existing_instance() {
    let directory = tempfile::tempdir().unwrap();
    let corrupt = directory.path().join("corrupt.sqlite");
    std::fs::write(&corrupt, b"not a SQLite database").unwrap();
    let destination = directory.path().join("restored");
    assert!(backup::restore(&corrupt, &destination).await.is_err());
    assert!(!destination.exists());
    let source = directory.path().join("live.sqlite");
    let database = Database::open(&source).await.unwrap();
    seed(&database).await;
    database
        .writer()
        .execute(|connection| {
            Box::pin(async move {
                sqlx::query(&format!(
                    "PRAGMA user_version={}",
                    atmusic_storage::migrations::SCHEMA_VERSION + 1
                ))
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(backup::restore(&source, &destination).await.is_err());
    assert!(!destination.exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scrobbles")
            .fetch_one(database.reader_pool())
            .await
            .unwrap(),
        1
    );
    database
        .writer()
        .execute(|connection| {
            Box::pin(async move {
                sqlx::query(&format!(
                    "PRAGMA user_version={}",
                    atmusic_storage::migrations::SCHEMA_VERSION
                ))
                .execute(&mut *connection)
                .await?;
                sqlx::query("DROP TABLE follows")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        backup::restore(&source, &destination).await.is_err(),
        "schema marker with missing table passed verification"
    );
    assert!(!destination.exists());
    database.close().await;
}
