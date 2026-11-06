//! Efficient signed benchmark repositories using the same maintained MST/crypto APIs.
#![allow(dead_code)]
use atmusic_atproto::sync::{
    frames::{Action, CommitEvent, Operation},
    verify::TrustedSigningKey,
};
use atrium_crypto::keypair::{Did as _, Secp256k1Keypair};
use atrium_repo::{
    Repository,
    blockstore::{AsyncBlockStoreRead, AsyncBlockStoreWrite, CarStore, MemoryBlockStore},
    mst::Tree,
};
use ipld_core::ipld::Ipld;
use serde_json::Value;
use std::{collections::BTreeMap, io::Cursor};

pub async fn signed(did: &str, records: Vec<(String, Value)>) -> (CommitEvent, TrustedSigningKey) {
    let signing = Secp256k1Keypair::import(&[7; 32]).unwrap();
    let mut memory = MemoryBlockStore::new();
    let mut operations = Vec::with_capacity(records.len());
    for (path, record) in records {
        let cid = memory
            .write_block(0x71, 0x12, &serde_ipld_dagcbor::to_vec(&record).unwrap())
            .await
            .unwrap();
        operations.push(Operation {
            action: Action::Create,
            path,
            cid: Some(cid),
        });
    }
    let data = {
        let mut tree = Tree::create(&mut memory).await.unwrap();
        for operation in &operations {
            tree.add(&operation.path, operation.cid.unwrap())
                .await
                .unwrap();
        }
        tree.root()
    };
    let revision = "3m3ijqc2abc22";
    let mut commit = BTreeMap::from([
        ("did".into(), Ipld::String(did.into())),
        ("version".into(), Ipld::Integer(3)),
        ("data".into(), Ipld::Link(data)),
        ("rev".into(), Ipld::String(revision.into())),
        ("prev".into(), Ipld::Null),
    ]);
    let signature = signing
        .sign(&serde_ipld_dagcbor::to_vec(&Ipld::Map(commit.clone())).unwrap())
        .unwrap();
    commit.insert("sig".into(), Ipld::Bytes(signature));
    let root = memory
        .write_block(
            0x71,
            0x12,
            &serde_ipld_dagcbor::to_vec(&Ipld::Map(commit)).unwrap(),
        )
        .await
        .unwrap();
    let mut repo = Repository::open(&mut memory, root).await.unwrap();
    let mut cids: Vec<_> = repo.export().await.unwrap().collect();
    drop(repo);
    cids.sort_by_key(|cid| cid.to_bytes());
    let mut blocks = Vec::new();
    let mut car = CarStore::create_with_roots(Cursor::new(&mut blocks), [root])
        .await
        .unwrap();
    for cid in cids {
        let bytes = memory.read_block(cid).await.unwrap();
        assert_eq!(
            car.write_block(cid.codec(), 0x12, &bytes).await.unwrap(),
            cid
        );
    }
    drop(car);
    (
        CommitEvent {
            sequence: 1,
            did: did.into(),
            revision: revision.into(),
            since: None,
            commit: root,
            time: "2026-01-15T12:00:00Z".into(),
            blocks,
            operations,
        },
        TrustedSigningKey {
            did: did.into(),
            did_key: signing.did(),
            valid_from: "2222222222222".into(),
            valid_until: None,
        },
    )
}

/// Shared exact benchmark dataset for the example and isolated query-plan acceptance.
/// Every one of the 100,000 rows is admitted by the production signature/CID/MST gate.
pub async fn seed_benchmark(database: &atmusic_storage::Database) {
    use atmusic_atproto::sync::apply::{ApplyContext, apply_commit};
    use atmusic_core::namespace::Namespace;
    use atmusic_storage::User;
    use chrono::{Duration, Utc};
    use serde_json::json;
    let now = "2026-01-15T12:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let namespace = Namespace::new("com.example.atmusic").unwrap();
    for actor in 0..100 {
        let did = format!("did:web:benchmark-{actor:03}.test");
        database
            .repositories()
            .upsert_user(User::new(&did, now.to_rfc3339()))
            .await
            .unwrap();
        let records=(0..1000).map(|number|(format!("com.example.atmusic.scrobble/r{number:04}"),json!({
            "$type":"com.example.atmusic.scrobble","artist":format!("Artist {:03}",number%100),
            "track":format!("Track {:04}",number%500),"album":format!("Album {:03}",number%50),
            "listenedAt":(now-Duration::seconds(i64::from(number)*60+i64::from(actor))).to_rfc3339(),"createdAt":now.to_rfc3339()
        }))).collect();
        let (event, key) = signed(&did, records).await;
        let result = apply_commit(
            &database.repositories(),
            &event,
            ApplyContext {
                relay: &format!("wss://benchmark.test/{actor}"),
                expected_did: &did,
                namespace: &namespace,
                receipt_time: now,
                resolver: &BulkResolver(key),
            },
        )
        .await
        .unwrap();
        assert!(result.applied && result.excluded.is_empty());
    }
    let counts: (i64, i64) =
        sqlx::query_as("SELECT count(*),count(DISTINCT did) FROM scrobbles WHERE confirmed=1")
            .fetch_one(database.reader_pool())
            .await
            .unwrap();
    assert_eq!(counts, (100_000, 100));
}
struct BulkResolver(TrustedSigningKey);
#[async_trait::async_trait]
impl atmusic_atproto::sync::verify::SigningKeyResolver for BulkResolver {
    async fn resolve_for_revision(
        &self,
        did: &str,
        _: &str,
    ) -> Result<TrustedSigningKey, atmusic_atproto::sync::verify::VerificationError> {
        if self.0.did != did {
            return Err(atmusic_atproto::sync::verify::VerificationError::UntrustedIdentity);
        }
        Ok(self.0.clone())
    }
}
