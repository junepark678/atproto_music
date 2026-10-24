//! Rust-oracle golden export of genuinely signed repository CARs (W0-03, ADR 0004 §7.7, F9).
//!
//! Writes, for secp256k1 and P-256, a getRecord inclusion-proof CAR, an exclusion-proof CAR,
//! a full repository CAR (music plus 50 non-music records) and one CAR per single corruption,
//! to `<out>/signed_cars/<name>.car` with `<out>/signed_cars/manifest.json`. Every CAR is then
//! read back from disk and run through the frozen Rust verifier (`verify_snapshot_record` /
//! `verify_snapshot`); the export aborts unless each valid CAR verifies and each corrupted CAR
//! fails with exactly the Rust error recorded in its manifest entry.
//!
//! It also writes `snapshot_enumeration.json` (the record set `verify_snapshot` returns for each
//! full-repo CAR) and the storage-backed goldens `stats_read_models.json` and `windows.json`,
//! which need the frozen `atmusic-storage` statistics query (atmusic-core cannot depend on it).
//!
//! Usage: `cargo run --locked -p atmusic-atproto --example export_signed_cars -- [--out DIR]`
//! (default `tests/goldens`). Everything is rendered twice in-process and must be
//! byte-identical before files are written.
//!
//! The signing keys are fixed, public, test-only seeds (`[seed; 32]`), exactly as in
//! `tests/support/signed_repo.rs`. They must never be used for anything but fixtures.

#[path = "../tests/support/signed_repo.rs"]
mod signed_repo;

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

use atmusic_atproto::sync::{
    frames::MAX_CAR_BYTES,
    verify::{
        TrustedSigningKey, VerificationError, VerifiedMutation, VerifiedRecord, verify_commit,
        verify_snapshot, verify_snapshot_record,
    },
};
use atmusic_core::{
    follow::follow_rkey,
    music_key::normalize,
    namespace::{FIXTURE_PREFIX, Namespace},
};
use atmusic_storage::{
    Checkpoint, Database, FollowRow, PageBounds, RecordMutation, RepositoryEvent, ScrobbleRow,
    StatisticsWindow, User,
};
use atrium_crypto::keypair::{Did as _, P256Keypair, Secp256k1Keypair};
use atrium_repo::{
    Repository,
    blockstore::{AsyncBlockStoreRead, AsyncBlockStoreWrite, MemoryBlockStore},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ipld_core::{
    cid::{Cid, multihash::Multihash},
    ipld::Ipld,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use signed_repo::{FixtureResolver, signed_repo_for};

const AS_OF: &str = "2026-01-15T12:00:00Z";
const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: &str = "did:plc:cccccccccccccccccccccccc";
const FOREIGN_DID: &str = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
const INITIAL_REVISION: &str = "2222222222222";
const REVISION: &str = signed_repo::REVISION;
const NON_TID_REVISION: &str = "1111111111111";
const INCLUSION_PATH: &str = "com.example.atmusic.scrobble/r01";
const EXCLUSION_PATH: &str = "com.example.atmusic.scrobble/r08";
const SOURCE: &str = "crates/atproto/examples/export_signed_cars.rs";
const SECP256K1_SEED: u8 = 0x07;
const P256_SEED: u8 = 0x07;
const FIXTURE: &str = include_str!("../../../tests/fixtures/read_models.json");

// Curve orders, for building the high-S twin of a low-S signature.
const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const P256_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let out = output_dir();
    let first = render_all().await;
    let second = render_all().await;
    assert!(
        first == second,
        "signed CAR export is not deterministic within one process"
    );
    fs::create_dir_all(out.join("signed_cars")).expect("create output directory");
    for (name, body) in &first {
        fs::write(out.join(name), body).expect("write golden file");
    }
    let (valid, invalid) = verify_written(&out).await;
    println!(
        "export_signed_cars: wrote {} files to {}; two in-process renders byte-identical; \
         re-read from disk: {valid} valid CARs verified by the Rust verifier, {invalid} corrupted CARs \
         rejected with their manifest error",
        first.len(),
        out.display()
    );
}

fn output_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    let mut out = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = Some(PathBuf::from(args.next().expect("--out requires a path"))),
            other => panic!("unknown argument {other}; usage: export_signed_cars [--out DIR]"),
        }
    }
    out.unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/goldens"))
}

fn pretty(value: &Value) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(value).expect("serialize golden");
    text.push('\n');
    text.into_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).expect("fixture namespace")
}

fn dag_cbor_cid(bytes: &[u8]) -> Cid {
    Cid::new_v1(
        0x71,
        Multihash::wrap(0x12, &Sha256::digest(bytes)).expect("sha2-256 multihash"),
    )
}

// ---------------------------------------------------------------------------------------
// Signing keys
// ---------------------------------------------------------------------------------------

enum Signer {
    Secp256k1(Secp256k1Keypair),
    P256(P256Keypair),
}

impl Signer {
    fn new(curve: &str) -> Self {
        match curve {
            "secp256k1" => {
                Self::Secp256k1(Secp256k1Keypair::import(&[SECP256K1_SEED; 32]).unwrap())
            }
            "p256" => Self::P256(P256Keypair::import(&[P256_SEED; 32]).unwrap()),
            other => unreachable!("unknown curve {other}"),
        }
    }
    fn seed(&self) -> u8 {
        match self {
            Self::Secp256k1(_) => SECP256K1_SEED,
            Self::P256(_) => P256_SEED,
        }
    }
    fn sign(&self, message: &[u8]) -> Vec<u8> {
        match self {
            Self::Secp256k1(key) => key.sign(message).unwrap(),
            Self::P256(key) => key.sign(message).unwrap(),
        }
    }
    fn did_key(&self) -> String {
        match self {
            Self::Secp256k1(key) => key.did(),
            Self::P256(key) => key.did(),
        }
    }
    fn order(&self) -> &'static [u8; 32] {
        match self {
            Self::Secp256k1(_) => &SECP256K1_N,
            Self::P256(_) => &P256_N,
        }
    }
    fn trusted(&self, did: &str) -> TrustedSigningKey {
        TrustedSigningKey {
            did: did.into(),
            did_key: self.did_key(),
            valid_from: INITIAL_REVISION.into(),
            valid_until: None,
        }
    }
}

/// n - s over 32-byte big-endian integers (s < n).
fn negate_scalar(order: &[u8; 32], s: &[u8]) -> Vec<u8> {
    let mut out = vec![0_u8; 32];
    let mut borrow = 0_i16;
    for i in (0..32).rev() {
        let mut value = i16::from(order[i]) - i16::from(s[i]) - borrow;
        borrow = 0;
        if value < 0 {
            value += 256;
            borrow = 1;
        }
        out[i] = value as u8;
    }
    assert_eq!(borrow, 0, "s must be below the curve order");
    out
}

// ---------------------------------------------------------------------------------------
// CAR model
// ---------------------------------------------------------------------------------------

#[derive(Clone)]
struct Car {
    root: Cid,
    blocks: Vec<(Cid, Vec<u8>)>,
}

impl Car {
    fn encode(&self) -> Vec<u8> {
        let header = serde_ipld_dagcbor::to_vec(&Ipld::Map(BTreeMap::from([
            ("roots".to_string(), Ipld::List(vec![Ipld::Link(self.root)])),
            ("version".to_string(), Ipld::Integer(1)),
        ])))
        .unwrap();
        let mut out = Vec::new();
        push_section(&mut out, &[&header]);
        for (cid, block) in &self.blocks {
            push_section(&mut out, &[&cid.to_bytes(), block]);
        }
        out
    }
    fn block(&self, cid: Cid) -> &[u8] {
        &self
            .blocks
            .iter()
            .find(|(c, _)| *c == cid)
            .expect("block present")
            .1
    }
    fn replace(&mut self, old: Cid, new: Cid, bytes: Vec<u8>) {
        let slot = self
            .blocks
            .iter_mut()
            .find(|(c, _)| *c == old)
            .expect("block present");
        *slot = (new, bytes);
    }
    fn remove(&mut self, cid: Cid) {
        let before = self.blocks.len();
        self.blocks.retain(|(c, _)| *c != cid);
        assert_eq!(self.blocks.len() + 1, before, "exactly one block removed");
    }
    fn commit_map(&self) -> BTreeMap<String, Ipld> {
        match serde_ipld_dagcbor::from_slice::<Ipld>(self.block(self.root)).unwrap() {
            Ipld::Map(map) => map,
            _ => unreachable!("commit is a map"),
        }
    }
    fn data_cid(&self) -> Cid {
        match self.commit_map().get("data") {
            Some(Ipld::Link(cid)) => *cid,
            _ => unreachable!("commit has data"),
        }
    }
    /// Re-encode the commit after `mutate`, optionally re-signing the unsigned bytes.
    fn rewrite_commit(
        &self,
        signer: Option<&Signer>,
        mutate: impl FnOnce(&mut BTreeMap<String, Ipld>),
    ) -> Car {
        let mut map = self.commit_map();
        if let Some(signer) = signer {
            map.remove("sig");
            mutate(&mut map);
            let unsigned = serde_ipld_dagcbor::to_vec(&Ipld::Map(map.clone())).unwrap();
            map.insert("sig".into(), Ipld::Bytes(signer.sign(&unsigned)));
        } else {
            mutate(&mut map);
        }
        let bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(map)).unwrap();
        let cid = dag_cbor_cid(&bytes);
        let mut car = self.clone();
        car.replace(self.root, cid, bytes);
        car.root = cid;
        car
    }
}

fn push_section(out: &mut Vec<u8>, parts: &[&[u8]]) {
    let length: usize = parts.iter().map(|p| p.len()).sum();
    let mut buffer = unsigned_varint::encode::usize_buffer();
    out.extend_from_slice(unsigned_varint::encode::usize(length, &mut buffer));
    for part in parts {
        out.extend_from_slice(part);
    }
}

// ---------------------------------------------------------------------------------------
// Repository construction (mirrors signed_repo.rs build_repo for any curve)
// ---------------------------------------------------------------------------------------

struct BuiltRepo {
    memory: MemoryBlockStore,
    root: Cid,
    record_cids: HashMap<String, Cid>,
}

async fn build_repo(did: &str, records: &[(String, Value)], signer: &Signer) -> BuiltRepo {
    let mut memory = MemoryBlockStore::new();
    let data = atrium_repo::mst::Tree::create(&mut memory)
        .await
        .unwrap()
        .root();
    let mut initial = BTreeMap::from([
        ("did".to_string(), Ipld::String(did.into())),
        ("version".into(), Ipld::Integer(3)),
        ("data".into(), Ipld::Link(data)),
        ("rev".into(), Ipld::String(INITIAL_REVISION.into())),
        ("prev".into(), Ipld::Null),
    ]);
    let signature = signer.sign(&serde_ipld_dagcbor::to_vec(&Ipld::Map(initial.clone())).unwrap());
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
    let mut record_cids = HashMap::new();
    for (path, record) in records {
        let (mut builder, cid) = repository.add_raw(path, record).await.unwrap();
        builder.rev(REVISION.parse().unwrap());
        let signature = signer.sign(&builder.bytes());
        builder.finalize(signature).await.unwrap();
        record_cids.insert(path.clone(), cid);
    }
    let root = repository.root();
    drop(repository);
    BuiltRepo {
        memory,
        root,
        record_cids,
    }
}

async fn read(memory: &mut MemoryBlockStore, cid: Cid) -> Vec<u8> {
    memory.read_block(cid).await.unwrap()
}

/// The signed tree must enumerate exactly the inserted records, and inserting the same records
/// in reverse key order must yield the identical MST root (the MST is canonical for a key set).
async fn assert_complete_and_canonical(
    repo: &mut BuiltRepo,
    records: &[(String, Value)],
    signer: &Signer,
) {
    use futures::TryStreamExt;
    let mut repository = Repository::open(&mut repo.memory, repo.root).await.unwrap();
    let data = repository.commit().data();
    let entries: Vec<(String, Cid)> = repository.tree().entries().try_collect().await.unwrap();
    drop(repository);
    let expected: Vec<(String, Cid)> = records
        .iter()
        .map(|(path, _)| (path.clone(), repo.record_cids[path]))
        .collect();
    assert_eq!(
        entries, expected,
        "signed MST enumerates exactly the inserted records"
    );
    let mut reversed = records.to_vec();
    reversed.reverse();
    let mut other = build_repo(ALICE, &reversed, signer).await;
    let other_data = Repository::open(&mut other.memory, other.root)
        .await
        .unwrap()
        .commit()
        .data();
    assert_eq!(
        data, other_data,
        "MST root is independent of insertion order"
    );
}

/// The full repository, blocks sorted by CID bytes exactly as signed_repo.rs packs them.
async fn full_car(repo: &mut BuiltRepo) -> Car {
    let mut repository = Repository::open(&mut repo.memory, repo.root).await.unwrap();
    let mut cids: Vec<_> = repository.export().await.unwrap().collect();
    drop(repository);
    cids.sort_by_key(Cid::to_bytes);
    cids.dedup();
    let mut blocks = Vec::new();
    for cid in cids {
        blocks.push((cid, read(&mut repo.memory, cid).await));
    }
    Car {
        root: repo.root,
        blocks,
    }
}

/// A getRecord-style proof: the commit, the MST path nodes root to leaf, then the record
/// block when present (atrium `extract_raw`, i.e. what a PDS serves for sync.getRecord).
async fn proof_car(repo: &mut BuiltRepo, path: &str) -> Car {
    let mut repository = Repository::open(&mut repo.memory, repo.root).await.unwrap();
    let cids: Vec<_> = repository.extract_raw(path).await.unwrap().collect();
    drop(repository);
    let mut blocks: Vec<(Cid, Vec<u8>)> = Vec::new();
    for cid in cids {
        if !blocks.iter().any(|(c, _)| *c == cid) {
            blocks.push((cid, read(&mut repo.memory, cid).await));
        }
    }
    Car {
        root: repo.root,
        blocks,
    }
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("shared read-model fixture")
}

/// Alice's confirmed fixture scrobbles, her follow of Bob, one schema-invalid scrobble that
/// the verifier must exclude, and 50 non-music records around the namespace range boundaries.
fn repo_records() -> Vec<(String, Value)> {
    let fixture = fixture();
    let mut records: Vec<(String, Value)> = fixture["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["owner"] == ALICE && item["state"] == "confirmed")
        .map(|item| {
            (
                format!(
                    "{FIXTURE_PREFIX}.scrobble/{}",
                    item["rkey"].as_str().unwrap()
                ),
                item["record"].clone(),
            )
        })
        .collect();
    records.push((
        format!("{FIXTURE_PREFIX}.follow/{}", follow_rkey(BOB).unwrap()),
        json!({"$type": format!("{FIXTURE_PREFIX}.follow"), "subject": BOB, "createdAt": "2025-01-01T00:00:00Z"}),
    ));
    records.push((
        format!("{FIXTURE_PREFIX}.scrobble/r99"),
        json!({"$type": format!("{FIXTURE_PREFIX}.scrobble"), "artist": "\u{3000}", "track": "Untitled", "listenedAt": "2026-01-15T10:00:00Z", "createdAt": "2026-01-15T10:00:00Z"}),
    ));
    let non_music: [(&str, &str, usize); 6] = [
        ("app.bsky.feed.post", "p", 20),
        ("app.bsky.feed.like", "l", 10),
        ("com.example.atmusia.post", "a", 5),
        ("com.example.atmusic-x.post", "h", 5),
        ("com.example.atmusicz.post", "z", 5),
        ("zz.example.other", "o", 5),
    ];
    for (collection, prefix, count) in non_music {
        for i in 0..count {
            records.push((
                format!("{collection}/{prefix}{i:02}"),
                json!({"$type": collection, "text": format!("non-music {collection} {i}"), "createdAt": "2026-01-01T00:00:00Z"}),
            ));
        }
    }
    let music = records
        .iter()
        .filter(|(path, _)| path.starts_with(&format!("{FIXTURE_PREFIX}.")))
        .count();
    assert_eq!(records.len() - music, 50, "exactly 50 non-music records");
    records
}

// ---------------------------------------------------------------------------------------
// Signed CAR cases
// ---------------------------------------------------------------------------------------

struct Case {
    name: String,
    mst_cids: HashMap<String, Cid>,
    kind: &'static str,
    base: Option<String>,
    corruption: Option<&'static str>,
    description: String,
    verifier: &'static str,
    path: &'static str,
    target_cid: Option<Cid>,
    bytes: Vec<u8>,
    expected_code: Option<&'static str>,
    expected_state: Option<&'static str>,
    rust_error: Option<&'static str>,
}

async fn curve_cases(curve: &'static str) -> Vec<Case> {
    let signer = Signer::new(curve);
    // atrium-repo 0.1.8 MST insertion silently drops entries for some insertion orders
    // (observed: r01, r02 and the follow vanish when the 59 records are added in fixture
    // order). Insert in key order, then prove the tree is complete and order-independent.
    let mut records = repo_records();
    records.sort_by(|a, b| a.0.cmp(&b.0));
    let mut repo = build_repo(ALICE, &records, &signer).await;
    assert_complete_and_canonical(&mut repo, &records, &signer).await;
    let full = full_car(&mut repo).await;
    if curve == "secp256k1" {
        // The generic builder must reproduce the shared test helper byte for byte.
        let helper = signed_repo_for(ALICE, records.clone(), SECP256K1_SEED, REVISION).await;
        assert_eq!(
            helper.event.blocks,
            full.encode(),
            "builder matches signed_repo.rs"
        );
        assert_eq!(helper.event.commit, full.root);
    }
    // Re-signing an unchanged commit must reproduce it exactly (deterministic RFC 6979).
    assert_eq!(
        full.rewrite_commit(Some(&signer), |_| {}).encode(),
        full.encode(),
        "commit re-encoding and re-signing is canonical"
    );
    let inclusion = proof_car(&mut repo, INCLUSION_PATH).await;
    let exclusion = proof_car(&mut repo, EXCLUSION_PATH).await;
    let record_cid = repo.record_cids[INCLUSION_PATH];
    assert!(!repo.record_cids.contains_key(EXCLUSION_PATH));

    let mst_cids = repo.record_cids.clone();
    let name = |case: &str| format!("{curve}_{case}");
    let full_name = name("full_repo");
    let mut cases = Vec::new();
    let mut push = |case: &str,
                    kind: &'static str,
                    base: Option<&str>,
                    corruption: Option<&'static str>,
                    description: &str,
                    verifier: &'static str,
                    path: &'static str,
                    target_cid: Option<Cid>,
                    bytes: Vec<u8>,
                    expected: (Option<&'static str>, Option<&'static str>),
                    rust_error: Option<&'static str>| {
        cases.push(Case {
            name: name(case),
            mst_cids: mst_cids.clone(),
            kind,
            base: base.map(str::to_string),
            corruption,
            description: description.into(),
            verifier,
            path,
            target_cid,
            bytes,
            expected_code: expected.0,
            expected_state: expected.1,
            rust_error,
        })
    };

    push(
        "getrecord_inclusion",
        "inclusion_proof",
        None,
        None,
        "sync.getRecord-style inclusion proof for r01: signed commit, MST path nodes root to leaf, record block.",
        "verify_snapshot_record",
        INCLUSION_PATH,
        Some(record_cid),
        inclusion.encode(),
        (None, Some("present")),
        None,
    );
    push(
        "getrecord_exclusion",
        "exclusion_proof",
        None,
        None,
        "sync.getRecord-style exclusion proof for r08 (absent): signed commit and the MST path nodes covering the key.",
        "verify_snapshot_record",
        EXCLUSION_PATH,
        None,
        exclusion.encode(),
        (None, Some("absent")),
        None,
    );
    push(
        "full_repo",
        "full_repo",
        None,
        None,
        "Complete signed repository: 7 fixture scrobbles, 1 follow, 1 schema-invalid scrobble (r99, excluded) and 50 non-music records.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        full.encode(),
        (None, None),
        None,
    );

    let corrupt = |car: Car| car.encode();
    let base = Some(full_name.as_str());

    let signature_byte = full.rewrite_commit(None, |map| {
        if let Some(Ipld::Bytes(sig)) = map.get_mut("sig") {
            sig[0] ^= 0x01;
        }
    });
    push(
        "corrupt_signature_byte",
        "corruption",
        base,
        Some("signature_byte"),
        "Bit 0 of the first signature byte flipped; the commit block is re-hashed and the CAR root updated, so only the signature is wrong.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(signature_byte),
        (Some("bad_signature"), None),
        Some("InvalidSignature"),
    );

    let order = signer.order();
    let high_s = full.rewrite_commit(None, |map| {
        if let Some(Ipld::Bytes(sig)) = map.get_mut("sig") {
            let high = negate_scalar(order, &sig[32..64]);
            sig[32..64].copy_from_slice(&high);
        }
    });
    push(
        "corrupt_signature_high_s",
        "corruption",
        base,
        Some("signature_high_s"),
        "Signature replaced by its malleable high-S twin (s -> n - s); mathematically valid ECDSA but forbidden by atproto. Commit re-hashed, root updated.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(high_s),
        (Some("bad_signature"), None),
        Some("InvalidSignature"),
    );

    let mut record_byte = full.clone();
    {
        let slot = record_byte
            .blocks
            .iter_mut()
            .find(|(c, _)| *c == record_cid)
            .unwrap();
        let last = slot.1.len() - 1;
        slot.1[last] ^= 0x01;
    }
    push(
        "corrupt_record_block_byte",
        "corruption",
        base,
        Some("record_block_byte"),
        "Bit 0 of the last byte of the r01 record block flipped; its CID is unchanged.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(record_byte),
        (Some("cid_mismatch"), None),
        Some("CidMismatch"),
    );

    let mst_root = full.data_cid();
    let mut mst_byte = full.clone();
    {
        let slot = mst_byte
            .blocks
            .iter_mut()
            .find(|(c, _)| *c == mst_root)
            .unwrap();
        let last = slot.1.len() - 1;
        slot.1[last] ^= 0x01;
    }
    push(
        "corrupt_mst_node_byte",
        "corruption",
        base,
        Some("mst_node_byte"),
        "Bit 0 of the last byte of the MST root node (commit.data, on every key's path) flipped; its CID is unchanged.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(mst_byte),
        (Some("cid_mismatch"), None),
        Some("CidMismatch"),
    );

    let mst_structure = {
        let node = full.block(mst_root).to_vec();
        let Ipld::Map(mut map) = serde_ipld_dagcbor::from_slice::<Ipld>(&node).unwrap() else {
            unreachable!()
        };
        let Some(Ipld::List(entries)) = map.get_mut("e") else {
            unreachable!()
        };
        assert!(!entries.is_empty(), "MST root node has entries");
        let Ipld::Map(first) = &mut entries[0] else {
            unreachable!()
        };
        assert_eq!(first.get("p"), Some(&Ipld::Integer(0)));
        first.insert("p".into(), Ipld::Integer(1));
        let bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(map)).unwrap();
        let cid = dag_cbor_cid(&bytes);
        let mut car = full.clone();
        car.replace(mst_root, cid, bytes);
        car.rewrite_commit(Some(&signer), |commit| {
            commit.insert("data".into(), Ipld::Link(cid));
        })
    };
    push(
        "corrupt_mst_structure_resigned",
        "corruption",
        base,
        Some("mst_structure"),
        "MST root node's first entry claims prefix length 1 with no previous key; node re-hashed and commit.data re-signed, so hashes and signature are valid and only the MST invariant fails.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(mst_structure),
        (Some("mst_invalid"), None),
        Some("InvalidMst"),
    );

    let did = full.rewrite_commit(Some(&signer), |map| {
        map.insert("did".into(), Ipld::String(FOREIGN_DID.into()));
    });
    push(
        "corrupt_did",
        "corruption",
        base,
        Some("did"),
        "Commit did replaced by did:plc:zzzzzzzzzzzzzzzzzzzzzzzz and re-signed with the same key; the expected DID is Alice's.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(did),
        (Some("did_mismatch"), None),
        Some("CommitMismatch"),
    );

    let version = full.rewrite_commit(Some(&signer), |map| {
        map.insert("version".into(), Ipld::Integer(2));
    });
    push(
        "corrupt_version",
        "corruption",
        base,
        Some("version"),
        "Commit version 2 instead of 3, re-signed.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(version),
        (Some("bad_version"), None),
        Some("CommitMismatch"),
    );

    let rev = full.rewrite_commit(Some(&signer), |map| {
        map.insert("rev".into(), Ipld::String(NON_TID_REVISION.into()));
    });
    push(
        "corrupt_rev",
        "corruption",
        base,
        Some("rev"),
        "Commit rev '1111111111111' (13 characters, outside the TID base32 alphabet), re-signed.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(rev),
        (Some("bad_rev"), None),
        Some("CommitMismatch"),
    );

    let mut root = full.clone();
    root.root = dag_cbor_cid(b"atmusic golden: absent commit root");
    push(
        "corrupt_root",
        "corruption",
        base,
        Some("root"),
        "CAR header root replaced by a well-formed dag-cbor CID with no block in the CAR; all blocks unchanged.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(root),
        (Some("missing_block"), None),
        Some("MissingProof"),
    );

    let full_bytes = full.encode();
    push(
        "corrupt_truncated",
        "corruption",
        base,
        Some("truncation"),
        "Full repo CAR truncated to its first half (mid-section).",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        full_bytes[..full_bytes.len() / 2].to_vec(),
        (Some("car_malformed"), None),
        Some("InvalidCar"),
    );

    let oversize = {
        let target = MAX_CAR_BYTES + 1;
        let mut padding = target - full_bytes.len() - 45;
        loop {
            let block = serde_ipld_dagcbor::to_vec(&Ipld::Bytes(vec![0; padding])).unwrap();
            let mut car = full.clone();
            car.blocks.push((dag_cbor_cid(&block), block));
            let bytes = car.encode();
            match bytes.len().cmp(&target) {
                std::cmp::Ordering::Equal => break bytes,
                std::cmp::Ordering::Greater => padding -= bytes.len() - target,
                std::cmp::Ordering::Less => padding += target - bytes.len(),
            }
        }
    };
    push(
        "corrupt_oversize",
        "corruption",
        base,
        Some("oversize"),
        "Well-formed full repo CAR plus one unreferenced, correctly hashed dag-cbor padding block, totalling 8 MiB + 1 byte (one over the Rust MAX_CAR_BYTES).",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        oversize,
        (Some("car_too_large"), None),
        Some("CarTooLarge"),
    );

    let swap = {
        let mut other = records
            .iter()
            .find(|(path, _)| path == INCLUSION_PATH)
            .unwrap()
            .1
            .clone();
        other["track"] = json!("Jóga (swapped)");
        let bytes = serde_ipld_dagcbor::to_vec(&other).unwrap();
        let cid = dag_cbor_cid(&bytes);
        assert_ne!(cid, record_cid);
        let mut car = full.clone();
        car.replace(record_cid, cid, bytes);
        car
    };
    push(
        "corrupt_record_cid_swap",
        "corruption",
        base,
        Some("record_cid_swap"),
        "The r01 record block is replaced by a different, correctly hashed record block (track 'Jóga (swapped)'); the signed MST still commits to the original r01 CID, whose block is now absent.",
        "verify_snapshot",
        INCLUSION_PATH,
        Some(record_cid),
        corrupt(swap),
        (Some("record_cid_mismatch"), None),
        Some("MissingProof"),
    );

    // Proof CARs with the deepest MST path node removed: absence must never be inferred.
    let deepest = |car: &Car, skip_record: bool| {
        let end = if skip_record {
            car.blocks.len() - 1
        } else {
            car.blocks.len()
        };
        car.blocks[1..end].last().expect("path node").0
    };
    let mut inclusion_missing = inclusion.clone();
    inclusion_missing.remove(deepest(&inclusion, true));
    push(
        "inclusion_missing_mst_node",
        "corruption",
        Some(&name("getrecord_inclusion")),
        Some("missing_path_node"),
        "Inclusion proof for r01 with the deepest MST path node removed.",
        "verify_snapshot_record",
        INCLUSION_PATH,
        Some(record_cid),
        inclusion_missing.encode(),
        (Some("missing_block"), None),
        Some("MissingProof"),
    );
    let mut exclusion_missing = exclusion.clone();
    exclusion_missing.remove(deepest(&exclusion, false));
    push(
        "exclusion_missing_mst_node",
        "corruption",
        Some(&name("getrecord_exclusion")),
        Some("missing_path_node"),
        "Exclusion proof for r08 with the deepest MST path node removed; must be missing_block, never absent.",
        "verify_snapshot_record",
        EXCLUSION_PATH,
        None,
        exclusion_missing.encode(),
        (Some("missing_block"), None),
        Some("MissingProof"),
    );
    cases
}

fn error_name(error: &VerificationError) -> String {
    format!("{error:?}")
}

/// Run the frozen Rust verifier for one manifest entry. Ok(entries) for a valid CAR.
async fn rust_verify(
    bytes: &[u8],
    verifier: &str,
    path: &str,
    target_cid: Option<Cid>,
    key: TrustedSigningKey,
) -> Result<Vec<VerifiedMutation>, VerificationError> {
    let resolver = FixtureResolver(key);
    match verifier {
        "verify_snapshot_record" => verify_snapshot_record(
            bytes,
            ALICE,
            path,
            target_cid,
            &namespace(),
            at(AS_OF),
            &resolver,
        )
        .await
        .map(|commit| commit.mutations().to_vec()),
        "verify_snapshot" => verify_snapshot(bytes, ALICE, &namespace(), at(AS_OF), &resolver)
            .await
            .map(|snapshot| snapshot.mutations().to_vec()),
        other => unreachable!("unknown verifier {other}"),
    }
}

fn mutation_json(mutation: &VerifiedMutation) -> Value {
    let key = |uri: &str| {
        uri.strip_prefix(&format!("at://{ALICE}/"))
            .unwrap()
            .to_string()
    };
    match mutation {
        VerifiedMutation::Put { uri, cid, record } => json!({
            "key": key(uri),
            "cid": cid.to_string(),
            "verdict": "put",
            "recordType": match record.as_ref() {
                VerifiedRecord::Scrobble(_) => "scrobble",
                VerifiedRecord::Follow(_) => "follow",
            },
            "error": Value::Null,
        }),
        VerifiedMutation::Exclude { uri, error } => json!({
            "key": key(uri),
            "cid": Value::Null,
            "verdict": "exclude",
            "recordType": Value::Null,
            "error": {"field": error.field, "code": error.code, "message": error.message},
        }),
        VerifiedMutation::Delete { uri } => json!({
            "key": key(uri),
            "cid": Value::Null,
            "verdict": "absent",
            "recordType": Value::Null,
            "error": Value::Null,
        }),
    }
}

async fn signed_cars() -> (Vec<(String, Vec<u8>)>, Value) {
    let mut files = Vec::new();
    let mut entries = Vec::new();
    let mut enumerations = Vec::new();
    let mut keys = serde_json::Map::new();
    for curve in ["secp256k1", "p256"] {
        let signer = Signer::new(curve);
        keys.insert(
            curve.into(),
            json!({"seedHex": hex(&[signer.seed(); 32]), "didKey": signer.did_key(), "testOnly": true}),
        );
        for case in curve_cases(curve).await {
            let result = rust_verify(
                &case.bytes,
                case.verifier,
                case.path,
                case.target_cid,
                signer.trusted(ALICE),
            )
            .await;
            let observed = result.as_ref().err().map(error_name);
            assert_eq!(
                observed.as_deref(),
                case.rust_error,
                "Rust verifier verdict for {}",
                case.name
            );
            if case.kind == "full_repo" {
                let mutations = result.as_ref().unwrap();
                let rendered: Vec<Value> = mutations
                    .iter()
                    .map(|mutation| {
                        let mut entry = mutation_json(mutation);
                        let key = entry["key"].as_str().unwrap().to_string();
                        let signed = case.mst_cids[&key].to_string();
                        if entry["cid"].is_null() {
                            // VerifiedMutation::Exclude carries no CID; report the signed MST leaf.
                            entry["cid"] = json!(signed);
                        }
                        assert_eq!(
                            entry["cid"],
                            json!(signed),
                            "enumerated CID is the MST leaf"
                        );
                        entry
                    })
                    .collect();
                assert_eq!(
                    rendered.len(),
                    9,
                    "7 scrobbles + 1 follow + 1 excluded scrobble"
                );
                enumerations.push(json!({
                    "car": format!("signed_cars/{}.car", case.name),
                    "curve": curve,
                    "did": ALICE,
                    "commitCid": untrusted_root(&case.bytes),
                    "rev": REVISION,
                    "entries": rendered,
                }));
            }
            if let Ok(mutations) = &result
                && case.kind != "full_repo"
            {
                let expected_state = if case.target_cid.is_some() {
                    "put"
                } else {
                    "absent"
                };
                assert_eq!(mutations.len(), 1);
                assert_eq!(mutation_json(&mutations[0])["verdict"], expected_state);
            }
            let commit = match case.corruption {
                Some("truncation") | Some("oversize") => Value::Null,
                _ => json!(untrusted_root(&case.bytes)),
            };
            entries.push(json!({
                "name": case.name,
                "file": format!("{}.car", case.name),
                "curve": curve,
                "signingKey": signer.did_key(),
                "did": ALICE,
                "rev": REVISION,
                "kind": case.kind,
                "base": case.base,
                "corruption": case.corruption,
                "description": case.description,
                "carRoot": commit,
                "target": {
                    "collection": case.path.split_once('/').unwrap().0,
                    "rkey": case.path.split_once('/').unwrap().1,
                    "cid": case.target_cid.map(|c| c.to_string()),
                },
                "expected": {
                    "verdict": if case.rust_error.is_none() { "valid" } else { "invalid" },
                    "code": case.expected_code,
                    "state": case.expected_state,
                },
                "rust": {
                    "verifier": case.verifier,
                    "verdict": if observed.is_none() { "valid" } else { "invalid" },
                    "error": observed,
                },
                "bytes": case.bytes.len(),
                "sha256": hex(&Sha256::digest(&case.bytes)),
            }));
            files.push((format!("signed_cars/{}.car", case.name), case.bytes));
        }
    }
    let manifest = json!({
        "description": "Rust-signed golden CARs. expected.code is the TypeScript VerifyErrorCode (ADR 0004 §4.4) for verifyRecordProof({did, collection, rkey, signingKey}) over the file; rust.error is the frozen Rust VerificationError observed by rust.verifier (verify_snapshot_record with the target path/CID, or verify_snapshot for full-repo CARs and their corruptions). Every entry was re-verified from disk by the exporter.",
        "source": SOURCE,
        "namespacePrefix": FIXTURE_PREFIX,
        "receiptTime": AS_OF,
        "did": ALICE,
        "maxCarBytesRust": MAX_CAR_BYTES,
        "keys": keys,
        "rustErrorToCode": {
            "InvalidSignature": "bad_signature",
            "CidMismatch": "cid_mismatch",
            "InvalidMst": "mst_invalid",
            "InvalidCar": "car_malformed",
            "CarTooLarge": "car_too_large",
            "MissingProof": "missing_block (record_cid_mismatch when the CAR carries a different record block in place of the proven CID)",
            "CommitMismatch": "did_mismatch | bad_version | bad_rev (Rust has one variant; the corruption field disambiguates)",
        },
        "notes": [
            "Rust enforces TID syntax for rev only in verify_snapshot (frames::validate_revision); verify_snapshot_record does not, so the rev corruption is applied to the full-repo CAR.",
            "All corruptions except the two missing_path_node cases are applied to the full-repo CAR and touch the commit, the MST root node or the r01 record, so they are on the r01 proof path for a record-proof verifier as well as for a snapshot walker.",
            "Both curves sign the same records, so MST nodes and record CIDs are identical across curves; only commit blocks differ."
        ],
        "entries": entries,
    });
    files.push(("signed_cars/manifest.json".into(), pretty(&manifest)));
    let enumeration = json!({
        "description": "Record set returned by the frozen Rust verify_snapshot for each valid full-repo CAR, in MST key order: only the configured music collections (<prefix>.scrobble, <prefix>.follow); non-music records, including look-alike collections just outside the namespace range, are skipped. verdict put = proven and schema-valid; exclude = proven but rejected by schema validation (still part of the enumerated set; Rust's Exclude mutation carries no CID, so cid is the signed MST leaf, asserted equal to it for every entry).",
        "source": SOURCE,
        "namespacePrefix": FIXTURE_PREFIX,
        "receiptTime": AS_OF,
        "snapshots": enumerations,
    });
    (files, enumeration)
}

fn untrusted_root(bytes: &[u8]) -> String {
    atmusic_atproto::sync::verify::untrusted_snapshot_metadata(bytes)
        .map(|m| m.commit.to_string())
        .unwrap_or_else(|_| {
            // Header root without block-level validation (used for corrupted CARs).
            let mut reader = std::io::Cursor::new(bytes);
            let length = unsigned_varint::io::read_usize(&mut reader).unwrap();
            let start = reader.position() as usize;
            let header: Ipld =
                serde_ipld_dagcbor::from_slice(&bytes[start..start + length]).unwrap();
            let Ipld::Map(header) = header else {
                unreachable!()
            };
            let Some(Ipld::List(roots)) = header.get("roots") else {
                unreachable!()
            };
            let Some(Ipld::Link(root)) = roots.first() else {
                unreachable!()
            };
            root.to_string()
        })
}

/// Re-read every written CAR and re-run the Rust verifier against its manifest entry.
async fn verify_written(out: &Path) -> (usize, usize) {
    let manifest: Value =
        serde_json::from_slice(&fs::read(out.join("signed_cars/manifest.json")).unwrap()).unwrap();
    let (mut valid, mut invalid) = (0, 0);
    for entry in manifest["entries"].as_array().unwrap() {
        let bytes = fs::read(
            out.join("signed_cars")
                .join(entry["file"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(
            hex(&Sha256::digest(&bytes)),
            entry["sha256"].as_str().unwrap()
        );
        let signer = Signer::new(entry["curve"].as_str().unwrap());
        assert_eq!(signer.did_key(), entry["signingKey"].as_str().unwrap());
        let path = format!(
            "{}/{}",
            entry["target"]["collection"].as_str().unwrap(),
            entry["target"]["rkey"].as_str().unwrap()
        );
        let cid = entry["target"]["cid"]
            .as_str()
            .map(|c| c.parse::<Cid>().unwrap());
        let result = rust_verify(
            &bytes,
            entry["rust"]["verifier"].as_str().unwrap(),
            &path,
            cid,
            signer.trusted(ALICE),
        )
        .await;
        match (&result, entry["expected"]["verdict"].as_str().unwrap()) {
            (Ok(_), "valid") => valid += 1,
            (Err(error), "invalid") => {
                assert_eq!(
                    error_name(error),
                    entry["rust"]["error"].as_str().unwrap(),
                    "{}",
                    entry["name"]
                );
                invalid += 1;
            }
            (outcome, expected) => panic!(
                "{}: expected {expected}, Rust verifier returned {:?}",
                entry["name"],
                outcome.as_ref().map(|_| ()).map_err(error_name)
            ),
        }
    }
    (valid, invalid)
}

// ---------------------------------------------------------------------------------------
// Storage-backed goldens: statistics, history/feed orders and window bounds
// ---------------------------------------------------------------------------------------

/// Verify a signed repository with the production gate, then project it into SQLite exactly as
/// the server fixtures do (crates/server/tests/common/read_projection.rs).
async fn project(database: &Database, did: &str, records: Vec<(String, Value)>, seed: u8) {
    let signed = signed_repo_for(did, records, seed, REVISION).await;
    let verified = verify_commit(
        &signed.event,
        did,
        &namespace(),
        at(AS_OF),
        &FixtureResolver(signed.key.clone()),
    )
    .await
    .expect("fixture repository verifies");
    let mutations = verified
        .mutations()
        .iter()
        .map(|mutation| match mutation {
            VerifiedMutation::Put { uri, cid, record } => match record.as_ref() {
                VerifiedRecord::Scrobble(record) => {
                    let artist_key = normalize(&record.artist);
                    RecordMutation::Scrobble(ScrobbleRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        did: did.into(),
                        revision: verified.revision().into(),
                        artist: record.artist.clone(),
                        track: record.track.clone(),
                        album: record.album.clone(),
                        listened_at: record.listened_at.clone(),
                        created_at: record.created_at.clone(),
                        duration_seconds: record.duration_seconds.map(i64::from),
                        recording_mbid: record.recording_mbid.clone(),
                        indexed_at: AS_OF.into(),
                        track_key: serde_json::to_string(&(&artist_key, normalize(&record.track)))
                            .unwrap(),
                        album_key: record.album.as_ref().map(|album| {
                            serde_json::to_string(&(&artist_key, normalize(album))).unwrap()
                        }),
                        artist_key,
                        confirmed: true,
                    })
                }
                VerifiedRecord::Follow(record) => RecordMutation::Follow(FollowRow {
                    uri: uri.clone(),
                    cid: cid.to_string(),
                    actor: did.into(),
                    subject: record.subject.clone(),
                    created_at: record.created_at.clone(),
                    revision: verified.revision().into(),
                    indexed_at: AS_OF.into(),
                    confirmed: true,
                }),
            },
            other => panic!("fixture produced a non-put mutation: {other:?}"),
        })
        .collect();
    assert!(
        database
            .repositories()
            .apply_event(RepositoryEvent {
                checkpoint: Checkpoint {
                    relay: format!("signed-fixture:{did}"),
                    sequence: 1,
                    revision: Some(verified.revision().into()),
                    indexed_at: AS_OF.into(),
                },
                mutations,
            })
            .await
            .unwrap()
    );
}

const WINDOWS: [(&str, StatisticsWindow); 4] = [
    ("all", StatisticsWindow::All),
    ("7d", StatisticsWindow::SevenDays),
    ("30d", StatisticsWindow::ThirtyDays),
    ("365d", StatisticsWindow::Year),
];

fn rkey(uri: &str) -> String {
    uri.rsplit('/').next().unwrap().to_string()
}

async fn stats_read_models(dir: &Path) -> Value {
    let database = Database::open(dir.join("fixture.sqlite")).await.unwrap();
    let fixture = fixture();
    let users = [(ALICE, 1_u8), (BOB, 2), (CAROL, 3)];
    for (did, seed) in users {
        database
            .repositories()
            .upsert_user(User::new(did, "2025-01-01T00:00:00Z"))
            .await
            .unwrap();
        let mut records: Vec<(String, Value)> = fixture["scrobbles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["owner"] == did && item["state"] == "confirmed")
            .map(|item| {
                (
                    format!(
                        "{FIXTURE_PREFIX}.scrobble/{}",
                        item["rkey"].as_str().unwrap()
                    ),
                    item["record"].clone(),
                )
            })
            .collect();
        for follow in fixture["follows"].as_array().unwrap() {
            if follow["actor"] == did && follow["state"] == "confirmed" {
                let subject = follow["subject"].as_str().unwrap();
                records.push((
                    format!("{FIXTURE_PREFIX}.follow/{}", follow_rkey(subject).unwrap()),
                    json!({"$type": format!("{FIXTURE_PREFIX}.follow"), "subject": subject, "createdAt": "2025-01-01T00:00:00Z"}),
                ));
            }
        }
        project(&database, did, records, seed).await;
    }
    let repository = database.repositories();
    let mut statistics = serde_json::Map::new();
    for (name, did) in [("Alice", ALICE), ("Bob", BOB), ("Carol", CAROL)] {
        let mut by_window = serde_json::Map::new();
        for (window_name, window) in WINDOWS {
            let stats = repository
                .statistics(did, window, at(AS_OF), 10)
                .await
                .unwrap();
            by_window.insert(window_name.into(), serde_json::to_value(stats).unwrap());
        }
        statistics.insert(name.into(), Value::Object(by_window));
    }
    let bounds = || PageBounds {
        upper: None,
        last: None,
        limit: 101,
    };
    let history = repository.history(ALICE, bounds()).await.unwrap();
    let global = repository.feed(None, bounds()).await.unwrap();
    let following = repository.feed(Some(ALICE), bounds()).await.unwrap();
    let order = |rows: &[ScrobbleRow]| rows.iter().map(|r| rkey(&r.uri)).collect::<Vec<_>>();

    // The cross-check must agree with the TESTING.md hardcoded expectations before export.
    let expected = &fixture["expected"];
    assert_eq!(json!(order(&history)), expected["aliceHistory"]);
    assert_eq!(json!(order(&global)), expected["globalFeed"]);
    assert_eq!(json!(order(&following)), expected["aliceFollowingFeed"]);
    for (window_name, _) in WINDOWS {
        let stats = &statistics["Alice"][window_name];
        for field in ["totalScrobbles", "distinctArtists", "distinctTracks"] {
            assert_eq!(
                stats[field], expected["aliceStats"][window_name][field],
                "{window_name} {field}"
            );
        }
    }
    database.close().await;
    json!({
        "description": "CROSS-CHECK ONLY. The shared fixture tests/fixtures/read_models.json projected through the frozen Rust path (signed repo -> verify_commit -> atmusic-storage apply_event) and read back with Repository::statistics (limit 10, asOf 2026-01-15T12:00:00Z), history and feed (unpaginated). Acceptance tests must keep hardcoding the TESTING.md values; CIDs/revisions depend on the Rust fixture signing and are not a contract.",
        "source": SOURCE,
        "asOf": AS_OF,
        "statisticsLimit": 10,
        "statistics": statistics,
        "orders": {
            "aliceHistory": order(&history),
            "globalFeed": order(&global),
            "aliceFollowingFeed": order(&following),
        },
        "rows": {
            "aliceHistory": history,
            "globalFeed": global,
            "aliceFollowingFeed": following,
        },
    })
}

async fn windows(dir: &Path) -> Value {
    let database = Database::open(dir.join("windows.sqlite")).await.unwrap();
    let as_of = at(AS_OF);
    let nanos = |t: DateTime<Utc>| t.to_rfc3339_opts(SecondsFormat::Nanos, true);
    let mut rendered = Vec::new();
    let mut probe_index = 0_u32;
    for (name, window) in WINDOWS {
        let days = window.days();
        // Same arithmetic as Repository::statistics; the probes below check it against the query.
        let lower = days.map(|d| as_of.checked_sub_signed(Duration::days(d)).unwrap());
        let probe_times: Vec<DateTime<Utc>> = match lower {
            Some(lower) => vec![
                lower - Duration::seconds(1),
                lower - Duration::nanoseconds(1),
                lower,
                lower + Duration::nanoseconds(1),
                lower + Duration::seconds(1),
                as_of,
                as_of + Duration::nanoseconds(1),
                as_of + Duration::seconds(1),
            ],
            None => vec![
                at("1970-01-01T00:00:00Z"),
                as_of,
                as_of + Duration::nanoseconds(1),
                as_of + Duration::seconds(1),
            ],
        };
        let mut probes = Vec::new();
        for time in probe_times {
            probe_index += 1;
            let did = format!("did:plc:windowprobe{probe_index:04}");
            database
                .repositories()
                .upsert_user(User::new(&did, "2025-01-01T00:00:00Z"))
                .await
                .unwrap();
            let stamp = nanos(time);
            project(
                &database,
                &did,
                vec![(
                    format!("{FIXTURE_PREFIX}.scrobble/probe"),
                    json!({"$type": format!("{FIXTURE_PREFIX}.scrobble"), "artist": "Probe", "track": "Probe", "listenedAt": stamp, "createdAt": "1970-01-01T00:00:00Z"}),
                )],
                9,
            )
            .await;
            let stats = database
                .repositories()
                .statistics(&did, window, as_of, 10)
                .await
                .unwrap();
            assert!(stats.total_scrobbles <= 1);
            probes.push(json!({"listenedAt": stamp, "included": stats.total_scrobbles == 1}));
        }
        let included =
            |t: &str| probes.iter().find(|p| p["listenedAt"] == t).unwrap()["included"] == true;
        if let Some(lower) = lower {
            assert!(included(&nanos(lower)), "{name} lower bound inclusive");
            assert!(
                !included(&nanos(lower - Duration::nanoseconds(1))),
                "{name} below lower excluded"
            );
        }
        assert!(included(&nanos(as_of)), "{name} upper bound inclusive");
        assert!(
            !included(&nanos(as_of + Duration::nanoseconds(1))),
            "{name} future excluded"
        );
        rendered.push(json!({
            "window": name,
            "days": days,
            "lowerBound": lower.map(nanos),
            "lowerBoundRfc3339": lower.map(|l| l.to_rfc3339_opts(SecondsFormat::AutoSi, true)),
            "upperBound": nanos(as_of),
            "inclusive": true,
            "probes": probes,
        }));
    }
    database.close().await;
    json!({
        "description": "Statistics window bounds for asOf 2026-01-15T12:00:00Z: listenedAt in [asOf - days*86400 s, asOf], both inclusive, nanosecond precision; 'all' has no lower bound but still excludes listens after asOf. Each probe is a single signed scrobble projected through verify_commit + atmusic-storage, and `included` is whether the frozen Repository::statistics query counted it.",
        "source": SOURCE,
        "asOf": AS_OF,
        "windows": rendered,
    })
}

async fn render_all() -> Vec<(String, Vec<u8>)> {
    let (mut files, enumeration) = signed_cars().await;
    files.push(("snapshot_enumeration.json".into(), pretty(&enumeration)));
    let dir = tempfile::tempdir().unwrap();
    files.push((
        "stats_read_models.json".into(),
        pretty(&stats_read_models(dir.path()).await),
    ));
    files.push(("windows.json".into(), pretty(&windows(dir.path()).await)));
    files
}
