//! Bounded subscribeRepos event decoding. These events are unverified candidates.

use std::{collections::HashSet, fmt, io::Cursor};

use atmusic_core::{follow::validate_did_syntax, namespace::Namespace};
use ciborium::value::Value;
use ipld_core::cid::Cid;
use serde::{
    Deserialize,
    de::{self, SeqAccess, Visitor},
};
use thiserror::Error;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CAR_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_OPERATIONS: usize = 10_000;
const MAX_CBOR_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum FrameError {
    #[error("relay frame exceeds 8 MiB")]
    FrameTooLarge,
    #[error("CAR payload exceeds 8 MiB")]
    CarTooLarge,
    #[error("event exceeds 10000 operations")]
    TooManyOperations,
    #[error("invalid CBOR event framing")]
    InvalidCbor,
    #[error("invalid relay field: {0}")]
    InvalidField(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Operation {
    pub action: Action,
    pub path: String,
    pub cid: Option<Cid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitEvent {
    pub sequence: u64,
    pub did: String,
    pub revision: String,
    pub since: Option<String>,
    pub commit: Cid,
    pub time: String,
    pub blocks: Vec<u8>,
    /// Only configured music collections. All values still require repository verification.
    pub operations: Vec<Operation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackfillReason {
    TooBig,
    Rebase,
    Sync,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayEvent {
    Commit(CommitEvent),
    Identity {
        sequence: u64,
        did: String,
        time: String,
        handle: Option<String>,
    },
    Account {
        sequence: u64,
        did: String,
        time: String,
        active: bool,
        status: Option<String>,
    },
    Backfill {
        sequence: u64,
        did: String,
        revision: Option<String>,
        reason: BackfillReason,
        /// A bounded, structurally valid configured operation is only a discovery hint.
        matching_music_operations: bool,
    },
    Ignored {
        event_type: Option<String>,
    },
    StreamError {
        code: String,
    },
}

#[derive(Deserialize)]
struct Header {
    op: i64,
    t: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommit {
    seq: u64,
    repo: String,
    rev: String,
    since: Option<String>,
    commit: Value,
    time: String,
    blocks: Value,
    ops: BoundedOperations,
    too_big: bool,
    #[serde(default)]
    rebase: bool,
}

#[derive(Deserialize)]
struct WireOperation {
    action: String,
    path: String,
    cid: Option<Value>,
}

struct BoundedOperations(Vec<WireOperation>);

impl<'de> Deserialize<'de> for BoundedOperations {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OperationsVisitor;
        impl<'de> Visitor<'de> for OperationsVisitor {
            type Value = BoundedOperations;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("at most 10000 repository operations")
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                if sequence
                    .size_hint()
                    .is_some_and(|size| size > MAX_OPERATIONS)
                {
                    return Err(de::Error::custom("too_many_operations"));
                }
                let mut operations = Vec::new();
                while operations.len() < MAX_OPERATIONS {
                    let Some(operation) = sequence.next_element()? else {
                        return Ok(BoundedOperations(operations));
                    };
                    operations.push(operation);
                }
                if sequence.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("too_many_operations"));
                }
                Ok(BoundedOperations(operations))
            }
        }
        deserializer.deserialize_seq(OperationsVisitor)
    }
}

#[derive(Deserialize)]
struct IdentityEvent {
    seq: u64,
    did: String,
    time: String,
    handle: Option<String>,
}

#[derive(Deserialize)]
struct AccountEvent {
    seq: u64,
    did: String,
    time: String,
    active: bool,
    status: Option<String>,
}

#[derive(Deserialize)]
struct BackfillEvent {
    seq: u64,
    #[serde(alias = "repo")]
    did: String,
    rev: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEvent {
    error: String,
}

/// Decode one binary WebSocket message containing exactly a header and body.
/// Errors must cause a reconnect/backfill decision in the caller; they never advance a checkpoint.
pub fn decode_frame(frame: &[u8], namespace: &Namespace) -> Result<RelayEvent, FrameError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }
    let mut reader = Cursor::new(frame);
    let header: Header = decode(&mut reader)?;
    let event = match (header.op, header.t.as_deref()) {
        (-1, _) => {
            let body: ErrorEvent = decode(&mut reader)?;
            RelayEvent::StreamError { code: body.error }
        }
        (1, Some("#commit")) => {
            let body: WireCommit = decode(&mut reader)?;
            validate_event_identity(body.seq, &body.repo)?;
            validate_revision(&body.rev)?;
            if let Some(since) = &body.since {
                validate_revision(since)?;
            }
            let operations = music_operations(body.ops, namespace)?;
            if body.too_big || body.rebase {
                RelayEvent::Backfill {
                    sequence: body.seq,
                    did: body.repo,
                    revision: Some(body.rev),
                    reason: if body.too_big {
                        BackfillReason::TooBig
                    } else {
                        BackfillReason::Rebase
                    },
                    matching_music_operations: !operations.is_empty(),
                }
            } else {
                let commit = cid_link(&body.commit)?;
                let Value::Bytes(blocks) = body.blocks else {
                    return Err(FrameError::InvalidField("blocks"));
                };
                if blocks.len() > MAX_CAR_BYTES {
                    return Err(FrameError::CarTooLarge);
                }
                RelayEvent::Commit(CommitEvent {
                    sequence: body.seq,
                    did: body.repo,
                    revision: body.rev,
                    since: body.since,
                    commit,
                    time: body.time,
                    blocks,
                    operations,
                })
            }
        }
        (1, Some("#identity")) => {
            let body: IdentityEvent = decode(&mut reader)?;
            validate_event_identity(body.seq, &body.did)?;
            RelayEvent::Identity {
                sequence: body.seq,
                did: body.did,
                time: body.time,
                handle: body.handle,
            }
        }
        (1, Some("#account")) => {
            let body: AccountEvent = decode(&mut reader)?;
            validate_event_identity(body.seq, &body.did)?;
            RelayEvent::Account {
                sequence: body.seq,
                did: body.did,
                time: body.time,
                active: body.active,
                status: body.status,
            }
        }
        (1, Some("#tooBig" | "#sync")) => {
            let body: BackfillEvent = decode(&mut reader)?;
            validate_event_identity(body.seq, &body.did)?;
            if let Some(revision) = &body.rev {
                validate_revision(revision)?;
            }
            RelayEvent::Backfill {
                sequence: body.seq,
                did: body.did,
                revision: body.rev,
                reason: if header.t.as_deref() == Some("#sync") {
                    BackfillReason::Sync
                } else {
                    BackfillReason::TooBig
                },
                matching_music_operations: false,
            }
        }
        (1, None) => return Err(FrameError::InvalidField("header.t")),
        _ => {
            let body: Value = decode(&mut reader)?;
            if !matches!(body, Value::Map(_)) {
                return Err(FrameError::InvalidCbor);
            }
            RelayEvent::Ignored {
                event_type: header.t,
            }
        }
    };
    if reader.position() as usize != frame.len() {
        return Err(FrameError::InvalidCbor);
    }
    Ok(event)
}

fn decode<T: de::DeserializeOwned>(reader: &mut Cursor<&[u8]>) -> Result<T, FrameError> {
    ciborium::de::from_reader_with_recursion_limit(reader, MAX_CBOR_DEPTH).map_err(|error| {
        if error.to_string().contains("too_many_operations") {
            FrameError::TooManyOperations
        } else {
            FrameError::InvalidCbor
        }
    })
}

fn music_operations(
    bounded: BoundedOperations,
    namespace: &Namespace,
) -> Result<Vec<Operation>, FrameError> {
    let mut paths = HashSet::new();
    let mut operations = Vec::new();
    for operation in bounded.0 {
        let (collection, rkey) = operation
            .path
            .split_once('/')
            .ok_or(FrameError::InvalidField("ops.path"))?;
        if !valid_rkey(rkey) || collection.is_empty() || !paths.insert(operation.path.clone()) {
            return Err(FrameError::InvalidField("ops.path"));
        }
        // Avoid record decoding, CAR lookups, and indexing for unrelated collections.
        if collection != namespace.scrobble_collection()
            && collection != namespace.follow_collection()
        {
            continue;
        }
        let action = match operation.action.as_str() {
            "create" => Action::Create,
            "update" => Action::Update,
            "delete" => Action::Delete,
            _ => return Err(FrameError::InvalidField("ops.action")),
        };
        let cid = operation.cid.as_ref().map(cid_link).transpose()?;
        if (action == Action::Delete) != cid.is_none() {
            return Err(FrameError::InvalidField("ops.cid"));
        }
        operations.push(Operation {
            action,
            path: operation.path,
            cid,
        });
    }
    Ok(operations)
}

pub(crate) fn cid_link(value: &Value) -> Result<Cid, FrameError> {
    let Value::Tag(42, value) = value else {
        return Err(FrameError::InvalidField("cid"));
    };
    let Value::Bytes(bytes) = &**value else {
        return Err(FrameError::InvalidField("cid"));
    };
    if bytes.first() != Some(&0) {
        return Err(FrameError::InvalidField("cid"));
    }
    let mut reader = Cursor::new(&bytes[1..]);
    let cid = Cid::read_bytes(&mut reader).map_err(|_| FrameError::InvalidField("cid"))?;
    if reader.position() as usize != bytes.len() - 1 {
        return Err(FrameError::InvalidField("cid"));
    }
    Ok(cid)
}

fn validate_event_identity(sequence: u64, did: &str) -> Result<(), FrameError> {
    if sequence == 0 {
        return Err(FrameError::InvalidField("seq"));
    }
    validate_did_syntax(did).map_err(|_| FrameError::InvalidField("did"))
}

pub(crate) fn validate_revision(revision: &str) -> Result<(), FrameError> {
    let bytes = revision.as_bytes();
    if bytes.len() != 13
        || !bytes
            .iter()
            .all(|byte| b"234567abcdefghijklmnopqrstuvwxyz".contains(byte))
        || !b"234567abcdefghij".contains(&bytes[0])
    {
        return Err(FrameError::InvalidField("rev"));
    }
    Ok(())
}

pub(crate) fn valid_rkey(rkey: &str) -> bool {
    !rkey.is_empty()
        && rkey.len() <= 512
        && rkey != "."
        && rkey != ".."
        && rkey
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~:-".contains(&byte))
}
