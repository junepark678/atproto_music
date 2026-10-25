// N1-10: migration 2, the complete Node schema (ADR 0005 §3.2, §6.4, §8.3,
// §14.5), on real DO SQLite in the harness DO (the DDL is the one node:sqlite
// runs; N2-02 ports this file to the Node harness).
//
// Expectations are hardcoded from ADR 0005 §6.4, not derived from schema.ts.
// The column lists are typed against worker/src/app/rows.ts, so a row type
// that drifts from the table fails typecheck and the table that drifts from
// the ADR fails here.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import type {
  AccountRow,
  AppPasswordRow,
  BackupRunRow,
  ForwardOutboxRow,
  IgnoredListenRow,
  ImportItemRow,
  ImportJobRow,
  LastfmAppRow,
  LastfmSessionRow,
  LastfmTokenRow,
  LbTokenRow,
  LinkedAccountRow,
  LinkStateRow,
  ListenKeyRow,
  LoveRow,
  NowPlayingRow,
  OAuthSessionRow,
  OAuthStateRow,
  OperationDepRow,
  OperationRow,
  PdsBudgetRow,
  RangeStatsCacheRow,
  SchemaCompatRow,
  ScrobbleV2Columns,
  WebSessionRow,
} from '../../src/app/rows';
import { type Db, doDb, type SqlParam } from '../../src/do/db';
import { migrate } from '../../src/do/migrate';
import {
  FORWARD_KINDS,
  IMPORT_SOURCES,
  LINK_SERVICES,
  MIGRATIONS,
  MIN_COMPATIBLE_VERSION,
  type Migration,
  OPERATION_KINDS,
  OPERATION_STATES,
  SCHEMA_VERSION,
  TABLE_CLASS,
  TABLES,
} from '../../src/do/schema';
import type { HarnessDO } from '../harness/harness-do';
import { readFixture } from '../read/scrobble-read-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const TS = '2026-01-15T12:00:00.000000000Z';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const SCROBBLE = 'com.example.atmusic.scrobble';
const LOVE = 'com.example.atmusic.love';

/** A 32-byte BLOB parameter (a SHA-256 value) filled with `n`. */
const hash = (n: number): ArrayBuffer => new Uint8Array(32).fill(n).buffer;
const sealed = (n: number): ArrayBuffer => new Uint8Array(48).fill(n).buffer;

// ---------------------------------------------------------------------------
// Expected schema (ADR 0005 §6.4)

/** Every key of the row type, in table order; a missing or extra key is a type error. */
const cols = <T>(c: { [K in keyof T]-?: true }): string[] => Object.keys(c);

interface ExpectedTable {
  columns: string[];
  pk: string[];
  /** Column sets of UNIQUE constraints (not the primary key). */
  unique?: string[][];
}

const NEW_TABLES: Record<string, ExpectedTable> = {
  accounts: {
    columns: cols<AccountRow>({
      did: true,
      username: true,
      oauth_status: true,
      share_now_playing: true,
      import_share_pct: true,
      daily_listen_cap: true,
      created_at_ms: true,
      updated_at_ms: true,
    }),
    pk: ['did'],
    unique: [['username']],
  },
  web_sessions: {
    columns: cols<WebSessionRow>({
      token_hash: true,
      did: true,
      created_at_ms: true,
      expires_at_ms: true,
      last_seen_ms: true,
    }),
    pk: ['token_hash'],
  },
  oauth_states: {
    columns: cols<OAuthStateRow>({
      key_hash: true,
      ciphertext: true,
      key_id: true,
      session_binding: true,
      expires_at_ms: true,
    }),
    pk: ['key_hash'],
  },
  oauth_sessions: {
    columns: cols<OAuthSessionRow>({
      did: true,
      ciphertext: true,
      key_id: true,
      client_kid: true,
      generation: true,
      last_refresh_ms: true,
      status: true,
      created_at_ms: true,
      updated_at_ms: true,
    }),
    pk: ['did'],
  },
  operations: {
    columns: cols<OperationRow>({
      id: true,
      did: true,
      kind: true,
      origin: true,
      priority: true,
      collection: true,
      rkey: true,
      record_json: true,
      digest: true,
      swap_cid: true,
      state: true,
      attempts: true,
      due_at: true,
      last_error: true,
      result_uri: true,
      result_cid: true,
      idempotency_key: true,
      request_hash: true,
      import_job_id: true,
      created_at_ms: true,
      updated_at_ms: true,
    }),
    pk: ['id'],
    unique: [['did', 'idempotency_key']],
  },
  operation_deps: { columns: cols<OperationDepRow>({ op_id: true, pred_id: true }), pk: ['op_id', 'pred_id'] },
  listen_keys: {
    columns: cols<ListenKeyRow>({ did: true, dedupe_key: true, operation_id: true, source: true, created_at_ms: true }),
    pk: ['did', 'dedupe_key'],
  },
  pds_budget: {
    columns: cols<PdsBudgetRow>({
      did: true,
      window: true,
      window_start_ms: true,
      points: true,
      limit_hint: true,
      remaining_hint: true,
      reset_at_ms: true,
    }),
    pk: ['did', 'window'],
  },
  lastfm_tokens: {
    columns: cols<LastfmTokenRow>({
      token_hash: true,
      api_key: true,
      did: true,
      state: true,
      created_at_ms: true,
      expires_at_ms: true,
    }),
    pk: ['token_hash'],
  },
  lastfm_sessions: {
    columns: cols<LastfmSessionRow>({
      id: true,
      sk_hash: true,
      did: true,
      api_key: true,
      client_name: true,
      created_at_ms: true,
      last_used_ms: true,
    }),
    pk: ['id'],
    unique: [['sk_hash']],
  },
  lastfm_apps: {
    columns: cols<LastfmAppRow>({
      api_key: true,
      did: true,
      name: true,
      secret_ciphertext: true,
      key_id: true,
      created_at_ms: true,
    }),
    pk: ['api_key'],
  },
  app_passwords: {
    columns: cols<AppPasswordRow>({
      id: true,
      did: true,
      label: true,
      hash: true,
      created_at_ms: true,
      last_used_ms: true,
    }),
    pk: ['id'],
    unique: [['hash']],
  },
  lb_tokens: {
    columns: cols<LbTokenRow>({
      id: true,
      did: true,
      label: true,
      hash: true,
      created_at_ms: true,
      last_used_ms: true,
    }),
    pk: ['id'],
    unique: [['hash']],
  },
  now_playing: {
    columns: cols<NowPlayingRow>({
      did: true,
      artist: true,
      track: true,
      album: true,
      album_artist: true,
      duration_seconds: true,
      recording_mbid: true,
      client: true,
      source: true,
      started_at_ms: true,
      expires_at_ms: true,
    }),
    pk: ['did'],
  },
  loves: {
    columns: cols<LoveRow>({
      uri: true,
      did: true,
      rkey: true,
      cid: true,
      artist: true,
      track: true,
      album: true,
      artist_key: true,
      track_key: true,
      recording_mbid: true,
      created_at: true,
      indexed_at: true,
    }),
    pk: ['uri'],
  },
  linked_accounts: {
    columns: cols<LinkedAccountRow>({
      id: true,
      did: true,
      service: true,
      remote_user: true,
      credential_ciphertext: true,
      key_id: true,
      forward_scrobbles: true,
      forward_now_playing: true,
      status: true,
      last_error: true,
      created_at_ms: true,
      updated_at_ms: true,
    }),
    pk: ['id'],
    unique: [['did', 'service']],
  },
  link_states: {
    columns: cols<LinkStateRow>({
      state_hash: true,
      did: true,
      service: true,
      session_hash: true,
      expires_at_ms: true,
    }),
    pk: ['state_hash'],
  },
  forward_outbox: {
    columns: cols<ForwardOutboxRow>({
      id: true,
      link_id: true,
      did: true,
      kind: true,
      dedupe_key: true,
      payload_json: true,
      state: true,
      attempts: true,
      due_at: true,
      last_error: true,
      created_at_ms: true,
      updated_at_ms: true,
    }),
    pk: ['id'],
    unique: [['link_id', 'kind', 'dedupe_key']],
  },
  import_jobs: {
    columns: cols<ImportJobRow>({
      id: true,
      did: true,
      source: true,
      remote_user: true,
      state: true,
      cursor_json: true,
      upload_path: true,
      upload_bytes: true,
      fetched: true,
      staged: true,
      duplicates: true,
      invalid: true,
      invalid_reasons: true,
      written: true,
      failed_items: true,
      attempts: true,
      error: true,
      created_at_ms: true,
      updated_at_ms: true,
      finished_at_ms: true,
    }),
    pk: ['id'],
  },
  import_items: {
    columns: cols<ImportItemRow>({
      job_id: true,
      seq: true,
      dedupe_key: true,
      listened_at: true,
      record_json: true,
      state: true,
      operation_id: true,
    }),
    pk: ['job_id', 'seq'],
    unique: [['job_id', 'dedupe_key']],
  },
  ignored_listens: {
    columns: cols<IgnoredListenRow>({
      id: true,
      did: true,
      source: true,
      reason: true,
      listened_at: true,
      artist_preview: true,
      track_preview: true,
      created_at_ms: true,
    }),
    pk: ['id'],
  },
  range_stats_cache: {
    columns: cols<RangeStatsCacheRow>({
      did: true,
      entity: true,
      range_key: true,
      as_of: true,
      lower: true,
      upper: true,
      version: true,
      body: true,
      created_at_ms: true,
    }),
    pk: ['did', 'entity', 'range_key'],
  },
  backup_runs: {
    columns: cols<BackupRunRow>({
      id: true,
      kind: true,
      started_at_ms: true,
      finished_at_ms: true,
      path: true,
      bytes: true,
      ok: true,
      error: true,
    }),
    pk: ['id'],
  },
  schema_compat: {
    columns: cols<SchemaCompatRow>({ singleton: true, min_compatible_version: true }),
    pk: ['singleton'],
  },
};

/** The columns migration 2 appends to scrobbles, in order. */
const NEW_SCROBBLE_COLUMNS = cols<ScrobbleV2Columns>({
  album_artist: true,
  album_artist_key: true,
  track_number: true,
  artist_mbids: true,
  release_mbid: true,
  release_group_mbid: true,
  isrc: true,
  submission_client: true,
  music_service: true,
  recording_msid: true,
});

/** New named indexes: table, unique, partial, [column, desc] in key order. */
const NEW_INDEXES: Record<string, [string, number, number, Array<[string, number]>]> = {
  // Partial (WHERE recording_msid IS NOT NULL), so it never shadows the
  // per-DID time index while msids are NULL.
  scrobbles_msid: [
    'scrobbles',
    0,
    1,
    [
      ['did', 0],
      ['recording_msid', 0],
      ['listened_at', 0],
    ],
  ],
  scrobbles_track_global: [
    'scrobbles',
    0,
    0,
    [
      ['artist_key', 0],
      ['track_key', 0],
    ],
  ],
  scrobbles_artist_global: ['scrobbles', 0, 0, [['artist_key', 0]]],
  scrobbles_album_stats: [
    'scrobbles',
    0,
    1,
    [
      ['did', 0],
      ['album_key', 0],
      ['listened_at', 0],
    ],
  ],
  web_sessions_did: ['web_sessions', 0, 0, [['did', 0]]],
  web_sessions_expiry: ['web_sessions', 0, 0, [['expires_at_ms', 0]]],
  operations_due: [
    'operations',
    0,
    0,
    [
      ['state', 0],
      ['priority', 0],
      ['due_at', 0],
    ],
  ],
  operations_did_state: [
    'operations',
    0,
    0,
    [
      ['did', 0],
      ['state', 0],
    ],
  ],
  loves_owner_time: [
    'loves',
    0,
    0,
    [
      ['did', 0],
      ['created_at', 1],
      ['uri', 1],
    ],
  ],
  loves_owner_track: [
    'loves',
    0,
    0,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
    ],
  ],
  forward_outbox_due: [
    'forward_outbox',
    0,
    0,
    [
      ['state', 0],
      ['due_at', 0],
    ],
  ],
  import_jobs_did_state: [
    'import_jobs',
    0,
    0,
    [
      ['did', 0],
      ['state', 0],
    ],
  ],
  import_items_job_state: [
    'import_items',
    0,
    0,
    [
      ['job_id', 0],
      ['state', 0],
      ['seq', 0],
    ],
  ],
  ignored_listens_did_time: [
    'ignored_listens',
    0,
    0,
    [
      ['did', 0],
      ['created_at_ms', 1],
    ],
  ],
};

/** The only foreign keys migration 2 adds: [table, from, parent, to, on_delete]. */
const NEW_FOREIGN_KEYS = [
  ['loves', 'did', 'users', 'did', 'CASCADE'],
  ['forward_outbox', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
];

// ---------------------------------------------------------------------------
// Helpers

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function appObjects(db: Db): MasterRow[] {
  return db.all<MasterRow>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
}

const tableNames = (db: Db) =>
  appObjects(db)
    .filter((o) => o.type === 'table')
    .map((o) => o.name);

function columnsOf(db: Db, table: string): string[] {
  return db.all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map((r) => r.name);
}

function pkOf(db: Db, table: string): string[] {
  return db
    .all<{ name: string }>('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', table)
    .map((r) => r.name);
}

function uniqueSets(db: Db, table: string): string[][] {
  return db
    .all<{ name: string }>("SELECT name FROM pragma_index_list(?) WHERE origin = 'u' ORDER BY name", table)
    .map((ix) =>
      db.all<{ name: string }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', ix.name).map((c) => c.name),
    );
}

function indexShape(db: Db, table: string, index: string) {
  const list = db.one<{ unique: number; partial: number }>(
    'SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?',
    table,
    index,
  );
  const keys = db
    .all<{ name: string; desc: number }>(
      'SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
      index,
    )
    .map((c): [string, number] => [c.name, c.desc]);
  return [table, list?.unique, list?.partial, keys];
}

function foreignKeys(db: Db, table: string): string[][] {
  return db
    .all<{ from: string; table: string; to: string; on_delete: string }>(
      'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)',
      table,
    )
    .map((f) => [table, f.from, f.table, f.to, f.on_delete]);
}

function insert(db: Db, table: string, row: Record<string, SqlParam>): void {
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => row[k] as SqlParam),
  );
}

const count = (db: Db, table: string) => db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n;

function plan(db: Db, tag: string, sql: string, ...params: SqlParam[]): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN /* ${tag} */ ${sql}`, ...params).map((r) => r.detail);
}

function inDb<T>(name: string, fn: (db: Db) => T): Promise<T> {
  return runInDurableObject(stubFor(name), (_i: HarnessDO, s: DurableObjectState) => fn(doDb(s.storage)));
}

/** Wipe the DO's storage and apply migration 1 only: a database written by version-1 code. */
function resetToV1(name: string): Promise<unknown> {
  return runInDurableObject(stubFor(name), async (_i: HarnessDO, s: DurableObjectState) => {
    await s.storage.deleteAll();
    return migrate(s.storage, MIGRATIONS.slice(0, 1));
  });
}

function migrateToLatest(name: string): Promise<unknown> {
  return runInDurableObject(stubFor(name), (_i: HarnessDO, s: DurableObjectState) => migrate(s.storage));
}

/** Every row of `table`, each column as SQLite's quote() literal (exact bytes and type), in rowid order. */
function quotedRows(db: Db, table: string, columns: string[]): string[] {
  const expr = columns.map((c) => `quote(${c})`).join(" || '|' || ");
  return db.all<{ r: string }>(`SELECT ${expr} AS r FROM ${table} ORDER BY rowid`).map((x) => x.r);
}

const user = (db: Db, did: string) => db.run('INSERT INTO users(did, joined_at) VALUES (?, ?)', did, TS);
const op = (id: string, o: Record<string, SqlParam> = {}) => ({
  id,
  did: ALICE,
  kind: 'scrobble.create',
  origin: 'web',
  priority: 0,
  collection: SCROBBLE,
  rkey: '3lb2aaaaaaa2a',
  record_json: '{}',
  digest: 'digest',
  due_at: T0,
  created_at_ms: T0,
  updated_at_ms: T0,
  ...o,
});
const link = (id: string, o: Record<string, SqlParam> = {}) => ({
  id,
  did: ALICE,
  service: 'lastfm',
  remote_user: 'rj',
  credential_ciphertext: sealed(1),
  key_id: 'e1',
  created_at_ms: T0,
  updated_at_ms: T0,
  ...o,
});
const forward = (id: string, linkId: string, o: Record<string, SqlParam> = {}) => ({
  id,
  link_id: linkId,
  did: ALICE,
  kind: 'scrobble',
  dedupe_key: `key-${id}`,
  payload_json: '{}',
  due_at: T0,
  created_at_ms: T0,
  updated_at_ms: T0,
  ...o,
});
const importJob = (id: string, o: Record<string, SqlParam> = {}) => ({
  id,
  did: ALICE,
  source: 'lastfm_api',
  created_at_ms: T0,
  updated_at_ms: T0,
  ...o,
});
const love = (uri: string, did: string, o: Record<string, SqlParam> = {}) => ({
  uri,
  did,
  rkey: uri.slice(uri.lastIndexOf('/') + 1),
  cid: 'bafylove',
  artist: 'Björk',
  track: 'Jóga',
  artist_key: 'björk',
  track_key: 'jóga',
  created_at: TS,
  indexed_at: TS,
  ...o,
});
const ignored = (did: string, createdAtMs: number, o: Record<string, SqlParam> = {}) => ({
  did,
  source: 'listenbrainz',
  reason: 'artist_invalid',
  listened_at: TS,
  artist_preview: 'a',
  track_preview: 't',
  created_at_ms: createdAtMs,
  ...o,
});

const CHECK_FAILED = /CHECK constraint failed/;
const UNIQUE_FAILED = /UNIQUE constraint failed/;

// ---------------------------------------------------------------------------

describe('schema v2 (ADR 0005 §6.4)', () => {
  it('migration 2 creates exactly the ADR 0005 §6.4 tables, scrobbles columns and indexes, and TABLES lists every table', async () => {
    const v1Name = 'schema-v2-shape-v1';
    expect(await resetToV1(v1Name)).toEqual({ status: 'ready', version: 1 });
    const v1 = await inDb(v1Name, (db) => ({ objects: appObjects(db), scrobbles: columnsOf(db, 'scrobbles') }));
    expect(v1.objects.some((o) => o.name === 'accounts')).toBe(false);

    // The constructor of a fresh harness DO applied every migration.
    const v2 = await inDb('schema-v2-shape', (db) => {
      const objects = appObjects(db);
      return {
        objects,
        scrobbles: columnsOf(db, 'scrobbles'),
        tables: Object.fromEntries(
          Object.keys(NEW_TABLES).map((t) => [
            t,
            { columns: columnsOf(db, t), pk: pkOf(db, t), unique: uniqueSets(db, t) },
          ]),
        ),
        indexes: Object.fromEntries(
          objects
            .filter((o) => o.type === 'index' && !v1.objects.some((x) => x.name === o.name))
            .map((o) => [o.name, indexShape(db, o.tbl_name, o.name)]),
        ),
        foreignKeys: Object.keys(NEW_TABLES).flatMap((t) => foreignKeys(db, t)),
        allTables: tableNames(db),
      };
    });

    // Exactly the new tables and indexes, no trigger or view.
    const added = v2.objects.filter((o) => !v1.objects.some((x) => x.name === o.name));
    expect(
      added
        .filter((o) => o.type === 'table')
        .map((o) => o.name)
        .sort(),
    ).toEqual(Object.keys(NEW_TABLES).sort());
    expect(
      added
        .filter((o) => o.type === 'index')
        .map((o) => o.name)
        .sort(),
    ).toEqual(Object.keys(NEW_INDEXES).sort());
    expect(added.every((o) => o.type === 'table' || o.type === 'index')).toBe(true);
    expect(v2.objects.filter((o) => o.type === 'trigger' || o.type === 'view')).toEqual([]);
    // No v1 object was dropped, and every v1 object but scrobbles (ALTER ... ADD COLUMN) keeps its DDL.
    for (const o of v1.objects) {
      const now = v2.objects.find((x) => x.name === o.name);
      expect([o.name, now?.type]).toEqual([o.name, o.type]);
      if (o.name !== 'scrobbles') expect([o.name, now?.sql]).toEqual([o.name, o.sql]);
    }

    // scrobbles: the v1 columns in place, then the §6.2/§8.4 columns.
    expect(v2.scrobbles).toEqual([...v1.scrobbles, ...NEW_SCROBBLE_COLUMNS]);
    expect(v1.scrobbles).not.toContain('album_artist');

    // Every new table's columns, primary key and UNIQUE constraints.
    for (const [table, e] of Object.entries(NEW_TABLES)) {
      expect([table, v2.tables[table]]).toEqual([table, { columns: e.columns, pk: e.pk, unique: e.unique ?? [] }]);
    }
    // Every new index's shape (columns, DESC, partial).
    expect(v2.indexes).toEqual(NEW_INDEXES);
    expect(v2.foreignKeys).toEqual(NEW_FOREIGN_KEYS);

    // TABLES lists every table of the database exactly once, and nothing else.
    expect(new Set(TABLES).size).toBe(TABLES.length);
    expect([...TABLES].sort()).toEqual([...v2.allTables].sort());
    expect(v2.allTables).toContain('schema_migrations');
  });

  it('CHECK constraints accept operation state cancelled and reject an unknown operation kind, operation state, link service, import source and forward kind', async () => {
    // The ADR 0005 value sets, hardcoded; schema.ts exports the same lists.
    const kinds = [
      'scrobble.create',
      'scrobble.delete',
      'follow.put',
      'follow.delete',
      'settings.put',
      'love.put',
      'love.delete',
    ];
    const states = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'];
    const services = ['lastfm', 'listenbrainz'];
    const sources = ['lastfm_api', 'lastfm_json', 'listenbrainz_api', 'listenbrainz_zip'];
    const forwardKinds = ['scrobble', 'nowplaying', 'love', 'unlove'];
    expect([OPERATION_KINDS, OPERATION_STATES, LINK_SERVICES, IMPORT_SOURCES, FORWARD_KINDS]).toEqual([
      kinds,
      states,
      services,
      sources,
      forwardKinds,
    ]);

    const result = await inDb('schema-v2-checks', (db) => {
      for (const [i, kind] of kinds.entries()) insert(db, 'operations', op(`k${i}`, { kind }));
      for (const [i, state] of states.entries()) insert(db, 'operations', op(`s${i}`, { state }));
      // A queued create becomes cancelled (ADR 0005 §5.8, §7.5).
      db.run("UPDATE operations SET state = 'cancelled' WHERE id = 'k0'");
      for (const [i, service] of services.entries()) insert(db, 'linked_accounts', link(`l${i}`, { service }));
      for (const [i, source] of sources.entries()) insert(db, 'import_jobs', importJob(`j${i}`, { source }));
      for (const [i, kind] of forwardKinds.entries()) insert(db, 'forward_outbox', forward(`f${i}`, 'l0', { kind }));

      const rejected = [
        () => insert(db, 'operations', op('bad-kind', { kind: 'scrobble.update' })),
        () => insert(db, 'operations', op('bad-state', { state: 'paused' })),
        () => db.run("UPDATE operations SET state = 'done' WHERE id = 's0'"),
        () => insert(db, 'linked_accounts', link('bad-service', { did: BOB, service: 'spotify' })),
        () => insert(db, 'import_jobs', importJob('bad-source', { source: 'lastfm' })),
        () => insert(db, 'forward_outbox', forward('bad-kind', 'l0', { kind: 'delete' })),
      ].map((f) => {
        try {
          f();
          return 'accepted';
        } catch (e) {
          return String((e as Error).message);
        }
      });
      return {
        rejected,
        counts: ['operations', 'linked_accounts', 'import_jobs', 'forward_outbox'].map((t) => count(db, t)),
        cancelled: db.all("SELECT id FROM operations WHERE state = 'cancelled' ORDER BY id"),
        s0: db.one("SELECT state FROM operations WHERE id = 's0'"),
      };
    });

    expect(result.rejected).toHaveLength(6);
    for (const [i, column] of ['kind', 'state', 'state', 'service', 'source', 'kind'].entries()) {
      expect(result.rejected[i]).toMatch(CHECK_FAILED);
      expect(result.rejected[i]).toContain(`${column} IN (`);
    }
    // Only the accepted rows exist; the refused update changed nothing.
    expect(result.counts).toEqual([kinds.length + states.length, services.length, sources.length, forwardKinds.length]);
    expect(result.cancelled).toEqual([{ id: 'k0' }, { id: 's5' }]);
    expect(result.s0).toEqual({ state: 'queued' });
  });

  it('UNIQUE(did, idempotency_key), listen_keys PK, forward_outbox (link_id, kind, dedupe_key) and lastfm_sessions.sk_hash are enforced', async () => {
    const r = await inDb('schema-v2-unique', (db) => {
      const errors: string[] = [];
      const attempt = (f: () => void) => {
        try {
          f();
        } catch (e) {
          errors.push(String((e as Error).message));
        }
      };

      // Idempotency keys are scoped per DID; NULL keys never collide.
      insert(db, 'operations', op('o1', { idempotency_key: 'idem-1' }));
      attempt(() => insert(db, 'operations', op('o2', { idempotency_key: 'idem-1' })));
      insert(db, 'operations', op('o3', { did: BOB, idempotency_key: 'idem-1' }));
      insert(db, 'operations', op('o4'));
      insert(db, 'operations', op('o5'));

      // One listen key per (did, dedupe_key).
      const key = { did: ALICE, dedupe_key: 'lk-1', operation_id: 'o1', source: 'lastfm', created_at_ms: T0 };
      insert(db, 'listen_keys', key);
      attempt(() => insert(db, 'listen_keys', { ...key, operation_id: 'o4', source: 'listenbrainz' }));
      const ignoredResend = db.run(
        "INSERT OR IGNORE INTO listen_keys(did, dedupe_key, source, created_at_ms) VALUES (?, 'lk-1', 'web', ?)",
        ALICE,
        T0,
      );
      insert(db, 'listen_keys', { ...key, did: BOB });

      // One forward row per (link, kind, dedupe_key).
      insert(db, 'linked_accounts', link('l1'));
      insert(db, 'linked_accounts', link('l2', { service: 'listenbrainz' }));
      insert(db, 'forward_outbox', forward('f1', 'l1', { dedupe_key: 'lk-1' }));
      attempt(() => insert(db, 'forward_outbox', forward('f2', 'l1', { dedupe_key: 'lk-1' })));
      insert(db, 'forward_outbox', forward('f3', 'l1', { kind: 'nowplaying', dedupe_key: 'lk-1' }));
      insert(db, 'forward_outbox', forward('f4', 'l2', { dedupe_key: 'lk-1' }));

      // A session key hash names one session.
      const session = {
        sk_hash: hash(7),
        did: ALICE,
        api_key: 'k',
        client_name: 'Pano Scrobbler',
        created_at_ms: T0,
      };
      insert(db, 'lastfm_sessions', { id: 's1', ...session });
      attempt(() => insert(db, 'lastfm_sessions', { id: 's2', ...session, did: BOB }));
      insert(db, 'lastfm_sessions', { id: 's3', ...session, sk_hash: hash(8) });

      return {
        errors,
        ignoredResend: ignoredResend.rowsWritten,
        operations: db.all('SELECT id, did, idempotency_key FROM operations ORDER BY id'),
        listenKeys: db.all('SELECT did, dedupe_key, operation_id, source FROM listen_keys ORDER BY did'),
        forwards: db.all('SELECT id, link_id, kind FROM forward_outbox ORDER BY id'),
        sessions: db.all('SELECT id, did FROM lastfm_sessions ORDER BY id'),
      };
    });

    expect(r.errors).toHaveLength(4);
    for (const e of r.errors) expect(e).toMatch(UNIQUE_FAILED);
    expect(r.errors[0]).toContain('operations.did, operations.idempotency_key');
    expect(r.errors[1]).toContain('listen_keys.did, listen_keys.dedupe_key');
    expect(r.errors[2]).toContain('forward_outbox.link_id, forward_outbox.kind, forward_outbox.dedupe_key');
    expect(r.errors[3]).toContain('lastfm_sessions.sk_hash');
    expect(r.ignoredResend).toBe(0);
    expect(r.operations).toEqual([
      { id: 'o1', did: ALICE, idempotency_key: 'idem-1' },
      { id: 'o3', did: BOB, idempotency_key: 'idem-1' },
      { id: 'o4', did: ALICE, idempotency_key: null },
      { id: 'o5', did: ALICE, idempotency_key: null },
    ]);
    // The first listen key row is kept unchanged.
    expect(r.listenKeys).toEqual([
      { did: ALICE, dedupe_key: 'lk-1', operation_id: 'o1', source: 'lastfm' },
      { did: BOB, dedupe_key: 'lk-1', operation_id: 'o1', source: 'lastfm' },
    ]);
    expect(r.forwards).toEqual([
      { id: 'f1', link_id: 'l1', kind: 'scrobble' },
      { id: 'f3', link_id: 'l1', kind: 'nowplaying' },
      { id: 'f4', link_id: 'l2', kind: 'scrobble' },
    ]);
    expect(r.sessions).toEqual([
      { id: 's1', did: ALICE },
      { id: 's3', did: ALICE },
    ]);
  });

  it('deleting a users row cascades its loves and deleting a linked_accounts row cascades its forward_outbox rows', async () => {
    const r = await inDb('schema-v2-cascade', (db) => {
      user(db, ALICE);
      user(db, BOB);
      const uri = (did: string, rkey: string) => `at://${did}/${LOVE}/${rkey}`;
      insert(db, 'loves', love(uri(ALICE, 'l1'), ALICE));
      insert(db, 'loves', love(uri(ALICE, 'l2'), ALICE, { track: 'Bachelorette', track_key: 'bachelorette' }));
      insert(db, 'loves', love(uri(BOB, 'l1'), BOB));
      let orphanLove = '';
      try {
        insert(db, 'loves', love(uri('did:plc:nobody', 'l1'), 'did:plc:nobody'));
      } catch (e) {
        orphanLove = String((e as Error).message);
      }

      insert(db, 'linked_accounts', link('la'));
      insert(db, 'linked_accounts', link('lb', { service: 'listenbrainz' }));
      insert(db, 'forward_outbox', forward('fa1', 'la'));
      insert(db, 'forward_outbox', forward('fa2', 'la', { kind: 'love', state: 'held' }));
      insert(db, 'forward_outbox', forward('fb1', 'lb'));
      let orphanForward = '';
      try {
        insert(db, 'forward_outbox', forward('fx', 'no-such-link'));
      } catch (e) {
        orphanForward = String((e as Error).message);
      }
      const before = { loves: count(db, 'loves'), forwards: count(db, 'forward_outbox') };

      const usersDeleted = db.all('DELETE FROM users WHERE did = ? RETURNING did', ALICE);
      const linksDeleted = db.all("DELETE FROM linked_accounts WHERE id = 'la' RETURNING id");
      return {
        orphanLove,
        orphanForward,
        before,
        usersDeleted,
        linksDeleted,
        loves: db.all('SELECT uri, did FROM loves ORDER BY uri'),
        forwards: db.all('SELECT id, link_id FROM forward_outbox ORDER BY id'),
        links: db.all('SELECT id FROM linked_accounts ORDER BY id'),
      };
    });

    expect(r.orphanLove).toMatch(/FOREIGN KEY constraint failed/);
    expect(r.orphanForward).toMatch(/FOREIGN KEY constraint failed/);
    expect(r.before).toEqual({ loves: 3, forwards: 3 });
    expect(r.usersDeleted).toEqual([{ did: ALICE }]);
    expect(r.linksDeleted).toEqual([{ id: 'la' }]);
    expect(r.loves).toEqual([{ uri: `at://${BOB}/${LOVE}/l1`, did: BOB }]);
    expect(r.forwards).toEqual([{ id: 'fb1', link_id: 'lb' }]);
    expect(r.links).toEqual([{ id: 'lb' }]);
  });

  it('a v1 database seeded with the read-model fixture migrates to v2 with every v1 row byte-identical and the new scrobbles columns NULL', async () => {
    const name = 'schema-v2-upgrade';
    expect(await resetToV1(name)).toEqual({ status: 'ready', version: 1 });
    // read_models.json through verify → apply into the version-1 schema.
    const f = await readFixture(name);
    expect(f.outcomes.length).toBeGreaterThan(0);

    const before = await inDb(name, (db) => {
      const tables = tableNames(db);
      const columns = Object.fromEntries(tables.map((t) => [t, columnsOf(db, t)]));
      return {
        tables,
        columns,
        rows: Object.fromEntries(tables.map((t) => [t, quotedRows(db, t, columns[t] ?? [])])),
        ledger: db.all('SELECT version FROM schema_migrations ORDER BY version'),
      };
    });
    expect(before.ledger).toEqual([{ version: 1 }]);
    expect(before.tables).not.toContain('accounts');
    expect(before.columns.scrobbles).not.toContain('album_artist');
    // The fixture really populated the v1 tables.
    const expectedScrobbles = fixture.scrobbles.filter((s) => s.rkey !== 'r08').length;
    expect(before.rows.scrobbles).toHaveLength(expectedScrobbles);
    expect(before.rows.users).toHaveLength(3);
    expect(before.rows.follows).toHaveLength(fixture.follows.length);
    expect(before.rows.record_state?.length).toBeGreaterThan(expectedScrobbles);

    expect(await migrateToLatest(name)).toEqual({ status: 'ready', version: SCHEMA_VERSION });

    const after = await inDb(name, (db) => ({
      rows: Object.fromEntries(before.tables.map((t) => [t, quotedRows(db, t, before.columns[t] ?? [])])),
      newColumns: db.all(`SELECT uri, ${NEW_SCROBBLE_COLUMNS.join(', ')} FROM scrobbles ORDER BY uri`),
      ledger: db.all('SELECT version, name FROM schema_migrations ORDER BY version'),
      compat: db.all('SELECT * FROM schema_compat'),
      newTablesEmpty: Object.keys(NEW_TABLES)
        .filter((t) => t !== 'schema_compat')
        .filter((t) => count(db, t) !== 0),
    }));
    // Every v1 row of every v1 table, column for column, as exact SQL
    // literals; the ledger only gained migration 2's row after its v1 row.
    const { schema_migrations: ledgerAfter, ...dataAfter } = after.rows;
    const { schema_migrations: ledgerBefore, ...dataBefore } = before.rows;
    expect(dataAfter).toEqual(dataBefore);
    expect(Object.keys(dataBefore)).toHaveLength(before.tables.length - 1);
    expect(ledgerBefore).toEqual(["1|'initial_workers_schema'"]);
    expect(ledgerAfter).toEqual(["1|'initial_workers_schema'", "2|'node_schema'"]);
    // The new scrobble columns exist and are NULL on every migrated row.
    expect(after.newColumns).toHaveLength(expectedScrobbles);
    for (const row of after.newColumns as Array<Record<string, unknown>>) {
      for (const c of NEW_SCROBBLE_COLUMNS) expect([row.uri, c, row[c]]).toEqual([row.uri, c, null]);
    }
    expect(after.ledger).toEqual([
      { version: 1, name: 'initial_workers_schema' },
      { version: 2, name: 'node_schema' },
    ]);
    expect(after.compat).toEqual([{ singleton: 1, min_compatible_version: 2 }]);
    expect(after.newTablesEmpty).toEqual([]);

    // The production history module still reads the migrated rows.
    const page = await f.index.history({ did: fixture.users.Alice.did, limit: 50 });
    expect(page.rows.map((r) => r.rkey)).toEqual(fixture.expected.aliceHistory);
  });

  it('EXPLAIN QUERY PLAN for loves by owner, due operations, due forward rows and import items by job uses the new indexes', async () => {
    const plans = await inDb('schema-v2-plans', (db) => {
      user(db, ALICE);
      for (let i = 0; i < 5; i++) {
        insert(
          db,
          'loves',
          love(`at://${ALICE}/${LOVE}/l${i}`, ALICE, { created_at: `2026-01-1${i}T12:00:00.000000000Z` }),
        );
        insert(db, 'operations', op(`o${i}`, { due_at: T0 + i, priority: i % 2 }));
      }
      insert(db, 'linked_accounts', link('l1'));
      insert(db, 'forward_outbox', forward('f1', 'l1'));
      insert(db, 'import_jobs', importJob('j1'));
      insert(db, 'import_items', {
        job_id: 'j1',
        seq: 0,
        dedupe_key: 'k0',
        listened_at: TS,
        record_json: '{}',
      });
      return {
        lovesByOwner: plan(
          db,
          'loves-by-owner',
          'SELECT uri, artist, track, created_at FROM loves WHERE did = ? ORDER BY created_at DESC, uri DESC LIMIT 50',
          ALICE,
        ),
        lovedTrack: plan(
          db,
          'loved-track',
          'SELECT uri FROM loves WHERE did = ? AND artist_key = ? AND track_key = ?',
          ALICE,
          'björk',
          'jóga',
        ),
        dueOperations: plan(
          db,
          'due-operations',
          "SELECT id FROM operations WHERE state = 'queued' AND due_at <= ? ORDER BY priority, due_at LIMIT 50",
          T0,
        ),
        dueForwards: plan(
          db,
          'due-forwards',
          "SELECT id FROM forward_outbox WHERE state = 'queued' AND due_at <= ? ORDER BY due_at LIMIT 50",
          T0,
        ),
        importItems: plan(
          db,
          'import-items',
          "SELECT seq, record_json FROM import_items WHERE job_id = ? AND state = 'staged' ORDER BY seq LIMIT 1000",
          'j1',
        ),
        // The partial msid index serves an msid lookup (§8.4).
        listensByMsid: plan(
          db,
          'listens-by-msid',
          'SELECT uri FROM scrobbles WHERE did = ? AND recording_msid = ? ORDER BY listened_at DESC',
          ALICE,
          '6a6f6761-0000-5000-8000-000000000000',
        ),
        // Control: the same owner query on a column no index leads with scans the table.
        control: plan(db, 'control', 'SELECT uri FROM loves WHERE cid = ? ORDER BY created_at DESC', 'bafylove'),
      };
    });

    expect(plans.lovesByOwner).toEqual(['SEARCH loves USING INDEX loves_owner_time (did=?)']);
    expect(plans.lovedTrack).toEqual([
      'SEARCH loves USING INDEX loves_owner_track (did=? AND artist_key=? AND track_key=?)',
    ]);
    expect(plans.dueOperations).toEqual(['SEARCH operations USING INDEX operations_due (state=?)']);
    expect(plans.dueForwards).toEqual(['SEARCH forward_outbox USING INDEX forward_outbox_due (state=? AND due_at<?)']);
    expect(plans.importItems).toEqual([
      'SEARCH import_items USING INDEX import_items_job_state (job_id=? AND state=?)',
    ]);
    expect(plans.listensByMsid).toEqual(['SEARCH scrobbles USING INDEX scrobbles_msid (did=? AND recording_msid=?)']);
    expect(plans.control.join(' | ')).toMatch(/SCAN loves/);
    expect(plans.control.join(' | ')).toMatch(/TEMP B-TREE/);
  });

  it('schema_compat holds one row with min_compatible_version 2', async () => {
    expect(MIN_COMPATIBLE_VERSION).toBe(2);
    const fresh = await inDb('schema-v2-compat', (db) => ({
      rows: db.all('SELECT * FROM schema_compat'),
      columns: columnsOf(db, 'schema_compat'),
    }));
    expect(fresh).toEqual({
      rows: [{ singleton: 1, min_compatible_version: 2 }],
      columns: ['singleton', 'min_compatible_version'],
    });

    // Re-running migrate does not add a row; a second row and a floor below
    // 1 are both refused, and the one row is unchanged.
    expect(await migrateToLatest('schema-v2-compat')).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    const rerun = await inDb('schema-v2-compat', (db) => {
      const attempt = (sql: string) => {
        try {
          db.run(sql);
          return 'accepted';
        } catch (e) {
          return String((e as Error).message);
        }
      };
      return {
        secondRow: attempt('INSERT INTO schema_compat(singleton, min_compatible_version) VALUES (2, 3)'),
        duplicate: attempt('INSERT INTO schema_compat(singleton, min_compatible_version) VALUES (1, 3)'),
        belowOne: attempt('UPDATE schema_compat SET min_compatible_version = 0'),
        rows: db.all('SELECT * FROM schema_compat'),
      };
    });
    expect(rerun.secondRow).toMatch(CHECK_FAILED);
    expect(rerun.duplicate).toMatch(/UNIQUE constraint failed: schema_compat.singleton/);
    expect(rerun.belowOne).toMatch(CHECK_FAILED);
    expect(rerun.rows).toEqual([{ singleton: 1, min_compatible_version: 2 }]);

    // A database upgraded from version 1 gets the same single row.
    const upgraded = 'schema-v2-compat-upgrade';
    expect(await resetToV1(upgraded)).toEqual({ status: 'ready', version: 1 });
    expect(await inDb(upgraded, (db) => tableNames(db).includes('schema_compat'))).toBe(false);
    expect(await migrateToLatest(upgraded)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    expect(await inDb(upgraded, (db) => db.all('SELECT * FROM schema_compat'))).toEqual([
      { singleton: 1, min_compatible_version: 2 },
    ]);
  });

  it('every migration after 2 contains only CREATE TABLE, CREATE INDEX and ALTER TABLE ADD COLUMN statements', () => {
    const later = MIGRATIONS.filter((m) => m.version > 2);
    expect(later.flatMap(nonAdditiveStatements)).toEqual([]);

    // The checker is not vacuous: on migration 2 it flags exactly the one
    // statement that is not additive (the schema_compat seed row) ...
    const migration2 = MIGRATIONS.find((m) => m.version === 2);
    expect(migration2).toBeDefined();
    expect(nonAdditiveStatements(migration2 as Migration)).toEqual([
      `INSERT INTO schema_compat(singleton,min_compatible_version) VALUES(1,${MIN_COMPATIBLE_VERSION})`,
    ]);
    // ... it accepts every additive form ...
    const additive = [
      'CREATE TABLE extra (x INTEGER)',
      'CREATE TABLE IF NOT EXISTS extra (x INTEGER)',
      '  create   index extra_x on extra(x)',
      'CREATE INDEX IF NOT EXISTS extra_x ON extra(x) WHERE x IS NOT NULL',
      'ALTER TABLE scrobbles ADD COLUMN mood TEXT',
      'ALTER TABLE scrobbles ADD mood TEXT',
      `CREATE TABLE extra2 (
        y TEXT NOT NULL DEFAULT ''
      )`,
    ];
    expect(nonAdditiveStatements({ version: 3, name: 'additive', statements: additive })).toEqual([]);
    // ... and rejects everything else.
    const nonAdditive = [
      'DROP TABLE scrobbles',
      'DROP INDEX scrobbles_stats',
      'ALTER TABLE scrobbles RENAME TO plays',
      'ALTER TABLE scrobbles RENAME COLUMN artist TO artist_name',
      'ALTER TABLE scrobbles DROP COLUMN album',
      'CREATE UNIQUE INDEX scrobbles_uniq ON scrobbles(did, rkey)',
      'CREATE TRIGGER t AFTER INSERT ON scrobbles BEGIN SELECT 1; END',
      'CREATE VIEW v AS SELECT 1',
      'CREATE TEMP TABLE t (x)',
      'INSERT INTO timers(name, due_at) VALUES (1, 1)',
      'UPDATE schema_compat SET min_compatible_version = 3',
      'DELETE FROM hints',
      'CREATE TABLE a (x); DROP TABLE scrobbles',
      'PRAGMA foreign_keys = OFF',
    ];
    expect(nonAdditiveStatements({ version: 3, name: 'bad', statements: nonAdditive })).toEqual(nonAdditive);
  });

  it('every table in TABLES has exactly one TABLE_CLASS entry and the test names any table that has none', async () => {
    // Keys of TABLE_CLASS are exactly TABLES, each with one of the two classes.
    expect(Object.keys(TABLE_CLASS).sort()).toEqual([...TABLES].sort());
    expect(new Set(TABLES).size).toBe(TABLES.length);
    expect(Object.values(TABLE_CLASS).filter((c) => c !== 'derived' && c !== 'non-derived')).toEqual([]);
    expectEveryTableClassified([...TABLES]);

    // The classification of ADR 0005 §6.4 / §14.5, hardcoded.
    const derived = [
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
      'loves',
      'range_stats_cache',
    ];
    const entries = Object.entries(TABLE_CLASS);
    expect(
      entries
        .filter(([, c]) => c === 'derived')
        .map(([t]) => t)
        .sort(),
    ).toEqual([...derived].sort());
    expect(
      entries
        .filter(([, c]) => c === 'non-derived')
        .map(([t]) => t)
        .sort(),
    ).toEqual(TABLES.filter((t) => !derived.includes(t)).sort());
    for (const t of ['accounts', 'web_sessions', 'oauth_sessions', 'lb_tokens', 'forward_outbox', 'counters']) {
      expect([t, TABLE_CLASS[t as keyof typeof TABLE_CLASS]]).toEqual([t, 'non-derived']);
    }

    // Every table of a migrated database is classified.
    const live = await inDb('schema-v2-classes', (db) => tableNames(db));
    expectEveryTableClassified(live);

    // A table without a class is named by the failure.
    const withExtra = await inDb('schema-v2-classes-extra', (db) => {
      db.run('CREATE TABLE extra_probe (x INTEGER)');
      return tableNames(db);
    });
    expect(unclassified(withExtra)).toEqual(['extra_probe']);
    expect(() => expectEveryTableClassified(withExtra)).toThrow(/tables without a TABLE_CLASS entry: extra_probe/);
  });

  it('ignored_listens accepts reasons artist_invalid and track_invalid only and is listed newest first by its (did, created_at_ms DESC) index', async () => {
    const r = await inDb('schema-v2-ignored', (db) => {
      insert(db, 'ignored_listens', ignored(ALICE, T0 + 10, { reason: 'artist_invalid' }));
      insert(db, 'ignored_listens', ignored(ALICE, T0 + 30, { reason: 'track_invalid' }));
      insert(db, 'ignored_listens', ignored(BOB, T0 + 40, { reason: 'track_invalid' }));
      // 128 scalars of a two-byte character: within the preview bound.
      insert(db, 'ignored_listens', ignored(ALICE, T0 + 20, { artist_preview: 'é'.repeat(128) }));
      const refused = [
        ignored(ALICE, T0, { reason: 'album_invalid' }),
        ignored(ALICE, T0, { reason: 'too_new' }),
        ignored(ALICE, T0, { source: 'lastfm' }),
        ignored(ALICE, T0, { artist_preview: 'é'.repeat(129) }),
        ignored(ALICE, T0, { listened_at: '2026-01-15T12:00:00Z' }),
      ].map((row) => {
        try {
          insert(db, 'ignored_listens', row);
          return 'accepted';
        } catch (e) {
          return String((e as Error).message);
        }
      });
      const sql = 'SELECT id, reason, created_at_ms FROM ignored_listens WHERE did = ? ORDER BY created_at_ms DESC';
      return {
        refused,
        listed: db.all(sql, ALICE),
        plan: plan(db, 'ignored-listens', sql, ALICE),
        total: count(db, 'ignored_listens'),
      };
    });

    expect(r.refused).toHaveLength(5);
    for (const message of r.refused) expect(message).toMatch(CHECK_FAILED);
    expect(r.refused[0]).toContain('reason IN (');
    expect(r.total).toBe(4);
    // SQLite assigned ids in insertion order; the list is newest first.
    expect(r.listed).toEqual([
      { id: 2, reason: 'track_invalid', created_at_ms: T0 + 30 },
      { id: 4, reason: 'artist_invalid', created_at_ms: T0 + 20 },
      { id: 1, reason: 'artist_invalid', created_at_ms: T0 + 10 },
    ]);
    expect(r.plan).toEqual(['SEARCH ignored_listens USING INDEX ignored_listens_did_time (did=?)']);
  });
});

// ---------------------------------------------------------------------------
// Static checks

/**
 * ADR 0005 §3.2: the statements of `m` that are not additive. Additive means
 * exactly one statement that is CREATE TABLE, CREATE INDEX (not UNIQUE, which
 * can fail on existing rows) or ALTER TABLE ... ADD [COLUMN].
 */
function nonAdditiveStatements(m: Migration): string[] {
  const allowed = [
    /^CREATE TABLE (IF NOT EXISTS )?\w+ ?\(/i,
    /^CREATE INDEX (IF NOT EXISTS )?\w+ ON \w+ ?\(/i,
    /^ALTER TABLE \w+ ADD (COLUMN )?\w+ /i,
  ];
  return m.statements.filter((statement) => {
    const s = statement.replace(/\s+/g, ' ').trim();
    const body = s.endsWith(';') ? s.slice(0, -1) : s;
    // More than one statement in one string is never additive.
    if (body.includes(';')) return true;
    return !allowed.some((re) => re.test(body));
  });
}

function unclassified(tables: readonly string[]): string[] {
  return tables.filter((t) => !Object.hasOwn(TABLE_CLASS, t));
}

function expectEveryTableClassified(tables: readonly string[]): void {
  const missing = unclassified(tables);
  expect(missing, `tables without a TABLE_CLASS entry: ${missing.join(', ')}`).toEqual([]);
}
