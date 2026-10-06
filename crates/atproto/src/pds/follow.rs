//! Deterministic owner-derived follow records and verified aggregate removal.
use super::{
    reconcile::{PdsClient, canonical_digest, classify, permanent, transient},
    write::WriteOutcome,
};
use crate::sync::verify::{VerifiedMutation, VerifiedRecord, verify_snapshot};
use atmusic_core::{
    follow::{FollowRecord, follow_rkey},
    namespace::Namespace,
};
use atmusic_storage::{NewOperation, OutboxItem, RecordMutation};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn operation(
    actor: &str,
    subject: &str,
    namespace: &Namespace,
    now: DateTime<Utc>,
    create: bool,
    id: String,
) -> Result<NewOperation, atmusic_core::scrobble::ValidationError> {
    let record = FollowRecord::new(subject, namespace, now)?;
    let rkey = follow_rkey(subject)?;
    let value = if create {
        serde_json::to_value(record).expect("follow serialization")
    } else {
        json!({"subject":subject})
    };
    let collection = namespace.follow_collection();
    Ok(NewOperation {
        operation_id: id,
        owner: actor.into(),
        kind: if create {
            "follow_create"
        } else {
            "follow_delete"
        }
        .into(),
        created_at: now.to_rfc3339(),
        record_uri: Some(format!("at://{actor}/{collection}/{rkey}")),
        collection,
        rkey,
        payload_json: Some(value.to_string()),
        canonical_digest: create.then(|| canonical_digest(&value)),
    })
}
impl PdsClient {
    pub(crate) fn validate_follow_item(&self, item: &OutboxItem) -> Result<(), WriteOutcome> {
        if item.collection != self.namespace.follow_collection() {
            return Err(permanent("invalid_collection"));
        }
        let value: Value = item
            .payload_json
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .ok_or_else(|| permanent("invalid_follow_intent"))?;
        let subject = value["subject"]
            .as_str()
            .ok_or_else(|| permanent("invalid_follow_intent"))?;
        let rkey = follow_rkey(subject).map_err(|_| permanent("invalid_follow_subject"))?;
        if subject == item.owner {
            return Err(permanent("self_follow"));
        }
        if item.kind == "follow_create" && item.rkey != rkey {
            return Err(permanent("invalid_follow_identity"));
        }
        if item.kind == "follow_delete" {
            self.follow_targets(item)?;
        }
        Ok(())
    }
    fn follow_targets(&self, item: &OutboxItem) -> Result<Vec<OutboxItem>, WriteOutcome> {
        let value: Value = item
            .payload_json
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .ok_or_else(|| permanent("invalid_follow_intent"))?;
        let values = value["targetUris"]
            .as_array()
            .filter(|values| !values.is_empty() && values.len() <= 10000)
            .ok_or_else(|| permanent("invalid_follow_targets"))?;
        let prefix = format!(
            "at://{}/{}/",
            item.owner,
            self.namespace.follow_collection()
        );
        let mut targets = Vec::new();
        for uri in values {
            let uri = uri
                .as_str()
                .ok_or_else(|| permanent("invalid_follow_targets"))?;
            let rkey = uri
                .strip_prefix(&prefix)
                .filter(|key| !key.is_empty() && !key.contains('/'))
                .ok_or_else(|| permanent("invalid_follow_targets"))?;
            let mut target = item.clone();
            target.rkey = rkey.into();
            target.record_uri = Some(uri.into());
            target.payload_json = Some(json!({"subject":value["subject"]}).to_string());
            targets.push(target);
        }
        Ok(targets)
    }
    pub(crate) async fn execute_follow_delete(
        &self,
        item: &OutboxItem,
        now: DateTime<Utc>,
    ) -> WriteOutcome {
        let targets = match self.follow_targets(item) {
            Ok(targets) => targets,
            Err(outcome) => return outcome,
        };
        for target in &targets {
            match self.execute_record(target, now).await {
                WriteOutcome::Confirmed(row) if matches!(*row, RecordMutation::Delete { .. }) => {}
                outcome => return outcome,
            }
        }
        self.reconcile_follow_delete(item, now).await
    }
    pub(crate) async fn reconcile_follow_delete(
        &self,
        item: &OutboxItem,
        now: DateTime<Utc>,
    ) -> WriteOutcome {
        let targets = match self.follow_targets(item) {
            Ok(targets) => targets,
            Err(outcome) => return outcome,
        };
        let pds = match self.current_pds(item).await {
            Ok(pds) => pds,
            Err(outcome) => return outcome,
        };
        let mut url = match url::Url::parse(&pds)
            .and_then(|url| url.join("/xrpc/com.atproto.sync.getRepo"))
        {
            Ok(url) => url,
            Err(_) => return permanent("invalid_pds"),
        };
        url.query_pairs_mut().append_pair("did", &item.owner);
        let snapshot = match self.oauth.client.repository(&url).await {
            Ok(response) => response,
            Err(_) => return transient("upstream_transport_error", None),
        };
        if snapshot.status != 200 {
            return classify(&snapshot, now);
        }
        let verified = match verify_snapshot(
            &snapshot.body,
            &item.owner,
            &self.namespace,
            now,
            self.resolver.as_ref(),
        )
        .await
        {
            Ok(verified) => verified,
            Err(error) => return super::reconcile::verification_failure(error),
        };
        let value: Value = serde_json::from_str(item.payload_json.as_deref().unwrap())
            .expect("validated follow intent");
        let target_uris: HashSet<&str> = targets
            .iter()
            .filter_map(|target| target.record_uri.as_deref())
            .collect();
        for mutation in verified.mutations() {
            match mutation {
                VerifiedMutation::Put { uri, record, .. } => {
                    if target_uris.contains(uri.as_str()) {
                        return transient("remote_delete_unconfirmed", None);
                    }
                    if matches!(record.as_ref(),VerifiedRecord::Follow(record) if value["subject"].as_str()==Some(record.subject.as_str()))
                    {
                        return permanent("remote_edge_changed");
                    }
                }
                VerifiedMutation::Exclude { uri, .. } if target_uris.contains(uri.as_str()) => {
                    return transient("remote_delete_unconfirmed", None);
                }
                _ => {}
            }
        }
        WriteOutcome::Confirmed(Box::new(RecordMutation::DeleteMany {
            uris: targets
                .into_iter()
                .map(|target| target.record_uri.unwrap())
                .collect(),
            owner: item.owner.clone(),
            revision: verified.revision().into(),
            indexed_at: now.to_rfc3339(),
        }))
    }
}
