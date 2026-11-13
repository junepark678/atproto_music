// The forwarding queue's row lifecycle (ADR 0005 §12.2, §12.3; N3-08).
// Rows are created by N2-05 (`enqueueForwards`, outbox/forward-enqueue.ts) in
// the acceptance transaction; this module reads and settles them for the
// forwarder (forwarder.ts).
//
// States (forward_outbox.state):
//
//   queued    waiting for `due_at`; the only state the forwarder sends
//   sent      the upstream accepted it
//   ignored   Last.fm answered a per-item ignoredMessage other than 5, or a
//             ListenBrainz love/unlove had no recording MBID (not forwardable)
//   failed    a permanent refusal (ListenBrainz 400 with its error text, an
//             unknown Last.fm code, a now-playing failure: sent once, never
//             retried, or an unreadable payload)
//   expired   too old to be worth sending: Last.fm rows after 13 days,
//             ListenBrainz rows after 30 days (ADR §12.3), now playing after
//             60 s, held rows 30 days after they were held
//   held      the link was revoked (Last.fm 9/4, ListenBrainz 401); kept and
//             queued again when the account is relinked (links.ts saveLink)
//
// Order. Rows are read oldest first: `created_at_ms`, then `rowid` (the
// insertion order, which breaks ties between rows accepted in the same
// millisecond). For love/unlove, the durable lane table schedules keys fairly,
// while an indexed canonical head probe chooses the oldest queued row for the
// key. A backoff blocks later toggles of that same key, but does not block a
// different track. Thus each track's toggles reach upstream in order even
// across retries.
//
// Retry (ADR §12.3): `forwardBackoffMs(n)` = 30 s·2^n + U[0, 25%] of it,
// capped at 1 h, with n the row's attempts before this one. Transient errors
// retry until the destination-specific row age expires. An actual upstream
// 429 counts; a local pacing deferral does not. Last.fm code 5 re-queues at the
// next 00:00 UTC without counting an attempt; service age limits still apply.
// Admission and destination generations persist locally. A crash after
// upstream acceptance but before the outbox transition commits can still
// duplicate delivery: neither upstream supports idempotency keys.
//
// Payloads (payload_json, written by enqueueForwards' callers):
// - scrobble:    {listen, origin}. `listen` is the accepted entry: a
//   ScrobbleInput (`listenedAt` RFC 3339, `durationSeconds`, `recordingMbid`,
//   `albumArtist`, `trackNumber`, …) or a Last.fm entry as received
//   (`timestamp` in seconds, `duration`, `mbid`).
// - nowplaying:  {track, startedAtMs, origin} with the same track fields.
// - love/unlove: {artist, track, album?, recordingMbid?, origin}.
// A payload that does not give an artist, a track and (for a scrobble) a
// time is `failed` with `invalid_payload`, never sent.
//
// The global Last.fm pause (codes 10 and 26, ADR §12.3) is the `counters`
// row `lastfm_key_rejected`, whose value is when the key was last rejected
// (epoch ms). adminStatus lists every counter, so the pause is visible there;
// it is lifted when a later probe request succeeds (forwarder.ts).

import type { Random } from '@atmusic/core/deps';
import type { ForwardKind, ForwardOutboxRow, LinkService } from '../app/rows';
import type { Db } from '../do/db';
import { settleApiLoveRecipientRows } from './love-api-recipients';
import { recordLoveDelivery, type SentLoveRow } from './love-delivery';
import { touchLoveLane } from './love-lanes';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Last.fm drops scrobbles older than about 14 days (ADR §12.3). */
export const LASTFM_EXPIRY_MS = 13 * DAY;
/** ListenBrainz accepts old listens; its rows expire after 30 days (ADR §12.3). */
export const LISTENBRAINZ_EXPIRY_MS = 30 * DAY;
/** Held rows are kept this long after their link was revoked. */
export const HELD_RETENTION_MS = 30 * DAY;
/** Now playing older than this is not sent (ADR §12.3). */
export const NOW_PLAYING_MAX_AGE_MS = 60 * SECOND;
export const BACKOFF_BASE_MS = 30 * SECOND;
export const BACKOFF_CAP_MS = HOUR;
/**
 * Attempt ceiling for rows whose upstream answered with something unparseable
 * (Last.fm `malformed`): retried like a transient failure, because one bad
 * answer is not a payload refusal, but not until expiry, because it is not
 * proven transient either. This keeps the policy those answers had before the
 * retry-until-expiry change (ADR §12.3 amendment).
 */
export const MAX_MALFORMED_ATTEMPTS = 8;
/** The counters row that pauses all Last.fm forwarding (ADR §12.3). */
export const LASTFM_KEY_REJECTED = 'lastfm_key_rejected';
/** The longest `last_error` kept on a row. */
export const MAX_ROW_ERROR_CHARS = 512;

export const EXPIRY_MS: Readonly<Record<LinkService, number>> = {
  lastfm: LASTFM_EXPIRY_MS,
  listenbrainz: LISTENBRAINZ_EXPIRY_MS,
};

/** 30 s·2^n + U[0, 25%], capped at 1 h (ADR §12.3). `n` is the attempts already made. */
export function forwardBackoffMs(n: number, random: Random): number {
  const base = BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, n), 20);
  return Math.min(BACKOFF_CAP_MS, Math.floor(base + random.float() * base * 0.25));
}

/** The next 00:00 UTC strictly after `now`. */
export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY) + 1) * DAY;
}

// ---------------------------------------------------------------------------
// Payloads

/** A track as the forward clients send it. */
export interface ForwardTrack {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  durationSeconds?: number;
  trackNumber?: number;
  recordingMbid?: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  artistMbids?: string[];
  isrc?: string;
  submissionClient?: string;
  musicService?: string;
}

export interface ForwardListen extends ForwardTrack {
  /** UNIX seconds. */
  timestamp: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Optional text a destination can accept. ListenBrainz rejects a listen with a
 * decoded U+0000 anywhere in it (its recursive unicode-null check covers
 * additional_info), and the record validators admit NUL in optional fields, so
 * such a field is left out here, at the one boundary every queued scrobble,
 * now-playing and love payload passes through, rather than failing the listen.
 */
function optStr(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined || text.includes('\u0000') ? undefined : text;
}

function posInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function trackOf(src: Record<string, unknown>): ForwardTrack | null {
  const artist = str(src.artist);
  const track = str(src.track);
  if (artist === undefined || track === undefined) return null;
  const out: ForwardTrack = { artist, track };
  const set = <K extends keyof ForwardTrack>(key: K, value: ForwardTrack[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set('album', optStr(src.album));
  set('albumArtist', optStr(src.albumArtist));
  set('durationSeconds', posInt(src.durationSeconds) ?? posInt(src.duration));
  set('trackNumber', posInt(src.trackNumber));
  set('recordingMbid', optStr(src.recordingMbid) ?? optStr(src.mbid));
  set('releaseMbid', optStr(src.releaseMbid));
  set('releaseGroupMbid', optStr(src.releaseGroupMbid));
  if (Array.isArray(src.artistMbids) && src.artistMbids.every((m) => typeof m === 'string' && !m.includes('\u0000'))) {
    out.artistMbids = [...(src.artistMbids as string[])];
  }
  set('isrc', optStr(src.isrc));
  set('submissionClient', optStr(src.submissionClient));
  set('musicService', optStr(src.musicService));
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The listen of a scrobble row, or null when the payload is unusable. */
export function scrobblePayload(row: Pick<ForwardOutboxRow, 'payload_json'>): ForwardListen | null {
  const doc = parseJson(row.payload_json);
  const listen = isObject(doc) ? doc.listen : null;
  if (!isObject(listen)) return null;
  const track = trackOf(listen);
  if (track === null) return null;
  let timestamp: number | undefined;
  const ts = listen.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) timestamp = Math.floor(ts);
  else if (typeof ts === 'string' && /^\d{1,12}(\.\d+)?$/.test(ts)) timestamp = Math.floor(Number(ts));
  else if (typeof listen.listenedAt === 'string') {
    const ms = Date.parse(listen.listenedAt);
    if (Number.isFinite(ms) && ms >= 0) timestamp = Math.floor(ms / 1000);
  }
  if (timestamp === undefined || !Number.isSafeInteger(timestamp)) return null;
  return { ...track, timestamp };
}

/** The track of a now-playing row, or null when the payload is unusable. */
export function nowPlayingPayload(row: Pick<ForwardOutboxRow, 'payload_json'>): ForwardTrack | null {
  const doc = parseJson(row.payload_json);
  if (!isObject(doc)) return null;
  return isObject(doc.track) ? trackOf(doc.track) : trackOf(doc);
}

/** The track of a love or unlove row, or null when the payload is unusable. */
export function lovePayload(row: Pick<ForwardOutboxRow, 'payload_json'>): ForwardTrack | null {
  const doc = parseJson(row.payload_json);
  return isObject(doc) ? trackOf(doc) : null;
}

/** Whether a queued love came from historical backfill (scoped consumer policy). */
export function loveRowOrigin(row: Pick<ForwardOutboxRow, 'payload_json'>): string | null {
  const doc = parseJson(row.payload_json);
  return isObject(doc) && typeof doc.origin === 'string' ? doc.origin : null;
}

// ---------------------------------------------------------------------------
// Reading rows

/** A queued row with its rowid (the insertion order). */
export type QueuedRow = ForwardOutboxRow & { seq: number };

const ROW_COLUMNS =
  'rowid AS seq,id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms,priority';

/** Due queued rows of `link` of `kind`, live priority before history. */
export function dueRows(
  db: Db,
  linkId: string,
  generation: number,
  kind: ForwardKind,
  now: number,
  limit: number,
): QueuedRow[] {
  return db.all<QueuedRow>(
    `SELECT ${ROW_COLUMNS} FROM forward_outbox
     WHERE link_id = ? AND generation=? AND kind=? AND state='queued' AND due_at<=?
     ORDER BY priority, created_at_ms, rowid LIMIT ?`,
    linkId,
    generation,
    kind,
    now,
    limit,
  );
}

/**
 * The oldest queued love/unlove row of `link` (due or not): only it may be
 * sent, so toggles reach the upstream in order.
 */
export function loveHead(db: Db, linkId: string, generation: number): QueuedRow | null {
  return db.one<QueuedRow>(
    `SELECT ${ROW_COLUMNS} FROM forward_outbox
     WHERE link_id = ? AND generation=? AND kind IN ('love', 'unlove') AND state = 'queued'
     ORDER BY created_at_ms, rowid LIMIT 1`,
    linkId,
    generation,
  );
}

/** Counts of rows by state, for one link or all (tests and admin views). */
export function rowStates(db: Db, linkId?: string): Partial<Record<ForwardOutboxRow['state'], number>> {
  const rows =
    linkId === undefined
      ? db.all<{ state: ForwardOutboxRow['state']; n: number }>(
          `SELECT f.state,count(*) AS n FROM forward_outbox AS f
           JOIN linked_accounts AS link ON link.id=f.link_id AND link.generation=f.generation GROUP BY f.state`,
        )
      : db.all<{ state: ForwardOutboxRow['state']; n: number }>(
          `SELECT f.state,count(*) AS n FROM forward_outbox AS f
           JOIN linked_accounts AS link ON link.id=f.link_id AND link.generation=f.generation
           WHERE f.link_id=? GROUP BY f.state`,
          linkId,
        );
  const out: Partial<Record<ForwardOutboxRow['state'], number>> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// Settling rows

function clip(text: string): string {
  return [...text].slice(0, MAX_ROW_ERROR_CHARS).join('');
}

function inList(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ');
}

/** Ids per statement, under the Db facade's 100 bound parameters (do/db.ts MAX_SQL_PARAMS). */
const IDS_PER_STATEMENT = 90;

/** Exact durable rows changed by a terminal transition, for same-transaction consumers. */
export interface SettledForwardRow {
  id: string;
  link_id: string;
  generation: number;
  did: string;
  kind: ForwardKind;
  dedupe_key: string;
  state: 'sent' | 'ignored' | 'failed' | 'expired';
  love_artist_key: string | null;
  love_track_key: string | null;
  created_at_ms: number;
}

/** Synchronous same-transaction consumer for exact terminal transition rows. */
export type SettledForwardRowsHook = (rows: readonly SettledForwardRow[], now: number) => void;

const SETTLED_COLUMNS = 'id,link_id,generation,did,kind,dedupe_key,state,love_artist_key,love_track_key,created_at_ms';

function notifySettled(
  db: Db,
  onSettled: SettledForwardRowsHook | undefined,
  rows: readonly SettledForwardRow[],
  now: number,
): void {
  if (rows.length === 0) return;
  if (onSettled !== undefined) {
    const result: unknown = onSettled(rows, now);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    )
      throw new TypeError('terminal settlement hook must be synchronous');
  }
  settleApiLoveRecipientRows(db, rows, now);
}

/** Runs `update` over `ids` in slices that fit one statement, in one transaction. */
function inSlices(db: Db, ids: readonly string[], update: (slice: readonly string[]) => void): void {
  if (ids.length === 0) return;
  db.tx(() => {
    for (let i = 0; i < ids.length; i += IDS_PER_STATEMENT) update(ids.slice(i, i + IDS_PER_STATEMENT));
  });
}

/** Sets the state of `ids` (a terminal state, or held), recording `error`. */
export function settleRows(
  db: Db,
  ids: readonly string[],
  state: 'sent' | 'ignored' | 'failed' | 'expired',
  now: number,
  error: string | null = null,
  countAttempt = true,
  generation?: number,
  onSettled?: SettledForwardRowsHook,
): void {
  settleRowsReturning(db, ids, state, now, error, countAttempt, generation, onSettled);
}

/** Same transition as settleRows, returning exactly the generation-fenced rows changed. */
export function settleRowsReturning(
  db: Db,
  ids: readonly string[],
  state: 'sent' | 'ignored' | 'failed' | 'expired',
  now: number,
  error: string | null = null,
  countAttempt = true,
  generation?: number,
  onSettled?: SettledForwardRowsHook,
): SettledForwardRow[] {
  const changed: SettledForwardRow[] = [];
  inSlices(db, ids, (slice) => {
    const sql = `UPDATE forward_outbox SET state = ?, last_error = ?, attempts = attempts + ?, updated_at_ms = ?
       WHERE id IN (${inList(slice)}) AND state='queued'
         AND generation=coalesce(?,generation)
         AND EXISTS (SELECT 1 FROM linked_accounts AS link
                     WHERE link.id=forward_outbox.link_id AND link.generation=forward_outbox.generation)`;
    const params = [
      state,
      error === null ? null : clip(error),
      countAttempt ? 1 : 0,
      now,
      ...slice,
      generation ?? null,
    ];
    const rows = db.all<SettledForwardRow>(`${sql} RETURNING ${SETTLED_COLUMNS}`, ...params);
    changed.push(...rows);
    if (state === 'sent') recordLoveDelivery(db, rows satisfies SentLoveRow[], now);
    notifySettled(db, onSettled, rows, now);
  });
  return changed;
}

/** Queues `ids` again at `dueAt`; `countAttempt` adds one to their attempts. */
export function requeueRows(
  db: Db,
  ids: readonly string[],
  dueAt: number,
  now: number,
  error: string | null,
  countAttempt: boolean,
  generation?: number,
): void {
  inSlices(db, ids, (slice) =>
    db.run(
      `UPDATE forward_outbox SET due_at = ?, last_error = ?, attempts = attempts + ?, updated_at_ms = ?
       WHERE id IN (${inList(slice)}) AND state='queued'
         AND generation=coalesce(?,generation)
         AND EXISTS (SELECT 1 FROM linked_accounts AS link
                     WHERE link.id=forward_outbox.link_id AND link.generation=forward_outbox.generation)`,
      dueAt,
      error === null ? null : clip(error),
      countAttempt ? 1 : 0,
      now,
      ...slice,
      generation ?? null,
    ),
  );
}

/** Queues each row again after its own backoff (attempts counted). */
export function backoffRows(db: Db, rows: readonly QueuedRow[], now: number, random: Random, error: string): void {
  retryRowsAt(db, rows, now, (row) => now + forwardBackoffMs(row.attempts, random), error);
}

/**
 * Backs rows off after a malformed upstream answer; a row whose attempts reach
 * MAX_MALFORMED_ATTEMPTS fails as `retry_exhausted` instead.
 */
export function backoffMalformedRows(
  db: Db,
  rows: readonly QueuedRow[],
  now: number,
  random: Random,
  error: string,
): void {
  db.tx(() => {
    for (const row of rows) {
      if (row.attempts + 1 >= MAX_MALFORMED_ATTEMPTS)
        settleRows(db, [row.id], 'failed', now, 'retry_exhausted', true, row.generation);
      else requeueRows(db, [row.id], now + forwardBackoffMs(row.attempts, random), now, error, true, row.generation);
    }
  });
}

/** Retries rows after an attempted transient failure until their age expiry. */
export function retryRowsAt(
  db: Db,
  rows: readonly QueuedRow[],
  now: number,
  dueAt: (row: QueuedRow) => number,
  error: string,
): void {
  db.tx(() => {
    for (const row of rows) requeueRows(db, [row.id], dueAt(row), now, error, true, row.generation);
  });
}

/** Holds every queued row of a revoked link. Returns how many were held. */
export function holdLinkRows(db: Db, linkId: string, now: number, generation?: number): number {
  const expected =
    generation ??
    db.one<{ generation: number }>('SELECT generation FROM linked_accounts WHERE id=?', linkId)?.generation;
  if (expected === undefined) return 0;
  return db.run(
    `UPDATE forward_outbox SET state='held',updated_at_ms=? WHERE link_id=? AND generation=? AND state='queued'
       AND EXISTS (SELECT 1 FROM linked_accounts AS link WHERE link.id=? AND link.generation=?)`,
    now,
    linkId,
    expected,
    linkId,
    expected,
  ).rowsWritten;
}

/** Queues a relinked link's held rows without bypassing their original due time. */
export function resumeHeldRows(db: Db, linkId: string, now: number, generation?: number): number {
  const expected =
    generation ??
    db.one<{ generation: number }>('SELECT generation FROM linked_accounts WHERE id=?', linkId)?.generation;
  if (expected === undefined) return 0;
  return db.run(
    `UPDATE forward_outbox SET state='queued',due_at=max(due_at,?),updated_at_ms=?,
       love_lane=CASE WHEN kind IN ('love','unlove') THEN NULL ELSE love_lane END
     WHERE link_id=? AND generation=? AND state='held'
       AND EXISTS (SELECT 1 FROM linked_accounts AS link WHERE link.id=? AND link.generation=?)`,
    now,
    now,
    linkId,
    expected,
    linkId,
    expected,
  ).rowsWritten;
}

export interface ExpiryReport {
  /** Queued rows past their service's age limit. */
  aged: number;
  /** Now-playing rows older than 60 s. */
  staleNowPlaying: number;
  /** Held rows past their retention. */
  held: number;
  /** More expired work remains; forwarding is paused until a later bounded sweep drains it. */
  pending?: boolean;
}

export const MAX_EXPIRY_TRANSITIONS_PER_RUN = 128;
export const EXPIRY_SELECT_SQL = `SELECT rowid AS seq,generation,love_artist_key,love_track_key FROM forward_outbox INDEXED BY forward_outbox_link_expiry
  WHERE link_id=? AND state='queued' AND kind=? AND created_at_ms<? ORDER BY created_at_ms,rowid LIMIT ?`;
export const HELD_EXPIRY_SELECT_SQL = `SELECT rowid AS seq FROM forward_outbox INDEXED BY forward_outbox_held_expiry
  WHERE state='held' AND updated_at_ms<? ORDER BY updated_at_ms,rowid LIMIT ?`;
export const EXPIRY_PROBE_SQL = `SELECT rowid FROM forward_outbox INDEXED BY forward_outbox_link_expiry
  WHERE link_id=? AND state='queued' AND kind=? AND created_at_ms<? LIMIT 1`;
export const STALE_NOWPLAYING_PROBE_SQL = `SELECT rowid FROM forward_outbox INDEXED BY forward_outbox_link_expiry
  WHERE link_id=? AND state='queued' AND kind='nowplaying' AND created_at_ms<? LIMIT 1`;
export const HELD_EXPIRY_PROBE_SQL = `SELECT rowid FROM forward_outbox INDEXED BY forward_outbox_held_expiry
  WHERE state='held' AND updated_at_ms<? LIMIT 1`;

/** Expires what is too old to send with a fixed transition and probe budget. */
export function expireRows(db: Db, now: number, onSettled?: SettledForwardRowsHook): ExpiryReport {
  return db.tx(() => {
    let aged = 0;
    let staleNowPlaying = 0;
    let held = 0;
    let remaining = MAX_EXPIRY_TRANSITIONS_PER_RUN;
    const links = db.all<{ id: string; service: LinkService }>('SELECT id,service FROM linked_accounts ORDER BY id');
    const expireSelected = (
      linkId: string,
      kind: ForwardKind,
      cutoff: number,
      error: string,
      bucket: 'aged' | 'stale',
    ): number => {
      if (remaining === 0) return 0;
      const selected = db.all<{ seq: number }>(EXPIRY_SELECT_SQL, linkId, kind, cutoff, remaining);
      const rows: SettledForwardRow[] = [];
      for (const row of selected) {
        rows.push(
          ...db.all<SettledForwardRow>(
            `UPDATE forward_outbox SET state='expired',last_error=?,updated_at_ms=? WHERE rowid=? AND state='queued'
             RETURNING ${SETTLED_COLUMNS}`,
            error,
            now,
            row.seq,
          ),
        );
      }
      for (const row of rows) {
        if ((kind === 'love' || kind === 'unlove') && row.love_artist_key !== null && row.love_track_key !== null) {
          touchLoveLane(db, {
            linkId,
            generation: row.generation,
            artistKey: row.love_artist_key,
            trackKey: row.love_track_key,
            priority: 0,
            dueAt: now,
            createdAtMs: now,
          });
        }
      }
      notifySettled(db, onSettled, rows, now);
      remaining -= selected.length;
      if (bucket === 'aged') aged += rows.length;
      else staleNowPlaying += rows.length;
      return selected.length;
    };
    for (const link of links) {
      if (remaining === 0) break;
      expireSelected(link.id, 'nowplaying', now - NOW_PLAYING_MAX_AGE_MS, 'stale', 'stale');
    }
    for (const link of links) {
      if (remaining === 0) break;
      for (const kind of ['scrobble', 'nowplaying', 'love', 'unlove'] as const) {
        expireSelected(link.id, kind, now - EXPIRY_MS[link.service], 'expired', 'aged');
        if (remaining === 0) break;
      }
    }
    if (remaining > 0) {
      const selected = db.all<{ seq: number }>(HELD_EXPIRY_SELECT_SQL, now - HELD_RETENTION_MS, remaining);
      const rows = selected.flatMap((row) =>
        db.all<SettledForwardRow>(
          `UPDATE forward_outbox SET state='expired',last_error='held_expired',updated_at_ms=?
           WHERE rowid=? AND state='held' RETURNING ${SETTLED_COLUMNS}`,
          now,
          row.seq,
        ),
      );
      notifySettled(db, onSettled, rows, now);
      held = rows.length;
      remaining -= selected.length;
    }
    const pending =
      links.some((link) => {
        if (db.one(STALE_NOWPLAYING_PROBE_SQL, link.id, now - NOW_PLAYING_MAX_AGE_MS)) return true;
        return (['scrobble', 'nowplaying', 'love', 'unlove'] as const).some(
          (kind) => db.one(EXPIRY_PROBE_SQL, link.id, kind, now - EXPIRY_MS[link.service]) !== null,
        );
      }) || db.one(HELD_EXPIRY_PROBE_SQL, now - HELD_RETENTION_MS) !== null;
    return { aged, staleNowPlaying, held, pending };
  });
}

// ---------------------------------------------------------------------------
// The global Last.fm pause (codes 10 and 26)

/** When our Last.fm key was rejected (epoch ms), or null when forwarding is not paused. */
export function lastfmKeyRejectedAt(db: Db): number | null {
  return (
    db.one<{ value: number }>("SELECT value FROM counters WHERE name = ? AND label = ''", LASTFM_KEY_REJECTED)?.value ??
    null
  );
}

/** Pauses all Last.fm forwarding; the value is the latest rejection, so the next probe waits from it. */
export function markLastfmKeyRejected(db: Db, now: number): void {
  db.run(
    `INSERT INTO counters(name, label, value) VALUES (?, '', ?)
     ON CONFLICT(name, label) DO UPDATE SET value = excluded.value`,
    LASTFM_KEY_REJECTED,
    now,
  );
}

/** Lifts the pause (a request with the key succeeded). True when it was set. */
export function clearLastfmKeyRejected(db: Db): boolean {
  return db.run("DELETE FROM counters WHERE name = ? AND label = ''", LASTFM_KEY_REJECTED).rowsWritten > 0;
}
