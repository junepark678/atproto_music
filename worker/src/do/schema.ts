// IndexDO SQLite schema (ADR 0004 §6). Frozen in Wave 0.
//
// Migrations are an ordered array; worker/src/do/migrate.ts applies the
// missing ones inside one transactionSync and records each in
// `schema_migrations`. Never edit an applied migration: append a new entry
// (which needs an amendment to W0-01's schema ownership).
//
// Conventions (ADR §6):
// - Ordering timestamps are TEXT in the fixed-width 30-character UTC storage
//   form `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`; their text order is time order.
// - Internal timers and bookkeeping times are INTEGER epoch ms (`*_ms`,
//   `due_at`, `until_ms`, `window_start_ms`).
// - Every integer is a safe JS integer (Jetstream seq / time_us are ~1.8e15).
// - Statements stay D1-dialect compatible (no PRAGMA, no ATTACH, no triggers).

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

export const MIGRATIONS: readonly Migration[] = [MIGRATION_1];

/** The schema version this code expects. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Every table migration 1 creates, for tests and admin status. */
export const TABLES = [
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
] as const;

export type TableName = (typeof TABLES)[number];
