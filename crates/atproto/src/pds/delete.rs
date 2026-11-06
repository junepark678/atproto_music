//! A write acknowledgement or RecordNotFound alone never confirms deletion.
//! The shared client first proves absence in a resolver-bound signed repository.
use atmusic_storage::{OutboxItem, RecordMutation};
use chrono::{DateTime, Utc};

use super::{
    reconcile::{PdsClient, permanent},
    write::WriteOutcome,
};

impl PdsClient {
    /// Called only for Lookup::Absent, which is constructed after CAR verification.
    pub(crate) fn deletion(
        item: &OutboxItem,
        revision: String,
        now: DateTime<Utc>,
    ) -> WriteOutcome {
        let uri = format!("at://{}/{}/{}", item.owner, item.collection, item.rkey);
        if !matches!(item.kind.as_str(), "scrobble_delete" | "follow_delete")
            || item.record_uri.as_deref() != Some(uri.as_str())
            || revision.parse::<atrium_api::types::string::Tid>().is_err()
        {
            return permanent("invalid_deletion_identity");
        }
        WriteOutcome::Confirmed(Box::new(RecordMutation::Delete {
            uri,
            owner: item.owner.clone(),
            revision,
            indexed_at: now.to_rfc3339(),
        }))
    }
}
