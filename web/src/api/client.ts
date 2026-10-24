// Typed client for every route that remains after ADR 0004 §9 (api/openapi.yaml
// 1.1.0). It is framework-free so the outbox (W2-07) and the screens (W3-06)
// share it.
//
// - Responses are decoded at runtime, not cast. Every object is closed, and an
//   absent optional field stays absent. A changed field type, an unknown field
//   or a missing required field becomes an `ApiDecodeError`, so contract drift
//   shows up as an error and never as a silently wrong screen.
// - A non-2xx response is parsed as the error envelope `{error:{code, message,
//   requestId, fields?}}` and becomes a typed `ApiError`. A body that is not a
//   valid envelope becomes an `ApiDecodeError`.
// - Cursors are opaque: `nextCursor` is returned exactly as received, and a
//   cursor passed in is sent back as the `cursor` query value without any change.
// - The client never clamps or "fixes" query values. Out-of-range limits are
//   sent as given, and the server answers 422 with `fields` (API envelope rule).

import type {
  AtUri,
  Did,
  ErrorBody,
  Export,
  FeedScope,
  Follow,
  FollowPage,
  Handle,
  HealthLive,
  HealthReady,
  Indexing,
  Meta,
  NotifyAccepted,
  NotifyInput,
  OAuthClientMetadata,
  Profile,
  RecordStatus,
  Resolve,
  Scrobble,
  ScrobblePage,
  ScrobbleResult,
  Statistics,
  StatsWindow,
  TopAlbum,
  TopArtist,
  TopTrack,
} from '@atmusic/core/api-types';
import { ApiError as CoreApiError, type ErrorCode, isErrorCode } from '@atmusic/core/errors';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A server error envelope, typed by the frozen error vocabulary. */
export class ApiError extends CoreApiError {
  constructor(
    code: ErrorCode,
    message: string,
    fields: Readonly<Record<string, string>> | undefined,
    status: number,
    /** `error.requestId` from the envelope. */
    readonly requestId: string,
    /** Parsed `Retry-After` (delta seconds) when the server sent one. */
    readonly retryAfterSeconds: number | null,
    /** The route that failed, for example `GET /api/v1/feed`. */
    readonly endpoint: string,
  ) {
    super(code, message, fields, status);
    this.name = 'ApiError';
  }
}

/** A response that does not match the contract (wrong status, type, field or envelope). */
export class ApiDecodeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    /** JSON path of the offending value, `$` for the whole body. */
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${endpoint} (${status}): ${path} ${reason}`);
    this.name = 'ApiDecodeError';
  }
}

/** `fetch` itself rejected: offline, DNS, CORS, or an abort. */
export class ApiNetworkError extends Error {
  constructor(
    readonly endpoint: string,
    override readonly cause: unknown,
  ) {
    super(`${endpoint}: network request failed`);
    this.name = 'ApiNetworkError';
  }
}

export type ApiFailure = ApiError | ApiDecodeError | ApiNetworkError;

export function isApiFailure(value: unknown): value is ApiFailure {
  return value instanceof ApiError || value instanceof ApiDecodeError || value instanceof ApiNetworkError;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

class DecodeIssue extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} ${reason}`);
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

function fail(path: string, reason: string): never {
  throw new DecodeIssue(path, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str: Decoder<string> = (v, p) => (typeof v === 'string' ? v : fail(p, 'must be a string'));

const bool: Decoder<boolean> = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'must be a boolean'));

function int(min: number, max = Number.MAX_SAFE_INTEGER): Decoder<number> {
  return (v, p) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(p, 'must be an integer');
    if (v < min || v > max) fail(p, `must be between ${min} and ${max}`);
    return v;
  };
}

const nonNegativeNumber: Decoder<number> = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'must be a number');
  if (v < 0) fail(p, 'must be at least 0');
  return v;
};

function literal<const T extends string | number | boolean>(expected: T): Decoder<T> {
  return (v, p) => (v === expected ? (v as T) : fail(p, `must be ${JSON.stringify(expected)}`));
}

function oneOf<const T extends string>(values: readonly T[]): Decoder<T> {
  return (v, p) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? (v as T)
      : fail(p, `must be one of ${values.join(', ')}`);
}

function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return (v, p) => (v === null ? null : inner(v, p));
}

function array<T>(inner: Decoder<T>): Decoder<T[]> {
  return (v, p) => (Array.isArray(v) ? v.map((item, i) => inner(item, `${p}[${i}]`)) : fail(p, 'must be an array'));
}

function refine<T>(inner: Decoder<T>, check: (value: T) => boolean, reason: string): Decoder<T> {
  return (v, p) => {
    const out = inner(v, p);
    return check(out) ? out : fail(p, reason);
  };
}

type Shape = Record<string, Decoder<unknown>>;
type Decoded<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/**
 * A closed object: every `required` key present, `optional` keys present or
 * absent (never null), and no other key. Keys are emitted in declaration order.
 */
function object<R extends Shape, O extends Shape = Record<never, never>>(
  required: R,
  optional?: O,
  { open = false }: { open?: boolean } = {},
): Decoder<Decoded<R> & Partial<Decoded<O>>> {
  return (v, p) => {
    if (!isPlainObject(v)) fail(p, 'must be an object');
    const out: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(required)) {
      if (!Object.hasOwn(v, key)) fail(`${p}.${key}`, 'is required');
      out[key] = decode(v[key], `${p}.${key}`);
    }
    for (const [key, decode] of Object.entries(optional ?? {})) {
      if (Object.hasOwn(v, key)) out[key] = decode(v[key], `${p}.${key}`);
    }
    for (const key of Object.keys(v)) {
      if (Object.hasOwn(out, key)) continue;
      if (!open) fail(`${p}.${key}`, 'is not an allowed field');
      out[key] = v[key];
    }
    return out as Decoded<R> & Partial<Decoded<O>>;
  };
}

// Format checks mirror scripts/validate_contracts.py (the OpenAPI format checker).

const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)$/;
const DID_RE = /^did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/;
const NSID_SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NSID_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;
// CIDv1 (0x01) dag-cbor (0x71) sha2-256 (0x12, 32 bytes) in base32: 36 bytes are
// 58 base32 digits whose final digit carries 3 data bits and 2 zero pad bits.
const CID_RE = /^bafyrei[a-z2-7]{51}[aeimquy4]$/;
const HANDLE_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Unicode White_Space (Rust str::trim), as in validate_contracts.py. Built from
// a string: a raw U+2028/U+2029 inside a regex literal would end the literal.
const WHITE_SPACE_CLASS =
  '[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const WHITE_SPACE_EDGES_RE = new RegExp(`^${WHITE_SPACE_CLASS}+|${WHITE_SPACE_CLASS}+$`, 'g');
const UTF8 = new TextEncoder();

function isTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || ms < 0) return false;
  // Reject calendar overflow such as 2026-02-30, which Date.parse rolls over.
  return new Date(ms).toISOString().slice(0, 10) === value.slice(0, 10);
}

export function isDid(value: string): boolean {
  return value.length <= 2048 && DID_RE.test(value) && !value.endsWith(':');
}

function isNsid(value: string): boolean {
  const parts = value.split('.');
  if (parts.length < 3 || value.length > 317 || !/^[A-Za-z]/.test(value)) return false;
  const name = parts[parts.length - 1]!;
  return (
    parts.slice(0, -1).every((part) => part.length <= 63 && NSID_SEGMENT_RE.test(part)) &&
    name.length <= 63 &&
    NSID_NAME_RE.test(name)
  );
}

export function isRecordUri(value: string): boolean {
  if (!value.startsWith('at://')) return false;
  const parts = value.slice('at://'.length).split('/');
  if (parts.length !== 3) return false;
  const [did, collection, rkey] = parts as [string, string, string];
  return isDid(did) && isNsid(collection) && RKEY_RE.test(rkey) && rkey !== '.' && rkey !== '..';
}

function isHandle(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  const labels = value.split('.');
  return (
    labels.length >= 2 &&
    !/^[0-9]/.test(labels[labels.length - 1]!) &&
    labels.every((label) => label.length >= 1 && label.length <= 63 && HANDLE_LABEL_RE.test(label))
  );
}

function isMusicText(value: string): boolean {
  let scalars = 0;
  for (const _ of value) scalars++;
  return scalars <= 256 && UTF8.encode(value).length <= 1024 && value.replace(WHITE_SPACE_EDGES_RE, '') !== '';
}

const timestamp = refine(str, isTimestamp, 'must be a UTC RFC 3339 timestamp at or after 1970');
const did = refine(str, isDid, 'must be a DID');
const atUri = refine(str, isRecordUri, 'must be a record AT URI');
const cid = refine(str, (v) => CID_RE.test(v), 'must be a CIDv1 dag-cbor sha2-256 string');
const handle = refine(str, isHandle, 'must be a handle');
const uuid = refine(str, (v) => UUID_RE.test(v), 'must be a UUID');
const musicText = refine(str, isMusicText, 'must be 1–256 scalars, ≤1,024 UTF-8 bytes and not blank');
const nonEmpty = refine(str, (v) => v.length > 0, 'must not be empty');

const indexing: Decoder<Indexing> = object({
  state: oneOf(['current', 'recovering', 'stale', 'suppressed'] as const),
  caughtUp: bool,
  lastIndexedAt: nullable(timestamp),
  lagSeconds: nullable(nonNegativeNumber),
});

const scrobble: Decoder<Scrobble> = object(
  {
    uri: atUri,
    cid,
    did,
    revision: str,
    artist: musicText,
    track: musicText,
    listenedAt: timestamp,
    createdAt: timestamp,
    indexedAt: timestamp,
  },
  { album: musicText, durationSeconds: int(1, 86_400), recordingMbid: uuid },
);

const follow: Decoder<Follow> = object({ uri: atUri, cid, actor: did, subject: did, createdAt: timestamp });

function page<T>(item: Decoder<T>) {
  return object({ items: array(item), nextCursor: nullable(str), asOf: timestamp, indexing });
}

const scrobblePage: Decoder<ScrobblePage> = page(scrobble);
const followPage: Decoder<FollowPage> = page(follow);
const scrobbleResult: Decoder<ScrobbleResult> = object({ scrobble });

const count = int(0);

const profile: Decoder<Profile> = object({
  did,
  handle: nullable(handle),
  joinedAt: timestamp,
  indexedAt: nullable(timestamp),
  totalScrobbles: count,
  followerCount: count,
  followingCount: count,
  indexing,
});

const topArtist: Decoder<TopArtist> = object({ artist: musicText, scrobbleCount: count });
const topTrack: Decoder<TopTrack> = object({ artist: musicText, track: musicText, scrobbleCount: count });
const topAlbum: Decoder<TopAlbum> = object({ artist: musicText, album: musicText, scrobbleCount: count });

const statistics: Decoder<Statistics> = object({
  did,
  window: oneOf(['all', '7d', '30d', '365d'] as const),
  asOf: timestamp,
  totalScrobbles: count,
  distinctArtists: count,
  distinctTracks: count,
  topArtists: array(topArtist),
  topTracks: array(topTrack),
  topAlbums: array(topAlbum),
});

const meta: Decoder<Meta> = object({
  name: literal('atproto_music'),
  version: str,
  stage: oneOf(['scaffold', 'backend', 'product'] as const),
  capabilities: array(str),
  lexiconPrefix: nullable(str),
  indexing,
});

const resolve: Decoder<Resolve> = object({ did, handle, verified: literal(true) });
const healthLive: Decoder<HealthLive> = object({ status: literal('live') });
const healthReady: Decoder<HealthReady> = object({ status: literal('ready') });
const notifyAccepted: Decoder<NotifyAccepted> = object({ state: literal('queued') });

const recordStatusBase = object(
  { uri: atUri, state: oneOf(['indexed', 'pending', 'absent', 'excluded', 'unknown'] as const), indexing },
  { cid, revision: nonEmpty, reason: nonEmpty },
);

/** RecordStatus plus its conditional rules (OpenAPI `allOf` if/then). */
const recordStatus: Decoder<RecordStatus> = (v, p) => {
  const out = recordStatusBase(v, p);
  if (out.state === 'indexed') {
    if (out.cid === undefined) fail(`${p}.cid`, 'is required when state is indexed');
    if (out.revision === undefined) fail(`${p}.revision`, 'is required when state is indexed');
  }
  if (out.state === 'excluded' && out.reason === undefined) fail(`${p}.reason`, 'is required when state is excluded');
  if (out.state !== 'excluded' && out.reason !== undefined) fail(`${p}.reason`, 'is allowed only when excluded');
  if (out.state === 'unknown' && (out.cid !== undefined || out.revision !== undefined)) {
    fail(p, 'unknown state carries no cid or revision');
  }
  return out as RecordStatus;
};

const exportPayload: Decoder<Export> = object({
  schemaVersion: literal(1),
  did,
  exportedAt: timestamp,
  indexing,
  scrobbles: array(scrobble),
  follows: array(follow),
});

const httpsUri = refine(str, (v) => /^https:\/\/[^/?#\s]+(?:[/?#]\S*)?$/.test(v), 'must be an https URI');

/** OAuthClientMetadata is the one open object: protocol extension fields pass through. */
const oauthClientMetadata: Decoder<OAuthClientMetadata> = object(
  {
    client_id: refine(
      str,
      (v) => /^https:\/\/[^/?#]+\/oauth\/client-metadata\.json$/.test(v),
      'must be the metadata URL',
    ),
    redirect_uris: refine(
      array(refine(str, (v) => /^https:\/\/[^/?#]+\/oauth\/callback$/.test(v), 'must be the /oauth/callback URL')),
      (v) => v.length === 1,
      'must hold exactly one redirect',
    ),
    scope: refine(str, (v) => /^atproto( repo:[A-Za-z0-9.-]+)*$/.test(v), 'must be atproto plus repo: scopes'),
    grant_types: refine(
      array(str),
      (v) => v.length === 2 && v[0] === 'authorization_code' && v[1] === 'refresh_token',
      'must be ["authorization_code","refresh_token"]',
    ),
    response_types: refine(array(str), (v) => v.length === 1 && v[0] === 'code', 'must be ["code"]'),
    token_endpoint_auth_method: literal('none'),
    application_type: literal('web'),
    dpop_bound_access_tokens: literal(true),
  },
  {
    client_name: str,
    client_uri: httpsUri,
    logo_uri: httpsUri,
    tos_uri: httpsUri,
    policy_uri: httpsUri,
    contacts: array(str),
  },
  { open: true },
) as Decoder<OAuthClientMetadata>;

const fieldsMap: Decoder<Record<string, string>> = (v, p) => {
  if (!isPlainObject(v)) fail(p, 'must be an object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) out[key] = str(value, `${p}.${key}`);
  return out;
};

const errorCode: Decoder<ErrorCode> = (v, p) => (isErrorCode(v) ? v : fail(p, 'is not a known error code'));

const errorEnvelope = object({
  error: object({ code: errorCode, message: str, requestId: uuid }, { fields: fieldsMap }),
});

/** The response decoders, keyed by OpenAPI schema name. Exported for contract tests. */
export const decoders = {
  Live: healthLive,
  Ready: healthReady,
  Meta: meta,
  OAuthClientMetadata: oauthClientMetadata,
  ResolvedIdentity: resolve,
  ScrobbleResult: scrobbleResult,
  ScrobblePage: scrobblePage,
  Profile: profile,
  Statistics: statistics,
  FollowPage: followPage,
  Export: exportPayload,
  NotifyAccepted: notifyAccepted,
  RecordStatus: recordStatus,
} as const;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Origin to prefix, e.g. `https://music.example.org`. Empty (the default) means same-origin relative URLs. */
  baseUrl?: string;
  /** Injected fetch; defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface PageQuery {
  /** Sent as given; the server rejects out-of-range values with 422 (no clamping). */
  limit?: number;
  /** An opaque `nextCursor` from a previous page, sent back unchanged. */
  cursor?: string | null;
}

export interface FeedQuery extends PageQuery {
  scope?: FeedScope;
  /** Required by the server for `scope=following` (A8). */
  viewer?: Did;
}

export interface StatsQuery {
  window?: StatsWindow;
  limit?: number;
}

type Query = Record<string, string | number | null | undefined>;

interface Call<T> {
  method: 'GET' | 'POST';
  path: string;
  query?: Query;
  body?: unknown;
  expect: number;
  decode: Decoder<T>;
  noStore?: boolean;
}

/** A path segment holding a DID: percent-encoded, with `:` kept literal as in the Rust tests. */
function didSegment(value: Did): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':');
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export class ApiClient {
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(options: ApiClientOptions = {}) {
    this.#base = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The URL of a route with its query, as the client would request it. */
  url(path: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const search = params.toString();
    return `${this.#base}${path}${search ? `?${search}` : ''}`;
  }

  async #call<T>(call: Call<T>, options: CallOptions = {}): Promise<T> {
    const endpoint = `${call.method} ${call.path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    // The AppView holds no session: nothing ambient is ever sent (ADR 0004 §8).
    const init: RequestInit = { method: call.method, headers, credentials: 'omit' };
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(call.body);
    }
    if (call.noStore) init.cache = 'no-store';
    if (options.signal) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.#fetch(this.url(call.path, call.query), init);
    } catch (error) {
      throw new ApiNetworkError(endpoint, error);
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new ApiDecodeError(endpoint, response.status, '$', 'is not JSON');
    }

    if (!response.ok) {
      let envelope: ReturnType<typeof errorEnvelope>;
      try {
        envelope = errorEnvelope(body, '$');
      } catch (error) {
        if (error instanceof DecodeIssue) throw new ApiDecodeError(endpoint, response.status, error.path, error.reason);
        throw error;
      }
      const e: ErrorBody = envelope.error;
      throw new ApiError(
        e.code,
        e.message,
        e.fields,
        response.status,
        e.requestId,
        parseRetryAfter(response.headers.get('retry-after')),
        endpoint,
      );
    }
    if (response.status !== call.expect) {
      throw new ApiDecodeError(endpoint, response.status, '$', `status must be ${call.expect}`);
    }
    try {
      return call.decode(body, '$');
    } catch (error) {
      if (error instanceof DecodeIssue) throw new ApiDecodeError(endpoint, response.status, error.path, error.reason);
      throw error;
    }
  }

  healthLive(o?: CallOptions): Promise<HealthLive> {
    return this.#call({ method: 'GET', path: '/health/live', expect: 200, decode: healthLive, noStore: true }, o);
  }

  healthReady(o?: CallOptions): Promise<HealthReady> {
    return this.#call({ method: 'GET', path: '/health/ready', expect: 200, decode: healthReady, noStore: true }, o);
  }

  meta(o?: CallOptions): Promise<Meta> {
    return this.#call({ method: 'GET', path: '/api/v1/meta', expect: 200, decode: meta }, o);
  }

  /** The build-time static asset that is the OAuth client_id (A3). */
  oauthClientMetadata(o?: CallOptions): Promise<OAuthClientMetadata> {
    return this.#call(
      { method: 'GET', path: '/oauth/client-metadata.json', expect: 200, decode: oauthClientMetadata },
      o,
    );
  }

  /** Verified handle → DID (404 unresolved, 422 mismatch). */
  resolve(value: Handle, o?: CallOptions): Promise<Resolve> {
    return this.#call(
      { method: 'GET', path: '/api/v1/resolve', query: { handle: value }, expect: 200, decode: resolve, noStore: true },
      o,
    );
  }

  /** One scrobble by its full AT URI (sent URL-encoded as the path segment). */
  scrobble(uri: AtUri, o?: CallOptions): Promise<ScrobbleResult> {
    return this.#call(
      { method: 'GET', path: `/api/v1/scrobbles/${encodeURIComponent(uri)}`, expect: 200, decode: scrobbleResult },
      o,
    );
  }

  userScrobbles(user: Did, q: PageQuery = {}, o?: CallOptions): Promise<ScrobblePage> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/scrobbles`,
        query: { limit: q.limit, cursor: q.cursor },
        expect: 200,
        decode: scrobblePage,
      },
      o,
    );
  }

  feed(q: FeedQuery = {}, o?: CallOptions): Promise<ScrobblePage> {
    return this.#call(
      {
        method: 'GET',
        path: '/api/v1/feed',
        query: { scope: q.scope, viewer: q.viewer, limit: q.limit, cursor: q.cursor },
        expect: 200,
        decode: scrobblePage,
      },
      o,
    );
  }

  profile(user: Did, o?: CallOptions): Promise<Profile> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/profile`,
        expect: 200,
        decode: profile,
        noStore: true,
      },
      o,
    );
  }

  stats(user: Did, q: StatsQuery = {}, o?: CallOptions): Promise<Statistics> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/stats`,
        query: { window: q.window, limit: q.limit },
        expect: 200,
        decode: statistics,
      },
      o,
    );
  }

  following(user: Did, q: PageQuery = {}, o?: CallOptions): Promise<FollowPage> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/following`,
        query: { limit: q.limit, cursor: q.cursor },
        expect: 200,
        decode: followPage,
      },
      o,
    );
  }

  followers(user: Did, q: PageQuery = {}, o?: CallOptions): Promise<FollowPage> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/followers`,
        query: { limit: q.limit, cursor: q.cursor },
        expect: 200,
        decode: followPage,
      },
      o,
    );
  }

  /** The export attachment URL (for a download link). */
  exportUrl(user: Did): string {
    return this.url(`/api/v1/users/${didSegment(user)}/export`);
  }

  exportUser(user: Did, o?: CallOptions): Promise<Export> {
    return this.#call(
      {
        method: 'GET',
        path: `/api/v1/users/${didSegment(user)}/export`,
        expect: 200,
        decode: exportPayload,
        noStore: true,
      },
      o,
    );
  }

  /** N1: an untrusted hint naming exactly one record or one DID. Success is 202 `{state:"queued"}`. */
  notify(input: NotifyInput, o?: CallOptions): Promise<NotifyAccepted> {
    const body = input.uri !== undefined ? { uri: input.uri } : { did: input.did };
    return this.#call({ method: 'POST', path: '/api/v1/notify', body, expect: 202, decode: notifyAccepted }, o);
  }

  /** N2: indexing state of one record (no-store; the outbox polls it). */
  recordStatus(uri: AtUri, o?: CallOptions): Promise<RecordStatus> {
    return this.#call(
      {
        method: 'GET',
        path: '/api/v1/records/status',
        query: { uri },
        expect: 200,
        decode: recordStatus,
        noStore: true,
      },
      o,
    );
  }
}

export function createApiClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
