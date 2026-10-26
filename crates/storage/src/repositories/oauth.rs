//! Atomic consumption and revocation primitives for encrypted OAuth material.
use super::*;
use crate::StorageError;
impl Repository {
    /// Compare the full previous envelope as well as its counter: disconnect/reconnect
    /// must not create an ABA match for a refresh that was already in flight.
    pub async fn replace_oauth_tokens(
        &self,
        tokens: OAuthTokens,
        previous: OAuthTokens,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c|Box::pin(async move {
            if tokens.owner!=previous.owner {return Err(StorageError::Ownership);}
            Ok(sqlx::query("UPDATE oauth_tokens SET encrypted_material=?,generation=?,expires_at=? WHERE owner=? AND generation=? AND encrypted_material=? AND NOT EXISTS(SELECT 1 FROM suppression WHERE did=oauth_tokens.owner)")
                .bind(tokens.encrypted_material).bind(tokens.generation).bind(tokens.expires_at).bind(tokens.owner).bind(previous.generation).bind(previous.encrypted_material).execute(c).await?.rows_affected()==1)
        })).await
    }
    /// First material installation cannot recreate an account disconnected meanwhile.
    pub async fn initialize_oauth_tokens(
        &self,
        user: User,
        tokens: OAuthTokens,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c|Box::pin(async move {
            if user.did!=tokens.owner {return Err(StorageError::Ownership);}
            if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM suppression WHERE did=?)").bind(&user.did).fetch_one(&mut *c).await? {return Ok(false);}
            if !sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM users WHERE did=?)").bind(&user.did).fetch_one(&mut *c).await? {super::public::upsert_user(c,&user).await?;}
            let changed=sqlx::query("INSERT INTO oauth_tokens(owner,encrypted_material,generation,expires_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO NOTHING")
                .bind(tokens.owner).bind(tokens.encrypted_material).bind(tokens.generation).bind(tokens.expires_at).execute(c).await?.rows_affected();
            Ok(changed==1)
        })).await
    }
    /// Only the successfully validated OAuth callback installs material through this gate.
    /// Clearing suppression, recovery admission and material persistence share one commit.
    pub async fn install_authorized_oauth(
        &self,
        user: User,
        tokens: OAuthTokens,
    ) -> Result<(), StorageError> {
        self.writer.execute(move |c|Box::pin(async move {
            if user.did!=tokens.owner {return Err(StorageError::Ownership);}
            let suppressed=sqlx::query("DELETE FROM suppression WHERE did=?").bind(&user.did).execute(&mut *c).await?.rows_affected()>0;
            let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE did=?)").bind(&user.did).fetch_one(&mut *c).await?;
            if !exists {super::public::upsert_user(c,&user).await?;}
            super::backfill::request_backfill(c,&user.did,suppressed || !exists,&user.joined_at).await?;
            sqlx::query("INSERT INTO oauth_tokens(owner,encrypted_material,generation,expires_at) VALUES(?,?,0,?) ON CONFLICT(owner) DO UPDATE SET encrypted_material=excluded.encrypted_material,generation=oauth_tokens.generation+1,expires_at=excluded.expires_at")
                .bind(tokens.owner).bind(tokens.encrypted_material).bind(tokens.expires_at).execute(c).await?;
            Ok(())
        })).await
    }
    /// Update an authorization nonce while preserving the original state lifetime.
    pub async fn update_oauth_state(&self, state: OAuthState) -> Result<bool, StorageError> {
        self.writer.execute(move |c| Box::pin(async move {
            let changed=sqlx::query("UPDATE oauth_states SET encrypted_material=? WHERE state_hash=? AND issuer=? AND did=?")
                .bind(state.encrypted_material).bind(state.state_hash).bind(state.issuer).bind(state.did).execute(c).await?.rows_affected();
            Ok(changed==1)
        })).await
    }
    /// Deletes expired state as well; the caller performs issuer binding after decryption.
    pub async fn take_oauth_state(
        &self,
        hash: String,
        now: i64,
    ) -> Result<Option<OAuthState>, StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    let state: Option<OAuthState> =
                        sqlx::query_as("SELECT * FROM oauth_states WHERE state_hash=?")
                            .bind(&hash)
                            .fetch_optional(&mut *c)
                            .await?;
                    sqlx::query("DELETE FROM oauth_states WHERE state_hash=?")
                        .bind(hash)
                        .execute(c)
                        .await?;
                    Ok(state.filter(|s| s.created_at <= now && now < s.expires_at))
                })
            })
            .await
    }
    /// A revoked/invalid refresh token invalidates every local session for its owner.
    pub async fn invalidate_oauth(&self, owner: String) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    sqlx::query("DELETE FROM oauth_tokens WHERE owner=?")
                        .bind(&owner)
                        .execute(&mut *c)
                        .await?;
                    sqlx::query("DELETE FROM sessions WHERE owner=?")
                        .bind(owner)
                        .execute(c)
                        .await?;
                    Ok(())
                })
            })
            .await
    }
    /// An old invalid-grant/revoke response cannot invalidate fresh authorization.
    pub async fn invalidate_oauth_if_current(
        &self,
        previous: OAuthTokens,
    ) -> Result<bool, StorageError> {
        self.writer.execute(move |c|Box::pin(async move {
            let matches:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM oauth_tokens WHERE owner=? AND generation=? AND encrypted_material=?)")
                .bind(&previous.owner).bind(previous.generation).bind(previous.encrypted_material).fetch_one(&mut *c).await?;
            if !matches {return Ok(false);}
            sqlx::query("DELETE FROM oauth_tokens WHERE owner=?").bind(&previous.owner).execute(&mut *c).await?;
            sqlx::query("DELETE FROM sessions WHERE owner=?").bind(previous.owner).execute(c).await?;
            Ok(true)
        })).await
    }
    pub async fn delete_oauth_tokens(&self, owner: String) -> Result<(), StorageError> {
        self.writer
            .execute(move |c| {
                Box::pin(async move {
                    sqlx::query("DELETE FROM oauth_tokens WHERE owner=?")
                        .bind(owner)
                        .execute(c)
                        .await?;
                    Ok(())
                })
            })
            .await
    }
}
