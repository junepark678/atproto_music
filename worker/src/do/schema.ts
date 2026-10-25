// The atmusic SQLite schema (ADR 0004 §6; ADR 0005 §3.2, §6.4). Migration 1
// was frozen in Wave 0 (W0-01); migration 2 is the complete Node schema
// (N1-10). Later packages never edit the schema: a missing column needs an
// amendment to N1-10.
//
// Migrations are an ordered array; worker/src/do/migrate.ts applies the
// missing ones inside one transaction and records each in
// `schema_migrations`. Never edit an applied migration: append a new entry.
// Every migration after 2 is additive (only CREATE TABLE, CREATE INDEX and
// ALTER TABLE ... ADD COLUMN; ADR 0005 §3.2), which
// worker/test/storage/schema-v2.test.ts enforces statically, and it leaves
// `schema_compat.min_compatible_version` unchanged.
//
// Conventions (ADR 0004 §6):
// - Ordering timestamps are TEXT in the fixed-width 30-character UTC storage
//   form `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`; their text order is time order.
// - Internal timers and bookkeeping times are INTEGER epoch ms (`*_ms`,
//   `due_at`, `until_ms`, `window_start_ms`).
// - Every integer is a safe JS integer (Jetstream seq / time_us are ~1.8e15).
// - Statements stay D1-dialect compatible (no PRAGMA, no ATTACH, no triggers).
//
// Migration 2 conventions (ADR 0005 §6.4):
// - Unless noted, times are INTEGER ms and listen times are TS30 text.
// - Every SHA-256 lookup hash (`*_hash`, `hash`, `session_binding`) is a
//   32-byte BLOB, enforced by CHECK.
// - Sealed values (`*ciphertext`) are BLOBs in the box format
//   keyId‖nonce‖ct‖tag; `key_id` names the `encryptionKeys` entry.
// - Ids are application-generated TEXT, except in the two log tables
//   (`ignored_listens`, `backup_runs`), whose INTEGER PRIMARY KEY SQLite assigns.

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

const TS30 = (column: string) => `CHECK(length(${column}) = 30 AND substr(${column}, 30, 1) = 'Z')`;

const MIGRATION_1: Migration = {
  version: 1,
  name: 'initial_workers_schema',
  statements: [
    // -- users: kept and extended. Active defaults to 0 until the first
    //    complete snapshot. max_rev replaces revision.
    `CREATE TABLE users (
      did TEXT PRIMARY KEY NOT NULL,
      handle TEXT,
      handle_checked_at_ms INTEGER,
      pds TEXT,
      joined_at TEXT NOT NULL,
      indexed_at TEXT,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      account_status TEXT NOT NULL DEFAULT 'unknown' CHECK(account_status IN ('unknown','active','deactivated','takendown','suspended','deleted','desynchronized','throttled','not_found')),
      max_rev TEXT,
      indexing_state TEXT NOT NULL DEFAULT 'recovering' CHECK(indexing_state IN ('current','recovering','stale','suppressed')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
      stats_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stats_version) = 'integer' AND stats_version >= 0),
      last_snapshot_at_ms INTEGER,
      last_status_check_ms INTEGER,
      last_activity_ms INTEGER
    )`,
    'CREATE UNIQUE INDEX users_verified_handle ON users(handle) WHERE handle IS NOT NULL',

    // -- scrobbles: kept. Drops confirmed (only verified present rows exist),
    //    adds rkey. Same three indexes.
    `CREATE TABLE scrobbles (
      uri TEXT PRIMARY KEY NOT NULL,
      cid TEXT NOT NULL,
      did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      rkey TEXT NOT NULL,
      revision TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      listened_at TEXT NOT NULL ${TS30('listened_at')},
      created_at TEXT NOT NULL,
      duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400),
      recording_mbid TEXT,
      indexed_at TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL,
      album_key TEXT
    )`,
    'CREATE INDEX scrobbles_owner_time ON scrobbles(did,listened_at DESC,uri DESC)',
    'CREATE INDEX scrobbles_global_time ON scrobbles(listened_at DESC,uri DESC)',
    'CREATE INDEX scrobbles_stats ON scrobbles(did,artist_key,track_key,listened_at)',

    // -- follows: kept. Drops confirmed. Same indexes.
    `CREATE TABLE follows (
      uri TEXT PRIMARY KEY NOT NULL,
      cid TEXT NOT NULL,
      actor TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      revision TEXT NOT NULL,
      created_at TEXT NOT NULL ${TS30('created_at')},
      indexed_at TEXT NOT NULL,
      CHECK(actor != subject)
    )`,
    'CREATE INDEX follows_actor_subject ON follows(actor,subject,uri)',
    'CREATE INDEX follows_subject_actor ON follows(subject,actor,uri)',

    // -- record_state: replaces tombstones. Per-URI monotonic guard; backs
    //    /api/v1/records/status.
    `CREATE TABLE record_state (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      revision TEXT NOT NULL,
      cid TEXT,
      state TEXT NOT NULL CHECK(state IN ('present','absent','excluded')),
      reason TEXT,
      verified_at TEXT NOT NULL,
      CHECK(state = 'absent' OR cid IS NOT NULL),
      CHECK(state != 'excluded' OR reason IS NOT NULL)
    )`,

    // -- suppression: kept, extended with the signed settings record identity.
    `CREATE TABLE suppression (
      did TEXT PRIMARY KEY NOT NULL,
      suppressed_at TEXT NOT NULL,
      settings_uri TEXT,
      settings_rev TEXT
    )`,

    // -- indexing_status: kept.
    `CREATE TABLE indexing_status (
      scope TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('current','recovering','stale','suppressed')),
      caught_up INTEGER NOT NULL DEFAULT 0 CHECK(caught_up IN (0,1)),
      last_indexed_at TEXT,
      lag_seconds INTEGER CHECK(lag_seconds >= 0)
    )`,
    `INSERT INTO indexing_status(scope,state,caught_up) VALUES('global','recovering',0)`,

    // -- backfill_generation: kept. Global generation counter; survives disconnect.
    `CREATE TABLE backfill_generation (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      last_generation INTEGER NOT NULL CHECK(typeof(last_generation) = 'integer' AND last_generation >= 0)
    )`,
    'INSERT INTO backfill_generation(singleton,last_generation) VALUES(1,0)',

    // -- repo_jobs: replaces repo_backfills. One resumable job per (did, kind).
    `CREATE TABLE repo_jobs (
      did TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('snapshot','status','identity')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
      reason TEXT,
      head_rev TEXT,
      head_cid TEXT,
      frontier_json TEXT,
      restarts INTEGER NOT NULL DEFAULT 0 CHECK(restarts >= 0),
      reactivate INTEGER NOT NULL DEFAULT 0 CHECK(reactivate IN (0,1)),
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      failure_code TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,kind)
    )`,
    'CREATE INDEX repo_jobs_due ON repo_jobs(kind,state,due_at,did)',

    // -- ingest_checkpoint: merges relay_checkpoints and relay_recovery.
    `CREATE TABLE ingest_checkpoint (
      stream TEXT PRIMARY KEY NOT NULL,
      cursor INTEGER CHECK(cursor >= 0),
      last_event_time_us INTEGER CHECK(last_event_time_us >= 0),
      connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)),
      pending_gap INTEGER NOT NULL DEFAULT 1 CHECK(pending_gap IN (0,1)),
      gap_scan_after_did TEXT,
      mode TEXT CHECK(mode IN ('socket','pulse','off')),
      host_index INTEGER NOT NULL DEFAULT 0 CHECK(host_index >= 0),
      connected_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    )`,
    `INSERT INTO ingest_checkpoint(stream,pending_gap) VALUES('jetstream',1)`,

    // -- hints: ordered, coalescing, durable queue of untrusted (did, collection, rkey).
    `CREATE TABLE hints (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('jetstream','notify','reconcile')),
      priority INTEGER NOT NULL,
      hint_rev TEXT,
      receipt_time TEXT NOT NULL ${TS30('receipt_time')},
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error TEXT
    )`,
    'CREATE INDEX hints_due ON hints(due_at)',
    'CREATE INDEX hints_did ON hints(did)',

    // -- snapshot_blocks: MST-node and getRepo-fallback block cache.
    `CREATE TABLE snapshot_blocks (
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY(did,cid)
    )`,

    // -- identity_cache: DID documents (TTL 5 min) and negative entries (1 h).
    `CREATE TABLE identity_cache (
      did TEXT PRIMARY KEY NOT NULL,
      doc_json TEXT,
      signing_key TEXT,
      pds TEXT,
      handle TEXT,
      fetched_at_ms INTEGER NOT NULL,
      neg_until_ms INTEGER
    )`,

    // -- verified_commits: skip a repeated signature check for (did, commit).
    `CREATE TABLE verified_commits (
      did TEXT NOT NULL,
      commit_cid TEXT NOT NULL,
      rev TEXT NOT NULL,
      verified_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,commit_cid)
    )`,

    // -- host_backoff: per-PDS-host pause honouring Retry-After / RateLimit-Reset.
    `CREATE TABLE host_backoff (
      host TEXT PRIMARY KEY NOT NULL,
      until_ms INTEGER NOT NULL
    )`,

    // -- admission: hourly new-DID admission budget.
    `CREATE TABLE admission (
      window_start_ms INTEGER PRIMARY KEY NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted >= 0)
    )`,

    // -- timers: every background task multiplexed onto the one alarm.
    `CREATE TABLE timers (
      name TEXT PRIMARY KEY NOT NULL,
      due_at INTEGER NOT NULL
    )`,

    // -- stats_cache: exact statistics cache, valid only when provably equal.
    `CREATE TABLE stats_cache (
      did TEXT NOT NULL,
      win TEXT NOT NULL CHECK(win IN ('all','7d','30d','365d')),
      lim INTEGER NOT NULL CHECK(lim BETWEEN 1 AND 100),
      as_of TEXT NOT NULL,
      lower TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY(did,win,lim)
    )`,

    // -- counters: replaces the Prometheus metrics.
    `CREATE TABLE counters (
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0),
      PRIMARY KEY(name,label)
    )`,
  ],
};

// ---------------------------------------------------------------------------
// Migration 2 (ADR 0005 §6.4, N1-10).

/** Operation kinds of the server outbox (ADR 0005 §5.8). */
export const OPERATION_KINDS = [
  'scrobble.create',
  'scrobble.delete',
  'follow.put',
  'follow.delete',
  'settings.put',
  'love.put',
  'love.delete',
] as const;
/** Operation states; `cancelled` is an operation that was never sent (ADR 0005 §5.8, §7.5). */
export const OPERATION_STATES = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;
/** Who submitted an operation or a listen (ADR 0005 §5.8). */
export const ORIGINS = ['web', 'lastfm', 'listenbrainz', 'import'] as const;
export const OAUTH_STATUSES = ['active', 'reauth_required', 'signed_out'] as const;
export const PDS_BUDGET_WINDOWS = ['hour', 'day'] as const;
export const LASTFM_TOKEN_STATES = ['issued', 'authorized', 'consumed'] as const;
export const NOW_PLAYING_SOURCES = ['web', 'lastfm', 'listenbrainz'] as const;
export const LINK_SERVICES = ['lastfm', 'listenbrainz'] as const;
export const LINK_STATUSES = ['active', 'revoked', 'error'] as const;
export const FORWARD_KINDS = ['scrobble', 'nowplaying', 'love', 'unlove'] as const;
export const FORWARD_STATES = ['queued', 'sent', 'ignored', 'failed', 'expired', 'held'] as const;
export const IMPORT_SOURCES = ['lastfm_api', 'lastfm_json', 'listenbrainz_api', 'listenbrainz_zip'] as const;
export const IMPORT_STATES = ['waiting_index', 'fetching', 'writing', 'paused', 'done', 'failed', 'cancelled'] as const;
export const IMPORT_ITEM_STATES = ['staged', 'queued', 'written', 'duplicate', 'invalid', 'failed'] as const;
export const IGNORED_LISTEN_SOURCES = ['listenbrainz'] as const;
export const IGNORED_LISTEN_REASONS = ['artist_invalid', 'track_invalid'] as const;
export const BACKUP_KINDS = ['daily', 'manual', 'pre_migration', 'pre_restore'] as const;

/** What migration 2 stores in `schema_compat.min_compatible_version` (ADR 0005 §3.2). */
export const MIN_COMPATIBLE_VERSION = 2;

const oneOf = (column: string, values: readonly string[]) =>
  `CHECK(${column} IN (${values.map((v) => `'${v}'`).join(',')}))`;
const BLOB32 = (column: string) => `CHECK(typeof(${column}) = 'blob' AND length(${column}) = 32)`;
const FLAG = (column: string) => `CHECK(${column} IN (0,1))`;
const COUNT = (column: string) => `INTEGER NOT NULL DEFAULT 0 CHECK(typeof(${column}) = 'integer' AND ${column} >= 0)`;

const MIGRATION_2: Migration = {
  version: 2,
  name: 'node_schema',
  statements: [
    // -- scrobbles: the optional record fields of ADR 0005 §6.2 and the
    //    ListenBrainz recording MSID (§8.4). NULL until a record is applied by
    //    the N3-11 projection; every v1 row is left byte-identical.
    'ALTER TABLE scrobbles ADD COLUMN album_artist TEXT',
    'ALTER TABLE scrobbles ADD COLUMN album_artist_key TEXT',
    'ALTER TABLE scrobbles ADD COLUMN track_number INTEGER CHECK(track_number BETWEEN 1 AND 9999)',
    'ALTER TABLE scrobbles ADD COLUMN artist_mbids TEXT',
    'ALTER TABLE scrobbles ADD COLUMN release_mbid TEXT',
    'ALTER TABLE scrobbles ADD COLUMN release_group_mbid TEXT',
    'ALTER TABLE scrobbles ADD COLUMN isrc TEXT',
    'ALTER TABLE scrobbles ADD COLUMN submission_client TEXT',
    'ALTER TABLE scrobbles ADD COLUMN music_service TEXT',
    'ALTER TABLE scrobbles ADD COLUMN recording_msid TEXT',
    // Partial: a full (did, recording_msid, listened_at) index is narrower than
    // scrobbles_owner_time while every msid is NULL, so the planner would pick
    // it for the per-DID stats and history reads and lose the listened_at
    // range; an msid lookup (`recording_msid = ?`) still uses this index.
    'CREATE INDEX scrobbles_msid ON scrobbles(did,recording_msid,listened_at) WHERE recording_msid IS NOT NULL',
    'CREATE INDEX scrobbles_track_global ON scrobbles(artist_key,track_key)',
    'CREATE INDEX scrobbles_artist_global ON scrobbles(artist_key)',
    'CREATE INDEX scrobbles_album_stats ON scrobbles(did,album_key,listened_at) WHERE album_key IS NOT NULL',

    // -- accounts: the local account of each signed-in DID (§9). The username
    //    is lowercase [a-z0-9][a-z0-9._-]{1,63}.
    `CREATE TABLE accounts (
      did TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE CHECK(length(username) BETWEEN 2 AND 64 AND substr(username, 1, 1) GLOB '[a-z0-9]' AND username NOT GLOB '*[^a-z0-9._-]*'),
      oauth_status TEXT NOT NULL DEFAULT 'active' ${oneOf('oauth_status', OAUTH_STATUSES)},
      share_now_playing INTEGER NOT NULL DEFAULT 1 ${FLAG('share_now_playing')},
      import_share_pct INTEGER NOT NULL DEFAULT 50 CHECK(typeof(import_share_pct) = 'integer' AND import_share_pct BETWEEN 10 AND 90),
      daily_listen_cap INTEGER NOT NULL DEFAULT 3000 CHECK(typeof(daily_listen_cap) = 'integer' AND daily_listen_cap >= 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,

    // -- web_sessions: cookie sessions, SHA-256(token) only (§5.6).
    `CREATE TABLE web_sessions (
      token_hash BLOB PRIMARY KEY NOT NULL ${BLOB32('token_hash')},
      did TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    )`,
    'CREATE INDEX web_sessions_did ON web_sessions(did)',
    'CREATE INDEX web_sessions_expiry ON web_sessions(expires_at_ms)',

    // -- oauth_states / oauth_sessions: the OAuth library's stores, sealed (§5.5).
    `CREATE TABLE oauth_states (
      key_hash BLOB PRIMARY KEY NOT NULL ${BLOB32('key_hash')},
      ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      session_binding BLOB NOT NULL ${BLOB32('session_binding')},
      expires_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_sessions (
      did TEXT PRIMARY KEY NOT NULL,
      ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      client_kid TEXT NOT NULL,
      generation ${COUNT('generation')},
      last_refresh_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' ${oneOf('status', OAUTH_STATUSES)},
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,

    // -- operations: the server outbox (§5.8). rkey is NULL for a delete
    //    intent that lists its targets when it runs (unlove); record_json and
    //    digest are set together (creates and puts).
    `CREATE TABLE operations (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      kind TEXT NOT NULL ${oneOf('kind', OPERATION_KINDS)},
      origin TEXT NOT NULL ${oneOf('origin', ORIGINS)},
      priority INTEGER NOT NULL CHECK(typeof(priority) = 'integer' AND priority >= 0),
      collection TEXT NOT NULL,
      rkey TEXT,
      record_json TEXT,
      digest TEXT,
      swap_cid TEXT,
      state TEXT NOT NULL DEFAULT 'queued' ${oneOf('state', OPERATION_STATES)},
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 10),
      due_at INTEGER NOT NULL,
      last_error TEXT,
      result_uri TEXT,
      result_cid TEXT,
      idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
      request_hash BLOB CHECK(request_hash IS NULL OR (typeof(request_hash) = 'blob' AND length(request_hash) = 32)),
      import_job_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK((record_json IS NULL) = (digest IS NULL)),
      UNIQUE(did,idempotency_key)
    )`,
    'CREATE INDEX operations_due ON operations(state,priority,due_at)',
    'CREATE INDEX operations_did_state ON operations(did,state)',

    // -- operation_deps: predecessor ordering (a delete waits for its create).
    `CREATE TABLE operation_deps (
      op_id TEXT NOT NULL,
      pred_id TEXT NOT NULL,
      PRIMARY KEY(op_id,pred_id),
      CHECK(op_id != pred_id)
    )`,

    // -- listen_keys: idempotent listen ingress and import dedupe (§7.7, §11.2).
    `CREATE TABLE listen_keys (
      did TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      operation_id TEXT,
      source TEXT NOT NULL ${oneOf('source', ORIGINS)},
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,dedupe_key)
    )`,

    // -- pds_budget: the per-DID point ledger, hour and day windows (§5.8).
    `CREATE TABLE pds_budget (
      did TEXT NOT NULL,
      window TEXT NOT NULL ${oneOf('window', PDS_BUDGET_WINDOWS)},
      window_start_ms INTEGER NOT NULL,
      points ${COUNT('points')},
      limit_hint INTEGER CHECK(limit_hint >= 0),
      remaining_hint INTEGER CHECK(remaining_hint >= 0),
      reset_at_ms INTEGER,
      PRIMARY KEY(did,window)
    )`,

    // -- Last.fm protocol credentials (§7.3). A token gets its did when it is
    //    authorized.
    `CREATE TABLE lastfm_tokens (
      token_hash BLOB PRIMARY KEY NOT NULL ${BLOB32('token_hash')},
      api_key TEXT NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      did TEXT,
      state TEXT NOT NULL DEFAULT 'issued' ${oneOf('state', LASTFM_TOKEN_STATES)},
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      CHECK(state = 'issued' OR did IS NOT NULL)
    )`,
    `CREATE TABLE lastfm_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      sk_hash BLOB NOT NULL UNIQUE ${BLOB32('sk_hash')},
      did TEXT NOT NULL,
      api_key TEXT NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      client_name TEXT,
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    )`,
    `CREATE TABLE lastfm_apps (
      api_key TEXT PRIMARY KEY NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      did TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE app_passwords (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      label TEXT,
      hash BLOB NOT NULL UNIQUE ${BLOB32('hash')},
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    )`,

    // -- lb_tokens: ListenBrainz user tokens (§8.2).
    `CREATE TABLE lb_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      label TEXT,
      hash BLOB NOT NULL UNIQUE ${BLOB32('hash')},
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    )`,

    // -- now_playing: ephemeral, never a PDS record (§7.8, §8.3).
    `CREATE TABLE now_playing (
      did TEXT PRIMARY KEY NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      album_artist TEXT,
      duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400),
      recording_mbid TEXT,
      client TEXT,
      source TEXT NOT NULL ${oneOf('source', NOW_PLAYING_SOURCES)},
      started_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    )`,

    // -- loves: the love projection (§6.3), proof-gated like scrobbles.
    `CREATE TABLE loves (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      rkey TEXT NOT NULL,
      cid TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL,
      recording_mbid TEXT,
      created_at TEXT NOT NULL ${TS30('created_at')},
      indexed_at TEXT NOT NULL
    )`,
    'CREATE INDEX loves_owner_time ON loves(did,created_at DESC,uri DESC)',
    'CREATE INDEX loves_owner_track ON loves(did,artist_key,track_key)',

    // -- linked_accounts / link_states: forwarding links (§12.1).
    `CREATE TABLE linked_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      service TEXT NOT NULL ${oneOf('service', LINK_SERVICES)},
      remote_user TEXT NOT NULL,
      credential_ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      forward_scrobbles INTEGER NOT NULL DEFAULT 1 ${FLAG('forward_scrobbles')},
      forward_now_playing INTEGER NOT NULL DEFAULT 1 ${FLAG('forward_now_playing')},
      status TEXT NOT NULL DEFAULT 'active' ${oneOf('status', LINK_STATUSES)},
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(did,service)
    )`,
    `CREATE TABLE link_states (
      state_hash BLOB PRIMARY KEY NOT NULL ${BLOB32('state_hash')},
      did TEXT NOT NULL,
      service TEXT NOT NULL ${oneOf('service', LINK_SERVICES)},
      session_hash BLOB NOT NULL ${BLOB32('session_hash')},
      expires_at_ms INTEGER NOT NULL
    )`,

    // -- forward_outbox: the forwarding queue (§12.2, §12.3). Deleting a link
    //    deletes its rows.
    `CREATE TABLE forward_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      did TEXT NOT NULL,
      kind TEXT NOT NULL ${oneOf('kind', FORWARD_KINDS)},
      dedupe_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' ${oneOf('state', FORWARD_STATES)},
      attempts ${COUNT('attempts')},
      due_at INTEGER NOT NULL,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(link_id,kind,dedupe_key)
    )`,
    'CREATE INDEX forward_outbox_due ON forward_outbox(state,due_at)',

    // -- import_jobs / import_items: imports (§11). attempts counts slices that
    //    never completed (the crash-loop guard, §11.4); invalid_reasons is a
    //    JSON object of counts by reason; upload_bytes counts received bytes.
    `CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      source TEXT NOT NULL ${oneOf('source', IMPORT_SOURCES)},
      remote_user TEXT,
      state TEXT NOT NULL DEFAULT 'waiting_index' ${oneOf('state', IMPORT_STATES)},
      cursor_json TEXT,
      upload_path TEXT,
      upload_bytes INTEGER CHECK(upload_bytes IS NULL OR (typeof(upload_bytes) = 'integer' AND upload_bytes >= 0)),
      fetched ${COUNT('fetched')},
      staged ${COUNT('staged')},
      duplicates ${COUNT('duplicates')},
      invalid ${COUNT('invalid')},
      invalid_reasons TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(invalid_reasons) AND json_type(invalid_reasons) = 'object'),
      written ${COUNT('written')},
      failed_items ${COUNT('failed_items')},
      attempts ${COUNT('attempts')},
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER
    )`,
    'CREATE INDEX import_jobs_did_state ON import_jobs(did,state)',
    `CREATE TABLE import_items (
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(typeof(seq) = 'integer' AND seq >= 0),
      dedupe_key TEXT NOT NULL,
      listened_at TEXT NOT NULL ${TS30('listened_at')},
      record_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'staged' ${oneOf('state', IMPORT_ITEM_STATES)},
      operation_id TEXT,
      PRIMARY KEY(job_id,seq),
      UNIQUE(job_id,dedupe_key)
    )`,
    'CREATE INDEX import_items_job_state ON import_items(job_id,state,seq)',

    // -- ignored_listens: listens ListenBrainz accepts but our validator
    //    refuses (§8.3); each preview is the first 128 scalars; kept 30 days.
    `CREATE TABLE ignored_listens (
      id INTEGER PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      source TEXT NOT NULL ${oneOf('source', IGNORED_LISTEN_SOURCES)},
      reason TEXT NOT NULL ${oneOf('reason', IGNORED_LISTEN_REASONS)},
      listened_at TEXT NOT NULL ${TS30('listened_at')},
      artist_preview TEXT NOT NULL CHECK(length(artist_preview) <= 128),
      track_preview TEXT NOT NULL CHECK(length(track_preview) <= 128),
      created_at_ms INTEGER NOT NULL
    )`,
    'CREATE INDEX ignored_listens_did_time ON ignored_listens(did,created_at_ms DESC)',

    // -- range_stats_cache: the full ranked list per range (§10.3).
    `CREATE TABLE range_stats_cache (
      did TEXT NOT NULL,
      entity TEXT NOT NULL,
      range_key TEXT NOT NULL,
      as_of TEXT NOT NULL,
      lower TEXT,
      upper TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,entity,range_key)
    )`,

    // -- backup_runs: backup history (§14.5).
    `CREATE TABLE backup_runs (
      id INTEGER PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL ${oneOf('kind', BACKUP_KINDS)},
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      path TEXT,
      bytes INTEGER CHECK(bytes IS NULL OR (typeof(bytes) = 'integer' AND bytes >= 0)),
      ok INTEGER NOT NULL DEFAULT 0 ${FLAG('ok')},
      error TEXT
    )`,

    // -- schema_compat: one row, the oldest code version that may run on this
    //    database (§3.2). Only a non-additive migration may raise it. The
    //    `singleton` key (as in backfill_generation) makes a second row
    //    impossible.
    `CREATE TABLE schema_compat (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      min_compatible_version INTEGER NOT NULL CHECK(typeof(min_compatible_version) = 'integer' AND min_compatible_version >= 1)
    )`,
    `INSERT INTO schema_compat(singleton,min_compatible_version) VALUES(1,${MIN_COMPATIBLE_VERSION})`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [MIGRATION_1, MIGRATION_2];

/** The schema version this code expects. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Every table of the schema, for tests, admin status and restore: those the
 * migrations create and `schema_migrations`, the ledger migrate.ts creates.
 */
export const TABLES = [
  // Migration 1.
  'users',
  'scrobbles',
  'follows',
  'record_state',
  'suppression',
  'indexing_status',
  'backfill_generation',
  'repo_jobs',
  'ingest_checkpoint',
  'hints',
  'snapshot_blocks',
  'identity_cache',
  'verified_commits',
  'host_backoff',
  'admission',
  'timers',
  'stats_cache',
  'counters',
  // The migration ledger (worker/src/do/migrate.ts).
  'schema_migrations',
  // Migration 2.
  'accounts',
  'web_sessions',
  'oauth_states',
  'oauth_sessions',
  'operations',
  'operation_deps',
  'listen_keys',
  'pds_budget',
  'lastfm_tokens',
  'lastfm_sessions',
  'lastfm_apps',
  'app_passwords',
  'lb_tokens',
  'now_playing',
  'loves',
  'linked_accounts',
  'link_states',
  'forward_outbox',
  'import_jobs',
  'import_items',
  'ignored_listens',
  'range_stats_cache',
  'backup_runs',
  'schema_compat',
] as const;

export type TableName = (typeof TABLES)[number];

export type TableClass = 'derived' | 'non-derived';

/**
 * ADR 0005 §6.4, §14.5. `derived` tables can be rebuilt from public
 * repositories: the index, its ingestion queues, checkpoints and caches, and
 * the timers. `non-derived` tables hold local state that exists nowhere else.
 * Restore (N4-02) keeps the live rows of every non-derived table and takes
 * only the derived tables from a backup; a table without a class aborts it.
 */
export const TABLE_CLASS: Readonly<Record<TableName, TableClass>> = {
  users: 'derived',
  scrobbles: 'derived',
  follows: 'derived',
  record_state: 'derived',
  suppression: 'derived',
  indexing_status: 'derived',
  backfill_generation: 'derived',
  repo_jobs: 'derived',
  ingest_checkpoint: 'derived',
  hints: 'derived',
  snapshot_blocks: 'derived',
  identity_cache: 'derived',
  verified_commits: 'derived',
  host_backoff: 'derived',
  admission: 'derived',
  timers: 'derived',
  stats_cache: 'derived',
  counters: 'non-derived',
  schema_migrations: 'non-derived',
  accounts: 'non-derived',
  web_sessions: 'non-derived',
  oauth_states: 'non-derived',
  oauth_sessions: 'non-derived',
  operations: 'non-derived',
  operation_deps: 'non-derived',
  listen_keys: 'non-derived',
  pds_budget: 'non-derived',
  lastfm_tokens: 'non-derived',
  lastfm_sessions: 'non-derived',
  lastfm_apps: 'non-derived',
  app_passwords: 'non-derived',
  lb_tokens: 'non-derived',
  now_playing: 'non-derived',
  loves: 'derived',
  linked_accounts: 'non-derived',
  link_states: 'non-derived',
  forward_outbox: 'non-derived',
  import_jobs: 'non-derived',
  import_items: 'non-derived',
  ignored_listens: 'non-derived',
  range_stats_cache: 'derived',
  backup_runs: 'non-derived',
  schema_compat: 'non-derived',
};
