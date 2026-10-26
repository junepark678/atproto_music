// The `lastfm_api` import source (ADR 0005 §11.1, §11.3; N3-09).
//
// `user.getRecentTracks` with `limit=200`, `extended=1`, the owner's api_key
// and, when the DID has an active linked Last.fm account, that account's `sk`
// (it reveals recent listening the user hides; the request is then signed
// with the owner's shared secret, as Last.fm requires for any request that
// carries a session key).
//
// Paging walks backward from a `to` fixed when the job starts (the start
// second + 1, so nothing scrobbled after the job began is fetched): each
// request asks for page 1 below the current `to`; the next `to` is the page's
// oldest `uts` + 1, and the listens at that boundary second that this job has
// already taken are skipped by identity (pageBoundary, staging.ts), so each
// upstream listen is fetched exactly once. If a page brings nothing older
// than the boundary, `to` becomes the oldest `uts`, so paging always makes
// progress. The `nowplaying` row is never a listen and is skipped. The walk
// ends with a page shorter than the limit.
//
// The request goes through policyFetch (the pinned transport, https only, no
// redirects, a deadline and a response cap). The global 1 request/s Last.fm
// pacing (shared with forwarding) is applied by the caller (jobs.ts) before
// this module is called.
//
// Answers:
// - Last.fm error 29 (rate limit) → `rate_limited`; 11, 16, 8, HTTP 5xx,
//   429, a non-JSON body and any TransportError → `retry` (the caller backs
//   off 30 s·2^n, capped at 1 h);
// - 9 or 4 (the linked sk was revoked) and 17 (the user's history is private
//   and no session was sent) → `pause` with `upstream_unauthorized`;
// - 10 or 26 (our api_key is invalid or suspended) → `fail lastfm_key_rejected`;
//   6 → `fail remote_user_not_found`; anything else → `fail lastfm_error`.

import { mapLastfmScrobble } from '@atmusic/core/protocol-map';
import { computeSignature } from '../lastfm/signature';
import type { BoundPolicyFetch } from '../node/policy-fetch';
import type { FetchOutcome } from './jobs';
import { type Boundary, type ListenEntry, type ParsedEntry, pageBoundary, sha256Hex } from './staging';

export const LASTFM_PAGE_LIMIT = 200;

export interface LastfmCursor {
  /** The exclusive upper bound (UNIX seconds) of the next request. */
  to: number;
  boundary: Boundary | null;
}

export interface LastfmFetchDeps {
  fetch: BoundPolicyFetch;
  /** LASTFM_API_ROOT, e.g. `https://ws.audioscrobbler.com/2.0/`. */
  apiRoot: string;
  apiKey: string;
  sharedSecret: string;
}

/** The cursor of a job started at `nowMs`. */
export function initialLastfmCursor(nowMs: number): LastfmCursor {
  return { to: Math.floor(nowMs / 1000) + 1, boundary: null };
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** A Last.fm text node: a string, or an object's `#text` (or `name` for extended artists). */
function text(value: unknown, key: '#text' | 'name' = '#text'): string | undefined {
  if (typeof value === 'string') return value;
  const o = obj(value);
  if (o === null) return undefined;
  const v = o[key] ?? (key === 'name' ? o['#text'] : undefined);
  return typeof v === 'string' ? v : undefined;
}

export interface LastfmRow {
  /** null for the now-playing row. */
  entry: ParsedEntry | null;
  /** UNIX seconds, or null when the row has no usable time. */
  second: number | null;
  /** Identity of the upstream row (boundary dedupe). */
  id: string;
}

/** Whether a `recenttracks.track` row is the now-playing row (the only row mapLastfmRow maps to no entry). */
export function isNowPlaying(row: unknown): boolean {
  const attr = obj(obj(row)?.['@attr']);
  return attr !== null && (attr.nowplaying === 'true' || attr.nowplaying === true);
}

/**
 * One `recenttracks.track` row (API page or the lastfm.ghan.nl export):
 * mapped with `mapLastfmScrobble` (packages/core/src/protocol-map.ts), or null
 * for the now-playing row.
 */
export function mapLastfmRow(row: unknown): LastfmRow {
  if (isNowPlaying(row)) return { entry: null, second: null, id: '' };
  const r = obj(row) ?? {};
  const artist = text(r.artist, 'name');
  const track = typeof r.name === 'string' ? r.name : undefined;
  const album = text(r.album);
  const mbid = typeof r.mbid === 'string' ? r.mbid : undefined;
  const date = obj(r.date);
  const uts = date !== null ? date.uts : r.uts;
  const timestamp = typeof uts === 'string' ? uts : typeof uts === 'number' ? String(uts) : undefined;
  const params: Record<string, string | undefined> = { artist, track, album, mbid, timestamp };
  const mapped = mapLastfmScrobble(params);
  const second = timestamp !== undefined && /^[0-9]{1,15}$/.test(timestamp) ? Number(timestamp) : null;
  const id = sha256Hex(JSON.stringify([artist ?? null, track ?? null, album ?? null, mbid ?? null, timestamp ?? null]));
  if (!mapped.ok) return { entry: { kind: 'invalid', reason: mapped.reason }, second, id };
  const entry: ListenEntry = { kind: 'listen', input: mapped.input, listenedAtSeconds: mapped.listenedAtSeconds };
  return { entry, second, id };
}

/** The rows of a getRecentTracks page (`track` may be one object instead of an array). */
export function pageTracks(page: unknown): unknown[] {
  const p = obj(page);
  if (p === null) return Array.isArray(page) ? page : [];
  const recent = obj(p.recenttracks) ?? p;
  const track = recent.track;
  if (Array.isArray(track)) return track;
  return obj(track) !== null ? [track] : [];
}

/** The GET URL of one request (signed when `sk` is present). Exposed for tests. */
export function recentTracksUrl(deps: LastfmFetchDeps, user: string, to: number, sk: string | null): string {
  const params: [string, string][] = [
    ['method', 'user.getRecentTracks'],
    ['user', user],
    ['limit', String(LASTFM_PAGE_LIMIT)],
    ['extended', '1'],
    ['page', '1'],
    ['to', String(to)],
    ['api_key', deps.apiKey],
  ];
  if (sk !== null) {
    params.push(['sk', sk]);
    params.push(['api_sig', computeSignature(params, deps.sharedSecret)]);
  }
  params.push(['format', 'json']);
  const url = new URL(deps.apiRoot);
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.href;
}

const RETRY_CODES = new Set([8, 11, 16]);

/** One page of the backward walk (see the header). */
export async function fetchLastfmPage(
  deps: LastfmFetchDeps,
  args: { user: string; sk: string | null; cursor: LastfmCursor },
): Promise<FetchOutcome<LastfmCursor>> {
  let response: Response;
  let body: unknown;
  try {
    response = await deps.fetch(recentTracksUrl(deps, args.user, args.cursor.to, args.sk), {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const raw = await response.text();
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  } catch {
    return { kind: 'retry', reason: 'network' };
  }
  const envelope = obj(body);
  const code = envelope !== null && typeof envelope.error === 'number' ? envelope.error : null;
  if (code !== null) {
    if (code === 29) return { kind: 'rate_limited' };
    if (RETRY_CODES.has(code)) return { kind: 'retry', reason: `lastfm_${code}` };
    if (code === 9 || code === 4 || code === 17) return { kind: 'pause', error: 'upstream_unauthorized' };
    if (code === 10 || code === 26) return { kind: 'fail', error: 'lastfm_key_rejected' };
    if (code === 6) return { kind: 'fail', error: 'remote_user_not_found' };
    return { kind: 'fail', error: 'lastfm_error' };
  }
  if (response.status === 429 || response.status >= 500 || envelope === null || response.status !== 200) {
    return { kind: 'retry', reason: `http_${response.status}` };
  }

  const rows = pageTracks(envelope).map(mapLastfmRow);
  const listens = rows.filter((row) => row.entry !== null);
  const timed = listens.filter((row) => row.second !== null) as Array<LastfmRow & { second: number }>;
  const { keep, next } = pageBoundary(args.cursor.boundary, timed, args.cursor.to);
  const entries: ParsedEntry[] = [];
  for (const row of listens) {
    if (row.second !== null && !keep.has(row as LastfmRow & { second: number })) continue;
    entries.push(row.entry as ParsedEntry);
  }
  const done = listens.length < LASTFM_PAGE_LIMIT || timed.length === 0;
  return { kind: 'page', entries, cursor: { to: next.bound, boundary: next.boundary }, done };
}
