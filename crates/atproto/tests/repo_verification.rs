#[path = "support/signed_repo.rs"]
mod signed_repo;

use async_trait::async_trait;
use atmusic_atproto::sync::verify::{
    SigningKeyResolver, TrustedSigningKey, VerificationError, VerifiedMutation,
    content_addressed_car_blocks, untrusted_snapshot_metadata, verify_commit,
    verify_snapshot_record,
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use atrium_repo::blockstore::{AsyncBlockStoreWrite, CarStore};
use chrono::{DateTime, Utc};
use ipld_core::{cid::Cid, ipld::Ipld};
use serde_json::{Value, json};
use signed_repo::{ALICE, FixtureResolver, signed_repo, signed_repo_with_bad_signature};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
fn records() -> Vec<(String, Value)> {
    vec![
        (
            "com.example.atmusic.scrobble/r01".into(),
            json!({"$type":"com.example.atmusic.scrobble","artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T12:00:00Z"}),
        ),
        (
            "com.example.atmusic.follow/f01".into(),
            json!({"$type":"com.example.atmusic.follow","subject":"did:plc:bbbbbbbbbbbbbbbbbbbbbbbb","createdAt":"2026-01-15T12:00:00Z"}),
        ),
    ]
}

#[tokio::test]
async fn valid_signed_repo() {
    let fixture = signed_repo(records(), 7).await;
    let verified = verify_commit(
        &fixture.event,
        ALICE,
        &namespace(),
        now(),
        &FixtureResolver(fixture.key.clone()),
    )
    .await
    .unwrap();
    assert_eq!(verified.did(), ALICE);
    assert_eq!(verified.revision(), signed_repo::REVISION);
    assert_eq!(verified.commit(), fixture.event.commit);
    assert_eq!(verified.mutations().len(), 2);
    let expected: Vec<_> = fixture
        .event
        .operations
        .iter()
        .map(|op| format!("at://{ALICE}/{}", op.path))
        .collect();
    let actual: Vec<_> = verified
        .mutations()
        .iter()
        .map(|mutation| match mutation {
            VerifiedMutation::Put { uri, .. } => uri.clone(),
            _ => panic!("expected proven put"),
        })
        .collect();
    assert_eq!(actual, expected);
    for (mutation, cid) in verified.mutations().iter().zip(&fixture.record_cids) {
        assert!(matches!(mutation,VerifiedMutation::Put{cid:actual,..} if actual == cid));
    }
    let metadata = untrusted_snapshot_metadata(&fixture.event.blocks).unwrap();
    assert_eq!(metadata.did, ALICE);
    assert_eq!(metadata.commit, fixture.event.commit);
    let snapshot = verify_snapshot_record(
        &fixture.event.blocks,
        ALICE,
        &fixture.event.operations[0].path,
        Some(fixture.record_cids[0]),
        &namespace(),
        now(),
        &FixtureResolver(fixture.key),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.mutations().len(), 1);
}

#[tokio::test]
async fn tampering_matrix() {
    let fixture = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(fixture.key.clone());
    let corrupt_signature = signed_repo_with_bad_signature(records(), 7, true).await;
    assert_eq!(
        verify_commit(
            &corrupt_signature.event,
            ALICE,
            &namespace(),
            now(),
            &resolver
        )
        .await
        .unwrap_err(),
        VerificationError::InvalidSignature
    );
    let blocks = content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let record_bytes = &blocks[&fixture.record_cids[0].to_string()];
    let offset = fixture
        .event
        .blocks
        .windows(record_bytes.len())
        .position(|window| window == record_bytes)
        .unwrap();
    let mut bad_block = fixture.event.clone();
    bad_block.blocks[offset + record_bytes.len() - 1] ^= 1;
    assert_eq!(
        verify_commit(&bad_block, ALICE, &namespace(), now(), &resolver)
            .await
            .unwrap_err(),
        VerificationError::CidMismatch
    );
    assert_eq!(
        verify_commit(
            &fixture.event,
            "did:plc:cccccccccccccccccccccccc",
            &namespace(),
            now(),
            &resolver
        )
        .await
        .unwrap_err(),
        VerificationError::CommitMismatch
    );
    let mut bad_path = fixture.event.clone();
    bad_path.operations[0].path = "com.example.atmusic.scrobble/absent".into();
    assert_eq!(
        verify_commit(&bad_path, ALICE, &namespace(), now(), &resolver)
            .await
            .unwrap_err(),
        VerificationError::MembershipMismatch
    );
    assert!(
        verify_commit(&fixture.event, ALICE, &namespace(), now(), &resolver)
            .await
            .is_ok(),
        "valid event remains processable after rejection"
    );
}

struct RotatingResolver {
    key: Mutex<TrustedSigningKey>,
    calls: AtomicUsize,
}
#[async_trait]
impl SigningKeyResolver for RotatingResolver {
    async fn resolve_for_revision(
        &self,
        _: &str,
        _: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.key.lock().unwrap().clone())
    }
}
#[tokio::test]
async fn key_rotation() {
    let old = signed_repo(records(), 7).await;
    let new = signed_repo(records(), 8).await;
    let resolver = RotatingResolver {
        key: Mutex::new(old.key.clone()),
        calls: AtomicUsize::new(0),
    };
    assert!(
        verify_commit(&old.event, ALICE, &namespace(), now(), &resolver)
            .await
            .is_ok()
    );
    *resolver.key.lock().unwrap() = TrustedSigningKey {
        valid_from: signed_repo::REVISION.into(),
        ..new.key.clone()
    };
    assert!(
        verify_commit(&new.event, ALICE, &namespace(), now(), &resolver)
            .await
            .is_ok()
    );
    assert_eq!(
        verify_commit(&old.event, ALICE, &namespace(), now(), &resolver)
            .await
            .unwrap_err(),
        VerificationError::InvalidSignature
    );
    *resolver.key.lock().unwrap() = TrustedSigningKey {
        valid_until: Some(signed_repo::REVISION.into()),
        ..old.key
    };
    assert_eq!(
        verify_commit(&old.event, ALICE, &namespace(), now(), &resolver)
            .await
            .unwrap_err(),
        VerificationError::UntrustedIdentity
    );
    assert_eq!(
        resolver.calls.load(Ordering::SeqCst),
        4,
        "key is re-resolved for every event revision"
    );
}

#[tokio::test]
async fn valid_signature_does_not_admit_invalid_application_schema() {
    let mut input = records();
    input[0].1["artist"] = json!("");
    let fixture = signed_repo(input, 7).await;
    let verified = verify_commit(
        &fixture.event,
        ALICE,
        &namespace(),
        now(),
        &FixtureResolver(fixture.key),
    )
    .await
    .unwrap();
    assert!(
        matches!(&verified.mutations()[0],VerifiedMutation::Exclude{error,..} if error.field=="artist")
    );
    assert!(matches!(
        &verified.mutations()[1],
        VerifiedMutation::Put { .. }
    ));
}

#[tokio::test]
async fn malformed_car_length_is_bounded_before_library_allocation() {
    let fixture = signed_repo(records(), 7).await;
    let mut event = fixture.event.clone();
    event.blocks = vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f];
    assert_eq!(
        verify_commit(
            &event,
            ALICE,
            &namespace(),
            now(),
            &FixtureResolver(fixture.key)
        )
        .await
        .unwrap_err(),
        VerificationError::InvalidCar
    );
}

#[tokio::test]
async fn signed_successor_updates_and_delete_absence() {
    let first = signed_repo(records(), 7).await;
    let path = first.event.operations[0].path.clone();
    let mut record = records().remove(0).1;
    record["track"] = json!("Army of Me");
    let updated =
        signed_repo::signed_mutation(&first, &path, Some(record), 7, "3m4zm2ufr2223").await;
    let verified = verify_commit(
        &updated.event,
        ALICE,
        &namespace(),
        now(),
        &FixtureResolver(updated.key.clone()),
    )
    .await
    .unwrap();
    assert_eq!(verified.mutations().len(), 1);
    assert_eq!(updated.event.since.as_deref(), Some(signed_repo::REVISION));
    assert_ne!(updated.record_cids[0], first.record_cids[0]);
    let deleted = signed_repo::signed_mutation(&updated, &path, None, 7, "3m4zm2ufr2224").await;
    let proof = verify_snapshot_record(
        &deleted.event.blocks,
        ALICE,
        &path,
        None,
        &namespace(),
        now(),
        &FixtureResolver(deleted.key),
    )
    .await
    .unwrap();
    assert!(
        matches!(&proof.mutations()[0], VerifiedMutation::Delete {uri} if uri == &format!("at://{ALICE}/{path}"))
    );
}

async fn repack_without(fixture: &signed_repo::SignedFixture, omitted: Cid) -> Vec<u8> {
    let blocks = content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let mut bytes = Vec::new();
    let mut car =
        CarStore::create_with_roots(std::io::Cursor::new(&mut bytes), [fixture.event.commit])
            .await
            .unwrap();
    for (cid, block) in blocks {
        let cid: Cid = cid.parse().unwrap();
        if cid != omitted {
            assert_eq!(
                car.write_block(cid.codec(), 0x12, &block).await.unwrap(),
                cid
            );
        }
    }
    drop(car);
    bytes
}

#[tokio::test]
async fn missing_required_proof_fails_but_unrelated_slice_is_optional() {
    let fixture = signed_repo(records(), 7).await;
    let resolver = FixtureResolver(fixture.key.clone());
    let without_unrelated = repack_without(&fixture, fixture.record_cids[1]).await;
    let verified = verify_snapshot_record(
        &without_unrelated,
        ALICE,
        &fixture.event.operations[0].path,
        Some(fixture.record_cids[0]),
        &namespace(),
        now(),
        &resolver,
    )
    .await
    .unwrap();
    assert_eq!(verified.mutations().len(), 1);
    let blocks = content_addressed_car_blocks(&fixture.event.blocks, fixture.event.commit).unwrap();
    let Ipld::Map(commit) =
        serde_ipld_dagcbor::from_slice::<Ipld>(&blocks[&fixture.event.commit.to_string()]).unwrap()
    else {
        unreachable!()
    };
    let Ipld::Link(data) = commit["data"] else {
        unreachable!()
    };
    let without_required = repack_without(&fixture, data).await;
    assert_eq!(
        verify_snapshot_record(
            &without_required,
            ALICE,
            &fixture.event.operations[0].path,
            Some(fixture.record_cids[0]),
            &namespace(),
            now(),
            &resolver
        )
        .await
        .unwrap_err(),
        VerificationError::MissingProof
    );
}
