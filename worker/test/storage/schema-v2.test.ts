// N1-10: migration 2, the complete Node schema (ADR 0005 §3.2, §6.4, §8.3,
// §14.5), on node:sqlite through the production adapter: each name is a
// migrated file of this test file's IndexSet (worker/test/node/support/
// with-index.ts, N4-04). Schema introspection (`pragma_table_info` and the
// other schema pragma functions, which the adapter's authorizer denies like
// every PRAGMA) is answered by `schemaAll` from a schema-only replica.
//
// Expectations are hardcoded from ADR 0005 §6.4, not derived from schema.ts.
// The column lists are typed against worker/src/app/rows.ts, so a row type
// that drifts from the table fails typecheck and the table that drifts from
// the ADR fails here.

import { createFixtureKit, FIXTURE_USERS, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterAll, describe, expect, it } from 'vitest';
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
  VerifiedMembershipRow,
  WebSessionRow,
} from '../../src/app/rows';
import type { Db, SqlParam } from '../../src/do/db';
import { migrate } from '../../src/do/migrate';
import { history } from '../../src/do/read/history';
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
import { type ApplyResult, applyRecordProof } from '../../src/do/write/apply-record';
import { closeFileIndexes, fileIndexes, nodeIndex, schemaAll } from '../node/support/with-index';
import { OPTS, seedUser } from '../write/support';

afterAll(() => closeFileIndexes());

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
  live_record_evidence: {
    columns: [
      'uri',
      'did',
      'collection',
      'rkey',
      'up_rev',
      'up_action',
      'up_cid',
      'del_rev',
      'conflict_rev',
      'received_ms',
      'expires_at_ms',
    ],
    pk: ['uri'],
  },
  live_acceptance_candidates: {
    columns: ['uri', 'identity_key', 'kind', 'member_uri', 'cid', 'created_at_ms', 'expires_at_ms'],
    pk: ['uri', 'identity_key'],
  },
  live_pending_removals: {
    columns: [
      'uri',
      'member_uri',
      'removed_cid',
      'kind',
      'window_lo',
      'window_hi',
      'replaced_by_cid',
      'identity_key',
      'listened_at',
      'artist_key',
      'track_key',
      'artist',
      'track',
      'recording_mbid',
      'love_source_service',
      'love_import_sources',
      'authorized_rev',
      'created_at_ms',
      'expires_at_ms',
      'conflict_invalidated',
      'conflicted_auth_rev',
    ],
    pk: ['uri', 'member_uri', 'removed_cid', 'window_lo', 'window_hi', 'replaced_by_cid'],
  },
  live_pending_removal_events: {
    columns: [
      'uri',
      'rev',
      'action',
      'cid',
      'conflicted',
      'cursor_window_hi',
      'cursor_window_lo',
      'cursor_replaced_by_cid',
      'cursor_kind',
      'cursor_member_uri',
      'cursor_removed_cid',
      'scan_complete',
      'created_at_ms',
      'expires_at_ms',
      'cleanup_due_ms',
      'cleanup_cursor_window_hi',
      'cleanup_cursor_window_lo',
      'cleanup_cursor_replaced_by_cid',
      'cleanup_cursor_kind',
      'cleanup_cursor_member_uri',
      'cleanup_cursor_removed_cid',
      'cleanup_scan_complete',
      'cleanup_has_match',
    ],
    pk: ['uri', 'rev'],
  },
  live_pending_removal_reconcile: {
    columns: ['uri', 'window_lo', 'window_hi', 'replaced_by_cid', 'cursor_rev', 'next_due_ms', 'created_at_ms'],
    pk: ['uri', 'window_lo', 'window_hi', 'replaced_by_cid'],
  },
  listenbrainz_deletes: {
    columns: [
      'id',
      'event_key',
      'link_id',
      'generation',
      'did',
      'identity_key',
      'listened_at',
      'artist_key',
      'track_key',
      'artist',
      'track',
      'source_path',
      'state',
      'attempts',
      'due_at',
      'deadline_at',
      'target_msid',
      'target_listened_at',
      'last_error',
      'created_at_ms',
      'updated_at_ms',
      'lookup_min_ts',
      'lookup_candidates',
      'lookup_last_earliest',
      'lookup_last_max',
      'authorization_uri',
      'authorization_rev',
    ],
    pk: ['id'],
    unique: [['link_id', 'generation', 'event_key']],
  },
  linked_pull_state: {
    columns: [
      'link_id',
      'generation',
      'source_service',
      'source_account',
      'listen_watermark_ms',
      'love_boundary_ms',
      'love_boundary_key',
      'page_kind',
      'page_cursor',
      'page_started_at_ms',
      'hold_reason',
      'retry_at_ms',
      'failures',
      'updated_at_ms',
      'love_cursor',
      'poll_next_at_ms',
      'listen_round_upper_ms',
      'listen_round_floor_ms',
      'listen_round_page',
      'love_round_upper_ms',
      'love_round_page',
      'love_round_floor_ms',
      'poll_phase',
      'skipped_count',
      'listen_floor_at_ms',
      'love_floor_at_ms',
      'listen_round_saturated',
      'love_round_total_count',
      'love_round_first_key',
      'love_round_newest_ms',
    ],
    pk: ['link_id', 'generation'],
  },
  linked_pull_items: {
    columns: [
      'link_id',
      'generation',
      'item_key',
      'kind',
      'source_service',
      'source_account',
      'listened_at_ms',
      'love_key',
      'recording_mbid',
      'payload_json',
      'payload_bytes',
      'staged_at_ms',
    ],
    pk: ['link_id', 'generation', 'item_key'],
  },
  linked_pull_tombstones: {
    columns: [
      'did',
      'kind',
      'identity_key',
      'listen_second',
      'artist_key',
      'track_key',
      'love_key',
      'recording_mbid',
      'created_at_ms',
    ],
    pk: ['did', 'kind', 'identity_key'],
  },
  linked_love_intents: {
    columns: ['did', 'love_key', 'intent', 'operation_id', 'updated_at_ms', 'recording_mbid'],
    pk: ['did', 'love_key'],
  },
  linked_pull_receipt_seed: {
    columns: ['singleton', 'last_rowid', 'member_offset', 'done', 'updated_at_ms'],
    pk: ['singleton'],
  },
  linked_pull_projection_scan: {
    columns: ['did', 'rowid_cursor', 'updated_at_ms'],
    pk: ['did'],
  },
  linked_pull_love_admissions: {
    columns: [
      'did',
      'link_id',
      'generation',
      'operation_id',
      'love_key',
      'recording_mbid',
      'source_service',
      'source_account',
      'state',
      'uri',
      'incarnation_key',
      'updated_at_ms',
    ],
    pk: ['did', 'operation_id'],
  },
  forward_admissions: {
    columns: ['did', 'identity_key', 'path', 'source_service', 'created_at_ms', 'admission_seq'],
    pk: ['did', 'identity_key'],
    unique: [['admission_seq']],
  },
  forward_admission_clock: {
    columns: ['singleton', 'next_seq'],
    pk: ['singleton'],
  },
  love_incarnations: {
    columns: ['uri', 'incarnation_key', 'state', 'path', 'source_service', 'updated_at_ms'],
    pk: ['uri'],
  },
  love_delete_bridges: {
    columns: ['did', 'uri', 'incarnation_key', 'expected_cid', 'operation_id', 'state', 'created_at_ms', 'delete_rev'],
    pk: ['did', 'uri', 'incarnation_key', 'operation_id'],
  },
  love_import_bridges: {
    columns: ['did', 'operation_id', 'uri', 'incarnation_key', 'source_service', 'state', 'created_at_ms'],
    pk: ['did', 'operation_id'],
  },
  forward_storage_scan: {
    columns: ['table_key', 'cursor_json', 'rows_seen', 'logical_bytes_seen', 'complete'],
    pk: ['table_key'],
  },
  batch_delete_children: {
    columns: ['parent_operation_id', 'child_operation_id'],
    pk: ['parent_operation_id', 'child_operation_id'],
  },
  batch_delete_listens: {
    columns: ['operation_id', 'listen_id'],
    pk: ['operation_id', 'listen_id'],
  },
  listen_removal_cids: {
    columns: ['operation_id', 'cid'],
    pk: ['operation_id', 'cid'],
  },
  verified_membership: {
    columns: cols<VerifiedMembershipRow>({
      record_uri: true,
      listen_id: true,
      did: true,
      state: true,
      revision: true,
      cid: true,
      reason: true,
      last_absent_revision: true,
    }),
    pk: ['record_uri', 'listen_id'],
  },
  mb_pacing: { columns: ['singleton', 'available_at_ms'], pk: ['singleton'] },
  mb_seed_state: { columns: ['singleton', 'cursor_uri', 'complete'], pk: ['singleton'] },
  mb_love_revive_jobs: {
    columns: [
      'artist_key',
      'track_key',
      'album_key',
      'recording_mbid',
      'matched_at_ms',
      'created_at_ms',
      'cursor_link_id',
    ],
    pk: ['artist_key', 'track_key', 'album_key'],
  },
  mb_love_revival_state: {
    columns: ['singleton', 'cursor_rowid', 'complete'],
    pk: ['singleton'],
  },
  mb_forward_love_current: {
    columns: ['link_id', 'love_artist_key', 'love_track_key', 'forward_rowid'],
    pk: ['link_id', 'love_artist_key', 'love_track_key'],
  },
  mb_cover_art: {
    columns: [
      'release_mbid',
      'mime_type',
      'image_bytes',
      'byte_size',
      'created_at_ms',
      'fetched_at_ms',
      'last_access_ms',
    ],
    pk: ['release_mbid'],
  },
  mb_cover_art_jobs: {
    columns: ['release_mbid', 'release_group_mbid', 'status', 'attempts', 'next_due_ms', 'created_at_ms'],
    pk: ['release_mbid'],
  },
  mb_cover_art_usage: { columns: ['singleton', 'used_bytes'], pk: ['singleton'] },
  mb_tracks: {
    columns: [
      'artist_key',
      'track_key',
      'album_key',
      'status',
      'priority',
      'attempts',
      'next_attempt_ms',
      'last_attempt_ms',
      'submitted_recording_mbid',
      'matched_by',
      'score',
      'recording_mbid',
      'title',
      'artist_credit',
      'artist_mbids',
      'release_mbid',
      'release_title',
      'release_group_mbid',
      'duration_ms',
      'isrcs',
      'first_release_date',
      'synced_at_ms',
      'created_at_ms',
    ],
    pk: ['artist_key', 'track_key', 'album_key'],
  },
  batch_entry_items: {
    columns: ['operation_id', 'entry_id', 'job_id', 'seq', 'removal_operation_id', 'removed_at_ms'],
    pk: ['operation_id', 'entry_id', 'job_id', 'seq'],
  },
  listen_removals: {
    columns: cols<{
      did: true;
      record_uri: true;
      listen_id: true;
      created_at_ms: true;
      operation_id: true;
      removed_cid: true;
    }>({
      did: true,
      record_uri: true,
      listen_id: true,
      created_at_ms: true,
      operation_id: true,
      removed_cid: true,
    }),
    pk: ['did', 'record_uri', 'listen_id'],
  },
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
      follow_proof_json: true,
      send_started_at_ms: true,
      send_state: true,
      legacy_absent_at_ms: true,
      removal_fence_rev: true,
      removal_head_rev: true,
      removal_commit_rev: true,
      removal_done_rev: true,
      removal_done_basis: true,
      removal_reached: true,
      removal_reached_at_ms: true,
      removal_send_state: true,
      removal_send_json: true,
      removal_send_at_ms: true,
      removal_superseded_by: true,
    }),
    pk: ['id'],
    unique: [['did', 'idempotency_key']],
  },
  operation_deps: { columns: cols<OperationDepRow>({ op_id: true, pred_id: true }), pk: ['op_id', 'pred_id'] },
  listen_keys: {
    columns: cols<ListenKeyRow>({
      did: true,
      dedupe_key: true,
      operation_id: true,
      source: true,
      created_at_ms: true,
      listen_second: true,
    }),
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
      updated_at_ms: true,
      track_number: true,
      release_mbid: true,
      release_group_mbid: true,
      artist_mbids: true,
      isrc: true,
      submission_client_version: true,
      music_service: true,
      media_player: true,
      scrobbled_at_ms: true,
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
      revision: true,
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
      generation: true,
      generation_start_seq: true,
      last_success_ms: true,
      last_failure_ms: true,
      consecutive_failures: true,
      backfill_state: true,
      backfill_cursor: true,
      backfill_total: true,
      backfill_done: true,
      pull_enabled: true,
      pull_watermark_ms: true,
      last_pull_ms: true,
      sync_remote_user: true,
      backfill_failures: true,
      backfill_next_attempt_ms: true,
      backfill_run_revision: true,
      backfill_discovery_cursor: true,
      backfill_discovery_done: true,
      backfill_last_serviced_seq: true,
      backfill_last_error: true,
    }),
    pk: ['id'],
    unique: [['did', 'service']],
  },
  link_backfill_items: {
    columns: ['link_id', 'generation', 'run_revision', 'ordinal', 'identity_key', 'uri', 'cid', 'kind', 'event_at'],
    pk: ['link_id', 'generation', 'run_revision', 'identity_key'],
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
      love_artist_key: true,
      love_track_key: true,
      generation: true,
      priority: true,
      love_lane: true,
      authorization_uri: true,
      authorization_rev: true,
      authorization_conflicted: true,
    }),
    pk: ['id'],
    unique: [['link_id', 'kind', 'dedupe_key']],
  },
  forward_love_lanes: {
    columns: ['link_id', 'generation', 'love_artist_key', 'love_track_key', 'priority', 'due_at', 'head_created_at_ms'],
    pk: ['link_id', 'generation', 'love_artist_key', 'love_track_key'],
  },
  forward_love_recording_history: {
    columns: ['did', 'artist_key', 'track_key', 'operation_rowid', 'recording_mbid'],
    pk: ['did', 'artist_key', 'track_key', 'operation_rowid'],
  },
  forward_love_recording_history_state: {
    columns: ['singleton', 'cursor_rowid', 'complete'],
    pk: ['singleton'],
  },
  forward_love_recording_targets: {
    columns: [
      'target_id',
      'forward_rowid',
      'link_id',
      'generation',
      'artist_key',
      'track_key',
      'created_at_ms',
      'recording_mbid',
    ],
    pk: ['target_id'],
    unique: [['forward_rowid']],
  },
  forward_love_recording_targets_state: {
    columns: ['singleton', 'cursor_rowid', 'complete'],
    pk: ['singleton'],
  },
  forward_love_operation_targets: {
    columns: ['target_id', 'operation_rowid', 'did', 'artist_key', 'track_key', 'created_at_ms', 'recording_mbid'],
    pk: ['target_id'],
    unique: [['operation_rowid']],
  },
  forward_love_operation_targets_state: {
    columns: ['singleton', 'cursor_rowid', 'complete'],
    pk: ['singleton'],
  },
  forward_unlove_lookup_progress: {
    columns: ['unlove_rowid', 'cursor_created_at_ms', 'cursor_operation_rowid'],
    pk: ['unlove_rowid'],
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
      removal_operation_id: true,
      removed_at_ms: true,
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
  record_uri: true,
  listen_id: true,
});

/** New named indexes: table, unique, partial, [column, desc] in key order. */
const NEW_INDEXES: Record<string, [string, number, number, Array<[string, number]>]> = {
  forward_outbox_authorization: [
    'forward_outbox',
    0,
    0,
    [['authorization_uri', 0], ['authorization_rev', 0], ['state', 0]],
  ],
  live_pending_removal_events_uri_ready_order: [
    'live_pending_removal_events',
    0,
    0,
    [['uri', 0], ['scan_complete', 0], ['created_at_ms', 0], ['rev', 0]],
  ],
  live_record_evidence_expiry: ['live_record_evidence', 0, 0, [['expires_at_ms', 0]]],
  live_acceptance_candidates_expiry: ['live_acceptance_candidates', 0, 0, [['expires_at_ms', 0]]],
  live_pending_removals_ready: [
    'live_pending_removals',
    0,
    0,
    [
      ['authorized_rev', 0],
      ['created_at_ms', 0],
      ['uri', 0],
      ['window_hi', 0],
      ['expires_at_ms', 0],
    ],
  ],
  live_pending_removals_uri_ready: [
    'live_pending_removals',
    0,
    0,
    [
      ['uri', 0],
      ['authorized_rev', 0],
      ['created_at_ms', 0],
      ['window_hi', 0],
      ['expires_at_ms', 0],
    ],
  ],
  live_pending_removals_group: [
    'live_pending_removals',
    0,
    0,
    [
      ['uri', 0],
      ['kind', 0],
      ['window_lo', 0],
      ['window_hi', 0],
      ['replaced_by_cid', 0],
      ['authorized_rev', 0],
      ['expires_at_ms', 0],
      ['member_uri', 0],
    ],
  ],
  live_pending_removals_authorize: [
    'live_pending_removals',
    0,
    0,
    [
      ['uri', 0],
      ['window_hi', 0],
      ['window_lo', 1],
      ['replaced_by_cid', 0],
      ['authorized_rev', 0],
      ['expires_at_ms', 0],
    ],
  ],
  live_pending_removals_expiry: [
    'live_pending_removals',
    0,
    0,
    [
      ['expires_at_ms', 0],
      ['uri', 0],
      ['window_hi', 0],
    ],
  ],
  live_pending_removals_page: [
    'live_pending_removals',
    0,
    0,
    [
      ['uri', 0],
      ['window_hi', 0],
      ['window_lo', 0],
      ['replaced_by_cid', 0],
      ['kind', 0],
      ['member_uri', 0],
      ['removed_cid', 0],
    ],
  ],
  loves_newer_by_track: [
    'loves',
    0,
    0,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['revision', 0],
    ],
  ],
  live_pending_removal_events_expiry: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['expires_at_ms', 0],
      ['uri', 0],
      ['rev', 0],
    ],
  ],
  live_pending_removal_events_by_uri: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['uri', 0],
      ['rev', 0],
      ['expires_at_ms', 0],
    ],
  ],
  live_pending_removal_events_scan: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['scan_complete', 0],
      ['expires_at_ms', 0],
      ['created_at_ms', 0],
      ['uri', 0],
      ['rev', 0],
    ],
  ],
  live_pending_removal_events_uri_scan: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['uri', 0],
      ['scan_complete', 0],
      ['expires_at_ms', 0],
      ['created_at_ms', 0],
      ['rev', 0],
    ],
  ],
  live_pending_removal_events_ready_v2: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['scan_complete', 0],
      ['created_at_ms', 0],
      ['uri', 0],
      ['rev', 0],
    ],
  ],
  live_pending_removal_events_cleanup: [
    'live_pending_removal_events',
    0,
    0,
    [
      ['cleanup_due_ms', 0],
      ['uri', 0],
      ['rev', 0],
      ['expires_at_ms', 0],
    ],
  ],
  live_pending_removal_reconcile_due: [
    'live_pending_removal_reconcile',
    0,
    0,
    [
      ['next_due_ms', 0],
      ['created_at_ms', 0],
      ['uri', 0],
      ['window_lo', 0],
      ['window_hi', 0],
      ['replaced_by_cid', 0],
    ],
  ],
  forward_love_lanes_due: [
    'forward_love_lanes',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['priority', 0],
      ['due_at', 0],
    ],
  ],
  forward_outbox_love_unkeyed: [
    'forward_outbox',
    0,
    1,
    [
      ['link_id', 0],
      ['generation', 0],
      ['kind', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_outbox_love_unframed: [
    'forward_outbox',
    0,
    1,
    [
      ['link_id', 0],
      ['generation', 0],
      ['kind', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_outbox_kind_due: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['kind', 0],
      ['state', 0],
      ['due_at', 0],
    ],
  ],
  forward_outbox_link_expiry: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['state', 0],
      ['kind', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_outbox_held_expiry: [
    'forward_outbox',
    0,
    0,
    [
      ['state', 0],
      ['updated_at_ms', 0],
    ],
  ],
  listenbrainz_deletes_due: [
    'listenbrainz_deletes',
    0,
    0,
    [
      ['state', 0],
      ['due_at', 0],
    ],
  ],
  listenbrainz_deletes_authorization: [
    'listenbrainz_deletes',
    0,
    0,
    [
      ['authorization_uri', 0],
      ['authorization_rev', 0],
      ['state', 0],
    ],
  ],
  linked_love_intents_mbid: [
    'linked_love_intents',
    0,
    0,
    [
      ['did', 0],
      ['recording_mbid', 0],
      ['updated_at_ms', 0],
    ],
  ],
  linked_pull_items_pending: [
    'linked_pull_items',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['kind', 0],
      ['staged_at_ms', 0],
      ['item_key', 0],
    ],
  ],
  listen_keys_did_second: [
    'listen_keys',
    0,
    1,
    [
      ['did', 0],
      ['listen_second', 0],
    ],
  ],
  linked_pull_tombstones_listen_second: [
    'linked_pull_tombstones',
    0,
    1,
    [
      ['did', 0],
      ['listen_second', 0],
    ],
  ],
  linked_pull_tombstones_love_key: [
    'linked_pull_tombstones',
    0,
    1,
    [
      ['did', 0],
      ['love_key', 0],
      ['recording_mbid', 0],
    ],
  ],
  linked_pull_love_admissions_generation: [
    'linked_pull_love_admissions',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['state', 0],
    ],
  ],
  linked_pull_love_admissions_key: [
    'linked_pull_love_admissions',
    0,
    0,
    [
      ['did', 0],
      ['state', 0],
      ['love_key', 0],
    ],
  ],
  linked_pull_love_admissions_mbid: [
    'linked_pull_love_admissions',
    0,
    1,
    [
      ['did', 0],
      ['state', 0],
      ['recording_mbid', 0],
    ],
  ],
  linked_pull_love_admissions_uri: [
    'linked_pull_love_admissions',
    0,
    1,
    [
      ['did', 0],
      ['uri', 0],
      ['state', 0],
    ],
  ],
  mb_cover_art_lru: [
    'mb_cover_art',
    0,
    0,
    [
      ['last_access_ms', 0],
      ['release_mbid', 0],
    ],
  ],
  mb_cover_art_jobs_due: [
    'mb_cover_art_jobs',
    0,
    0,
    [
      ['status', 0],
      ['next_due_ms', 0],
      ['release_mbid', 0],
    ],
  ],
  mb_forward_love_current_key: [
    'mb_forward_love_current',
    0,
    0,
    [
      ['love_artist_key', 0],
      ['love_track_key', 0],
      ['link_id', 0],
    ],
  ],
  forward_outbox_due_generation: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['state', 0],
      ['due_at', 0],
    ],
  ],
  forward_outbox_order_generation: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['state', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_outbox_love_heads: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['state', 0],
      ['love_artist_key', 0],
      ['love_track_key', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_love_recording_history_latest: [
    'forward_love_recording_history',
    0,
    0,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['operation_rowid', 1],
    ],
  ],
  forward_outbox_love_recording_lookup: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['love_artist_key', 0],
      ['love_track_key', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_love_recording_targets_latest: [
    'forward_love_recording_targets',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['created_at_ms', 1],
      ['forward_rowid', 1],
    ],
  ],
  forward_love_operation_targets_latest: [
    'forward_love_operation_targets',
    0,
    0,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['created_at_ms', 1],
      ['operation_rowid', 1],
    ],
  ],
  linked_accounts_backfill_due: [
    'linked_accounts',
    0,
    0,
    [
      ['backfill_state', 0],
      ['backfill_next_attempt_ms', 0],
      ['created_at_ms', 0],
      ['id', 0],
    ],
  ],
  forward_outbox_priority_due: [
    'forward_outbox',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['priority', 0],
      ['state', 0],
      ['due_at', 0],
      ['created_at_ms', 0],
    ],
  ],
  forward_outbox_history_state: [
    'forward_outbox',
    0,
    0,
    [
      ['priority', 0],
      ['state', 0],
    ],
  ],
  linked_accounts_backfill_fair: [
    'linked_accounts',
    0,
    0,
    [
      ['status', 0],
      ['forward_scrobbles', 0],
      ['backfill_state', 0],
      ['backfill_next_attempt_ms', 0],
      ['backfill_last_serviced_seq', 0],
      ['created_at_ms', 0],
      ['id', 0],
    ],
  ],
  link_backfill_items_pending: [
    'link_backfill_items',
    0,
    0,
    [
      ['link_id', 0],
      ['generation', 0],
      ['run_revision', 0],
      ['ordinal', 0],
    ],
  ],
  love_delete_bridges_pending: [
    'love_delete_bridges',
    0,
    0,
    [
      ['did', 0],
      ['uri', 0],
      ['state', 0],
    ],
  ],
  love_import_bridges_incarnation: [
    'love_import_bridges',
    0,
    0,
    [
      ['did', 0],
      ['uri', 0],
      ['incarnation_key', 0],
      ['state', 0],
    ],
  ],
  mb_love_revive_jobs_due: [
    'mb_love_revive_jobs',
    0,
    0,
    [
      ['matched_at_ms', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['album_key', 0],
    ],
  ],
  mb_tracks_due: [
    'mb_tracks',
    0,
    0,
    [
      ['status', 0],
      ['next_attempt_ms', 0],
      ['priority', 0],
    ],
  ],
  batch_delete_children_child: ['batch_delete_children', 0, 0, [['child_operation_id', 0]]],
  batch_delete_listens_operation: ['batch_delete_listens', 0, 0, [['operation_id', 0]]],
  batch_entry_items_job: [
    'batch_entry_items',
    0,
    0,
    [
      ['job_id', 0],
      ['seq', 0],
    ],
  ],
  operations_scrobble_delete_target: [
    'operations',
    0,
    1,
    [
      ['did', 0],
      ['rkey', 0],
    ],
  ],
  scrobbles_batch_visibility: [
    'scrobbles',
    0,
    1,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['listened_at', 0],
    ],
  ],
  scrobbles_single_visibility: [
    'scrobbles',
    0,
    1,
    [
      ['did', 0],
      ['artist_key', 0],
      ['track_key', 0],
      ['listened_at', 0],
    ],
  ],
  listen_removals_container: ['listen_removals', 0, 0, [['record_uri', 0]]],
  scrobbles_record_uri: ['scrobbles', 0, 0, [['record_uri', 0]]],
  verified_membership_did: ['verified_membership', 0, 0, [['did', 0]]],
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
  operations_record_target: [
    'operations',
    0,
    0,
    [
      ['did', 0],
      ['collection', 0],
      ['rkey', 0],
      ['created_at_ms', 0],
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

/** Foreign keys in the additive schema: [table, from, parent, to, on_delete]. */
const NEW_FOREIGN_KEYS = [
  ['listenbrainz_deletes', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
  ['mb_forward_love_current', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
  ['loves', 'did', 'users', 'did', 'CASCADE'],
  ['link_backfill_items', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
  ['forward_outbox', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
  ['forward_love_lanes', 'link_id', 'linked_accounts', 'id', 'CASCADE'],
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
  return schemaAll<{ name: string }>(db, 'SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map(
    (r) => r.name,
  );
}

function pkOf(db: Db, table: string): string[] {
  return schemaAll<{ name: string }>(db, 'SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', table).map(
    (r) => r.name,
  );
}

function uniqueSets(db: Db, table: string): string[][] {
  return schemaAll<{ name: string }>(
    db,
    "SELECT name FROM pragma_index_list(?) WHERE origin = 'u' ORDER BY name",
    table,
  ).map((ix) =>
    schemaAll<{ name: string }>(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', ix.name).map((c) => c.name),
  );
}

function indexShape(db: Db, table: string, index: string) {
  const [list] = schemaAll<{ unique: number; partial: number }>(
    db,
    'SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?',
    table,
    index,
  );
  const keys = schemaAll<{ name: string; desc: number }>(
    db,
    'SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
    index,
  ).map((c): [string, number] => [c.name, c.desc]);
  return [table, list?.unique, list?.partial, keys];
}

function foreignKeys(db: Db, table: string): string[][] {
  return schemaAll<{ from: string; table: string; to: string; on_delete: string }>(
    db,
    'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)',
    table,
  ).map((f) => [table, f.from, f.table, f.to, f.on_delete]);
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

/** Runs `fn` over the named database of this test file (created and migrated on first use). */
async function inDb<T>(name: string, fn: (db: Db) => T): Promise<T> {
  return fn(fileIndexes().get(name));
}

/** Wipe the named database and apply migration 1 only: a database written by version-1 code. */
async function resetToV1(name: string): Promise<unknown> {
  return migrate(fileIndexes().reset(name), MIGRATIONS.slice(0, 1));
}

async function migrateToLatest(name: string): Promise<unknown> {
  return migrate(fileIndexes().get(name));
}

/**
 * The named database of this test file (latest schema) seeded with
 * tests/fixtures/read_models.json through the real ingestion path, as
 * worker/test/read/scrobble-read-support.ts readFixture does on the harness
 * DO: the fixture is published as signed commits on fake PDSs, the three
 * `users` rows are seeded, and every Jetstream commit event's getRecord CAR
 * goes through the production verifier `verifyRecordProof` with the
 * account's did:key and the verified proof through the production
 * `applyRecordProof`, one transaction each. Returns every outcome in order.
 */
async function readModelSource(
  name: string,
): Promise<{ db: Db; outcomes: Array<{ uri: string; rev: string; outcome: ApplyResult['outcome'] }> }> {
  const kit = await createFixtureKit();
  await seedReadModels(kit);
  const db = fileIndexes().get(name);
  for (const n of FIXTURE_USERS) seedUser(db, kit.users[n].did);
  const outcomes: Array<{ uri: string; rev: string; outcome: ApplyResult['outcome'] }> = [];
  for (const ev of kit.jetstream.events) {
    if (ev.kind !== 'commit') continue;
    const owner = FIXTURE_USERS.find((n) => kit.users[n].did === ev.did);
    if (owner === undefined) throw new Error(`no fixture user ${ev.did}`);
    const repo = kit.repos[owner];
    const commit = repo.history.find((c) => c.rev === ev.commit.rev);
    if (commit === undefined) throw new Error(`no commit ${ev.commit.rev} for ${ev.did}`);
    const { collection, rkey } = ev.commit;
    const car = await repo.getRecordCar(collection, rkey, { at: commit.cid });
    const proof = await verifyRecordProof(car, {
      did: ev.did,
      collection,
      rkey,
      signingKey: kit.users[owner].key.didKey,
    });
    expect(proof.commit.rev).toBe(ev.commit.rev);
    const applied = db.tx(() => applyRecordProof(db, proof, OPTS));
    outcomes.push({ uri: `at://${ev.did}/${collection}/${rkey}`, rev: proof.commit.rev, outcome: applied.outcome });
  }
  return { db, outcomes };
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
    const v1 = await inDb(v1Name, (db) => ({
      objects: appObjects(db),
      scrobbles: columnsOf(db, 'scrobbles'),
      hints: columnsOf(db, 'hints'),
    }));
    expect(v1.objects.some((o) => o.name === 'accounts')).toBe(false);

    // The constructor of a fresh harness DO applied every migration.
    const v2 = await inDb('schema-v2-shape', (db) => {
      const objects = appObjects(db);
      return {
        objects,
        scrobbles: columnsOf(db, 'scrobbles'),
        hints: columnsOf(db, 'hints'),
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
      if (o.name !== 'scrobbles')
        expect([o.name, o.name === 'hints' ? now?.sql?.replace(', evidence_rev TEXT', '') : now?.sql]).toEqual([
          o.name,
          o.sql,
        ]);
    }

    // scrobbles: the v1 columns in place, then the §6.2/§8.4 columns.
    expect(v2.scrobbles).toEqual([...v1.scrobbles, ...NEW_SCROBBLE_COLUMNS]);
    expect(v1.scrobbles).not.toContain('album_artist');
    expect(v2.hints).toEqual([...v1.hints, 'evidence_rev']);

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

  it('UNIQUE(did, idempotency_key), listen_keys PK, legacy forward key and lastfm_sessions.sk_hash are enforced', async () => {
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
      insert(db, 'forward_outbox', forward('f5', 'l1', { generation: 2, dedupe_key: 'g2:lk-1' }));

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
        forwards: db.all('SELECT id, link_id, kind, generation, dedupe_key FROM forward_outbox ORDER BY id'),
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
      { id: 'f1', link_id: 'l1', kind: 'scrobble', generation: 1, dedupe_key: 'lk-1' },
      { id: 'f3', link_id: 'l1', kind: 'nowplaying', generation: 1, dedupe_key: 'lk-1' },
      { id: 'f4', link_id: 'l2', kind: 'scrobble', generation: 1, dedupe_key: 'lk-1' },
      { id: 'f5', link_id: 'l1', kind: 'scrobble', generation: 2, dedupe_key: 'g2:lk-1' },
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
    // read_models.json through verify → apply. Since N3-11 the projection also
    // writes the migration-2 scrobble columns (ADR 0005 §6.5), which a
    // version-1 schema does not have, so the fixture is applied into a scratch
    // database at the latest schema and its rows, version-1 columns only,
    // are copied into the version-1 schema: exactly what version-1 code wrote.
    const f = await readModelSource(`${name}-source`);
    expect(f.outcomes.length).toBeGreaterThan(0);
    const v1Tables = await inDb(name, (db) =>
      tableNames(db)
        .filter((t) => t !== 'schema_migrations')
        .map((t) => ({ t, columns: columnsOf(db, t) })),
    );
    const copied = await inDb(`${name}-source`, (db) =>
      v1Tables.map(({ t, columns }) => ({
        t,
        columns,
        rows: db.all<Record<string, SqlParam>>(
          `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY rowid`,
        ),
      })),
    );
    await inDb(name, (db) =>
      db.tx(() => {
        for (const { t } of copied) db.run(`DELETE FROM "${t}"`);
        // users first: scrobbles and follows reference it.
        const ordered = [...copied].sort((a, b) => Number(b.t === 'users') - Number(a.t === 'users'));
        for (const { t, columns, rows } of ordered) {
          const sql = `INSERT INTO "${t}"(${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
          for (const row of rows) db.run(sql, ...columns.map((c) => row[c] ?? null));
        }
      }),
    );

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
      admissionClock: db.all('SELECT singleton,next_seq FROM forward_admission_clock'),
      newTablesEmpty: Object.keys(NEW_TABLES)
        .filter((t) => t !== 'schema_compat')
        .filter((t) => count(db, t) !== 0),
    }));
    // Every v1 row of every v1 table, column for column, as exact SQL
    // literals; only the additive migration ledger rows changed.
    const { schema_migrations: ledgerAfter, ...dataAfter } = after.rows;
    const { schema_migrations: ledgerBefore, ...dataBefore } = before.rows;
    expect(dataAfter).toEqual(dataBefore);
    expect(Object.keys(dataBefore)).toHaveLength(before.tables.length - 1);
    expect(ledgerBefore).toEqual(["1|'initial_workers_schema'"]);
    expect(ledgerAfter).toEqual([
      "1|'initial_workers_schema'",
      "2|'node_schema'",
      "3|'follow_proof_baseline'",
      "4|'scrobble_delete_target_index'",
      "5|'batch_listen_provenance'",
      "6|'batch_outbox_recovery'",
      "7|'batch_listen_removal_receipts'",
      "8|'outbox_send_certainty'",
      "9|'batch_removal_evidence'",
      "10|'verified_listen_membership'",
      "11|'removal_commit_fence'",
      "12|'removal_completion_boundary'",
      "13|'removal_reached'",
      "14|'removal_send_pin'",
      "15|'detailed_now_playing'",
      "16|'musicbrainz_track_matches'",
      "17|'musicbrainz_global_pacing'",
      "18|'musicbrainz_seed_cursor'",
      "19|'musicbrainz_love_revival_jobs'",
      "20|'bounded_love_revival_scan'",
      "21|'cover_art_cache_and_jobs'",
      "22|'forward_admissions_and_love_provenance'",
      "23|'forward_link_generations_and_health'",
      "24|'linked_account_backfill_and_pull_state'",
      "25|'forward_backfill_priority'",
      "26|'forward_backfill_retry_state'",
      "27|'linked_account_backfill_run_revision'",
      "28|'bounded_link_backfill_progress_and_fairness'",
      "29|'link_backfill_staged_membership'",
      "30|'linked_service_pull_foundation'",
      "31|'linked_pull_deletion_tombstones'",
      "32|'linked_love_pull_cursor'",
      "33|'linked_love_user_intent_fence'",
      "34|'linked_pull_legacy_listen_second_recovery'",
      "35|'linked_pull_persisted_poll_rounds'",
      "36|'linked_listenbrainz_pull_round_guards'",
      "37|'linked_pull_love_acceptance_admissions'",
      "38|'love_delete_bridge_commit_revision'",
      "39|'listenbrainz_delete_queue'",
      "40|'listenbrainz_delete_lookup_progress'",
      "41|'listenbrainz_delete_lookup_tie_fence'",
      "42|'listenbrainz_delete_lookup_page_boundary'",
      "43|'forward_love_key_heads'",
      "44|'forward_love_lanes'",
      "45|'forward_love_recording_history'",
      "46|'forward_love_recording_targets'",
      "47|'operations_record_target'",
      "48|'live_admission_evidence'",
      "49|'live_pending_removals'",
      "50|'live_pending_removal_repair'",
      "51|'live_pending_removal_bounds'",
      "52|'a2_authorization_binding'",
    ]);
    // The new scrobble columns exist and are NULL on every migrated row.
    expect(after.newColumns).toHaveLength(expectedScrobbles);
    for (const row of after.newColumns as Array<Record<string, unknown>>) {
      for (const c of NEW_SCROBBLE_COLUMNS) expect([row.uri, c, row[c]]).toEqual([row.uri, c, null]);
    }
    expect(after.ledger).toEqual([
      { version: 1, name: 'initial_workers_schema' },
      { version: 2, name: 'node_schema' },
      { version: 3, name: 'follow_proof_baseline' },
      { version: 4, name: 'scrobble_delete_target_index' },
      { version: 5, name: 'batch_listen_provenance' },
      { version: 6, name: 'batch_outbox_recovery' },
      { version: 7, name: 'batch_listen_removal_receipts' },
      { version: 8, name: 'outbox_send_certainty' },
      { version: 9, name: 'batch_removal_evidence' },
      { version: 10, name: 'verified_listen_membership' },
      { version: 11, name: 'removal_commit_fence' },
      { version: 12, name: 'removal_completion_boundary' },
      { version: 13, name: 'removal_reached' },
      { version: 14, name: 'removal_send_pin' },
      { version: 15, name: 'detailed_now_playing' },
      { version: 16, name: 'musicbrainz_track_matches' },
      { version: 17, name: 'musicbrainz_global_pacing' },
      { version: 18, name: 'musicbrainz_seed_cursor' },
      { version: 19, name: 'musicbrainz_love_revival_jobs' },
      { version: 20, name: 'bounded_love_revival_scan' },
      { version: 21, name: 'cover_art_cache_and_jobs' },
      { version: 22, name: 'forward_admissions_and_love_provenance' },
      { version: 23, name: 'forward_link_generations_and_health' },
      { version: 24, name: 'linked_account_backfill_and_pull_state' },
      { version: 25, name: 'forward_backfill_priority' },
      { version: 26, name: 'forward_backfill_retry_state' },
      { version: 27, name: 'linked_account_backfill_run_revision' },
      { version: 28, name: 'bounded_link_backfill_progress_and_fairness' },
      { version: 29, name: 'link_backfill_staged_membership' },
      { version: 30, name: 'linked_service_pull_foundation' },
      { version: 31, name: 'linked_pull_deletion_tombstones' },
      { version: 32, name: 'linked_love_pull_cursor' },
      { version: 33, name: 'linked_love_user_intent_fence' },
      { version: 34, name: 'linked_pull_legacy_listen_second_recovery' },
      { version: 35, name: 'linked_pull_persisted_poll_rounds' },
      { version: 36, name: 'linked_listenbrainz_pull_round_guards' },
      { version: 37, name: 'linked_pull_love_acceptance_admissions' },
      { version: 38, name: 'love_delete_bridge_commit_revision' },
      { version: 39, name: 'listenbrainz_delete_queue' },
      { version: 40, name: 'listenbrainz_delete_lookup_progress' },
      { version: 41, name: 'listenbrainz_delete_lookup_tie_fence' },
      { version: 42, name: 'listenbrainz_delete_lookup_page_boundary' },
      { version: 43, name: 'forward_love_key_heads' },
      { version: 44, name: 'forward_love_lanes' },
      { version: 45, name: 'forward_love_recording_history' },
      { version: 46, name: 'forward_love_recording_targets' },
      { version: 47, name: 'operations_record_target' },
      { version: 48, name: 'live_admission_evidence' },
      { version: 49, name: 'live_pending_removals' },
      { version: 50, name: 'live_pending_removal_repair' },
      { version: 51, name: 'live_pending_removal_bounds' },
      { version: 52, name: 'a2_authorization_binding' },
    ]);
    expect(after.compat).toEqual([{ singleton: 1, min_compatible_version: 2 }]);
    expect(after.newTablesEmpty).toEqual(['mb_cover_art_usage']);
    expect(after.admissionClock).toEqual([]);

    // The production history module still reads the migrated rows.
    const migrated = nodeIndex(fileIndexes().get(name), { history }, { clock: fixedClock() });
    const page = await migrated.history({ did: fixture.users.Alice.did, limit: 50 });
    expect(page.rows.map((r) => r.rkey)).toEqual(fixture.expected.aliceHistory);
  });

  it('upgrades the real M4 migration-21 schema to S1 without changing cover-art state', () => {
    const name = 'schema-m4-to-s1-upgrade';
    const db = fileIndexes().reset(name);
    expect(migrate(db, MIGRATIONS.slice(0, 21))).toEqual({ status: 'ready', version: 21 });

    db.run(
      'INSERT INTO mb_cover_art(release_mbid,mime_type,image_bytes,byte_size,created_at_ms,fetched_at_ms,last_access_ms) VALUES (?,?,?,?,?,?,?)',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'image/jpeg',
      new Uint8Array([1, 2, 3]).buffer,
      3,
      T0,
      T0,
      T0,
    );
    db.run(
      'INSERT INTO mb_cover_art_jobs(release_mbid,release_group_mbid,status,attempts,next_due_ms,created_at_ms) VALUES (?,?,?,?,?,?)',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      null,
      'pending',
      0,
      T0,
      T0,
    );
    const prior = {
      art: db.all(
        'SELECT release_mbid,mime_type,image_bytes,byte_size,created_at_ms,fetched_at_ms,last_access_ms FROM mb_cover_art',
      ),
      jobs: db.all(
        'SELECT release_mbid,release_group_mbid,status,attempts,next_due_ms,created_at_ms FROM mb_cover_art_jobs',
      ),
      usage: db.all('SELECT singleton,used_bytes FROM mb_cover_art_usage'),
    };

    expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    expect(
      db.all(
        'SELECT release_mbid,mime_type,image_bytes,byte_size,created_at_ms,fetched_at_ms,last_access_ms FROM mb_cover_art',
      ),
    ).toEqual(prior.art);
    expect(
      db.all('SELECT release_mbid,release_group_mbid,status,attempts,next_due_ms,created_at_ms FROM mb_cover_art_jobs'),
    ).toEqual(prior.jobs);
    expect(db.all('SELECT singleton,used_bytes FROM mb_cover_art_usage')).toEqual(prior.usage);
    expect(db.all('SELECT version,name FROM schema_migrations ORDER BY version')).toEqual(
      MIGRATIONS.map(({ version, name: migrationName }) => ({ version, name: migrationName })),
    );
    expect(
      db.all("SELECT name FROM sqlite_master WHERE type='index' AND name=?", 'forward_outbox_due_generation'),
    ).toEqual([{ name: 'forward_outbox_due_generation' }]);
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
      'SEARCH loves USING INDEX loves_newer_by_track (did=? AND artist_key=? AND track_key=?)',
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
    // No ADD COLUMN in any migration, migration 2 included, carries a clause
    // that makes SQLite run its internal quick_check (or fail on existing
    // rows): the node:sqlite PRAGMA authorizer refuses that check, so such a
    // statement rolls back migrate() at startup on the Node host.
    expect(MIGRATIONS.flatMap((m) => m.statements.filter(isUnsafeAddColumn))).toEqual([]);
    expect(
      MIGRATIONS.flatMap((m) => m.statements).filter((s) => /^\s*ALTER TABLE \w+ ADD (COLUMN )?/i.test(s)).length,
    ).toBeGreaterThan(0);

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
      "ALTER TABLE scrobbles ADD COLUMN mood TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE scrobbles ADD COLUMN plays INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE scrobbles ADD COLUMN note TEXT DEFAULT 'CHECK(x) UNIQUE'",
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
      // ADD COLUMN forms SQLite verifies with pragma_quick_check or that fail
      // on existing rows.
      'ALTER TABLE scrobbles ADD COLUMN track_no INTEGER CHECK(track_no BETWEEN 1 AND 9999)',
      'ALTER TABLE scrobbles ADD COLUMN n INTEGER CONSTRAINT n_pos check (n > 0)',
      'ALTER TABLE scrobbles ADD COLUMN mood TEXT NOT NULL',
      'ALTER TABLE scrobbles ADD COLUMN mood TEXT UNIQUE',
      'ALTER TABLE scrobbles ADD COLUMN pk INTEGER PRIMARY KEY',
      'ALTER TABLE scrobbles ADD COLUMN owner TEXT REFERENCES users(did)',
      'ALTER TABLE scrobbles ADD COLUMN k TEXT GENERATED ALWAYS AS (artist_key) VIRTUAL',
      'ALTER TABLE scrobbles ADD COLUMN k TEXT AS (artist_key)',
      'ALTER TABLE scrobbles ADD COLUMN t TEXT DEFAULT CURRENT_TIMESTAMP',
      'ALTER TABLE scrobbles ADD COLUMN t INTEGER DEFAULT (1 + 1)',
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
      'forward_storage_scan',
      'loves',
      'range_stats_cache',
      // Migration 10: rebuilt from verified proofs and snapshots.
      'verified_membership',
      'mb_forward_love_current',
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
    if (m.version === 21 && /^INSERT INTO mb_cover_art_usage\(/i.test(body)) return false;
    // More than one statement in one string is never additive.
    if (body.includes(';')) return true;
    if (isUnsafeAddColumn(body)) return true;
    return !allowed.some((re) => re.test(body));
  });
}

/**
 * An ALTER TABLE ... ADD [COLUMN] whose column definition SQLite cannot add
 * as a plain metadata change. A CHECK (or a NOT NULL generated column) makes
 * SQLite verify existing rows with an internal `pragma_quick_check`, which the
 * node:sqlite authorizer (N1-01) refuses; NOT NULL without DEFAULT, UNIQUE,
 * PRIMARY KEY, a non-constant DEFAULT and REFERENCES fail or need a check on
 * a table with rows. Bounds on such a column belong in the validator.
 */
function isUnsafeAddColumn(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ').trim();
  const m = /^ALTER TABLE \w+ ADD (?:COLUMN )?\w+(.*)$/i.exec(s);
  if (!m) return false;
  // Ignore keywords inside string literals (e.g. a DEFAULT text value).
  const def = (m[1] ?? '').replace(/'(?:[^']|'')*'/g, "''").toUpperCase();
  if (/\b(CHECK|UNIQUE|PRIMARY KEY|REFERENCES|GENERATED)\b/.test(def)) return true;
  if (/\bAS ?\(/.test(def)) return true;
  if (/\bDEFAULT ?(\(|CURRENT_)/.test(def)) return true;
  if (/\bNOT NULL\b/.test(def) && !/\bDEFAULT\b/.test(def)) return true;
  return false;
}

function unclassified(tables: readonly string[]): string[] {
  return tables.filter((t) => !Object.hasOwn(TABLE_CLASS, t));
}

function expectEveryTableClassified(tables: readonly string[]): void {
  const missing = unclassified(tables);
  expect(missing, `tables without a TABLE_CLASS entry: ${missing.join(', ')}`).toEqual([]);
}
