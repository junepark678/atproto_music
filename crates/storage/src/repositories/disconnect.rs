//! Local account removal and explicit reconnect/backfill admission.
use super::public::timestamp;
use super::*;
use crate::StorageError;
impl Repository {
    pub async fn disconnect(&self, owner: String, now: String) -> Result<(), StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("INSERT INTO suppression(did,suppressed_at) VALUES(?,?) ON CONFLICT(did) DO UPDATE SET suppressed_at=excluded.suppressed_at").bind(&owner).bind(timestamp(&now)?).execute(&mut *c).await?;
            // Cascades remove secrets, indexed rows, idempotency, operations and outbox atomically.
            sqlx::query("DELETE FROM users WHERE did=?").bind(&owner).execute(&mut *c).await?;
            sqlx::query("DELETE FROM oauth_states WHERE did=?").bind(&owner).execute(&mut *c).await?;
            sqlx::query("DELETE FROM indexing_status WHERE scope=?").bind(&owner).execute(c).await?;
            Ok(())
        })).await
    }
    /// Called after fresh OAuth authorization. Current status still requires reconciliation.
    pub async fn reconnect(&self, user: User) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    sqlx::query("DELETE FROM suppression WHERE did=?")
                        .bind(&user.did)
                        .execute(&mut *c)
                        .await?;
                    let mut user = user;
                    user.indexing_state = "recovering".into();
                    user.revision = None;
                    super::public::upsert_user(c, &user).await?;
                    super::backfill::request_backfill(c, &user.did, true, &user.joined_at).await?;
                    Ok(())
                })
            })
            .await
    }
    pub async fn is_suppressed(&self, owner: &str) -> Result<bool, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)")
                .bind(owner)
                .fetch_one(&self.readers)
                .await?,
        )
    }
}
