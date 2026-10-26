use super::*;
use crate::StorageError;

impl Repository {
    pub async fn put_session(&self, session: &Session) -> Result<(), StorageError> {
        let session = session.clone();
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("INSERT INTO sessions(session_hash,owner,csrf_hash,encrypted_material,created_at,expires_at) VALUES(?,?,?,?,?,?)")
                .bind(session.session_hash).bind(session.owner).bind(session.csrf_hash).bind(session.encrypted_material).bind(session.created_at).bind(session.expires_at).execute(c).await?; Ok(())
        })).await
    }
    pub async fn session(&self, hash: &str, now: i64) -> Result<Option<Session>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM sessions WHERE session_hash=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=sessions.owner)").bind(hash).bind(now).fetch_optional(&self.readers).await?)
    }
    pub async fn delete_session(&self, hash: &str) -> Result<(), StorageError> {
        let hash = hash.to_owned();
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    sqlx::query("DELETE FROM sessions WHERE session_hash=?")
                        .bind(hash)
                        .execute(c)
                        .await?;
                    Ok(())
                })
            })
            .await
    }
    pub async fn put_oauth_state(&self, state: OAuthState) -> Result<(), StorageError> {
        if state.expires_at - state.created_at != 300 {
            return Err(StorageError::Invariant(
                "OAuth state lifetime must be 300 seconds",
            ));
        }
        self.writer.execute(move |c| Box::pin(async move {
            sqlx::query("INSERT INTO oauth_states(state_hash,encrypted_material,issuer,did,created_at,expires_at) VALUES(?,?,?,?,?,?)")
                .bind(state.state_hash).bind(state.encrypted_material).bind(state.issuer).bind(state.did).bind(state.created_at).bind(state.expires_at).execute(c).await?; Ok(())
        })).await
    }
    pub async fn consume_oauth_state(
        &self,
        hash: String,
        issuer: String,
        now: i64,
    ) -> Result<Option<OAuthState>, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let state: Option<OAuthState> = sqlx::query_as("SELECT * FROM oauth_states WHERE state_hash=? AND issuer=? AND created_at<=? AND expires_at>?").bind(&hash).bind(issuer).bind(now).bind(now).fetch_optional(&mut *c).await?;
            if state.is_some() { sqlx::query("DELETE FROM oauth_states WHERE state_hash=?").bind(hash).execute(c).await?; }
            Ok(state)
        })).await
    }
    pub async fn oauth_tokens(&self, owner: &str) -> Result<Option<OAuthTokens>, StorageError> {
        Ok(sqlx::query_as("SELECT * FROM oauth_tokens WHERE owner=?")
            .bind(owner)
            .fetch_optional(&self.readers)
            .await?)
    }
    /// Generation compare-and-swap prevents a stale refresh from replacing newer material.
    pub async fn put_oauth_tokens(
        &self,
        tokens: OAuthTokens,
        expected_generation: Option<i64>,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE did=? AND NOT EXISTS(SELECT 1 FROM suppression WHERE did=?))").bind(&tokens.owner).bind(&tokens.owner).fetch_one(&mut *c).await?;
            if !allowed {return Ok(false);}
            let changed = if let Some(expected)=expected_generation {
                sqlx::query("UPDATE oauth_tokens SET encrypted_material=?,generation=?,expires_at=? WHERE owner=? AND generation=?")
                    .bind(tokens.encrypted_material).bind(tokens.generation).bind(tokens.expires_at).bind(tokens.owner).bind(expected).execute(c).await?.rows_affected()
            } else {
                sqlx::query("INSERT INTO oauth_tokens(owner,encrypted_material,generation,expires_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO NOTHING")
                    .bind(tokens.owner).bind(tokens.encrypted_material).bind(tokens.generation).bind(tokens.expires_at).execute(c).await?.rows_affected()
            }; Ok(changed==1)
        })).await
    }
}
