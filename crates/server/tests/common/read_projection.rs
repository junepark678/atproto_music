//! Signed repository fixtures verified by the production gate before SQLite projection.
#![allow(dead_code)]
use atmusic_atproto::sync::verify::{VerifiedMutation, VerifiedRecord, verify_commit};
use atmusic_core::{music_key::normalize, namespace::Namespace, scrobble::ScrobbleRecord};
use atmusic_server::Clock;
use atmusic_storage::repositories::{
    Checkpoint, FollowRow, RecordMutation, RepositoryEvent, ScrobbleRow, User,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};
#[path = "../../../atproto/tests/support/signed_repo.rs"]
pub mod signed_repo;
use signed_repo::{FixtureResolver, SignedFixture, signed_mutation, signed_repo_for};

pub const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
pub const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
pub const CAROL: &str = "did:plc:cccccccccccccccccccccccc";
pub const AS_OF: &str = "2026-01-15T12:00:00Z";
pub const CANONICAL_AS_OF: &str = "2026-01-15T12:00:00.000000000Z";
const INITIAL_REVISION: &str = "3m3ijqc2abc22";
const REVISIONS: [&str; 8] = [
    "3m3ijqc2abc22",
    "3m3ijqc2abc23",
    "3m3ijqc2abc24",
    "3m3ijqc2abc25",
    "3m3ijqc2abc26",
    "3m3ijqc2abc27",
    "3m3ijqc2abc2a",
    "3m3ijqc2abc2b",
];
pub struct FixedClock(pub AtomicI64);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::SeqCst), 0).unwrap()
    }
}
pub async fn server() -> (crate::common::TestServer, Arc<FixedClock>) {
    let clock = Arc::new(FixedClock(AtomicI64::new(receipt_time().timestamp())));
    (
        crate::common::TestServer::start_with_clock(clock.clone()).await,
        clock,
    )
}
fn receipt_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(AS_OF)
        .unwrap()
        .with_timezone(&Utc)
}
pub fn uri(owner: &str, rkey: &str) -> String {
    format!("at://{owner}/com.example.atmusic.scrobble/{rkey}")
}
pub fn follow_uri(actor: &str, subject: &str) -> String {
    let key = atmusic_core::follow::follow_rkey(subject).unwrap();
    format!("at://{actor}/com.example.atmusic.follow/{key}")
}
fn signing_seed(did: &str) -> u8 {
    match did {
        ALICE => 1,
        BOB => 2,
        CAROL => 3,
        _ => 4,
    }
}
pub struct ReadFixtures {
    repositories: HashMap<String, SignedFixture>,
    pub excluded: Vec<String>,
}
impl ReadFixtures {
    pub async fn put_follow(
        &mut self,
        server: &crate::common::TestServer,
        did: &str,
        rkey: &str,
        subject: &str,
    ) {
        self.mutate(server, did, &format!("com.example.atmusic.follow/{rkey}"), Some(json!({
            "$type":"com.example.atmusic.follow", "subject":subject, "createdAt":"2025-01-01T00:00:00Z",
        }))).await;
    }
    pub async fn put(
        &mut self,
        server: &crate::common::TestServer,
        did: &str,
        rkey: &str,
        mut record: Value,
    ) {
        record["$type"] = json!("com.example.atmusic.scrobble");
        self.mutate(
            server,
            did,
            &format!("com.example.atmusic.scrobble/{rkey}"),
            Some(record),
        )
        .await;
    }
    pub async fn update(&mut self, server: &crate::common::TestServer, row: ScrobbleRow) {
        let record = serde_json::to_value(ScrobbleRecord {
            record_type: "com.example.atmusic.scrobble".into(),
            artist: row.artist,
            track: row.track,
            album: row.album,
            listened_at: row.listened_at,
            created_at: row.created_at,
            duration_seconds: row
                .duration_seconds
                .map(|value| u32::try_from(value).unwrap()),
            recording_mbid: row.recording_mbid,
        })
        .unwrap();
        let path = row.uri.strip_prefix(&format!("at://{}/", row.did)).unwrap();
        self.mutate(server, &row.did, path, Some(record)).await;
    }
    pub async fn delete(&mut self, server: &crate::common::TestServer, did: &str, uri: &str) {
        self.delete_database(&server.database, did, uri).await;
    }
    pub async fn delete_database(
        &mut self,
        database: &atmusic_storage::Database,
        did: &str,
        uri: &str,
    ) {
        let path = uri.strip_prefix(&format!("at://{did}/")).unwrap();
        self.mutate_database(database, did, path, None).await;
    }
    async fn mutate(
        &mut self,
        server: &crate::common::TestServer,
        did: &str,
        path: &str,
        record: Option<Value>,
    ) {
        self.mutate_database(&server.database, did, path, record)
            .await;
    }
    async fn mutate_database(
        &mut self,
        database: &atmusic_storage::Database,
        did: &str,
        path: &str,
        record: Option<Value>,
    ) {
        let generated = if let Some(previous) = self.repositories.get(did) {
            signed_mutation(
                previous,
                path,
                record,
                signing_seed(did),
                REVISIONS[previous.event.sequence as usize],
            )
            .await
        } else {
            signed_repo_for(
                did,
                vec![(path.into(), record.unwrap())],
                signing_seed(did),
                INITIAL_REVISION,
            )
            .await
        };
        self.excluded = verify_and_apply(database, &generated).await;
        self.repositories.insert(did.into(), generated);
    }
}
async fn verify_and_apply(
    database: &atmusic_storage::Database,
    fixture: &SignedFixture,
) -> Vec<String> {
    let verified = verify_commit(
        &fixture.event,
        &fixture.event.did,
        &Namespace::new("com.example.atmusic").unwrap(),
        receipt_time(),
        &FixtureResolver(fixture.key.clone()),
    )
    .await
    .unwrap();
    let mut mutations = Vec::new();
    let mut excluded = Vec::new();
    for mutation in verified.mutations() {
        match mutation {
            VerifiedMutation::Put { uri, cid, record } => match record.as_ref() {
                VerifiedRecord::Scrobble(record) => {
                    let artist_key = normalize(&record.artist);
                    mutations.push(RecordMutation::Scrobble(ScrobbleRow {
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
                        indexed_at: AS_OF.into(),
                        artist_key: artist_key.clone(),
                        track_key: serde_json::to_string(&(
                            artist_key.clone(),
                            normalize(&record.track),
                        ))
                        .unwrap(),
                        album_key: record.album.as_ref().map(|album| {
                            serde_json::to_string(&(artist_key.clone(), normalize(album))).unwrap()
                        }),
                        confirmed: true,
                    }));
                }
                VerifiedRecord::Follow(record) => {
                    mutations.push(RecordMutation::Follow(FollowRow {
                        uri: uri.clone(),
                        cid: cid.to_string(),
                        actor: verified.did().into(),
                        subject: record.subject.clone(),
                        created_at: record.created_at.clone(),
                        revision: verified.revision().into(),
                        indexed_at: AS_OF.into(),
                        confirmed: true,
                    }))
                }
            },
            VerifiedMutation::Delete { uri } => mutations.push(RecordMutation::Delete {
                uri: uri.clone(),
                owner: verified.did().into(),
                revision: verified.revision().into(),
                indexed_at: AS_OF.into(),
            }),
            VerifiedMutation::Exclude { uri, .. } => {
                excluded.push(uri.clone());
                mutations.push(RecordMutation::Delete {
                    uri: uri.clone(),
                    owner: verified.did().into(),
                    revision: verified.revision().into(),
                    indexed_at: AS_OF.into(),
                });
            }
        }
    }
    assert!(
        database
            .repositories()
            .apply_event(RepositoryEvent {
                checkpoint: Checkpoint {
                    relay: format!("signed-fixture:{}", verified.did()),
                    sequence: verified.sequence().try_into().unwrap(),
                    revision: Some(verified.revision().into()),
                    indexed_at: AS_OF.into()
                },
                mutations,
            })
            .await
            .unwrap()
    );
    excluded
}
pub async fn seed(server: &crate::common::TestServer, all: bool) -> ReadFixtures {
    seed_database(&server.database, all).await
}
pub async fn seed_database(database: &atmusic_storage::Database, all: bool) -> ReadFixtures {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/fixtures/read_models.json")).unwrap();
    let mut generated = ReadFixtures {
        repositories: HashMap::new(),
        excluded: Vec::new(),
    };
    for did in [ALICE, BOB, CAROL] {
        database
            .repositories()
            .upsert_user(User::new(did, "2025-01-01T00:00:00Z"))
            .await
            .unwrap();
        let mut records: Vec<_> = fixture["scrobbles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                (all || did == ALICE) && item["owner"] == did && item["state"] == "confirmed"
            })
            .map(|item| {
                (
                    format!(
                        "com.example.atmusic.scrobble/{}",
                        item["rkey"].as_str().unwrap()
                    ),
                    item["record"].clone(),
                )
            })
            .collect();
        if all && did == ALICE {
            let key = atmusic_core::follow::follow_rkey(BOB).unwrap();
            records.push((format!("com.example.atmusic.follow/{key}"),json!({"$type":"com.example.atmusic.follow","subject":BOB,"createdAt":"2025-01-01T00:00:00Z"})));
        }
        if !records.is_empty() {
            let signed = signed_repo_for(did, records, signing_seed(did), INITIAL_REVISION).await;
            let excluded = verify_and_apply(database, &signed).await;
            assert!(excluded.is_empty());
            generated.repositories.insert(did.into(), signed);
        }
    }
    generated
}
pub fn assert_page(page: &Value) {
    assert_eq!(page.as_object().unwrap().len(), 4);
    assert!(page["items"].is_array());
    assert!(page["nextCursor"].is_null() || page["nextCursor"].is_string());
    DateTime::parse_from_rfc3339(page["asOf"].as_str().unwrap()).unwrap();
    assert_eq!(page["indexing"]["state"], "recovering");
    assert_eq!(page["indexing"]["caughtUp"], false);
    assert!(page["indexing"]["lastIndexedAt"].is_null());
    assert!(page["indexing"]["lagSeconds"].is_null());
    for item in page["items"].as_array().unwrap() {
        let cid: ipld_core::cid::Cid = item["cid"].as_str().unwrap().parse().unwrap();
        assert_eq!(cid.codec(), 0x71);
        for field in [
            "uri",
            "cid",
            "did",
            "revision",
            "artist",
            "track",
            "listenedAt",
            "createdAt",
            "indexedAt",
        ] {
            assert!(item[field].is_string(), "required field {field}: {item}");
        }
        for hidden in ["confirmed", "artistKey", "trackKey", "albumKey"] {
            assert!(
                item.get(hidden).is_none(),
                "private projection field {hidden}"
            );
        }
    }
}
pub fn items(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["uri"].as_str().unwrap().into())
        .collect()
}
pub fn assert_error(body: &Value, code: &str) {
    assert_eq!(body.as_object().unwrap().len(), 1);
    assert_eq!(body["error"]["code"], code);
    assert!(body["error"]["message"].is_string());
    uuid::Uuid::parse_str(body["error"]["requestId"].as_str().unwrap()).unwrap();
}
