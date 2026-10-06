#[path = "support/federation.rs"]
mod federation;
use federation::signed_repo;
#[path = "../../atproto/tests/support/write_pds.rs"]
mod write_pds;

use async_trait::async_trait;
use atmusic_atproto::sync::{
    backfill::{BackfillCoordinator, BackfillError, FetchedSnapshot, ReceiptClock, SnapshotSource},
    stream::{ReconnectClock, RelayConnection, RelayTransport, StreamError},
};
use atmusic_server::{
    Clock,
    workers::{
        outbox::OutboxWorker,
        relay::{RelayDependencies, RelayWorker},
        runtime::{ShutdownReport, WorkerRuntime, WorkerSet},
    },
};
use atmusic_storage::{Database, User};
use federation::{ALICE, Harness, RELAY};
use std::{
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::Notify,
    time::{Instant, timeout},
};
use url::Url;

async fn until<F, Fut>(mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    timeout(Duration::from_secs(5), async {
        while !condition().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("worker progress deadline");
}
fn start(workers: WorkerSet) -> WorkerRuntime {
    WorkerRuntime::start(
        workers,
        Arc::new(federation::Clock),
        Duration::from_secs(60),
    )
    .unwrap()
}
async fn stop(runtime: WorkerRuntime) {
    assert_eq!(
        runtime
            .shutdown_until(Instant::now() + Duration::from_secs(3))
            .await,
        ShutdownReport::default()
    );
}

async fn admit_during_batch(notify: bool) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("poll.sqlite"))
        .await
        .unwrap();
    db.repositories()
        .upsert_user(User::new(ALICE, write_pds::NOW))
        .await
        .unwrap();
    let pause = Arc::new(write_pds::Pause::default());
    let pds = write_pds::WritePds::new(
        &db,
        vec![write_pds::Reply::PauseAfterCommit(pause.clone())],
        None,
    )
    .await;
    db.repositories()
        .admit_operation(write_pds::operation(), None)
        .await
        .unwrap();
    let worker = Arc::new(OutboxWorker::new(db.repositories(), pds.client.clone()));
    let runtime = WorkerRuntime::start(
        WorkerSet {
            outbox: Some(worker.clone()),
            ..Default::default()
        },
        Arc::new(federation::Clock),
        if notify {
            Duration::from_secs(60)
        } else {
            Duration::from_millis(20)
        },
    )
    .unwrap();
    timeout(Duration::from_secs(5), pause.committed.notified())
        .await
        .unwrap();
    // The first batch's query has finished: this record cannot enter that batch.
    let mut second = write_pds::operation();
    second.operation_id = "operation-two".into();
    second.rkey = "3m4zm2ufr2223".into();
    second.record_uri = Some(format!(
        "at://{ALICE}/{}/{}",
        second.collection, second.rkey
    ));
    db.repositories()
        .admit_operation(second, None)
        .await
        .unwrap();
    if notify {
        worker.notify();
    }
    pause.release.notify_one();
    until(|| async {
        db.repositories()
            .operation(ALICE, "operation-two")
            .await
            .unwrap()
            .unwrap()
            .state
            == "succeeded"
    })
    .await;
    stop(runtime).await;
    assert_eq!(pds.state.lock().await.calls, 2);
    assert_eq!(db.repositories().public_counts(ALICE).await.unwrap().0, 2);
    db.close().await;
}

#[tokio::test]
async fn notification_during_a_batch_is_retained_until_the_next_batch() {
    admit_during_batch(true).await;
}

#[tokio::test]
async fn periodic_poll_discovers_work_without_a_notification() {
    admit_during_batch(false).await;
}

#[tokio::test]
async fn notified_outbox_cancel_after_remote_commit_recovers_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite");
    let db = Database::open(&path).await.unwrap();
    db.repositories()
        .upsert_user(User::new(ALICE, write_pds::NOW))
        .await
        .unwrap();
    let pause = Arc::new(write_pds::Pause::default());
    let pds = write_pds::WritePds::new(
        &db,
        vec![write_pds::Reply::PauseAfterCommit(pause.clone())],
        None,
    )
    .await;
    let worker = Arc::new(OutboxWorker::new(db.repositories(), pds.client.clone()));
    let runtime = start(WorkerSet {
        outbox: Some(worker.clone()),
        ..Default::default()
    });
    // Admit after startup. A notification must wake the 60-second polling wait.
    tokio::task::yield_now().await;
    db.repositories()
        .admit_operation(write_pds::operation(), Some("once".into()))
        .await
        .unwrap();
    worker.notify();
    timeout(Duration::from_secs(5), pause.committed.notified())
        .await
        .unwrap();
    stop(runtime).await;
    let operation = db
        .repositories()
        .operation(ALICE, "operation-one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (operation.state.as_str(), operation.attempts),
        ("pending", 1)
    );
    assert_eq!(db.repositories().public_counts(ALICE).await.unwrap().0, 0);
    assert_eq!(pds.state.lock().await.calls, 1);
    pause.release.notify_one();
    db.close().await;

    let reopened = Database::open(&path).await.unwrap();
    let client = pds.rebuild_for(&reopened).await;
    // No notification: startup polling must discover the durable pending operation.
    let runtime = start(WorkerSet {
        outbox: Some(Arc::new(OutboxWorker::new(reopened.repositories(), client))),
        ..Default::default()
    });
    until(|| async {
        reopened
            .repositories()
            .operation(ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap()
            .state
            == "succeeded"
    })
    .await;
    stop(runtime).await;
    assert_eq!(
        pds.state.lock().await.calls,
        1,
        "signed reconciliation avoids a duplicate create"
    );
    assert_eq!(
        reopened
            .repositories()
            .public_counts(ALICE)
            .await
            .unwrap()
            .0,
        1
    );
    assert_eq!(
        reopened
            .repositories()
            .operation(ALICE, "operation-one")
            .await
            .unwrap()
            .unwrap()
            .attempts,
        2
    );
    reopened.close().await;
}

struct HeldSnapshot {
    source: Arc<dyn SnapshotSource>,
    fetched: Notify,
}
#[async_trait]
impl SnapshotSource for HeldSnapshot {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        let result = self.source.fetch(did).await?;
        self.fetched.notify_one();
        std::future::pending::<()>().await;
        Ok(result)
    }
}

#[tokio::test]
async fn cancelled_backfill_releases_owned_tasks_and_retries_durable_job() {
    let h = Harness::new().await;
    h.alice
        .create(
            federation::SCROBBLE,
            "3m4zm2ufr2222",
            federation::record("Björk", "Jóga"),
        )
        .await;
    let held = Arc::new(HeldSnapshot {
        source: h.source.clone(),
        fetched: Notify::new(),
    });
    let backfills = Arc::new(BackfillCoordinator::new(
        h.db.repositories(),
        federation::namespace(),
        held.clone(),
        h.keys.clone(),
        Arc::new(federation::Clock),
    ));
    backfills.schedule(ALICE, false).await.unwrap();
    let runtime = start(WorkerSet {
        backfills: Some(backfills.clone()),
        ..Default::default()
    });
    timeout(Duration::from_secs(5), held.fetched.notified())
        .await
        .unwrap();
    assert_eq!(backfills.active(), 1);
    stop(runtime).await;
    assert_eq!(
        backfills.active(),
        0,
        "shutdown awaits aborted child task drops"
    );
    let job = h.db.repositories().backfill(ALICE).await.unwrap().unwrap();
    assert_eq!(job.state, "running");
    assert!(!job.backfill_complete);
    assert_eq!(h.db.repositories().public_counts(ALICE).await.unwrap().0, 0);

    let runtime = start(WorkerSet {
        backfills: Some(h.backfills.clone()),
        ..Default::default()
    });
    until(|| async {
        h.db.repositories()
            .backfill(ALICE)
            .await
            .unwrap()
            .unwrap()
            .backfill_complete
    })
    .await;
    stop(runtime).await;
    federation::assert_exact(&h.db, &[&h.alice, &h.carol], h.keys.as_ref()).await;
    h.close().await;
}

struct HeldRelay {
    source: Arc<dyn RelayTransport>,
    waiting: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}
struct HeldConnection {
    source: Box<dyn RelayConnection>,
    waiting: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}
impl Drop for HeldConnection {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
#[async_trait]
impl RelayConnection for HeldConnection {
    async fn receive(&mut self) -> Result<Option<Vec<u8>>, StreamError> {
        match self.source.receive().await? {
            Some(frame) => Ok(Some(frame)),
            None => {
                self.waiting.notify_one();
                std::future::pending().await
            }
        }
    }
}
#[async_trait]
impl RelayTransport for HeldRelay {
    async fn connect(
        &self,
        url: &Url,
        max: usize,
    ) -> Result<Box<dyn RelayConnection>, StreamError> {
        Ok(Box::new(HeldConnection {
            source: self.source.connect(url, max).await?,
            waiting: self.waiting.clone(),
            dropped: self.dropped.clone(),
        }))
    }
}
fn held_relay(h: &Harness) -> Arc<HeldRelay> {
    Arc::new(HeldRelay {
        source: h.relay.clone(),
        waiting: Arc::new(Notify::new()),
        dropped: Arc::new(AtomicBool::new(false)),
    })
}
fn relay_worker(
    h: &Harness,
    transport: Arc<dyn RelayTransport>,
    clock: Arc<dyn ReconnectClock>,
) -> Arc<RelayWorker> {
    Arc::new(RelayWorker::new(
        h.db.repositories(),
        RELAY.into(),
        federation::namespace(),
        RelayDependencies {
            transport,
            resolver: h.keys.clone(),
            clock,
            backfills: h.backfills.clone(),
        },
    ))
}

#[tokio::test]
async fn relay_cancellation_drops_connection_marks_gap_and_resumes_exact_checkpoint() {
    let h = Harness::new().await;
    h.alice
        .create(
            federation::SCROBBLE,
            "3m4zm2ufr2222",
            federation::record("Björk", "Jóga"),
        )
        .await;
    let transport = held_relay(&h);
    let runtime = start(WorkerSet {
        relay: Some(relay_worker(
            &h,
            transport.clone(),
            Arc::new(federation::Clock),
        )),
        ..Default::default()
    });
    timeout(Duration::from_secs(5), transport.waiting.notified())
        .await
        .unwrap();
    let checkpoint =
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap();
    let before =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(before.connected);
    assert!(before.last_event_at.is_some());
    stop(runtime).await;
    assert!(transport.dropped.load(Ordering::SeqCst));
    let after =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(!after.connected);
    assert!(after.pending_gap);
    assert_eq!(after.reason.as_deref(), Some("worker_stopped"));
    assert_eq!(after.last_event_at, before.last_event_at);
    assert_eq!(after.prior_sequence, before.prior_sequence);
    assert_eq!(
        h.db.repositories()
            .checkpoint(RELAY)
            .await
            .unwrap()
            .unwrap()
            .sequence,
        checkpoint.sequence
    );
    federation::assert_exact(&h.db, &[&h.alice, &h.carol], h.keys.as_ref()).await;

    let resumed = held_relay(&h);
    let runtime = start(WorkerSet {
        relay: Some(relay_worker(
            &h,
            resumed.clone(),
            Arc::new(federation::Clock),
        )),
        ..Default::default()
    });
    timeout(Duration::from_secs(5), resumed.waiting.notified())
        .await
        .unwrap();
    let requests = h.relay.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]
            .query_pairs()
            .find(|(key, _)| key == "cursor")
            .unwrap()
            .1,
        checkpoint.sequence.to_string()
    );
    assert!(
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .pending_gap
    );
    stop(runtime).await;
    h.close().await;
}

#[derive(Default)]
struct BackoffClock {
    waits: Mutex<Vec<Duration>>,
    waiting: Notify,
}
impl ReceiptClock for BackoffClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        federation::now()
    }
}
#[async_trait]
impl ReconnectClock for BackoffClock {
    async fn sleep(&self, duration: Duration) {
        self.waits.lock().unwrap().push(duration);
        self.waiting.notify_one();
        std::future::pending::<()>().await;
    }
}

#[tokio::test]
async fn reconnect_wait_is_bounded_and_cancellable_without_spinning() {
    let h = Harness::new().await;
    let clock = Arc::new(BackoffClock::default());
    let runtime = start(WorkerSet {
        relay: Some(relay_worker(&h, h.relay.clone(), clock.clone())),
        ..Default::default()
    });
    timeout(Duration::from_secs(5), clock.waiting.notified())
        .await
        .unwrap();
    let waits = clock.waits.lock().unwrap().clone();
    assert_eq!(waits.len(), 1);
    assert!((Duration::from_secs(1)..=Duration::from_secs(60)).contains(&waits[0]));
    assert_eq!(h.relay.requests.lock().unwrap().len(), 1);
    stop(runtime).await;
    assert!(
        !h.db
            .repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap()
            .connected
    );
    h.close().await;
}

#[tokio::test]
async fn one_shutdown_deadline_reports_blocked_cleanup_and_keeps_admitted_write() {
    let h = Harness::new().await;
    let transport = held_relay(&h);
    let runtime = start(WorkerSet {
        relay: Some(relay_worker(
            &h,
            transport.clone(),
            Arc::new(federation::Clock),
        )),
        backfills: Some(h.backfills.clone()),
        ..Default::default()
    });
    timeout(Duration::from_secs(5), transport.waiting.notified())
        .await
        .unwrap();
    let release = Arc::new(Notify::new());
    let entered = Arc::new(Notify::new());
    let pending =
        h.db.writer()
            .enqueue({
                let release = release.clone();
                let entered = entered.clone();
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
    let shutdown =
        tokio::spawn(runtime.shutdown_until(Instant::now() + Duration::from_millis(150)));
    until(|| async { h.db.writer().unfinished() == 2 }).await;
    let report = timeout(Duration::from_secs(1), shutdown)
        .await
        .unwrap()
        .unwrap();
    assert!(report.timed_out);
    assert_eq!(report.unfinished, 1);
    assert!(report.cleanup_failed.is_empty());
    assert!(transport.dropped.load(Ordering::SeqCst));
    release.notify_one();
    pending.wait().await.unwrap();
    h.db.writer().drain().await;
    // Cancellation dropped the acknowledgement future, not the already admitted transaction.
    let status =
        h.db.repositories()
            .relay_recovery(RELAY)
            .await
            .unwrap()
            .unwrap();
    assert!(!status.connected);
    assert!(status.pending_gap);
    h.close().await;
}

#[tokio::test]
async fn zero_poll_interval_is_rejected() {
    assert!(
        WorkerRuntime::start(
            WorkerSet::default(),
            Arc::new(federation::Clock) as Arc<dyn Clock>,
            Duration::ZERO
        )
        .is_err()
    );
}
