use crate::http::error::{HttpError, RequestId};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Domain-separated CSRF secret; recoverable only with the session cookie and application key.
pub fn token(application_key: &[u8; 32], session_token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(application_key).expect("HMAC key length");
    mac.update(b"atmusic.csrf.v1\0");
    mac.update(session_token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn validate(
    headers: &HeaderMap,
    origin: &str,
    application_key: &[u8; 32],
    session_token: &str,
    request_id: &RequestId,
) -> Result<(), HttpError> {
    let deny = || {
        HttpError::new(
            StatusCode::FORBIDDEN,
            "csrf_failed",
            "Origin and CSRF token must match the authenticated session.",
            request_id,
        )
    };
    if headers.get_all("origin").iter().count() != 1
        || headers.get_all("x-csrf-token").iter().count() != 1
    {
        return Err(deny());
    }
    if headers.get("origin").and_then(|value| value.to_str().ok())
        != Some(origin.trim_end_matches('/'))
    {
        return Err(deny());
    }
    let supplied = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| hex::decode(value).ok())
        .ok_or_else(deny)?;
    let mut mac = HmacSha256::new_from_slice(application_key).expect("HMAC key length");
    mac.update(b"atmusic.csrf.v1\0");
    mac.update(session_token.as_bytes());
    mac.verify_slice(&supplied).map_err(|_| deny())
}
