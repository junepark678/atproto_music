//! Durable owner-bound admission and PDS operation transitions.
use super::public::timestamp;
use super::*;
use crate::StorageError;
use sqlx::SqliteConnection;
impl Repository {
    /// Allocate an operation/TID only after replay/conflict admission has been resolved.
    pub async fn admit_scrobble_factory<F>(
        &self,
        owner: String,
        key: String,
        input_digest: String,
        factory: F,
    ) -> Result<Admission, StorageError>
    where
        F: FnOnce() -> Result<NewOperation, StorageError> + Send + 'static,
    {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    if key.is_empty()
                        || key.len() > 128
                        || !key.bytes().all(|b| (32..=126).contains(&b))
                    {
                        return Err(StorageError::Invariant("invalid idempotency key"));
                    }
                    let previous: Option<(String, String)> = sqlx::query_as(
                        "SELECT digest,operation_id FROM idempotency WHERE owner=? AND key=?",
                    )
                    .bind(&owner)
                    .bind(&key)
                    .fetch_optional(&mut *c)
                    .await?;
                    if let Some((digest, id)) = previous {
                        if digest != input_digest {
                            return Err(StorageError::IdempotencyConflict);
                        }
                        return Ok(Admission::Replayed(
                            sqlx::query_as(
                                "SELECT * FROM operations WHERE owner=? AND operation_id=?",
                            )
                            .bind(&owner)
                            .bind(id)
                            .fetch_one(c)
                            .await?,
                        ));
                    }
                    let input = factory()?;
                    if input.owner != owner || input.kind != "scrobble_create" {
                        return Err(StorageError::Invariant(
                            "invalid scrobble admission factory",
                        ));
                    }
                    insert_operation(c, &input).await?;
                    sqlx::query(
                        "INSERT INTO idempotency(owner,key,digest,operation_id) VALUES(?,?,?,?)",
                    )
                    .bind(owner)
                    .bind(key)
                    .bind(input_digest)
                    .bind(&input.operation_id)
                    .execute(&mut *c)
                    .await?;
                    Ok(Admission::Created(
                        sqlx::query_as("SELECT * FROM operations WHERE operation_id=?")
                            .bind(input.operation_id)
                            .fetch_one(c)
                            .await?,
                    ))
                })
            })
            .await
    }
    /// Digest/key and operation/outbox commit together. Replays never re-enqueue.
    pub async fn admit_operation(
        &self,
        input: NewOperation,
        key: Option<String>,
    ) -> Result<Admission, StorageError> {
        let digest = input.canonical_digest.clone();
        self.admit_operation_with_digest(input, key, digest).await
    }
    /// Local-input replay identity is distinct from the full published-record digest.
    pub async fn admit_operation_with_digest(
        &self,
        input: NewOperation,
        key: Option<String>,
        input_digest: Option<String>,
    ) -> Result<Admission, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            if let Some(key) = &key {
                if key.is_empty() || key.len()>128 || !key.bytes().all(|b| (32..=126).contains(&b)) { return Err(StorageError::Invariant("invalid idempotency key")); }
                let existing: Option<(String,String)> = sqlx::query_as("SELECT digest,operation_id FROM idempotency WHERE owner=? AND key=?").bind(&input.owner).bind(key).fetch_optional(&mut *c).await?;
                if let Some((digest,id)) = existing {
                    if Some(&digest)!=input_digest.as_ref() { return Err(StorageError::IdempotencyConflict); }
                    return Ok(Admission::Replayed(sqlx::query_as("SELECT * FROM operations WHERE operation_id=? AND owner=?").bind(id).bind(&input.owner).fetch_one(&mut *c).await?));
                }
            }
            insert_operation(c,&input).await?;
            if let Some(key) = key {
                sqlx::query("INSERT INTO idempotency(owner,key,digest,operation_id) VALUES(?,?,?,?)").bind(&input.owner).bind(key)
                    .bind(input_digest.as_ref().ok_or(StorageError::Invariant("idempotency requires digest"))?).bind(&input.operation_id).execute(&mut *c).await?;
            }
            Ok(Admission::Created(sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(&input.operation_id).fetch_one(c).await?))
        })).await
    }
    pub async fn operation(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<Option<Operation>, StorageError> {
        Ok(
            sqlx::query_as("SELECT * FROM operations WHERE owner=? AND operation_id=?")
                .bind(owner)
                .bind(id)
                .fetch_optional(&self.readers)
                .await?,
        )
    }
    /// Reveals existence only, for the frozen authenticated 403/404 distinction.
    pub async fn operation_exists(&self, id: &str) -> Result<bool, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?)")
                .bind(id)
                .fetch_one(&self.readers)
                .await?,
        )
    }
    pub async fn outbox_due(&self, now: &str, limit: u32) -> Result<Vec<OutboxItem>, StorageError> {
        Ok(sqlx::query_as("SELECT b.*,o.kind,o.attempts,o.record_uri FROM outbox b JOIN operations o USING(operation_id) WHERE o.state='pending' AND b.due_at<=? AND NOT EXISTS(SELECT 1 FROM operation_dependencies d JOIN operations p ON p.operation_id=d.predecessor_id WHERE d.operation_id=o.operation_id AND p.state='pending') ORDER BY b.due_at,b.operation_id LIMIT ?").bind(timestamp(now)?).bind(i64::from(limit)).fetch_all(&self.readers).await?)
    }
    /// Persist an attempt before sending. The single worker owns attempt sequencing.
    pub async fn begin_attempt(&self, id: String, now: String) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let changed = sqlx::query("UPDATE operations SET attempts=attempts+1,updated_at=? WHERE operation_id=? AND state='pending' AND attempts<10 AND EXISTS(SELECT 1 FROM outbox b WHERE b.operation_id=operations.operation_id) AND NOT EXISTS(SELECT 1 FROM operation_dependencies d JOIN operations p ON p.operation_id=d.predecessor_id WHERE d.operation_id=operations.operation_id AND p.state='pending')").bind(timestamp(&now)?).bind(&id).execute(&mut *c).await?.rows_affected();
            if changed>0 { sqlx::query("UPDATE outbox SET locked_at=? WHERE operation_id=?").bind(timestamp(&now)?).bind(id).execute(c).await?; }
            Ok(changed>0)
        })).await
    }
    pub async fn retry_operation(
        &self,
        id: String,
        now: String,
        due: String,
    ) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    let (state, attempts): (String, i64) = sqlx::query_as(
                        "SELECT state,attempts FROM operations WHERE operation_id=?",
                    )
                    .bind(&id)
                    .fetch_one(&mut *c)
                    .await?;
                    if state != "pending" || attempts >= 10 {
                        return Err(StorageError::InvalidTransition);
                    }
                    sqlx::query("UPDATE outbox SET due_at=?,locked_at=NULL WHERE operation_id=?")
                        .bind(timestamp(&due)?)
                        .bind(&id)
                        .execute(&mut *c)
                        .await?;
                    sqlx::query("UPDATE operations SET updated_at=? WHERE operation_id=?")
                        .bind(timestamp(&now)?)
                        .bind(id)
                        .execute(c)
                        .await?;
                    Ok(())
                })
            })
            .await
    }
    pub async fn finish_operation(
        &self,
        id: String,
        now: String,
        failure_code: Option<String>,
        confirmed: Option<RecordMutation>,
    ) -> Result<(), StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let operation: Operation = sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(&id).fetch_one(&mut *c).await?;
            if operation.state!="pending" { return Err(StorageError::InvalidTransition); }
            if failure_code.is_some() && confirmed.is_some() { return Err(StorageError::Invariant("failed operation cannot confirm a record")); }
            let verified_create = matches!(&confirmed,Some(RecordMutation::Scrobble(_)|RecordMutation::Follow(_)));
            let verified_delete = matches!(&confirmed,Some(RecordMutation::Delete{..}|RecordMutation::DeleteMany{..}));
            if failure_code.is_none() && matches!(operation.kind.as_str(),"scrobble_delete"|"follow_delete") && !verified_delete { return Err(StorageError::Invariant("deletion acknowledgement is not verified absence")); }
            if let Some(mutation) = confirmed {
                let (uri,owner,kind)=match &mutation {
                    RecordMutation::Scrobble(row)=>(&row.uri,&row.did,"scrobble_create"),
                    RecordMutation::Follow(row)=>(&row.uri,&row.actor,"follow_create"),
                    RecordMutation::DeleteMany{uris,owner,..}=>{
                        let uri=operation.record_uri.as_ref().ok_or(StorageError::Invariant("batch delete requires URI"))?;
                        if operation.kind!="follow_delete" || !uris.contains(uri) || uris.iter().any(|uri|!uri.starts_with(&format!("at://{owner}/"))){return Err(StorageError::Invariant("batch deletion identity mismatch"));}
                        let payload:String=sqlx::query_scalar("SELECT payload_json FROM outbox WHERE operation_id=?").bind(&id).fetch_one(&mut *c).await?;
                        let payload:serde_json::Value=serde_json::from_str(&payload).map_err(|_|StorageError::Invariant("invalid batch deletion intent"))?;
                        let mut expected:Vec<String>=payload.get("targetUris").and_then(serde_json::Value::as_array).ok_or(StorageError::Invariant("batch deletion targets missing"))?.iter().map(|value|value.as_str().map(str::to_owned).ok_or(StorageError::Invariant("invalid batch deletion target"))).collect::<Result<_,_>>()?;
                        let mut actual=uris.clone(); expected.sort();actual.sort();
                        if expected.is_empty() || expected!=actual || actual.windows(2).any(|pair|pair[0]==pair[1]) {return Err(StorageError::Invariant("batch deletion targets mismatch"));}
                        (uri,owner,"follow_delete")
                    },
                    RecordMutation::Delete{uri,owner,..}=>(uri,owner,operation.kind.as_str()),
                };
                if owner!=&operation.owner || Some(uri)!=operation.record_uri.as_ref() || kind!=operation.kind || matches!(&mutation,RecordMutation::Delete{..}) && !matches!(operation.kind.as_str(),"scrobble_delete"|"follow_delete") {
                    return Err(StorageError::Invariant("operation confirmation identity mismatch"));
                }
                // A new explicit follow intent can restore a deterministic URI only
                // after verified confirmation, never while its delete is pending.
                if matches!(&mutation,RecordMutation::Follow(_)) {
                    sqlx::query("DELETE FROM tombstones WHERE uri=? AND owner=? AND pending=1 AND EXISTS(SELECT 1 FROM operations previous WHERE previous.operation_id=tombstones.operation_id AND previous.owner=? AND previous.kind='follow_delete' AND previous.state='failed')")
                        .bind(uri).bind(owner).bind(owner).execute(&mut *c).await?;
                }
                super::relay::apply_mutation(c,&mutation).await?;
            }
            if failure_code.is_none() && matches!(operation.kind.as_str(),"scrobble_create"|"follow_create") {
                let uri=operation.record_uri.as_ref().ok_or(StorageError::Invariant("confirmed create requires URI"))?;
                let exists: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scrobbles WHERE uri=? AND confirmed=1 UNION ALL SELECT 1 FROM follows WHERE uri=? AND confirmed=1)").bind(uri).bind(uri).fetch_one(&mut *c).await?;
                let hidden: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tombstones WHERE uri=? AND pending=1)").bind(uri).fetch_one(&mut *c).await?;
                if !(exists || verified_create && hidden) { return Err(StorageError::Invariant("queue acknowledgement is not verified confirmation")); }
            }
            sqlx::query("UPDATE operations SET state=?,updated_at=?,failure_code=? WHERE operation_id=?")
                .bind(if failure_code.is_some(){"failed"}else{"succeeded"}).bind(timestamp(&now)?).bind(failure_code).bind(&id).execute(&mut *c).await?;
            if verified_delete {
                sqlx::query("UPDATE tombstones SET pending=0 WHERE operation_id=? AND owner=?").bind(&id).bind(&operation.owner).execute(&mut *c).await?;
            }
            sqlx::query("DELETE FROM outbox WHERE operation_id=?").bind(id).execute(c).await?;
            Ok(())
        })).await
    }
    /// Immediate visibility removal and durable remote-delete work share one transaction.
    pub async fn request_deletion(&self, input: NewOperation) -> Result<Operation, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            if !matches!(input.kind.as_str(),"scrobble_delete"|"follow_delete") {return Err(StorageError::Invariant("deletion requires delete operation"));}
            let uri = input.record_uri.as_ref().ok_or(StorageError::Invariant("delete requires URI"))?;
            if !uri.starts_with(&format!("at://{}/",input.owner)) { return Err(StorageError::Ownership); }
            let existing: Option<String> = sqlx::query_scalar("SELECT operation_id FROM tombstones WHERE uri=? AND pending=1").bind(uri).fetch_optional(&mut *c).await?.flatten();
            if let Some(id)=existing { return Ok(sqlx::query_as("SELECT * FROM operations WHERE operation_id=? AND owner=?").bind(id).bind(&input.owner).fetch_one(c).await?); }
            insert_operation(c,&input).await?;
            sqlx::query("INSERT INTO tombstones(uri,owner,operation_id,created_at,pending) VALUES(?,?,?,?,1) ON CONFLICT(uri) DO UPDATE SET operation_id=excluded.operation_id,pending=1")
                .bind(uri).bind(&input.owner).bind(&input.operation_id).bind(timestamp(&input.created_at)?).execute(&mut *c).await?;
            Ok(sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(&input.operation_id).fetch_one(c).await?)
        })).await
    }
}

pub(crate) async fn insert_operation(
    c: &mut SqliteConnection,
    input: &NewOperation,
) -> Result<(), StorageError> {
    let expected_uri = format!("at://{}/{}/{}", input.owner, input.collection, input.rkey);
    if input.record_uri.as_deref() != Some(expected_uri.as_str()) {
        return Err(StorageError::Invariant(
            "operation record identity mismatch",
        ));
    }
    sqlx::query("INSERT INTO operations(operation_id,owner,kind,created_at,updated_at,record_uri) VALUES(?,?,?,?,?,?)")
        .bind(&input.operation_id).bind(&input.owner).bind(&input.kind).bind(timestamp(&input.created_at)?).bind(timestamp(&input.created_at)?).bind(&input.record_uri).execute(&mut *c).await?;
    sqlx::query("INSERT INTO outbox(operation_id,owner,collection,rkey,payload_json,canonical_digest,due_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&input.operation_id).bind(&input.owner).bind(&input.collection).bind(&input.rkey).bind(&input.payload_json).bind(&input.canonical_digest).bind(timestamp(&input.created_at)?).execute(c).await?;
    Ok(())
}
