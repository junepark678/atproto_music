#![allow(dead_code)]
use atmusic_storage::{Database, NewOperation, ScrobbleRow, User};
use std::path::PathBuf;
pub const NOW: &str = "2026-01-15T12:00:00Z";
pub const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
pub const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
pub struct Temp {
    pub dir: PathBuf,
    pub path: PathBuf,
}
impl Temp {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("atmusic-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("music.sqlite");
        Self { dir, path }
    }
    pub async fn database(&self) -> Database {
        Database::open(&self.path).await.unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
pub async fn users(db: &Database) {
    let repo = db.repositories();
    repo.upsert_user(User::new(ALICE, NOW)).await.unwrap();
    repo.upsert_user(User::new(BOB, NOW)).await.unwrap();
}
pub fn row(rkey: &str, revision: &str) -> ScrobbleRow {
    ScrobbleRow {
        uri: format!("at://{ALICE}/com.example.atmusic.scrobble/{rkey}"),
        cid: "storage-boundary-evidence".into(),
        did: ALICE.into(),
        revision: revision.into(),
        artist: "Björk".into(),
        track: "Jóga".into(),
        album: Some("Homogenic".into()),
        listened_at: NOW.into(),
        created_at: NOW.into(),
        duration_seconds: None,
        recording_mbid: None,
        indexed_at: NOW.into(),
        artist_key: "björk".into(),
        track_key: "jóga".into(),
        album_key: Some("homogenic".into()),
        confirmed: true,
    }
}
pub fn operation(id: &str, owner: &str) -> NewOperation {
    NewOperation {
        operation_id: id.into(),
        owner: owner.into(),
        kind: "scrobble_create".into(),
        created_at: NOW.into(),
        record_uri: Some(format!("at://{owner}/com.example.atmusic.scrobble/{id}")),
        collection: "com.example.atmusic.scrobble".into(),
        rkey: id.into(),
        payload_json: Some("{\"artist\":\"Björk\",\"track\":\"Jóga\"}".into()),
        canonical_digest: Some("boundary-test-digest".into()),
    }
}
