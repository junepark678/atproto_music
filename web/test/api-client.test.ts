// Typed API client contract tests (W1-10; case map M7.1.2/contract_drift).
//
// The client talks to an injected fetch that records every request and serves
// the frozen contract fixtures from api/examples (validated against
// api/openapi.yaml 1.1.0 by scripts/validate_contracts.py). Each test asserts
// the HTTP request the client sent (method, path, query, body, call count)
// and the decoded value or typed error it produced.

import type { NotifyInput, ScrobblePage } from '@atmusic/core/api-types';
import { expect, it } from 'vitest';
import { ApiClient, ApiDecodeError, ApiError, ApiNetworkError } from '../src/api/client';

// ---------------------------------------------------------------------------
// Fixtures and fake transport
// ---------------------------------------------------------------------------

const exampleFiles = import.meta.glob<unknown>('../../api/examples/*.json', { eager: true, import: 'default' });

function example<T = unknown>(name: string): T {
  const value = exampleFiles[`../../api/examples/${name}.json`];
  if (value === undefined) throw new Error(`missing api/examples/${name}.json`);
  return structuredClone(value) as T;
}

interface ResponseCase {
  method: 'GET' | 'POST';
  path: string;
  status: number;
  example: string;
}

const RESPONSE_CASES = example<ResponseCase[]>('response-cases');

const BASE = 'https://music.example.org';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const R01 = 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r01';

interface Sent {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  init: RequestInit;
}

type Responder = (sent: Sent) => Response;

function fakeServer(responder: Responder) {
  const calls: Sent[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const sent: Sent = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
      init,
    };
    calls.push(sent);
    return responder(sent);
  };
  return { client: new ApiClient({ baseUrl: BASE, fetch }), calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

// One client invocation per (method, route template), with the exact request it must send.
interface RouteCall {
  invoke: (client: ApiClient) => Promise<unknown>;
  pathname: string;
  query: Record<string, string>;
  body?: string;
}

const ROUTE_CALLS: Record<string, RouteCall> = {
  'GET /health/live': { invoke: (c) => c.healthLive(), pathname: '/health/live', query: {} },
  'GET /health/ready': { invoke: (c) => c.healthReady(), pathname: '/health/ready', query: {} },
  'GET /api/v1/meta': { invoke: (c) => c.meta(), pathname: '/api/v1/meta', query: {} },
  'GET /oauth/client-metadata.json': {
    invoke: (c) => c.oauthClientMetadata(),
    pathname: '/oauth/client-metadata.json',
    query: {},
  },
  'GET /api/v1/resolve': {
    invoke: (c) => c.resolve('alice.test'),
    pathname: '/api/v1/resolve',
    query: { handle: 'alice.test' },
  },
  'GET /api/v1/scrobbles/{id}': {
    invoke: (c) => c.scrobble(R01),
    // The full AT URI as one URL-encoded path segment (API.md).
    pathname: '/api/v1/scrobbles/at%3A%2F%2Fdid%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa%2Fcom.example.atmusic.scrobble%2Fr01',
    query: {},
  },
  'GET /api/v1/users/{did}/scrobbles': {
    invoke: (c) => c.userScrobbles(ALICE, { limit: 20 }),
    pathname: `/api/v1/users/${ALICE}/scrobbles`,
    query: { limit: '20' },
  },
  'GET /api/v1/feed': {
    invoke: (c) => c.feed({ scope: 'following', viewer: ALICE }),
    pathname: '/api/v1/feed',
    query: { scope: 'following', viewer: ALICE },
  },
  'GET /api/v1/users/{did}/profile': {
    invoke: (c) => c.profile(ALICE),
    pathname: `/api/v1/users/${ALICE}/profile`,
    query: {},
  },
  'GET /api/v1/users/{did}/stats': {
    invoke: (c) => c.stats(ALICE, { window: '7d', limit: 5 }),
    pathname: `/api/v1/users/${ALICE}/stats`,
    query: { window: '7d', limit: '5' },
  },
  'GET /api/v1/users/{did}/following': {
    invoke: (c) => c.following(ALICE),
    pathname: `/api/v1/users/${ALICE}/following`,
    query: {},
  },
  'GET /api/v1/users/{did}/followers': {
    invoke: (c) => c.followers(BOB, { limit: 3 }),
    pathname: `/api/v1/users/${BOB}/followers`,
    query: { limit: '3' },
  },
  'GET /api/v1/users/{did}/export': {
    invoke: (c) => c.exportUser(ALICE),
    pathname: `/api/v1/users/${ALICE}/export`,
    query: {},
  },
  'POST /api/v1/notify': {
    invoke: (c) => c.notify({ uri: R01 }),
    pathname: '/api/v1/notify',
    query: {},
    body: JSON.stringify({ uri: R01 }),
  },
  'GET /api/v1/records/status': {
    invoke: (c) => c.recordStatus(R01),
    pathname: '/api/v1/records/status',
    query: { uri: R01 },
  },
};

function routeCall(c: ResponseCase): RouteCall {
  const call = ROUTE_CALLS[`${c.method} ${c.path}`];
  if (!call) throw new Error(`no client method for ${c.method} ${c.path}`);
  return call;
}

function expectRequest(sent: Sent | undefined, method: string, call: RouteCall): void {
  expect(sent).toBeDefined();
  expect(sent!.method).toBe(method);
  expect(sent!.url.origin).toBe(BASE);
  expect(sent!.url.pathname).toBe(call.pathname);
  expect(Object.fromEntries(sent!.url.searchParams)).toEqual(call.query);
  expect(sent!.body).toBe(call.body ?? null);
}

/** Every value inside a JSON document with the decoder's path notation (`$.a[0].b`). */
function jsonPaths(value: unknown, path = '$'): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      out.push({ path: `${path}[${i}]`, value: item }, ...jsonPaths(item, `${path}[${i}]`));
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push({ path: `${path}.${key}`, value: item }, ...jsonPaths(item, `${path}.${key}`));
    }
  }
  return out;
}

/** A value of a different JSON type than `value`. */
function changedType(value: unknown): unknown {
  if (typeof value === 'string') return 1;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return true;
  return 'not-a-container';
}

function setAt(root: unknown, path: string, replacement: unknown): unknown {
  const copy = structuredClone(root);
  const steps = [...path.slice(1).matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]));
  let target = copy as Record<string | number, unknown>;
  for (const step of steps.slice(0, -1)) target = target[step!] as Record<string | number, unknown>;
  target[steps[steps.length - 1]!] = replacement;
  return copy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Test titles are the plan's test ids verbatim (docs/verification/ts-case-map.json).

it('decodes Page<Scrobble> and passes nextCursor unchanged', async () => {
  // An opaque token with characters that must be query-encoded on the way back.
  const cursor = 'djEuAAAB+/x9_-~.%3D==';
  const first = example<ScrobblePage>('scrobble-page');
  first.nextCursor = cursor;
  const second = example<ScrobblePage>('scrobble-page');
  // The second page's item omits every optional field; absent stays absent.
  const { album: _a, durationSeconds: _d, recordingMbid: _m, ...bare } = second.items[0]!;
  second.items = [{ ...bare, uri: `${bare.uri.slice(0, -3)}r02` }];
  second.nextCursor = null;

  const pages = [first, second, first];
  const { client, calls } = fakeServer(() => json(200, pages[calls.length - 1]));

  const page1 = await client.userScrobbles(ALICE, { limit: 2 });
  expect(page1).toEqual(first);
  expect(page1.nextCursor).toBe(cursor);
  expect(calls[0]!.method).toBe('GET');
  expect(calls[0]!.url.pathname).toBe(`/api/v1/users/${ALICE}/scrobbles`);
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ limit: '2' });

  const page2 = await client.userScrobbles(ALICE, { limit: 2, cursor: page1.nextCursor });
  expect(calls[1]!.url.searchParams.get('cursor')).toBe(cursor);
  // Form-encoded once (application/x-www-form-urlencoded), never altered or re-encoded twice.
  expect(calls[1]!.url.search).toBe(`?${new URLSearchParams({ limit: '2', cursor })}`);
  expect(calls[1]!.url.search).toContain('cursor=djEuAAAB%2B%2Fx9_-%7E.%253D%3D%3D');
  expect(page2).toEqual(second);
  expect(page2.nextCursor).toBeNull();
  expect(Object.keys(page2.items[0]!)).not.toContain('album');
  expect(Object.keys(page2.items[0]!)).not.toContain('durationSeconds');
  expect(Object.keys(page2.items[0]!)).not.toContain('recordingMbid');

  // The feed passes the same opaque cursor back next to its scope and viewer.
  const feed = await client.feed({ scope: 'following', viewer: ALICE, limit: 2, cursor });
  expect(feed.nextCursor).toBe(cursor);
  expect(calls[2]!.url.pathname).toBe('/api/v1/feed');
  expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({
    scope: 'following',
    viewer: ALICE,
    limit: '2',
    cursor,
  });
  expect(calls).toHaveLength(3);
});

it('maps 422 envelope to ApiError with fields', async () => {
  const envelope = example<{ error: { requestId: string; message: string; fields: Record<string, string> } }>(
    'error-422',
  );
  const { client, calls } = fakeServer(() => json(422, envelope));

  // The client sends the invalid limit as given (no clamping) and surfaces the server's verdict.
  const error = await rejection(client.userScrobbles(ALICE, { limit: 0 }));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.searchParams.get('limit')).toBe('0');
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.status).toBe(422);
  expect(apiError.code).toBe('validation_failed');
  expect(apiError.fields).toEqual({ limit: 'Must be an integer between 1 and 100.' });
  expect(apiError.message).toBe(envelope.error.message);
  expect(apiError.requestId).toBe(envelope.error.requestId);
  expect(apiError.endpoint).toBe(`GET /api/v1/users/${ALICE}/scrobbles`);
  expect(apiError.retryAfterSeconds).toBeNull();

  // 429 keeps Retry-After; a 400 has no fields.
  const limited = fakeServer(() => json(429, example('error-429'), { 'retry-after': '7' }));
  const rateError = (await rejection(limited.client.feed())) as ApiError;
  expect(rateError).toBeInstanceOf(ApiError);
  expect([rateError.status, rateError.code, rateError.retryAfterSeconds]).toEqual([429, 'rate_limited', 7]);
  expect(rateError.fields).toBeUndefined();
  const badCursor = fakeServer(() => json(400, example('error-400')));
  const cursorError = (await rejection(badCursor.client.feed({ cursor: 'tampered' }))) as ApiError;
  expect([cursorError.status, cursorError.code, cursorError.fields]).toEqual([400, 'bad_request', undefined]);
  expect(badCursor.calls[0]!.url.searchParams.get('cursor')).toBe('tampered');

  // A 422 whose envelope is malformed is contract drift, not a typed ApiError.
  const malformed = structuredClone(envelope) as { error: Record<string, unknown> };
  malformed.error.fields = { limit: 1 };
  const drift = fakeServer(() => json(422, malformed));
  const driftError = await rejection(drift.client.userScrobbles(ALICE, { limit: 0 }));
  expect(driftError).toBeInstanceOf(ApiDecodeError);
  expect((driftError as ApiDecodeError).path).toBe('$.error.fields.limit');
  expect((driftError as ApiDecodeError).status).toBe(422);

  // An unknown error code and a non-JSON error page are drift too.
  const unknownCode = fakeServer(() => json(422, { error: { ...envelope.error, code: 'teapot' } }));
  const unknownError = (await rejection(unknownCode.client.meta())) as ApiDecodeError;
  expect(unknownError).toBeInstanceOf(ApiDecodeError);
  expect(unknownError.path).toBe('$.error.code');
  const html = fakeServer(() => new Response('<html>bad gateway</html>', { status: 502 }));
  const htmlError = (await rejection(html.client.meta())) as ApiDecodeError;
  expect(htmlError).toBeInstanceOf(ApiDecodeError);
  expect([htmlError.status, htmlError.path]).toEqual([502, '$']);

  // A rejected fetch is a network error carrying the cause.
  const offline = new ApiClient({
    baseUrl: BASE,
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  const networkError = await rejection(offline.meta());
  expect(networkError).toBeInstanceOf(ApiNetworkError);
  expect((networkError as ApiNetworkError).cause).toBeInstanceOf(TypeError);
});

it('notify posts {uri} and returns queued', async () => {
  const input = example<NotifyInput>('notify-input');
  const { client, calls } = fakeServer(() => json(202, example('notify')));

  const accepted = await client.notify(input);
  expect(accepted).toEqual({ state: 'queued' });
  expect(calls).toHaveLength(1);
  const sent = calls[0]!;
  expect(sent.method).toBe('POST');
  expect(sent.url.href).toBe(`${BASE}/api/v1/notify`);
  expect(sent.headers.get('content-type')).toBe('application/json');
  expect(sent.headers.get('accept')).toBe('application/json');
  expect(sent.headers.get('cookie')).toBeNull();
  expect(sent.init.credentials).toBe('omit');
  expect(sent.body).toBe(`{"uri":"${R01}"}`);
  expect(JSON.parse(sent.body!)).toEqual({ uri: R01 });

  // The {did} form sends exactly {did}.
  await client.notify({ did: ALICE });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toBe(`{"did":"${ALICE}"}`);

  // Success is exactly 202 {state:"queued"}.
  const wrongStatus = fakeServer(() => json(200, example('notify')));
  const statusError = (await rejection(wrongStatus.client.notify(input))) as ApiDecodeError;
  expect(statusError).toBeInstanceOf(ApiDecodeError);
  expect(statusError.status).toBe(200);
  const wrongState = fakeServer(() => json(202, { state: 'done' }));
  expect(((await rejection(wrongState.client.notify(input))) as ApiDecodeError).path).toBe('$.state');

  // 503 queue_full and 413 are typed errors.
  const full = fakeServer(() => json(503, example('error-queue-full')));
  const fullError = (await rejection(full.client.notify(input))) as ApiError;
  expect([fullError.status, fullError.code]).toEqual([503, 'queue_full']);
  const tooLarge = fakeServer(() => json(413, example('error-413')));
  const largeError = (await rejection(tooLarge.client.notify(input))) as ApiError;
  expect([largeError.status, largeError.code]).toEqual([413, 'payload_too_large']);
  expect(full.calls).toHaveLength(1);
  expect(full.calls[0]!.method).toBe('POST');
});

it('every api/examples response decodes and a changed field type is rejected', async () => {
  // Every remaining route has a client method, and every response fixture is exercised.
  const routes = new Set(RESPONSE_CASES.map((c) => `${c.method} ${c.path}`));
  expect([...routes].sort()).toEqual(Object.keys(ROUTE_CALLS).sort());
  const responseFixtures = Object.keys(exampleFiles)
    .map((file) => file.replace('../../api/examples/', '').replace('.json', ''))
    .filter((name) => !name.endsWith('-input') && !name.endsWith('-cases'));
  expect([...new Set(RESPONSE_CASES.map((c) => c.example))].sort()).toEqual(responseFixtures.sort());

  let decoded = 0;
  let rejected = 0;
  for (const c of RESPONSE_CASES) {
    const call = routeCall(c);
    const fixture = example(c.example);
    const label = `${c.method} ${c.path} ${c.status} ${c.example}`;

    // 1. The unmodified fixture decodes to exactly itself, or to the typed ApiError.
    const ok = fakeServer(() => json(c.status, fixture));
    if (c.status < 300) {
      expect(await call.invoke(ok.client), label).toEqual(fixture);
    } else {
      const error = await rejection(call.invoke(ok.client));
      const body = (fixture as { error: { code: string; requestId: string; fields?: Record<string, string> } }).error;
      expect(error, label).toBeInstanceOf(ApiError);
      expect((error as ApiError).status, label).toBe(c.status);
      expect((error as ApiError).code, label).toBe(body.code);
      expect((error as ApiError).requestId, label).toBe(body.requestId);
      expect((error as ApiError).fields, label).toEqual(body.fields);
    }
    expect(ok.calls, label).toHaveLength(1);
    expectRequest(ok.calls[0], c.method, call);
    decoded++;

    // 2. Changing the JSON type of any single field (leaf or container) is rejected at that field.
    for (const { path, value } of jsonPaths(fixture)) {
      const mutated = setAt(fixture, path, changedType(value));
      const bad = fakeServer(() => json(c.status, mutated));
      const error = await rejection(call.invoke(bad.client));
      expect(error, `${label} ${path}`).toBeInstanceOf(ApiDecodeError);
      expect((error as ApiDecodeError).path, `${label} ${path}`).toBe(path);
      expect((error as ApiDecodeError).status).toBe(c.status);
      expect(bad.calls).toHaveLength(1);
      rejected++;
    }

    // 3. Objects are closed (only the OAuth client metadata admits extension fields).
    const extended = { ...(fixture as object), unexpected: 'x' };
    const extra = fakeServer(() => json(c.status, extended));
    if (c.example === 'oauth-metadata') {
      expect(await call.invoke(extra.client)).toEqual(extended);
    } else {
      const error = await rejection(call.invoke(extra.client));
      expect(error, label).toBeInstanceOf(ApiDecodeError);
      expect((error as ApiDecodeError).path, label).toBe('$.unexpected');
    }
  }
  expect(decoded).toBe(RESPONSE_CASES.length);
  expect(decoded).toBe(51);
  expect(rejected).toBeGreaterThan(300);
});
