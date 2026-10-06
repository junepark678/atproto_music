//! Owner record exports use one SQLite read transaction, independent of pagination.
use super::*;
use crate::StorageError;
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountExport {
    pub schema_version: u32,
    pub did: String,
    pub exported_at: String,
    pub indexing: Indexing,
    pub scrobbles: Vec<ScrobbleRow>,
    pub follows: Vec<FollowRow>,
}
impl Repository {
    pub async fn export_account(
        &self,
        owner: &str,
        exported_at: &str,
    ) -> Result<AccountExport, StorageError> {
        self.export_account_with_relay(owner, exported_at, None)
            .await
    }
    /// Record rows and durable freshness evidence share the same pinned read snapshot.
    pub async fn export_account_with_relay(
        &self,
        owner: &str,
        exported_at: &str,
        relay: Option<&str>,
    ) -> Result<AccountExport, StorageError> {
        let exported_at = super::public::timestamp(exported_at)?;
        let as_of = chrono::DateTime::parse_from_rfc3339(&exported_at)
            .map_err(|_| StorageError::Invariant("invalid export timestamp"))?;
        let mut snapshot = self.readers.begin().await?;
        let user:Option<User>=sqlx::query_as("SELECT * FROM users WHERE did=? AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=users.did)").bind(owner).fetch_optional(&mut *snapshot).await?;
        let user = user.ok_or(StorageError::NotFound)?;
        let mut indexing = sqlx::query_as(
            "SELECT state,caught_up,last_indexed_at,lag_seconds FROM indexing_status WHERE scope=?",
        )
        .bind(owner)
        .fetch_optional(&mut *snapshot)
        .await?
        .unwrap_or(Indexing {
            state: user.indexing_state,
            caught_up: false,
            last_indexed_at: user.indexed_at,
            lag_seconds: None,
        });
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM repo_backfills WHERE state!='complete' OR backfill_complete=0)").fetch_one(&mut *snapshot).await?;
        let recovery: Option<RelayRecovery> = if let Some(relay) = relay {
            sqlx::query_as("SELECT * FROM relay_recovery WHERE relay=?")
                .bind(relay)
                .fetch_optional(&mut *snapshot)
                .await?
        } else {
            None
        };
        let pending_gap = recovery
            .as_ref()
            .is_none_or(|recovery| recovery.pending_gap || !recovery.connected);
        indexing.lag_seconds = recovery
            .as_ref()
            .and_then(|recovery| recovery.last_event_at.as_deref())
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .map(|time| (as_of - time).num_seconds().max(0));
        if pending || pending_gap {
            if !matches!(indexing.state.as_str(), "stale" | "suppressed") {
                indexing.state = "recovering".into();
            }
            indexing.caught_up = false;
        }
        let scrobbles=sqlx::query_as("SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did WHERE s.did=? AND s.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) ORDER BY s.listened_at DESC,s.uri DESC").bind(owner).fetch_all(&mut *snapshot).await?;
        let follows=sqlx::query_as("SELECT f.* FROM follows f JOIN users u ON u.did=f.actor WHERE f.actor=? AND f.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=f.actor OR x.did=f.subject) AND NOT EXISTS(SELECT 1 FROM users subject WHERE subject.did=f.subject AND subject.active=0) AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=f.uri) AND f.uri=(SELECT min(g.uri) FROM follows g WHERE g.actor=f.actor AND g.subject=f.subject AND g.confirmed=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=g.uri)) ORDER BY f.created_at DESC,f.uri DESC").bind(owner).fetch_all(&mut *snapshot).await?;
        snapshot.commit().await?;
        Ok(AccountExport {
            schema_version: 1,
            did: owner.into(),
            exported_at,
            indexing,
            scrobbles,
            follows,
        })
    }
}
