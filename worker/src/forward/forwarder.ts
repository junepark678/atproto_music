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
//    - otherwise whichever is older of its due scrobbles and its love/unlove
//      head (forward-outbox.ts `loveHead`: love toggles go strictly in order).
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
// ListenBrainz feedback goes by `recording_mbid`; a love or unlove without
// one is `ignored` (`no_recording_mbid`) without a request.
//
// The Last.fm key pause (10/26) is the `lastfm_key_rejected` counter, shown
// by adminStatus. While it is set no Last.fm request is sent, except one
// probe an hour after the latest rejection; a probe that succeeds lifts it.
//
// Delivery is at least once: a request that timed out after the upstream
// accepted it is sent again (neither service has an idempotency key).
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
import type { CoreExtension } from '../app/host';
import type { LinkedAccountRow } from '../app/rows';
import type { Box } from '../crypto/box';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
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
  loveHead,
  lovePayload,
  markLastfmKeyRejected,
  nextUtcMidnight,
  nowPlayingPayload,
  type QueuedRow,
  requeueRows,
  scrobblePayload,
  settleRows,
} from './forward-outbox';
import { LASTFM_MAX_BATCH, type LastfmClient, type LastfmFailure, type LastfmTrack } from './lastfm-client';
import { openLinkCredential, revokeLink } from './links';
import {
  LISTENBRAINZ_MAX_IMPORT,
  type ListenbrainzClient,
  type ListenbrainzOutcome,
  type ListenPayload,
  type ListenType,
  type TrackMetadata,
} from './listenbrainz-client';
import { LASTFM_MIN_INTERVAL_MS, type UpstreamPacing } from './upstream-pacing';

/** Upstream requests per `forward` run (ADR §3.3). */
export const MAX_REQUESTS_PER_RUN = 5;
/** While the key is rejected, one probe this long after the latest rejection. */
export const KEY_REJECTED_PROBE_MS = 3_600_000;
/** The `forward` timer looks for new rows at least this often. */
export const FORWARD_IDLE_POLL_MS = 10_000;
/** Last error of a row whose ListenBrainz import was refused: it is sent alone next. */
export const BATCH_REJECTED = 'batch_rejected';

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
}

export interface ForwardReport {
  /** True when another run over the same database was in flight. */
  skipped: boolean;
  /** Upstream requests sent. */
  requests: number;
  expired: ExpiryReport | null;
  /** When to run next (epoch ms), or null when nothing is queued. */
  nextDueMs: number | null;
}

type LinkRow = LinkedAccountRow;

type Job =
  | { link: LinkRow; kind: 'nowplaying'; rows: [QueuedRow]; track: ForwardTrack }
  | { link: LinkRow; kind: 'scrobble'; rows: QueuedRow[]; listens: ForwardListen[] }
  | { link: LinkRow; kind: 'love' | 'unlove'; rows: [QueuedRow]; track: ForwardTrack };

const lbKey = (link: Pick<LinkRow, 'id'>): string => `link:${link.id}`;

function ids(rows: readonly QueuedRow[]): string[] {
  return rows.map((r) => r.id);
}

/**
 * Revokes `link` and holds its queued rows, inside the caller's transaction.
 * `link` is the row read before the request was sent, so this is
 * conditional on that state: when the owner relinked while the request was
 * in flight (a new credential, status active again), the refusal was of the
 * old credential and the fresh link and its rows are left as they are.
 */
function revokeAndHold(db: Db, link: LinkRow, error: string, now: number): void {
  if (revokeLink(db, link, error, now)) holdLinkRows(db, link.id, now);
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
  if (bad.length > 0) settleRows(rt.db, bad, 'failed', now, 'invalid_payload', false);
  return out;
}

function nowPlayingJob(rt: ForwardRuntime, link: LinkRow, now: number): Job | null {
  const rows = dueRows(rt.db, link.id, 'nowplaying', now, 50);
  if (rows.length === 0) return null;
  // Only the newest is current; older ones are superseded.
  const newest = rows[rows.length - 1] as QueuedRow;
  settleRows(rt.db, ids(rows.slice(0, -1)), 'expired', now, 'superseded', false);
  const [entry] = parsed(rt, [newest], nowPlayingPayload, now);
  return entry === undefined ? null : { link, kind: 'nowplaying', rows: [entry[0]], track: entry[1] };
}

function scrobbleJob(rt: ForwardRuntime, link: LinkRow, now: number): Job | null {
  const limit = link.service === 'lastfm' ? LASTFM_MAX_BATCH : LISTENBRAINZ_MAX_IMPORT;
  for (;;) {
    const rows = dueRows(rt.db, link.id, 'scrobble', now, limit);
    if (rows.length === 0) return null;
    let batch = rows;
    if (link.service === 'listenbrainz') {
      const first = rows[0] as QueuedRow;
      batch = first.last_error === BATCH_REJECTED ? [first] : rows.filter((r) => r.last_error !== BATCH_REJECTED);
    }
    const entries = parsed(rt, batch, scrobblePayload, now);
    if (entries.length === 0) continue; // every row was unusable and is now failed
    return { link, kind: 'scrobble', rows: entries.map(([r]) => r), listens: entries.map(([, l]) => l) };
  }
}

function loveJob(rt: ForwardRuntime, link: LinkRow, now: number): Job | null {
  for (;;) {
    const head = loveHead(rt.db, link.id);
    if (head === null || head.due_at > now) return null;
    const [entry] = parsed(rt, [head], lovePayload, now);
    if (entry === undefined) continue;
    if (link.service === 'listenbrainz' && entry[1].recordingMbid === undefined) {
      // ListenBrainz feedback needs a recording MBID; without one it is not forwarded.
      settleRows(rt.db, [head.id], 'ignored', now, 'no_recording_mbid', false);
      continue;
    }
    return { link, kind: head.kind as 'love' | 'unlove', rows: [head], track: entry[1] };
  }
}

const seqOf = (job: Job): [number, number] => [job.rows[0].created_at_ms, job.rows[0].seq];

function older(a: Job | null, b: Job | null): Job | null {
  if (a === null) return b;
  if (b === null) return a;
  const [ac, as] = seqOf(a);
  const [bc, bs] = seqOf(b);
  return ac < bc || (ac === bc && as <= bs) ? a : b;
}

/** The next job to send at `now`, or null. */
function pickJob(rt: ForwardRuntime, now: number): Job | null {
  const candidates = rt.db.all<LinkRow & { oldest: number }>(
    `SELECT l.*, min(f.created_at_ms) AS oldest FROM linked_accounts l
     JOIN forward_outbox f ON f.link_id = l.id
     WHERE l.status = 'active' AND f.state = 'queued' AND f.due_at <= ?
     GROUP BY l.id ORDER BY oldest, l.id`,
    now,
  );
  for (const link of candidates) {
    if (!upstreamFree(rt, link, now)) continue;
    const job = rt.db.tx(
      () => nowPlayingJob(rt, link, now) ?? older(scrobbleJob(rt, link, now), loveJob(rt, link, now)),
    );
    if (job !== null) return job;
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
      return `network_${out.error}`;
    default:
      return 'malformed_answer';
  }
}

/** Applies a failed Last.fm request to its rows, its link and the global pause. */
function lastfmFailed(rt: ForwardRuntime, job: Job, out: LastfmFailure, now: number): void {
  const db = rt.db;
  const once = job.kind === 'nowplaying';
  const error = lastfmErrorText(out);
  db.tx(() => {
    if (out.kind === 'error' && REVOKING_LASTFM_CODES.has(out.code)) {
      if (once) settleRows(db, ids(job.rows), 'failed', now, error);
      revokeAndHold(db, job.link, 'session_revoked', now);
      return;
    }
    if (out.kind === 'error' && KEY_LASTFM_CODES.has(out.code)) {
      markLastfmKeyRejected(db, now);
      if (once) settleRows(db, ids(job.rows), 'failed', now, error);
      return;
    }
    const retryable =
      (out.kind === 'error' && RETRYABLE_LASTFM_CODES.has(out.code)) ||
      (out.kind === 'http' && (out.httpStatus >= 500 || out.httpStatus === 429)) ||
      out.kind === 'network' ||
      out.kind === 'malformed';
    if (!retryable || once) {
      settleRows(db, ids(job.rows), 'failed', now, error);
      return;
    }
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
    if (!out.ok) return lastfmFailed(rt, job, out, at);
    db.tx(() => {
      clearLastfmKeyRejected(db);
      job.rows.forEach((row, i) => {
        const code = out.value[i] as number;
        if (code === 0) settleRows(db, [row.id], 'sent', at);
        else if (code === 5) requeueRows(db, [row.id], nextUtcMidnight(at), at, 'ignored_5', false);
        else settleRows(db, [row.id], 'ignored', at, `ignored_${code}`);
      });
    });
    return;
  }
  const out =
    job.kind === 'nowplaying'
      ? await client.updateNowPlaying(sk, lastfmTrack(job.track))
      : await client.love(sk, job.kind === 'love' ? 'track.love' : 'track.unlove', job.track.artist, job.track.track);
  const at = rt.clock.nowMs();
  if (!out.ok) return lastfmFailed(rt, job, out, at);
  db.tx(() => {
    clearLastfmKeyRejected(db);
    settleRows(db, ids(job.rows), 'sent', at);
  });
}

// ---------------------------------------------------------------------------
// ListenBrainz

function metadataOf(t: ForwardTrack): TrackMetadata {
  const info: Record<string, unknown> = {};
  if (t.recordingMbid !== undefined) info.recording_mbid = t.recordingMbid;
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
  const key = lbKey(job.link);
  const once = job.kind === 'nowplaying';
  if (out.ok) {
    rt.pacing.observeListenbrainz(key, at, out.rate);
    settleRows(db, ids(job.rows), 'sent', at);
    return;
  }
  if (out.kind === 'network') {
    const error = `network_${out.error}`;
    if (once) settleRows(db, ids(job.rows), 'failed', at, error);
    else backoffRows(db, job.rows, at, rt.random, error);
    rt.log.log('warn', 'forward.failed', { service: 'listenbrainz', kind: job.kind, rows: job.rows.length, error });
    return;
  }
  const error = `http_${out.status}: ${out.error}`;
  db.tx(() => {
    if (out.status === 401) {
      if (once) settleRows(db, ids(job.rows), 'failed', at, error);
      revokeAndHold(db, job.link, 'token_revoked', at);
      return;
    }
    if (out.status === 429) {
      const until = rt.pacing.observeListenbrainz(key, at, out.rate, true) as number;
      if (once) settleRows(db, ids(job.rows), 'failed', at, error);
      else requeueRows(db, ids(job.rows), until, at, 'rate_limited', false);
      return;
    }
    rt.pacing.observeListenbrainz(key, at, out.rate);
    if (out.status >= 500 && !once) {
      backoffRows(db, job.rows, at, rt.random, error);
      return;
    }
    if (out.status === 400 && listenType === 'import') {
      // One listen may be the cause: each is retried alone, without an attempt counted.
      requeueRows(db, ids(job.rows), at, at, BATCH_REJECTED, false);
      return;
    }
    settleRows(db, ids(job.rows), 'failed', at, error);
  });
  rt.log.log('warn', 'forward.failed', {
    service: 'listenbrainz',
    kind: job.kind,
    rows: job.rows.length,
    status: out.status,
  });
}

// ---------------------------------------------------------------------------
// The run

async function execute(rt: ForwardRuntime, job: Job, now: number): Promise<boolean> {
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

/** The earliest instant some active link has a due row and a free upstream; null when nothing is queued. */
export function nextForwardDue(rt: ForwardRuntime, now: number): number | null {
  const links = rt.db.all<LinkRow & { due: number | null }>(
    `SELECT l.*, (SELECT min(f.due_at) FROM forward_outbox f
                  WHERE f.link_id = l.id AND f.state = 'queued' AND f.kind IN ('scrobble', 'nowplaying')) AS due
     FROM linked_accounts l WHERE l.status = 'active'`,
  );
  let next: number | null = null;
  let lastfmBacklog = false;
  for (const link of links) {
    if (link.service === 'lastfm' && rt.lastfm === null) continue;
    const head = loveHead(rt.db, link.id);
    const due = Math.min(link.due ?? Number.POSITIVE_INFINITY, head?.due_at ?? Number.POSITIVE_INFINITY);
    if (due === Number.POSITIVE_INFINITY) continue;
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
  if (inFlight.has(rt.db)) return { skipped: true, requests: 0, expired: null, nextDueMs: null };
  inFlight.add(rt.db);
  try {
    const max = options.maxRequests ?? MAX_REQUESTS_PER_RUN;
    const expired = expireRows(rt.db, now);
    let requests = 0;
    let at = now;
    // A pick that sends nothing (an unreadable credential revokes its link) still counts against this bound.
    for (let picks = 0; requests < max && picks < max * 4; picks++) {
      const job = pickJob(rt, at);
      if (job === null) break;
      const sent = await execute(rt, job, at);
      if (sent) requests += 1;
      at = Math.max(at, rt.clock.nowMs());
    }
    let next = nextForwardDue(rt, at);
    // Work left that this run could not send (a bound, or rows that turned unsendable): try again shortly.
    if (next !== null && next <= at && requests < max) next = at + LASTFM_MIN_INTERVAL_MS;
    return { skipped: false, requests, expired, nextDueMs: next };
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
        if (report.skipped) return;
        const poll = now + FORWARD_IDLE_POLL_MS;
        ctx.schedule('forward', report.nextDueMs === null ? poll : Math.min(poll, report.nextDueMs), { force: true });
      },
    },
    start(ctx, now) {
      ctx.schedule('forward', now);
    },
  };
}
