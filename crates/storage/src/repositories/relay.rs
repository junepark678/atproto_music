use super::public::{apply_follow, apply_scrobble, timestamp};
use super::*;
use crate::StorageError;
use sqlx::SqliteConnection;
impl Repository {
    pub async fn checkpoint(&self, relay: &str) -> Result<Option<Checkpoint>, StorageError> {
        Ok(
            sqlx::query_as("SELECT * FROM relay_checkpoints WHERE relay=?")
                .bind(relay)
                .fetch_optional(&self.readers)
                .await?,
        )
    }
    /// All record mutations and checkpoint advancement succeed or roll back together.
    pub async fn apply_event(&self, event: RepositoryEvent) -> Result<bool, StorageError> {
        self.apply_repository_event_inner(None, event).await
    }
    /// The protocol caller has verified the repository commit. Advance its revision
    /// even when it contains no visible music mutation, in the checkpoint transaction.
    pub async fn apply_repository_event(
        &self,
        did: String,
        event: RepositoryEvent,
    ) -> Result<bool, StorageError> {
        self.apply_repository_event_inner(Some(did), event).await
    }
    async fn apply_repository_event_inner(
        &self,
        did: Option<String>,
        event: RepositoryEvent,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let old: Option<i64> = sqlx::query_scalar("SELECT sequence FROM relay_checkpoints WHERE relay=?").bind(&event.checkpoint.relay).fetch_optional(&mut *c).await?;
            if old.is_some_and(|old| old>=event.checkpoint.sequence) { return Ok(false); }
            if let Some(did)=&did {
                let revision=event.checkpoint.revision.as_ref().ok_or(StorageError::Invariant("repository event requires verified revision"))?;
                for mutation in &event.mutations {
                    let (owner,record_revision)=match mutation {
                        RecordMutation::Scrobble(row)=>(&row.did,&row.revision),
                        RecordMutation::Follow(row)=>(&row.actor,&row.revision),
                        RecordMutation::Delete{owner,revision,..}|RecordMutation::DeleteMany{owner,revision,..}=>(owner,revision),
                    };
                    if owner!=did || record_revision!=revision {return Err(StorageError::Ownership);}
                }
            }
            for mutation in &event.mutations { apply_mutation(c,mutation).await?; }
            if let Some(did)=did {
                let revision=event.checkpoint.revision.as_ref().ok_or(StorageError::Invariant("repository event requires verified revision"))?;
                sqlx::query("UPDATE users SET indexed_at=?,revision=? WHERE did=? AND (revision IS NULL OR revision<?) AND NOT EXISTS(SELECT 1 FROM suppression WHERE did=users.did)")
                    .bind(timestamp(&event.checkpoint.indexed_at)?).bind(revision).bind(did).bind(revision).execute(&mut *c).await?;
            }
            sqlx::query("INSERT INTO relay_checkpoints(relay,sequence,revision,indexed_at) VALUES(?,?,?,?) ON CONFLICT(relay) DO UPDATE SET sequence=excluded.sequence,revision=excluded.revision,indexed_at=excluded.indexed_at")
                .bind(&event.checkpoint.relay).bind(event.checkpoint.sequence).bind(&event.checkpoint.revision).bind(timestamp(&event.checkpoint.indexed_at)?).execute(c).await?;
            Ok(true)
        })).await
    }
}
pub(crate) async fn apply_mutation(
    c: &mut SqliteConnection,
    mutation: &RecordMutation,
) -> Result<(), StorageError> {
    match mutation {
        RecordMutation::DeleteMany {
            uris,
            owner,
            revision,
            indexed_at,
        } => {
            if uris.is_empty()
                || uris
                    .iter()
                    .any(|uri| !uri.starts_with(&format!("at://{owner}/")))
            {
                return Err(StorageError::Ownership);
            }
            for uri in uris {
                Box::pin(apply_mutation(
                    c,
                    &RecordMutation::Delete {
                        uri: uri.clone(),
                        owner: owner.clone(),
                        revision: revision.clone(),
                        indexed_at: indexed_at.clone(),
                    },
                ))
                .await?;
            }
            Ok(())
        }
        RecordMutation::Scrobble(row) => apply_scrobble(c, row).await,
        RecordMutation::Follow(row) => apply_follow(c, row).await,
        RecordMutation::Delete {
            uri,
            owner,
            revision,
            indexed_at,
        } => {
            if !uri.starts_with(&format!("at://{owner}/")) {
                return Err(StorageError::Ownership);
            }
            if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
                .bind(owner)
                .fetch_one(&mut *c)
                .await?
            {
                return Ok(());
            }
            let current: Option<String> = sqlx::query_scalar("SELECT revision FROM scrobbles WHERE uri=? UNION ALL SELECT revision FROM follows WHERE uri=? LIMIT 1").bind(uri).bind(uri).fetch_optional(&mut *c).await?;
            if current
                .as_deref()
                .is_some_and(|old| old > revision.as_str())
            {
                return Ok(());
            }
            sqlx::query("INSERT INTO tombstones(uri,owner,revision,created_at,pending) VALUES(?,?,?,?,0) ON CONFLICT(uri) DO UPDATE SET revision=excluded.revision,pending=CASE WHEN tombstones.pending=1 AND EXISTS(SELECT 1 FROM operations local WHERE local.operation_id=tombstones.operation_id AND local.kind IN('scrobble_delete','follow_delete') AND local.state!='succeeded') THEN 1 ELSE 0 END WHERE tombstones.revision IS NULL OR excluded.revision>=tombstones.revision")
                .bind(uri).bind(owner).bind(revision).bind(timestamp(indexed_at)?).execute(&mut *c).await?;
            sqlx::query("DELETE FROM scrobbles WHERE uri=? AND did=? AND revision<=?")
                .bind(uri)
                .bind(owner)
                .bind(revision)
                .execute(&mut *c)
                .await?;
            sqlx::query("DELETE FROM follows WHERE uri=? AND actor=? AND revision<=?")
                .bind(uri)
                .bind(owner)
                .bind(revision)
                .execute(&mut *c)
                .await?;
            sqlx::query("UPDATE users SET indexed_at=?,revision=? WHERE did=? AND (revision IS NULL OR revision<?)")
                .bind(timestamp(indexed_at)?).bind(revision).bind(owner).bind(revision).execute(c).await?;
            Ok(())
        }
    }
}
