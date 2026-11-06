//! Immediate local hiding and durable, ordered remote absence verification.
use super::{NewOperation, Operation, Repository, outbox::insert_operation, public::timestamp};
use crate::StorageError;

#[derive(Debug, Clone)]
pub enum DeletionAdmission {
    /// Signed remote absence was already recorded, or a guaranteed unsent create was cancelled.
    ConfirmedAbsent,
    CancelledUnsent,
    Pending(Operation),
    Failed(Operation),
}

impl Repository {
    /// A missing local row is not proof of remote absence. Unknown URIs are queued too.
    pub async fn admit_scrobble_deletion(
        &self,
        input: NewOperation,
    ) -> Result<DeletionAdmission, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            if input.kind != "scrobble_delete" || input.payload_json.is_some() || input.canonical_digest.is_some() {
                return Err(StorageError::Invariant("invalid scrobble deletion intent"));
            }
            let uri = input.record_uri.as_ref().ok_or(StorageError::Invariant("delete requires URI"))?;
            if uri != &format!("at://{}/{}/{}",input.owner,input.collection,input.rkey) {
                return Err(StorageError::Ownership);
            }
            let tombstone: Option<(String,Option<String>,Option<String>,bool)> = sqlx::query_as("SELECT owner,revision,operation_id,pending FROM tombstones WHERE uri=?")
                .bind(uri).fetch_optional(&mut *c).await?;
            if let Some((owner,revision,operation_id,pending)) = tombstone {
                if owner != input.owner { return Err(StorageError::Ownership); }
                if let Some(id) = operation_id {
                    let operation: Operation = sqlx::query_as("SELECT * FROM operations WHERE operation_id=? AND owner=?").bind(id).bind(&input.owner).fetch_one(&mut *c).await?;
                    match operation.state.as_str() {
                        "pending" => return Ok(DeletionAdmission::Pending(operation)),
                        "failed" if pending => return Ok(DeletionAdmission::Failed(operation)),
                        "succeeded" if !pending => return Ok(DeletionAdmission::ConfirmedAbsent),
                        _ => {}
                    }
                }
                if !pending && revision.is_some() { return Ok(DeletionAdmission::ConfirmedAbsent); }
            }
            let creates: Vec<(String,i64,Option<String>)> = sqlx::query_as("SELECT o.operation_id,o.attempts,b.locked_at FROM operations o JOIN outbox b USING(operation_id) WHERE o.owner=? AND o.record_uri=? AND o.kind='scrobble_create' AND o.state='pending'")
                .bind(&input.owner).bind(uri).fetch_all(&mut *c).await?;
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scrobbles WHERE uri=? AND confirmed=1)").bind(uri).fetch_one(&mut *c).await?;
            let never_sent = !exists && !creates.is_empty() && creates.iter().all(|(_,attempts,lock)| *attempts==0 && lock.is_none());
            insert_operation(c,&input).await?;
            for (predecessor,attempts,locked_at) in creates {
                if attempts==0 && locked_at.is_none() {
                    sqlx::query("UPDATE operations SET state='failed',failure_code='cancelled_before_publish',updated_at=? WHERE operation_id=? AND state='pending' AND attempts=0")
                        .bind(timestamp(&input.created_at)?).bind(&predecessor).execute(&mut *c).await?;
                    sqlx::query("DELETE FROM outbox WHERE operation_id=?").bind(predecessor).execute(&mut *c).await?;
                } else {
                    sqlx::query("INSERT INTO operation_dependencies(operation_id,predecessor_id) VALUES(?,?)")
                        .bind(&input.operation_id).bind(predecessor).execute(&mut *c).await?;
                }
            }
            sqlx::query("INSERT INTO tombstones(uri,owner,operation_id,created_at,pending) VALUES(?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET owner=excluded.owner,operation_id=excluded.operation_id,created_at=excluded.created_at,pending=excluded.pending")
                .bind(uri).bind(&input.owner).bind(&input.operation_id).bind(timestamp(&input.created_at)?).bind(!never_sent).execute(&mut *c).await?;
            if never_sent {
                sqlx::query("UPDATE operations SET state='succeeded' WHERE operation_id=?").bind(&input.operation_id).execute(&mut *c).await?;
                sqlx::query("DELETE FROM outbox WHERE operation_id=?").bind(input.operation_id).execute(c).await?;
                return Ok(DeletionAdmission::CancelledUnsent);
            }
            Ok(DeletionAdmission::Pending(sqlx::query_as("SELECT * FROM operations WHERE operation_id=?").bind(input.operation_id).fetch_one(c).await?))
        })).await
    }
}
