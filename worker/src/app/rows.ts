// Row types for the tables of migration 2 (ADR 0005 §6.4, N1-10), exactly as
// `SELECT *` returns them through `Db` (worker/src/do/schema.ts is the source
// of truth for columns and constraints).
//
// - INTEGER columns are numbers (safe integers), flags are 0 | 1.
// - BLOB columns are ArrayBuffer: every SHA-256 lookup hash is 32 bytes, and
//   sealed values use the box format keyId‖nonce‖ct‖tag.
// - Times are epoch ms unless the name says otherwise; listen times and love
//   `created_at` are 30-character storage timestamps.
//
// Type only: no runtime code, no barrel.

import type { ScrobbleRow } from '../do/contracts';
import type {
  BACKUP_KINDS,
  FORWARD_KINDS,
  FORWARD_STATES,
  IGNORED_LISTEN_REASONS,
  IGNORED_LISTEN_SOURCES,
  IMPORT_ITEM_STATES,
  IMPORT_SOURCES,
  IMPORT_STATES,
  LASTFM_TOKEN_STATES,
  LINK_SERVICES,
  LINK_STATUSES,
  NOW_PLAYING_SOURCES,
  OAUTH_STATUSES,
  OPERATION_KINDS,
  OPERATION_STATES,
  ORIGINS,
  PDS_BUDGET_WINDOWS,
} from '../do/schema';

export type Flag = 0 | 1;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationState = (typeof OPERATION_STATES)[number];
export type Origin = (typeof ORIGINS)[number];
export type OAuthStatus = (typeof OAUTH_STATUSES)[number];
export type PdsBudgetWindow = (typeof PDS_BUDGET_WINDOWS)[number];
export type LastfmTokenState = (typeof LASTFM_TOKEN_STATES)[number];
export type NowPlayingSource = (typeof NOW_PLAYING_SOURCES)[number];
export type LinkService = (typeof LINK_SERVICES)[number];
export type LinkStatus = (typeof LINK_STATUSES)[number];
export type ForwardKind = (typeof FORWARD_KINDS)[number];
export type ForwardState = (typeof FORWARD_STATES)[number];
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export type ImportState = (typeof IMPORT_STATES)[number];
export type ImportItemState = (typeof IMPORT_ITEM_STATES)[number];
export type IgnoredListenSource = (typeof IGNORED_LISTEN_SOURCES)[number];
export type IgnoredListenReason = (typeof IGNORED_LISTEN_REASONS)[number];
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** The `scrobbles` columns migration 2 adds (ADR 0005 §6.2, §8.4); NULL until projected (N3-11). */
export interface ScrobbleV2Columns {
  album_artist: string | null;
  album_artist_key: string | null;
  /** 1–9999, bounded by the §6.2 validator and the N3-11 projection (no column CHECK). */
  track_number: number | null;
  /** JSON array text of distinct UUID strings. */
  artist_mbids: string | null;
  release_mbid: string | null;
  release_group_mbid: string | null;
  isrc: string | null;
  submission_client: string | null;
  music_service: string | null;
  recording_msid: string | null;
}

/** A `scrobbles` row at schema version 2. */
export interface ScrobbleRowV2 extends ScrobbleRow, ScrobbleV2Columns {}

export interface AccountRow {
  did: string;
  /** Lowercase `[a-z0-9][a-z0-9._-]{1,63}`, unique. */
  username: string;
  oauth_status: OAuthStatus;
  share_now_playing: Flag;
  /** 10–90. */
  import_share_pct: number;
  daily_listen_cap: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WebSessionRow {
  /** SHA-256 of the cookie token. */
  token_hash: ArrayBuffer;
  did: string;
  created_at_ms: number;
  expires_at_ms: number;
  last_seen_ms: number;
}

export interface OAuthStateRow {
  /** SHA-256 of the state key; also the AAD of the ciphertext. */
  key_hash: ArrayBuffer;
  ciphertext: ArrayBuffer;
  key_id: string;
  /** SHA-256 of the `__Host-atmusic_oauth` cookie value. */
  session_binding: ArrayBuffer;
  expires_at_ms: number;
}

export interface OAuthSessionRow {
  did: string;
  ciphertext: ArrayBuffer;
  key_id: string;
  client_kid: string;
  generation: number;
  last_refresh_ms: number;
  status: OAuthStatus;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OperationRow {
  id: string;
  did: string;
  kind: OperationKind;
  origin: Origin;
  /** 0 live, 1 import. */
  priority: number;
  collection: string;
  /** NULL for a delete intent that lists its targets when it runs. */
  rkey: string | null;
  /** Set together with `digest`. */
  record_json: string | null;
  digest: string | null;
  swap_cid: string | null;
  state: OperationState;
  /** 0–10. */
  attempts: number;
  due_at: number;
  last_error: string | null;
  result_uri: string | null;
  result_cid: string | null;
  /** 1–128 characters; UNIQUE per DID. */
  idempotency_key: string | null;
  /** SHA-256 of the request. */
  request_hash: ArrayBuffer | null;
  import_job_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OperationDepRow {
  op_id: string;
  pred_id: string;
}

export interface ListenKeyRow {
  did: string;
  dedupe_key: string;
  operation_id: string | null;
  source: Origin;
  created_at_ms: number;
}

export interface PdsBudgetRow {
  did: string;
  window: PdsBudgetWindow;
  window_start_ms: number;
  points: number;
  limit_hint: number | null;
  remaining_hint: number | null;
  reset_at_ms: number | null;
}

export interface LastfmTokenRow {
  token_hash: ArrayBuffer;
  api_key: string;
  /** Set once the token is authorized. */
  did: string | null;
  state: LastfmTokenState;
  created_at_ms: number;
  expires_at_ms: number;
}

export interface LastfmSessionRow {
  id: string;
  sk_hash: ArrayBuffer;
  did: string;
  api_key: string;
  client_name: string | null;
  created_at_ms: number;
  last_used_ms: number | null;
}

export interface LastfmAppRow {
  api_key: string;
  did: string;
  name: string;
  secret_ciphertext: ArrayBuffer;
  key_id: string;
  created_at_ms: number;
}

export interface AppPasswordRow {
  id: string;
  did: string;
  label: string | null;
  hash: ArrayBuffer;
  created_at_ms: number;
  last_used_ms: number | null;
}

export interface LbTokenRow {
  id: string;
  did: string;
  label: string | null;
  hash: ArrayBuffer;
  created_at_ms: number;
  last_used_ms: number | null;
}

export interface NowPlayingRow {
  did: string;
  artist: string;
  track: string;
  album: string | null;
  album_artist: string | null;
  duration_seconds: number | null;
  recording_mbid: string | null;
  client: string | null;
  source: NowPlayingSource;
  started_at_ms: number;
  expires_at_ms: number;
}

export interface LoveRow {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  artist: string;
  track: string;
  album: string | null;
  artist_key: string;
  track_key: string;
  recording_mbid: string | null;
  /** 30-character storage timestamp. */
  created_at: string;
  indexed_at: string;
}

export interface LinkedAccountRow {
  id: string;
  did: string;
  service: LinkService;
  remote_user: string;
  credential_ciphertext: ArrayBuffer;
  key_id: string;
  forward_scrobbles: Flag;
  forward_now_playing: Flag;
  status: LinkStatus;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface LinkStateRow {
  state_hash: ArrayBuffer;
  did: string;
  service: LinkService;
  /** The web session's token hash the state is bound to. */
  session_hash: ArrayBuffer;
  expires_at_ms: number;
}

export interface ForwardOutboxRow {
  id: string;
  link_id: string;
  did: string;
  kind: ForwardKind;
  dedupe_key: string;
  payload_json: string;
  state: ForwardState;
  attempts: number;
  due_at: number;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ImportJobRow {
  id: string;
  did: string;
  source: ImportSource;
  remote_user: string | null;
  state: ImportState;
  cursor_json: string | null;
  upload_path: string | null;
  upload_bytes: number | null;
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  /** JSON object text: counts by reason. */
  invalid_reasons: string;
  written: number;
  failed_items: number;
  /** Slices started and never completed (crash-loop guard). */
  attempts: number;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  finished_at_ms: number | null;
}

export interface ImportItemRow {
  job_id: string;
  seq: number;
  dedupe_key: string;
  /** 30-character storage timestamp. */
  listened_at: string;
  record_json: string;
  state: ImportItemState;
  operation_id: string | null;
}

export interface IgnoredListenRow {
  id: number;
  did: string;
  source: IgnoredListenSource;
  reason: IgnoredListenReason;
  /** 30-character storage timestamp. */
  listened_at: string;
  /** At most 128 scalars. */
  artist_preview: string;
  track_preview: string;
  created_at_ms: number;
}

export interface RangeStatsCacheRow {
  did: string;
  entity: string;
  range_key: string;
  as_of: string;
  lower: string | null;
  upper: string | null;
  version: number;
  body: string;
  created_at_ms: number;
}

export interface BackupRunRow {
  id: number;
  kind: BackupKind;
  started_at_ms: number;
  finished_at_ms: number | null;
  path: string | null;
  bytes: number | null;
  ok: Flag;
  error: string | null;
}

export interface SchemaCompatRow {
  /** Always 1: the table holds exactly one row. */
  singleton: 1;
  min_compatible_version: number;
}
