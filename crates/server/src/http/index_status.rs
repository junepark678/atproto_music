//! Truthful API indexing state derived from durable relay and repository recovery evidence.
use crate::AppState;
use atmusic_storage::{Indexing, Repository, StorageError};
use chrono::{DateTime, Utc};

pub async fn app_indexing(
    state: &AppState,
    repository: &Repository,
    scope: &str,
) -> Result<Indexing, StorageError> {
    Ok(read(
        repository,
        state
            .config
            .as_ref()
            .and_then(|c| c.relay_url.as_ref())
            .map(|url| url.as_str()),
        scope,
        state.clock.now(),
    )
    .await?
    .indexing)
}

#[derive(Clone, Debug)]
pub struct IndexStatus {
    pub indexing: Indexing,
    pub last_sequence: Option<i64>,
    pub last_event_at: Option<String>,
    pub pending_gap: bool,
    pub pending_backfills: usize,
}
pub async fn read(
    repository: &Repository,
    relay: Option<&str>,
    scope: &str,
    now: DateTime<Utc>,
) -> Result<IndexStatus, StorageError> {
    let mut indexing = repository.indexing(scope).await?;
    let pending_backfills = usize::try_from(repository.pending_backfill_count().await?)
        .map_err(|_| StorageError::Invariant("invalid backfill count"))?;
    let recovery = if let Some(relay) = relay {
        repository.relay_recovery(relay).await?
    } else {
        None
    };
    let checkpoint = if let Some(relay) = relay {
        repository.checkpoint(relay).await?
    } else {
        None
    };
    let pending_gap = recovery
        .as_ref()
        .is_none_or(|v| v.pending_gap || !v.connected);
    let prior_sequence = recovery.as_ref().and_then(|v| v.prior_sequence);
    let last_event_at = recovery.and_then(|v| v.last_event_at);
    indexing.lag_seconds = last_event_at
        .as_deref()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| (now - t.with_timezone(&Utc)).num_seconds().max(0));
    if pending_gap || pending_backfills > 0 {
        if !matches!(indexing.state.as_str(), "stale" | "suppressed") {
            indexing.state = "recovering".into();
        }
        indexing.caught_up = false;
    }
    Ok(IndexStatus {
        indexing,
        last_sequence: checkpoint.map(|v| v.sequence).or(prior_sequence),
        last_event_at,
        pending_gap,
        pending_backfills,
    })
}
