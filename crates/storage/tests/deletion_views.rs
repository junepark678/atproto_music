//! Storage transaction tests at the typed verified-projection boundary.
//! Cryptographic evidence and HTTP/PDS acceptance live in server/tests/deletion.rs.
mod common;
use atmusic_storage::*;
use common::*;
fn deletion(key: &str) -> NewOperation {
    NewOperation {
        operation_id: format!("delete-{key}"),
        owner: ALICE.into(),
        kind: "scrobble_delete".into(),
        created_at: NOW.into(),
        record_uri: Some(row(key, "rev1").uri),
        collection: "com.example.atmusic.scrobble".into(),
        rkey: key.into(),
        payload_json: None,
        canonical_digest: None,
    }
}
async fn seven(db: &Database) {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/read_models.json")).unwrap();
    for value in fixture["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|value| value["owner"] == ALICE && value["state"] == "confirmed")
    {
        let record = &value["record"];
        let mut projected = row(value["rkey"].as_str().unwrap(), "rev1");
        projected.artist = record["artist"].as_str().unwrap().into();
        projected.track = record["track"].as_str().unwrap().into();
        projected.album = record["album"].as_str().map(str::to_owned);
        projected.listened_at = record["listenedAt"].as_str().unwrap().into();
        projected.created_at = record["createdAt"].as_str().unwrap().into();
        db.repositories().apply_scrobble(projected).await.unwrap();
    }
}
async fn six(db: &Database, key: &str) {
    let repo = db.repositories();
    let uri = row(key, "rev1").uri;
    assert!(repo.scrobble(&uri).await.unwrap().is_none());
    assert_eq!(
        repo.history(ALICE, PageBounds::default())
            .await
            .unwrap()
            .len(),
        6
    );
    assert!(
        repo.feed(None, PageBounds::default())
            .await
            .unwrap()
            .iter()
            .all(|row| row.uri != uri)
    );
    let now = chrono::DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .with_timezone(&chrono::Utc);
    let stats = repo
        .statistics(ALICE, StatisticsWindow::All, now, 20)
        .await
        .unwrap();
    assert_eq!(stats.total_scrobbles, 6);
    assert_eq!(
        stats
            .top_albums
            .iter()
            .find(|album| atmusic_core::music_key::normalize(&album.album) == "homogenic")
            .unwrap()
            .scrobble_count,
        1
    );
}
#[tokio::test]
async fn read_model_removal() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    seven(&db).await;
    assert!(matches!(
        db.repositories()
            .admit_scrobble_deletion(deletion("r01"))
            .await
            .unwrap(),
        DeletionAdmission::Pending(_)
    ));
    six(&db, "r01").await;
    db.close().await;
}
#[tokio::test]
async fn remote_failure_status() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    seven(&db).await;
    let repo = db.repositories();
    repo.admit_scrobble_deletion(deletion("r01")).await.unwrap();
    repo.finish_operation(
        "delete-r01".into(),
        NOW.into(),
        Some("remote_rejected".into()),
        None,
    )
    .await
    .unwrap();
    match repo.admit_scrobble_deletion(deletion("r01")).await.unwrap() {
        DeletionAdmission::Failed(op) => {
            assert_eq!(op.state, "failed");
            assert_eq!(op.operation_id, "delete-r01");
        }
        _ => panic!("must preserve failed deletion evidence"),
    }
    six(&db, "r01").await;
    db.close().await;
}
#[tokio::test]
async fn external_delete() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    seven(&db).await;
    db.repositories()
        .apply_event(RepositoryEvent {
            checkpoint: Checkpoint {
                relay: "typed-verified-external".into(),
                sequence: 1,
                revision: Some("rev2".into()),
                indexed_at: NOW.into(),
            },
            mutations: vec![RecordMutation::Delete {
                uri: row("r02", "rev1").uri,
                owner: ALICE.into(),
                revision: "rev2".into(),
                indexed_at: NOW.into(),
            }],
        })
        .await
        .unwrap();
    six(&db, "r02").await;
    assert!(
        db.repositories()
            .outbox_due(NOW, 20)
            .await
            .unwrap()
            .is_empty()
    );
    db.close().await;
}
#[tokio::test]
async fn transactional_owner_and_dependency() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    let create = operation("r01", ALICE);
    repo.admit_operation(create, None).await.unwrap();
    assert!(repo.begin_attempt("r01".into(), NOW.into()).await.unwrap());
    let mut bad = deletion("r01");
    bad.owner = BOB.into();
    assert!(matches!(
        repo.admit_scrobble_deletion(bad).await,
        Err(StorageError::Ownership)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tombstones")
        .fetch_one(db.reader_pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    repo.admit_scrobble_deletion(deletion("r01")).await.unwrap();
    assert!(
        !repo
            .begin_attempt("delete-r01".into(), NOW.into())
            .await
            .unwrap()
    );
    repo.finish_operation(
        "r01".into(),
        NOW.into(),
        None,
        Some(RecordMutation::Scrobble(row("r01", "rev1"))),
    )
    .await
    .unwrap();
    assert!(
        repo.scrobble(&row("r01", "rev1").uri)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        repo.begin_attempt("delete-r01".into(), NOW.into())
            .await
            .unwrap()
    );
    db.close().await;
}
#[tokio::test]
async fn external_delete_preserves_local_intent_and_requires_absence() {
    let temp = Temp::new();
    let db = temp.database().await;
    users(&db).await;
    let repo = db.repositories();
    repo.admit_operation(operation("r01", ALICE), None)
        .await
        .unwrap();
    repo.begin_attempt("r01".into(), NOW.into()).await.unwrap();
    repo.admit_scrobble_deletion(deletion("r01")).await.unwrap();
    repo.apply_event(RepositoryEvent {
        checkpoint: Checkpoint {
            relay: "external-race".into(),
            sequence: 1,
            revision: Some("rev2".into()),
            indexed_at: NOW.into(),
        },
        mutations: vec![RecordMutation::Delete {
            uri: row("r01", "rev1").uri,
            owner: ALICE.into(),
            revision: "rev2".into(),
            indexed_at: NOW.into(),
        }],
    })
    .await
    .unwrap();
    repo.apply_scrobble(row("r01", "rev3")).await.unwrap();
    assert!(
        repo.scrobble(&row("r01", "rev1").uri)
            .await
            .unwrap()
            .is_none()
    );
    repo.finish_operation(
        "r01".into(),
        NOW.into(),
        None,
        Some(RecordMutation::Scrobble(row("r01", "rev3"))),
    )
    .await
    .unwrap();
    assert!(
        repo.finish_operation("delete-r01".into(), NOW.into(), None, None)
            .await
            .is_err()
    );
    assert_eq!(
        repo.operation(ALICE, "delete-r01")
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    repo.finish_operation(
        "delete-r01".into(),
        NOW.into(),
        None,
        Some(RecordMutation::Delete {
            uri: row("r01", "rev1").uri,
            owner: ALICE.into(),
            revision: "rev4".into(),
            indexed_at: NOW.into(),
        }),
    )
    .await
    .unwrap();
    assert!(matches!(
        repo.admit_scrobble_deletion(deletion("r01")).await.unwrap(),
        DeletionAdmission::ConfirmedAbsent
    ));
    db.close().await;
}
