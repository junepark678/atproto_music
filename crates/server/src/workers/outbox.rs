//! Persist attempt counters and retry schedules around a single serialized outbox worker.
use atmusic_atproto::pds::write::{
    Jitter, PdsWriteBoundary, RandomJitter, WriteOutcome, retry_delay,
};
use atmusic_storage::{Repository, StorageError};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

pub struct OutboxWorker {
    repository: Repository,
    boundary: Arc<dyn PdsWriteBoundary>,
    jitter: Arc<dyn Jitter>,
    running: Mutex<()>,
    wake: Notify,
}
impl OutboxWorker {
    pub fn new(repository: Repository, boundary: Arc<dyn PdsWriteBoundary>) -> Self {
        Self {
            repository,
            boundary,
            jitter: Arc::new(RandomJitter),
            running: Mutex::new(()),
            wake: Notify::new(),
        }
    }
    pub fn with_jitter(mut self, jitter: Arc<dyn Jitter>) -> Self {
        self.jitter = jitter;
        self
    }
    pub fn notify(&self) {
        self.wake.notify_one();
    }
    /// Run one bounded due batch at injected time. The runtime owns polling/shutdown.
    pub async fn run_due(&self, now: DateTime<Utc>) -> Result<usize, StorageError> {
        let _guard = self.running.lock().await;
        let items = self.repository.outbox_due(&now.to_rfc3339(), 32).await?;
        let count = items.len();
        for item in items {
            let outcome = if item.attempts >= 10 {
                self.boundary.reconcile(&item, now).await
            } else {
                if !self
                    .repository
                    .begin_attempt(item.operation_id.clone(), now.to_rfc3339())
                    .await?
                {
                    continue;
                }
                self.boundary.execute(&item, now).await
            };
            match outcome {
                WriteOutcome::Confirmed(record) => {
                    self.repository
                        .finish_operation(item.operation_id, now.to_rfc3339(), None, Some(*record))
                        .await?
                }
                WriteOutcome::Permanent { failure_code } => {
                    self.repository
                        .finish_operation(
                            item.operation_id,
                            now.to_rfc3339(),
                            Some(failure_code.into()),
                            None,
                        )
                        .await?
                }
                WriteOutcome::Transient {
                    failure_code,
                    retry_after,
                } => {
                    let attempts = item.attempts + 1;
                    if attempts >= 10 {
                        self.repository
                            .finish_operation(
                                item.operation_id,
                                now.to_rfc3339(),
                                Some(failure_code.into()),
                                None,
                            )
                            .await?;
                    } else {
                        let delay = chrono::Duration::from_std(retry_delay(
                            attempts,
                            retry_after,
                            self.jitter.as_ref(),
                        ))
                        .map_err(|_| StorageError::Invariant("retry duration overflow"))?;
                        self.repository
                            .retry_operation(
                                item.operation_id,
                                now.to_rfc3339(),
                                (now + delay).to_rfc3339(),
                            )
                            .await?;
                    }
                }
            }
        }
        Ok(count)
    }
    pub async fn wait_for_notification(&self) {
        self.wake.notified().await;
    }
}
