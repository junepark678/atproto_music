//! Relay account/identity hints trigger current DID/PDS resolution, never supplied event keys.
use super::backfill::{BackfillCoordinator, BackfillError};
use crate::{http::safe_client::SafeClient, identity::IdentityResolver};
use async_trait::async_trait;
use atmusic_storage::Repository;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct AccountStatus {
    pub did: String,
    pub pds: String,
    pub active: bool,
}
#[async_trait]
pub trait AccountSource: Send + Sync {
    async fn current(&self, did: &str) -> Result<AccountStatus, BackfillError>;
}
pub struct PdsAccountSource {
    identity: IdentityResolver,
    client: SafeClient,
}
impl PdsAccountSource {
    pub fn new(identity: IdentityResolver, client: SafeClient) -> Self {
        Self { identity, client }
    }
}
#[derive(Deserialize)]
struct WireStatus {
    did: String,
    active: bool,
}
#[async_trait]
impl AccountSource for PdsAccountSource {
    async fn current(&self, did: &str) -> Result<AccountStatus, BackfillError> {
        let pds = self.identity.document(did).await?.pds()?;
        let mut url = pds
            .join("xrpc/com.atproto.sync.getRepoStatus")
            .map_err(|_| BackfillError::InvalidSnapshot)?;
        url.query_pairs_mut().append_pair("did", did);
        let value: WireStatus = serde_json::from_slice(&self.client.metadata(&url).await?)
            .map_err(|_| BackfillError::InvalidSnapshot)?;
        if value.did != did {
            return Err(BackfillError::InvalidSnapshot);
        }
        Ok(AccountStatus {
            did: did.into(),
            pds: pds.to_string(),
            active: value.active,
        })
    }
}
pub struct AccountReconciler {
    repository: Repository,
    source: Arc<dyn AccountSource>,
    backfills: Arc<BackfillCoordinator>,
}
impl AccountReconciler {
    pub fn new(
        repository: Repository,
        source: Arc<dyn AccountSource>,
        backfills: Arc<BackfillCoordinator>,
    ) -> Self {
        Self {
            repository,
            source,
            backfills,
        }
    }
    /// Both identity migration and account events are hints; current verified PDS status wins.
    /// Reactivation remains invisible until a fresh signed complete snapshot commits.
    pub async fn reconcile(&self, did: &str, now: &str) -> Result<(), BackfillError> {
        if self.repository.user(did).await?.is_none() {
            return Ok(());
        }
        let job = match self.repository.backfill(did).await? {
            Some(job) => job,
            None => match self.backfills.schedule(did, false).await? {
                Some(job) => job,
                None => return Ok(()),
            },
        };
        let status = self.source.current(did).await?;
        if status.did != did {
            return Err(BackfillError::InvalidSnapshot);
        }
        if status.active {
            if self
                .repository
                .request_backfill_generation(
                    did.into(),
                    job.generation,
                    self.repository.active_user(did).await?.is_none(),
                    now.into(),
                )
                .await?
                .is_none()
            {
                return Err(BackfillError::AccountChanged);
            }
        } else if !self
            .repository
            .account_inactive_generation(did.into(), job.generation, now.into())
            .await?
        {
            return Err(BackfillError::AccountChanged);
        }
        Ok(())
    }
}
