-- Public rows are confirmed repository state; queue acknowledgement never inserts them.
CREATE TABLE users (
 did TEXT PRIMARY KEY NOT NULL,
 handle TEXT,
 joined_at TEXT NOT NULL,
 indexed_at TEXT,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 revision TEXT,
 indexing_state TEXT NOT NULL DEFAULT 'recovering' CHECK(indexing_state IN ('current','recovering','stale','suppressed'))
);
CREATE UNIQUE INDEX users_verified_handle ON users(handle) WHERE handle IS NOT NULL;
CREATE TABLE scrobbles (
 uri TEXT PRIMARY KEY NOT NULL,
 cid TEXT NOT NULL,
 did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 revision TEXT NOT NULL,
 artist TEXT NOT NULL,
 track TEXT NOT NULL,
 album TEXT,
 listened_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400),
 recording_mbid TEXT,
 indexed_at TEXT NOT NULL,
 artist_key TEXT NOT NULL,
 track_key TEXT NOT NULL,
 album_key TEXT,
 confirmed INTEGER NOT NULL DEFAULT 1 CHECK(confirmed IN (0,1))
);
CREATE INDEX scrobbles_owner_time ON scrobbles(did,listened_at DESC,uri DESC);
CREATE INDEX scrobbles_global_time ON scrobbles(listened_at DESC,uri DESC);
CREATE INDEX scrobbles_stats ON scrobbles(did,artist_key,track_key,listened_at);
CREATE TABLE follows (
 uri TEXT PRIMARY KEY NOT NULL,
 cid TEXT NOT NULL,
 actor TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 subject TEXT NOT NULL,
 revision TEXT NOT NULL,
 created_at TEXT NOT NULL,
 indexed_at TEXT NOT NULL,
 confirmed INTEGER NOT NULL DEFAULT 1 CHECK(confirmed IN (0,1)),
 CHECK(actor != subject)
);
CREATE INDEX follows_actor_subject ON follows(actor,subject,uri);
CREATE INDEX follows_subject_actor ON follows(subject,actor,uri);
CREATE TABLE operations (
 operation_id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('scrobble_create','scrobble_delete','follow_create','follow_delete')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 record_uri TEXT,
 failure_code TEXT,
 CHECK(state != 'succeeded' OR failure_code IS NULL)
);
CREATE INDEX operations_owner ON operations(owner,operation_id);
CREATE TABLE outbox (
 operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
 owner TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 collection TEXT NOT NULL,
 rkey TEXT NOT NULL,
 payload_json TEXT,
 canonical_digest TEXT,
 due_at TEXT NOT NULL,
 locked_at TEXT,
 CHECK((payload_json IS NULL) = (canonical_digest IS NULL))
);
CREATE INDEX outbox_due ON outbox(due_at,operation_id);
CREATE TABLE idempotency (
 owner TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
 digest TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
 PRIMARY KEY(owner,key)
);
CREATE TABLE tombstones (
 uri TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 revision TEXT,
 operation_id TEXT REFERENCES operations(operation_id) ON DELETE SET NULL,
 created_at TEXT NOT NULL,
 pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1))
);
CREATE TABLE oauth_states (
 state_hash TEXT PRIMARY KEY NOT NULL,
 encrypted_material BLOB NOT NULL,
 issuer TEXT NOT NULL,
 did TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 CHECK(expires_at > created_at)
);
CREATE TABLE oauth_tokens (
 owner TEXT PRIMARY KEY NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 encrypted_material BLOB NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
 expires_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 session_hash TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 csrf_hash TEXT NOT NULL,
 encrypted_material BLOB NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 CHECK(expires_at > created_at)
);
CREATE INDEX sessions_owner ON sessions(owner);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE relay_checkpoints (
 relay TEXT PRIMARY KEY NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence >= 0),
 revision TEXT,
 indexed_at TEXT NOT NULL
);
CREATE TABLE indexing_status (
 scope TEXT PRIMARY KEY NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('current','recovering','stale','suppressed')),
 caught_up INTEGER NOT NULL DEFAULT 0 CHECK(caught_up IN (0,1)),
 last_indexed_at TEXT,
 lag_seconds INTEGER CHECK(lag_seconds >= 0)
);
INSERT INTO indexing_status(scope,state,caught_up) VALUES('global','recovering',0);
CREATE TABLE suppression (
 did TEXT PRIMARY KEY NOT NULL,
 suppressed_at TEXT NOT NULL
);
PRAGMA user_version = 1;
