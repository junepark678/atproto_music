// W5-01 worker/src/router.ts + worker/src/index.ts composition: the production
// Worker fetch over the real IndexDO (JS RPC, DO SQLite, alarm-driven
// ingestion of read_models.json from real signed repositories).
// Proves M1.2.3/packaged_http, M1.4.2/safe_errors (with error.test.ts),
// M6.1.1/asset_missing_traversal and spa_deep_link (Worker side, ADR 0004
// §15 Q9 asset-miss routing), M6.1.2/untrusted_forwarded and
// M6.2.1/bounded_state (client-IP keying).

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import {
  ALICE,
  type AssetCall,
  BOB,
  CAROL,
  constructed,
  control,
  harness,
  inDo,
  ingestFixture,
  kitControl,
  postJson,
  resetControl,
  schema,
  UUID,
  uriOf,
} from './support';

const rkeysOf = (body: unknown) =>
  (body as { items: Array<{ uri: string }> }).items.map((s) => s.uri.slice(s.uri.lastIndexOf('/') + 1));

const INDEX_HTML =
  '<!doctype html>\n<html lang="en"><head><title>atmusic</title></head><body><div id="app"></div></body></html>\n';
const APP_JS = '"use strict";\n';

/**
 * A Static Assets stand-in with `not_found_handling: "none"`: the files it
 * holds are 200 (GET with body, HEAD without) and a bare 405 for any other
 * method, anything else a bare 404, as the platform's ASSETS binding answers
 * (miniflare assets.worker.js `getResponseOrAssetIntent`). `/` is index.html
 * unless `index` says otherwise (missing, or a redirect, to prove neither is
 * passed on).
 */
function staticAssets(index: 'ok' | 'missing' | 'redirect' = 'ok'): Fetcher & { calls: AssetCall[] } {
  const calls: AssetCall[] = [];
  const files = new Map<string, { body: string; headers: Record<string, string> }>([
    [
      '/assets/app-3f9a1c2e.js',
      {
        body: APP_JS,
        headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
      },
    ],
  ]);
  if (index === 'ok')
    files.set('/', {
      body: INDEX_HTML,
      headers: { 'content-type': 'text/html', 'cache-control': 'no-cache', etag: '"idx-1"' },
    });
  return {
    calls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(input as RequestInfo, init);
      calls.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers) });
      const { pathname } = new URL(req.url);
      if (index === 'redirect' && pathname === '/') {
        return new Response(null, { status: 307, headers: { location: '/index.html' } });
      }
      const file = files.get(pathname);
      if (file === undefined) return new Response(null, { status: 404 });
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
      return new Response(req.method === 'HEAD' ? null : file.body, { status: 200, headers: file.headers });
    },
    connect() {
      throw new Error('not used');
    },
  } as unknown as Fetcher & { calls: AssetCall[] };
}

/** The production Worker over `assets`; returns the response and the ASSETS calls it made. */
async function viaAssets(
  h: ReturnType<typeof harness>,
  assets: ReturnType<typeof staticAssets>,
  path: string,
  init: RequestInit & { ip?: string } = {},
) {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip !== undefined) headers.set('cf-connecting-ip', ip);
  const before = assets.calls.length;
  const res = await h.worker.fetch(
    new Request(`https://music.example.test${path}`, { ...rest, headers }),
    { ...h.env, ASSETS: assets } as Env,
    {} as ExecutionContext,
  );
  const text = await res.text();
  let body: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
  const calls = assets.calls.slice(before);
  return {
    status: res.status,
    headers: res.headers,
    text,
    body,
    calls,
    seen: calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
  };
}

function expectEnvelope(r: { status: number; headers: Headers; body: unknown }, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('content-type')).toBe('application/json');
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(schema('Error', r.body)).toBe('valid');
  const error = (r.body as { error: { code: string; requestId: string } }).error;
  expect(error.code).toBe(code);
  expect(error.requestId).toMatch(UUID);
  expect(r.headers.get('x-request-id')).toBe(error.requestId);
}

describe('worker/src/router.ts', () => {
  beforeEach(() => {
    resetControl();
  });

  it('every API.md v1.1 route dispatches; unknown /api/x → JSON 404; non-API path → ASSETS', async () => {
    const kit = await kitControl();
    const h = harness('routing');
    const seed = await ingestFixture(h, kit);
    const tables = await inDo(h.stub, (_i, db) => ({
      users: db.all<{ did: string; active: number }>('SELECT did, active FROM users ORDER BY did'),
      scrobbles: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')?.n,
      follows: db.all<{ actor: string; subject: string }>('SELECT actor, subject FROM follows'),
    }));
    expect(tables).toEqual({
      users: [
        { did: ALICE, active: 1 },
        { did: BOB, active: 1 },
        { did: CAROL, active: 1 },
      ],
      scrobbles: 9, // r01–r10 without the deleted r08
      follows: [{ actor: ALICE, subject: BOB }],
    });

    kit.resetCalls();
    const assetsBefore = h.assets.calls.length;
    const r07 = encodeURIComponent(uriOf(ALICE, 'r07'));
    const reads: Array<[string, number, string]> = [
      ['/health/ready', 200, 'Ready'],
      ['/api/v1/meta', 200, 'Meta'],
      [`/api/v1/scrobbles/${r07}`, 200, 'ScrobbleResult'],
      [`/api/v1/users/${ALICE}/scrobbles?limit=100`, 200, 'ScrobblePage'],
      ['/api/v1/feed?scope=global&limit=100', 200, 'ScrobblePage'],
      [`/api/v1/feed?scope=following&viewer=${ALICE}`, 200, 'ScrobblePage'],
      [`/api/v1/users/${ALICE}/stats?window=all`, 200, 'Statistics'],
      [`/api/v1/users/${ALICE}/following`, 200, 'FollowPage'],
      [`/api/v1/users/${BOB}/followers`, 200, 'FollowPage'],
      [`/api/v1/users/${ALICE}/export`, 200, 'Export'],
      [`/api/v1/records/status?uri=${r07}`, 200, 'RecordStatus'],
    ];
    const bodies: Record<string, unknown> = {};
    for (const [path, status, name] of reads) {
      const r = await h.request(path);
      expect([path, r.status]).toEqual([path, status]);
      expect([path, schema(name, r.body)]).toEqual([path, 'valid']);
      expect(r.headers.get('x-request-id')).toMatch(UUID);
      bodies[path] = r.body;
    }
    // Every read is answered from the index: no remote call at all.
    expect(kit.transport.calls.entries).toEqual([]);

    expect(bodies['/health/ready']).toEqual({ status: 'ready' });
    expect((bodies['/api/v1/meta'] as { lexiconPrefix: string }).lexiconPrefix).toBe('com.example.atmusic');
    const scrobble = (bodies[`/api/v1/scrobbles/${r07}`] as { scrobble: { uri: string; cid: string } }).scrobble;
    expect(scrobble.uri).toBe(uriOf(ALICE, 'r07'));
    expect(scrobble.cid).toBe(seed.records.get(uriOf(ALICE, 'r07'))?.cid);
    expect(rkeysOf(bodies[`/api/v1/users/${ALICE}/scrobbles?limit=100`])).toEqual([
      'r07',
      'r01',
      'r02',
      'r03',
      'r04',
      'r05',
      'r06',
    ]);
    expect(rkeysOf(bodies['/api/v1/feed?scope=global&limit=100'])).toEqual([
      'r09',
      'r10',
      'r07',
      'r01',
      'r02',
      'r03',
      'r04',
      'r05',
      'r06',
    ]);
    expect(rkeysOf(bodies[`/api/v1/feed?scope=following&viewer=${ALICE}`])).toEqual(['r09']);
    expect(bodies[`/api/v1/users/${ALICE}/stats?window=all`]).toMatchObject({
      did: ALICE,
      window: 'all',
      totalScrobbles: 7,
      distinctArtists: 3,
      distinctTracks: 6,
    });
    expect(
      (bodies[`/api/v1/users/${ALICE}/following`] as { items: Array<{ subject: string }> }).items.map((f) => f.subject),
    ).toEqual([BOB]);
    expect(
      (bodies[`/api/v1/users/${BOB}/followers`] as { items: Array<{ actor: string }> }).items.map((f) => f.actor),
    ).toEqual([ALICE]);
    expect((bodies[`/api/v1/users/${ALICE}/export`] as { scrobbles: unknown[] }).scrobbles).toHaveLength(7);
    expect(bodies[`/api/v1/records/status?uri=${r07}`]).toMatchObject({ state: 'indexed' });

    // Profile and resolve verify the handle against the fixture DoH / PLC.
    const profile = await h.request(`/api/v1/users/${ALICE}/profile`);
    expect(profile.status).toBe(200);
    expect(schema('Profile', profile.body)).toBe('valid');
    expect(profile.body).toMatchObject({ did: ALICE, handle: 'alice.test', totalScrobbles: 7, followingCount: 1 });
    expect(profile.headers.get('cache-control')).toBe('no-store');
    const resolved = await h.request('/api/v1/resolve?handle=alice.test');
    expect(resolved.status).toBe(200);
    expect(schema('ResolvedIdentity', resolved.body)).toBe('valid');
    expect(resolved.body).toEqual({ did: ALICE, handle: 'alice.test', verified: true });
    expect(
      kit.transport.calls.count({ service: 'doh' }) + kit.transport.calls.count({ service: 'handle' }),
    ).toBeGreaterThan(0);

    // POST /api/v1/notify dispatches (ingestFixture used it for {did}); {uri} too.
    const notified = await postJson(h, '/api/v1/notify', { uri: uriOf(ALICE, 'r07') }, { ip: '198.51.100.2' });
    expect(notified.status).toBe(202);
    expect(schema('NotifyAccepted', notified.body)).toBe('valid');
    expect(await inDo(h.stub, (_i, db) => db.all('SELECT uri, source FROM hints'))).toEqual([
      { uri: uriOf(ALICE, 'r07'), source: 'notify' },
    ]);

    // /health/live is answered by the Worker alone: a fresh name's IndexDO is never created.
    const lonely = harness('live-only');
    const liveRes = await lonely.request('/health/live');
    expect(liveRes.status).toBe(200);
    expect(schema('Live', liveRes.body)).toBe('valid');
    expect(liveRes.body).toEqual({ status: 'live' });
    expect(constructed(lonely.stub)).toBe(0);

    // Unknown Worker paths: the JSON 404 envelope, never ASSETS (no SPA index.html).
    for (const path of ['/api/x', '/api/v1/nope', `/api/v1/users/${ALICE}/nope`, '/health/x', '/internal/x', '/api']) {
      const r = await h.request(path);
      expectEnvelope(r, 404, 'not_found');
    }
    // An encoded traversal stays inside its segment: the route rejects it, ASSETS never sees it.
    const traversal = await h.request('/api/v1/scrobbles/..%2F..%2Fassets%2Fapp.js');
    expectEnvelope(traversal, 422, 'validation_failed');
    const wrongMethod = await h.request('/api/v1/meta', { method: 'POST' });
    expectEnvelope(wrongMethod, 405, 'method_not_allowed');
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    expect(h.assets.calls.length).toBe(assetsBefore);

    // Everything else is the SPA's: passed to ASSETS unchanged in path and method.
    for (const path of ['/', '/feed', '/oauth/callback?code=x&state=y', '/assets/missing.js']) {
      const r = await h.request(path);
      expect(r.status).toBe(200);
      expect(r.text).toBe(`asset:${new URL(path, 'https://x.test').pathname}`);
    }
    expect(h.assets.calls.slice(assetsBefore).map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/'],
      ['GET', '/feed'],
      ['GET', '/oauth/callback'],
      ['GET', '/assets/missing.js'],
    ]);
  });

  it('inbound x-atmusic-client-ip is stripped and CF-Connecting-IP used', async () => {
    const h = harness('client-ip');
    const notifyFrom = (ip: string, spoofed: string, rkey: string) =>
      postJson(h, '/api/v1/notify', { uri: uriOf(CAROL, rkey) }, { ip, headers: { 'x-atmusic-client-ip': spoofed } });

    // 60 per minute per CF-Connecting-IP, whatever x-atmusic-client-ip claims.
    for (let n = 0; n < 60; n++) {
      const r = await notifyFrom('203.0.113.7', `192.0.2.${n}`, `r${String(n).padStart(3, '0')}`);
      expect([n, r.status]).toEqual([n, 202]);
    }
    const limited = await notifyFrom('203.0.113.7', '192.0.2.200', 'r999');
    expectEnvelope(limited, 429, 'rate_limited');
    expect(limited.headers.get('retry-after')).toBe('1');
    // Spoofing the limited address from another client does not drain its bucket.
    const other = await notifyFrom('203.0.113.8', '203.0.113.7', 'r998');
    expect(other.status).toBe(202);
    const hints = await inDo(h.stub, (_i, db) => db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri'));
    expect(hints).toHaveLength(61);
    expect(hints.map((r) => r.uri)).not.toContain(uriOf(CAROL, 'r999'));
    expect(hints.map((r) => r.uri)).toContain(uriOf(CAROL, 'r998'));

    // A Worker path handed to ASSETS never is; a non-Worker path is, without any x-atmusic-* header.
    const asset = await h.request('/feed', {
      ip: '203.0.113.9',
      headers: { 'x-atmusic-client-ip': '10.0.0.1', 'X-Atmusic-Admin': 'yes', accept: 'text/html' },
    });
    expect(asset.status).toBe(200);
    const seen = h.assets.calls.at(-1)?.headers ?? {};
    expect(Object.keys(seen).filter((k) => k.startsWith('x-atmusic-'))).toEqual([]);
    expect(seen['cf-connecting-ip']).toBe('203.0.113.9');
    expect(seen.accept).toBe('text/html');
  });

  it('forced storage error → 500 envelope with UUID requestId and no stack trace or file path', async () => {
    const h = harness('storage-error');
    const ok = await h.request(`/api/v1/users/${ALICE}/scrobbles`);
    expect(ok.status).toBe(200);

    const leak =
      'SQLITE_IOERR: disk I/O error near "scrobbles" for did:plc:aaaaaaaaaaaaaaaaaaaaaaaa\n' +
      '    at history (/srv/atmusic/worker/src/do/read/history.ts:88:14)\n' +
      '    at file:///srv/atmusic/worker/src/do/db.ts:71:20';
    control.dbFault = { match: /FROM scrobbles/, message: leak, remaining: 1 };
    const failed = await h.request(`/api/v1/users/${ALICE}/scrobbles`);
    expectEnvelope(failed, 500, 'internal_error');
    expect(failed.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'An internal error occurred.',
        requestId: failed.headers.get('x-request-id'),
      },
    });
    for (const needle of ['SQLITE', 'history.ts', 'db.ts', '/srv/', 'file://', '    at ', 'did:plc:', 'Error:']) {
      expect([needle, failed.text.includes(needle)]).toEqual([needle, false]);
    }
    expect(control.dbFault.remaining).toBe(0);

    // The fault is gone and the storage untouched: the same request succeeds.
    const again = await h.request(`/api/v1/users/${ALICE}/scrobbles`);
    expect(again.status).toBe(200);
    expect(schema('ScrobblePage', again.body)).toBe('valid');
    expect(again.headers.get('x-request-id')).not.toBe(failed.headers.get('x-request-id'));
  });

  it('asset miss: SPA route GET/HEAD serves index.html 200, every other miss is JSON not_found with x-request-id', async () => {
    const h = harness('asset-miss');
    const assets = staticAssets();
    const PLC = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    const WEB = 'did:web:music.example.test';

    // An existing file is Static Assets' answer, passed on unchanged (one ASSETS call).
    const js = await viaAssets(h, assets, '/assets/app-3f9a1c2e.js');
    expect([js.status, js.text, js.headers.get('cache-control')]).toEqual([
      200,
      APP_JS,
      'public, max-age=31536000, immutable',
    ]);
    expect(js.seen).toEqual(['GET /assets/app-3f9a1c2e.js']);
    const root = await viaAssets(h, assets, '/');
    expect([root.status, root.text, root.seen]).toEqual([200, INDEX_HTML, ['GET /']]);

    // Every SPA route of the shared table, raw and percent-encoded DIDs alike:
    // the miss, then index.html fetched from ASSETS at `/` with the same method.
    const spaPaths = [
      ['/feed', '/feed'],
      ['/feed/', '/feed/'],
      ['/signin', '/signin'],
      ['/scrobble', '/scrobble'],
      ['/settings', '/settings'],
      ['/oauth/callback?code=cod-x&state=st-x&iss=https%3A%2F%2Fpds.example.test', '/oauth/callback'],
      [`/u/${PLC}`, `/u/${PLC}`],
      [`/u/${PLC}?tab=history`, `/u/${PLC}`],
      [`/u/${encodeURIComponent(PLC)}`, `/u/${encodeURIComponent(PLC)}`],
      [`/u/${WEB}`, `/u/${WEB}`],
      [`/u/${encodeURIComponent(WEB)}`, `/u/${encodeURIComponent(WEB)}`],
    ] as const;
    for (const [path, pathname] of spaPaths) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await viaAssets(h, assets, path, { method, headers: { accept: 'text/html' } });
        const label = `${method} ${path}`;
        expect([label, r.status], label).toEqual([label, 200]);
        expect(r.headers.get('content-type'), label).toBe('text/html');
        expect(r.headers.get('cache-control'), label).toBe('no-cache');
        expect(r.headers.get('location'), label).toBeNull();
        expect(r.headers.get('x-request-id'), label).toMatch(UUID);
        expect(r.text, label).toBe(method === 'GET' ? INDEX_HTML : '');
        expect(r.seen, label).toEqual([`${method} ${pathname}`, `${method} /`]);
        expect(r.calls[1]?.headers.accept, label).toBe('text/html');
      }
    }

    // Every other miss: the JSON envelope, and index.html is never fetched.
    const misses = [
      '/assets/missing.js',
      '/assets/app-3f9a1c2e.js.map',
      '/unknown',
      '/unknown/api',
      '/oauth/missing',
      '/oauth',
      '/secret.txt',
      '/index.htm',
      '/metrics',
      '/.well-known/atproto-did',
      '/u',
      '/u/',
      `/u/${PLC}/extra`,
      '/feed/extra',
      '/settingsx',
    ];
    for (const path of misses) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await viaAssets(h, assets, path, { method });
        const label = `${method} ${path}`;
        if (method === 'GET') {
          expectEnvelope(r, 404, 'not_found');
        } else {
          expect([label, r.status, r.headers.get('content-type')]).toEqual([label, 404, 'application/json']);
          expect(r.headers.get('x-request-id'), label).toMatch(UUID);
        }
        expect(r.text.includes('<div id="app">'), label).toBe(false);
        expect(r.seen, label).toEqual([`${method} ${new URL(path, 'https://x.test').pathname}`]);
      }
    }

    // Traversal and encoding tricks (the oracle's asset_missing_traversal inputs
    // and safe_path rules): the envelope, and index.html is never fetched. The
    // ones the oracle's safe_path rejects never reach ASSETS at all.
    const rejected = [
      '/assets%2f..%2fsecret',
      '/assets/%252e%252e/secret',
      '/u/did%3Aplc%3Aa%2Fb',
      `/u/${encodeURIComponent(PLC)}%5C`,
      '/u/%00',
      '/u/%ff',
      '/u/%zz',
      '/feed%',
      '/feed%2',
    ];
    // The URL parser itself resolves `%2e%2e` segments and turns `\` into `/`
    // before the Worker sees the path; those land on non-SPA paths here.
    for (const path of [...rejected, '/%2e%2e/secret', '/assets/%2E%2E/secret', '/u/%2e%2e/secret', '/u/a\\b']) {
      const r = await viaAssets(h, assets, path);
      expectEnvelope(r, 404, 'not_found');
      expect([path, r.seen.includes('GET /')]).toEqual([path, false]);
      if ((rejected as readonly string[]).includes(path)) expect([path, r.seen]).toEqual([path, []]);
    }

    // A non-GET/HEAD to an SPA path with no file behind it (every SPA route
    // but `/`): in production Static Assets finds no file and the Worker gets
    // the request. The envelope, never 405 and never index.html.
    const nonGet = async (method: string, path: string) => {
      const r = await viaAssets(h, assets, path, {
        method,
        ...(method === 'OPTIONS' ? {} : { body: '{"x":1}', headers: { 'content-type': 'application/json' } }),
      });
      expectEnvelope(r, 404, 'not_found');
      expect(r.headers.get('allow'), `${method} ${path}`).toBeNull();
      expect([method, path, r.seen]).toEqual([method, path, []]);
    };
    for (const [method, path] of [
      ['POST', '/feed'],
      ['POST', `/u/${PLC}`],
      ['POST', `/u/${encodeURIComponent(PLC)}`],
      ['PUT', '/oauth/callback'],
      ['DELETE', '/settings'],
      ['OPTIONS', '/feed'],
    ] as const) {
      await nonGet(method, path);
    }
    // Worker-only behaviour, not what production sends. A non-GET/HEAD to a
    // path that is an existing file (`/` is index.html, a hashed asset) never
    // reaches the Worker: Static Assets answers it with a bare 405, no JSON
    // and no x-request-id (the platform exception in docs/deploy/routing.md;
    // web/tests/mvp.spec.ts pins it under wrangler dev). These cases pin only
    // what the Worker would send were such a request routed to it, e.g. if
    // the owner put `/` into run_worker_first.
    for (const [method, path] of [
      ['PATCH', '/'],
      ['POST', '/assets/app-3f9a1c2e.js'],
    ] as const) {
      await nonGet(method, path);
      // The stand-in is the platform's answer the Worker never sees for these.
      const platform = await assets.fetch(`https://music.example.test${path}`, { method, body: '{"x":1}' });
      expect([method, path, platform.status, platform.headers.get('x-request-id')]).toEqual([method, path, 405, null]);
    }

    // Spoofed internal headers never reach ASSETS on either fetch; others pass through.
    const spoofed = await viaAssets(h, assets, `/u/${PLC}`, {
      ip: '203.0.113.9',
      headers: { 'x-atmusic-client-ip': '10.0.0.1', 'X-Atmusic-Admin': 'yes', accept: 'text/html' },
    });
    expect(spoofed.status).toBe(200);
    expect(spoofed.calls).toHaveLength(2);
    for (const call of spoofed.calls) {
      expect(Object.keys(call.headers).filter((k) => k.startsWith('x-atmusic-'))).toEqual([]);
      expect(call.headers['cf-connecting-ip']).toBe('203.0.113.9');
    }

    // index.html missing or answered with a redirect: the envelope, never a 3xx.
    for (const mode of ['missing', 'redirect'] as const) {
      const broken = staticAssets(mode);
      const r = await viaAssets(h, broken, '/feed');
      expectEnvelope(r, 404, 'not_found');
      expect(r.headers.get('location')).toBeNull();
      expect([mode, r.seen]).toEqual([mode, ['GET /feed', 'GET /']]);
    }

    // The Worker-first prefixes are unchanged: the envelope, ASSETS untouched.
    for (const path of ['/api/x', '/health/x', '/internal/x']) {
      const r = await viaAssets(h, assets, path);
      expectEnvelope(r, 404, 'not_found');
      expect([path, r.seen]).toEqual([path, []]);
    }
    // Asset misses never create or touch the IndexDO.
    expect(constructed(h.stub)).toBe(0);
  });
});
