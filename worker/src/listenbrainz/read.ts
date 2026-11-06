// ListenBrainz-compatible reads (ADR 0005 §8.4, §9; N3-06):
//
//   GET /1/user/{user}/listens        {payload: {count, listens, latest_listen_ts, oldest_listen_ts, user_id}}
//   GET /1/user/{user}/playing-now    {payload: {count, user_id, playing_now: true, listens}}
//   GET /1/user/{user}/listen-count   {payload: {count}}
//
// and the plumbing the other /1/ read and write modules share: `LbHttpError`
// (answered by the router, routes.ts, as `{code, error}` with the CORS and
// X-RateLimit-* sets), ListenBrainz's integer and boolean argument parsers,
// and the §9 user resolution.
//
// - `{user}` resolves through `lookupUser` (§9: `did:` values, dotless
//   usernames, a dotted username only while it is its owner's verified handle,
//   then verified handles); only a visible user is found. Unknown → 404
//   "Cannot find user: <path value>". `user_id` echoes the path value exactly
//   as typed; every other name in a payload (`user_name`) is the account's
//   protocol name (`displayName`: username, else verified handle, else DID).
// - listens: ListenBrainz `_validate_get_endpoint_params` first (`max_ts` and
//   `min_ts` must be integers, "Invalid max_ts argument: x"; `count` a
//   non-negative integer, default 25, silently capped at 1,000), then the
//   `min_ts and max_ts and min_ts >= max_ts` check (Python truthiness, so a 0
//   bound never trips it) → 400 "max_ts should be greater than min_ts", then
//   the user. Bounds are exclusive at second precision (do/read/recent.ts);
//   a bound outside the storage range is clamped to the bound that selects
//   the same listens (min_ts < 0 is no lower bound, max_ts ≤ 0 selects
//   nothing). With `min_ts` the oldest `count` listens after it are taken and
//   reversed, so output is always newest first. `latest_listen_ts` and
//   `oldest_listen_ts` span the user's whole visible history; 0 when the
//   user has no listens, as ListenBrainz's listen metadata reports.
// - Each listen is `{listened_at, inserted_at, recording_msid, user_name,
//   track_metadata}`: `inserted_at` is when the index stored the verified
//   record (UNIX s); `recording_msid` is the stored column, else computed from
//   the stored music keys (packages/core/src/msid.ts: the same UUIDv5 the
//   projection stores); `track_metadata` has `artist_name`, `track_name`,
//   `release_name` (only when the record has an album) and `additional_info`
//   with the §6.2 fields mapped back to ListenBrainz's keys, present only when
//   set. `mbid_mapping` is omitted: we do no MusicBrainz mapping.
// - playing-now shows the current entry only when its owner shares now playing
//   (do/read/now-playing.ts `currentNowPlaying`), else count 0 and [].
// - listen-count counts the user's visible indexed listens.

import { recordingMsidOfKey } from '@atmusic/core/msid';
import type { NowPlayingRow, ScrobbleRowV2 } from '../app/rows';
import { displayName } from '../credentials/accounts';
import type { ModuleDeps } from '../do/contracts';
import { currentNowPlaying } from '../do/read/now-playing';
import { type ListensPage, listensByTimestamp, MAX_UNIX_SECONDS, storageToUnixSeconds } from '../do/read/recent';
import { lookupUser, type ProtocolUser } from '../do/read/user-lookup';
import { visibleScrobblesFrom } from '../do/read/visibility';
import { need, type RequestCtx } from '../http/types';
import { lbJson } from './errors';
import type { LbRouteDef } from './routes';

// ---------------------------------------------------------------------------
// Shared plumbing

/** A ListenBrainz error answer: the router (routes.ts) sends `{code: status, error: message}`. */
export class LbHttpError extends Error {
  override readonly name = 'LbHttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`LbHttpError needs an HTTP error status, got ${status}`);
    }
  }
}

/** ListenBrainz DEFAULT_ITEMS_PER_GET. */
export const LB_DEFAULT_COUNT = 25;
/** ListenBrainz MAX_ITEMS_PER_GET. */
export const LB_MAX_COUNT = 1000;

/** Python `int()` of a query value: optional whitespace, an optional sign, decimal digits. */
const PY_INT = /^\s*[+-]?[0-9]+\s*$/;

/**
 * ListenBrainz `_parse_int_arg`: an absent or empty value is `undefined`, a
 * non-integer is 400 "Invalid <name> argument: <value>". Values beyond the
 * safe-integer range are clamped (they select the same rows).
 */
export function intArg(q: URLSearchParams, name: string): number | undefined {
  const value = q.get(name);
  if (value === null || value === '') return undefined;
  if (!PY_INT.test(value)) throw new LbHttpError(400, `Invalid ${name} argument: ${value}`);
  const n = Number(value.trim());
  if (Number.isSafeInteger(n)) return n;
  return n < 0 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
}

/** ListenBrainz `get_non_negative_param`: 400 "'<name>' should be a non-negative integer" for a negative value. */
export function nonNegativeArg(q: URLSearchParams, name: string, def: number): number {
  const value = intArg(q, name) ?? def;
  if (value < 0) throw new LbHttpError(400, `'${name}' should be a non-negative integer`);
  return value;
}

/** ListenBrainz `parse_boolean_arg`: `true`/`false` in any case; absent or empty is `def`. */
export function booleanArg(q: URLSearchParams, name: string, def: boolean): boolean {
  const value = q.get(name);
  if (value === null || value === '') return def;
  const lower = value.toLowerCase();
  if (lower !== 'true' && lower !== 'false') {
    throw new LbHttpError(400, `Invalid ${name} argument: ${lower}. Must be 'true' or 'false'`);
  }
  return lower === 'true';
}

/** The visible user `value` names (§9), or 404 "Cannot find user: <value>". */
export function resolveLbUser(m: Pick<ModuleDeps, 'db'>, value: string): ProtocolUser {
  const user = lookupUser(m, value);
  if (user === null) throw new LbHttpError(404, `Cannot find user: ${value}`);
  return user;
}

/** The query of a request. */
export function queryOf(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

/** UNIX seconds (floor) of epoch ms. */
export function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Listen serialisation

/** The stored MSID, else the one of the stored music keys. */
export async function msidOfRow(row: Pick<ScrobbleRowV2, 'recording_msid' | 'artist_key' | 'track_key'>) {
  return row.recording_msid ?? (await recordingMsidOfKey([row.artist_key, row.track_key]));
}

function parseMbids(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/** `additional_info` of a stored listen: the §6.2 fields under ListenBrainz's keys, only those that are set. */
export function additionalInfoOf(row: ScrobbleRowV2): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) info[key] = value;
  };
  put('release_artist_name', row.album_artist);
  put('tracknumber', row.track_number);
  put('artist_mbids', parseMbids(row.artist_mbids));
  put('recording_mbid', row.recording_mbid);
  put('release_mbid', row.release_mbid);
  put('release_group_mbid', row.release_group_mbid);
  put('isrc', row.isrc);
  put('duration_ms', row.duration_seconds === null ? null : row.duration_seconds * 1000);
  put('submission_client', row.submission_client);
  put('music_service', row.music_service);
  return info;
}

export interface LbTrackMetadata {
  artist_name: string;
  track_name: string;
  release_name?: string;
  additional_info: Record<string, unknown>;
}

export function trackMetadataOf(row: ScrobbleRowV2): LbTrackMetadata {
  return {
    artist_name: row.artist,
    track_name: row.track,
    ...(row.album === null ? {} : { release_name: row.album }),
    additional_info: additionalInfoOf(row),
  };
}

export interface LbListen {
  listened_at: number;
  inserted_at: number;
  recording_msid: string;
  user_name: string;
  track_metadata: LbTrackMetadata;
}

export async function listenOf(row: ScrobbleRowV2, userName: string): Promise<LbListen> {
  return {
    listened_at: storageToUnixSeconds(row.listened_at),
    inserted_at: storageToUnixSeconds(row.indexed_at),
    recording_msid: await msidOfRow(row),
    user_name: userName,
    track_metadata: trackMetadataOf(row),
  };
}

function nowPlayingMetadata(row: NowPlayingRow): LbTrackMetadata {
  const info: Record<string, unknown> = {};
  if (row.album_artist !== null) info.release_artist_name = row.album_artist;
  if (row.recording_mbid !== null) info.recording_mbid = row.recording_mbid;
  if (row.duration_seconds !== null) info.duration_ms = row.duration_seconds * 1000;
  if (row.client !== null) info.submission_client = row.client;
  return {
    artist_name: row.artist,
    track_name: row.track,
    ...(row.album === null ? {} : { release_name: row.album }),
    additional_info: info,
  };
}

// ---------------------------------------------------------------------------
// Handlers

/** The exclusive bounds as recent.ts takes them (see the module comment). */
function clampBounds(minRaw: number | undefined, maxRaw: number | undefined) {
  let minTs: number | null = null;
  let maxTs: number | null = null;
  if (minRaw !== undefined && minRaw >= 0) minTs = Math.min(minRaw, MAX_UNIX_SECONDS);
  if (maxRaw !== undefined && maxRaw <= MAX_UNIX_SECONDS) maxTs = Math.max(maxRaw, 0);
  return { minTs, maxTs };
}

async function getListens(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const q = queryOf(req);
  const maxRaw = intArg(q, 'max_ts');
  const minRaw = intArg(q, 'min_ts');
  const count = Math.min(nonNegativeArg(q, 'count', LB_DEFAULT_COUNT), LB_MAX_COUNT);
  if (minRaw && maxRaw && minRaw >= maxRaw) throw new LbHttpError(400, 'max_ts should be greater than min_ts');
  const pathUser = params.user ?? '';
  const user = resolveLbUser(m, pathUser);

  const { minTs, maxTs } = clampBounds(minRaw, maxRaw);
  // A clamped empty interval (or a 0 bound Python's truthiness let through) selects nothing.
  const empty = minTs !== null && maxTs !== null && maxTs <= minTs;
  const page: ListensPage | null = listensByTimestamp(m, {
    did: user.did,
    minTs: empty ? null : minTs,
    maxTs: empty ? null : maxTs,
    count: empty ? 0 : count,
  });
  if (page === null) throw new LbHttpError(404, `Cannot find user: ${pathUser}`);
  const name = displayName(m.db, user.did);
  const listens = await Promise.all(page.rows.map((row) => listenOf(row, name)));
  return lbJson({
    payload: {
      count: listens.length,
      listens,
      latest_listen_ts: page.latestListenTs ?? 0,
      oldest_listen_ts: page.oldestListenTs ?? 0,
      user_id: pathUser,
    },
  });
}

async function getPlayingNow(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const pathUser = params.user ?? '';
  const user = resolveLbUser(m, pathUser);
  const row = currentNowPlaying(m, user.did);
  const name = displayName(m.db, user.did);
  const listens =
    row === null ? [] : [{ track_metadata: nowPlayingMetadata(row), user_name: name, playing_now: true as const }];
  return lbJson({ payload: { count: listens.length, user_id: pathUser, playing_now: true, listens } });
}

async function getListenCount(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const m = need(ctx, 'deps');
  const user = resolveLbUser(m, params.user ?? '');
  const count =
    m.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.did = ?`, user.did)
      ?.n ?? 0;
  return lbJson({ payload: { count } });
}

/** The read routes (mounted by routes.ts). */
export function readRoutes(): LbRouteDef[] {
  return [
    { method: 'GET', pattern: '/1/user/{user}/listens', handler: getListens },
    { method: 'GET', pattern: '/1/user/{user}/playing-now', handler: getPlayingNow },
    { method: 'GET', pattern: '/1/user/{user}/listen-count', handler: getListenCount },
  ];
}
