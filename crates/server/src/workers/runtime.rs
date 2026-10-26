//! Owned worker tasks with cancellation and one caller-provided shutdown deadline.
//!
//! Start only with workers whose trust dependencies have been configured. Shutdown
//! this runtime before stopping writer admission, then drain HTTP and storage with
//! the same deadline. Dropping it aborts tasks; orderly shutdown also persists the
//! relay's disconnected recovery state.
use super::{outbox::OutboxWorker, relay::RelayWorker};
use crate::Clock;
use atmusic_atproto::sync::backfill::BackfillCoordinator;
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::watch,
    task::JoinSet,
    time::{Instant, sleep, timeout_at},
};

#[derive(Default)]
pub struct WorkerSet {
    pub outbox: Option<Arc<OutboxWorker>>,
    pub backfills: Option<Arc<BackfillCoordinator>>,
    pub relay: Option<Arc<RelayWorker>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerKind {
    Outbox,
    Backfill,
    Relay,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ShutdownReport {
    pub timed_out: bool,
    pub unfinished: usize,
    pub cleanup_failed: Vec<WorkerKind>,
    pub task_failed: usize,
}

/// Owns every spawned worker; no task remains detached when the owner is dropped.
pub struct WorkerRuntime {
    stop: watch::Sender<bool>,
    tasks: JoinSet<Result<(), WorkerKind>>,
}

impl WorkerRuntime {
    /// Polling covers durable work admitted before startup or missed notifications.
    /// A zero interval is rejected to prevent a busy loop on an empty queue.
    pub fn start(
        workers: WorkerSet,
        clock: Arc<dyn Clock>,
        poll_interval: Duration,
    ) -> Result<Self, &'static str> {
        if poll_interval.is_zero() {
            return Err("worker polling interval must be positive");
        }
        let (stop, _) = watch::channel(false);
        let mut tasks = JoinSet::new();
        if let Some(worker) = workers.outbox {
            let mut stopped = stop.subscribe();
            tasks.spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => return Ok(()),
                        result = worker.run_due(clock.now()) => {
                            if result.is_err() {
                                tracing::warn!(worker = "outbox", "worker batch failed; durable work retained");
                            }
                        }
                    }
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => return Ok(()),
                        () = worker.wait_for_notification() => {},
                        () = sleep(poll_interval) => {},
                    }
                }
            });
        }
        if let Some(worker) = workers.backfills {
            let mut stopped = stop.subscribe();
            tasks.spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => break,
                        result = worker.run_batch() => {
                            if result.is_err() {
                                tracing::warn!(worker = "backfill", "worker batch failed; durable work retained");
                            }
                        }
                    }
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => break,
                        () = sleep(poll_interval) => {},
                    }
                }
                // Dropping run_batch aborts its JoinSet. Await the task guards so
                // orderly shutdown does not report completion before child drops.
                while worker.active() != 0 {
                    tokio::task::yield_now().await;
                }
                Ok(())
            });
        }
        if let Some(worker) = workers.relay {
            let mut stopped = stop.subscribe();
            tasks.spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => break,
                        result = worker.run_session() => {
                            if result.is_err() {
                                tracing::warn!(worker = "relay", "relay session failed; reconnect scheduled");
                            }
                        }
                    }
                    tokio::select! {
                        biased;
                        () = cancelled(&mut stopped) => break,
                        _ = worker.wait_to_reconnect() => {},
                    }
                }
                // The cancelled session and its connection have been dropped before
                // this write. Keep admission open until this cleanup has completed.
                worker.mark_disconnected().await.map_err(|_| WorkerKind::Relay)
            });
        }
        Ok(Self { stop, tasks })
    }

    pub fn cancel(&self) {
        self.stop.send_replace(true);
    }

    /// Cancel active boundary calls, retain durable queue state, and await cleanup.
    /// All workers share this absolute deadline; it is never restarted per task.
    pub async fn shutdown_until(mut self, deadline: Instant) -> ShutdownReport {
        self.cancel();
        let mut report = ShutdownReport::default();
        while !self.tasks.is_empty() {
            match timeout_at(deadline, self.tasks.join_next()).await {
                Ok(Some(Ok(Ok(())))) => {}
                Ok(Some(Ok(Err(worker)))) => report.cleanup_failed.push(worker),
                Ok(Some(Err(_))) => report.task_failed += 1,
                Ok(None) => break,
                Err(_) => {
                    report.timed_out = true;
                    report.unfinished = self.tasks.len();
                    self.tasks.abort_all();
                    break;
                }
            }
        }
        report
    }
}

impl Drop for WorkerRuntime {
    fn drop(&mut self) {
        self.cancel();
        self.tasks.abort_all();
    }
}

async fn cancelled(stopped: &mut watch::Receiver<bool>) {
    while !*stopped.borrow_and_update() {
        if stopped.changed().await.is_err() {
            return;
        }
    }
}
