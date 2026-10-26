//! Schema-v1 custom music follows and deterministic record keys.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    namespace::Namespace,
    scrobble::{ValidationError, record_object, required_string, validate_timestamp},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowRecord {
    #[serde(rename = "$type")]
    pub record_type: String,
    pub subject: String,
    pub created_at: String,
}

impl FollowRecord {
    pub fn new(
        subject: impl Into<String>,
        namespace: &Namespace,
        receipt_time: DateTime<Utc>,
    ) -> Result<Self, ValidationError> {
        let subject = subject.into();
        validate_did_syntax(&subject)?;
        Ok(Self {
            record_type: namespace.follow_collection(),
            subject,
            created_at: receipt_time.to_rfc3339_opts(SecondsFormat::AutoSi, true),
        })
    }

    pub fn from_json(
        value: &Value,
        namespace: &Namespace,
        receipt_time: DateTime<Utc>,
    ) -> Result<Self, ValidationError> {
        let object = record_object(value)?;
        let record_type = required_string(object, "$type")?;
        if record_type != namespace.follow_collection() {
            return Err(ValidationError::new(
                "$type",
                "record type does not match the configured music-follow collection",
            ));
        }
        let subject = required_string(object, "subject")?;
        validate_did_syntax(&subject)?;
        let created_at = required_string(object, "createdAt")?;
        validate_timestamp("createdAt", &created_at, receipt_time)?;
        Ok(Self {
            record_type,
            subject,
            created_at,
        })
    }
}

/// Checks DID syntax, not identity resolution, ownership, or repository verification.
pub fn validate_did_syntax(subject: &str) -> Result<(), ValidationError> {
    let invalid = || ValidationError::new("subject", "expected a DID");
    if subject.len() > 2_048 {
        return Err(invalid());
    }
    let rest = subject.strip_prefix("did:").ok_or_else(invalid)?;
    let (method, identifier) = rest.split_once(':').ok_or_else(invalid)?;
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_lowercase()) || identifier.is_empty()
    {
        return Err(invalid());
    }
    let bytes = identifier.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if bytes.get(index + 1).is_none_or(|b| !b.is_ascii_hexdigit())
                || bytes.get(index + 2).is_none_or(|b| !b.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
            index += 3;
        } else if byte.is_ascii_alphanumeric() || b"._-:".contains(&byte) {
            index += 1;
        } else {
            return Err(invalid());
        }
    }
    if bytes.last() == Some(&b':') {
        return Err(invalid());
    }
    Ok(())
}

/// Identical subjects always address the same valid AT record key.
pub fn follow_rkey(subject: &str) -> Result<String, ValidationError> {
    validate_did_syntax(subject)?;
    Ok(format!("f{:x}", Sha256::digest(subject.as_bytes())))
}
