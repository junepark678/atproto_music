// IndexDO module and RPC contracts (ADR 0004 §4.3, §4.4). Frozen in Wave 0.
//
// DO modules are plain functions `(m: ModuleDeps, args)`. Only
// worker/src/do/index-do.ts (W5-01) exposes them as RPC methods matching
// IndexRpc. Row types mirror worker/src/do/schema.ts column for column (DO SQL
// returns INTEGER as number, TEXT as string, NULL as null, BLOB as ArrayBuffer).

import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type {
  AtUri,
  Did,
  Export,
  FeedScope,
  Indexing,
  NotifyInput,
  Profile,
  RecordStatus,
  Statistics,
  StatsWindow,
} from '@atmusic/core/api-types';
import type { Clock, Random } from '@atmusic/core/deps';
import type { AppConfig } from '../config';
import type { Db } from './db';
import type { MigrateResult } from './migrate';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logging to Workers Logs. Never pass secrets or tokens. */
export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export interface ModuleDeps {
  db: Db;
  clock: Clock;
  random: Random;
  transport: Transport;
  identity: IdentityResolver;
  config: AppConfig;
  log: Logger;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type AccountStatus =
  | 'unknown'
  | 'active'
  | 'deactivated'
  | 'takendown'
  | 'suspended'
  | 'deleted'
  | 'desynchronized'
  | 'throttled'
  | 'not_found';

export interface UserRow {
  did: string;
  handle: string | null;
  handle_checked_at_ms: number | null;
  pds: string | null;
  joined_at: string;
  indexed_at: string | null;
  active: 0 | 1;
  account_status: AccountStatus;
  max_rev: string | null;
  indexing_state: Indexing['state'];
  generation: number;
  stats_version: number;
  last_snapshot_at_ms: number | null;
  last_status_check_ms: number | null;
  last_activity_ms: number | null;
}

export interface ScrobbleRow {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  revision: string;
  artist: string;
  track: string;
  album: string | null;
  /** 30-character storage timestamp. */
  listened_at: string;
  created_at: string;
  duration_seconds: number | null;
  recording_mbid: string | null;
  indexed_at: string;
  artist_key: string;
  track_key: string;
  album_key: string | null;
}

export interface FollowRow {
  uri: string;
  cid: string;
  actor: string;
  subject: string;
  revision: string;
  /** 30-character storage timestamp. */
  created_at: string;
  indexed_at: string;
}

export type RepoJobKind = 'snapshot' | 'status' | 'identity';
export type RepoJobState = 'pending' | 'running' | 'complete' | 'failed';

export interface RepoJobRow {
  did: string;
  kind: RepoJobKind;
  state: RepoJobState;
  generation: number;
  reason: string | null;
  head_rev: string | null;
  head_cid: string | null;
  frontier_json: string | null;
  restarts: number;
  reactivate: 0 | 1;
  due_at: number;
  attempts: number;
  failure_code: string | null;
  updated_at_ms: number;
}

// ---------------------------------------------------------------------------
// RPC argument and result types
// ---------------------------------------------------------------------------

/** A (timestamp, uri) ordering tuple; `t` is the 30-character storage form. */
export interface TimeKey {
  t: string;
  uri: string;
}

/** Keyset position decoded from a cursor (or set from the first page). */
export interface KeysetQuery {
  /** Anchor: no row above it is returned (fresh traversal sets it). */
  upper?: TimeKey;
  /** Last row already returned; the next page starts strictly below it. */
  last?: TimeKey;
  limit: number;
}

export interface HistoryQuery extends KeysetQuery {
  did: Did;
}

export interface FeedQuery extends KeysetQuery {
  scope: FeedScope;
  /** Required when scope is `following` (A8). */
  viewer?: Did;
}

export interface FollowListQuery extends KeysetQuery {
  did: Did;
}

export interface StatsQuery {
  did: Did;
  window: StatsWindow;
  limit: number;
  /** asOf as integer nanoseconds since the epoch. */
  asOfNs: bigint;
}

/** One RPC returns the rows and the indexing truth for the page. */
export interface RowsResult<T> {
  rows: T[];
  hasMore: boolean;
  indexing: Indexing;
}

export type ResolveOutcome =
  | { status: 'ok'; did: Did; handle: string }
  | { status: 'not_found' }
  | { status: 'mismatch' }
  | { status: 'upstream_error' };

export type NotifyOutcome =
  | { status: 'queued' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'queue_full' };

export interface AdminStatus {
  schema: MigrateResult;
  indexing: Indexing;
  ingest: {
    mode: AppConfig['ingestMode'];
    cursor: number | null;
    lastEventTimeUs: number | null;
    connected: boolean;
    pendingGap: boolean;
    hostIndex: number;
  };
  hints: { total: number; due: number };
  jobs: Record<RepoJobKind, Partial<Record<RepoJobState, number>>>;
  counters: Array<{ name: string; label: string; value: number }>;
}

export interface PitrResult {
  /** The restore bookmark scheduled for the next session. */
  bookmark: string;
}

export interface IndexRpc {
  ready(): Promise<MigrateResult>;
  indexing(did?: Did): Promise<Indexing>;
  history(q: HistoryQuery): Promise<RowsResult<ScrobbleRow>>;
  feed(q: FeedQuery): Promise<RowsResult<ScrobbleRow>>;
  /** Null for unknown, inactive, excluded or absent records (404). */
  lookup(uri: AtUri): Promise<ScrobbleRow | null>;
  recordStatus(uri: AtUri): Promise<RecordStatus>;
  /** Null for unknown or inactive users (404). */
  stats(q: StatsQuery): Promise<Statistics | null>;
  /** Null for unknown, inactive or suppressed users (404, before any identity request). */
  profile(did: Did): Promise<Profile | null>;
  following(q: FollowListQuery): Promise<RowsResult<FollowRow>>;
  followers(q: FollowListQuery): Promise<RowsResult<FollowRow>>;
  /** Null for unknown or inactive users (404). */
  exportUser(did: Did): Promise<Export | null>;
  resolveHandle(handle: string): Promise<ResolveOutcome>;
  notify(input: NotifyInput, ip: string): Promise<NotifyOutcome>;
  ensureRunning(): Promise<void>;
  adminStatus(): Promise<AdminStatus>;
  adminPitr(atMs: number): Promise<PitrResult>;
}
