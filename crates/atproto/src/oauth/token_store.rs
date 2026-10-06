//! Authenticated encrypted OAuth persistence and per-DID refresh serialization.
//! The envelope binds purpose, owner and issuer. Secret material never implements Debug.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use atmusic_storage::{OAuthState, OAuthTokens, Repository, StorageError, User};
use base64::{Engine, engine::general_purpose::STANDARD};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Debug, thiserror::Error)]
pub enum TokenStoreError {
    #[error("OAuth encryption key must contain exactly 32 bytes")]
    InvalidKey,
    #[error("OAuth encrypted material failed authentication")]
    Authentication,
    #[error("OAuth material has an invalid shape")]
    InvalidMaterial,
    #[error("secure randomness unavailable")]
    Randomness,
    #[error("OAuth refresh concurrency capacity exceeded")]
    ServiceBusy,
    #[error("OAuth refresh failed")]
    RefreshFailed,
    #[error("OAuth refresh requires sign-in")]
    SignInRequired,
    #[error("OAuth storage failed: {0}")]
    Storage(#[from] StorageError),
}
#[derive(Debug)]
pub enum RefreshFailure {
    InvalidGrant,
    Failed,
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    issuer: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone)]
pub struct TokenStore {
    repository: Repository,
    state_cipher: Arc<Aes256Gcm>,
    token_cipher: Arc<Aes256Gcm>,
    refresh_locks: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
}
impl TokenStore {
    pub fn new(repository: Repository, master_key: &[u8]) -> Result<Self, TokenStoreError> {
        if master_key.len() != 32 {
            return Err(TokenStoreError::InvalidKey);
        }
        let hkdf = Hkdf::<Sha256>::new(Some(b"atmusic/oauth/encryption/v1"), master_key);
        let mut state_key = [0u8; 32];
        let mut token_key = [0u8; 32];
        hkdf.expand(b"state", &mut state_key)
            .map_err(|_| TokenStoreError::InvalidKey)?;
        hkdf.expand(b"tokens", &mut token_key)
            .map_err(|_| TokenStoreError::InvalidKey)?;
        Ok(Self {
            repository,
            state_cipher: Arc::new(
                Aes256Gcm::new_from_slice(&state_key).map_err(|_| TokenStoreError::InvalidKey)?,
            ),
            token_cipher: Arc::new(
                Aes256Gcm::new_from_slice(&token_key).map_err(|_| TokenStoreError::InvalidKey)?,
            ),
            refresh_locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    pub async fn put_oauth_state(
        &self,
        id: &str,
        payload: &Value,
        created_at: i64,
    ) -> Result<(), TokenStoreError> {
        let did = string(payload, "expected_did", "expectedDid")?;
        let issuer = string(payload, "issuer", "issuer")?;
        let hash = hash(id);
        let encrypted_material = seal(&self.state_cipher, "state", &hash, &issuer, payload)?;
        self.repository
            .put_oauth_state(OAuthState {
                state_hash: hash,
                encrypted_material,
                issuer,
                did,
                created_at,
                expires_at: created_at
                    .checked_add(300)
                    .ok_or(TokenStoreError::InvalidMaterial)?,
            })
            .await?;
        Ok(())
    }
    /// Persist PAR's authorization nonce without extending the state's expiry.
    pub async fn update_oauth_state(
        &self,
        id: &str,
        payload: &Value,
    ) -> Result<bool, TokenStoreError> {
        let did = string(payload, "expected_did", "expectedDid")?;
        let issuer = string(payload, "issuer", "issuer")?;
        let hash = hash(id);
        let encrypted_material = seal(&self.state_cipher, "state", &hash, &issuer, payload)?;
        Ok(self
            .repository
            .update_oauth_state(OAuthState {
                state_hash: hash,
                encrypted_material,
                issuer,
                did,
                created_at: 0,
                expires_at: 0,
            })
            .await?)
    }
    pub async fn consume_oauth_state(
        &self,
        id: &str,
        now: i64,
    ) -> Result<Option<Value>, TokenStoreError> {
        let hash = hash(id);
        let Some(state) = self.repository.take_oauth_state(hash.clone(), now).await? else {
            return Ok(None);
        };
        let value = open(
            &self.state_cipher,
            "state",
            &hash,
            &state.encrypted_material,
        )?;
        if string(&value, "issuer", "issuer")? != state.issuer
            || string(&value, "expected_did", "expectedDid")? != state.did
        {
            return Err(TokenStoreError::Authentication);
        }
        Ok(Some(value))
    }
    pub async fn put_oauth_tokens(
        &self,
        did: &str,
        payload: &Value,
        now: i64,
    ) -> Result<(), TokenStoreError> {
        let _guard = self.refresh_guard(did).await?;
        self.save_tokens(did, payload, now).await
    }
    pub async fn get_oauth_tokens(&self, did: &str) -> Result<Option<Value>, TokenStoreError> {
        let Some(row) = self.repository.oauth_tokens(did).await? else {
            return Ok(None);
        };
        let payload = open(&self.token_cipher, "tokens", did, &row.encrypted_material)?;
        if string(&payload, "did", "did")? != did {
            return Err(TokenStoreError::Authentication);
        }
        Ok(Some(payload))
    }
    /// Fresh callback authorization is the sole path that lifts local disconnect suppression.
    pub async fn put_authorized_oauth_tokens(
        &self,
        did: &str,
        payload: &Value,
        now: i64,
    ) -> Result<(), TokenStoreError> {
        let _guard = self.refresh_guard(did).await?;
        let tokens = self.encrypt_tokens(did, payload, 0)?;
        let joined = chrono::DateTime::from_timestamp(now, 0)
            .ok_or(TokenStoreError::InvalidMaterial)?
            .to_rfc3339();
        self.repository
            .install_authorized_oauth(User::new(did, joined), tokens)
            .await?;
        Ok(())
    }
    pub async fn remove_oauth_tokens(&self, did: &str) -> Result<(), TokenStoreError> {
        let _guard = self.refresh_guard(did).await?;
        self.repository.invalidate_oauth(did.into()).await?;
        Ok(())
    }
    /// A response using an old access token cannot overwrite a newer rotation.
    pub async fn update_resource_nonce(
        &self,
        did: &str,
        access_token: &str,
        nonce: Option<String>,
        now: i64,
    ) -> Result<(), TokenStoreError> {
        let _guard = self.refresh_guard(did).await?;
        let Some(mut payload) = self.get_oauth_tokens(did).await? else {
            return Ok(());
        };
        if payload.get("access_token").and_then(Value::as_str) != Some(access_token) {
            return Ok(());
        }
        payload
            .as_object_mut()
            .ok_or(TokenStoreError::InvalidMaterial)?
            .insert(
                "resource_nonce".into(),
                nonce.map_or(Value::Null, Value::String),
            );
        self.save_tokens(did, &payload, now).await
    }
    /// Mark the rejected access token expired without disturbing a concurrent rotation.
    pub async fn mark_access_expired(
        &self,
        did: &str,
        access_token: &str,
        now: i64,
    ) -> Result<(), TokenStoreError> {
        let _guard = self.refresh_guard(did).await?;
        let Some(mut payload) = self.get_oauth_tokens(did).await? else {
            return Ok(());
        };
        if payload.get("access_token").and_then(Value::as_str) != Some(access_token) {
            return Ok(());
        }
        payload
            .as_object_mut()
            .ok_or(TokenStoreError::InvalidMaterial)?
            .insert("expires_at".into(), Value::from(now));
        self.save_tokens(did, &payload, now).await
    }
    /// Prevent refresh/revoke races and invalidate local auth after every remote outcome.
    pub async fn revoke_tokens<F, Fut>(&self, did: &str, revoke: F) -> Result<(), TokenStoreError>
    where
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = Result<(), TokenStoreError>>,
    {
        let _guard = self.refresh_guard(did).await?;
        let previous = self.repository.oauth_tokens(did).await?;
        let result = match self.get_oauth_tokens(did).await {
            Ok(Some(material)) => revoke(material).await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        if let Some(previous) = previous {
            self.repository
                .invalidate_oauth_if_current(previous)
                .await?;
        }
        result
    }
    pub async fn refresh_guard(&self, did: &str) -> Result<OwnedMutexGuard<()>, TokenStoreError> {
        let lock = {
            let mut locks = self
                .refresh_locks
                .lock()
                .map_err(|_| TokenStoreError::ServiceBusy)?;
            locks.retain(|_, v| v.strong_count() > 0);
            if let Some(lock) = locks.get(did).and_then(Weak::upgrade) {
                lock
            } else {
                if locks.len() >= 1024 {
                    return Err(TokenStoreError::ServiceBusy);
                }
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(did.into(), Arc::downgrade(&lock));
                lock
            }
        };
        Ok(lock.lock_owned().await)
    }
    /// Lock, re-read and refresh only if still expired. A rotated response replaces the
    /// whole authenticated envelope before any waiting request obtains the new token.
    pub async fn fresh_tokens<F, Fut>(
        &self,
        did: &str,
        now: i64,
        refresh: F,
    ) -> Result<Option<Value>, TokenStoreError>
    where
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = Result<Value, RefreshFailure>>,
    {
        let _guard = self.refresh_guard(did).await?;
        let Some(previous) = self.repository.oauth_tokens(did).await? else {
            return Ok(None);
        };
        let current = open(
            &self.token_cipher,
            "tokens",
            did,
            &previous.encrypted_material,
        )?;
        if string(&current, "did", "did")? != did {
            return Err(TokenStoreError::Authentication);
        }
        if expiry(&current)? > now {
            return Ok(Some(current));
        }
        let old_issuer = string(&current, "issuer", "issuer")?;
        match refresh(current).await {
            Ok(rotated) => {
                if string(&rotated, "issuer", "issuer")? != old_issuer || expiry(&rotated)? <= now {
                    return Err(TokenStoreError::InvalidMaterial);
                }
                let tokens = self.encrypt_tokens(did, &rotated, previous.generation + 1)?;
                if !self
                    .repository
                    .replace_oauth_tokens(tokens, previous)
                    .await?
                {
                    return Err(TokenStoreError::SignInRequired);
                }
                Ok(Some(rotated))
            }
            Err(RefreshFailure::InvalidGrant) => {
                self.repository
                    .invalidate_oauth_if_current(previous)
                    .await?;
                Err(TokenStoreError::SignInRequired)
            }
            Err(RefreshFailure::Failed) => Err(TokenStoreError::RefreshFailed),
        }
    }
    async fn save_tokens(
        &self,
        did: &str,
        payload: &Value,
        now: i64,
    ) -> Result<(), TokenStoreError> {
        let previous = self.repository.oauth_tokens(did).await?;
        let generation = previous.as_ref().map_or(0, |t| t.generation + 1);
        let tokens = self.encrypt_tokens(did, payload, generation)?;
        let saved = if let Some(previous) = previous {
            self.repository
                .replace_oauth_tokens(tokens, previous)
                .await?
        } else {
            let joined = chrono::DateTime::from_timestamp(now, 0)
                .ok_or(TokenStoreError::InvalidMaterial)?
                .to_rfc3339();
            self.repository
                .initialize_oauth_tokens(User::new(did, joined), tokens)
                .await?
        };
        if !saved {
            return Err(TokenStoreError::Storage(StorageError::InvalidTransition));
        }
        Ok(())
    }
    fn encrypt_tokens(
        &self,
        did: &str,
        payload: &Value,
        generation: i64,
    ) -> Result<OAuthTokens, TokenStoreError> {
        if string(payload, "did", "did")? != did {
            return Err(TokenStoreError::InvalidMaterial);
        }
        let issuer = string(payload, "issuer", "issuer")?;
        Ok(OAuthTokens {
            owner: did.into(),
            encrypted_material: seal(&self.token_cipher, "tokens", did, &issuer, payload)?,
            generation,
            expires_at: expiry(payload)?,
        })
    }
}
fn string(payload: &Value, snake: &str, camel: &str) -> Result<String, TokenStoreError> {
    payload
        .get(snake)
        .or_else(|| payload.get(camel))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or(TokenStoreError::InvalidMaterial)
}
fn expiry(payload: &Value) -> Result<i64, TokenStoreError> {
    payload
        .get("expires_at")
        .or_else(|| payload.get("expiresAt"))
        .and_then(Value::as_i64)
        .ok_or(TokenStoreError::InvalidMaterial)
}
fn hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn aad(kind: &str, owner: &str, issuer: &str) -> Vec<u8> {
    let mut bytes = b"atmusic/oauth/aes-256-gcm/v1".to_vec();
    for value in [kind, owner, issuer] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes
}
fn seal(
    cipher: &Aes256Gcm,
    kind: &str,
    owner: &str,
    issuer: &str,
    payload: &Value,
) -> Result<Vec<u8>, TokenStoreError> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| TokenStoreError::Randomness)?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| TokenStoreError::InvalidMaterial)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad(kind, owner, issuer),
            },
        )
        .map_err(|_| TokenStoreError::Authentication)?;
    serde_json::to_vec(&Envelope {
        version: 1,
        issuer: issuer.into(),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| TokenStoreError::InvalidMaterial)
}
fn open(
    cipher: &Aes256Gcm,
    kind: &str,
    owner: &str,
    envelope: &[u8],
) -> Result<Value, TokenStoreError> {
    let envelope: Envelope =
        serde_json::from_slice(envelope).map_err(|_| TokenStoreError::Authentication)?;
    if envelope.version != 1 {
        return Err(TokenStoreError::Authentication);
    }
    let nonce = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| TokenStoreError::Authentication)?;
    if nonce.len() != 12 {
        return Err(TokenStoreError::Authentication);
    }
    let ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| TokenStoreError::Authentication)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(kind, owner, &envelope.issuer),
            },
        )
        .map_err(|_| TokenStoreError::Authentication)?;
    let payload: Value =
        serde_json::from_slice(&plaintext).map_err(|_| TokenStoreError::Authentication)?;
    if string(&payload, "issuer", "issuer")? != envelope.issuer {
        return Err(TokenStoreError::Authentication);
    }
    Ok(payload)
}
