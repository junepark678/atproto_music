#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;
use atmusic_atproto::pds::write::Jitter;
use atmusic_server::workers::outbox::OutboxWorker;
use atmusic_storage::{Database, User};
use std::sync::Arc;
use write_pds::*;
struct ZeroJitter;
impl Jitter for ZeroJitter {
    fn milliseconds(&self, _: u64) -> u64 {
        0
    }
}
async fn prepare(replies: Vec<Reply>) -> (tempfile::TempDir, Database, WritePds, OutboxWorker) {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(temp.path().join("music.sqlite"))
        .await
        .unwrap();
    db.repositories()
        .upsert_user(User::new(signed_repo::ALICE, NOW))
        .await
        .unwrap();
    let fixture = WritePds::new(&db, replies, None).await;
    db.repositories()
        .admit_operation(operation(), Some("key".into()))
        .await
        .unwrap();
    let worker = OutboxWorker::new(db.repositories(), fixture.client.clone())
        .with_jitter(Arc::new(ZeroJitter));
    (temp, db, fixture, worker)
}
#[tokio::test]
async fn transient_schedule() {
    let (_temp, db, fixture, worker) = prepare(vec![
        Reply::Status(500, None),
        Reply::Status(429, Some(20)),
        Reply::Status(200, None),
    ])
    .await;
    let repo = db.repositories();
    let start = now();
    worker.run_due(start).await.unwrap();
    let pending = repo
        .outbox_due(&(start + chrono::Duration::seconds(1)).to_rfc3339(), 10)
        .await
        .unwrap();
    assert_eq!(pending[0].attempts, 1);
    assert_eq!(pending[0].due_at, "2026-01-15T12:00:01.000000000Z");
    assert_eq!(worker.run_due(start).await.unwrap(), 0);
    worker
        .run_due(start + chrono::Duration::seconds(1))
        .await
        .unwrap();
    let pending = repo
        .outbox_due(&(start + chrono::Duration::seconds(21)).to_rfc3339(), 10)
        .await
        .unwrap();
    assert_eq!(pending[0].attempts, 2);
    assert_eq!(pending[0].due_at, "2026-01-15T12:00:21.000000000Z");
    worker
        .run_due(start + chrono::Duration::seconds(21))
        .await
        .unwrap();
    let op = repo
        .operation(signed_repo::ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.state, "succeeded");
    assert_eq!(op.attempts, 3);
    assert_eq!(repo.public_counts(signed_repo::ALICE).await.unwrap().0, 1);
    assert_eq!(
        repo.outbox_due("2026-01-16T12:00:00Z", 10)
            .await
            .unwrap()
            .len(),
        0
    );
    let remote = fixture.state.lock().await;
    assert_eq!(remote.calls, 3);
    assert_eq!(
        remote
            .records
            .get(&format!("{PREFIX}.scrobble/{RKEY}"))
            .unwrap(),
        &record("Jóga")
    );
    assert!(remote.payloads.iter().all(|p| p["rkey"] == RKEY));
    drop(remote);
    db.close().await;
}
#[tokio::test]
async fn terminal_attempt() {
    let (_temp, db, fixture, worker) = prepare(vec![Reply::Timeout; 10]).await;
    let mut time = now();
    for attempt in 1..=10 {
        worker.run_due(time).await.unwrap();
        let op = db
            .repositories()
            .operation(signed_repo::ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(op.attempts, attempt);
        if attempt < 10 {
            let due = db
                .repositories()
                .outbox_due("2026-01-16T12:00:00Z", 10)
                .await
                .unwrap()[0]
                .due_at
                .clone();
            time = chrono::DateTime::parse_from_rfc3339(&due)
                .unwrap()
                .with_timezone(&chrono::Utc);
        }
    }
    let op = db
        .repositories()
        .operation(signed_repo::ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.state, "failed");
    assert_eq!(op.attempts, 10);
    assert_eq!(
        worker
            .run_due(time + chrono::Duration::days(1))
            .await
            .unwrap(),
        0
    );
    assert_eq!(fixture.state.lock().await.calls, 10);
    assert_eq!(
        db.repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        0
    );
    db.close().await;
}
#[tokio::test]
async fn permanent_error() {
    for (code, expected) in [
        ("InvalidRecord", "invalid_record"),
        ("InsufficientScope", "forbidden_scope"),
    ] {
        let (_temp, db, fixture, worker) = prepare(vec![Reply::Permanent(code)]).await;
        worker.run_due(now()).await.unwrap();
        let op = db
            .repositories()
            .operation(signed_repo::ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(op.state, "failed");
        assert_eq!(op.attempts, 1);
        assert_eq!(op.failure_code.as_deref(), Some(expected));
        assert_eq!(
            worker
                .run_due(now() + chrono::Duration::days(1))
                .await
                .unwrap(),
            0
        );
        assert_eq!(fixture.state.lock().await.calls, 1);
        assert_eq!(
            db.repositories()
                .public_counts(signed_repo::ALICE)
                .await
                .unwrap()
                .0,
            0
        );
        db.close().await;
    }
}
