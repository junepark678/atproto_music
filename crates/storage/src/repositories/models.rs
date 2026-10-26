use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub did: String,
    pub handle: Option<String>,
    pub joined_at: String,
    pub indexed_at: Option<String>,
    pub active: bool,
    pub revision: Option<String>,
    pub indexing_state: String,
}
impl User {
    pub fn new(did: impl Into<String>, joined_at: impl Into<String>) -> Self {
        Self {
            did: did.into(),
            handle: None,
            joined_at: joined_at.into(),
            indexed_at: None,
            active: true,
            revision: None,
            indexing_state: "recovering".into(),
        }
    }
}
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleRow {
    pub uri: String,
    pub cid: String,
    pub did: String,
    pub revision: String,
    pub artist: String,
    pub track: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    pub listened_at: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_mbid: Option<String>,
    pub indexed_at: String,
    #[serde(skip)]
    pub artist_key: String,
    #[serde(skip)]
    pub track_key: String,
    #[serde(skip)]
    pub album_key: Option<String>,
    #[serde(skip)]
    pub confirmed: bool,
}
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowRow {
    pub uri: String,
    pub cid: String,
    pub actor: String,
    pub subject: String,
    pub created_at: String,
    #[serde(skip)]
    pub revision: String,
    #[serde(skip)]
    pub indexed_at: String,
    #[serde(skip)]
    pub confirmed: bool,
}
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    #[serde(skip)]
    pub owner: String,
    pub kind: String,
    pub state: String,
    pub attempts: i64,
    pub created_at: String,
    pub updated_at: String,
    pub record_uri: Option<String>,
    pub failure_code: Option<String>,
}
#[derive(Debug, Clone)]
pub struct NewOperation {
    pub operation_id: String,
    pub owner: String,
    pub kind: String,
    pub created_at: String,
    pub record_uri: Option<String>,
    pub collection: String,
    pub rkey: String,
    pub payload_json: Option<String>,
    pub canonical_digest: Option<String>,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OutboxItem {
    pub operation_id: String,
    pub owner: String,
    pub kind: String,
    pub attempts: i64,
    pub collection: String,
    pub rkey: String,
    pub payload_json: Option<String>,
    pub canonical_digest: Option<String>,
    pub due_at: String,
    pub locked_at: Option<String>,
    pub record_uri: Option<String>,
}
#[derive(Debug, Clone)]
pub enum Admission {
    Created(Operation),
    Replayed(Operation),
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Session {
    pub session_hash: String,
    pub owner: String,
    pub csrf_hash: String,
    pub encrypted_material: Vec<u8>,
    pub created_at: i64,
    pub expires_at: i64,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OAuthState {
    pub state_hash: String,
    pub encrypted_material: Vec<u8>,
    pub issuer: String,
    pub did: String,
    pub created_at: i64,
    pub expires_at: i64,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OAuthTokens {
    pub owner: String,
    pub encrypted_material: Vec<u8>,
    pub generation: i64,
    pub expires_at: i64,
}
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Indexing {
    pub state: String,
    pub caught_up: bool,
    pub last_indexed_at: Option<String>,
    pub lag_seconds: Option<i64>,
}
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Checkpoint {
    pub relay: String,
    pub sequence: i64,
    pub revision: Option<String>,
    pub indexed_at: String,
}
#[derive(Debug, Clone)]
pub enum RecordMutation {
    Scrobble(ScrobbleRow),
    Follow(FollowRow),
    Delete {
        uri: String,
        owner: String,
        revision: String,
        indexed_at: String,
    },
    DeleteMany {
        uris: Vec<String>,
        owner: String,
        revision: String,
        indexed_at: String,
    },
}
#[derive(Debug, Clone)]
pub struct RepositoryEvent {
    pub checkpoint: Checkpoint,
    pub mutations: Vec<RecordMutation>,
}
#[derive(Debug, Clone)]
pub struct PageBounds {
    pub upper: Option<(String, String)>,
    pub last: Option<(String, String)>,
    pub limit: u32,
}
impl Default for PageBounds {
    fn default() -> Self {
        Self {
            upper: None,
            last: None,
            limit: 20,
        }
    }
}
