//! Atomic revision convergence for complete, cryptographically verified repository snapshots.
use super::{public::timestamp, relay::apply_mutation, *};
use crate::StorageError;
use sqlx::SqliteConnection;
use std::collections::HashSet;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct BackfillJob {
    pub did: String,
    pub state: String,
    pub backfill_complete: bool,
    pub revision: Option<String>,
    pub pds: Option<String>,
    pub reactivate: bool,
    pub generation: i64,
    pub updated_at: String,
    pub failure_code: Option<String>,
}
#[derive(Clone, Debug)]
pub enum DiscoveryAdmission {
    Queued(BackfillJob),
    Known,
    Suppressed,
}
#[derive(Clone, Debug)]
pub struct RepositorySnapshot {
    pub did: String,
    pub revision: String,
    pub indexed_at: String,
    pub pds: String,
    pub generation: i64,
    pub mutations: Vec<RecordMutation>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Complete,
    Stale,
    Superseded,
    Suppressed,
}
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct RelayRecovery {
    pub relay: String,
    pub pending_gap: bool,
    pub connected: bool,
    pub last_event_at: Option<String>,
    pub prior_sequence: Option<i64>,
    pub reason: Option<String>,
    pub updated_at: String,
}

impl Repository {
    /// A relay hint admits only an inactive owner and bounded recovery job, never public records.
    /// Repeated hints cannot supersede a job, change account policy, or lift suppression.
    pub async fn discover_repository(
        &self,
        did: String,
        now: String,
    ) -> Result<DiscoveryAdmission, StorageError> {
        atmusic_core::follow::validate_did_syntax(&did)
            .map_err(|_| StorageError::Invariant("invalid discovery DID"))?;
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    let suppressed: bool =
                        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
                            .bind(&did)
                            .fetch_one(&mut *c)
                            .await?;
                    if suppressed {
                        return Ok(DiscoveryAdmission::Suppressed);
                    }
                    let known: bool =
                        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE did=?)")
                            .bind(&did)
                            .fetch_one(&mut *c)
                            .await?;
                    if known {
                        return Ok(DiscoveryAdmission::Known);
                    }
                    let mut user = User::new(&did, &now);
                    user.active = false;
                    super::public::upsert_user(c, &user).await?;
                    let job = request_backfill(c, &did, true, &now)
                        .await?
                        .ok_or(StorageError::Invariant("discovery admission lost owner"))?;
                    Ok(DiscoveryAdmission::Queued(job))
                })
            })
            .await
    }
    pub async fn request_backfill(
        &self,
        did: String,
        reactivate: bool,
        now: String,
    ) -> Result<Option<BackfillJob>, StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move { request_backfill(c, &did, reactivate, &now).await })
            })
            .await
    }
    /// An awaited account-status result may schedule recovery only for the job it observed.
    pub async fn request_backfill_generation(
        &self,
        did: String,
        expected_generation: i64,
        reactivate: bool,
        now: String,
    ) -> Result<Option<BackfillJob>, StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    if !sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM repo_backfills WHERE did=? AND generation=?)",
                    )
                    .bind(&did)
                    .bind(expected_generation)
                    .fetch_one(&mut *c)
                    .await?
                    {
                        return Ok(None);
                    }
                    request_backfill(c, &did, reactivate, &now).await
                })
            })
            .await
    }
    pub async fn backfill(&self, did: &str) -> Result<Option<BackfillJob>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM repo_backfills WHERE did=?")
            .bind(did)
            .fetch_optional(&self.readers)
            .await?)
    }
    pub async fn backfill_jobs(&self, limit: i64) -> Result<Vec<BackfillJob>, StorageError> {
        if !(1..=1024).contains(&limit) {
            return Err(StorageError::Invariant("invalid backfill queue limit"));
        }
        Ok(sqlx::query_as(
            "SELECT * FROM repo_backfills WHERE state!='complete' ORDER BY updated_at,did LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.readers)
        .await?)
    }
    pub async fn pending_backfill_count(&self) -> Result<i64, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT count(*) FROM repo_backfills WHERE backfill_complete=0")
                .fetch_one(&self.readers)
                .await?,
        )
    }
    pub async fn known_repository_dids(&self) -> Result<Vec<String>, StorageError> {
        Ok(sqlx::query_scalar("SELECT did FROM users WHERE NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=users.did) ORDER BY did").fetch_all(&self.readers).await?)
    }
    pub async fn backfill_running(
        &self,
        job: BackfillJob,
        now: String,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            Ok(sqlx::query("UPDATE repo_backfills SET state='running',updated_at=?,failure_code=NULL WHERE did=? AND generation=? AND state!='complete' AND NOT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
                .bind(timestamp(&now)?).bind(&job.did).bind(job.generation).bind(&job.did).execute(c).await?.rows_affected()==1)
        })).await
    }
    pub async fn backfill_failed(
        &self,
        job: BackfillJob,
        code: String,
        now: String,
    ) -> Result<(), StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("UPDATE repo_backfills SET state='failed',backfill_complete=0,failure_code=?,updated_at=? WHERE did=? AND generation=?")
                .bind(code).bind(timestamp(&now)?).bind(job.did).bind(job.generation).execute(c).await?; Ok(())
        })).await
    }
    /// Caller supplies a complete signed MST projection; local admission cannot call this gate.
    pub async fn reconcile_snapshot(
        &self,
        snapshot: RepositorySnapshot,
    ) -> Result<SnapshotOutcome, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)").bind(&snapshot.did).fetch_one(&mut *c).await? { return Ok(SnapshotOutcome::Suppressed); }
            let job: Option<BackfillJob> = sqlx::query_as("SELECT * FROM repo_backfills WHERE did=?").bind(&snapshot.did).fetch_optional(&mut *c).await?;
            let Some(job)=job else { return Ok(SnapshotOutcome::Superseded); };
            if job.generation != snapshot.generation { return Ok(SnapshotOutcome::Superseded); }
            let newest: Option<String> = sqlx::query_scalar("SELECT max(revision) FROM (SELECT revision FROM users WHERE did=? UNION ALL SELECT revision FROM scrobbles WHERE did=? UNION ALL SELECT revision FROM follows WHERE actor=? UNION ALL SELECT revision FROM tombstones WHERE owner=?)")
                .bind(&snapshot.did).bind(&snapshot.did).bind(&snapshot.did).bind(&snapshot.did).fetch_one(&mut *c).await?;
            let mut present=HashSet::new();
            for mutation in &snapshot.mutations {
                let (uri,owner,revision)=match mutation {
                    RecordMutation::Scrobble(row)=>(&row.uri,&row.did,&row.revision),
                    RecordMutation::Follow(row)=>(&row.uri,&row.actor,&row.revision),
                    RecordMutation::Delete{uri,owner,revision,..}=>(uri,owner,revision),
                    _ => return Err(StorageError::Invariant("snapshot cannot carry bulk mutations")),
                };
                if owner != &snapshot.did || revision != &snapshot.revision || !present.insert(uri.clone()) { return Err(StorageError::Ownership); }
                apply_mutation(c,mutation).await?;
            }
            let existing: Vec<String> = sqlx::query_scalar("SELECT uri FROM scrobbles WHERE did=? AND revision<=? UNION ALL SELECT uri FROM follows WHERE actor=? AND revision<=?")
                .bind(&snapshot.did).bind(&snapshot.revision).bind(&snapshot.did).bind(&snapshot.revision).fetch_all(&mut *c).await?;
            for uri in existing {
                if !present.contains(&uri) { apply_mutation(c,&RecordMutation::Delete { uri,owner:snapshot.did.clone(),revision:snapshot.revision.clone(),indexed_at:snapshot.indexed_at.clone() }).await?; }
            }
            let stale=newest.as_ref().is_some_and(|rev| rev>&snapshot.revision);
            sqlx::query("UPDATE users SET revision=CASE WHEN revision IS NULL OR revision<? THEN ? ELSE revision END,indexed_at=?,indexing_state=?,active=CASE WHEN ? AND ? THEN 1 ELSE active END WHERE did=?")
                .bind(&snapshot.revision).bind(&snapshot.revision).bind(timestamp(&snapshot.indexed_at)?).bind(if stale {"recovering"} else {"current"}).bind(job.reactivate).bind(!stale).bind(&snapshot.did).execute(&mut *c).await?;
            sqlx::query("UPDATE repo_backfills SET state=?,backfill_complete=?,revision=?,pds=?,updated_at=?,failure_code=NULL WHERE did=? AND generation=?")
                .bind(if stale {"pending"} else {"complete"}).bind(!stale).bind(&snapshot.revision).bind(snapshot.pds).bind(timestamp(&snapshot.indexed_at)?).bind(&snapshot.did).bind(snapshot.generation).execute(&mut *c).await?;
            set_scope(c,&snapshot.did,!stale,&snapshot.indexed_at).await?;
            Ok(if stale {SnapshotOutcome::Stale} else {SnapshotOutcome::Complete})
        })).await
    }
    pub async fn account_inactive(&self, did: String, now: String) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    account_inactive(c, &did, None, &now).await?;
                    Ok(())
                })
            })
            .await
    }
    /// Ignore a status response fetched before a newer authorization or recovery admission.
    pub async fn account_inactive_generation(
        &self,
        did: String,
        generation: i64,
        now: String,
    ) -> Result<bool, StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move { account_inactive(c, &did, Some(generation), &now).await })
            })
            .await
    }
    pub async fn set_relay_recovery(&self, recovery: RelayRecovery) -> Result<(), StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("INSERT INTO relay_recovery(relay,pending_gap,connected,last_event_at,prior_sequence,reason,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(relay) DO UPDATE SET pending_gap=excluded.pending_gap,connected=excluded.connected,last_event_at=excluded.last_event_at,prior_sequence=excluded.prior_sequence,reason=excluded.reason,updated_at=excluded.updated_at")
                .bind(recovery.relay).bind(recovery.pending_gap).bind(recovery.connected).bind(recovery.last_event_at.as_deref().map(timestamp).transpose()?).bind(recovery.prior_sequence).bind(recovery.reason).bind(timestamp(&recovery.updated_at)?).execute(c).await?; Ok(())
        })).await
    }
    pub async fn relay_recovery(&self, relay: &str) -> Result<Option<RelayRecovery>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM relay_recovery WHERE relay=?")
            .bind(relay)
            .fetch_optional(&self.readers)
            .await?)
    }
    /// Cursor rejection and coverage invalidation persist together. Previously successful
    /// snapshots remain unadmitted stale coverage until the bounded coordinator schedules them.
    pub async fn reject_relay_cursor(
        &self,
        relay: String,
        code: String,
        now: String,
    ) -> Result<(), StorageError> {
        if !matches!(code.as_str(), "FutureCursor" | "OutdatedCursor") {
            return Err(StorageError::Invariant("invalid cursor recovery reason"));
        }
        self.writer.execute(move |c|Box::pin(async move {
            sqlx::query("INSERT INTO relay_recovery(relay,pending_gap,connected,reason,updated_at) VALUES(?,1,0,?,?) ON CONFLICT(relay) DO UPDATE SET pending_gap=1,connected=0,reason=excluded.reason,updated_at=excluded.updated_at")
                .bind(relay).bind(code).bind(timestamp(&now)?).execute(&mut *c).await?;
            let count: i64=sqlx::query_scalar("SELECT count(*) FROM repo_backfills").fetch_one(&mut *c).await?;
            if count>0 {
                let last=allocate_generations(c,count).await?;
                sqlx::query("WITH allocated AS MATERIALIZED (SELECT did,row_number() OVER (ORDER BY did) AS ordinal FROM repo_backfills) UPDATE repo_backfills SET backfill_complete=0,generation=?+(SELECT ordinal FROM allocated WHERE allocated.did=repo_backfills.did),updated_at=?")
                    .bind(last-count).bind(timestamp(&now)?).execute(c).await?;
            }
            Ok(())
        })).await
    }
    /// An invalid relay cursor may be reset only after complete snapshots cover every known DID.
    /// Preserve the previous sequence and unresolved gap as durable evidence of this transition.
    pub async fn prepare_relay_resume(
        &self,
        relay: String,
        now: String,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let incomplete:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u LEFT JOIN repo_backfills b ON b.did=u.did WHERE NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=u.did) AND (b.did IS NULL OR b.backfill_complete=0 OR b.state!='complete'))").fetch_one(&mut *c).await?;
            if incomplete {return Ok(false);}
            let old:Option<i64>=sqlx::query_scalar("SELECT sequence FROM relay_checkpoints WHERE relay=?").bind(&relay).fetch_optional(&mut *c).await?;
            let changed=sqlx::query("UPDATE relay_recovery SET reason='cursor_reconciled',prior_sequence=?,pending_gap=1,updated_at=? WHERE relay=? AND reason IN ('FutureCursor','OutdatedCursor')").bind(old).bind(timestamp(&now)?).bind(&relay).execute(&mut *c).await?.rows_affected();
            if changed==1 {sqlx::query("DELETE FROM relay_checkpoints WHERE relay=?").bind(relay).execute(c).await?;}
            Ok(changed==1)
        })).await
    }
}

async fn account_inactive(
    c: &mut SqliteConnection,
    did: &str,
    generation: Option<i64>,
    now: &str,
) -> Result<bool, StorageError> {
    let admitted = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users u WHERE u.did=? AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=u.did) AND (? IS NULL OR EXISTS(SELECT 1 FROM repo_backfills b WHERE b.did=u.did AND b.generation=?)))",
    )
    .bind(did)
    .bind(generation)
    .bind(generation)
    .fetch_one(&mut *c)
    .await?;
    if !admitted {
        return Ok(false);
    }
    sqlx::query("UPDATE users SET active=0,indexing_state='recovering' WHERE did=?")
        .bind(did)
        .execute(&mut *c)
        .await?;
    // The global allocator also prevents old jobs from matching a recreated account.
    let has_job: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM repo_backfills WHERE did=?)")
            .bind(did)
            .fetch_one(&mut *c)
            .await?;
    if has_job {
        let next = allocate_generations(c, 1).await?;
        sqlx::query("UPDATE repo_backfills SET generation=?,reactivate=0,backfill_complete=0,state='pending',updated_at=? WHERE did=?")
            .bind(next).bind(timestamp(now)?).bind(did).execute(&mut *c).await?;
    }
    set_scope(c, did, false, now).await?;
    Ok(true)
}

pub(crate) async fn request_backfill(
    c: &mut SqliteConnection,
    did: &str,
    reactivate: bool,
    now: &str,
) -> Result<Option<BackfillJob>, StorageError> {
    if !sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM users WHERE did=? AND NOT EXISTS(SELECT 1 FROM suppression WHERE did=?))").bind(did).bind(did).fetch_one(&mut *c).await? { return Ok(None); }
    let queued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM repo_backfills WHERE state IN ('pending','failed') AND did!=?",
    )
    .bind(did)
    .fetch_one(&mut *c)
    .await?;
    if queued >= 1024 {
        return Err(StorageError::ServiceBusy);
    }
    let next = allocate_generations(c, 1).await?;
    sqlx::query("INSERT INTO repo_backfills(did,state,reactivate,generation,updated_at) VALUES(?,'pending',?,?,?) ON CONFLICT(did) DO UPDATE SET state='pending',backfill_complete=0,reactivate=(repo_backfills.reactivate OR excluded.reactivate),generation=excluded.generation,updated_at=excluded.updated_at,failure_code=NULL")
        .bind(did).bind(reactivate).bind(next).bind(timestamp(now)?).execute(&mut *c).await?;
    sqlx::query("UPDATE users SET indexing_state='recovering',active=CASE WHEN ? THEN 0 ELSE active END WHERE did=?").bind(reactivate).bind(did).execute(&mut *c).await?;
    set_scope(c, did, false, now).await?;
    Ok(sqlx::query_as("SELECT * FROM repo_backfills WHERE did=?")
        .bind(did)
        .fetch_optional(c)
        .await?)
}
/// Reserve a durable range in the caller's transaction; arithmetic never promotes to REAL.
async fn allocate_generations(c: &mut SqliteConnection, count: i64) -> Result<i64, StorageError> {
    let upper =
        i64::MAX
            .checked_sub(count)
            .filter(|_| count > 0)
            .ok_or(StorageError::Invariant(
                "invalid backfill generation allocation",
            ))?;
    sqlx::query_scalar(
        "UPDATE backfill_generation SET last_generation=last_generation+? WHERE singleton=1 AND last_generation<=? RETURNING last_generation",
    )
    .bind(count)
    .bind(upper)
    .fetch_optional(c)
    .await?
    .ok_or(StorageError::Invariant("backfill generation exhausted"))
}
async fn set_scope(
    c: &mut SqliteConnection,
    did: &str,
    current: bool,
    now: &str,
) -> Result<(), StorageError> {
    sqlx::query("INSERT INTO indexing_status(scope,state,caught_up,last_indexed_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state,caught_up=excluded.caught_up,last_indexed_at=excluded.last_indexed_at")
        .bind(did).bind(if current {"current"} else {"recovering"}).bind(current).bind(timestamp(now)?).execute(c).await?;
    Ok(())
}
