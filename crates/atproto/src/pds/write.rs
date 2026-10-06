//! Owner-authorized PDS write boundary; confirmation carries independently verified state.
use async_trait::async_trait;
use atmusic_storage::{OutboxItem, RecordMutation};
use chrono::{DateTime, Utc};
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum WriteOutcome {
    Confirmed(Box<RecordMutation>),
    Transient {
        failure_code: &'static str,
        retry_after: Option<Duration>,
    },
    Permanent {
        failure_code: &'static str,
    },
}
#[async_trait]
pub trait PdsWriteBoundary: Send + Sync {
    async fn execute(&self, item: &OutboxItem, now: DateTime<Utc>) -> WriteOutcome;
    /// A read-only recovery check; never sends an eleventh write after the attempt cap.
    async fn reconcile(&self, _item: &OutboxItem, _now: DateTime<Utc>) -> WriteOutcome {
        WriteOutcome::Permanent {
            failure_code: "attempts_exhausted",
        }
    }
}
pub trait Jitter: Send + Sync {
    fn milliseconds(&self, base_milliseconds: u64) -> u64;
}
pub struct RandomJitter;
impl Jitter for RandomJitter {
    fn milliseconds(&self, base: u64) -> u64 {
        use rand::Rng;
        rand::rngs::OsRng.gen_range(0..=base / 4)
    }
}
/// Total delay including jitter and Retry-After is capped at five minutes.
pub fn retry_delay(attempt: i64, retry_after: Option<Duration>, jitter: &dyn Jitter) -> Duration {
    let base = 1000u64
        .saturating_mul(
            1u64.checked_shl(u32::try_from(attempt.saturating_sub(1)).unwrap_or(u32::MAX))
                .unwrap_or(u64::MAX),
        )
        .min(300_000);
    let millis = base
        .saturating_add(jitter.milliseconds(base).min(base / 4))
        .max(retry_after.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)))
        .min(300_000);
    Duration::from_millis(millis)
}

use super::reconcile::{Lookup, PdsClient, classify, permanent, transient};
use crate::http::safe_client::HttpRequest;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use url::Url;

impl PdsClient {
    pub(crate) async fn execute_record(
        &self,
        item: &OutboxItem,
        now: DateTime<Utc>,
    ) -> WriteOutcome {
        if self.namespace.require_publication().is_err() {
            return permanent("namespace_not_production");
        }
        let expected_collection = match item.kind.as_str() {
            "scrobble_create" | "scrobble_delete" => self.namespace.scrobble_collection(),
            "follow_create" | "follow_delete" => self.namespace.follow_collection(),
            _ => return permanent("invalid_operation_kind"),
        };
        if item.collection != expected_collection
            || item.record_uri.as_deref()
                != Some(format!("at://{}/{}/{}", item.owner, item.collection, item.rkey).as_str())
        {
            return permanent("invalid_record_identity");
        }
        let pds = match self.current_pds(item).await {
            Ok(pds) => pds,
            Err(outcome) => return outcome,
        };
        let deleting = matches!(item.kind.as_str(), "scrobble_delete" | "follow_delete");
        let mut swap_record = None;
        match self.lookup(item, now, &pds).await {
            Ok(Lookup::Present(row)) if !deleting => return WriteOutcome::Confirmed(row),
            Ok(Lookup::Present(row)) => {
                swap_record = Some(match row.as_ref() {
                    atmusic_storage::RecordMutation::Scrobble(row) => row.cid.clone(),
                    atmusic_storage::RecordMutation::Follow(row) => row.cid.clone(),
                    _ => return permanent("invalid_verified_record"),
                });
            }
            Ok(Lookup::Absent { revision }) if deleting => {
                return Self::deletion(item, revision, now);
            }
            Ok(Lookup::Absent { .. }) => {}
            Err(outcome) => return outcome,
        }
        let mut material = match self.oauth.refresh(&item.owner, now.timestamp()).await {
            Ok(material) => material,
            Err(_) => return permanent("sign_in_required"),
        };
        let endpoint = if deleting {
            "com.atproto.repo.deleteRecord"
        } else {
            "com.atproto.repo.createRecord"
        };
        let url = match Url::parse(&material.pds)
            .and_then(|url| url.join(&format!("/xrpc/{endpoint}")))
        {
            Ok(url) => url,
            Err(_) => return permanent("invalid_pds"),
        };
        let mut payload = json!({"repo":item.owner,"collection":item.collection,"rkey":item.rkey});
        if deleting {
            payload["swapRecord"] =
                Value::String(swap_record.expect("verified present delete CID"));
        }
        if !deleting {
            let Some(record) = item
                .payload_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            else {
                return permanent("invalid_record");
            };
            payload["record"] = record;
            payload["validate"] = Value::Bool(true);
        }
        let request = HttpRequest {
            url,
            method: "POST".into(),
            headers: BTreeMap::from([
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "application/json".into()),
                (
                    "authorization".into(),
                    format!("DPoP {}", material.access_token),
                ),
            ]),
            body: serde_json::to_vec(&payload).expect("JSON serialization"),
        };
        let mut response = match self
            .oauth
            .dpop_send(
                request.clone(),
                &material.dpop_private_pem,
                &mut material.resource_nonce,
                Some(&material.access_token),
                now.timestamp(),
            )
            .await
        {
            Ok(response) => response,
            Err(_) => return transient("upstream_transport_error", None),
        };
        if self
            .oauth
            .store
            .update_resource_nonce(
                &item.owner,
                &material.access_token,
                material.resource_nonce.clone(),
                now.timestamp(),
            )
            .await
            .is_err()
        {
            return transient("oauth_storage_unavailable", None);
        }
        let expired = response.status == 401
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .is_some_and(|body| {
                    matches!(
                        body["error"].as_str(),
                        Some("InvalidToken" | "ExpiredToken")
                    )
                });
        if expired {
            if self
                .oauth
                .store
                .mark_access_expired(&item.owner, &material.access_token, now.timestamp())
                .await
                .is_err()
            {
                return permanent("sign_in_required");
            }
            material = match self.oauth.refresh(&item.owner, now.timestamp()).await {
                Ok(material) => material,
                Err(_) => return permanent("sign_in_required"),
            };
            let mut retry = request;
            retry.headers.insert(
                "authorization".into(),
                format!("DPoP {}", material.access_token),
            );
            response = match self
                .oauth
                .dpop_send(
                    retry,
                    &material.dpop_private_pem,
                    &mut material.resource_nonce,
                    Some(&material.access_token),
                    now.timestamp(),
                )
                .await
            {
                Ok(response) => response,
                Err(_) => return transient("upstream_transport_error", None),
            };
            if self
                .oauth
                .store
                .update_resource_nonce(
                    &item.owner,
                    &material.access_token,
                    material.resource_nonce,
                    now.timestamp(),
                )
                .await
                .is_err()
            {
                return transient("oauth_storage_unavailable", None);
            }
        }
        let already_exists = !deleting
            && response.status == 400
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .is_some_and(|body| body["error"] == "RecordAlreadyExists");
        if response.status == 400
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .is_some_and(|body| body["error"] == "InvalidSwap")
        {
            return transient("repository_changed", None);
        }
        if !(200..300).contains(&response.status)
            && !super::reconcile::missing(&response)
            && !already_exists
        {
            return classify(&response, now);
        }
        // The createRecord CID is a candidate only. Signed MST/CID verification decides success.
        match self.lookup(item, now, &pds).await {
            Ok(Lookup::Present(row)) if !deleting => WriteOutcome::Confirmed(row),
            Ok(Lookup::Absent { revision }) if deleting => Self::deletion(item, revision, now),
            Ok(_) => transient("remote_write_unconfirmed", None),
            Err(outcome) => outcome,
        }
    }
    pub(crate) async fn reconcile_record(
        &self,
        item: &OutboxItem,
        now: DateTime<Utc>,
    ) -> WriteOutcome {
        if self.namespace.require_publication().is_err() {
            return permanent("namespace_not_production");
        }
        let expected_collection = match item.kind.as_str() {
            "scrobble_create" | "scrobble_delete" => self.namespace.scrobble_collection(),
            "follow_create" | "follow_delete" => self.namespace.follow_collection(),
            _ => return permanent("invalid_operation_kind"),
        };
        if item.collection != expected_collection
            || item.record_uri.as_deref()
                != Some(format!("at://{}/{}/{}", item.owner, item.collection, item.rkey).as_str())
        {
            return permanent("invalid_record_identity");
        }
        let pds = match self.current_pds(item).await {
            Ok(pds) => pds,
            Err(outcome) => return outcome,
        };
        let deleting = matches!(item.kind.as_str(), "scrobble_delete" | "follow_delete");
        match self.lookup(item, now, &pds).await {
            Ok(Lookup::Present(row)) if !deleting => WriteOutcome::Confirmed(row),
            Ok(Lookup::Absent { revision }) if deleting => Self::deletion(item, revision, now),
            Ok(_) => permanent("attempts_exhausted"),
            Err(outcome) => outcome,
        }
    }
}

#[async_trait]
impl PdsWriteBoundary for PdsClient {
    async fn execute(&self, item: &OutboxItem, now: DateTime<Utc>) -> WriteOutcome {
        if matches!(item.kind.as_str(), "follow_create" | "follow_delete") {
            if let Err(outcome) = self.validate_follow_item(item) {
                return outcome;
            }
            if item.kind == "follow_delete" {
                return self.execute_follow_delete(item, now).await;
            }
        }
        self.execute_record(item, now).await
    }
    async fn reconcile(&self, item: &OutboxItem, now: DateTime<Utc>) -> WriteOutcome {
        if matches!(item.kind.as_str(), "follow_create" | "follow_delete") {
            if let Err(outcome) = self.validate_follow_item(item) {
                return outcome;
            }
            if item.kind == "follow_delete" {
                return self.reconcile_follow_delete(item, now).await;
            }
        }
        self.reconcile_record(item, now).await
    }
}
