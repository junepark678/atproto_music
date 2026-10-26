// The `listenbrainz_api` import source (ADR 0005 §11.1, §11.3; N3-09).
//
// `GET /1/user/{name}/listens?count=1000&max_ts=…`, walking backward from a
// `max_ts` fixed when the job starts (the start second + 1). The next
// `max_ts` is the page's oldest `listened_at` + 1; listens at that boundary
// second already taken are skipped by identity (pageBoundary, staging.ts),
// and a page that brings nothing older moves `max_ts` to the oldest second
// itself, so the walk always progresses. A page shorter than `count` ends it.
// The user's linked ListenBrainz token is sent as `Authorization: Token …`
// when the DID has an active link.
//
// The request goes through policyFetch. At most one request per second
// (the caller's pacer); the answer's `X-RateLimit-Remaining` and
// `X-RateLimit-Reset-In` are returned so the caller can hold the pacer until
// the window resets when nothing is left of it.
//
// Answers:
// - 200 → a page;
// - 429 → `rate_limited` until now + X-RateLimit-Reset-In (or the backoff);
// - 5xx (503 included), a non-JSON body, a TransportError → `retry`;
// - 401 → `pause upstream_unauthorized` (the linked token was reset);
// - 404 → `fail remote_user_not_found`; any other status → `fail listenbrainz_error`.

import { mapListenBrainzListen } from '@atmusic/core/protocol-map';
import type { BoundPolicyFetch } from '../node/policy-fetch';
import type { FetchOutcome } from './jobs';
import { type Boundary, type ListenEntry, type ParsedEntry, pageBoundary, sha256Hex } from './staging';

export const LISTENBRAINZ_PAGE_COUNT = 1_000;

export interface ListenBrainzCursor {
  /** The exclusive upper bound (UNIX seconds) of the next request. */
  maxTs: number;
  boundary: Boundary | null;
}

export interface ListenBrainzFetchDeps {
  fetch: BoundPolicyFetch;
  /** LISTENBRAINZ_API_ROOT, e.g. `https://api.listenbrainz.org/`. */
  apiRoot: string;
}

export function initialListenBrainzCursor(nowMs: number): ListenBrainzCursor {
  return { maxTs: Math.floor(nowMs / 1000) + 1, boundary: null };
}

/** The upstream's rate-limit headers, when it sent them. */
export interface RateInfo {
  remaining: number | null;
  resetInSeconds: number | null;
}

const INT = /^\s*([0-9]{1,10})\s*$/;

function headerInt(headers: Headers, name: string): number | null {
  const m = INT.exec(headers.get(name) ?? '');
  return m === null ? null : Number(m[1]);
}

export function rateInfo(headers: Headers): RateInfo {
  return {
    remaining: headerInt(headers, 'x-ratelimit-remaining'),
    resetInSeconds: headerInt(headers, 'x-ratelimit-reset-in'),
  };
}

export function listensUrl(apiRoot: string, user: string, maxTs: number): string {
  const url = new URL(`1/user/${encodeURIComponent(user)}/listens`, apiRoot.endsWith('/') ? apiRoot : `${apiRoot}/`);
  url.searchParams.set('count', String(LISTENBRAINZ_PAGE_COUNT));
  url.searchParams.set('max_ts', String(maxTs));
  return url.href;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** ListenBrainz `listened_at`: an integer, a float (the export) or an all-digit string → whole seconds. */
export function listenedAtSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^[0-9]{1,15}(\.[0-9]+)?$/.test(value)) return Math.floor(Number(value));
  return null;
}

/** One ListenBrainz listen object → a staged entry (record MBIDs from additional_info only). */
export function mapListenBrainzRow(listen: unknown): { entry: ParsedEntry; second: number | null; id: string } {
  const o = obj(listen) ?? {};
  const second = listenedAtSeconds(o.listened_at);
  const meta = o.track_metadata;
  const id = sha256Hex(JSON.stringify([second, o.recording_msid ?? null, meta ?? null]));
  const mapped = mapListenBrainzListen({ listened_at: second ?? o.listened_at, track_metadata: meta });
  if (!mapped.ok) return { entry: { kind: 'invalid', reason: mapped.reason }, second, id };
  const entry: ListenEntry = { kind: 'listen', input: mapped.input, listenedAtSeconds: mapped.listenedAtSeconds };
  return { entry, second, id };
}

export type ListenBrainzOutcome = FetchOutcome<ListenBrainzCursor> & { rate: RateInfo | null };

/** One page of the backward walk (see the header). */
export async function fetchListenBrainzPage(
  deps: ListenBrainzFetchDeps,
  args: { user: string; token: string | null; cursor: ListenBrainzCursor; nowMs: number },
): Promise<ListenBrainzOutcome> {
  let response: Response;
  let body: unknown;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (args.token !== null) headers.authorization = `Token ${args.token}`;
    response = await deps.fetch(listensUrl(deps.apiRoot, args.user, args.cursor.maxTs), { method: 'GET', headers });
    const raw = await response.text();
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  } catch {
    return { kind: 'retry', reason: 'network', rate: null };
  }
  const rate = rateInfo(response.headers);
  if (response.status === 429) {
    const until = rate.resetInSeconds === null ? undefined : args.nowMs + Math.max(1, rate.resetInSeconds) * 1000;
    return { kind: 'rate_limited', ...(until === undefined ? {} : { untilMs: until }), rate };
  }
  if (response.status >= 500) return { kind: 'retry', reason: `http_${response.status}`, rate };
  if (response.status === 401) return { kind: 'pause', error: 'upstream_unauthorized', rate };
  if (response.status === 404) return { kind: 'fail', error: 'remote_user_not_found', rate };
  if (response.status !== 200) return { kind: 'fail', error: 'listenbrainz_error', rate };
  const payload = obj(obj(body)?.payload);
  const listens = payload?.listens;
  if (!Array.isArray(listens)) return { kind: 'retry', reason: 'malformed_page', rate };

  const rows = listens.map(mapListenBrainzRow);
  const timed = rows.filter((row) => row.second !== null) as Array<(typeof rows)[number] & { second: number }>;
  const { keep, next } = pageBoundary(args.cursor.boundary, timed, args.cursor.maxTs);
  const entries: ParsedEntry[] = [];
  for (const row of rows) {
    if (row.second !== null && !keep.has(row as (typeof timed)[number])) continue;
    entries.push(row.entry);
  }
  const done = listens.length < LISTENBRAINZ_PAGE_COUNT || timed.length === 0;
  return { kind: 'page', entries, cursor: { maxTs: next.bound, boundary: next.boundary }, done, rate };
}
