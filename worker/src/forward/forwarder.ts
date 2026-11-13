// Delivery of forward rows to linked accounts (ADR 0005 §12.3, §3.3 `forward`
// timer; N3-08). Rows are queued by N2-05 in the acceptance transaction
// (outbox/forward-enqueue.ts); `runForward` sends them.
//
// One run:
// 1. Expires what is too old (forward-outbox.ts `expireRows`): Last.fm rows
//    after 13 days, ListenBrainz rows after 30, now playing after 60 s, held
//    rows 30 days after they were held.
// 2. Sends at most MAX_REQUESTS_PER_RUN (5) upstream requests. Each pick
//    takes the active link with the oldest due row whose upstream is free:
//    Last.fm needs the global 1 request/s token (upstream-pacing.ts, shared
//    with imports, forwarding first) and no key pause; ListenBrainz needs the
//    link's own 1 request/s token and no rate-limit hold. For that link it
//    sends, in this order of preference:
//    - its newest due now playing (older ones are superseded), once;
//    - otherwise whichever is older of its due scrobbles and the next due
//      first due durable love lane. Lane hints keep selection fair and bounded;
//      the canonical oldest-row probe remains authoritative for each key.
//      Last.fm scrobbles go as one signed track.scrobble of ≤ 50 rows, oldest
//      first; ListenBrainz sends one due listen as `single` and a backlog as
//      `import` of ≤ 100; a row whose import was refused with 400 is retried
//      alone, so one bad listen never fails the others.
//    The current time is re-read after each request.
// 3. Returns when it should run next: the earliest instant an active link
//    has a due row and a free upstream, or null when nothing is queued.
//
// Outcomes (ADR §12.3):
//
// | upstream answer                         | rows                                    | link / global          |
// |-----------------------------------------|-----------------------------------------|------------------------|
// | Last.fm ok, item code 0                 | sent                                    |                        |
// | Last.fm item code 5                     | queued at the next 00:00 UTC            |                        |
// | Last.fm other item code                 | ignored (`ignored_<code>`)              |                        |
// | Last.fm 8, 11, 16, 29; HTTP 5xx, 429;   | backoff 30 s·2^n + U[0,25%], ≤ 6 h      | 29/429 hold the global |
// |   network or redirect; malformed answer |                                         |   bucket (Retry-After) |
// | Last.fm 9 or 4                          | held                                    | link revoked           |
// | Last.fm 10 or 26                        | stay queued                             | all Last.fm paused     |
// | Last.fm other error code, HTTP 4xx      | failed                                  |                        |
// | ListenBrainz 2xx                        | sent                                    |                        |
// | ListenBrainz 401                        | held                                    | link revoked           |
// | ListenBrainz 429                        | queued again after X-RateLimit-Reset-In | link's key held        |
// | ListenBrainz 400                        | failed with the upstream error          |                        |
// | ListenBrainz 5xx, network               | backoff                                 |                        |
// | ListenBrainz other 4xx                  | failed                                  |                        |
//
// Now playing is sent once: any failure makes it `failed`, never retried
// (a revocation or key rejection still applies to the link or globally).
// ListenBrainz feedback goes by `recording_mbid`. An unlove carries only the
// track; its MBID is the one the track was loved with, found locally
// (`knownRecordingMbid`) and recorded on the row. A love, or an unlove whose
// track has no known MBID, is `ignored` (`no_recording_mbid`) without a request.
//
// The Last.fm key pause (10/26) is the `lastfm_key_rejected` counter, shown
// by adminStatus. While it is set no Last.fm request is sent, except one
// probe an hour after the latest rejection; a probe that succeeds lifts it.
//
// Delivery is at least once: a request that timed out after the upstream
// accepted it is sent again (neither service has an idempotency key).
// Retryable row requests stop after eight attempted requests, including
// upstream 429 responses. Local pacing waits do not consume attempts. Link
// health stores the last success/failure times and shows transient errors
// after three consecutive failures; a successful response clears that error.
//
// Every request goes through the clients (lastfm-client.ts,
// listenbrainz-client.ts), and so through policyFetch. No transaction spans
// an await, and a write after one is conditional on what was read before it:
// a revocation applies only while the link still has the refused credential
// (a relink during the request is kept, with its rows queued). Runs over one
// database never overlap: a second call while one is in flight returns at
// once (`skipped`); the `forward` extension timer serializes them in
// production.

import type { Clock, Random } from '@atmusic/core/deps';
import { albumKey, artistKey, MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { CoreExtension } from '../app/host';
import type { LinkedAccountRow } from '../app/rows';
import type { Box } from '../crypto/box';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import { enqueueTrack, matchedRecordingMbid } from '../musicbrainz/store';
import { canonicalForwardDedupeKey } from '../outbox/forward-key';
import { hasPresentTrackLove } from '../outbox/live-track-survivor';
import { nextDeleteWakeAt, runDeleteSlice } from './delete-forwarder';
import {
  backoffRows,
  clearLastfmKeyRejected,
  dueRows,
  type ExpiryReport,
  expireRows,
  type ForwardListen,
  type ForwardTrack,
  holdLinkRows,
  lastfmKeyRejectedAt,
  lovePayload,
  loveRowOrigin,
  markLastfmKeyRejected,
  nextUtcMidnight,
  nowPlayingPayload,
  type QueuedRow,
  requeueRows,
  retryRowsAt,
  scrobblePayload,
  settleRows,
} from './forward-outbox';
import { LASTFM_MAX_BATCH, type LastfmClient, type LastfmFailure, type LastfmTrack } from './lastfm-client';
import { noteLinkError, noteLinkSuccess, openLinkCredential, revokeLink } from './links';
import {
  LISTENBRAINZ_MAX_IMPORT,
  type ListenbrainzClient,
  type ListenbrainzOutcome,
  type ListenPayload,
  type ListenType,
  type TrackMetadata,
} from './listenbrainz-client';
import { deferredAuthorityStatus } from './love-coverage-authority';
import {
  HEAD_SQL,
  hasUnkeyedLoves,
  LANE_PICK_SQL,
  LOVE_KINDS,
  type QueuedRow as LoveQueuedRow,
  MAX_LOVE_FRAMING_PER_RUN,
  MAX_LOVE_LANES_PER_LINK_PER_RUN,
  noteForwardLoveCurrent,
  refreshLoveLane,
  touchLoveLane,
  UNFRAMED_SQL,
  UNKEYED_SQL,
} from './love-lanes';
import { loveFallbackKey, lovePrimaryKey, resolveLoveRecording } from './love-recording';
import { indexForwardLoveTarget, indexLoveOperationTarget, normalizeForwardLoveKeys } from './love-recording-targets';
import { refreshForwardStorageStats } from './storage-stats';
import { LASTFM_MIN_INTERVAL_MS, listenbrainzPacingKey, type UpstreamPacing } from './upstream-pacing';

/** Upstream requests per `forward` run (ADR §3.3). */
export const MAX_REQUESTS_PER_RUN = 5;
/** While the key is rejected, one probe this long after the latest rejection. */
export const KEY_REJECTED_PROBE_MS = 3_600_000;
/** The `forward` timer looks for new rows at least this often. */
export const FORWARD_IDLE_POLL_MS = 10_000;
/** Last error of a row whose ListenBrainz import was refused: it is sent alone next. */
export const BATCH_REJECTED = 'batch_rejected';
/** Local candidate work is bounded independently from upstream request count. */
export const MAX_LOCAL_WORK_PER_RUN = MAX_LOVE_LANES_PER_LINK_PER_RUN;
export { MAX_LOVE_FRAMING_PER_RUN };

const RETRYABLE_LASTFM_CODES: ReadonlySet<number> = new Set([8, 11, 16, 29]);
const REVOKING_LASTFM_CODES: ReadonlySet<number> = new Set([4, 9]);
const KEY_LASTFM_CODES: ReadonlySet<number> = new Set([10, 26]);
const MAX_RETRY_AFTER_MS = 6 * 3_600_000;

/** Everything one run needs. Built once by the composition (http/links.ts linksFeature). */
export interface ForwardRuntime {
  db: Db;
  clock: Clock;
  random: Random;
  log: Logger;
  box: Box;
  pacing: UpstreamPacing;
  /** Null without the owner's Last.fm key: Last.fm rows wait (and expire). */
  lastfm: LastfmClient | null;
  listenbrainz: ListenbrainzClient;
  /** Actual OAuth restore/scope availability used before staged pull acceptance. */
  pullWriterAvailability?: (did: string) => Promise<import('../sync/pull-writer').PullWriterAvailability>;
}

export interface ForwardReport {
  /** True when another run over the same database was in flight. */
  skipped: boolean;
  /** Upstream requests sent. */
  requests: number;
  /** ListenBrainz links that used the shared bucket for a live request this run. */
  listenbrainzLinkIds: ReadonlySet<string>;
  expired: ExpiryReport | null;
  /** When to run next (epoch ms), or null when nothing is queued. */
  nextDueMs: number | null;
}

type LinkRow = LinkedAccountRow;

type Job =
  | { link: LinkRow; kind: 'nowplaying'; rows: [QueuedRow]; track: ForwardTrack }
  | { link: LinkRow; kind: 'scrobble'; rows: QueuedRow[]; listens: ForwardListen[] }
  | {
      link: LinkRow;
      kind: 'love' | 'unlove';
      rows: [QueuedRow];
      track: ForwardTrack;
      lane: { artistKey: string; trackKey: string };
    };

const lbKey = listenbrainzPacingKey;

function generationIsCurrent(db: Db, link: LinkRow): boolean {
  return (
    db.one<{ generation: number }>('SELECT generation FROM linked_accounts WHERE id=?', link.id)?.generation ===
    link.generation
  );
}

function ids(rows: readonly QueuedRow[]): string[] {
  return rows.map((r) => r.id);
}

function settleJobRows(
  db: Db,
  job: Job,
  state: 'sent' | 'ignored' | 'failed' | 'expired',
  now: number,
  error: string | null = null,
  countAttempt = true,
): void {
  settleRows(db, ids(job.rows), state, now, error, countAttempt, job.link.generation);
}

function requeueJobRows(
  db: Db,
  job: Job,
  dueAt: number,
  now: number,
  error: string | null,
  countAttempt: boolean,
): void {
  requeueRows(db, ids(job.rows), dueAt, now, error, countAttempt, job.link.generation);
}

/**
 * Revokes `link` and holds its queued rows, inside the caller's transaction.
 * `link` is the row read before the request was sent, so this is
 * conditional on that state: when the owner relinked while the request was
 * in flight (a new credential, status active again), the refusal was of the
 * old credential and the fresh link and its rows are left as they are.
 */
function revokeAndHold(db: Db, link: LinkRow, error: string, now: number): void {
  if (revokeLink(db, link, error, now)) holdLinkRows(db, link.id, now, link.generation);
}

// ---------------------------------------------------------------------------
// Picking

/** Whether `link`'s upstream may take a request at `now`. */
function upstreamFree(rt: ForwardRuntime, link: LinkRow, now: number): boolean {
  if (link.service === 'lastfm') {
    if (rt.lastfm === null) return false;
    const rejected = lastfmKeyRejectedAt(rt.db);
    if (rejected !== null && now < rejected + KEY_REJECTED_PROBE_MS) return false;
    return rt.pacing.lastfmAvailableAt('forward', now) <= now;
  }
  return rt.pacing.listenbrainzAvailableAt(lbKey(link)) <= now;
}

/** When `link`'s upstream is next free (−∞ when now). */
function upstreamFreeAt(rt: ForwardRuntime, link: LinkRow, now: number): number {
  if (link.service === 'lastfm') {
    const rejected = lastfmKeyRejectedAt(rt.db);
    const probe = rejected === null ? Number.NEGATIVE_INFINITY : rejected + KEY_REJECTED_PROBE_MS;
    return Math.max(probe, rt.pacing.lastfmAvailableAt('forward', now));
  }
  return rt.pacing.listenbrainzAvailableAt(lbKey(link));
}

/** Parses rows; unusable payloads are settled `failed` (no attempt) and dropped. */
function parsed<T>(
  rt: ForwardRuntime,
  link: LinkRow,
  rows: QueuedRow[],
  parse: (row: QueuedRow) => T | null,
  now: number,
): Array<[QueuedRow, T]> {
  const out: Array<[QueuedRow, T]> = [];
  const bad: string[] = [];
  for (const row of rows) {
    const value = parse(row);
    if (value === null) bad.push(row.id);
    else out.push([row, value]);
  }
  if (bad.length > 0)
    rt.db.tx(() => {
      noteLinkError(rt.db, link, 'invalid_payload', now, true);
      settleRows(rt.db, bad, 'failed', now, 'invalid_payload', false, link.generation);
    });
  return out;
}

function nowPlayingJob(rt: ForwardRuntime, link: LinkRow, now: number): Job | null {
  const rows = dueRows(rt.db, link.id, link.generation, 'nowplaying', now, 50);
  if (rows.length === 0) return null;
  // Only the newest is current; older ones are superseded.
  const newest = rows[rows.length - 1] as QueuedRow;
  settleRows(rt.db, ids(rows.slice(0, -1)), 'expired', now, 'superseded', false);
  const [entry] = parsed(rt, link, [newest], nowPlayingPayload, now);
  return entry === undefined ? null : { link, kind: 'nowplaying', rows: [entry[0]], track: entry[1] };
}

function scrobbleJob(rt: ForwardRuntime, link: LinkRow, now: number): Job | null {
  const limit = link.service === 'lastfm' ? LASTFM_MAX_BATCH : LISTENBRAINZ_MAX_IMPORT;
  for (;;) {
    const rows = dueRows(rt.db, link.id, link.generation, 'scrobble', now, limit);
    if (rows.length === 0) return null;
    let batch = rows;
    if (link.service === 'listenbrainz') {
      const first = rows[0] as QueuedRow;
      batch = first.last_error === BATCH_REJECTED ? [first] : rows.filter((r) => r.last_error !== BATCH_REJECTED);
    }
    const entries = parsed(rt, link, batch, scrobblePayload, now);
    if (entries.length === 0) continue; // every row was unusable and is now failed
    return { link, kind: 'scrobble', rows: entries.map(([r]) => r), listens: entries.map(([, l]) => l) };
  }
}

/** Frames legacy, resumed and raw-inserted love rows with a fixed per-link budget. */
function frameLoveRows(rt: ForwardRuntime, link: LinkRow, now: number): { pending: boolean } {
  return rt.db.tx(() => {
    let budget = MAX_LOVE_FRAMING_PER_RUN;
    for (const kind of LOVE_KINDS) {
      while (budget > 0) {
        const rows = rt.db.all<LoveQueuedRow>(UNKEYED_SQL, link.id, link.generation, kind, budget);
        if (rows.length === 0) break;
        for (const row of rows) {
          budget -= 1;
          const track = lovePayload(row);
          let keys: readonly [string, string] | null = null;
          if (track !== null) {
            try {
              keys = trackKey(track.artist, track.track);
            } catch (error) {
              if (!(error instanceof MusicKeyError)) throw error;
            }
          }
          if (track === null || keys === null) {
            noteLinkError(rt.db, link, 'invalid_payload', now, true);
            settleRows(rt.db, [row.id], 'failed', now, 'invalid_payload', false, link.generation);
            continue;
          }
          const [artistKeyValue, trackKeyValue] = keys;
          rt.db.run(
            "UPDATE forward_outbox SET love_artist_key=?,love_track_key=?,love_lane=1 WHERE rowid=? AND state='queued'",
            artistKeyValue,
            trackKeyValue,
            row.seq,
          );
          touchLoveLane(rt.db, {
            linkId: link.id,
            generation: link.generation,
            artistKey: artistKeyValue,
            trackKey: trackKeyValue,
            priority: row.priority as 0 | 1,
            dueAt: row.due_at,
            createdAtMs: row.created_at_ms,
          });
          noteForwardLoveCurrent(rt.db, link.id, artistKeyValue, trackKeyValue, row.seq);
        }
      }
    }
    for (const kind of LOVE_KINDS) {
      while (budget > 0) {
        const rows = rt.db.all<LoveQueuedRow>(UNFRAMED_SQL, link.id, link.generation, kind, budget);
        if (rows.length === 0) break;
        for (const row of rows) {
          budget -= 1;
          rt.db.run("UPDATE forward_outbox SET love_lane=1 WHERE rowid=? AND state='queued'", row.seq);
          touchLoveLane(rt.db, {
            linkId: link.id,
            generation: link.generation,
            artistKey: row.love_artist_key!,
            trackKey: row.love_track_key!,
            priority: row.priority as 0 | 1,
            dueAt: row.due_at,
            createdAtMs: row.created_at_ms,
          });
        }
      }
    }
    const pending = LOVE_KINDS.some(
      (kind) =>
        rt.db.all(UNKEYED_SQL, link.id, link.generation, kind, 1).length > 0 ||
        rt.db.all(UNFRAMED_SQL, link.id, link.generation, kind, 1).length > 0,
    );
    return { pending };
  });
}

function loveJob(rt: ForwardRuntime, link: LinkRow, now: number, budget: { remaining: number }): Job | null {
  if (hasUnkeyedLoves(rt.db, link.id, link.generation)) return null;
  for (const priority of [0, 1] as const) {
    while (budget.remaining > 0) {
      const lanes = rt.db.all<{
        rowid: number;
        love_artist_key: string;
        love_track_key: string;
        priority: number;
        due_at: number;
        head_created_at_ms: number;
      }>(LANE_PICK_SQL, link.id, link.generation, priority, now, 1);
      if (lanes.length === 0) break;
      // Charge fetched rows, including candidates skipped after revalidation.
      budget.remaining -= lanes.length;
      for (const lane of lanes) {
        const head = rt.db.one<QueuedRow>(
          HEAD_SQL,
          link.id,
          link.generation,
          lane.love_artist_key,
          lane.love_track_key,
        );
        if (head === null) {
          rt.db.run('DELETE FROM forward_love_lanes WHERE rowid=?', lane.rowid);
          continue;
        }
        if (
          head.priority !== lane.priority ||
          head.due_at !== lane.due_at ||
          head.created_at_ms !== lane.head_created_at_ms
        ) {
          rt.db.run(
            `UPDATE forward_love_lanes SET priority=?,due_at=?,head_created_at_ms=? WHERE rowid=?`,
            head.priority,
            head.due_at,
            head.created_at_ms,
            lane.rowid,
          );
          if (head.due_at > now || head.priority !== priority) continue;
        }
        const [entry] = parsed(rt, link, [head], lovePayload, now);
        if (entry === undefined) {
          refreshLoveLane(rt.db, link.id, link.generation, lane.love_artist_key, lane.love_track_key);
          continue;
        }
        const job: Job = {
          link,
          kind: head.kind as 'love' | 'unlove',
          rows: [head],
          track: entry[1],
          lane: { artistKey: lane.love_artist_key, trackKey: lane.love_track_key },
        };
        // Local settlement must not wait for MBID resolution or hold this key's later love.
        // execute repeats the check immediately before transport.
        if (job.kind === 'unlove' && !allowAuthorizedUnlove(rt, job, now)) {
          refreshLoveLane(rt.db, link.id, link.generation, lane.love_artist_key, lane.love_track_key);
          continue;
        }
        if (link.service === 'listenbrainz' && entry[1].recordingMbid === undefined) {
          // An unlove names only the track; the MBID its love was sent with is known locally.
          const known =
            head.kind === 'unlove' ? knownRecordingMbid(rt.db, head, entry[1]) : { mbid: null, pending: false };
          const key = {
            artistKey: artistKey(entry[1].artist),
            trackKey: trackKey(entry[1].artist, entry[1].track)[1],
            albumKey: entry[1].album ? albumKey(entry[1].artist, entry[1].album)?.[1] : '',
          };
          if (known.pending) {
            const next = now + FORWARD_IDLE_POLL_MS;
            rt.db.run(
              "UPDATE forward_outbox SET due_at=?,updated_at_ms=? WHERE id=? AND state='queued'",
              next,
              now,
              head.id,
            );
            rt.db.run('UPDATE forward_love_lanes SET due_at=? WHERE rowid=?', next, lane.rowid);
            continue;
          }
          const isBackfillLove = head.kind === 'love' && loveRowOrigin(head) === 'backfill';
          const backfillResolution = isBackfillLove ? resolveLoveRecording(rt.db, entry[1]) : null;
          const local =
            known.mbid ??
            (backfillResolution && 'mbid' in backfillResolution
              ? backfillResolution.mbid
              : matchedRecordingMbid(rt.db, key));
          if (local === null) {
            const primaryKey = isBackfillLove ? lovePrimaryKey(entry[1]) : key;
            const resolved = rt.db.one<{ status: string }>(
              'SELECT status FROM mb_tracks WHERE artist_key=? AND track_key=? AND album_key=?',
              primaryKey.artistKey,
              primaryKey.trackKey,
              primaryKey.albumKey ?? '',
            );
            if (
              (isBackfillLove && backfillResolution && 'terminal' in backfillResolution) ||
              (!isBackfillLove && resolved?.status === 'unmatched')
            ) {
              settleRows(rt.db, [head.id], 'ignored', now, 'no_recording_mbid', false);
              refreshLoveLane(rt.db, link.id, link.generation, lane.love_artist_key, lane.love_track_key);
              continue;
            }
            enqueueTrack(rt.db, primaryKey, now);
            if (isBackfillLove && resolved?.status === 'unmatched') {
              const fallback = loveFallbackKey(entry[1]);
              if (fallback !== null) enqueueTrack(rt.db, fallback, now);
            }
            const deadline = head.created_at_ms + 24 * 60 * 60 * 1000;
            if (now >= deadline) {
              settleRows(rt.db, [head.id], 'ignored', now, 'mbid_unresolved', false);
              refreshLoveLane(rt.db, link.id, link.generation, lane.love_artist_key, lane.love_track_key);
              continue;
            }
            rt.db.run(
              "UPDATE forward_outbox SET due_at=?,updated_at_ms=? WHERE id=? AND state='queued'",
              Math.min(deadline, now + 60_000),
              now,
              head.id,
            );
            rt.db.run(
              'UPDATE forward_love_lanes SET due_at=? WHERE rowid=?',
              Math.min(deadline, now + 60_000),
              lane.rowid,
            );
            continue;
          }
          entry[1].recordingMbid = local;
          withRecordingMbid(rt.db, head, local);
        }
        return job;
      }
    }
  }
  return null;
}

/** `payload_json` with a `recordingMbid` (null when it is not a JSON object). */
function payloadWithMbid(text: string, mbid: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  return JSON.stringify({ ...(doc as Record<string, unknown>), recordingMbid: mbid });
}

/** Records the resolved MBID on the row, so a retry sends the same feedback. Inside pickJob's transaction. */
function withRecordingMbid(db: Db, row: QueuedRow, mbid: string): void {
  const text = payloadWithMbid(row.payload_json, mbid);
  if (text === null) return;
  db.run(`UPDATE forward_outbox SET payload_json = ? WHERE id = ? AND state = 'queued'`, text, row.id);
  const stored = db.one<{ rowid: number; link_id: string; generation: number; created_at_ms: number }>(
    "SELECT rowid,link_id,generation,created_at_ms FROM forward_outbox WHERE id=? AND kind='love'",
    row.id,
  );
  if (stored !== null)
    indexForwardLoveTarget(db, {
      rowid: stored.rowid,
      linkId: stored.link_id,
      generation: stored.generation,
      createdAtMs: stored.created_at_ms,
      payloadJson: text,
    });
}

/** Incrementally indexes historical love.put rows; never scans an operation backlog in a dispatch transaction. */
function advanceLoveRecordingHistory(db: Db): void {
  db.run('INSERT OR IGNORE INTO forward_love_recording_history_state(singleton) VALUES(1)');
  db.run('INSERT OR IGNORE INTO forward_love_recording_targets_state(singleton) VALUES(1)');
  db.run('INSERT OR IGNORE INTO forward_love_operation_targets_state(singleton) VALUES(1)');
  db.tx(() => {
    const forwardState = db.one<{ cursor_rowid: number; complete: number }>(
      'SELECT cursor_rowid,complete FROM forward_love_recording_targets_state WHERE singleton=1',
    )!;
    if (forwardState.complete !== 1) {
      const rows = db.all<{
        rowid: number;
        link_id: string;
        generation: number;
        kind: string;
        created_at_ms: number;
        payload_json: string;
      }>(
        'SELECT rowid,link_id,generation,kind,created_at_ms,payload_json FROM forward_outbox WHERE rowid>? ORDER BY rowid LIMIT 128',
        forwardState.cursor_rowid,
      );
      for (const row of rows) {
        if (row.kind !== 'love' && row.kind !== 'unlove') continue;
        normalizeForwardLoveKeys(db, { rowid: row.rowid, linkId: row.link_id, payloadJson: row.payload_json });
        if (row.kind === 'love')
          indexForwardLoveTarget(db, {
            rowid: row.rowid,
            linkId: row.link_id,
            generation: row.generation,
            createdAtMs: row.created_at_ms,
            payloadJson: row.payload_json,
          });
      }
      db.run(
        'UPDATE forward_love_recording_targets_state SET cursor_rowid=?,complete=? WHERE singleton=1',
        rows.at(-1)?.rowid ?? forwardState.cursor_rowid,
        rows.length < 128 ? 1 : 0,
      );
    }
    const operationState = db.one<{ cursor_rowid: number; complete: number }>(
      'SELECT cursor_rowid,complete FROM forward_love_operation_targets_state WHERE singleton=1',
    )!;
    if (operationState.complete !== 1) {
      const rows = db.all<{
        rowid: number;
        did: string;
        kind: string;
        created_at_ms: number;
        record_json: string | null;
      }>(
        'SELECT rowid,did,kind,created_at_ms,record_json FROM operations WHERE rowid>? ORDER BY rowid LIMIT 128',
        operationState.cursor_rowid,
      );
      for (const row of rows) {
        if (row.kind !== 'love.put') continue;
        indexLoveOperationTarget(db, {
          rowid: row.rowid,
          did: row.did,
          createdAtMs: row.created_at_ms,
          recordJson: row.record_json,
        });
        if (row.record_json !== null) {
          const target = db.one<{ artist_key: string; track_key: string; recording_mbid: string }>(
            'SELECT artist_key,track_key,recording_mbid FROM forward_love_operation_targets WHERE operation_rowid=?',
            row.rowid,
          );
          if (target !== null)
            db.run(
              `INSERT OR IGNORE INTO forward_love_recording_history(did,artist_key,track_key,operation_rowid,recording_mbid) VALUES(?,?,?,?,?)`,
              row.did,
              target.artist_key,
              target.track_key,
              row.rowid,
              target.recording_mbid,
            );
        }
      }
      db.run(
        'UPDATE forward_love_operation_targets_state SET cursor_rowid=?,complete=? WHERE singleton=1',
        rows.at(-1)?.rowid ?? operationState.cursor_rowid,
        rows.length < 128 ? 1 : 0,
      );
      db.run(
        'UPDATE forward_love_recording_history_state SET cursor_rowid=?,complete=? WHERE singleton=1',
        rows.at(-1)?.rowid ?? operationState.cursor_rowid,
        rows.length < 128 ? 1 : 0,
      );
    }
  });
}

export const FORWARD_LOVE_RECORDING_LOOKUP_SQL = `SELECT recording_mbid FROM forward_love_recording_targets INDEXED BY forward_love_recording_targets_latest
  WHERE link_id=? AND generation=? AND artist_key=? AND track_key=? AND (created_at_ms,forward_rowid) < (?,?)
  ORDER BY created_at_ms DESC,forward_rowid DESC LIMIT 1`;
export const LOVE_RECORDING_HISTORY_LOOKUP_SQL = `SELECT operation_rowid,created_at_ms,recording_mbid FROM forward_love_operation_targets INDEXED BY forward_love_operation_targets_latest
  WHERE did=? AND artist_key=? AND track_key=? ORDER BY created_at_ms DESC,operation_rowid DESC LIMIT 128`;
export const LOVE_RECORDING_HISTORY_PAGE_SQL = `SELECT operation_rowid,created_at_ms,recording_mbid FROM forward_love_operation_targets INDEXED BY forward_love_operation_targets_latest
  WHERE did=? AND artist_key=? AND track_key=? AND (created_at_ms,operation_rowid) < (?,?)
  ORDER BY created_at_ms DESC,operation_rowid DESC LIMIT 128`;

/**
 * The recording MBID an unlove's track was loved with, or null when none is
 * known. Live unloves carry only `{artist, track}` (outbox/love-ops.ts
 * enqueueUnlove), so the MBID comes from local state, newest first:
 * 1. this link's love rows queued before the unlove (what we sent upstream);
 * 2. the DID's love intents before the unlove (`love.put` operations, which
 *    include imported loves that queue no forward row);
 * 3. the `loves` projection (loves by other apps). The unlove's own delete
 *    may already have removed ours from it, hence it comes last.
 * Matching is by the love key (outbox/love-ops.ts loveKeyOf), as unlove matches.
 */
function knownRecordingMbid(db: Db, unlove: QueuedRow, track: ForwardTrack): { mbid: string | null; pending: boolean } {
  let artistKey: string;
  let trackKeyPart: string;
  try {
    [artistKey, trackKeyPart] = trackKey(track.artist, track.track);
  } catch (error) {
    if (!(error instanceof MusicKeyError)) throw error;
    return { mbid: null, pending: false };
  }
  const forwardState = db.one<{ complete: number }>(
    'SELECT complete FROM forward_love_recording_targets_state WHERE singleton=1',
  );
  const operationState = db.one<{ complete: number }>(
    'SELECT complete FROM forward_love_operation_targets_state WHERE singleton=1',
  );
  if (forwardState?.complete !== 1 || operationState?.complete !== 1) return { mbid: null, pending: true };
  const row = db.one<{ recording_mbid: string }>(
    FORWARD_LOVE_RECORDING_LOOKUP_SQL,
    unlove.link_id,
    unlove.generation,
    artistKey,
    trackKeyPart,
    unlove.created_at_ms,
    unlove.seq,
  );
  if (row !== null) return { mbid: row.recording_mbid, pending: false };
  const operationId = canonicalForwardDedupeKey(unlove.generation, unlove.dedupe_key);
  if (operationId !== null) {
    const previous = db.one<{ rowid: number }>(
      'SELECT rowid FROM operations WHERE id=? AND did=?',
      operationId,
      unlove.did,
    );
    const progress = db.one<{ cursor_created_at_ms: number; cursor_operation_rowid: number }>(
      'SELECT cursor_created_at_ms,cursor_operation_rowid FROM forward_unlove_lookup_progress WHERE unlove_rowid=?',
      unlove.seq,
    );
    const page =
      progress === null
        ? db.all<{ operation_rowid: number; created_at_ms: number; recording_mbid: string }>(
            LOVE_RECORDING_HISTORY_LOOKUP_SQL,
            unlove.did,
            artistKey,
            trackKeyPart,
          )
        : db.all<{ operation_rowid: number; created_at_ms: number; recording_mbid: string }>(
            LOVE_RECORDING_HISTORY_PAGE_SQL,
            unlove.did,
            artistKey,
            trackKeyPart,
            progress.cursor_created_at_ms,
            progress.cursor_operation_rowid,
          );
    for (const intent of page) {
      if (previous === null || intent.operation_rowid < previous.rowid) {
        db.run('DELETE FROM forward_unlove_lookup_progress WHERE unlove_rowid=?', unlove.seq);
        return { mbid: intent.recording_mbid, pending: false };
      }
    }
    if (page.length === 128) {
      const last = page.at(-1)!;
      db.run(
        `INSERT INTO forward_unlove_lookup_progress(unlove_rowid,cursor_created_at_ms,cursor_operation_rowid) VALUES(?,?,?)
         ON CONFLICT(unlove_rowid) DO UPDATE SET cursor_created_at_ms=excluded.cursor_created_at_ms,cursor_operation_rowid=excluded.cursor_operation_rowid`,
        unlove.seq,
        last.created_at_ms,
        last.operation_rowid,
      );
      return { mbid: null, pending: true };
    }
    db.run('DELETE FROM forward_unlove_lookup_progress WHERE unlove_rowid=?', unlove.seq);
  }
  return {
    mbid:
      db.one<{ recording_mbid: string }>(
        `SELECT recording_mbid FROM loves
       WHERE did = ? AND artist_key = ? AND track_key = ? AND recording_mbid IS NOT NULL
       ORDER BY created_at DESC, uri DESC LIMIT 1`,
        unlove.did,
        artistKey,
        trackKeyPart,
      )?.recording_mbid ?? null,
    pending: false,
  };
}

const seqOf = (job: Job): [number, number, number] => [
  job.rows[0].priority,
  job.rows[0].created_at_ms,
  job.rows[0].seq,
];

function older(a: Job | null, b: Job | null): Job | null {
  if (a === null) return b;
  if (b === null) return a;
  const [ac, as] = seqOf(a);
  const [bc, bs] = seqOf(b);
  return ac < bc || (ac === bc && (as < bs || (as === bs && seqOf(a)[2] <= seqOf(b)[2]))) ? a : b;
}

/** The next job to send at `now`, or null. */
export const KIND_CANDIDATE_SQL = `SELECT min(priority) AS priority,min(created_at_ms) AS created_at_ms FROM forward_outbox INDEXED BY forward_outbox_kind_due
  WHERE link_id=? AND generation=? AND kind=? AND state='queued' AND due_at<=?`;
export const LANE_FIRST_DUE_SQL = `SELECT priority,head_created_at_ms FROM forward_love_lanes INDEXED BY forward_love_lanes_due
  WHERE link_id=? AND generation=? AND priority=? AND due_at<=? ORDER BY due_at,rowid LIMIT 1`;

/**
 * A link's due now playing jumps ahead of other links' backlog at most once per
 * this interval. All Last.fm links share one 1 request/second token, so an
 * unbounded boost would let one link that keeps a now-playing update due take
 * every token and starve other links' scrobbles, loves and imports.
 */
export const NOW_PLAYING_PRIORITY_INTERVAL_MS = 30_000;
/** When each link's now playing last took the cross-link boost, per Db handle (in memory). */
const nowPlayingBoostedAt = new WeakMap<Db, Map<string, number>>();

function pickJob(rt: ForwardRuntime, now: number, localWork: Map<string, { remaining: number }>): Job | null {
  const links = rt.db.all<LinkRow>("SELECT * FROM linked_accounts WHERE status='active' ORDER BY id");
  let boostedAt = nowPlayingBoostedAt.get(rt.db);
  if (boostedAt === undefined) {
    boostedAt = new Map();
    nowPlayingBoostedAt.set(rt.db, boostedAt);
  }
  const candidates: Array<{ link: LinkRow; priority: number; oldest: number; nowPlaying: boolean }> = [];
  for (const link of links) {
    const hints: Array<{ priority: number; created_at_ms: number | null } | null> = [];
    for (const kind of ['nowplaying', 'scrobble'] as const) {
      hints.push(rt.db.one(KIND_CANDIDATE_SQL, link.id, link.generation, kind, now));
    }
    if (!hasUnkeyedLoves(rt.db, link.id, link.generation)) {
      for (const priority of [0, 1] as const) {
        const hint = rt.db.one<{ priority: number; head_created_at_ms: number }>(
          LANE_FIRST_DUE_SQL,
          link.id,
          link.generation,
          priority,
          now,
        );
        hints.push(hint === null ? null : { priority: hint.priority, created_at_ms: hint.head_created_at_ms });
      }
    }
    const due = hints.filter(
      (hint): hint is { priority: number; created_at_ms: number } => hint !== null && hint.created_at_ms !== null,
    );
    if (due.length === 0) continue;
    const priority = Math.min(...due.map((hint) => hint.priority));
    const oldest = Math.min(...due.filter((hint) => hint.priority === priority).map((hint) => hint.created_at_ms));
    const nowPlayingHint = hints[0];
    const lastBoost = boostedAt.get(link.id);
    candidates.push({
      link,
      priority,
      oldest,
      nowPlaying:
        nowPlayingHint !== undefined &&
        nowPlayingHint !== null &&
        nowPlayingHint.created_at_ms !== null &&
        (lastBoost === undefined || now - lastBoost >= NOW_PLAYING_PRIORITY_INTERVAL_MS),
    });
  }
  // A live now-playing update is useful only while current (60 s). Let it
  // take the next Last.fm token before historical/live listen backlog, at most
  // once per NOW_PLAYING_PRIORITY_INTERVAL_MS per link; between boosts a link
  // competes, and sends, by the age of its oldest due job.
  candidates.sort(
    (a, b) =>
      Number(b.nowPlaying) - Number(a.nowPlaying) ||
      a.priority - b.priority ||
      a.oldest - b.oldest ||
      a.link.id.localeCompare(b.link.id),
  );
  for (const { link, nowPlaying } of candidates) {
    if (!upstreamFree(rt, link, now)) continue;
    let budget = localWork.get(link.id);
    if (budget === undefined) {
      budget = { remaining: MAX_LOCAL_WORK_PER_RUN };
      localWork.set(link.id, budget);
    }
    const job = rt.db.tx(() => {
      const backlog = () => older(scrobbleJob(rt, link, now), loveJob(rt, link, now, budget!));
      // Boosted: now playing goes first. Otherwise this link sends its oldest due
      // job, so the backlog row whose age won the link this turn is what spends
      // the token; it cannot keep lending that age to fresh now-playing updates.
      return nowPlaying ? (nowPlayingJob(rt, link, now) ?? backlog()) : older(nowPlayingJob(rt, link, now), backlog());
    });
    if (job !== null) {
      if (nowPlaying && job.kind === 'nowplaying') boostedAt.set(link.id, now);
      return job;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Last.fm

function lastfmTrack(t: ForwardTrack): LastfmTrack {
  const out: LastfmTrack = { artist: t.artist, track: t.track };
  if (t.album !== undefined) out.album = t.album;
  if (t.albumArtist !== undefined) out.albumArtist = t.albumArtist;
  if (t.durationSeconds !== undefined) out.duration = t.durationSeconds;
  if (t.trackNumber !== undefined) out.trackNumber = t.trackNumber;
  if (t.recordingMbid !== undefined) out.mbid = t.recordingMbid;
  return out;
}

function lastfmErrorText(out: LastfmFailure): string {
  switch (out.kind) {
    case 'error':
      return `lastfm_error_${out.code}`;
    case 'http':
      return `http_${out.httpStatus}`;
    case 'network':
      return 'network_error';
    default:
      return 'malformed_answer';
  }
}

/** Applies a failed Last.fm request to its rows, its link and the global pause. */
function lastfmFailed(rt: ForwardRuntime, job: Job, out: LastfmFailure, now: number): void {
  if (!generationIsCurrent(rt.db, job.link)) return;
  const db = rt.db;
  const once = job.kind === 'nowplaying';
  const error = out.kind === 'error' && KEY_LASTFM_CODES.has(out.code) ? 'lastfm_key_rejected' : lastfmErrorText(out);
  db.tx(() => {
    if (out.kind === 'error' && REVOKING_LASTFM_CODES.has(out.code)) {
      if (once) settleJobRows(db, job, 'failed', now, 'session_revoked');
      revokeAndHold(db, job.link, 'session_revoked', now);
      return;
    }
    if (out.kind === 'error' && KEY_LASTFM_CODES.has(out.code)) {
      markLastfmKeyRejected(db, now);
      noteLinkError(db, job.link, error, now, true);
      if (once) settleJobRows(db, job, 'failed', now, error);
      else retryRowsAt(db, job.rows, now, () => now, error);
      return;
    }
    const retryable =
      (out.kind === 'error' && RETRYABLE_LASTFM_CODES.has(out.code)) ||
      (out.kind === 'http' && (out.httpStatus >= 500 || out.httpStatus === 429)) ||
      out.kind === 'network' ||
      out.kind === 'malformed';
    if (!retryable || once) {
      noteLinkError(db, job.link, error, now, true);
      settleJobRows(db, job, 'failed', now, error);
      return;
    }
    noteLinkError(db, job.link, error, now);
    const rateLimited = (out.kind === 'error' && out.code === 29) || (out.kind === 'http' && out.httpStatus === 429);
    if (rateLimited && 'retryAfterS' in out && out.retryAfterS !== null) {
      rt.pacing.deferLastfm(now + Math.min(MAX_RETRY_AFTER_MS, out.retryAfterS * 1000));
    }
    backoffRows(db, job.rows, now, rt.random, error);
  });
  rt.log.log('warn', 'forward.failed', { service: 'lastfm', kind: job.kind, rows: job.rows.length, error });
}

async function sendLastfm(rt: ForwardRuntime, job: Job, sk: string): Promise<void> {
  const client = rt.lastfm as LastfmClient;
  const db = rt.db;
  if (job.kind === 'scrobble') {
    const out = await client.scrobble(
      sk,
      job.listens.map((l) => ({ ...lastfmTrack(l), timestamp: l.timestamp })),
    );
    const at = rt.clock.nowMs();
    if (!generationIsCurrent(db, job.link)) return;
    if (!out.ok) return lastfmFailed(rt, job, out, at);
    db.tx(() => {
      clearLastfmKeyRejected(db);
      noteLinkSuccess(db, job.link, at);
      job.rows.forEach((row, i) => {
        const code = out.value[i] as number;
        if (code === 0) settleRows(db, [row.id], 'sent', at, null, true, job.link.generation);
        else if (code === 5)
          requeueRows(db, [row.id], nextUtcMidnight(at), at, 'ignored_5', false, job.link.generation);
        else settleRows(db, [row.id], 'ignored', at, `ignored_${code}`, true, job.link.generation);
      });
    });
    return;
  }
  const out =
    job.kind === 'nowplaying'
      ? await client.updateNowPlaying(sk, lastfmTrack(job.track))
      : await client.love(sk, job.kind === 'love' ? 'track.love' : 'track.unlove', job.track.artist, job.track.track);
  const at = rt.clock.nowMs();
  if (!generationIsCurrent(db, job.link)) return;
  if (!out.ok) {
    if (job.kind === 'nowplaying')
      rt.log.log('info', 'forward.nowplaying', { kind: job.kind, status: 'failed', service: 'lastfm' });
    return lastfmFailed(rt, job, out, at);
  }
  db.tx(() => {
    clearLastfmKeyRejected(db);
    noteLinkSuccess(db, job.link, at);
    settleJobRows(db, job, 'sent', at);
  });
  if (job.kind === 'nowplaying')
    rt.log.log('info', 'forward.nowplaying', { kind: job.kind, status: 'sent', service: 'lastfm' });
}

// ---------------------------------------------------------------------------
// ListenBrainz

function metadataOf(t: ForwardTrack): TrackMetadata {
  const info: Record<string, unknown> = {};
  if (t.recordingMbid !== undefined) info.recording_mbid = t.recordingMbid;
  if (t.albumArtist !== undefined) info.release_artist_name = t.albumArtist;
  if (t.releaseMbid !== undefined) info.release_mbid = t.releaseMbid;
  if (t.releaseGroupMbid !== undefined) info.release_group_mbid = t.releaseGroupMbid;
  if (t.artistMbids !== undefined) info.artist_mbids = t.artistMbids;
  if (t.trackNumber !== undefined) info.tracknumber = t.trackNumber;
  if (t.isrc !== undefined) info.isrc = t.isrc;
  if (t.durationSeconds !== undefined) info.duration_ms = t.durationSeconds * 1000;
  if (t.submissionClient !== undefined) info.submission_client = t.submissionClient;
  if (t.musicService !== undefined) info.music_service = t.musicService;
  const meta: TrackMetadata = { artist_name: t.artist, track_name: t.track };
  if (t.album !== undefined) meta.release_name = t.album;
  if (Object.keys(info).length > 0) meta.additional_info = info;
  return meta;
}

async function sendListenbrainz(rt: ForwardRuntime, job: Job, token: string): Promise<void> {
  const client = rt.listenbrainz;
  let out: ListenbrainzOutcome<null>;
  let listenType: ListenType | 'feedback';
  if (job.kind === 'scrobble') {
    listenType = job.listens.length === 1 ? 'single' : 'import';
    const payload: ListenPayload[] = job.listens.map((l) => ({
      listened_at: l.timestamp,
      track_metadata: metadataOf(l),
    }));
    out = await client.submit(token, listenType, payload);
  } else if (job.kind === 'nowplaying') {
    listenType = 'playing_now';
    out = await client.submit(token, 'playing_now', [{ track_metadata: metadataOf(job.track) }]);
  } else {
    listenType = 'feedback';
    out = await client.feedback(token, job.track.recordingMbid as string, job.kind === 'love' ? 1 : 0);
  }
  const at = rt.clock.nowMs();
  const db = rt.db;
  if (!generationIsCurrent(db, job.link)) return;
  const key = lbKey(job.link);
  const once = job.kind === 'nowplaying';
  if (out.ok) {
    rt.pacing.observeListenbrainz(key, at, out.rate);
    db.tx(() => {
      noteLinkSuccess(db, job.link, at);
      settleJobRows(db, job, 'sent', at);
    });
    if (job.kind === 'nowplaying')
      rt.log.log('info', 'forward.nowplaying', { kind: job.kind, status: 'sent', service: 'listenbrainz' });
    return;
  }
  if (out.kind === 'network') {
    const error = 'network_error';
    db.tx(() => {
      noteLinkError(db, job.link, error, at, once);
      if (once) settleJobRows(db, job, 'failed', at, error);
      else backoffRows(db, job.rows, at, rt.random, error);
    });
    rt.log.log('warn', 'forward.failed', { service: 'listenbrainz', kind: job.kind, rows: job.rows.length, error });
    if (once) rt.log.log('info', 'forward.nowplaying', { kind: job.kind, status: 'failed', service: 'listenbrainz' });
    return;
  }
  const error = `http_${out.status}`;
  db.tx(() => {
    if (out.status === 401) {
      if (once) settleJobRows(db, job, 'failed', at, error);
      revokeAndHold(db, job.link, 'token_revoked', at);
      return;
    }
    if (out.status === 429) {
      const until = rt.pacing.observeListenbrainz(key, at, out.rate, true) as number;
      noteLinkError(db, job.link, error, at, once);
      if (once) settleJobRows(db, job, 'failed', at, error);
      else retryRowsAt(db, job.rows, at, () => until, error);
      return;
    }
    rt.pacing.observeListenbrainz(key, at, out.rate);
    if (out.status >= 500 && !once) {
      noteLinkError(db, job.link, error, at);
      backoffRows(db, job.rows, at, rt.random, error);
      return;
    }
    if (out.status === 400 && listenType === 'import') {
      // One listen may be the cause: each is retried alone, without an attempt counted.
      requeueJobRows(db, job, at, at, BATCH_REJECTED, false);
      return;
    }
    noteLinkError(db, job.link, error, at, true);
    settleJobRows(db, job, 'failed', at, error);
  });
  rt.log.log('warn', 'forward.failed', {
    service: 'listenbrainz',
    kind: job.kind,
    rows: job.rows.length,
    status: out.status,
  });
  if (once) rt.log.log('info', 'forward.nowplaying', { kind: job.kind, status: 'failed', service: 'listenbrainz' });
}

// ---------------------------------------------------------------------------
// The run

async function execute(rt: ForwardRuntime, job: Job, now: number): Promise<boolean> {
  if (job.kind === 'unlove' && !allowAuthorizedUnlove(rt, job, now)) return false;
  let credential: string;
  try {
    credential = openLinkCredential(rt.box, job.link);
  } catch (error) {
    // A credential that no longer opens (a dropped encryption key): the link needs relinking.
    rt.db.tx(() => revokeAndHold(rt.db, job.link, 'credential_unreadable', now));
    rt.log.log('error', 'forward.credential_unreadable', { link: job.link.id, error: (error as Error).name });
    return false;
  }
  if (job.link.service === 'lastfm') {
    if (!rt.pacing.tryLastfm('forward', now)) return false;
    await sendLastfm(rt, job, credential);
  } else {
    if (!rt.pacing.tryListenbrainz(lbKey(job.link), now)) return false;
    await sendListenbrainz(rt, job, credential);
  }
  return true;
}

/** Re-read the durable authorization at the last synchronous point before either remote effect. */
function allowAuthorizedUnlove(rt: ForwardRuntime, job: Job, now: number): boolean {
  if (job.kind !== 'unlove') return true;
  const row = job.rows[0]!;
  const current = rt.db.one<{
    authorization_uri: string | null;
    authorization_rev: string | null;
  }>("SELECT authorization_uri,authorization_rev FROM forward_outbox WHERE id=? AND state='queued'", row.id);
  if (current === null) return true;
  const operationId = canonicalForwardDedupeKey(row.generation, row.dedupe_key);
  if (operationId === null) return false;
  const witness = rt.db.one<{
    kind: string;
    authorization_uri: string | null;
    authorization_rev: string | null;
  }>(
    `SELECT kind,authorization_uri,authorization_rev FROM forward_deferred_love_witnesses
     WHERE link_id=? AND generation=? AND operation_id=?`,
    row.link_id,
    row.generation,
    operationId,
  );
  const owned = witness !== null;
  const witnessMatches =
    witness === null ||
    (witness.kind === 'unlove' &&
      witness.authorization_uri === current.authorization_uri &&
      witness.authorization_rev === current.authorization_rev);
  if (!witnessMatches) {
    settleRows(rt.db, [row.id], 'ignored', now, 'authorization_conflicted', false, job.link.generation);
    return false;
  }
  if (current.authorization_uri === null || current.authorization_rev === null) return true;
  const conflict =
    rt.db.one(
      'SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=? AND conflicted=1 LIMIT 1',
      current.authorization_uri,
      current.authorization_rev,
    ) !== null ||
    rt.db.one(
      'SELECT 1 FROM live_record_evidence WHERE uri=? AND conflict_rev=? LIMIT 1',
      current.authorization_uri,
      current.authorization_rev,
    ) !== null;
  if (conflict) {
    settleRows(rt.db, [row.id], 'ignored', now, 'authorization_conflicted', false, job.link.generation);
    return false;
  }
  if (hasPresentTrackLove(rt.db, job.link.did, job.lane.artistKey, job.lane.trackKey)) {
    settleRows(rt.db, [row.id], 'ignored', now, 'local_survivor', false, job.link.generation);
    return false;
  }
  const authority = deferredAuthorityStatus(rt.db, { uri: current.authorization_uri, rev: current.authorization_rev });
  // Legacy acceptance retains its A2 contract, but never overrides a known sticky negative.
  if (!owned && authority !== 'conflicted') return true;
  if (authority === 'active') return true;
  settleRows(
    rt.db,
    [row.id],
    'ignored',
    now,
    authority === 'conflicted' ? 'authorization_conflicted' : 'authorization_unavailable',
    false,
    job.link.generation,
  );
  return false;
}

export const KIND_MIN_DUE_SQL = `SELECT min(due_at) AS due FROM forward_outbox INDEXED BY forward_outbox_kind_due
  WHERE link_id=? AND generation=? AND kind=? AND state='queued'`;
export const LANE_MIN_DUE_SQL = `SELECT min(due_at) AS due FROM forward_love_lanes INDEXED BY forward_love_lanes_due
  WHERE link_id=? AND generation=? AND priority=?`;

/** The earliest instant some active link has a due row and a free upstream; null when nothing is queued. */
export function nextForwardDue(rt: ForwardRuntime, now: number): number | null {
  const links = rt.db.all<LinkRow>("SELECT * FROM linked_accounts WHERE status='active' ORDER BY id");
  let next: number | null = null;
  let lastfmBacklog = false;
  for (const link of links) {
    if (link.service === 'lastfm' && rt.lastfm === null) continue;
    let due: number | null = null;
    for (const kind of ['scrobble', 'nowplaying'] as const) {
      const value = rt.db.one<{ due: number | null }>(KIND_MIN_DUE_SQL, link.id, link.generation, kind)?.due ?? null;
      if (value !== null) due = due === null ? value : Math.min(due, value);
    }
    if (!hasUnkeyedLoves(rt.db, link.id, link.generation)) {
      for (const priority of [0, 1] as const) {
        const value =
          rt.db.one<{ due: number | null }>(LANE_MIN_DUE_SQL, link.id, link.generation, priority)?.due ?? null;
        if (value !== null) due = due === null ? value : Math.min(due, value);
      }
    }
    if (due === null) continue;
    if (link.service === 'lastfm' && due <= now) lastfmBacklog = true;
    const at = Math.max(due, upstreamFreeAt(rt, link, now));
    next = next === null ? at : Math.min(next, at);
  }
  rt.pacing.setForwardBacklog(lastfmBacklog);
  return next;
}

const inFlight = new WeakSet<Db>();

/** One forward run (see the header). */
export async function runForward(
  rt: ForwardRuntime,
  now: number = rt.clock.nowMs(),
  options: { maxRequests?: number } = {},
): Promise<ForwardReport> {
  if (inFlight.has(rt.db))
    return { skipped: true, requests: 0, listenbrainzLinkIds: new Set(), expired: null, nextDueMs: null };
  inFlight.add(rt.db);
  try {
    const max = options.maxRequests ?? MAX_REQUESTS_PER_RUN;
    // The caller's `now` may be stale (the extension lane hands every handler
    // the tick's timestamp after earlier handlers awaited): never act before
    // the clock's current time.
    let at = Math.max(now, rt.clock.nowMs());
    const expired = expireRows(rt.db, at);
    if (expired.pending === true) {
      return {
        skipped: false,
        requests: 0,
        listenbrainzLinkIds: new Set(),
        expired,
        nextDueMs: at + LASTFM_MIN_INTERVAL_MS,
      };
    }
    advanceLoveRecordingHistory(rt.db);
    let framingPending = false;
    for (const link of rt.db.all<LinkRow>("SELECT * FROM linked_accounts WHERE status='active' ORDER BY id")) {
      const framed = frameLoveRows(rt, link, at);
      if (framed.pending) framingPending = true;
    }
    let requests = 0;
    const localWork = new Map<string, { remaining: number }>();
    const listenbrainzLinkIds = new Set<string>();
    // A pick that sends nothing (an unreadable credential revokes its link) still counts against this bound.
    for (let picks = 0; requests < max && picks < max * 4; picks++) {
      const job = pickJob(rt, at, localWork);
      if (job === null) break;
      const sent = await execute(rt, job, at);
      if (job.kind === 'love' || job.kind === 'unlove') {
        rt.db.tx(() => refreshLoveLane(rt.db, job.link.id, job.link.generation, job.lane.artistKey, job.lane.trackKey));
      }
      if (sent) {
        requests += 1;
        if (job.link.service === 'listenbrainz') listenbrainzLinkIds.add(job.link.id);
      }
      at = Math.max(at, rt.clock.nowMs());
    }
    let next = nextForwardDue(rt, at);
    if (framingPending) next = Math.min(next ?? Number.POSITIVE_INFINITY, at + LASTFM_MIN_INTERVAL_MS);
    // Work left that this run could not send (a bound, or rows that turned unsendable): try again shortly.
    if (next !== null && next <= at && requests < max) next = at + LASTFM_MIN_INTERVAL_MS;
    return { skipped: false, requests, listenbrainzLinkIds, expired, nextDueMs: next };
  } finally {
    inFlight.delete(rt.db);
  }
}

/**
 * The `forward` extension timer (ADR §3.3): runs `runForward` and schedules
 * itself at the next due instant, at most FORWARD_IDLE_POLL_MS away so new
 * rows are picked up even without a kick. `runtime()` is null until the
 * composition built it (http/links.ts), and then the handler does nothing.
 */
export function forwardExtension(runtime: () => ForwardRuntime | null): CoreExtension {
  return {
    name: 'forward',
    timers: {
      forward: async (now, ctx) => {
        const rt = runtime();
        if (rt === null) return;
        const report = await runForward(rt, now);
        if (!report.skipped) {
          // Live work has per-account priority; it does not block unrelated
          // accounts. The delete lane still takes at most one request here.
          await runDeleteSlice(
            {
              db: rt.db,
              clock: rt.clock,
              random: rt.random,
              box: rt.box,
              client: rt.listenbrainz,
              pacing: rt.pacing,
            },
            rt.clock.nowMs(),
            { livePriorityLinkIds: report.listenbrainzLinkIds },
          );
        }
        // Pull polling remains a separate future increment. This only drains
        // pages already committed to durable local staging.
        const pullLinks = rt.db.all<{ id: string; generation: number }>(
          `SELECT l.id,l.generation FROM linked_accounts l JOIN linked_pull_items p ON p.link_id=l.id AND p.generation=l.generation
           WHERE l.status='active' AND l.pull_enabled=1 GROUP BY l.id,l.generation ORDER BY min(p.staged_at_ms),l.id LIMIT 20`,
        );
        for (const link of pullLinks) {
          if (!rt.pullWriterAvailability) continue;
          try {
            const { writePullSlice } = await import('../sync/pull-writer');
            await writePullSlice(ctx.deps, {
              linkId: link.id,
              generation: link.generation,
              available: rt.pullWriterAvailability,
              limit: 100,
            });
          } catch (error) {
            rt.log.log('warn', 'linked_pull.writer_failed', {
              linkId: link.id,
              generation: link.generation,
              error: error instanceof Error ? error.name : 'Error',
            });
          }
        }
        refreshForwardStorageStats(rt.db, rt.clock.nowMs());
        if (report.skipped) return;
        const deleteDue = nextDeleteWakeAt({ db: rt.db, pacing: rt.pacing }, rt.clock.nowMs());
        const due = [report.nextDueMs, deleteDue]
          .filter((v): v is number => v !== null)
          .reduce<number | null>((a, v) => (a === null ? v : Math.min(a, v)), null);
        const poll = now + FORWARD_IDLE_POLL_MS;
        ctx.schedule('forward', due === null ? poll : Math.min(poll, due), { force: true });
      },
    },
    start(ctx, now) {
      ctx.schedule('forward', now);
    },
  };
}
