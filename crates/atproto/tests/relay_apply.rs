#[path = "support/signed_repo.rs"]
mod signed_repo;

use std::path::PathBuf;

use atmusic_atproto::sync::{
    apply::{ApplyContext, ApplyError, apply_commit},
    frames::CommitEvent,
    verify::{
        SigningKeyResolver, UnavailableSigningKeyResolver, VerificationError,
        content_addressed_car_blocks,
    },
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atmusic_storage::{Database, PageBounds, StatisticsWindow, User};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use signed_repo::{
    ALICE, FixtureResolver, signed_mutation, signed_repo, signed_repo_with_bad_signature,
};

const RELAY: &str = "fixture-relay";
fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn records() -> Vec<(String, Value)> {
    vec![
        (
            "com.example.atmusic.scrobble/r01".into(),
            json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"}),
        ),
        (
            "com.example.atmusic.follow/f01".into(),
            json!({"$type":"com.example.atmusic.follow","subject":"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb","createdAt":"2026-01-15T12:00:00Z"}),
        ),
    ]
}

struct TempDatabase {
    directory: PathBuf,
    database: Database,
}
impl TempDatabase {
    async fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("atmusic-relay-{:032x}", rand::random::<u128>()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = Database::open(directory.join("fixture.sqlite"))
            .await
            .unwrap();
        database
            .repositories()
            .upsert_user(User::new(ALICE, "2026-01-15T12:00:00Z"))
            .await
            .unwrap();
        Self {
            directory,
            database,
        }
    }
    async fn close(self) {
        self.database.close().await;
    }
}
impl Drop for TempDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

async fn apply(
    db: &Database,
    event: &CommitEvent,
    expected_did: &str,
    resolver: &dyn SigningKeyResolver,
) -> Result<atmusic_atproto::sync::apply::ApplyOutcome, ApplyError> {
    let namespace = Namespace::new(FIXTURE_PREFIX).unwrap();
    apply_commit(
        &db.repositories(),
        event,
        ApplyContext {
            relay: RELAY,
            expected_did,
            namespace: &namespace,
            receipt_time: now(),
            resolver,
        },
    )
    .await
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    scrobbles: Vec<(String, String, String, String)>,
    follows: Vec<(String, String, String, String)>,
    checkpoint: Option<(i64, Option<String>, String)>,
}
async fn snapshot(db: &Database) -> Snapshot {
    Snapshot {
        scrobbles: sqlx::query_as("SELECT uri,cid,revision,track FROM scrobbles ORDER BY uri")
            .fetch_all(db.reader_pool())
            .await
            .unwrap(),
        follows: sqlx::query_as("SELECT uri,cid,revision,subject FROM follows ORDER BY uri")
            .fetch_all(db.reader_pool())
            .await
            .unwrap(),
        checkpoint: sqlx::query_as(
            "SELECT sequence,revision,indexed_at FROM relay_checkpoints WHERE relay=?",
        )
        .bind(RELAY)
        .fetch_optional(db.reader_pool())
        .await
        .unwrap(),
    }
}

#[tokio::test]
async fn duplicate_commit() {
    let db = TempDatabase::new().await;
    let fixture = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(fixture.key);
    assert!(
        apply(&db.database, &fixture.event, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    let original = snapshot(&db.database).await;
    assert_eq!(original.scrobbles.len(), 1);
    assert_eq!(original.follows.len(), 1);
    assert_eq!(original.checkpoint.as_ref().unwrap().0, 1);
    let replay = apply(&db.database, &fixture.event, ALICE, &resolver)
        .await
        .unwrap();
    assert!(!replay.applied);
    assert!(replay.excluded.is_empty());
    assert_eq!(snapshot(&db.database).await, original);
    let stats = db
        .database
        .repositories()
        .statistics(ALICE, StatisticsWindow::All, now(), 10)
        .await
        .unwrap();
    assert_eq!(
        (
            stats.total_scrobbles,
            stats.distinct_artists,
            stats.distinct_tracks
        ),
        (1, 1, 1)
    );
    db.close().await;
}

#[tokio::test]
async fn repository_revision_advances_for_follow_exclusion_and_empty_commit() {
    let db = TempDatabase::new().await;
    let initial = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(initial.key.clone());
    apply(&db.database, &initial.event, ALICE, &resolver)
        .await
        .unwrap();
    let following=signed_mutation(&initial,"com.example.atmusic.follow/f01",Some(json!({"$type":"com.example.atmusic.follow","subject":"did:plc:cccccccccccccccccccccccc","createdAt":"2026-01-15T12:00:00Z"})),7,"3m4zm2ufr2223").await;
    apply(&db.database, &following.event, ALICE, &resolver)
        .await
        .unwrap();
    assert_eq!(
        db.database
            .repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .revision
            .as_deref(),
        Some("3m4zm2ufr2223")
    );
    let mut unrelated=signed_mutation(&following,"app.bsky.feed.post/p01",Some(json!({"$type":"app.bsky.feed.post","text":"unrelated signed change","createdAt":"2026-01-15T12:00:00Z"})),7,"3m4zm2ufr2224").await;
    // The bounded frame decoder removes nonmusic operations; the signed commit still advances DID revision.
    unrelated.event.operations.clear();
    let before = snapshot(&db.database).await;
    db.database.writer().execute(|c|Box::pin(async move {sqlx::query("CREATE TRIGGER reject_empty_checkpoint BEFORE UPDATE ON relay_checkpoints WHEN NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END").execute(c).await?;Ok(())})).await.unwrap();
    assert!(
        apply(&db.database, &unrelated.event, ALICE, &resolver)
            .await
            .is_err()
    );
    assert_eq!(snapshot(&db.database).await, before);
    assert_eq!(
        db.database
            .repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .revision
            .as_deref(),
        Some("3m4zm2ufr2223")
    );
    db.database
        .writer()
        .execute(|c| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_empty_checkpoint")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        apply(&db.database, &unrelated.event, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    assert_eq!(
        db.database
            .repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .revision
            .as_deref(),
        Some("3m4zm2ufr2224")
    );
    assert!(
        !apply(&db.database, &unrelated.event, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    let invalid=signed_mutation(&unrelated,"com.example.atmusic.scrobble/r01",Some(json!({"$type":"com.example.atmusic.scrobble","artist":"   ","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"})),7,"3m4zm2ufr2225").await;
    let result = apply(&db.database, &invalid.event, ALICE, &resolver)
        .await
        .unwrap();
    assert_eq!(result.excluded.len(), 1);
    assert_eq!(
        db.database
            .repositories()
            .user(ALICE)
            .await
            .unwrap()
            .unwrap()
            .revision
            .as_deref(),
        Some("3m4zm2ufr2225")
    );
    assert_eq!(
        db.database
            .repositories()
            .public_counts(ALICE)
            .await
            .unwrap()
            .0,
        0
    );
    db.close().await;
}

#[tokio::test]
async fn atomic_fault() {
    let db = TempDatabase::new().await;
    let fixture = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(fixture.key);
    let before = snapshot(&db.database).await;
    // This test-only trigger is an explicit barrier after record mutations, before checkpoint insertion.
    sqlx::query("CREATE TRIGGER injected_checkpoint_fault BEFORE INSERT ON relay_checkpoints BEGIN SELECT RAISE(ABORT,'injected_checkpoint_fault'); END").execute(db.database.reader_pool()).await.unwrap();
    assert!(matches!(
        apply(&db.database, &fixture.event, ALICE, &resolver).await,
        Err(ApplyError::Storage(_))
    ));
    assert_eq!(
        snapshot(&db.database).await,
        before,
        "all record changes and sequence must roll back"
    );
    sqlx::query("DROP TRIGGER injected_checkpoint_fault")
        .execute(db.database.reader_pool())
        .await
        .unwrap();
    assert!(
        apply(&db.database, &fixture.event, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    let after = snapshot(&db.database).await;
    assert_eq!(
        (
            after.scrobbles.len(),
            after.follows.len(),
            after.checkpoint.unwrap().0
        ),
        (1, 1, 1)
    );
    assert_eq!(after.scrobbles[0].1, fixture.record_cids[0].to_string());
    assert_eq!(after.follows[0].1, fixture.record_cids[1].to_string());
    db.close().await;
}

#[tokio::test]
async fn tampering_matrix() {
    let db = TempDatabase::new().await;
    let fixture = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(fixture.key.clone());
    assert!(
        apply(&db.database, &fixture.event, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    let before = snapshot(&db.database).await;
    let mut signature = signed_repo_with_bad_signature(records(), 7, true)
        .await
        .event;
    signature.sequence = 2;
    let mut bad_block = fixture.event.clone();
    bad_block.sequence = 2;
    let blocks = content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let bytes = &blocks[&fixture.record_cids[0].to_string()];
    let index = bad_block
        .blocks
        .windows(bytes.len())
        .position(|window| window == bytes)
        .unwrap();
    bad_block.blocks[index + bytes.len() - 1] ^= 1;
    let mut bad_path = fixture.event.clone();
    bad_path.sequence = 2;
    bad_path.operations[0].path = "com.example.atmusic.scrobble/absent".into();
    let cases = [
        (signature, ALICE, VerificationError::InvalidSignature),
        (bad_block, ALICE, VerificationError::CidMismatch),
        (
            fixture.event.clone(),
            "did:plc:cccccccccccccccccccccccc",
            VerificationError::CommitMismatch,
        ),
        (bad_path, ALICE, VerificationError::MembershipMismatch),
    ];
    for (event, expected_did, error) in cases {
        assert!(
            matches!(apply(&db.database,&event,expected_did,&resolver).await,Err(ApplyError::Verification(actual)) if actual==error)
        );
        assert_eq!(
            snapshot(&db.database).await,
            before,
            "rejected {error:?} must not mutate SQLite or checkpoint"
        );
    }
    let mut valid = fixture.event;
    valid.sequence = 2;
    assert!(
        apply(&db.database, &valid, ALICE, &resolver)
            .await
            .unwrap()
            .applied
    );
    let after = snapshot(&db.database).await;
    assert_eq!(after.scrobbles, before.scrobbles);
    assert_eq!(after.follows, before.follows);
    assert_eq!(after.checkpoint.unwrap().0, 2);
    db.close().await;
}

#[tokio::test]
async fn update_delete() {
    let db = TempDatabase::new().await;
    let first = signed_repo(records(), 7).await;
    apply(
        &db.database,
        &first.event,
        ALICE,
        &FixtureResolver(first.key.clone()),
    )
    .await
    .unwrap();
    let path = &first.event.operations[0].path;
    let mut record = records().remove(0).1;
    record["track"] = json!("Army of Me");
    let update = signed_mutation(&first, path, Some(record), 7, "3m4zm2ufr2223").await;
    apply(
        &db.database,
        &update.event,
        ALICE,
        &FixtureResolver(update.key.clone()),
    )
    .await
    .unwrap();
    let rows = db
        .database
        .repositories()
        .history(ALICE, PageBounds::default())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].track, "Army of Me");
    assert_eq!(rows[0].cid, update.record_cids[0].to_string());
    let deleted = signed_mutation(&update, path, None, 7, "3m4zm2ufr2224").await;
    apply(
        &db.database,
        &deleted.event,
        ALICE,
        &FixtureResolver(deleted.key),
    )
    .await
    .unwrap();
    assert!(
        db.database
            .repositories()
            .history(ALICE, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        db.database
            .repositories()
            .feed(None, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.database
            .repositories()
            .statistics(ALICE, StatisticsWindow::All, now(), 10)
            .await
            .unwrap()
            .total_scrobbles,
        0
    );
    assert_eq!(
        db.database
            .repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        3
    );
    db.close().await;
}

#[tokio::test]
async fn unavailable_revision_trust_never_indexes() {
    let db = TempDatabase::new().await;
    let fixture = signed_repo(records(), 7).await;
    let before = snapshot(&db.database).await;
    assert!(matches!(
        apply(
            &db.database,
            &fixture.event,
            ALICE,
            &UnavailableSigningKeyResolver
        )
        .await,
        Err(ApplyError::Verification(
            VerificationError::UntrustedIdentity
        ))
    ));
    assert_eq!(snapshot(&db.database).await, before);
    assert!(
        apply(
            &db.database,
            &fixture.event,
            ALICE,
            &FixtureResolver(fixture.key)
        )
        .await
        .unwrap()
        .applied
    );
    db.close().await;
}

#[tokio::test]
async fn invalid_signed_update_removes_projection_with_reason() {
    let db = TempDatabase::new().await;
    let first = signed_repo(records(), 7).await;
    apply(
        &db.database,
        &first.event,
        ALICE,
        &FixtureResolver(first.key.clone()),
    )
    .await
    .unwrap();
    let path = &first.event.operations[0].path;
    let mut record = records().remove(0).1;
    record["artist"] = json!("");
    let invalid = signed_mutation(&first, path, Some(record), 7, "3m4zm2ufr2223").await;
    let result = apply(
        &db.database,
        &invalid.event,
        ALICE,
        &FixtureResolver(invalid.key.clone()),
    )
    .await
    .unwrap();
    assert!(result.applied);
    assert_eq!(result.excluded.len(), 1);
    assert_eq!(result.excluded[0].error.field, "artist");
    assert!(
        db.database
            .repositories()
            .history(ALICE, PageBounds::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(snapshot(&db.database).await.follows.len(), 1);
    assert_eq!(
        db.database
            .repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        2
    );
    let replay = apply(
        &db.database,
        &invalid.event,
        ALICE,
        &FixtureResolver(invalid.key),
    )
    .await
    .unwrap();
    assert!(!replay.applied);
    assert!(replay.excluded.is_empty());
    db.close().await;
}

#[tokio::test]
async fn remote_extensions_preserve_original_display_and_verified_owner() {
    let db = TempDatabase::new().await;
    let mut input = records();
    input[0].1["artist"] = json!("  BJÖRK  ");
    input[0].1["track"] = json!("jóga");
    input[0].1["album"] = json!(" HOMOGENIC ");
    input[0].1["owner"] = json!("did:plc:cccccccccccccccccccccccc");
    input[0].1["externalMetadata"] = json!({"client":"compatible-writer"});
    input[0].1["e"] = json!("ordinary record extension, not an MST entry list");
    input[0].1["l"] = json!(42);
    input[1].1["externalMetadata"] = json!("ignored extension");
    let fixture = signed_repo(input, 7).await;
    let result = apply(
        &db.database,
        &fixture.event,
        ALICE,
        &FixtureResolver(fixture.key),
    )
    .await
    .unwrap();
    assert!(result.applied);
    assert!(result.excluded.is_empty());
    let rows = db
        .database
        .repositories()
        .history(ALICE, PageBounds::default())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].did, ALICE);
    assert_eq!(rows[0].artist, "  BJÖRK  ");
    assert_eq!(rows[0].track, "jóga");
    assert_eq!(rows[0].album.as_deref(), Some(" HOMOGENIC "));
    assert_eq!(rows[0].artist_key, "björk");
    assert_eq!(snapshot(&db.database).await.follows.len(), 1);
    db.close().await;
}
