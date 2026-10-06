//! Authenticated cursors for descending, current-record pagination.
//!
//! A traversal retains its first-page upper tuple and `asOf`, then excludes
//! tuples at or above the last returned tuple. This excludes newer arrivals;
//! it does not freeze records which are subsequently deleted or reordered.

use std::{cmp::Ordering, error::Error, fmt};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const VERSION: u8 = 1;
const KEY_CONTEXT: &[u8] = b"atmusic:cursor:hmac-sha256:v1";
const MAX_TOKEN_BYTES: usize = 32_768;
const MAX_PAYLOAD_BYTES: usize = 16_384;
const MAX_FIELD_BYTES: usize = 4_096;

/// Invalid cursors deliberately have one public error, independent of cause.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorError {
    InvalidCursor,
    InvalidKey,
}

impl fmt::Display for CursorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCursor => "invalid_cursor",
            Self::InvalidKey => "cursor application key must contain at least 32 bytes",
        })
    }
}

impl Error for CursorError {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorQuery {
    History,
    Feed,
    Following,
    Followers,
}

/// Identity and route context authenticated with every page boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorBinding {
    pub query: CursorQuery,
    pub did: Option<String>,
    pub scope: Option<String>,
    pub viewer: Option<String>,
}

impl CursorBinding {
    pub fn history(did: impl Into<String>) -> Self {
        Self::public_user(CursorQuery::History, did)
    }

    pub fn global_feed() -> Self {
        Self {
            query: CursorQuery::Feed,
            did: None,
            scope: Some("global".into()),
            viewer: None,
        }
    }

    pub fn following_feed(viewer: impl Into<String>) -> Self {
        Self {
            query: CursorQuery::Feed,
            did: None,
            scope: Some("following".into()),
            viewer: Some(viewer.into()),
        }
    }

    pub fn following(did: impl Into<String>) -> Self {
        Self::public_user(CursorQuery::Following, did)
    }

    pub fn followers(did: impl Into<String>) -> Self {
        Self::public_user(CursorQuery::Followers, did)
    }

    fn public_user(query: CursorQuery, did: impl Into<String>) -> Self {
        Self {
            query,
            did: Some(did.into()),
            scope: None,
            viewer: None,
        }
    }

    fn validate(&self) -> Result<(), CursorError> {
        let valid_did = |value: Option<&str>| {
            value.is_some_and(|value| crate::follow::validate_did_syntax(value).is_ok())
        };
        let valid = match self.query {
            CursorQuery::History | CursorQuery::Following | CursorQuery::Followers => {
                valid_did(self.did.as_deref()) && self.scope.is_none() && self.viewer.is_none()
            }
            CursorQuery::Feed => {
                self.did.is_none()
                    && match self.scope.as_deref() {
                        Some("global") => self.viewer.is_none(),
                        Some("following") => valid_did(self.viewer.as_deref()),
                        _ => false,
                    }
            }
        };
        if valid {
            Ok(())
        } else {
            Err(CursorError::InvalidCursor)
        }
    }
}

/// An ordering timestamp plus the full AT URI, compared in that order.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorPosition {
    pub timestamp: String,
    pub uri: String,
}

impl CursorPosition {
    pub fn new(timestamp: impl Into<String>, uri: impl Into<String>) -> Result<Self, CursorError> {
        Self {
            timestamp: timestamp.into(),
            uri: uri.into(),
        }
        .normalized()
    }

    /// Ascending tuple comparison; read queries reverse this for DESC ordering.
    /// Parsing instants avoids mistakes caused by different fractional precision.
    pub fn compare(&self, other: &Self) -> Result<Ordering, CursorError> {
        self.validate()?;
        other.validate()?;
        Ok(parse_timestamp(&self.timestamp)?
            .cmp(&parse_timestamp(&other.timestamp)?)
            .then_with(|| self.uri.cmp(&other.uri)))
    }

    fn validate(&self) -> Result<(), CursorError> {
        parse_timestamp(&self.timestamp)?;
        if self.uri.starts_with("at://") && valid_field(&self.uri) {
            Ok(())
        } else {
            Err(CursorError::InvalidCursor)
        }
    }

    fn normalized(mut self) -> Result<Self, CursorError> {
        self.validate()?;
        self.timestamp = canonical_timestamp(&self.timestamp)?;
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCursor {
    pub binding: CursorBinding,
    pub upper: CursorPosition,
    pub last: CursorPosition,
    pub as_of: String,
}

impl PageCursor {
    pub fn new(
        binding: CursorBinding,
        upper: CursorPosition,
        last: CursorPosition,
        as_of: impl Into<String>,
    ) -> Result<Self, CursorError> {
        Self {
            binding,
            upper,
            last,
            as_of: as_of.into(),
        }
        .normalized()
    }

    /// The current row must be <= the initial upper bound and < the last row.
    /// Availability, deletion and query membership remain storage predicates.
    pub fn contains(&self, position: &CursorPosition) -> Result<bool, CursorError> {
        self.validate()?;
        Ok(position.compare(&self.upper)? != Ordering::Greater
            && position.compare(&self.last)? == Ordering::Less)
    }

    /// Advance without changing the original anchor, binding or frozen `asOf`.
    pub fn advance(&self, last: CursorPosition) -> Result<Self, CursorError> {
        if !self.contains(&last)? {
            return Err(CursorError::InvalidCursor);
        }
        Self::new(
            self.binding.clone(),
            self.upper.clone(),
            last,
            self.as_of.clone(),
        )
    }

    fn validate(&self) -> Result<(), CursorError> {
        self.binding.validate()?;
        parse_timestamp(&self.as_of)?;
        if self.last.compare(&self.upper)? == Ordering::Greater {
            return Err(CursorError::InvalidCursor);
        }
        Ok(())
    }

    fn normalized(mut self) -> Result<Self, CursorError> {
        self.validate()?;
        self.upper = self.upper.normalized()?;
        self.last = self.last.normalized()?;
        self.as_of = canonical_timestamp(&self.as_of)?;
        Ok(self)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CursorPayload {
    version: u8,
    binding: CursorBinding,
    upper: CursorPosition,
    last: CursorPosition,
    as_of: String,
}

/// HMAC-SHA256 over the exact JSON bytes, using a domain-separated derived key.
/// The application key and derived key are never serialized or included in Debug.
#[derive(Clone)]
pub struct CursorCodec {
    key: [u8; 32],
}

impl CursorCodec {
    /// Application keys must contain at least 256 bits of secure random material.
    pub fn from_application_key(application_key: &[u8]) -> Result<Self, CursorError> {
        if application_key.len() < 32 {
            return Err(CursorError::InvalidKey);
        }
        let mut derivation =
            HmacSha256::new_from_slice(application_key).map_err(|_| CursorError::InvalidKey)?;
        derivation.update(KEY_CONTEXT);
        Ok(Self {
            key: derivation.finalize().into_bytes().into(),
        })
    }

    /// The token is `base64url(JSON).base64url(HMAC)` without padding.
    pub fn encode(&self, cursor: &PageCursor) -> Result<String, CursorError> {
        let cursor = cursor.clone().normalized()?;
        let payload = serde_json::to_vec(&CursorPayload {
            version: VERSION,
            binding: cursor.binding,
            upper: cursor.upper,
            last: cursor.last,
            as_of: cursor.as_of,
        })
        .map_err(|_| CursorError::InvalidCursor)?;
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(CursorError::InvalidCursor);
        }
        let mut mac = self.mac()?;
        mac.update(&payload);
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }

    /// Authenticate before decoding JSON, then enforce the caller's route context.
    /// Callers map every failure to HTTP 400 `invalid_cursor`; never reset a page.
    pub fn decode(
        &self,
        token: &str,
        expected_binding: &CursorBinding,
    ) -> Result<PageCursor, CursorError> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(CursorError::InvalidCursor);
        }
        expected_binding.validate()?;
        let (payload, signature) = token.split_once('.').ok_or(CursorError::InvalidCursor)?;
        let payload = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| CursorError::InvalidCursor)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| CursorError::InvalidCursor)?;
        if payload.is_empty() || payload.len() > MAX_PAYLOAD_BYTES || signature.len() != 32 {
            return Err(CursorError::InvalidCursor);
        }
        let mut mac = self.mac()?;
        mac.update(&payload);
        mac.verify_slice(&signature)
            .map_err(|_| CursorError::InvalidCursor)?;

        let payload: CursorPayload =
            serde_json::from_slice(&payload).map_err(|_| CursorError::InvalidCursor)?;
        if payload.version != VERSION || &payload.binding != expected_binding {
            return Err(CursorError::InvalidCursor);
        }
        PageCursor::new(payload.binding, payload.upper, payload.last, payload.as_of)
    }

    fn mac(&self) -> Result<HmacSha256, CursorError> {
        HmacSha256::new_from_slice(&self.key).map_err(|_| CursorError::InvalidCursor)
    }
}

fn valid_field(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FIELD_BYTES
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, CursorError> {
    if value.len() > 64 || value.ends_with("-00:00") {
        return Err(CursorError::InvalidCursor);
    }
    let timestamp = DateTime::parse_from_rfc3339(value).map_err(|_| CursorError::InvalidCursor)?;
    if timestamp.offset().local_minus_utc() != 0 || !(1970..=9999).contains(&timestamp.year()) {
        return Err(CursorError::InvalidCursor);
    }
    Ok(timestamp.with_timezone(&Utc))
}

fn canonical_timestamp(value: &str) -> Result<String, CursorError> {
    Ok(parse_timestamp(value)?.to_rfc3339_opts(SecondsFormat::Nanos, true))
}
