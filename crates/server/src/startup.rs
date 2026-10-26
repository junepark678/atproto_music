//! Production initialization for current-head publication and complete snapshots.
//! Relay delivery remains disabled until covered-event progress has a safe policy.
use crate::{
    AppState, Clock, SystemClock,
    config::Config,
    workers::{
        outbox::OutboxWorker,
        runtime::{WorkerRuntime, WorkerSet},
    },
};
use atmusic_atproto::{
    http::safe_client::SafeClient,
    identity::IdentityResolver,
    oauth::{
        service::{OAuthConfig, OAuthService},
        token_store::TokenStore,
    },
    pds::reconcile::PdsClient,
    sync::{
        accounts::{AccountSource, AccountStatus, PdsAccountSource},
        backfill::{
            BackfillCoordinator, BackfillError, FetchedSnapshot, PdsSnapshotSource, ReceiptClock,
            SnapshotSource,
        },
        current_head::CurrentHeadResolver,
    },
};
use atmusic_storage::{Database, RelayRecovery, Repository};
use std::{sync::Arc, time::Duration};

pub struct InitializedApp {
    pub state: AppState,
    pub runtime: Option<WorkerRuntime>,
    pub backfills: Option<Arc<BackfillCoordinator>>,
}

impl ReceiptClock for SystemClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        Clock::now(self)
    }
}

pub async fn initialize(
    config: Config,
    database: Database,
    client: SafeClient,
) -> Result<InitializedApp, &'static str> {
    initialize_with_clock(config, database, client, Arc::new(SystemClock)).await
}

/// Injection is confined to the protected network boundary and receipt clock.
/// The same current-head resolver and account/snapshot verification run in tests.
pub async fn initialize_with_clock<C: Clock + ReceiptClock + 'static>(
    config: Config,
    database: Database,
    client: SafeClient,
    clock: Arc<C>,
) -> Result<InitializedApp, &'static str> {
    let repository = database.repositories();
    if let Some(relay) = &config.relay_url {
        let previous = repository
            .relay_recovery(relay.as_str())
            .await
            .map_err(|_| "relay: recovery state inspection failed")?;
        repository
            .set_relay_recovery(RelayRecovery {
                relay: relay.to_string(),
                pending_gap: true,
                connected: false,
                prior_sequence: previous.as_ref().and_then(|value| value.prior_sequence),
                last_event_at: previous.and_then(|value| value.last_event_at),
                reason: Some("relay_worker_not_enabled".into()),
                updated_at: Clock::now(clock.as_ref()).to_rfc3339(),
            })
            .await
            .map_err(|_| "relay: recovery state initialization failed")?;
    }
    let store = TokenStore::new(repository.clone(), config.encryption_key())
        .map_err(|_| "encryption_key: OAuth storage initialization failed")?;
    let oauth_config = OAuthConfig::new(
        &config.public_origin,
        crate::http::oauth_metadata::scopes(&config),
    )
    .map_err(|_| "public_origin: invalid OAuth client origin")?;
    let identity = Arc::new(IdentityResolver::new(client.clone()));
    let oauth = Arc::new(OAuthService::new(client.clone(), store, oauth_config));
    let publication = config
        .namespace
        .as_ref()
        .filter(|namespace| namespace.require_publication().is_ok())
        .cloned();
    let mut state = AppState::new(config, Some(database))
        .with_clock(clock.clone())
        .with_oauth(oauth.clone())
        .with_identity(identity.clone());
    let Some(namespace) = publication else {
        return Ok(InitializedApp {
            state,
            runtime: None,
            backfills: None,
        });
    };
    let resolver = Arc::new(CurrentHeadResolver::new(client.clone()));
    let boundary = Arc::new(
        PdsClient::new(oauth, namespace.clone(), resolver.clone())
            .map_err(|_| "namespace_ownership: publication is unavailable")?,
    );
    let outbox = Arc::new(OutboxWorker::new(repository.clone(), boundary));
    let account_source = Arc::new(PdsAccountSource::new(
        identity.as_ref().clone(),
        client.clone(),
    ));
    let snapshot_source = Arc::new(PdsSnapshotSource::new(identity.as_ref().clone(), client));
    let checked_source = Arc::new(AccountSnapshotSource::new(
        repository.clone(),
        account_source,
        snapshot_source,
        clock.clone(),
    ));
    let backfills = Arc::new(BackfillCoordinator::new(
        repository,
        namespace,
        checked_source,
        resolver,
        clock.clone(),
    ));
    state = state.with_outbox(outbox.clone());
    let runtime = WorkerRuntime::start(
        WorkerSet {
            outbox: Some(outbox),
            backfills: Some(backfills.clone()),
            relay: None,
        },
        clock,
        Duration::from_secs(1),
    )?;
    Ok(InitializedApp {
        state,
        runtime: Some(runtime),
        backfills: Some(backfills),
    })
}

/// Account status and snapshot origin must agree across the current snapshot fetch.
/// Status comes from a freshly resolved authenticated DID/PDS, never a relay hint.
pub struct AccountSnapshotSource {
    repository: Repository,
    accounts: Arc<dyn AccountSource>,
    snapshots: Arc<dyn SnapshotSource>,
    clock: Arc<dyn ReceiptClock>,
}
impl AccountSnapshotSource {
    pub fn new(
        repository: Repository,
        accounts: Arc<dyn AccountSource>,
        snapshots: Arc<dyn SnapshotSource>,
        clock: Arc<dyn ReceiptClock>,
    ) -> Self {
        Self {
            repository,
            accounts,
            snapshots,
            clock,
        }
    }
    async fn check(
        &self,
        did: &str,
        status: &AccountStatus,
        generation: i64,
    ) -> Result<(), BackfillError> {
        if status.did != did {
            return Err(BackfillError::AccountChanged);
        }
        let job = self.repository.backfill(did).await?;
        if job.as_ref().is_none_or(|job| job.generation != generation) {
            return Err(BackfillError::AccountChanged);
        }
        if !status.active {
            let changed = self
                .repository
                .account_inactive_generation(did.into(), generation, self.clock.now().to_rfc3339())
                .await?;
            return Err(if changed {
                BackfillError::AccountInactive
            } else {
                BackfillError::AccountChanged
            });
        }
        let user = self
            .repository
            .user(did)
            .await?
            .ok_or(BackfillError::AccountInactive)?;
        if !user.active && job.as_ref().is_none_or(|job| !job.reactivate) {
            let scheduled = self
                .repository
                .request_backfill_generation(
                    did.into(),
                    generation,
                    true,
                    self.clock.now().to_rfc3339(),
                )
                .await?;
            return Err(if scheduled.is_some() {
                BackfillError::AccountChanged
            } else {
                BackfillError::AccountInactive
            });
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl SnapshotSource for AccountSnapshotSource {
    async fn fetch(&self, did: &str) -> Result<FetchedSnapshot, BackfillError> {
        if self.repository.user(did).await?.is_none() {
            return Err(BackfillError::AccountInactive);
        }
        // Bind every status mutation to the job observed before any upstream wait.
        // Storage checks this generation again inside its writer transaction.
        let generation = self
            .repository
            .backfill(did)
            .await?
            .ok_or(BackfillError::AccountInactive)?
            .generation;
        let before = self.accounts.current(did).await?;
        self.check(did, &before, generation).await?;
        let snapshot = self.snapshots.fetch(did).await?;
        let after = self.accounts.current(did).await?;
        self.check(did, &after, generation).await?;
        if snapshot.pds != before.pds || before.pds != after.pds {
            return Err(BackfillError::AccountChanged);
        }
        Ok(snapshot)
    }
}
