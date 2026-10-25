// ListenBrainz-compatible recording feedback (ADR 0005 §8.6; N3-06):
//
//   POST /1/feedback/recording-feedback {recording_msid | recording_mbid, score}   (token)
//   GET  /1/feedback/user/{user}/get-feedback?score&count&offset&metadata
//
// Writes:
// - The token is required (the router answers the 401 before the body is
//   read). The body is JSON of at most 64 KiB. ListenBrainz's checks, in its
//   order and with its texts: `recording_msid` or `recording_mbid`, and
//   `score`, must be present ("JSON document must contain either
//   recording_msid or recording_mbid, and score top level keys"); no other
//   key ("JSON document may only contain recording_msid, recording_mbid and
//   score top level keys"); then the pydantic model ("Invalid JSON document
//   submitted: …"): score one of -1, 0, 1; each id null or a UUID; at least one
//   id given.
// - score 1 queues a love (`enqueueLove`, origin listenbrainz); 0 queues an
//   unlove; **-1 ("hate") also queues an unlove**, a documented deviation: we
//   have no hate state, and a hated track is at least not loved.
// - The target track is found from the caller's own data, in this order:
//   1. their indexed listens: `scrobbles.recording_msid` (or
//      `recording_mbid`), and for rows whose MSID column is still NULL the
//      MSID recomputed from the stored music keys;
//   2. their current now_playing row (expiry respected, share flag ignored:
//      it is the owner's own data);
//   3. their not-yet-indexed `scrobble.create` operations (not failed or
//      cancelled, and no indexed record at their result URI yet), newest
//      first, at most PENDING_SCAN_LIMIT of them.
//   An MSID is a pure function of the artist and track keys
//   (packages/core/src/msid.ts), so each candidate is checked by recomputing
//   it. A love right after a scrobble, or while a track plays, therefore
//   works. The display names, album and recording MBID of the matching
//   candidate become the love record's (the newest indexed listen of the key
//   for case 1).
// - An id with no candidate answers 200 `{"status":"ok"}` and stores nothing,
//   as ListenBrainz does for an MSID it cannot use.
// - Namespace gate closed (no lexicon prefix): 503, nothing stored.
//
// Reads (get-feedback): the user's loves (the proof-gated `loves` projection)
// newest first, `{feedback: [{user_id, recording_msid, recording_mbid, score:
// 1, created, track_metadata?}], count, total_count, offset}`. `score=1` or no
// score lists loves; `score=-1` is an empty list (no hate state); another
// non-zero score is 400 "Score can have a value of 1 or -1." (`score=0`, falsy
// in Python, is no filter). `metadata=true` adds `track_metadata`.

import { ApiError } from '@atmusic/core/errors';
import { recordingMsid, recordingMsidOfKey } from '@atmusic/core/msid';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { displayName } from '../credentials/accounts';
import type { ModuleDeps } from '../do/contracts';
import { lovedTracks } from '../do/read/loves';
import { ownNowPlaying } from '../do/read/now-playing';
import { storageToUnixSeconds } from '../do/read/recent';
import { readJsonBody } from '../http/params';
import { need, type RequestCtx } from '../http/types';
import { enqueueLove, enqueueUnlove } from '../outbox/love-ops';
import { lbError, lbJson } from './errors';
import {
  booleanArg,
  intArg,
  LB_DEFAULT_COUNT,
  LB_MAX_COUNT,
  LbHttpError,
  nonNegativeArg,
  queryOf,
  resolveLbUser,
} from './read';
import type { LbRequest, LbRouteDef } from './routes';

/** The most body bytes a feedback request may carry (the bridge's /1/ cap). */
export const FEEDBACK_MAX_BODY_BYTES = 64 * 1024;
/** How many of the caller's newest not-yet-indexed creates an id is matched against. */
export const PENDING_SCAN_LIMIT = 5000;

export const FEEDBACK_MESSAGES = {
  missingKeys: 'JSON document must contain either recording_msid or recording_mbid, and score top level keys',
  extraKeys: 'JSON document may only contain recording_msid, recording_mbid and score top level keys',
  invalidJson: 'Invalid JSON document submitted.',
  badScoreFilter: 'Score can have a value of 1 or -1.',
  unavailable: 'Cannot submit feedback, please try again later.',
} as const;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** A UUID in the lowercase hyphenated form. */
function canonicalUuid(value: string): string {
  const hex = value.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FeedbackRequest {
  msid: string | null;
  mbid: string | null;
  score: -1 | 0 | 1;
}

function invalid(detail: string): LbHttpError {
  return new LbHttpError(400, `Invalid JSON document submitted: ${detail}`);
}

function uuidField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(`${key} must be a valid UUID`);
  return canonicalUuid(value);
}

/** ListenBrainz's recording-feedback validation (module comment). */
export function parseFeedback(data: unknown): FeedbackRequest {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LbHttpError(400, FEEDBACK_MESSAGES.missingKeys);
  }
  const object = data as Record<string, unknown>;
  const has = (key: string) => Object.hasOwn(object, key);
  if ((!has('recording_msid') && !has('recording_mbid')) || !has('score')) {
    throw new LbHttpError(400, FEEDBACK_MESSAGES.missingKeys);
  }
  if (Object.keys(object).some((k) => k !== 'recording_msid' && k !== 'recording_mbid' && k !== 'score')) {
    throw new LbHttpError(400, FEEDBACK_MESSAGES.extraKeys);
  }
  const score = object.score;
  if (score !== -1 && score !== 0 && score !== 1) throw invalid('score must be either -1, 0 or 1');
  const msid = uuidField(object, 'recording_msid');
  const mbid = uuidField(object, 'recording_mbid');
  if (msid === null && mbid === null) {
    throw invalid('at least one of recording_msid or recording_mbid should be specified');
  }
  return { msid, mbid, score };
}

async function readFeedbackBody(req: Request): Promise<unknown> {
  try {
    return await readJsonBody(req, FEEDBACK_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'payload_too_large') throw new LbHttpError(413, 'The request body is too large.');
      throw new LbHttpError(400, FEEDBACK_MESSAGES.invalidJson);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Resolving an id to a track

export type FeedbackSource = 'indexed' | 'now_playing' | 'pending';

export interface FeedbackTarget {
  source: FeedbackSource;
  artist: string;
  track: string;
  album: string | null;
  recordingMbid: string | null;
}

interface TrackRow {
  artist: string;
  track: string;
  album: string | null;
  recording_mbid: string | null;
}

const TRACK_COLUMNS = 'artist, track, album, recording_mbid';

function targetOf(source: FeedbackSource, row: TrackRow): FeedbackTarget {
  return { source, artist: row.artist, track: row.track, album: row.album, recordingMbid: row.recording_mbid };
}

/** The MSID of display names, or null when they have no music key. */
async function msidOfNames(artist: unknown, track: unknown): Promise<string | null> {
  if (typeof artist !== 'string' || typeof track !== 'string') return null;
  try {
    return await recordingMsid(artist, track);
  } catch (error) {
    if (error instanceof MusicKeyError || error instanceof RangeError) return null;
    throw error;
  }
}

/** The track keys of display names, or null. */
function keysOfNames(artist: unknown, track: unknown): readonly [string, string] | null {
  if (typeof artist !== 'string' || typeof track !== 'string') return null;
  try {
    return trackKey(artist, track);
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
}

async function indexedByMsid(m: Pick<ModuleDeps, 'db'>, did: string, msid: string): Promise<FeedbackTarget | null> {
  const stored = m.db.one<TrackRow>(
    `SELECT ${TRACK_COLUMNS} FROM scrobbles WHERE did = ? AND recording_msid = ?
     ORDER BY listened_at DESC, uri DESC LIMIT 1`,
    did,
    msid,
  );
  if (stored !== null) return targetOf('indexed', stored);
  // Rows projected before the MSID column existed: recompute per distinct key.
  const groups = m.db.all<{ artist_key: string; track_key: string; newest: string }>(
    `SELECT artist_key, track_key, max(listened_at || ' ' || uri) AS newest FROM scrobbles
     WHERE did = ? AND recording_msid IS NULL GROUP BY artist_key, track_key`,
    did,
  );
  for (const g of groups) {
    if ((await recordingMsidOfKey([g.artist_key, g.track_key])) !== msid) continue;
    const row = m.db.one<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM scrobbles WHERE uri = ?`, g.newest.slice(31));
    if (row !== null) return targetOf('indexed', row);
  }
  return null;
}

interface PendingCreate {
  artist: unknown;
  track: unknown;
  album?: unknown;
  recordingMbid?: unknown;
}

/** The caller's newest not-yet-indexed scrobble.create records. */
function pendingCreates(m: Pick<ModuleDeps, 'db'>, did: string): PendingCreate[] {
  const rows = m.db.all<{ record_json: string }>(
    `SELECT o.record_json AS record_json FROM operations o
     WHERE o.did = ? AND o.kind = 'scrobble.create' AND o.state NOT IN ('failed', 'cancelled')
       AND o.record_json IS NOT NULL
       AND (o.result_uri IS NULL OR NOT EXISTS (SELECT 1 FROM scrobbles s WHERE s.uri = o.result_uri))
     ORDER BY o.created_at_ms DESC, o.rowid DESC LIMIT ?`,
    did,
    PENDING_SCAN_LIMIT,
  );
  const out: PendingCreate[] = [];
  for (const row of rows) {
    try {
      const record = JSON.parse(row.record_json) as unknown;
      if (record !== null && typeof record === 'object' && !Array.isArray(record)) out.push(record as PendingCreate);
    } catch {
      // A malformed stored record matches nothing.
    }
  }
  return out;
}

function pendingTarget(record: PendingCreate): FeedbackTarget {
  return {
    source: 'pending',
    artist: String(record.artist),
    track: String(record.track),
    album: typeof record.album === 'string' ? record.album : null,
    recordingMbid: typeof record.recordingMbid === 'string' ? record.recordingMbid : null,
  };
}

/** The track an MSID or MBID names in the caller's own data (module comment), or null. */
export async function resolveFeedbackTarget(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  did: string,
  ids: { msid: string | null; mbid: string | null },
): Promise<FeedbackTarget | null> {
  if (ids.msid !== null) {
    const msid = ids.msid;
    const indexed = await indexedByMsid(m, did, msid);
    if (indexed !== null) return indexed;
    const playing = ownNowPlaying(m, did);
    if (playing !== null && (await msidOfNames(playing.artist, playing.track)) === msid) {
      return targetOf('now_playing', playing);
    }
    // One MSID per distinct key, newest create first.
    const seen = new Map<string, boolean>();
    for (const record of pendingCreates(m, did)) {
      const keys = keysOfNames(record.artist, record.track);
      if (keys === null) continue;
      const id = `${keys[0]}\u0000${keys[1]}`;
      let match = seen.get(id);
      if (match === undefined) {
        match = (await recordingMsidOfKey(keys)) === msid;
        seen.set(id, match);
      }
      if (match) return pendingTarget(record);
    }
  }
  if (ids.mbid !== null) {
    const mbid = ids.mbid;
    const indexed = m.db.one<TrackRow>(
      `SELECT ${TRACK_COLUMNS} FROM scrobbles WHERE did = ? AND recording_mbid = ?
       ORDER BY listened_at DESC, uri DESC LIMIT 1`,
      did,
      mbid,
    );
    if (indexed !== null) return targetOf('indexed', indexed);
    const playing = ownNowPlaying(m, did);
    if (playing !== null && playing.recording_mbid === mbid) return targetOf('now_playing', playing);
    for (const record of pendingCreates(m, did)) {
      if (record.recordingMbid === mbid && keysOfNames(record.artist, record.track) !== null) {
        return pendingTarget(record);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers

export interface FeedbackOptions {
  /** Kicks the outbox after a love or unlove is queued. */
  kick?: () => void;
}

async function postRecordingFeedback(
  req: Request,
  ctx: RequestCtx,
  lb: LbRequest,
  options: FeedbackOptions,
): Promise<Response> {
  const m = need(ctx, 'deps');
  if (lb.auth.status !== 'valid') throw new Error('recording-feedback reached without a valid token');
  const did = lb.auth.token.did;
  const feedback = parseFeedback(await readFeedbackBody(req));
  if (m.config.prefix === null) return lbError(503, FEEDBACK_MESSAGES.unavailable);

  const target = await resolveFeedbackTarget(m, did, feedback);
  if (target === null) return lbJson({ status: 'ok' });

  const result =
    feedback.score === 1
      ? await enqueueLove(m, {
          did,
          input: {
            artist: target.artist,
            track: target.track,
            ...(target.album === null ? {} : { album: target.album }),
            ...(target.recordingMbid === null ? {} : { recordingMbid: target.recordingMbid }),
          },
          origin: 'listenbrainz',
          kick: options.kick,
        })
      : await enqueueUnlove(m, {
          did,
          artist: target.artist,
          track: target.track,
          origin: 'listenbrainz',
          kick: options.kick,
        });
  if (!result.ok) {
    // The candidate's names were valid when it was scrobbled; nothing usable is stored.
    m.log.log('warn', 'listenbrainz.feedback_unusable', {
      requestId: ctx.requestId,
      source: target.source,
      field: result.reason.field,
      code: result.reason.code,
    });
  }
  return lbJson({ status: 'ok' });
}

async function getFeedback(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const q = queryOf(req);
  const score = intArg(q, 'score');
  const metadata = booleanArg(q, 'metadata', false);
  const offset = nonNegativeArg(q, 'offset', 0);
  const count = Math.min(nonNegativeArg(q, 'count', LB_DEFAULT_COUNT), LB_MAX_COUNT);
  const user = resolveLbUser(m, params.user ?? '');
  if (score && score !== 1 && score !== -1) throw new LbHttpError(400, FEEDBACK_MESSAGES.badScoreFilter);
  if (score === -1) return lbJson({ feedback: [], count: 0, total_count: 0, offset });

  const page = lovedTracks(m, { did: user.did, limit: Math.max(count, 1), offset });
  if (page === null) throw new LbHttpError(404, `Cannot find user: ${params.user ?? ''}`);
  const rows = count === 0 ? [] : page.rows;
  const name = displayName(m.db, user.did);
  const feedback = await Promise.all(
    rows.map(async (love) => ({
      user_id: name,
      recording_msid: await recordingMsidOfKey([love.artist_key, love.track_key]),
      recording_mbid: love.recording_mbid,
      score: 1,
      created: storageToUnixSeconds(love.created_at),
      ...(metadata
        ? {
            track_metadata: {
              artist_name: love.artist,
              track_name: love.track,
              ...(love.album === null ? {} : { release_name: love.album }),
            },
          }
        : {}),
    })),
  );
  return lbJson({ feedback, count: feedback.length, total_count: page.total, offset });
}

/** The feedback routes (mounted by routes.ts). */
export function feedbackRoutes(options: FeedbackOptions = {}): LbRouteDef[] {
  return [
    {
      method: 'POST',
      pattern: '/1/feedback/recording-feedback',
      auth: 'required',
      handler: (req, ctx, _params, lb) => postRecordingFeedback(req, ctx, lb, options),
    },
    { method: 'GET', pattern: '/1/feedback/user/{user}/get-feedback', handler: getFeedback },
  ];
}
