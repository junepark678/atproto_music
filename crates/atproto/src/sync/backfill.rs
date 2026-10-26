//! Bounded durable repository recovery through complete signed sync snapshots.
use super::{
    apply::projection,
    verify::{SigningKeyResolver, VerificationError, verify_snapshot},
};
use crate::{
    http::safe_client::{FetchError, SafeClient},
    identity::{IdentityError, IdentityResolver},
};
use async_trait::async_trait;
use atmusic_core::namespace::Namespace;
use atmusic_storage::{
    BackfillJob, DiscoveryAdmission, Repository, RepositorySnapshot, SnapshotOutcome, StorageError,
};
use chrono::{DateTime, Utc};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use thiserror::Error;
use tokio::{sync::Mutex, task::JoinSet};

pub const MAX_ACTIVE_BACKFILLS: usize = 4;
pub const MAX_QUEUED_BACKFILLS: usize = 1024;
pub trait ReceiptClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}
#[derive(Clone, Debug)]
pub struct FetchedSnapshot {
    pub pds: String,
    pub bytes: Vec<u8>,
}
#[async_trait]
pub trait SnapshotSource: Send + Sync {
    /// Resolve the current authenticated DID document before fetching this PDS snapshot.
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError>;
}
pub struct PdsSnapshotSource {
    identity: IdentityResolver,
    client: SafeClient,
}
impl PdsSnapshotSource {
    pub fn new(identity: IdentityResolver, client: SafeClient) -> Self {
        Self { identity, client }
    }
}
#[async_trait]
impl SnapshotSource for PdsSnapshotSource {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        let pds = self.identity.document(did).await?.pds()?;
        let mut url = pds
            .join("xrpc/com.atproto.sync.getRepo")
            .map_err(|_| BackfillError::InvalidSnapshot)?;
        url.query_pairs_mut().append_pair("did", did);
        let response = self.client.repository(&url).await?;
        if response.headers.get("content-type").is_none_or(|v| {
            v.split(';')
                .next()
                .is_none_or(|mime| mime.trim() != "application/vnd.ipld.car")
        }) {
            return Err(BackfillError::InvalidSnapshot);
        }
        Ok(FetchedSnapshot {
            pds: pds.to_string(),
            bytes: response.body,
        })
    }
}
#[derive(Debug, Error)]
pub enum BackfillError {
    #[error("backfill_busy")]
    Busy,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Verification(#[from] VerificationError),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error("invalid_repository_snapshot")]
    InvalidSnapshot,
    #[error("account_inactive")]
    AccountInactive,
    #[error("repository_changed")]
    AccountChanged,
    #[error("backfill_worker_failed")]
    Worker,
}
impl BackfillError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy => "backfill_busy",
            Self::Verification(
                VerificationError::HeadChanged | VerificationError::IdentityChanged,
            ) => "repository_changed",
            Self::Verification(VerificationError::HeadUnavailable) => "repository_head_unavailable",
            Self::Verification(_) => "repository_verification_failed",
            Self::Storage(error) => error.code(),
            Self::Identity(_) => "identity_resolution_failed",
            Self::Fetch(_) => "repository_fetch_failed",
            Self::InvalidSnapshot => "invalid_repository_snapshot",
            Self::AccountInactive => "account_inactive",
            Self::AccountChanged => "repository_changed",
            Self::Worker => "backfill_worker_failed",
        }
    }
}
#[derive(Debug)]
pub struct BackfillResult {
    pub did: String,
    pub result: Result<SnapshotOutcome, BackfillError>,
}
pub struct BackfillCoordinator {
    repository: Repository,
    namespace: Namespace,
    source: Arc<dyn SnapshotSource>,
    resolver: Arc<dyn SigningKeyResolver>,
    clock: Arc<dyn ReceiptClock>,
    running: Mutex<()>,
    active: AtomicUsize,
}
struct ActiveJob(Arc<BackfillCoordinator>);
impl Drop for ActiveJob {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}
impl BackfillCoordinator {
    pub fn new(
        repository: Repository,
        namespace: Namespace,
        source: Arc<dyn SnapshotSource>,
        resolver: Arc<dyn SigningKeyResolver>,
        clock: Arc<dyn ReceiptClock>,
    ) -> Self {
        Self {
            repository,
            namespace,
            source,
            resolver,
            clock,
            running: Mutex::new(()),
            active: AtomicUsize::new(0),
        }
    }
    pub fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
    /// A matching stream operation is an admission hint, never authoritative repository data.
    /// New actors remain inactive until the account-checked, signed snapshot completes.
    pub async fn discover(&self, did: &str) -> Result<DiscoveryAdmission, BackfillError> {
        self.repository
            .discover_repository(did.into(), self.clock.now().to_rfc3339())
            .await
            .map_err(|error| match error {
                StorageError::ServiceBusy => BackfillError::Busy,
                error => BackfillError::Storage(error),
            })
    }
    pub async fn schedule(
        &self,
        did: &str,
        reactivate: bool,
    ) -> Result<Option<BackfillJob>, BackfillError> {
        self.repository
            .request_backfill(did.into(), reactivate, self.clock.now().to_rfc3339())
            .await
            .map_err(|e| {
                if matches!(e, StorageError::ServiceBusy) {
                    BackfillError::Busy
                } else {
                    BackfillError::Storage(e)
                }
            })
    }
    pub async fn schedule_known(&self) -> Result<usize, BackfillError> {
        let mut count = 0;
        for did in self.repository.known_repository_dids().await? {
            if self.schedule(&did, false).await?.is_some() {
                count += 1;
            }
        }
        Ok(count)
    }
    /// Resume fresh cursor recovery after restart/backpressure. Fresh completed coverage is
    /// retained; invalidated prior snapshots are admitted to the bounded queue as capacity frees.
    pub async fn schedule_cursor_recovery(&self) -> Result<usize, BackfillError> {
        let mut count = 0;
        for did in self.repository.known_repository_dids().await? {
            let job = self.repository.backfill(&did).await?;
            if job
                .as_ref()
                .is_none_or(|job| job.state == "complete" && !job.backfill_complete)
                && self.schedule(&did, false).await?.is_some()
            {
                count += 1;
            }
        }
        Ok(count)
    }
    /// One bounded batch. The runtime decides polling, retry cadence, and graceful shutdown.
    /// Running jobs are durable and can be retried following process restart.
    pub async fn run_batch(self: &Arc<Self>) -> Result<Vec<BackfillResult>, BackfillError> {
        let _guard = self.running.lock().await;
        let jobs = self
            .repository
            .backfill_jobs(MAX_ACTIVE_BACKFILLS as i64)
            .await?;
        let mut tasks = JoinSet::new();
        for job in jobs {
            if !self
                .repository
                .backfill_running(job.clone(), self.clock.now().to_rfc3339())
                .await?
            {
                continue;
            }
            let worker = self.clone();
            self.active.fetch_add(1, Ordering::AcqRel);
            let active = ActiveJob(worker.clone());
            tasks.spawn(async move {
                let _active = active;
                let result = worker.run_job(&job).await;
                if let Err(error) = &result {
                    let _ = worker
                        .repository
                        .backfill_failed(
                            job.clone(),
                            error.code().into(),
                            worker.clock.now().to_rfc3339(),
                        )
                        .await;
                }
                BackfillResult {
                    did: job.did,
                    result,
                }
            });
        }
        let mut results = Vec::new();
        while let Some(result) = tasks.join_next().await {
            results.push(result.map_err(|_| BackfillError::Worker)?);
        }
        Ok(results)
    }
    async fn run_job(&self, job: &BackfillJob) -> Result<SnapshotOutcome, BackfillError> {
        let fetched = self.source.fetch(&job.did).await?;
        let receipt = self.clock.now();
        let verified = verify_snapshot(
            &fetched.bytes,
            &job.did,
            &self.namespace,
            receipt,
            self.resolver.as_ref(),
        )
        .await?;
        let (mutations, _excluded) = projection(verified.verified_commit(), &receipt.to_rfc3339());
        Ok(self
            .repository
            .reconcile_snapshot(RepositorySnapshot {
                did: verified.did().into(),
                revision: verified.revision().into(),
                indexed_at: receipt.to_rfc3339(),
                pds: fetched.pds,
                generation: job.generation,
                mutations,
            })
            .await?)
    }
}
