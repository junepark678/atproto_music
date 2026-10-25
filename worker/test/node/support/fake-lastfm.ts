// A fake Last.fm 2.0 web service (ADR 0005 §15.2, N1-13). TEST-ONLY.
//
// It plays the upstream that imports (§11, `lastfm_api`) and forwarding (§12)
// talk to. It is a routerTransport endpoint (`routerTransport({hosts:
// {'lastfm.test': fake}})`) and can also be served on a local HTTP listener for
// the e2e stacks (`serveFake`). Everything is driven by the injected clock and
// by explicit scripting; nothing here reads the wall clock or randomness.
//
// Why here and not in packages/atproto/test-support: Last.fm's `api_sig` is MD5,
// WebCrypto has no MD5, and atproto's test-support compiles without Node types.
// This file therefore uses node:crypto directly. It deliberately does not import
// worker/src/crypto/md5.ts (N1-08): the fake is an independent implementation of
// the upstream's signature rule, pinned to the same vector N1-08 pins.
//
// Implemented methods (POST or GET, parameters from the query string and an
// application/x-www-form-urlencoded body, `format=json` for JSON, XML otherwise):
//
//   auth.getToken            signed
//   auth.getSession          signed; token issued + authorized → session
//   track.scrobble           signed + sk; ≤ 50 entries; inputs recorded
//   track.updateNowPlaying   signed + sk
//   track.love/track.unlove  signed + sk
//   user.getRecentTracks     unsigned; paged, newest first, now-playing row on page 1
//   user.getInfo             unsigned
//
// Scripted faults: `fail({code})` answers a Last.fm error body with the status
// of ADR 0005 §7.6; `fail({httpStatus})` answers a bare HTTP error page (what a
// load balancer in front of Last.fm returns). Per-item `ignoredMessage` codes
// (for example 5, the daily scrobble limit) are scripted with `ignoreItems`.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CallLog, type Routable } from '@atmusic/atproto/test-support/router-transport';
import type { Clock } from '@atmusic/core/deps';

export const LASTFM_HOST = 'lastfm.test';

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** MD5 hex of the UTF-8 bytes of `text` (node:crypto; WebCrypto has no MD5). */
export function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** Parameters that never take part in `api_sig`. */
const UNSIGNED_PARAMS = new Set(['api_sig', 'format', 'callback']);

/**
 * Last.fm's `api_sig`: every parameter except `api_sig`, `format` and
 * `callback`, sorted by name in byte order, concatenated as `name + value`,
 * the shared secret appended, MD5 in lowercase hex.
 */
export function lastfmSignature(params: Iterable<readonly [string, string]>, secret: string): string {
  const pairs = [...params].filter(([name]) => !UNSIGNED_PARAMS.has(name));
  pairs.sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return md5Hex(`${pairs.map(([name, value]) => name + value).join('')}${secret}`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Last.fm's error messages for the codes the fake can produce. */
export const LASTFM_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  2: 'Invalid service - This service does not exist',
  3: 'Invalid Method - No method with that name in this package',
  4: 'Authentication Failed - You do not have permissions to access the service',
  5: "Invalid format - This service doesn't exist in that format",
  6: 'Invalid parameters - Your request is missing a required parameter',
  7: 'Invalid resource specified',
  8: 'Operation failed - Most likely the backend service failed. Please try again.',
  9: 'Invalid session key - Please re-authenticate',
  10: 'Invalid API key - You must be granted a valid key by last.fm',
  11: 'Service Offline - This service is temporarily offline. Try again later.',
  13: 'Invalid method signature supplied',
  14: 'This token has not been authorized',
  15: 'This token has expired',
  16: 'There was a temporary error processing your request. Please try again',
  26: 'Suspended API key - Access for your account has been suspended, please contact Last.fm',
  29: 'Rate Limit Exceeded - Your IP has made too many requests in a short period',
};

/** HTTP status paired with each error code (ADR 0005 §7.6). */
export const LASTFM_ERROR_STATUS: Readonly<Record<number, number>> = {
  2: 400,
  3: 400,
  4: 403,
  5: 400,
  6: 400,
  7: 400,
  8: 500,
  9: 403,
  10: 403,
  11: 503,
  13: 403,
  14: 403,
  15: 403,
  16: 503,
  26: 403,
  29: 429,
};

/** Per-item `ignoredMessage` texts for track.scrobble. */
export const LASTFM_IGNORED_MESSAGES: Readonly<Record<number, string>> = {
  1: 'Artist name failed filter',
  2: 'Track name failed filter',
  3: 'Timestamp failed filter',
  4: 'Timestamp failed filter',
  5: 'Daily scrobble limit exceeded',
};

export type LastfmFault =
  /** A Last.fm error body (`{error, message}` / `<lfm status="failed">`) with the §7.6 status. */
  | { code: number; message?: string; status?: number; retryAfter?: number; method?: string }
  /** A bare HTTP error (text/html body, no Last.fm envelope). */
  | { httpStatus: number; body?: string; method?: string };

// ---------------------------------------------------------------------------
// Response tree → JSON / XML
// ---------------------------------------------------------------------------

/**
 * Responses are built in Last.fm's JSON shape. XML is derived from it with
 * Last.fm's own mapping: an object with `#text` is a leaf whose other members
 * are attributes; otherwise `@attr` holds the attributes and the other members
 * are children; an array is a repeated element; a scalar is a text element.
 */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function stripNonXml(text: string): string {
  let out = '';
  for (const ch of text) if (isXmlChar(ch.codePointAt(0)!)) out += ch;
  return out;
}

function xmlEscape(text: string): string {
  return stripNonXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlAttrs(attrs: Record<string, Json>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join('');
}

function xmlElement(name: string, value: Json): string {
  if (Array.isArray(value)) return value.map((item) => xmlElement(name, item)).join('');
  if (value === null || typeof value !== 'object') return `<${name}>${xmlEscape(String(value ?? ''))}</${name}>`;
  if ('#text' in value) {
    const { '#text': text, ...attrs } = value;
    return `<${name}${xmlAttrs(attrs)}>${xmlEscape(String(text ?? ''))}</${name}>`;
  }
  const { '@attr': attr, ...children } = value;
  const attrs = attr && typeof attr === 'object' && !Array.isArray(attr) ? xmlAttrs(attr) : '';
  const inner = Object.entries(children)
    .map(([k, v]) => xmlElement(k, v))
    .join('');
  return `<${name}${attrs}>${inner}</${name}>`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

function okResponse(body: Record<string, Json>, json: boolean): Response {
  if (json) return jsonResponse(body, 200);
  const inner = Object.entries(body)
    .map(([k, v]) => xmlElement(k, v))
    .join('');
  const xml = inner === '' ? '<lfm status="ok"/>' : `<lfm status="ok">${inner}</lfm>`;
  return new Response(XML_DECL + xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(code: number, json: boolean, opts: { message?: string; status?: number; retryAfter?: number }) {
  const message = opts.message ?? LASTFM_ERROR_MESSAGES[code] ?? 'Operation failed';
  const status = opts.status ?? LASTFM_ERROR_STATUS[code] ?? 400;
  const headers: Record<string, string> = {};
  if (opts.retryAfter !== undefined) headers['retry-after'] = String(opts.retryAfter);
  if (json) return jsonResponse({ error: code, message }, status, headers);
  return new Response(`${XML_DECL}<lfm status="failed"><error code="${code}">${xmlEscape(message)}</error></lfm>`, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8', ...headers },
  });
}

class LastfmError extends Error {
  constructor(
    readonly code: number,
    message?: string,
  ) {
    super(message ?? LASTFM_ERROR_MESSAGES[code] ?? `error ${code}`);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface LastfmListen {
  artist: string;
  track: string;
  /** UNIX seconds. */
  uts: number;
  album?: string;
  albumArtist?: string;
  mbid?: string;
  artistMbid?: string;
  albumMbid?: string;
}

/** One track.scrobble entry exactly as received (absent parameters are absent). */
export interface LastfmScrobbleInput {
  artist: string;
  track: string;
  timestamp: string;
  album?: string;
  albumArtist?: string;
  duration?: string;
  trackNumber?: string;
  mbid?: string;
  chosenByUser?: string;
}

/** A successful track.scrobble request. */
export interface LastfmScrobbleBatch {
  user: string;
  sk: string;
  apiKey: string;
  /** Whether the request used `[i]` indexes. */
  indexed: boolean;
  items: LastfmScrobbleInput[];
  /** The `ignoredMessage` code answered for each item (0 = accepted). */
  codes: number[];
}

export interface LastfmNowPlayingCall {
  user: string;
  sk: string;
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  duration?: string;
}

export interface LastfmLoveCall {
  user: string;
  sk: string;
  method: 'track.love' | 'track.unlove';
  artist: string;
  track: string;
}

interface UserState {
  name: string;
  registeredS: number;
  history: LastfmListen[];
  loves: Set<string>;
  nowPlaying: { listen: Omit<LastfmListen, 'uts'>; expiresAtMs: number } | null;
}

interface TokenState {
  apiKey: string;
  issuedAtMs: number;
  user: string | null;
  consumed: boolean;
}

export interface FakeLastfmOptions {
  clock: Clock;
  /** The api_key the fake knows (others get 10). */
  apiKey: string;
  /** Its shared secret, used to verify `api_sig`. */
  secret: string;
  host?: string;
}

const SIGNED_METHODS = new Set([
  'auth.getToken',
  'auth.getSession',
  'auth.getMobileSession',
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove',
]);
const POST_ONLY = new Set([
  'auth.getMobileSession',
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove',
]);
const SESSION_METHODS = new Set(['track.scrobble', 'track.updateNowPlaying', 'track.love', 'track.unlove']);

export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const NOW_PLAYING_DEFAULT_TTL_MS = 600 * 1000;
export const MAX_SCROBBLES_PER_REQUEST = 50;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Jan 2026, 12:00" (UTC), Last.fm's `date.#text`. */
export function lastfmDateText(uts: number): string {
  const d = new Date(uts * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

const loveKey = (artist: string, track: string) => `${artist.toLowerCase()}\u0000${track.toLowerCase()}`;

const IMAGES: Json = ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' }));

const musicUrl = (artist: string, track?: string) =>
  `https://www.last.fm/music/${encodeURIComponent(artist)}${track === undefined ? '' : `/_/${encodeURIComponent(track)}`}`;

/** Parse a non-negative decimal integer parameter; anything else is error 6. */
function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,15}$/.test(value)) throw new LastfmError(6, `Invalid parameters - ${value} is not a valid integer`);
  return Number(value);
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export class FakeLastfm implements Routable {
  readonly host: string;
  readonly calls = new CallLog();
  /** Every successful track.scrobble request, in order. */
  readonly scrobbles: LastfmScrobbleBatch[] = [];
  readonly nowPlayingCalls: LastfmNowPlayingCall[] = [];
  readonly loveCalls: LastfmLoveCall[] = [];

  private readonly clock: Clock;
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly users = new Map<string, UserState>();
  private readonly sessions = new Map<string, string>();
  private readonly tokens = new Map<string, TokenState>();
  private readonly faults: LastfmFault[] = [];
  private readonly itemCodes: number[] = [];
  private tokenCounter = 0;
  private sessionCounter = 0;

  constructor(opts: FakeLastfmOptions) {
    this.clock = opts.clock;
    this.apiKey = opts.apiKey;
    this.secret = opts.secret;
    this.host = opts.host ?? LASTFM_HOST;
  }

  // -- setup ----------------------------------------------------------------

  /** Create a user (idempotent). `registeredS` defaults to the clock. */
  addUser(name: string, opts: { registeredS?: number } = {}): void {
    if (this.users.has(name.toLowerCase())) return;
    this.users.set(name.toLowerCase(), {
      name,
      registeredS: opts.registeredS ?? Math.floor(this.clock.nowMs() / 1000),
      history: [],
      loves: new Set(),
      nowPlaying: null,
    });
  }

  /** Add a session key for `user` (deterministic when `sk` is omitted). Returns it. */
  addSession(user: string, sk?: string): string {
    this.addUser(user);
    this.sessionCounter += 1;
    const key = sk ?? md5Hex(`fake-lastfm-session:${user}:${this.sessionCounter}`);
    this.sessions.set(key, this.userState(user)!.name);
    return key;
  }

  /** Revoke a session key: later calls with it get 9. */
  revokeSession(sk: string): void {
    this.sessions.delete(sk);
  }

  /** Issue a request token for `apiKey` at the current clock (what auth.getToken does). */
  issueToken(token?: string, apiKey = this.apiKey): string {
    this.tokenCounter += 1;
    const t = token ?? md5Hex(`fake-lastfm-token:${this.tokenCounter}`);
    this.tokens.set(t, { apiKey, issuedAtMs: this.clock.nowMs(), user: null, consumed: false });
    return t;
  }

  /** The user approves `token` on last.fm (the browser step of the web flow). */
  authorizeToken(token: string, user: string): void {
    const t = this.tokens.get(token);
    if (!t) throw new Error(`unknown token ${token}`);
    this.addUser(user);
    t.user = this.userState(user)!.name;
  }

  /** Append listens to a user's scrobble history (any order; reads sort newest first). */
  seedHistory(user: string, listens: readonly LastfmListen[]): void {
    this.addUser(user);
    this.userState(user)!.history.push(...listens.map((l) => ({ ...l })));
  }

  /** Set the user's now-playing track, current for `ttlMs` from the clock. */
  setNowPlaying(user: string, listen: Omit<LastfmListen, 'uts'>, ttlMs = NOW_PLAYING_DEFAULT_TTL_MS): void {
    this.addUser(user);
    this.userState(user)!.nowPlaying = { listen: { ...listen }, expiresAtMs: this.clock.nowMs() + ttlMs };
  }

  /** The user's loved tracks as `artist\0track` (lowercased). */
  loves(user: string): string[] {
    return [...(this.userState(user)?.loves ?? [])].sort();
  }

  /** The user's history, newest first. */
  history(user: string): LastfmListen[] {
    return this.sortedHistory(this.userState(user));
  }

  /** Queue faults; each one answers the next request (for its `method`, when given). */
  fail(...faults: LastfmFault[]): void {
    this.faults.push(...faults);
  }

  /** Queue per-item `ignoredMessage` codes, consumed by the next scrobbled items in order (0 = accept). */
  ignoreItems(...codes: number[]): void {
    this.itemCodes.push(...codes);
  }

  get pendingFaults(): number {
    return this.faults.length;
  }

  // -- transport ------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const params = new Map<string, string>();
    for (const [k, v] of url.searchParams) params.set(k, v);
    if (req.method === 'POST') {
      const body = await req.text();
      for (const [k, v] of new URLSearchParams(body)) params.set(k, v);
    }
    const method = params.get('method') ?? '';
    const json = params.get('format') === 'json';
    let res: Response;
    let faultName: string | null = null;

    if (url.pathname !== '/2.0/' && url.pathname !== '/2.0') {
      res = new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    } else {
      const i = this.faults.findIndex((f) => f.method === undefined || f.method === method);
      const fault = i >= 0 ? this.faults.splice(i, 1)[0]! : null;
      if (fault && 'httpStatus' in fault) {
        faultName = `http:${fault.httpStatus}`;
        res = new Response(fault.body ?? `<html><body><h1>${fault.httpStatus}</h1></body></html>`, {
          status: fault.httpStatus,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      } else if (fault) {
        faultName = `code:${fault.code}`;
        res = errorResponse(fault.code, json, fault);
      } else {
        try {
          res = okResponse(this.handle(req.method, method, params), json);
        } catch (e) {
          if (!(e instanceof LastfmError)) throw e;
          res = errorResponse(e.code, json, { message: e.message });
        }
      }
    }

    const logged: Record<string, string[]> = {};
    for (const [k, v] of params) logged[k] = [v];
    this.calls.record({
      service: 'lastfm',
      host: url.hostname,
      method: req.method,
      path: url.pathname,
      nsid: method || null,
      params: logged,
      did: null,
      status: res.status,
      fault: faultName,
    });
    return res;
  }

  // -- methods --------------------------------------------------------------

  private handle(httpMethod: string, method: string, params: Map<string, string>): Record<string, Json> {
    const apiKey = params.get('api_key');
    if (!apiKey || apiKey !== this.apiKey) throw new LastfmError(10);
    const known = SIGNED_METHODS.has(method) || method === 'user.getRecentTracks' || method === 'user.getInfo';
    if (!known) throw new LastfmError(3);
    if (POST_ONLY.has(method) && httpMethod !== 'POST') {
      throw new LastfmError(3, 'Invalid Method - this method must be called with POST');
    }
    if (SIGNED_METHODS.has(method)) {
      const sig = (params.get('api_sig') ?? '').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(sig) || sig !== lastfmSignature(params, this.secret)) throw new LastfmError(13);
    }
    let user = '';
    let sk = '';
    if (SESSION_METHODS.has(method)) {
      sk = params.get('sk') ?? '';
      const owner = this.sessions.get(sk);
      if (owner === undefined) throw new LastfmError(9);
      user = owner;
    }
    switch (method) {
      case 'auth.getToken':
        return { token: this.issueToken(undefined, apiKey) };
      case 'auth.getSession':
        return this.getSession(params, apiKey);
      case 'auth.getMobileSession':
        throw new LastfmError(4);
      case 'track.scrobble':
        return this.scrobble(params, user, sk, apiKey);
      case 'track.updateNowPlaying':
        return this.updateNowPlaying(params, user, sk);
      case 'track.love':
      case 'track.unlove':
        return this.love(method, params, user, sk);
      case 'user.getRecentTracks':
        return this.getRecentTracks(params);
      default:
        return this.getInfo(params);
    }
  }

  private getSession(params: Map<string, string>, apiKey: string): Record<string, Json> {
    const token = params.get('token');
    if (!token) throw new LastfmError(6);
    const t = this.tokens.get(token);
    if (!t || t.consumed || t.apiKey !== apiKey) throw new LastfmError(4, 'Invalid authentication token supplied');
    if (this.clock.nowMs() - t.issuedAtMs >= TOKEN_TTL_MS) throw new LastfmError(15);
    if (t.user === null) throw new LastfmError(14);
    t.consumed = true;
    const key = this.addSession(t.user);
    return { session: { name: t.user, key, subscriber: 0 } };
  }

  private scrobble(params: Map<string, string>, user: string, sk: string, apiKey: string): Record<string, Json> {
    const fields = [
      'artist',
      'track',
      'timestamp',
      'album',
      'albumArtist',
      'duration',
      'trackNumber',
      'mbid',
      'chosenByUser',
    ] as const;
    const indexed = new Map<number, Partial<Record<(typeof fields)[number], string>>>();
    const plain: Partial<Record<(typeof fields)[number], string>> = {};
    for (const [name, value] of params) {
      const m = /^([A-Za-z]+)\[(\d+)\]$/.exec(name);
      const field = (m ? m[1] : name) as (typeof fields)[number];
      if (!fields.includes(field)) continue;
      if (m) {
        const index = Number(m[2]);
        if (index >= MAX_SCROBBLES_PER_REQUEST) throw new LastfmError(6, 'Invalid parameters - too many scrobbles');
        const entry = indexed.get(index) ?? {};
        entry[field] = value;
        indexed.set(index, entry);
      } else {
        plain[field] = value;
      }
    }
    if (indexed.size > 0 && Object.keys(plain).length > 0) throw new LastfmError(6);
    const entries = indexed.size > 0 ? [...indexed.entries()].sort(([a], [b]) => a - b).map(([, e]) => e) : [plain];
    const items: LastfmScrobbleInput[] = entries.map((e) => {
      if (!e.artist || !e.track || !e.timestamp) throw new LastfmError(6);
      const item: LastfmScrobbleInput = { artist: e.artist, track: e.track, timestamp: e.timestamp };
      for (const f of fields.slice(3)) if (e[f] !== undefined) item[f] = e[f];
      return item;
    });

    const state = this.userState(user)!;
    const codes = items.map(() => this.itemCodes.shift() ?? 0);
    items.forEach((item, i) => {
      if (codes[i] !== 0) return;
      state.history.push({
        artist: item.artist,
        track: item.track,
        uts: Math.floor(Number(item.timestamp)),
        ...(item.album === undefined ? {} : { album: item.album }),
        ...(item.albumArtist === undefined ? {} : { albumArtist: item.albumArtist }),
        ...(item.mbid === undefined ? {} : { mbid: item.mbid }),
      });
    });
    this.scrobbles.push({ user, sk, apiKey, indexed: indexed.size > 0, items, codes });

    const rows: Json[] = items.map((item, i) => {
      const code = codes[i]!;
      return {
        artist: { corrected: '0', '#text': item.artist },
        album: { corrected: '0', '#text': item.album ?? '' },
        albumArtist: { corrected: '0', '#text': item.albumArtist ?? '' },
        track: { corrected: '0', '#text': item.track },
        timestamp: item.timestamp,
        ignoredMessage: { code: String(code), '#text': code === 0 ? '' : (LASTFM_IGNORED_MESSAGES[code] ?? '') },
      };
    });
    const accepted = codes.filter((c) => c === 0).length;
    return {
      scrobbles: {
        // Last.fm's quirk: one input gives an object, several give an array.
        scrobble: rows.length === 1 ? rows[0]! : rows,
        '@attr': { accepted, ignored: rows.length - accepted },
      },
    };
  }

  private updateNowPlaying(params: Map<string, string>, user: string, sk: string): Record<string, Json> {
    const artist = params.get('artist');
    const track = params.get('track');
    if (!artist || !track) throw new LastfmError(6);
    const call: LastfmNowPlayingCall = { user, sk, artist, track };
    for (const f of ['album', 'albumArtist', 'duration'] as const) {
      const v = params.get(f);
      if (v !== undefined) call[f] = v;
    }
    this.nowPlayingCalls.push(call);
    const duration = Number(call.duration);
    const ttlMs = Number.isInteger(duration) && duration >= 30 ? duration * 1000 : NOW_PLAYING_DEFAULT_TTL_MS;
    this.setNowPlaying(
      user,
      {
        artist,
        track,
        ...(call.album === undefined ? {} : { album: call.album }),
        ...(call.albumArtist === undefined ? {} : { albumArtist: call.albumArtist }),
      },
      ttlMs,
    );
    return {
      nowplaying: {
        track: { corrected: '0', '#text': track },
        artist: { corrected: '0', '#text': artist },
        album: { corrected: '0', '#text': call.album ?? '' },
        albumArtist: { corrected: '0', '#text': call.albumArtist ?? '' },
        ignoredMessage: { code: '0', '#text': '' },
      },
    };
  }

  private love(
    method: 'track.love' | 'track.unlove',
    params: Map<string, string>,
    user: string,
    sk: string,
  ): Record<string, Json> {
    const artist = params.get('artist');
    const track = params.get('track');
    if (!artist || !track) throw new LastfmError(6);
    this.loveCalls.push({ user, sk, method, artist, track });
    const loves = this.userState(user)!.loves;
    if (method === 'track.love') loves.add(loveKey(artist, track));
    else loves.delete(loveKey(artist, track));
    return {};
  }

  private getRecentTracks(params: Map<string, string>): Record<string, Json> {
    const name = params.get('user');
    if (!name) throw new LastfmError(6);
    const state = this.userState(name);
    if (!state) throw new LastfmError(6, 'User not found');
    const limit = Math.min(200, Math.max(1, intParam(params.get('limit'), 50)));
    const page = intParam(params.get('page'), 1);
    if (page < 1) throw new LastfmError(6);
    const from = params.get('from') === undefined ? null : intParam(params.get('from'), 0);
    const to = params.get('to') === undefined ? null : intParam(params.get('to'), 0);
    const extended = params.get('extended') === '1';

    // Exclusive bounds: from < uts < to.
    const bounded = this.sortedHistory(state).filter(
      (l) => (from === null || l.uts > from) && (to === null || l.uts < to),
    );
    const total = bounded.length;
    const totalPages = Math.ceil(total / limit);
    const rows: Json[] = bounded.slice((page - 1) * limit, page * limit).map((l) => this.trackRow(state, l, extended));
    const np = state.nowPlaying;
    if (page === 1 && np && this.clock.nowMs() < np.expiresAtMs) {
      const row = this.trackRow(state, np.listen, extended) as Record<string, Json>;
      rows.unshift({ '@attr': { nowplaying: 'true' }, ...row });
    }
    return {
      recenttracks: {
        track: rows,
        '@attr': {
          user: state.name,
          page: String(page),
          perPage: String(limit),
          totalPages: String(totalPages),
          total: String(total),
        },
      },
    };
  }

  private trackRow(state: UserState, l: Omit<LastfmListen, 'uts'> & { uts?: number }, extended: boolean): Json {
    const artist: Json = extended
      ? { url: musicUrl(l.artist), name: l.artist, image: IMAGES, mbid: l.artistMbid ?? '' }
      : { mbid: l.artistMbid ?? '', '#text': l.artist };
    const row: Record<string, Json> = {
      artist,
      streamable: '0',
      image: IMAGES,
      mbid: l.mbid ?? '',
      album: { mbid: l.albumMbid ?? '', '#text': l.album ?? '' },
      name: l.track,
      url: musicUrl(l.artist, l.track),
    };
    if (extended) row.loved = state.loves.has(loveKey(l.artist, l.track)) ? '1' : '0';
    if (l.uts !== undefined) row.date = { uts: String(l.uts), '#text': lastfmDateText(l.uts) };
    return row;
  }

  private getInfo(params: Map<string, string>): Record<string, Json> {
    const name = params.get('user');
    if (!name) throw new LastfmError(6);
    const state = this.userState(name);
    if (!state) throw new LastfmError(6, 'User not found');
    return {
      user: {
        name: state.name,
        realname: '',
        url: `https://www.last.fm/user/${encodeURIComponent(state.name)}`,
        country: 'None',
        playcount: String(state.history.length),
        registered: { unixtime: String(state.registeredS), '#text': state.registeredS },
        type: 'user',
        image: IMAGES,
      },
    };
  }

  private userState(name: string): UserState | undefined {
    return this.users.get(name.toLowerCase());
  }

  private sortedHistory(state: UserState | undefined): LastfmListen[] {
    if (!state) return [];
    // Newest first; among equal seconds, the later-recorded listen first.
    return state.history
      .map((l, i) => [l, i] as const)
      .sort(([a, ai], [b, bi]) => b.uts - a.uts || bi - ai)
      .map(([l]) => l);
  }
}

// ---------------------------------------------------------------------------
// Serving a fake on a local listener (e2e stacks, N6-01 and N8-01)
// ---------------------------------------------------------------------------

export interface ServedFake {
  /** `http://127.0.0.1:<port>` for a TCP listener; `http://localhost` for a unix socket. */
  readonly origin: string;
  /** The unix socket path, when listening on one. */
  readonly socketPath: string | null;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Listen on this unix socket instead of TCP. */
  socketPath?: string;
  /** TCP port (0 = ephemeral, the default). Always bound to 127.0.0.1. */
  port?: number;
}

async function bridge(endpoint: Routable, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
  const response = await endpoint.fetch(request);
  const body = Buffer.from(await response.arrayBuffer());
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    out[name] = value;
  });
  res.writeHead(response.status, { ...out, 'content-length': String(body.byteLength) });
  res.end(body);
}

/**
 * Serve a fake (any routerTransport endpoint) over HTTP: on an ephemeral
 * 127.0.0.1 port, or on a unix socket. Request bytes, method, path and headers
 * reach the fake unchanged; the fake's status, headers and body come back
 * unchanged. A fake that throws answers 500.
 */
export function serveFake(endpoint: Routable, opts: ServeOptions = {}): Promise<ServedFake> {
  const server = createServer((req, res) => {
    bridge(endpoint, req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(e));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      const address = server.address();
      const origin =
        opts.socketPath !== undefined ? 'http://localhost' : `http://127.0.0.1:${(address as AddressInfo).port}`;
      resolve({
        origin,
        socketPath: opts.socketPath ?? null,
        close: () =>
          new Promise<void>((ok, fail) => {
            server.close((err) => (err ? fail(err) : ok()));
            server.closeAllConnections();
          }),
      });
    };
    if (opts.socketPath !== undefined) server.listen(opts.socketPath, done);
    else server.listen(opts.port ?? 0, '127.0.0.1', done);
  });
}
