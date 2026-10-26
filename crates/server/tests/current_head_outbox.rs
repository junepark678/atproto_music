//! Production current-head proof through owned identity/PDS HTTP listeners.
//! Concurrent head changes must never admit unsigned data or repeat a committed write.
#[path = "../../atproto/tests/support/signed_repo.rs"]
mod signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;

use async_trait::async_trait;
use atmusic_atproto::{
    pds::{
        reconcile::PdsClient,
        write::{Jitter, PdsWriteBoundary, WriteOutcome},
    },
    sync::current_head::CurrentHeadResolver,
};
use atmusic_server::workers::outbox::OutboxWorker;
use atmusic_storage::{Database, DeletionAdmission, Operation, OutboxItem, RecordMutation, User};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use tokio::sync::Mutex;
use write_pds::*;

struct ZeroJitter;
impl Jitter for ZeroJitter {
    fn milliseconds(&self, _: u64) -> u64 {
        0
    }
}

struct RecordedBoundary {
    client: Arc<PdsClient>,
    outcomes: Mutex<Vec<WriteOutcome>>,
}
#[async_trait]
impl PdsWriteBoundary for RecordedBoundary {
    async fn execute(&self, item: &OutboxItem, now: DateTime<Utc>) -> WriteOutcome {
        let outcome = self.client.execute(item, now).await;
        self.outcomes.lock().await.push(outcome.clone());
        outcome
    }
    async fn reconcile(&self, item: &OutboxItem, now: DateTime<Utc>) -> WriteOutcome {
        let outcome = self.client.reconcile(item, now).await;
        self.outcomes.lock().await.push(outcome.clone());
        outcome
    }
}

struct Harness {
    _directory: tempfile::TempDir,
    database: Database,
    pds: WritePds,
    boundary: Arc<RecordedBoundary>,
    worker: OutboxWorker,
}
impl Harness {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("music.sqlite"))
            .await
            .unwrap();
        database
            .repositories()
            .upsert_user(User::new(signed_repo::ALICE, NOW))
            .await
            .unwrap();
        let pds = WritePds::new(&database, vec![], None).await;
        let resolver = Arc::new(CurrentHeadResolver::new(pds.safe_client()));
        let boundary = Arc::new(RecordedBoundary {
            client: pds.rebuild_with_resolver(&database, resolver).await,
            outcomes: Mutex::new(vec![]),
        });
        let worker = OutboxWorker::new(database.repositories(), boundary.clone())
            .with_jitter(Arc::new(ZeroJitter));
        Self {
            _directory: directory,
            database,
            pds,
            boundary,
            worker,
        }
    }
    async fn create(&self) {
        self.database
            .repositories()
            .admit_operation(operation(), Some("current-head-create".into()))
            .await
            .unwrap();
    }
    async fn operation(&self, id: &str) -> Operation {
        self.database
            .repositories()
            .operation(signed_repo::ALICE, id)
            .await
            .unwrap()
            .unwrap()
    }
    async fn assert_transient(&self, index: usize, expected: &'static str) {
        let outcomes = self.boundary.outcomes.lock().await;
        assert!(
            matches!(&outcomes[index], WriteOutcome::Transient { failure_code, retry_after: None }
                        if *failure_code == expected),
            "{:?}",
            outcomes[index]
        );
    }
}

#[tokio::test]
async fn create_head_race_reconciles_without_rewrite() {
    let harness = Harness::new().await;
    harness
        .pds
        .state
        .lock()
        .await
        .head_faults
        .push_back((1, HeadReply::Advance));
    harness.create().await;
    assert_eq!(harness.worker.run_due(now()).await.unwrap(), 1);
    harness.assert_transient(0, "current_head_changed").await;
    let pending = harness.operation("operation-one").await;
    assert_eq!(pending.state, "pending");
    assert_eq!(pending.attempts, 1);
    assert_eq!(
        harness
            .database
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        0
    );
    let (head_revision, remote_cid) = {
        let remote = harness.pds.state.lock().await;
        assert_eq!(remote.calls, 1);
        assert_eq!(remote.records.len(), 2);
        assert_eq!(
            remote.records[&format!("{PREFIX}.scrobble/{RKEY}")],
            record("Jóga")
        );
        (
            remote.fixture.event.revision.clone(),
            remote.cids[&format!("{PREFIX}.scrobble/{RKEY}")].clone(),
        )
    };
    assert_eq!(
        harness
            .worker
            .run_due(now() + chrono::Duration::milliseconds(999))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness
            .worker
            .run_due(now() + chrono::Duration::seconds(1))
            .await
            .unwrap(),
        1
    );
    let completed = harness.operation("operation-one").await;
    assert_eq!(completed.state, "succeeded");
    assert_eq!(completed.attempts, 2);
    assert_eq!(completed.record_uri, pending.record_uri);
    let row = harness
        .database
        .repositories()
        .scrobble(completed.record_uri.as_deref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.revision, head_revision);
    assert_eq!(row.cid, remote_cid);
    assert_eq!(row.track, "Jóga");
    assert_eq!(
        harness
            .database
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        1
    );
    let remote = harness.pds.state.lock().await;
    assert_eq!(remote.calls, 1, "retry must use signed read reconciliation");
    assert_eq!(remote.head_requests, 3);
    assert_eq!(
        remote.identity_requests, 6,
        "each head proof requires fresh before/after identity"
    );
    drop(remote);
    harness.database.close().await;
}

#[tokio::test]
async fn delete_head_race_reconciles_signed_absence() {
    let harness = Harness::new().await;
    harness.create().await;
    harness.worker.run_due(now()).await.unwrap();
    assert_eq!(harness.operation("operation-one").await.state, "succeeded");
    let mut deletion = operation();
    deletion.operation_id = "delete-one".into();
    deletion.kind = "scrobble_delete".into();
    deletion.payload_json = None;
    deletion.canonical_digest = None;
    assert!(matches!(
        harness
            .database
            .repositories()
            .admit_scrobble_deletion(deletion)
            .await
            .unwrap(),
        DeletionAdmission::Pending(_)
    ));
    harness
        .pds
        .state
        .lock()
        .await
        .head_faults
        .push_back((2, HeadReply::Advance));
    harness.worker.run_due(now()).await.unwrap();
    harness.assert_transient(1, "current_head_changed").await;
    let pending = harness.operation("delete-one").await;
    assert_eq!(pending.state, "pending");
    assert_eq!(pending.attempts, 1);
    assert_eq!(
        harness
            .database
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .0,
        0
    );
    let revision = {
        let remote = harness.pds.state.lock().await;
        assert_eq!(remote.calls, 2);
        assert!(
            !remote
                .records
                .contains_key(&format!("{PREFIX}.scrobble/{RKEY}"))
        );
        remote.fixture.event.revision.clone()
    };
    harness
        .worker
        .run_due(now() + chrono::Duration::seconds(1))
        .await
        .unwrap();
    let completed = harness.operation("delete-one").await;
    assert_eq!(completed.state, "succeeded");
    assert_eq!(completed.attempts, 2);
    assert_eq!(
        harness.pds.state.lock().await.calls,
        2,
        "no second remote delete"
    );
    assert!(
        harness
            .database
            .repositories()
            .scrobble(completed.record_uri.as_deref().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let outcomes = harness.boundary.outcomes.lock().await;
    assert!(matches!(&outcomes[2],WriteOutcome::Confirmed(row)
        if matches!(row.as_ref(),RecordMutation::Delete { uri, revision: confirmed_revision, .. }
            if Some(uri)==completed.record_uri.as_ref() && *confirmed_revision==revision)));
    drop(outcomes);
    harness.database.close().await;
}

#[tokio::test]
async fn unavailable_head_is_bounded_and_never_published() {
    let harness = Harness::new().await;
    harness
        .pds
        .state
        .lock()
        .await
        .head_faults
        .extend((0..10).map(|_| (0, HeadReply::Unavailable)));
    harness.create().await;
    let mut clock = now();
    for attempt in 1..=10 {
        assert_eq!(harness.worker.run_due(clock).await.unwrap(), 1);
        harness
            .assert_transient((attempt - 1) as usize, "current_head_unavailable")
            .await;
        let operation = harness.operation("operation-one").await;
        assert_eq!(operation.attempts, attempt);
        assert_eq!(
            operation.state,
            if attempt == 10 { "failed" } else { "pending" }
        );
        assert_eq!(
            harness
                .database
                .repositories()
                .public_counts(signed_repo::ALICE)
                .await
                .unwrap()
                .0,
            0
        );
        if attempt < 10 {
            let due = harness
                .database
                .repositories()
                .outbox_due("2026-01-16T12:00:00Z", 10)
                .await
                .unwrap()[0]
                .due_at
                .clone();
            clock = DateTime::parse_from_rfc3339(&due)
                .unwrap()
                .with_timezone(&Utc);
        }
    }
    assert_eq!(
        harness
            .operation("operation-one")
            .await
            .failure_code
            .as_deref(),
        Some("current_head_unavailable")
    );
    assert_eq!(
        harness
            .worker
            .run_due(clock + chrono::Duration::days(1))
            .await
            .unwrap(),
        0
    );
    let remote = harness.pds.state.lock().await;
    assert_eq!(remote.calls, 0);
    assert_eq!(remote.head_requests, 10);
    assert_eq!(remote.identity_requests, 10);
    assert_eq!(remote.records.len(), 1);
    drop(remote);
    harness.database.close().await;
}

#[tokio::test]
async fn unfollow_final_head_race_reconciles_without_redelete() {
    let harness = Harness::new().await;
    let subject = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    let create = atmusic_atproto::pds::follow::operation(
        signed_repo::ALICE,
        subject,
        &namespace(),
        now(),
        true,
        "follow-one".into(),
    )
    .unwrap();
    let uri = create.record_uri.clone().unwrap();
    harness
        .database
        .repositories()
        .admit_operation(create, Some("head-follow".into()))
        .await
        .unwrap();
    harness.worker.run_due(now()).await.unwrap();
    assert_eq!(harness.operation("follow-one").await.state, "succeeded");
    assert_eq!(
        harness
            .database
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .2,
        1
    );
    let deletion = atmusic_atproto::pds::follow::operation(
        signed_repo::ALICE,
        subject,
        &namespace(),
        now(),
        false,
        "unfollow-one".into(),
    )
    .unwrap();
    let admission = harness
        .database
        .repositories()
        .follow_intent(
            signed_repo::ALICE.into(),
            subject.into(),
            false,
            true,
            move || Ok(deletion),
        )
        .await
        .unwrap();
    assert!(matches!(
        admission,
        atmusic_storage::FollowIntent::Pending(_)
    ));
    {
        let mut remote = harness.pds.state.lock().await;
        // Verify the deleted target first, then race only the final whole-repo
        // snapshot proving no duplicate edge to the same subject remains.
        remote
            .head_faults
            .extend([(2, HeadReply::Stable), (2, HeadReply::Advance)]);
    }
    harness.worker.run_due(now()).await.unwrap();
    harness.assert_transient(1, "current_head_changed").await;
    assert_eq!(harness.operation("unfollow-one").await.state, "pending");
    assert_eq!(
        harness
            .database
            .repositories()
            .public_counts(signed_repo::ALICE)
            .await
            .unwrap()
            .2,
        0
    );
    assert_eq!(harness.pds.state.lock().await.calls, 2);
    harness
        .worker
        .run_due(now() + chrono::Duration::seconds(1))
        .await
        .unwrap();
    let completed = harness.operation("unfollow-one").await;
    assert_eq!(completed.state, "succeeded");
    assert_eq!(completed.attempts, 2);
    let remote = harness.pds.state.lock().await;
    assert_eq!(
        remote.calls, 2,
        "final head race must not repeat a committed delete"
    );
    assert!(
        !remote.records.contains_key(
            uri.strip_prefix(&format!("at://{}/", signed_repo::ALICE))
                .unwrap()
        )
    );
    let revision = remote.fixture.event.revision.clone();
    drop(remote);
    let outcomes = harness.boundary.outcomes.lock().await;
    assert!(matches!(&outcomes[2],WriteOutcome::Confirmed(row)
        if matches!(row.as_ref(),RecordMutation::DeleteMany { uris, revision: confirmed_revision, .. }
            if uris==&vec![uri] && *confirmed_revision==revision)));
    drop(outcomes);
    harness.database.close().await;
}

#[tokio::test]
async fn invalid_head_trust_remains_permanent() {
    for failure in [
        "missing_key",
        "malformed_witness",
        "same_revision_wrong_cid",
        "invalid_signature",
    ] {
        let harness = Harness::new().await;
        {
            let mut remote = harness.pds.state.lock().await;
            match failure {
                "missing_key" => remote.identity_without_key = true,
                "malformed_witness" => remote.head_faults.push_back((0, HeadReply::Malformed)),
                "same_revision_wrong_cid" => {
                    remote.head_faults.push_back((0, HeadReply::CidMismatch))
                }
                "invalid_signature" => {
                    let records = remote
                        .records
                        .iter()
                        .map(|(path, value)| (path.clone(), value.clone()))
                        .collect();
                    remote.fixture =
                        signed_repo::signed_repo_with_bad_signature(records, 7, true).await;
                }
                _ => unreachable!(),
            }
        }
        harness.create().await;
        harness.worker.run_due(now()).await.unwrap();
        let operation = harness.operation("operation-one").await;
        assert_eq!(operation.state, "failed", "{failure}");
        assert_eq!(operation.attempts, 1);
        assert_eq!(
            operation.failure_code.as_deref(),
            Some("repository_verification_failed"),
            "{failure}"
        );
        assert_eq!(harness.pds.state.lock().await.calls, 0, "{failure}");
        assert_eq!(
            harness
                .database
                .repositories()
                .public_counts(signed_repo::ALICE)
                .await
                .unwrap()
                .0,
            0
        );
        assert_eq!(
            harness
                .worker
                .run_due(now() + chrono::Duration::days(1))
                .await
                .unwrap(),
            0
        );
        harness.database.close().await;
    }
}
