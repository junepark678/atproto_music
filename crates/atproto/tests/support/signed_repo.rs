//! Generated, genuinely signed repositories. Deterministic private keys exist only in tests.
// Shared by several integration targets, each of which uses a different subset.
#![allow(dead_code)]

use async_trait::async_trait;
use atmusic_atproto::sync::{
    frames::{Action, CommitEvent, Operation},
    verify::{SigningKeyResolver, TrustedSigningKey, VerificationError},
};
use atrium_crypto::keypair::{Did as _, Secp256k1Keypair};
use atrium_repo::{
    Repository,
    blockstore::{AsyncBlockStoreRead, AsyncBlockStoreWrite, CarStore, MemoryBlockStore},
};
use ipld_core::{cid::Cid, ipld::Ipld};
use serde_json::Value;
use std::io::Cursor;

pub const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
pub const REVISION: &str = "3m4zm2ufr2222";
#[derive(Clone)]
pub struct SignedFixture {
    pub event: CommitEvent,
    pub key: TrustedSigningKey,
    pub record_cids: Vec<Cid>,
}
#[derive(Clone)]
pub struct FixtureResolver(pub TrustedSigningKey);

#[async_trait]
impl SigningKeyResolver for FixtureResolver {
    async fn resolve_for_revision(
        &self,
        did: &str,
        _: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        if self.0.did != did {
            return Err(VerificationError::UntrustedIdentity);
        }
        Ok(self.0.clone())
    }
}

pub async fn signed_repo(records: Vec<(String, Value)>, signing_seed: u8) -> SignedFixture {
    signed_repo_with_bad_signature(records, signing_seed, false).await
}

pub async fn signed_repo_for(
    did: &str,
    records: Vec<(String, Value)>,
    signing_seed: u8,
    revision: &str,
) -> SignedFixture {
    build_repo(did, records, signing_seed, revision, false).await
}
pub async fn signed_repo_with_bad_signature(
    records: Vec<(String, Value)>,
    signing_seed: u8,
    corrupt: bool,
) -> SignedFixture {
    build_repo(ALICE, records, signing_seed, REVISION, corrupt).await
}

async fn build_repo(
    did: &str,
    records: Vec<(String, Value)>,
    signing_seed: u8,
    revision: &str,
    corrupt: bool,
) -> SignedFixture {
    let keypair = Secp256k1Keypair::import(&[signing_seed; 32]).unwrap();
    let mut memory = MemoryBlockStore::new();
    // RepoBuilder has no injected-clock/rev setter; construct the version-3 initial commit
    // with maintained MST/CBOR/hash/signing APIs so no wall clock enters fixture evidence.
    let data = atrium_repo::mst::Tree::create(&mut memory)
        .await
        .unwrap()
        .root();
    let initial_revision = if records.is_empty() {
        revision
    } else {
        "2222222222222"
    };
    let mut initial = std::collections::BTreeMap::from([
        ("did".into(), Ipld::String(did.into())),
        ("version".into(), Ipld::Integer(3)),
        ("data".into(), Ipld::Link(data)),
        ("rev".into(), Ipld::String(initial_revision.into())),
        ("prev".into(), Ipld::Null),
    ]);
    let signature = keypair
        .sign(&serde_ipld_dagcbor::to_vec(&Ipld::Map(initial.clone())).unwrap())
        .unwrap();
    initial.insert("sig".into(), Ipld::Bytes(signature));
    let root = memory
        .write_block(
            0x71,
            0x12,
            &serde_ipld_dagcbor::to_vec(&Ipld::Map(initial)).unwrap(),
        )
        .await
        .unwrap();
    let mut repository = Repository::open(&mut memory, root).await.unwrap();
    let mut operations = Vec::new();
    let mut record_cids = Vec::new();
    let count = records.len();
    for (index, (path, record)) in records.into_iter().enumerate() {
        let (mut builder, cid) = repository.add_raw(&path, &record).await.unwrap();
        builder.rev(revision.parse().unwrap());
        let mut signature = keypair.sign(&builder.bytes()).unwrap();
        if corrupt && index + 1 == count {
            signature[0] ^= 1;
        }
        builder.finalize(signature).await.unwrap();
        record_cids.push(cid);
        operations.push(Operation {
            action: Action::Create,
            path,
            cid: Some(cid),
        });
    }
    let root = repository.root();
    drop(repository);
    let bytes = pack_repository(&mut memory, root).await;
    let key = TrustedSigningKey {
        did: did.into(),
        did_key: keypair.did(),
        valid_from: "2222222222222".into(),
        valid_until: None,
    };
    SignedFixture {
        event: CommitEvent {
            sequence: 1,
            did: did.into(),
            revision: revision.into(),
            since: None,
            commit: root,
            time: "2026-01-15T12:00:00Z".into(),
            blocks: bytes,
            operations,
        },
        key,
        record_cids,
    }
}

/// Generate a genuine successor repository with a single create/update/delete mutation.
pub async fn signed_mutation(
    previous: &SignedFixture,
    path: &str,
    record: Option<Value>,
    signing_seed: u8,
    revision: &str,
) -> SignedFixture {
    let keypair = Secp256k1Keypair::import(&[signing_seed; 32]).unwrap();
    let mut memory = MemoryBlockStore::new();
    let mut previous_car = CarStore::open(Cursor::new(&previous.event.blocks))
        .await
        .unwrap();
    let mut previous_repo = Repository::open(&mut previous_car, previous.event.commit)
        .await
        .unwrap();
    previous_repo.export_into(&mut memory).await.unwrap();
    let mut repository = Repository::open(&mut memory, previous.event.commit)
        .await
        .unwrap();
    let exists = repository.get_raw::<Value>(path).await.unwrap().is_some();
    let (mut builder, action, cid) = if let Some(record) = record {
        let (builder, cid) = if exists {
            repository.update_raw(path, &record).await.unwrap()
        } else {
            repository.add_raw(path, &record).await.unwrap()
        };
        (
            builder,
            if exists {
                Action::Update
            } else {
                Action::Create
            },
            Some(cid),
        )
    } else {
        (
            repository.delete_raw(path).await.unwrap(),
            Action::Delete,
            None,
        )
    };
    builder.rev(revision.parse().unwrap());
    let signature = keypair.sign(&builder.bytes()).unwrap();
    builder.finalize(signature).await.unwrap();
    let root = repository.root();
    drop(repository);
    let bytes = pack_repository(&mut memory, root).await;
    SignedFixture {
        event: CommitEvent {
            sequence: previous.event.sequence + 1,
            did: previous.event.did.clone(),
            revision: revision.into(),
            since: Some(previous.event.revision.clone()),
            commit: root,
            time: "2026-01-15T12:00:00Z".into(),
            blocks: bytes,
            operations: vec![Operation {
                action,
                path: path.into(),
                cid,
            }],
        },
        key: TrustedSigningKey {
            did: previous.event.did.clone(),
            did_key: keypair.did(),
            valid_from: "2222222222222".into(),
            valid_until: None,
        },
        record_cids: cid.into_iter().collect(),
    }
}

async fn pack_repository(memory: &mut MemoryBlockStore, root: Cid) -> Vec<u8> {
    let mut repository = Repository::open(&mut *memory, root).await.unwrap();
    let mut cids: Vec<_> = repository.export().await.unwrap().collect();
    drop(repository);
    cids.sort_by_key(Cid::to_bytes);
    let mut bytes = Vec::new();
    let mut car = CarStore::create_with_roots(Cursor::new(&mut bytes), [root])
        .await
        .unwrap();
    for cid in cids {
        let block = memory.read_block(cid).await.unwrap();
        assert_eq!(
            car.write_block(cid.codec(), 0x12, &block).await.unwrap(),
            cid
        );
    }
    drop(car);
    bytes
}
