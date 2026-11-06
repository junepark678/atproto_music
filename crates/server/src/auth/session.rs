//! Seven-day opaque sessions; only one-way hashes are persisted.
use crate::{
    AppState,
    auth::csrf,
    http::error::{HttpError, RequestId},
};
use atmusic_storage::{Database, Session};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const COOKIE_NAME: &str = "atmusic_session";
pub const SESSION_LIFETIME: i64 = 7 * 24 * 60 * 60;

pub struct IssuedSession {
    pub cookie: String,
    pub csrf_token: String,
    pub expires_at: DateTime<Utc>,
}
pub struct AuthenticatedSession {
    pub did: String,
    pub session_hash: String,
    pub csrf_token: String,
    pub expires_at: DateTime<Utc>,
    raw_token: String,
}
impl AuthenticatedSession {
    pub fn require_csrf(
        &self,
        headers: &HeaderMap,
        state: &AppState,
        id: &RequestId,
    ) -> Result<(), HttpError> {
        let config = state
            .config
            .as_ref()
            .ok_or_else(|| HttpError::storage(id))?;
        csrf::validate(
            headers,
            config.public_origin.as_str(),
            config.encryption_key(),
            &self.raw_token,
            id,
        )
    }
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn fresh_token() -> String {
    // Two independent random UUIDv4 values supply 244 random bits; no account identifier is encoded.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub async fn issue(
    database: &Database,
    application_key: &[u8; 32],
    did: &str,
    now: DateTime<Utc>,
) -> Result<IssuedSession, atmusic_storage::StorageError> {
    let raw_token = fresh_token();
    let csrf_token = csrf::token(application_key, &raw_token);
    let expires_at = now + chrono::Duration::seconds(SESSION_LIFETIME);
    database
        .repositories()
        .put_session(&Session {
            session_hash: hash(&raw_token),
            owner: did.into(),
            csrf_hash: hash(&csrf_token),
            encrypted_material: vec![],
            created_at: now.timestamp(),
            expires_at: expires_at.timestamp(),
        })
        .await?;
    Ok(IssuedSession {
        cookie: format!(
            "{COOKIE_NAME}={raw_token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_LIFETIME}"
        ),
        csrf_token,
        expires_at,
    })
}

pub async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    id: &RequestId,
) -> Result<AuthenticatedSession, HttpError> {
    let unauthorized = || {
        HttpError::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "A valid application session is required.",
            id,
        )
    };
    if headers
        .get_all("cookie")
        .iter()
        .any(|value| value.to_str().is_err())
    {
        return Err(unauthorized());
    }
    let mut tokens = headers
        .get_all("cookie")
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value);
    let raw_token = tokens.next().ok_or_else(unauthorized)?;
    if tokens.next().is_some()
        || raw_token.len() != 64
        || !raw_token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(unauthorized());
    }
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(id))?;
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(id))?;
    let session_hash = hash(raw_token);
    let session = database
        .repositories()
        .session(&session_hash, state.clock.now().timestamp())
        .await
        .map_err(|_| HttpError::storage(id))?
        .ok_or_else(unauthorized)?;
    let csrf_token = csrf::token(config.encryption_key(), raw_token);
    if hash(&csrf_token) != session.csrf_hash {
        return Err(unauthorized());
    }
    Ok(AuthenticatedSession {
        did: session.owner,
        session_hash,
        csrf_token,
        expires_at: DateTime::from_timestamp(session.expires_at, 0).ok_or_else(unauthorized)?,
        raw_token: raw_token.into(),
    })
}

pub async fn get_session(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let session = authenticate(&state, &headers, &id).await?;
    let user = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories()
        .user(&session.did)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    Ok(([("cache-control","no-store")],Json(
        json!({"did":session.did, "handle": user.and_then(|user| user.handle), "csrfToken":session.csrf_token,
        "expiresAt":session.expires_at.to_rfc3339_opts(SecondsFormat::Secs,true)}),
    )).into_response())
}
