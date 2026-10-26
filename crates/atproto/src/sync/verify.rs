//! Fail-closed repository verification using maintained CAR/MST and crypto libraries.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Cursor, Read},
};

use async_trait::async_trait;
use atmusic_core::{
    follow::FollowRecord,
    namespace::Namespace,
    scrobble::{ScrobbleRecord, ValidationError},
};
use atrium_repo::{Repository, blockstore::CarStore};
use chrono::{DateTime, Utc};
use ciborium::value::Value as CborValue;
use futures::TryStreamExt;
use ipld_core::{
    cid::{Cid, Version},
    ipld::Ipld,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::frames::{Action, CommitEvent, MAX_CAR_BYTES};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VerificationError {
    #[error("CAR payload exceeds the configured bound")]
    CarTooLarge,
    #[error("invalid bounded CAR framing or DAG-CBOR")]
    InvalidCar,
    #[error("unsupported CID codec, version, or hash")]
    UnsupportedCid,
    #[error("content-addressed block does not match its CID")]
    CidMismatch,
    #[error("commit identity or revision does not match the event")]
    CommitMismatch,
    #[error("trusted signing key is unavailable for the event revision")]
    UntrustedIdentity,
    #[error("the authenticated repository head has advanced or differs in revision")]
    HeadChanged,
    #[error("authenticated identity changed during the repository head lookup")]
    IdentityChanged,
    #[error("the current repository head is temporarily unavailable")]
    HeadUnavailable,
    #[error("the authenticated head CID differs for the requested revision")]
    HeadCidMismatch,
    #[error("the authenticated repository head response is malformed")]
    InvalidHeadWitness,
    #[error("commit signature is invalid")]
    InvalidSignature,
    #[error("record path is not proven by the signed MST")]
    MembershipMismatch,
    #[error("required MST or record proof block is missing")]
    MissingProof,
    #[error("invalid MST node structure")]
    InvalidMst,
}
impl VerificationError {
    /// No unverified mutation is admitted. A fresh lookup may resolve these races.
    pub fn is_retryable_head_race(&self) -> bool {
        matches!(
            self,
            Self::HeadChanged | Self::IdentityChanged | Self::HeadUnavailable
        )
    }
}

/// Produced by a trusted identity resolver using authenticated revision evidence.
/// `valid_until` is exclusive. A current DID document alone cannot establish historical ranges.
#[derive(Clone, Debug)]
pub struct TrustedSigningKey {
    pub did: String,
    pub did_key: String,
    pub valid_from: String,
    pub valid_until: Option<String>,
}

/// A point-in-time current-head witness, with no assertion about historical keys.
#[derive(Clone, Debug)]
pub struct TrustedHeadSigningKey {
    pub did: String,
    pub did_key: String,
    pub revision: String,
    pub commit: Cid,
}

#[derive(Clone, Debug)]
pub enum SigningKeyProof {
    Historical(TrustedSigningKey),
    CurrentHead(TrustedHeadSigningKey),
}

#[async_trait]
pub trait SigningKeyResolver: Send + Sync {
    /// Re-resolve trusted identity rather than trusting a key supplied in an event or CAR.
    async fn resolve_for_revision(
        &self,
        did: &str,
        revision: &str,
    ) -> Result<TrustedSigningKey, VerificationError>;

    /// Resolve evidence for this exact signed root. Existing historical resolvers
    /// keep their interval semantics; current-head resolvers override this method.
    async fn resolve_for_commit(
        &self,
        did: &str,
        revision: &str,
        _commit: Cid,
    ) -> Result<SigningKeyProof, VerificationError> {
        self.resolve_for_revision(did, revision)
            .await
            .map(SigningKeyProof::Historical)
    }
}

/// Safe production default until authenticated revision-bound identity evidence is configured.
pub struct UnavailableSigningKeyResolver;

#[async_trait]
impl SigningKeyResolver for UnavailableSigningKeyResolver {
    async fn resolve_for_revision(
        &self,
        _: &str,
        _: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        Err(VerificationError::UntrustedIdentity)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifiedRecord {
    Scrobble(ScrobbleRecord),
    Follow(FollowRecord),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifiedMutation {
    Put {
        uri: String,
        cid: Cid,
        record: Box<VerifiedRecord>,
    },
    Delete {
        uri: String,
    },
    /// A signed, proven record with invalid application schema must disappear from public views.
    Exclude {
        uri: String,
        error: ValidationError,
    },
}

/// Constructible only through the verification gate. No database writes occur before this exists.
#[derive(Clone, Debug)]
pub struct VerifiedCommit {
    did: String,
    revision: String,
    sequence: u64,
    commit: Cid,
    mutations: Vec<VerifiedMutation>,
}

impl VerifiedCommit {
    pub fn did(&self) -> &str {
        &self.did
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
    pub const fn commit(&self) -> Cid {
        self.commit
    }
    pub fn mutations(&self) -> &[VerifiedMutation] {
        &self.mutations
    }
}

/// Validate all block hashes, signed commit identity/revision, and each operation's MST membership.
/// Missing proof blocks fail closed; the caller must retrieve verified backfill instead of guessing.
pub async fn verify_commit(
    event: &CommitEvent,
    expected_did: &str,
    namespace: &Namespace,
    receipt_time: DateTime<Utc>,
    resolver: &dyn SigningKeyResolver,
) -> Result<VerifiedCommit, VerificationError> {
    if event.did != expected_did {
        return Err(VerificationError::CommitMismatch);
    }
    let blocks = preflight_car(&event.blocks, event.commit)?;
    let commit = blocks
        .get(&event.commit)
        .ok_or(VerificationError::MissingProof)?;
    let Ipld::Map(fields) = commit else {
        return Err(VerificationError::CommitMismatch);
    };
    if fields.get("did") != Some(&Ipld::String(expected_did.into()))
        || fields.get("rev") != Some(&Ipld::String(event.revision.clone()))
        || fields.get("version") != Some(&Ipld::Integer(3))
    {
        return Err(VerificationError::CommitMismatch);
    }
    let proof = resolver
        .resolve_for_commit(expected_did, &event.revision, event.commit)
        .await?;
    let did_key = match proof {
        SigningKeyProof::Historical(key) => {
            if key.did != expected_did
                || event.revision < key.valid_from
                || key
                    .valid_until
                    .as_ref()
                    .is_some_and(|until| &event.revision >= until)
            {
                return Err(VerificationError::UntrustedIdentity);
            }
            key.did_key
        }
        SigningKeyProof::CurrentHead(key) => {
            if key.did != expected_did
                || key.revision != event.revision
                || key.commit != event.commit
            {
                return Err(VerificationError::UntrustedIdentity);
            }
            key.did_key
        }
    };
    // Raw CarStore is only reached after lengths, supported hashes, and CBOR have been checked.
    let mut store = CarStore::open(Cursor::new(&event.blocks))
        .await
        .map_err(|_| VerificationError::InvalidCar)?;
    let mut repository = Repository::open(&mut store, event.commit)
        .await
        .map_err(|_| VerificationError::InvalidCar)?;
    let signed = repository.commit();
    atrium_crypto::verify::verify_signature(&did_key, &signed.bytes(), signed.sig())
        .map_err(|_| VerificationError::InvalidSignature)?;

    let mut mutations = Vec::new();
    for operation in &event.operations {
        let (collection, _) = operation
            .path
            .split_once('/')
            .ok_or(VerificationError::MembershipMismatch)?;
        if collection != namespace.scrobble_collection()
            && collection != namespace.follow_collection()
        {
            return Err(VerificationError::MembershipMismatch);
        }
        let member = repository
            .tree()
            .get(&operation.path)
            .await
            .map_err(|_| VerificationError::MissingProof)?;
        let uri = format!("at://{expected_did}/{}", operation.path);
        match operation.action {
            Action::Delete => {
                if member.is_some() || operation.cid.is_some() {
                    return Err(VerificationError::MembershipMismatch);
                }
                mutations.push(VerifiedMutation::Delete { uri });
            }
            Action::Create | Action::Update => {
                let cid = operation.cid.ok_or(VerificationError::MembershipMismatch)?;
                if member != Some(cid) {
                    return Err(VerificationError::MembershipMismatch);
                }
                let record = blocks.get(&cid).ok_or(VerificationError::MissingProof)?;
                let json =
                    serde_json::to_value(record).map_err(|_| VerificationError::InvalidCar)?;
                let validated = if collection == namespace.scrobble_collection() {
                    ScrobbleRecord::from_json(&json, namespace, receipt_time)
                        .map(VerifiedRecord::Scrobble)
                } else {
                    FollowRecord::from_json(&json, namespace, receipt_time)
                        .map(VerifiedRecord::Follow)
                };
                match validated {
                    Ok(record) => mutations.push(VerifiedMutation::Put {
                        uri,
                        cid,
                        record: Box::new(record),
                    }),
                    Err(error) => mutations.push(VerifiedMutation::Exclude { uri, error }),
                }
            }
        }
    }
    Ok(VerifiedCommit {
        did: expected_did.into(),
        revision: event.revision.clone(),
        sequence: event.sequence,
        commit: event.commit,
        mutations,
    })
}

fn preflight_car(
    bytes: &[u8],
    expected_root: Cid,
) -> Result<HashMap<Cid, Ipld>, VerificationError> {
    if bytes.len() > MAX_CAR_BYTES {
        return Err(VerificationError::CarTooLarge);
    }
    let mut reader = Cursor::new(bytes);
    let header_bytes = read_section(&mut reader)?;
    let header = bounded_dag_cbor(&header_bytes)?;
    let Ipld::Map(header) = header else {
        return Err(VerificationError::InvalidCar);
    };
    if header.get("version") != Some(&Ipld::Integer(1)) {
        return Err(VerificationError::InvalidCar);
    }
    let Some(Ipld::List(roots)) = header.get("roots") else {
        return Err(VerificationError::InvalidCar);
    };
    if roots.first() != Some(&Ipld::Link(expected_root)) {
        return Err(VerificationError::CommitMismatch);
    }
    let mut blocks = HashMap::new();
    while (reader.position() as usize) < bytes.len() {
        let section = read_section(&mut reader)?;
        let mut block_reader = Cursor::new(&section);
        let cid = Cid::read_bytes(&mut block_reader).map_err(|_| VerificationError::InvalidCar)?;
        if cid.version() != Version::V1
            || cid.codec() != 0x71
            || cid.hash().code() != 0x12
            || cid.hash().size() != 32
        {
            return Err(VerificationError::UnsupportedCid);
        }
        let block = &section[block_reader.position() as usize..];
        if Sha256::digest(block).as_slice() != cid.hash().digest() {
            return Err(VerificationError::CidMismatch);
        }
        let decoded = bounded_dag_cbor(block)?;
        blocks.insert(cid, decoded);
    }
    let Some(Ipld::Map(commit)) = blocks.get(&expected_root) else {
        return Err(VerificationError::MissingProof);
    };
    let Some(Ipld::Link(data)) = commit.get("data") else {
        return Err(VerificationError::CommitMismatch);
    };
    validate_mst_graph(&blocks, *data)?;
    Ok(blocks)
}

fn read_section(reader: &mut Cursor<&[u8]>) -> Result<Vec<u8>, VerificationError> {
    let length =
        unsigned_varint::io::read_usize(&mut *reader).map_err(|_| VerificationError::InvalidCar)?;
    let remaining = reader
        .get_ref()
        .len()
        .saturating_sub(reader.position() as usize);
    if length == 0 || length > remaining || length > MAX_CAR_BYTES {
        return Err(VerificationError::InvalidCar);
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| VerificationError::InvalidCar)?;
    Ok(bytes)
}

fn bounded_dag_cbor(bytes: &[u8]) -> Result<Ipld, VerificationError> {
    // Ciborium limits recursive depth before the strict DAG-CBOR decoder runs.
    let mut reader = Cursor::new(bytes);
    let _: CborValue = ciborium::de::from_reader_with_recursion_limit(&mut reader, 64)
        .map_err(|_| VerificationError::InvalidCar)?;
    if reader.position() as usize != bytes.len() {
        return Err(VerificationError::InvalidCar);
    }
    serde_ipld_dagcbor::from_slice(bytes).map_err(|_| VerificationError::InvalidCar)
}

fn validate_mst_graph(blocks: &HashMap<Cid, Ipld>, root: Cid) -> Result<(), VerificationError> {
    // Only commit.data and its MST child pointers identify nodes. Record extensions
    // named e/l must never be mistaken for tree structure. Missing unrelated slices
    // are allowed here; exact operation membership later requires its proof path.
    let mut pending = vec![(root, 0_usize)];
    let mut visited = HashSet::new();
    while let Some((cid, depth)) = pending.pop() {
        let Some(node) = blocks.get(&cid) else {
            continue;
        };
        if depth > 256 || !visited.insert(cid) || visited.len() > blocks.len() {
            return Err(VerificationError::InvalidMst);
        }
        validate_mst_node(node)?;
        let Ipld::Map(node) = node else {
            unreachable!()
        };
        if let Some(Ipld::Link(child)) = node.get("l") {
            pending.push((*child, depth + 1));
        }
        let Some(Ipld::List(entries)) = node.get("e") else {
            unreachable!()
        };
        for entry in entries {
            let Ipld::Map(entry) = entry else {
                unreachable!()
            };
            if let Some(Ipld::Link(child)) = entry.get("t") {
                pending.push((*child, depth + 1));
            }
        }
    }
    Ok(())
}

fn validate_mst_node(value: &Ipld) -> Result<(), VerificationError> {
    let Ipld::Map(node) = value else {
        return Err(VerificationError::InvalidMst);
    };
    let Some(Ipld::List(entries)) = node.get("e") else {
        return Err(VerificationError::InvalidMst);
    };
    if !nullable_link(node.get("l")) {
        return Err(VerificationError::InvalidMst);
    }
    let mut previous = Vec::new();
    for entry in entries {
        let Ipld::Map(fields) = entry else {
            return Err(VerificationError::InvalidMst);
        };
        let prefix = match fields.get("p") {
            Some(Ipld::Integer(prefix)) => {
                usize::try_from(*prefix).map_err(|_| VerificationError::InvalidMst)?
            }
            _ => return Err(VerificationError::InvalidMst),
        };
        let Some(Ipld::Bytes(suffix)) = fields.get("k") else {
            return Err(VerificationError::InvalidMst);
        };
        if prefix > previous.len()
            || !matches!(fields.get("v"), Some(Ipld::Link(_)))
            || !nullable_link(fields.get("t"))
        {
            return Err(VerificationError::InvalidMst);
        }
        let mut key = previous[..prefix].to_vec();
        key.extend_from_slice(suffix);
        if key.is_empty()
            || key.len() > 1_024
            || (!previous.is_empty() && key <= previous)
            || std::str::from_utf8(&key).is_err()
        {
            return Err(VerificationError::InvalidMst);
        }
        previous = key;
    }
    Ok(())
}

fn nullable_link(value: Option<&Ipld>) -> bool {
    matches!(value, Some(Ipld::Null | Ipld::Link(_)))
}

/// Inspect CID-checked CAR blocks; this does not establish signature or identity trust.
pub fn content_addressed_car_blocks(
    bytes: &[u8],
    root: Cid,
) -> Result<BTreeMap<String, Vec<u8>>, VerificationError> {
    preflight_car(bytes, root)?
        .into_iter()
        .map(|(cid, value)| {
            serde_ipld_dagcbor::to_vec(&value)
                .map(|bytes| (cid.to_string(), bytes))
                .map_err(|_| VerificationError::InvalidCar)
        })
        .collect()
}

/// These descriptors are untrusted until resolver-bound signature verification succeeds.
#[derive(Clone, Debug)]
pub struct UntrustedSnapshotMetadata {
    pub did: String,
    pub revision: String,
    pub commit: Cid,
}

pub fn untrusted_snapshot_metadata(
    bytes: &[u8],
) -> Result<UntrustedSnapshotMetadata, VerificationError> {
    if bytes.len() > MAX_CAR_BYTES {
        return Err(VerificationError::CarTooLarge);
    }
    let mut reader = Cursor::new(bytes);
    let header = bounded_dag_cbor(&read_section(&mut reader)?)?;
    let Ipld::Map(header) = header else {
        return Err(VerificationError::InvalidCar);
    };
    let Some(Ipld::List(roots)) = header.get("roots") else {
        return Err(VerificationError::InvalidCar);
    };
    let Some(Ipld::Link(commit)) = roots.first() else {
        return Err(VerificationError::InvalidCar);
    };
    let blocks = preflight_car(bytes, *commit)?;
    let Some(Ipld::Map(fields)) = blocks.get(commit) else {
        return Err(VerificationError::InvalidCar);
    };
    let Some(Ipld::String(did)) = fields.get("did") else {
        return Err(VerificationError::InvalidCar);
    };
    let Some(Ipld::String(revision)) = fields.get("rev") else {
        return Err(VerificationError::InvalidCar);
    };
    Ok(UntrustedSnapshotMetadata {
        did: did.clone(),
        revision: revision.clone(),
        commit: *commit,
    })
}

pub async fn verify_snapshot_record(
    bytes: &[u8],
    expected_did: &str,
    path: &str,
    expected_cid: Option<Cid>,
    namespace: &Namespace,
    receipt_time: DateTime<Utc>,
    resolver: &dyn SigningKeyResolver,
) -> Result<VerifiedCommit, VerificationError> {
    let metadata = untrusted_snapshot_metadata(bytes)?;
    let event = CommitEvent {
        sequence: 1,
        did: metadata.did,
        revision: metadata.revision,
        since: None,
        commit: metadata.commit,
        time: receipt_time.to_rfc3339(),
        blocks: bytes.to_vec(),
        operations: vec![super::frames::Operation {
            action: if expected_cid.is_some() {
                Action::Update
            } else {
                Action::Delete
            },
            path: path.into(),
            cid: expected_cid,
        }],
    };
    verify_commit(&event, expected_did, namespace, receipt_time, resolver).await
}

/// A complete signed MST, rather than a relay slice or an unauthenticated listRecords response.
#[derive(Clone, Debug)]
pub struct VerifiedSnapshot {
    commit: VerifiedCommit,
}
impl VerifiedSnapshot {
    pub fn did(&self) -> &str {
        self.commit.did()
    }
    pub fn revision(&self) -> &str {
        self.commit.revision()
    }
    pub fn mutations(&self) -> &[VerifiedMutation] {
        self.commit.mutations()
    }
    pub(crate) fn verified_commit(&self) -> &VerifiedCommit {
        &self.commit
    }
}

/// Enumerate every signed MST entry. Missing subtrees fail closed, so absence is established
/// for both configured music collections before snapshot reconciliation may remove rows.
pub async fn verify_snapshot(
    bytes: &[u8],
    expected_did: &str,
    namespace: &Namespace,
    receipt_time: DateTime<Utc>,
    resolver: &dyn SigningKeyResolver,
) -> Result<VerifiedSnapshot, VerificationError> {
    let metadata = untrusted_snapshot_metadata(bytes)?;
    if metadata.did != expected_did {
        return Err(VerificationError::CommitMismatch);
    }
    super::frames::validate_revision(&metadata.revision)
        .map_err(|_| VerificationError::CommitMismatch)?;
    let mut store = CarStore::open(Cursor::new(bytes))
        .await
        .map_err(|_| VerificationError::InvalidCar)?;
    let mut repository = Repository::open(&mut store, metadata.commit)
        .await
        .map_err(|_| VerificationError::InvalidCar)?;
    let mut tree = repository.tree();
    let entries = tree.entries();
    futures::pin_mut!(entries);
    let mut operations = Vec::new();
    let mut previous = None;
    while let Some((path, cid)) = entries
        .try_next()
        .await
        .map_err(|_| VerificationError::MissingProof)?
    {
        if previous.as_ref().is_some_and(|old: &String| old >= &path) {
            return Err(VerificationError::InvalidMst);
        }
        previous = Some(path.clone());
        let Some((collection, rkey)) = path.split_once('/') else {
            return Err(VerificationError::InvalidMst);
        };
        if collection != namespace.scrobble_collection()
            && collection != namespace.follow_collection()
        {
            continue;
        }
        if !super::frames::valid_rkey(rkey) {
            return Err(VerificationError::MembershipMismatch);
        }
        if operations.len() == super::frames::MAX_OPERATIONS {
            return Err(VerificationError::CarTooLarge);
        }
        operations.push(super::frames::Operation {
            action: Action::Update,
            path,
            cid: Some(cid),
        });
    }
    let event = CommitEvent {
        sequence: 0,
        did: metadata.did,
        revision: metadata.revision,
        since: None,
        commit: metadata.commit,
        time: receipt_time.to_rfc3339(),
        blocks: bytes.to_vec(),
        operations,
    };
    Ok(VerifiedSnapshot {
        commit: verify_commit(&event, expected_did, namespace, receipt_time, resolver).await?,
    })
}
