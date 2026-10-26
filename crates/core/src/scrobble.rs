//! Local input and remote-record validation against an explicitly supplied clock.

use std::{error::Error, fmt};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::namespace::Namespace;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ValidationError {
    pub field: String,
    pub code: &'static str,
    pub message: &'static str,
}

impl ValidationError {
    pub fn new(field: impl Into<String>, message: &'static str) -> Self {
        Self {
            field: field.into(),
            code: "invalid_field",
            message,
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

impl Error for ValidationError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScrobbleInput {
    pub artist: String,
    pub track: String,
    pub listened_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_mbid: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleRecord {
    #[serde(rename = "$type")]
    pub record_type: String,
    pub artist: String,
    pub track: String,
    pub listened_at: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_mbid: Option<String>,
}

const INPUT_FIELDS: &[&str] = &[
    "artist",
    "track",
    "listenedAt",
    "album",
    "durationSeconds",
    "recordingMbid",
];

impl ScrobbleInput {
    pub fn from_json(value: &Value, receipt_time: DateTime<Utc>) -> Result<Self, ValidationError> {
        let object = checked_object(value, INPUT_FIELDS)?;
        input_from_object(object)?.validate(receipt_time)
    }

    pub fn validate(mut self, receipt_time: DateTime<Utc>) -> Result<Self, ValidationError> {
        self.artist = validate_display_string("artist", &self.artist)?;
        self.track = validate_display_string("track", &self.track)?;
        if let Some(album) = &self.album {
            self.album = Some(validate_display_string("album", album)?);
        }
        validate_timestamp("listenedAt", &self.listened_at, receipt_time)?;
        if self
            .duration_seconds
            .is_some_and(|seconds| !(1..=86_400).contains(&seconds))
        {
            return Err(ValidationError::new(
                "durationSeconds",
                "expected an integer between 1 and 86400",
            ));
        }
        if let Some(mbid) = &self.recording_mbid {
            // Require the standard hyphenated UUID shape declared by the JSON API contract.
            let uuid = Uuid::parse_str(mbid)
                .map_err(|_| ValidationError::new("recordingMbid", "expected a UUID"))?;
            if !mbid.eq_ignore_ascii_case(&uuid.hyphenated().to_string()) {
                return Err(ValidationError::new(
                    "recordingMbid",
                    "expected a hyphenated UUID",
                ));
            }
            self.recording_mbid = Some(uuid.hyphenated().to_string());
        }
        Ok(self)
    }

    /// Derive createdAt and $type; neither is accepted in a local request.
    /// Building fixtures is allowed. Publication separately requires Namespace::require_publication.
    pub fn into_record(
        self,
        namespace: &Namespace,
        receipt_time: DateTime<Utc>,
    ) -> Result<ScrobbleRecord, ValidationError> {
        let input = self.validate(receipt_time)?;
        Ok(ScrobbleRecord {
            record_type: namespace.scrobble_collection(),
            artist: input.artist,
            track: input.track,
            listened_at: input.listened_at,
            created_at: receipt_time.to_rfc3339_opts(SecondsFormat::AutoSi, true),
            album: input.album,
            duration_seconds: input.duration_seconds,
            recording_mbid: input.recording_mbid,
        })
    }
}

impl ScrobbleRecord {
    /// Receipt time belongs to the repository event, not the later replay wall clock.
    pub fn from_json(
        value: &Value,
        namespace: &Namespace,
        receipt_time: DateTime<Utc>,
    ) -> Result<Self, ValidationError> {
        let object = record_object(value)?;
        let record_type = required_string(object, "$type")?;
        if record_type != namespace.scrobble_collection() {
            return Err(ValidationError::new(
                "$type",
                "record type does not match the configured scrobble collection",
            ));
        }
        let created_at = required_string(object, "createdAt")?;
        validate_timestamp("createdAt", &created_at, receipt_time)?;
        let input = input_from_object(object)?;
        input.clone().validate(receipt_time)?;
        // Remote spelling remains authoritative after raw bounds and trimmed nonempty checks.
        Ok(Self {
            record_type,
            artist: input.artist,
            track: input.track,
            listened_at: input.listened_at,
            created_at,
            album: input.album,
            duration_seconds: input.duration_seconds,
            recording_mbid: input.recording_mbid,
        })
    }
}

fn input_from_object(object: &Map<String, Value>) -> Result<ScrobbleInput, ValidationError> {
    let duration_seconds = object
        .get("durationSeconds")
        .map(|value| {
            value
                .as_u64()
                .filter(|seconds| (1..=86_400).contains(seconds))
                .map(|seconds| seconds as u32)
                .ok_or_else(|| {
                    ValidationError::new(
                        "durationSeconds",
                        "expected an integer between 1 and 86400",
                    )
                })
        })
        .transpose()?;
    Ok(ScrobbleInput {
        artist: required_string(object, "artist")?,
        track: required_string(object, "track")?,
        listened_at: required_string(object, "listenedAt")?,
        album: optional_string(object, "album")?,
        duration_seconds,
        recording_mbid: optional_string(object, "recordingMbid")?,
    })
}

pub(crate) fn checked_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, ValidationError> {
    let object = record_object(value)?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ValidationError::new(field.clone(), "unknown field"));
    }
    Ok(object)
}

/// Lexicon objects are open: ignore extensions while validating all known schema fields.
pub(crate) fn record_object(value: &Value) -> Result<&Map<String, Value>, ValidationError> {
    value
        .as_object()
        .ok_or_else(|| ValidationError::new("body", "expected a JSON object"))
}

pub(crate) fn required_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<String, ValidationError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ValidationError::new(field, "required string field"))
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, ValidationError> {
    object
        .get(field)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| ValidationError::new(field, "expected a string or omitted field"))
        })
        .transpose()
}

pub fn validate_display_string(field: &str, value: &str) -> Result<String, ValidationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || value.chars().count() > 256 || value.len() > 1_024 {
        return Err(ValidationError::new(
            field,
            "expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text",
        ));
    }
    Ok(trimmed.to_owned())
}

pub fn validate_timestamp(
    field: &str,
    value: &str,
    receipt_time: DateTime<Utc>,
) -> Result<DateTime<Utc>, ValidationError> {
    // AT datetime is the RFC3339/ISO8601/WHATWG intersection: uppercase separators,
    // explicit UTC, and seconds 00..59 (no leap-second spelling).
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(10) != Some(&b'T')
        || !matches!(
            (bytes.get(17), bytes.get(18)),
            (Some(b'0'..=b'5'), Some(b'0'..=b'9'))
        )
        || !(value.ends_with('Z') || value.ends_with("+00:00"))
    {
        return Err(ValidationError::new(
            field,
            "expected an AT Protocol UTC datetime",
        ));
    }
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| ValidationError::new(field, "expected a UTC RFC3339 timestamp"))?;
    if parsed.offset().local_minus_utc() != 0 || value.ends_with("-00:00") {
        return Err(ValidationError::new(
            field,
            "expected an explicit UTC offset",
        ));
    }
    let timestamp = parsed.with_timezone(&Utc);
    let latest = receipt_time
        .checked_add_signed(Duration::seconds(300))
        .ok_or_else(|| {
            ValidationError::new(field, "receipt time cannot represent the future bound")
        })?;
    let fraction_has_subnanosecond_tail = bytes.get(19) == Some(&b'.')
        && bytes[20..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .skip(9)
            .any(|byte| *byte != b'0');
    if timestamp.timestamp() < 0
        || timestamp > latest
        || (timestamp == latest && fraction_has_subnanosecond_tail)
    {
        return Err(ValidationError::new(
            field,
            "timestamp must be between 1970-01-01 and receipt time plus 300 seconds",
        ));
    }
    Ok(timestamp)
}
