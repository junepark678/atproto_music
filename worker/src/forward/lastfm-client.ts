// The outbound Last.fm 2.0 client of forwarding and linking (ADR 0005 §12.1,
// §12.3; N3-08). It talks to `LASTFM_API_ROOT` with the owner's api_key and
// shared secret (secrets.lastfm), always through policyFetch (N1-05): https
// only, default port, no IP literal, redirects refused (a 3xx is a
// TransportError `redirect`, its Location never read), a 10 s deadline and
// bounded bodies.
//
// Every call is a POST of an `application/x-www-form-urlencoded` body with
// `method`, `api_key`, the method's parameters, `api_sig` and `format=json`.
// `api_sig` is Last.fm's rule (lastfm/signature.ts computeSignature): every
// parameter except `api_sig`, `format` and `callback`, sorted by name in byte
// order, `name + value` concatenated, the shared secret appended, MD5 in hex.
// Unset optional parameters are simply not sent.
//
// Answers are classified, never thrown:
//   ok          a 2xx JSON body without an `error` member
//   error       a Last.fm error envelope `{error, message}` (any HTTP status)
//   http        any other non-2xx answer (a load balancer page)
//   network     a TransportError (refused URL, DNS, connect, timeout, size, redirect)
//   malformed   a 2xx answer that is not the expected JSON
// The forwarder decides what each means for its rows (§12.3). A credential
// never appears in an outcome or a thrown error.

import { computeSignature } from '../lastfm/signature';
import { isTransportError } from '../node/pinned-transport';
import type { BoundPolicyFetch, PolicyCaps } from '../node/policy-fetch';

/** Request and response bodies of one Last.fm call (50 scrobbles fit well within 1 MiB). */
export const LASTFM_CAPS: Readonly<PolicyCaps> = Object.freeze({
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576,
});

/** At most this many scrobbles per track.scrobble request (Last.fm's limit). */
export const LASTFM_MAX_BATCH = 50;

export interface LastfmClientOptions {
  /** LASTFM_API_ROOT, e.g. https://ws.audioscrobbler.com/2.0/ */
  apiRoot: string;
  apiKey: string;
  sharedSecret: string;
  /** policyFetch with LASTFM_CAPS bound. */
  fetch: BoundPolicyFetch;
}

export type LastfmFailure =
  | { ok: false; kind: 'error'; code: number; httpStatus: number; retryAfterS: number | null }
  | { ok: false; kind: 'http'; httpStatus: number; retryAfterS: number | null }
  | { ok: false; kind: 'network'; error: string }
  | { ok: false; kind: 'malformed'; httpStatus: number };

export type LastfmOutcome<T> = { ok: true; value: T } | LastfmFailure;

/** One track.scrobble entry as sent (the original, uncorrected input). */
export interface LastfmTrack {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  /** Seconds. */
  duration?: number;
  trackNumber?: number;
  /** MusicBrainz recording id. */
  mbid?: string;
}

export interface LastfmScrobbleItem extends LastfmTrack {
  /** UNIX seconds. */
  timestamp: number;
}

export interface LastfmSession {
  name: string;
  key: string;
}

function retryAfterOf(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null || !/^\s*\d{1,9}\s*$/.test(raw)) return null;
  return Number(raw.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trackParams(track: LastfmTrack, suffix: string): [string, string][] {
  const out: [string, string][] = [
    [`artist${suffix}`, track.artist],
    [`track${suffix}`, track.track],
  ];
  if (track.album !== undefined) out.push([`album${suffix}`, track.album]);
  if (track.albumArtist !== undefined) out.push([`albumArtist${suffix}`, track.albumArtist]);
  if (track.duration !== undefined) out.push([`duration${suffix}`, String(track.duration)]);
  if (track.trackNumber !== undefined) out.push([`trackNumber${suffix}`, String(track.trackNumber)]);
  if (track.mbid !== undefined) out.push([`mbid${suffix}`, track.mbid]);
  return out;
}

export class LastfmClient {
  readonly apiRoot: string;
  readonly apiKey: string;
  private readonly sharedSecret: string;
  private readonly fetch: BoundPolicyFetch;

  constructor(options: LastfmClientOptions) {
    this.apiRoot = options.apiRoot;
    this.apiKey = options.apiKey;
    this.sharedSecret = options.sharedSecret;
    this.fetch = options.fetch;
  }

  /** The signed form body of `method` with `params` (format=json added after signing). */
  signedBody(method: string, params: readonly (readonly [string, string])[]): URLSearchParams {
    const pairs: [string, string][] = [
      ['method', method],
      ['api_key', this.apiKey],
      ...params.map(([k, v]) => [k, v] as [string, string]),
    ];
    const body = new URLSearchParams();
    for (const [k, v] of pairs) body.append(k, v);
    body.append('api_sig', computeSignature(pairs, this.sharedSecret));
    body.append('format', 'json');
    return body;
  }

  /** One signed POST; the body parsed as JSON and classified. */
  async call(method: string, params: readonly (readonly [string, string])[]): Promise<LastfmOutcome<unknown>> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetch(this.apiRoot, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' },
        body: this.signedBody(method, params).toString(),
      });
      text = await res.text();
    } catch (error) {
      if (isTransportError(error)) return { ok: false, kind: 'network', error: error.code };
      throw error;
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (isObject(body) && typeof body.error === 'number' && Number.isInteger(body.error)) {
      return {
        ok: false,
        kind: 'error',
        code: body.error,
        httpStatus: res.status,
        retryAfterS: retryAfterOf(res.headers),
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, kind: 'http', httpStatus: res.status, retryAfterS: retryAfterOf(res.headers) };
    }
    if (!isObject(body)) return { ok: false, kind: 'malformed', httpStatus: res.status };
    return { ok: true, value: body };
  }

  /** auth.getSession for a token the user approved on Last.fm (the link callback). */
  async getSession(token: string): Promise<LastfmOutcome<LastfmSession>> {
    const out = await this.call('auth.getSession', [['token', token]]);
    if (!out.ok) return out;
    const session = (out.value as { session?: unknown }).session;
    if (!isObject(session) || typeof session.name !== 'string' || typeof session.key !== 'string') {
      return { ok: false, kind: 'malformed', httpStatus: 200 };
    }
    if (session.name === '' || session.key === '') return { ok: false, kind: 'malformed', httpStatus: 200 };
    return { ok: true, value: { name: session.name, key: session.key } };
  }

  /**
   * track.scrobble of 1–50 entries (always the indexed `[i]` form). The value
   * is each entry's `ignoredMessage` code, in input order (0 = accepted).
   */
  async scrobble(sk: string, items: readonly LastfmScrobbleItem[]): Promise<LastfmOutcome<number[]>> {
    if (items.length < 1 || items.length > LASTFM_MAX_BATCH) {
      throw new RangeError(`track.scrobble takes 1-${LASTFM_MAX_BATCH} entries, got ${items.length}`);
    }
    const params: [string, string][] = [['sk', sk]];
    items.forEach((item, i) => {
      params.push(...trackParams(item, `[${i}]`), [`timestamp[${i}]`, String(item.timestamp)]);
    });
    const out = await this.call('track.scrobble', params);
    if (!out.ok) return out;
    const scrobbles = (out.value as { scrobbles?: unknown }).scrobbles;
    if (!isObject(scrobbles)) return { ok: false, kind: 'malformed', httpStatus: 200 };
    const raw = scrobbles.scrobble;
    const rows = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    if (rows.length !== items.length) return { ok: false, kind: 'malformed', httpStatus: 200 };
    const codes: number[] = [];
    for (const row of rows) {
      const ignored = isObject(row) ? row.ignoredMessage : undefined;
      const code = isObject(ignored) ? Number(ignored.code ?? 0) : 0;
      if (!Number.isInteger(code) || code < 0) return { ok: false, kind: 'malformed', httpStatus: 200 };
      codes.push(code);
    }
    return { ok: true, value: codes };
  }

  /** track.updateNowPlaying. */
  async updateNowPlaying(sk: string, track: LastfmTrack): Promise<LastfmOutcome<null>> {
    const out = await this.call('track.updateNowPlaying', [['sk', sk], ...trackParams(track, '')]);
    return out.ok ? { ok: true, value: null } : out;
  }

  /** track.love or track.unlove. */
  async love(
    sk: string,
    method: 'track.love' | 'track.unlove',
    artist: string,
    track: string,
  ): Promise<LastfmOutcome<null>> {
    const out = await this.call(method, [
      ['sk', sk],
      ['artist', artist],
      ['track', track],
    ]);
    return out.ok ? { ok: true, value: null } : out;
  }
}
