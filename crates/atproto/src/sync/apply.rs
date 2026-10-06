//! Verify before the storage transaction applies records and advances its relay checkpoint.

use atmusic_core::{music_key::normalize, namespace::Namespace, scrobble::ValidationError};
use atmusic_storage::{
    Checkpoint, FollowRow, RecordMutation, Repository, RepositoryEvent, ScrobbleRow, StorageError,
};
use chrono::{DateTime, SecondsFormat, Utc};
use thiserror::Error;

use super::{
    frames::CommitEvent,
    verify::{
        SigningKeyResolver, VerificationError, VerifiedMutation, VerifiedRecord, verify_commit,
    },
};

pub struct ApplyContext<'a> {
    pub relay: &'a str,
    pub expected_did: &'a str,
    pub namespace: &'a Namespace,
    pub receipt_time: DateTime<Utc>,
    pub resolver: &'a dyn SigningKeyResolver,
}

#[derive(Debug, Error)]
pub enum ApplyError {
    #[error(transparent)]
    Verification(#[from] VerificationError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("relay sequence is outside SQLite's supported integer range")]
    InvalidSequence,
}

#[derive(Clone, Debug)]
pub struct ExcludedRecord {
    pub uri: String,
    pub error: ValidationError,
}

#[derive(Clone, Debug)]
pub struct ApplyOutcome {
    /// False means a previously applied sequence was replayed; no mutation was applied again.
    pub applied: bool,
    /// The caller reports these field reasons as malformed-record metrics after successful commit.
    pub excluded: Vec<ExcludedRecord>,
}

pub async fn apply_commit(
    repository: &Repository,
    event: &CommitEvent,
    context: ApplyContext<'_>,
) -> Result<ApplyOutcome, ApplyError> {
    let sequence = i64::try_from(event.sequence).map_err(|_| ApplyError::InvalidSequence)?;
    let verified = verify_commit(
        event,
        context.expected_did,
        context.namespace,
        context.receipt_time,
        context.resolver,
    )
    .await?;
    let indexed_at = context
        .receipt_time
        .to_rfc3339_opts(SecondsFormat::AutoSi, true);
    let (mutations, mut excluded) = projection(&verified, &indexed_at);
    let applied = repository
        .apply_repository_event(
            verified.did().into(),
            RepositoryEvent {
                checkpoint: Checkpoint {
                    relay: context.relay.into(),
                    sequence,
                    revision: Some(verified.revision().into()),
                    indexed_at,
                },
                mutations,
            },
        )
        .await?;
    if !applied {
        excluded.clear();
    }
    Ok(ApplyOutcome { applied, excluded })
}

/// Shared projection conversion; callers must retain the verification gate.
pub(crate) fn projection(
    verified: &super::verify::VerifiedCommit,
    indexed_at: &str,
) -> (Vec<RecordMutation>, Vec<ExcludedRecord>) {
    let mut mutations = Vec::new();
    let mut excluded = Vec::new();
    for mutation in verified.mutations() {
        match mutation {
            VerifiedMutation::Put { uri, cid, record } => {
                let mutation = match record.as_ref() {
                    VerifiedRecord::Scrobble(record) => RecordMutation::Scrobble(ScrobbleRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        did: verified.did().into(),
                        revision: verified.revision().into(),
                        artist: record.artist.clone(),
                        track: record.track.clone(),
                        album: record.album.clone(),
                        listened_at: record.listened_at.clone(),
                        created_at: record.created_at.clone(),
                        duration_seconds: record.duration_seconds.map(i64::from),
                        recording_mbid: record.recording_mbid.clone(),
                        indexed_at: indexed_at.into(),
                        artist_key: normalize(&record.artist),
                        track_key: normalize(&record.track),
                        album_key: record.album.as_deref().map(normalize),
                        confirmed: true,
                    }),
                    VerifiedRecord::Follow(record) => RecordMutation::Follow(FollowRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        actor: verified.did().into(),
                        subject: record.subject.clone(),
                        revision: verified.revision().into(),
                        created_at: record.created_at.clone(),
                        indexed_at: indexed_at.into(),
                        confirmed: true,
                    }),
                };
                mutations.push(mutation);
            }
            VerifiedMutation::Delete { uri } | VerifiedMutation::Exclude { uri, .. } => {
                mutations.push(RecordMutation::Delete {
                    uri: uri.clone(),
                    owner: verified.did().into(),
                    revision: verified.revision().into(),
                    indexed_at: indexed_at.into(),
                });
                if let VerifiedMutation::Exclude { error, .. } = mutation {
                    excluded.push(ExcludedRecord {
                        uri: uri.clone(),
                        error: error.clone(),
                    });
                }
            }
        }
    }
    (mutations, excluded)
}
