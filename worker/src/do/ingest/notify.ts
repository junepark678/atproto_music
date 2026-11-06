// Notify and record status inside the IndexDO (ADR 0004 §5.4, §8, §9.4 N1/N2;
// API.md "Notify (N1)", `RecordStatus`). Synchronous: every function here runs
// to completion inside one DO turn, and every write is one `db.tx`.
//
// notify(m, input, ip, now, limits?) — an untrusted hint (N1). It can only make
// the drain fetch and verify public signed truth; it never projects anything.
// The Worker (worker/src/http/notify.ts) has already admitted the body (2 KiB,
// strict JSON, `{uri}` in a configured collection or `{did}`), and this module
// re-checks the shape so the RPC can never be driven with anything else.
//  1. Abuse limits, before any read or write: the per-IP bucket (60/min, keyed
//     by the client IP the Worker took from CF-Connecting-IP) and then the
//     per-DID bucket (600/h, the input DID or the URI's DID). Either one empty
//     → `rate_limited` with the bucket's Retry-After, nothing written. The
//     buckets are in memory (worker/src/http/limits.ts BucketSet, bounded at
//     10,000 keys each), one NotifyLimits per IndexDO instance, driven by the
//     `now` of each call; they fail open after a DO restart (ADR §8).
//  2. Namespace gate closed (no configured collections): nothing to check,
//     `queued` with nothing written (the Worker already refuses every `{uri}`).
//  3. Suppressed DID: only a `<p>.settings` URI is accepted (the opt-out record
//     is the only thing that can lift an opt-out, ADR §5.3); anything else is
//     `queued` and silently ignored (API.md N1: 202, nothing written).
//  4. `{uri}`: `enqueueHints` with source `notify` (priority 0, the top of the
//     drain order), receipt time `now`, due now; a repeat coalesces into the
//     same row (hints.ts ON CONFLICT(uri)). For a DID this index does not know,
//     the drain will need an admission slot (50/h, 1,024 pending snapshot
//     jobs); while admission is exhausted the hint is refused up front with
//     `queue_full` and nothing is written, so unknown DIDs cannot grow the hint
//     queue past the admission bound. A settings URI is exempt: the drain
//     verifies an unknown DID's opt-out without admitting it.
//  5. `{did}`:
//     - unknown → `admit(db, did, 'notify', now)`: an inactive users row plus a
//       pending snapshot job in one transaction; admission exhausted →
//       `queue_full` with nothing written;
//     - known → a refresh snapshot (`scheduleSnapshot`, reason `notify`) only
//       when no snapshot job is open, the last completed snapshot
//       (`users.last_snapshot_at_ms`) is more than 24 h old or missing, and no
//       snapshot job row was created or touched in the last 24 h (both bounds
//       inclusive: exactly 24 h is not "more than 24 h ago"). Every job
//       this schedules is open until it completes (and completion sets
//       `last_snapshot_at_ms`), and its row's `updated_at_ms` is at least the
//       scheduling instant, so a DID gets at most one notify snapshot per 24 h
//       however often it is notified. Otherwise `queued` with nothing written.
//       The 1,024 pending cap full → `queue_full`.
//
// recordStatus(m, uri, now?) — N2, one synchronous read:
//   - `indexed`: a visible projection row (a scrobble, a follow or a love,
//     ADR 0005 §6.3, whose owner is a visible user, read/visibility.ts) with
//     its verified cid and revision (a love's revision is its record_state
//     revision: `loves` has no revision column);
//   - `pending`: a hint for this URI, or an open (pending, running or failed)
//     snapshot job for its DID, exists;
//   - `absent` (revision) or `excluded` (cid, revision, reason): record_state;
//   - `unknown` otherwise (no cid, revision or reason), which also covers a
//     verified record whose owner is hidden (inactive or suppressed) and a
//     settings record, which has no projection row;
//   - `indexing` is the per-DID Indexing truth (status.ts), so a suppressed
//     DID reports `indexing.state = 'suppressed'`.

import type { Did, NotifyInput, RecordStatus } from '@atmusic/core/api-types';
import type { Clock } from '@atmusic/core/deps';
import { isSupportedDid, parseRecordUri } from '@atmusic/core/syntax';
import { BucketSet, DID_RATE, IP_RATE, MAX_BUCKET_KEYS, type RateDecision, type RateRule } from '../../http/limits';
import type { ModuleDeps, NotifyOutcome } from '../contracts';
import type { Db } from '../db';
import { visibleDid, visibleScrobblesFrom } from '../read/visibility';
import { indexing } from '../status';
import { loadUser } from '../write/account-state';
import { collectionKind } from '../write/keys';
import {
  ADMISSION_HOURLY_BUDGET,
  admit,
  admittedThisWindow,
  MAX_PENDING_SNAPSHOT_JOBS,
  pendingSnapshotJobs,
  scheduleSnapshot,
} from './admission';
import { enqueueHints } from './hints';

/** A known DID is re-snapshotted on `{did}` notify at most once per this interval. */
export const NOTIFY_SNAPSHOT_INTERVAL_MS = 24 * 3_600_000;
/** `repo_jobs.reason` of a snapshot scheduled by `{did}` notify. */
export const NOTIFY_SNAPSHOT_REASON = 'notify';

export interface NotifyLimitRules {
  ip?: RateRule;
  did?: RateRule;
  maxKeys?: number;
}

/**
 * The in-memory notify buckets of one IndexDO instance: per client IP and per
 * DID. Time comes only from the `now` passed to `take`.
 */
export class NotifyLimits {
  private nowMs: number;
  private readonly ip: BucketSet;
  private readonly did: BucketSet;

  constructor(now: number, rules: NotifyLimitRules = {}) {
    assertEpochMs('now', now);
    this.nowMs = now;
    const clock: Clock = { nowMs: () => this.nowMs };
    const maxKeys = rules.maxKeys ?? MAX_BUCKET_KEYS;
    this.ip = new BucketSet(rules.ip ?? IP_RATE, clock, maxKeys);
    this.did = new BucketSet(rules.did ?? DID_RATE, clock, maxKeys);
  }

  /** Consumes one IP token, then (only if that passed) one DID token. */
  take(ip: string, did: string, now: number): RateDecision {
    assertEpochMs('now', now);
    // A clock that steps backwards never mints credit (TokenBucket ignores it).
    this.nowMs = Math.max(this.nowMs, now);
    const byIp = this.ip.take(ip);
    if (!byIp.allowed) return byIp;
    return this.did.take(did);
  }

  /** Live buckets per set (bounded by maxKeys). */
  get sizes(): { ip: number; did: number } {
    return { ip: this.ip.size, did: this.did.size };
  }
}

const instanceLimits = new WeakMap<Db, NotifyLimits>();

/**
 * The NotifyLimits of the IndexDO instance that owns `m.db` (created on first
 * use). IndexDO builds its ModuleDeps, and so its Db, once per instance; a new
 * instance (a restart) starts with full buckets.
 */
export function notifyLimitsFor(m: Pick<ModuleDeps, 'db'>, now: number): NotifyLimits {
  let limits = instanceLimits.get(m.db);
  if (limits === undefined) {
    limits = new NotifyLimits(now);
    instanceLimits.set(m.db, limits);
  }
  return limits;
}

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

type Target =
  | { kind: 'uri'; did: Did; collection: string; rkey: string; settings: boolean }
  | { kind: 'did'; did: Did };

/** Re-check the admitted shape (the Worker's 422 rules); throws on anything else. */
function notifyTarget(m: ModuleDeps, input: NotifyInput): Target {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('notify needs {uri} or {did}');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new TypeError('notify needs exactly one of uri or did');
  if (keys[0] === 'did') {
    const did = (input as { did: unknown }).did;
    if (typeof did !== 'string' || !isSupportedDid(did)) throw new TypeError('notify did is not a supported DID');
    return { kind: 'did', did };
  }
  if (keys[0] !== 'uri') throw new TypeError(`notify has an unknown field ${keys[0]}`);
  const raw = (input as { uri: unknown }).uri;
  const uri = typeof raw === 'string' ? parseRecordUri(raw) : null;
  if (uri === null || !isSupportedDid(uri.did)) throw new TypeError('notify uri is not a record AT URI');
  const prefix = m.config.prefix;
  const kind = prefix === null ? null : collectionKind(prefix, uri.collection);
  if (prefix !== null && kind === null) throw new TypeError('notify uri is not in a configured collection');
  return { kind: 'uri', did: uri.did, collection: uri.collection, rkey: uri.rkey, settings: kind === 'settings' };
}

function isSuppressedDid(db: Db, did: string): boolean {
  return db.one('SELECT 1 AS x FROM suppression WHERE did = ?', did) !== null;
}

/** Admission is exhausted for a new DID (the bounds `admit` checks, read only). */
function admissionExhausted(db: Db, did: string, now: number): boolean {
  return (
    admittedThisWindow(db, now) >= ADMISSION_HOURLY_BUDGET || pendingSnapshotJobs(db, did) >= MAX_PENDING_SNAPSHOT_JOBS
  );
}

const QUEUED: NotifyOutcome = { status: 'queued' };
const QUEUE_FULL: NotifyOutcome = { status: 'queue_full' };

function notifyDid(m: ModuleDeps, did: Did, now: number): NotifyOutcome {
  const db = m.db;
  return db.tx((): NotifyOutcome => {
    const user = loadUser(db, did);
    if (user === null) {
      const admitted = admit(db, did, 'notify', now);
      if (admitted.status === 'busy') return QUEUE_FULL;
      return QUEUED;
    }
    const open = db.one(
      `SELECT 1 AS x FROM repo_jobs WHERE did = ? AND kind = 'snapshot'
         AND (state IN ('pending','running','failed') OR updated_at_ms >= ?)`,
      did,
      now - NOTIFY_SNAPSHOT_INTERVAL_MS,
    );
    if (open !== null) return QUEUED;
    const last = user.last_snapshot_at_ms;
    if (last !== null && now - last <= NOTIFY_SNAPSHOT_INTERVAL_MS) return QUEUED;
    const scheduled = scheduleSnapshot(db, did, NOTIFY_SNAPSHOT_REASON, now);
    return scheduled.status === 'busy' ? QUEUE_FULL : QUEUED;
  });
}

/** N1: rate-limit, then queue a hint, admit a DID or schedule its refresh snapshot. */
export function notify(
  m: ModuleDeps,
  input: NotifyInput,
  ip: string,
  now: number,
  limits: NotifyLimits = notifyLimitsFor(m, now),
): NotifyOutcome {
  assertEpochMs('now', now);
  if (typeof ip !== 'string') throw new TypeError('notify needs the client IP string');
  const target = notifyTarget(m, input);

  const decision = limits.take(ip, target.did, now);
  if (!decision.allowed) return { status: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds };

  if (m.config.collections === null) return QUEUED;
  const db = m.db;
  if (isSuppressedDid(db, target.did) && !(target.kind === 'uri' && target.settings)) return QUEUED;
  if (target.kind === 'did') return notifyDid(m, target.did, now);

  if (!target.settings && loadUser(db, target.did) === null && admissionExhausted(db, target.did, now)) {
    return QUEUE_FULL;
  }
  enqueueHints(db, [
    { did: target.did, collection: target.collection, rkey: target.rkey, source: 'notify', receiptMs: now },
  ]);
  return QUEUED;
}

interface VisibleRow {
  cid: string;
  revision: string;
}

const VISIBLE_ROW = `
  SELECT s.cid, s.revision FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.uri = ?
  UNION ALL
  SELECT f.cid, f.revision FROM follows f WHERE f.uri = ? AND ${visibleDid('f.actor', 'fa')}
  UNION ALL
  SELECT l.cid, r.revision FROM loves l JOIN record_state r ON r.uri = l.uri
    WHERE l.uri = ? AND r.state = 'present' AND ${visibleDid('l.did', 'la')}
  LIMIT 1`;

/** N2: the indexing state of one record URI (see the header). */
export function recordStatus(m: ModuleDeps, uri: string, now: number = m.clock.nowMs()): RecordStatus {
  assertEpochMs('now', now);
  const parsed = typeof uri === 'string' ? parseRecordUri(uri) : null;
  if (parsed === null) throw new RangeError('recordStatus needs a record AT URI');
  const db = m.db;
  const did = parsed.did;
  const idx = indexing(db, now, { did, mode: m.config.ingestMode });

  const row = db.one<VisibleRow>(VISIBLE_ROW, uri, uri, uri);
  if (row !== null) return { uri, state: 'indexed', cid: row.cid, revision: row.revision, indexing: idx };

  const pending =
    db.one('SELECT 1 AS x FROM hints WHERE uri = ?', uri) !== null ||
    db.one(
      `SELECT 1 AS x FROM repo_jobs WHERE did = ? AND kind = 'snapshot' AND state IN ('pending','running','failed')`,
      did,
    ) !== null;
  if (pending) return { uri, state: 'pending', indexing: idx };

  const rs = db.one<{ state: string; cid: string | null; revision: string; reason: string | null }>(
    'SELECT state, cid, revision, reason FROM record_state WHERE uri = ?',
    uri,
  );
  if (rs?.state === 'absent') return { uri, state: 'absent', revision: rs.revision, indexing: idx };
  if (rs?.state === 'excluded' && rs.cid !== null && rs.reason !== null) {
    return { uri, state: 'excluded', cid: rs.cid, revision: rs.revision, reason: rs.reason, indexing: idx };
  }
  return { uri, state: 'unknown', indexing: idx };
}
