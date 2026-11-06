//! Shared API types and schema-v1 domain validation.

pub mod cursor;
pub mod follow;
pub mod music_key;
pub mod namespace;
pub mod scrobble;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub error: ApiError,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub request_id: String,
}
