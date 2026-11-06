// POST /1/submit-listens (ADR 0005 §8.3, Q11, Q16; N3-05).
//
// Order of the checks, each before the next reads anything more:
// 1. **Token first** (`lbGuard`, token-routes.ts): the Authorization header,
//    the token lookup and the credential-first rate limit. An unauthenticated
//    or rate-limited submit gets its 401 or 429 having read **zero body
//    bytes**, so nobody can make the server buffer 10 MB anonymously. The
//    bridge streams the body only as the handler reads it (http-bridge.ts,
//    `bodyBytesRead()`), and its 10,240,000-byte cap is the backstop.
// 2. **Publication gate.** Closed → 503 `{"code":503,"error":"Cannot submit
//    listens to queue, please try again later."}`. Open means exactly the
//    namespace gate's `publication` capability (ADR §5.7, `AppConfig.publication`:
//    an owned, non-fixture prefix with NAMESPACE_OWNERSHIP_REF, mirroring
//    `Namespace::require_publication`). The fixture prefix never opens it, so
//    /1/ agrees with /api/v1/meta and with the Last.fm write methods.
// 3. A declared Content-Length over 10,240,000 bytes is ListenBrainz's
//    "Payload too large" 400 without reading the body.
// 4. `validateSubmission` (validate.ts, N2-08): the envelope and per-listen
//    checks with ListenBrainz's messages. Only these are 400s: clients treat
//    any 400 as fatal (Web Scrobbler drops the batch).
// 5. Per listen type:
//    - **single / import:** listens classified `ignore` (a name ListenBrainz
//      accepts but our scrobble validator refuses) are not written; each is
//      recorded in `ignored_listens` (source listenbrainz, reason, listened_at,
//      the first 128 scalars of each name). That record is idempotent and
//      bounded (`recordIgnored`): a listen already recorded for the DID (same
//      reason, listened_at and previews, also within one request) is not
//      recorded again, so a resent batch (an offline cache flush retried, a
//      retry after the daily-cap 429) adds nothing; and at most
//      IGNORED_LISTENS_DAILY_LIMIT rows are recorded per DID in any rolling
//      24 hours, the default daily listen cap, so ignored listens, which the
//      cap does not count, cannot fill the 30-day table. Past the bound the
//      listen is still answered 200 and not written. The rest go through the shared
//      ingress `acceptListens` (N2-05) with origin `listenbrainz`: listen
//      keys (an identical resubmission creates nothing), the daily cap,
//      `scrobble.create` operations (live priority 0) and forward rows, in one
//      transaction; a `defer` listen (now + 300 s < listened_at ≤ now +
//      3,600 s) carries `notBeforeMs = listened_at − 300 s`, so its operation
//      is due, and its record dated, then. A client `import` is a live
//      submission (an offline cache flush), not an import job.
//      Over the daily cap → 429 "Daily listen limit exceeded." with
//      Retry-After and the X-RateLimit-* set (with
//      Access-Control-Expose-Headers) describing the rolling 24-hour window:
//      Limit = the DID's cap, Remaining = what is left, Reset-In = until the
//      oldest live listen of the window leaves it. Entries accepted before the
//      cap was reached stay accepted, and a resend of them is idempotent.
//    - **playing_now:** upserts the caller's `now_playing` row (source
//      listenbrainz; an identical current track is kept as is). The TTL is
//      `duration`, else `duration_ms`/1000, else 600 s (now-playing.ts). The
//      stored client is `additional_info.submission_client`, which
//      playing-now/delete compares. A new entry queues a `nowplaying` forward
//      row for each active link with forward_now_playing. No operation.
// 6. 200 `{"status":"ok"}`. `return_msid` (the query parameter) is honoured
//    for playing_now only, as ListenBrainz does, and any non-empty value
//    counts (Python truthiness of the string): `{"status":"ok",
//    "recording_msid":"<msid>"}` with the MSID of §8.4. For single and import
//    it is ignored.
//
// Every answer carries the CORS set (errors.ts) and the X-RateLimit-* set of
// the charged bucket (the daily-cap 429 carries the daily window instead).
// Under the /1/ dispatcher (N3-06, `registry`), step 1 is the dispatcher's:
// the handler takes its fourth argument (`LbDispatch`, token-routes.ts) and
// neither verifies the token again nor charges a limiter. The body, the token
// and the header are never logged.

import { recordingMsid } from '@atmusic/core/msid';
import type { MappedTrack } from '@atmusic/core/protocol-map';
import type { JsonObject } from '@atmusic/core/scrobble';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../do/contracts';
import { upsertNowPlaying } from '../do/read/now-playing';
import { need, type RequestCtx } from '../http/types';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { acceptListens, DAILY_CAP_WINDOW_MS, DEFAULT_DAILY_LISTEN_CAP, type IngressListen } from '../outbox/ingress';
import { LB_UNAVAILABLE_MESSAGE, lbError, lbJson, lbPreflight, lbTooManyRequests } from './errors';
import { rateLimitHeaders } from './rate-headers';
import {
  kickOutbox,
  type LbDispatch,
  type LbModuleRouteDef,
  type LbRouteOptions,
  lbGuard,
  lbPublicationOpen,
} from './token-routes';
import { LB_SUBMIT_MESSAGES, MAX_LISTEN_PAYLOAD_SIZE, type ValidatedListen, validateSubmission } from './validate';

export const SUBMIT_LISTENS_PATH = '/1/submit-listens';

/** The daily cap's 429 message (ADR §8.3). */
export const LB_DAILY_CAP_MESSAGE = 'Daily listen limit exceeded.';

/** At most this many ignored_listens rows per DID in any rolling 24 hours (module comment, step 5). */
export const IGNORED_LISTENS_DAILY_LIMIT = DEFAULT_DAILY_LISTEN_CAP;

/** Whether submissions may be queued for publication (step 2 of the module comment); shared with delete-listen. */
export { lbPublicationOpen };

// ---------------------------------------------------------------------------
// Helpers

/** ListenBrainz `return_msid`: any non-empty value of the query parameter. */
function wantsMsid(url: URL): boolean {
  const value = url.searchParams.get('return_msid');
  return value !== null && value !== '';
}

function declaredTooLarge(req: Request): boolean {
  const declared = req.headers.get('content-length');
  if (declared === null || !/^[0-9]+$/.test(declared.trim())) return false;
  return Number(declared.trim()) > MAX_LISTEN_PAYLOAD_SIZE;
}

async function readBody(req: Request): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await req.arrayBuffer());
  } catch {
    // The bridge's cap overflowed (it answers the 400 itself) or the client went away.
    return null;
  }
}

function additionalInfo(listen: ValidatedListen): JsonObject {
  const meta = listen.listen.track_metadata;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {};
  const info = (meta as JsonObject).additional_info;
  return typeof info === 'object' && info !== null && !Array.isArray(info) ? (info as JsonObject) : {};
}

/** The now-playing TTL basis in seconds: `duration`, else `duration_ms`/1000 (validated as integers). */
function nowPlayingDuration(info: JsonObject): number | null {
  if (typeof info.duration === 'number') return info.duration;
  if (typeof info.duration_ms === 'number') return info.duration_ms / 1000;
  return null;
}

function submissionClient(info: JsonObject): string | null {
  const client = info.submission_client;
  return typeof client === 'string' && client !== '' ? client : null;
}

/** The ListenBrainz-trimmed names of a validated listen. */
function names(listen: ValidatedListen): { artist: string; track: string } | null {
  const meta = listen.listen.track_metadata as JsonObject;
  return typeof meta.artist_name === 'string' && typeof meta.track_name === 'string'
    ? { artist: meta.artist_name, track: meta.track_name }
    : null;
}

async function msidOf(listen: ValidatedListen): Promise<string | null> {
  const n = listen.track ?? names(listen);
  if (n === null) return null;
  try {
    return await recordingMsid(n.artist, n.track);
  } catch {
    // A name our music keys refuse has no MSID of ours.
    return null;
  }
}

/** Seconds until the oldest live listen of the DID's 24-hour window leaves it (at least 1). */
function dailyResetInSeconds(m: Pick<ModuleDeps, 'db'>, did: string, now: number): number {
  const oldest = m.db.one<{ t: number | null }>(
    `SELECT min(created_at_ms) AS t FROM listen_keys WHERE did = ? AND source != 'import' AND created_at_ms > ?`,
    did,
    now - DAILY_CAP_WINDOW_MS,
  )?.t;
  const ms = oldest === null || oldest === undefined ? DAILY_CAP_WINDOW_MS : oldest + DAILY_CAP_WINDOW_MS - now;
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Records the ignored listens of a request in ignored_listens: once per listen
 * (an identical row of the DID is never added again) and at most
 * IGNORED_LISTENS_DAILY_LIMIT rows per DID per rolling 24 hours (module comment).
 */
function recordIgnored(m: ModuleDeps, did: string, listens: readonly ValidatedListen[], now: number): void {
  const rows: { reason: string; listenedAt: string; artist: string; track: string }[] = [];
  for (const listen of listens) {
    const d = listen.disposition;
    if (d.kind !== 'ignore' || listen.listenedAtSeconds === null) continue;
    rows.push({
      reason: d.reason,
      listenedAt: toStorage(BigInt(listen.listenedAtSeconds) * NS_PER_SECOND),
      artist: d.artistPreview,
      track: d.trackPreview,
    });
  }
  if (rows.length === 0) return;
  m.db.tx(() => {
    const recent =
      m.db.one<{ n: number }>(
        'SELECT count(*) AS n FROM ignored_listens WHERE did = ? AND created_at_ms > ?',
        did,
        now - DAILY_CAP_WINDOW_MS,
      )?.n ?? 0;
    let room = IGNORED_LISTENS_DAILY_LIMIT - recent;
    if (room <= 0) return;
    // listened_at is the fixed-width storage form, so string order is time order.
    const times = rows.map((r) => r.listenedAt).sort();
    const keyOf = (r: { reason: string; listenedAt: string; artist: string; track: string }) =>
      JSON.stringify([r.reason, r.listenedAt, r.artist, r.track]);
    const seen = new Set<string>();
    for (const row of m.db.all<{ reason: string; listened_at: string; artist_preview: string; track_preview: string }>(
      `SELECT reason, listened_at, artist_preview, track_preview FROM ignored_listens
       WHERE did = ? AND source = 'listenbrainz' AND listened_at >= ? AND listened_at <= ?`,
      did,
      times[0] as string,
      times[times.length - 1] as string,
    )) {
      seen.add(
        keyOf({
          reason: row.reason,
          listenedAt: row.listened_at,
          artist: row.artist_preview,
          track: row.track_preview,
        }),
      );
    }
    for (const row of rows) {
      if (room <= 0) break;
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      m.db.run(
        `INSERT INTO ignored_listens(did, source, reason, listened_at, artist_preview, track_preview, created_at_ms)
         VALUES (?, 'listenbrainz', ?, ?, ?, ?, ?)`,
        did,
        row.reason,
        row.listenedAt,
        row.artist,
        row.track,
        now,
      );
      room--;
    }
  });
}

// ---------------------------------------------------------------------------
// Listen types

async function submitListens(
  ctx: RequestCtx,
  did: string,
  listens: readonly ValidatedListen[],
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const m = need(ctx, 'deps');
  const ignored = listens.filter((l) => l.disposition.kind === 'ignore');
  const ingress: IngressListen[] = [];
  for (const listen of listens) {
    const d = listen.disposition;
    if (d.kind === 'ignore' || listen.record === null) continue;
    ingress.push(d.kind === 'defer' ? { input: listen.record, notBeforeMs: d.notBeforeMs } : { input: listen.record });
  }
  let overCap = false;
  if (ingress.length > 0) {
    const result = await acceptListens(m, {
      did,
      origin: 'listenbrainz',
      listens: ingress,
      receiptMs: now,
      kick: () => kickOutbox(ctx),
    });
    overCap = result.results.some((r) => r.status === 'over_cap');
    if (overCap) {
      recordIgnored(m, did, ignored, now);
      const resetIn = dailyResetInSeconds(m, did, now);
      const daily = rateLimitHeaders({ limit: result.cap, remaining: result.remaining, resetInSeconds: resetIn }, now);
      return lbTooManyRequests(daily, resetIn, LB_DAILY_CAP_MESSAGE);
    }
  }
  recordIgnored(m, did, ignored, now);
  return lbJson({ status: 'ok' }, 200, headers);
}

async function playingNow(
  ctx: RequestCtx,
  did: string,
  listen: ValidatedListen,
  now: number,
  returnMsid: boolean,
  headers: Record<string, string>,
): Promise<Response> {
  const m = need(ctx, 'deps');
  const track: MappedTrack | null = listen.track;
  if (listen.disposition.kind !== 'ignore' && track !== null) {
    const info = additionalInfo(listen);
    m.db.tx(() => {
      const stored = upsertNowPlaying(m, {
        did,
        artist: track.artist,
        track: track.track,
        album: track.album ?? null,
        albumArtist: track.albumArtist ?? null,
        durationSeconds: nowPlayingDuration(info),
        recordingMbid: track.recordingMbid ?? null,
        client: submissionClient(info),
        source: 'listenbrainz',
        sameTrack: 'keep',
      });
      if (stored.outcome !== 'stored') return;
      const startedAtMs = stored.row.started_at_ms;
      enqueueForwards(m.db, {
        did,
        items: [
          {
            kind: 'nowplaying',
            startedAtMs,
            artist: track.artist,
            track: track.track,
            payload: { track, startedAtMs, origin: 'listenbrainz' },
          },
        ],
        now,
        random: m.random,
      });
    });
  }
  if (!returnMsid) return lbJson({ status: 'ok' }, 200, headers);
  const msid = await msidOf(listen);
  return lbJson(msid === null ? { status: 'ok' } : { status: 'ok', recording_msid: msid }, 200, headers);
}

// ---------------------------------------------------------------------------
// The handler

async function handleSubmit(
  req: Request,
  ctx: RequestCtx,
  options: LbRouteOptions,
  lb?: LbDispatch,
): Promise<Response> {
  // 1. Token and rate limit (the dispatcher's, when mounted under it): nothing of the body has been read yet.
  const guard = lbGuard(req, ctx, options, lb);
  if (!guard.ok) return guard.response;
  const headers = guard.rateHeaders;
  const m = need(ctx, 'deps');

  // 2. Publication gate.
  if (!lbPublicationOpen(m.config)) return lbError(503, LB_UNAVAILABLE_MESSAGE, headers);

  // 3–4. Size, then ListenBrainz's validation.
  if (declaredTooLarge(req)) return lbError(400, LB_SUBMIT_MESSAGES.payloadTooLarge, headers);
  const body = await readBody(req);
  if (body === null) return lbError(400, LB_SUBMIT_MESSAGES.payloadTooLarge, headers);
  const now = m.clock.nowMs();
  const validated = validateSubmission(body, now);
  if (!validated.ok) return lbError(400, validated.error.message, headers);

  // 5–6.
  const did = guard.token.did;
  if (validated.listenType === 'playing_now') {
    const listen = validated.listens[0] as ValidatedListen;
    return playingNow(ctx, did, listen, now, wantsMsid(new URL(req.url)), headers);
  }
  return submitListens(ctx, did, validated.listens, now, headers);
}

/** POST /1/submit-listens and its OPTIONS answer (§8.1); mountable standalone or through the /1/ dispatcher. */
export function createSubmitRoutes(options: LbRouteOptions = {}): LbModuleRouteDef[] {
  return [
    {
      method: 'POST',
      pattern: SUBMIT_LISTENS_PATH,
      auth: 'required',
      handler: (req, ctx, _params, lb) => handleSubmit(req, ctx, options, lb),
    },
    { method: 'OPTIONS', pattern: SUBMIT_LISTENS_PATH, handler: async () => lbPreflight(['POST']) },
  ];
}

/** The submit routes over the composition's shared limiter. */
export const routes: readonly LbModuleRouteDef[] = Object.freeze(createSubmitRoutes());
