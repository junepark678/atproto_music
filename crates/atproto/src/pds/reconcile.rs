//! Confirm persisted record identity against a signed repository snapshot before indexing.
use super::write::WriteOutcome;
use crate::{
    http::safe_client::{HttpRequest, HttpResponse},
    oauth::service::OAuthService,
    sync::verify::{
        SigningKeyResolver, VerificationError, VerifiedMutation, VerifiedRecord,
        verify_snapshot_record,
    },
};
use atmusic_core::{music_key::normalize, namespace::Namespace};
use atmusic_storage::{FollowRow, OutboxItem, RecordMutation, ScrobbleRow};
use chrono::{DateTime, Utc};
use ipld_core::cid::Cid;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use url::Url;

pub struct PdsClient {
    pub(crate) oauth: Arc<OAuthService>,
    pub(crate) namespace: Namespace,
    pub(crate) resolver: Arc<dyn SigningKeyResolver>,
}
impl PdsClient {
    /// No publication capability exists without both namespace ownership and a trusted resolver.
    pub fn new(
        oauth: Arc<OAuthService>,
        namespace: Namespace,
        resolver: Arc<dyn SigningKeyResolver>,
    ) -> Result<Self, atmusic_core::namespace::NamespaceError> {
        namespace.require_publication()?;
        Ok(Self {
            oauth,
            namespace,
            resolver,
        })
    }
    pub(crate) async fn lookup(
        &self,
        item: &OutboxItem,
        now: DateTime<Utc>,
        pds: &str,
    ) -> Result<Lookup, WriteOutcome> {
        let mut url = Url::parse(pds)
            .map_err(|_| permanent("invalid_pds"))?
            .join("/xrpc/com.atproto.repo.getRecord")
            .map_err(|_| permanent("invalid_pds"))?;
        url.query_pairs_mut()
            .append_pair("repo", &item.owner)
            .append_pair("collection", &item.collection)
            .append_pair("rkey", &item.rkey);
        let response = self
            .oauth
            .client
            .send(&get(url, "application/json"))
            .await
            .map_err(|_| transient("upstream_transport_error", None))?;
        let cid = if response.status == 200 {
            let body: Value = serde_json::from_slice(&response.body)
                .map_err(|_| permanent("invalid_pds_response"))?;
            let expected_uri = format!("at://{}/{}/{}", item.owner, item.collection, item.rkey);
            if body.get("uri").and_then(Value::as_str) != Some(expected_uri.as_str()) {
                return Err(permanent("remote_record_identity_mismatch"));
            }
            Some(
                body.get("cid")
                    .and_then(Value::as_str)
                    .ok_or_else(|| permanent("invalid_pds_response"))?
                    .parse::<Cid>()
                    .map_err(|_| permanent("invalid_pds_response"))?,
            )
        } else if missing(&response) {
            None
        } else {
            return Err(classify(&response, now));
        };
        let mut url = Url::parse(pds)
            .map_err(|_| permanent("invalid_pds"))?
            .join("/xrpc/com.atproto.sync.getRepo")
            .map_err(|_| permanent("invalid_pds"))?;
        url.query_pairs_mut().append_pair("did", &item.owner);
        let snapshot = self
            .oauth
            .client
            .repository(&url)
            .await
            .map_err(|_| transient("upstream_transport_error", None))?;
        if snapshot.status != 200 {
            return Err(classify(&snapshot, now));
        }
        let path = format!("{}/{}", item.collection, item.rkey);
        let commit = verify_snapshot_record(
            &snapshot.body,
            &item.owner,
            &path,
            cid,
            &self.namespace,
            now,
            self.resolver.as_ref(),
        )
        .await
        .map_err(|error| match error {
            VerificationError::MembershipMismatch => transient("repository_changed", None),
            error => verification_failure(error),
        })?;
        if cid.is_none() {
            return Ok(Lookup::Absent {
                revision: commit.revision().into(),
            });
        }
        let deleting = matches!(item.kind.as_str(), "scrobble_delete" | "follow_delete");
        if !deleting && item.canonical_digest.is_none() {
            return Err(permanent("missing_canonical_digest"));
        }
        for mutation in commit.mutations() {
            if let VerifiedMutation::Put { uri, cid, record } = mutation {
                let json = match record.as_ref() {
                    VerifiedRecord::Scrobble(s) => serde_json::to_value(s),
                    VerifiedRecord::Follow(f) => serde_json::to_value(f),
                }
                .map_err(|_| permanent("invalid_verified_record"))?;
                if item.kind == "follow_delete" {
                    let requested: Value = item
                        .payload_json
                        .as_deref()
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .ok_or_else(|| permanent("invalid_follow_intent"))?;
                    if !matches!(record.as_ref(),VerifiedRecord::Follow(f) if requested["subject"].as_str()==Some(f.subject.as_str()))
                    {
                        return Err(permanent("remote_record_conflict"));
                    }
                }
                let matches_requested = if item.kind == "follow_create" {
                    let requested: Value = item
                        .payload_json
                        .as_deref()
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .ok_or_else(|| permanent("invalid_follow_intent"))?;
                    matches!(record.as_ref(),VerifiedRecord::Follow(f) if requested["subject"].as_str()==Some(f.subject.as_str()))
                } else {
                    item.canonical_digest.as_deref() == Some(canonical_digest(&json).as_str())
                };
                if !deleting && !matches_requested {
                    return Err(permanent("remote_record_conflict"));
                }
                let row = match record.as_ref() {
                    VerifiedRecord::Scrobble(s) => RecordMutation::Scrobble(ScrobbleRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        did: item.owner.clone(),
                        revision: commit.revision().into(),
                        artist: s.artist.clone(),
                        track: s.track.clone(),
                        album: s.album.clone(),
                        listened_at: s.listened_at.clone(),
                        created_at: s.created_at.clone(),
                        duration_seconds: s.duration_seconds.map(i64::from),
                        recording_mbid: s.recording_mbid.clone(),
                        indexed_at: now.to_rfc3339(),
                        artist_key: normalize(&s.artist),
                        track_key: normalize(&s.track),
                        album_key: s.album.as_deref().map(normalize),
                        confirmed: true,
                    }),
                    VerifiedRecord::Follow(f) => RecordMutation::Follow(FollowRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        actor: item.owner.clone(),
                        subject: f.subject.clone(),
                        created_at: f.created_at.clone(),
                        revision: commit.revision().into(),
                        indexed_at: now.to_rfc3339(),
                        confirmed: true,
                    }),
                };
                return Ok(Lookup::Present(Box::new(row)));
            }
        }
        Err(permanent("invalid_verified_record"))
    }
    pub(crate) async fn current_pds(&self, item: &OutboxItem) -> Result<String, WriteOutcome> {
        self.oauth
            .store
            .get_oauth_tokens(&item.owner)
            .await
            .map_err(|_| permanent("oauth_storage_unavailable"))?
            .and_then(|v| v.get("pds").and_then(Value::as_str).map(str::to_owned))
            .ok_or_else(|| permanent("sign_in_required"))
    }
}
pub(crate) enum Lookup {
    Present(Box<RecordMutation>),
    Absent { revision: String },
}
pub fn canonical_digest(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).expect("JSON value serialization"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn permanent(code: &'static str) -> WriteOutcome {
    WriteOutcome::Permanent { failure_code: code }
}
pub(crate) fn transient(code: &'static str, retry_after: Option<Duration>) -> WriteOutcome {
    WriteOutcome::Transient {
        failure_code: code,
        retry_after,
    }
}
/// A fresh read may resolve availability, head or identity races; every outcome
/// still requires the complete signed proof before any record is confirmed.
pub(crate) fn verification_failure(error: VerificationError) -> WriteOutcome {
    match error {
        VerificationError::HeadUnavailable => transient("current_head_unavailable", None),
        error if error.is_retryable_head_race() => transient("current_head_changed", None),
        _ => permanent("repository_verification_failed"),
    }
}
fn get(url: Url, accept: &str) -> HttpRequest {
    HttpRequest {
        url,
        method: "GET".into(),
        headers: BTreeMap::from([("accept".into(), accept.into())]),
        body: Vec::new(),
    }
}
pub(crate) fn missing(response: &HttpResponse) -> bool {
    response.status == 404
        || response.status == 400
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .is_some_and(|b| b["error"] == "RecordNotFound")
}
pub(crate) fn classify(response: &HttpResponse, now: DateTime<Utc>) -> WriteOutcome {
    if response.status == 429 || response.status >= 500 {
        let retry_after = response.headers.get("retry-after").and_then(|v| {
            v.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
                DateTime::parse_from_rfc2822(v)
                    .ok()
                    .and_then(|date| (date.with_timezone(&Utc) - now).to_std().ok())
            })
        });
        return transient(
            if response.status == 429 {
                "upstream_rate_limited"
            } else {
                "upstream_unavailable"
            },
            retry_after,
        );
    }
    let code = serde_json::from_slice::<Value>(&response.body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned));
    permanent(match code.as_deref() {
        Some("InvalidRecord") => "invalid_record",
        Some("Forbidden") | Some("InsufficientScope") => "forbidden_scope",
        Some("InvalidToken") | Some("ExpiredToken") => "sign_in_required",
        _ => "upstream_rejected",
    })
}
