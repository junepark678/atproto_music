//! Verified relay sessions and durable recovery; default startup does not enable this worker.
use atmusic_atproto::sync::{
    accounts::AccountReconciler,
    apply::{ApplyContext, apply_commit},
    backfill::BackfillCoordinator,
    frames::{MAX_FRAME_BYTES, RelayEvent, decode_frame},
    stream::{
        RandomReconnectJitter, ReconnectClock, ReconnectJitter, RelayTransport, bounded_receive,
        reconnect_delay, subscription_url,
    },
    verify::SigningKeyResolver,
};
use atmusic_core::namespace::Namespace;
use atmusic_storage::{DiscoveryAdmission, RelayRecovery, Repository, StorageError};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;

pub trait RelayObserver: Send + Sync {
    fn verification_rejected(&self, reason: &str);
}
pub struct NoopRelayObserver;
impl RelayObserver for NoopRelayObserver {
    fn verification_rejected(&self, _: &str) {}
}
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SessionOutcome {
    pub applied: usize,
    pub replayed: usize,
    pub recovery_requested: bool,
}
#[derive(Debug)]
pub enum RelayWorkerError {
    Storage(StorageError),
    Protocol(String),
}
impl From<StorageError> for RelayWorkerError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

pub struct RelayWorker {
    repository: Repository,
    relay: String,
    namespace: Namespace,
    transport: Arc<dyn RelayTransport>,
    resolver: Arc<dyn SigningKeyResolver>,
    clock: Arc<dyn ReconnectClock>,
    backfills: Arc<BackfillCoordinator>,
    accounts: Option<Arc<AccountReconciler>>,
    jitter: Arc<dyn ReconnectJitter>,
    observer: Arc<dyn RelayObserver>,
    running: Mutex<()>,
    attempt: AtomicU32,
}
pub struct RelayDependencies {
    pub transport: Arc<dyn RelayTransport>,
    pub resolver: Arc<dyn SigningKeyResolver>,
    pub clock: Arc<dyn ReconnectClock>,
    pub backfills: Arc<BackfillCoordinator>,
}
impl RelayWorker {
    pub fn new(
        repository: Repository,
        relay: String,
        namespace: Namespace,
        dependencies: RelayDependencies,
    ) -> Self {
        Self {
            repository,
            relay,
            namespace,
            transport: dependencies.transport,
            resolver: dependencies.resolver,
            clock: dependencies.clock,
            backfills: dependencies.backfills,
            accounts: None,
            jitter: Arc::new(RandomReconnectJitter),
            observer: Arc::new(NoopRelayObserver),
            running: Mutex::new(()),
            attempt: AtomicU32::new(0),
        }
    }
    pub fn with_jitter(mut self, jitter: Arc<dyn ReconnectJitter>) -> Self {
        self.jitter = jitter;
        self
    }
    pub fn with_observer(mut self, observer: Arc<dyn RelayObserver>) -> Self {
        self.observer = observer;
        self
    }
    pub fn with_accounts(mut self, accounts: Arc<AccountReconciler>) -> Self {
        self.accounts = Some(accounts);
        self
    }
    async fn recovery(&self, reason: &str, connected: bool) -> Result<(), RelayWorkerError> {
        let old = self.repository.relay_recovery(&self.relay).await?;
        self.repository
            .set_relay_recovery(RelayRecovery {
                relay: self.relay.clone(),
                pending_gap: true,
                connected,
                prior_sequence: old.as_ref().and_then(|v| v.prior_sequence),
                last_event_at: old.and_then(|v| v.last_event_at),
                reason: Some(reason.into()),
                updated_at: self.clock.now().to_rfc3339(),
            })
            .await?;
        Ok(())
    }
    /// Persist interruption after the runtime drops a cancelled connection.
    pub async fn mark_disconnected(&self) -> Result<(), RelayWorkerError> {
        self.recovery("worker_stopped", false).await
    }
    async fn discover_hint(&self, did: &str) -> Result<bool, RelayWorkerError> {
        match self.backfills.discover(did).await {
            Ok(DiscoveryAdmission::Queued(_)) => {
                self.recovery("repository_discovery_pending", true).await?;
                Ok(true)
            }
            Ok(DiscoveryAdmission::Known | DiscoveryAdmission::Suppressed) => Ok(false),
            Err(error) => {
                self.recovery("repository_discovery_failed", false).await?;
                Err(RelayWorkerError::Protocol(error.to_string()))
            }
        }
    }
    /// Connect with the durable checkpoint, decode bounded frames, and apply verified mutations.
    /// Runtime must await `wait_to_reconnect` after every session/error before retrying.
    pub async fn run_session(&self) -> Result<SessionOutcome, RelayWorkerError> {
        let _guard = self.running.lock().await;
        if self
            .repository
            .relay_recovery(&self.relay)
            .await?
            .as_ref()
            .and_then(|v| v.reason.as_deref())
            .is_some_and(|reason| matches!(reason, "FutureCursor" | "OutdatedCursor"))
        {
            self.backfills
                .schedule_cursor_recovery()
                .await
                .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
            if !self
                .repository
                .prepare_relay_resume(self.relay.clone(), self.clock.now().to_rfc3339())
                .await?
            {
                return Err(RelayWorkerError::Protocol("relay_recovery_pending".into()));
            }
        }
        let checkpoint = self.repository.checkpoint(&self.relay).await?;
        let url = subscription_url(&self.relay, checkpoint.as_ref().map(|v| v.sequence))
            .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
        let mut connection = match self.transport.connect(&url, MAX_FRAME_BYTES).await {
            Ok(connection) => connection,
            Err(error) => {
                self.recovery("relay_disconnected", false).await?;
                return Err(RelayWorkerError::Protocol(error.to_string()));
            }
        };
        let previous = self.repository.relay_recovery(&self.relay).await?;
        self.repository
            .set_relay_recovery(RelayRecovery {
                relay: self.relay.clone(),
                pending_gap: previous.as_ref().is_none_or(|v| v.pending_gap),
                connected: true,
                prior_sequence: previous.as_ref().and_then(|v| v.prior_sequence),
                last_event_at: previous.and_then(|v| v.last_event_at),
                reason: None,
                updated_at: self.clock.now().to_rfc3339(),
            })
            .await?;
        let mut outcome = SessionOutcome::default();
        loop {
            let frame = match bounded_receive(connection.as_mut()).await {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    self.recovery("relay_disconnected", false).await?;
                    return Ok(outcome);
                }
                Err(error) => {
                    self.recovery("relay_disconnected", false).await?;
                    return Err(RelayWorkerError::Protocol(error.to_string()));
                }
            };
            let event = match decode_frame(&frame, &self.namespace) {
                Ok(event) => event,
                Err(error) => {
                    self.recovery("invalid_relay_frame", false).await?;
                    return Err(RelayWorkerError::Protocol(error.to_string()));
                }
            };
            match event {
                RelayEvent::Commit(event) => {
                    let user = self.repository.user(&event.did).await?;
                    if user.is_none() {
                        // Only configured music operations justify bounded discovery. The frame
                        // is an untrusted hint: neither its records nor sequence are admitted.
                        if !event.operations.is_empty() {
                            outcome.recovery_requested |= self.discover_hint(&event.did).await?;
                        }
                        continue;
                    }
                    // A duplicate hint must not publish provisional records or reactivate an
                    // inactive account. Activation belongs to authenticated snapshot recovery.
                    if user.as_ref().is_some_and(|user| !user.active) {
                        continue;
                    }
                    let gap = user.and_then(|v| v.revision).is_some_and(|revision| {
                        event.revision > revision
                            && event.since.as_deref() != Some(revision.as_str())
                    });
                    if gap {
                        self.recovery("repository_revision_gap", true).await?;
                        self.backfills
                            .schedule(&event.did, false)
                            .await
                            .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
                        outcome.recovery_requested = true;
                    }
                    match apply_commit(
                        &self.repository,
                        &event,
                        ApplyContext {
                            relay: &self.relay,
                            expected_did: &event.did,
                            namespace: &self.namespace,
                            receipt_time: self.clock.now(),
                            resolver: self.resolver.as_ref(),
                        },
                    )
                    .await
                    {
                        Ok(result) => {
                            if result.applied {
                                outcome.applied += 1;
                                for excluded in result.excluded {
                                    self.observer.verification_rejected(excluded.error.code);
                                }
                            } else {
                                outcome.replayed += 1;
                            }
                        }
                        Err(error) => {
                            if let atmusic_atproto::sync::apply::ApplyError::Verification(reason) =
                                &error
                            {
                                self.observer.verification_rejected(&reason.to_string());
                            }
                            self.recovery("repository_verification_failed", false)
                                .await?;
                            self.backfills
                                .schedule(&event.did, false)
                                .await
                                .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
                            return Err(RelayWorkerError::Protocol(error.to_string()));
                        }
                    }
                    // A verified event proves freshness for its repository; it does not clear a
                    // prior relay gap or mark all known repositories/backfills complete.
                    let mut status = self
                        .repository
                        .relay_recovery(&self.relay)
                        .await?
                        .expect("connected recovery row");
                    status.last_event_at = Some(event.time);
                    status.updated_at = self.clock.now().to_rfc3339();
                    self.repository.set_relay_recovery(status).await?;
                    self.attempt.store(0, Ordering::Release);
                }
                RelayEvent::StreamError { code } => {
                    if matches!(code.as_str(), "FutureCursor" | "OutdatedCursor") {
                        self.repository
                            .reject_relay_cursor(
                                self.relay.clone(),
                                code.clone(),
                                self.clock.now().to_rfc3339(),
                            )
                            .await?;
                        self.backfills
                            .schedule_cursor_recovery()
                            .await
                            .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
                        outcome.recovery_requested = true;
                        return Ok(outcome);
                    }
                    self.recovery(&code, false).await?;
                    return Err(RelayWorkerError::Protocol(code));
                }
                RelayEvent::Backfill {
                    did,
                    matching_music_operations,
                    ..
                } => {
                    let user = self.repository.user(&did).await?;
                    if user.is_none() {
                        if matching_music_operations {
                            outcome.recovery_requested |= self.discover_hint(&did).await?;
                        }
                        continue;
                    }
                    if user.as_ref().is_some_and(|user| !user.active) {
                        continue;
                    }
                    self.recovery("repository_backfill_required", true).await?;
                    self.backfills
                        .schedule(&did, false)
                        .await
                        .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
                    outcome.recovery_requested = true;
                }
                RelayEvent::Account { did, .. } | RelayEvent::Identity { did, .. } => {
                    self.recovery("identity_account_reconciliation", true)
                        .await?;
                    let Some(accounts) = &self.accounts else {
                        return Err(RelayWorkerError::Protocol(
                            "account_verifier_unavailable".into(),
                        ));
                    };
                    accounts
                        .reconcile(&did, &self.clock.now().to_rfc3339())
                        .await
                        .map_err(|e| RelayWorkerError::Protocol(e.to_string()))?;
                    outcome.recovery_requested = true;
                }
                RelayEvent::Ignored { .. } => {}
            }
        }
    }
    pub async fn wait_to_reconnect(&self) -> Duration {
        let attempt = self.attempt.fetch_add(1, Ordering::AcqRel);
        let delay = reconnect_delay(attempt, self.jitter.as_ref());
        self.clock.sleep(delay).await;
        delay
    }
}
