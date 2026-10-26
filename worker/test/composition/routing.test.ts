// W5-01 composition routing, on the Node host (ported by N4-03; ADR 0005
// §3.6, §3.7, §3.10): the production Node composition (support.ts: compose,
// the dispatcher, the static server over a real web/dist and the HTTP bridge
// on 127.0.0.1:0) over IndexCore and node:sqlite, with read_models.json
// ingested from real signed repositories by the core alarm.
// Proves M1.2.3/packaged_http, M1.4.2/safe_errors (with error.test.ts),
// M6.1.1/asset_missing_traversal and spa_deep_link (ADR 0004 §15 Q9 asset-miss
// routing, kept by ADR 0005 §3.7), M6.1.2/untrusted_forwarded and
// M6.2.1/bounded_state (client-IP keying).
//
// Where the Workers platform and the Node host differ the Node behaviour is
// pinned: the router prefixes include /oauth/ (ADR 0005 §3.7), a method other
// than GET/HEAD on an existing file is the static server's 405 envelope with
// `Allow: GET, HEAD`, and "the index is never touched" is shown by the Db
// wrapper recording no statement at all (there is no Durable Object to leave
// uncreated).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json } from '../../src/http/json';
import type { RouteDef } from '../../src/http/types';
import {
  ALICE,
  BOB,
  CAROL,
  closeHarnesses,
  control,
  type Harness,
  type HttpResult,
  harness,
  ingestFixture,
  kitControl,
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
/** The `_headers` rules scripts/gen-config.ts writes, reduced to what these assertions read. */
const HEADERS_FILE = [
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '/',
  '  Cache-Control: no-cache',
  '',
].join('\n');

function dist(index: boolean): Record<string, string> {
  return {
    ...(index ? { 'index.html': INDEX_HTML } : {}),
    'assets/app-3f9a1c2e.js': APP_JS,
    _headers: HEADERS_FILE,
  };
}

/** A test route (mounted through compose's features) that reports what a handler sees. */
const ECHO: RouteDef = {
  method: 'GET',
  pattern: '/api/test/echo',
  async handler(req, ctx) {
    return json({ clientIp: ctx.clientIp, peer: ctx.peer, headers: Object.fromEntries(req.headers) });
  },
};

function expectEnvelope(r: HttpResult, status: number, code: string) {
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
  afterEach(closeHarnesses);

  it('every API.md v1.1 route dispatches; unknown /api/x → JSON 404; non-API path → ASSETS', async () => {
    const kit = await kitControl();
    const h = await harness('routing', { dist: dist(true) });
    const seed = await ingestFixture(h, kit);
    expect({
      users: h.db.all<{ did: string; active: number }>('SELECT did, active FROM users ORDER BY did'),
      scrobbles: h.db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')?.n,
      follows: h.db.all<{ actor: string; subject: string }>('SELECT actor, subject FROM follows'),
    }).toEqual({
      users: [
        { did: ALICE, active: 1 },
        { did: BOB, active: 1 },
        { did: CAROL, active: 1 },
      ],
      scrobbles: 9, // r01–r10 without the deleted r08
      follows: [{ actor: ALICE, subject: BOB }],
    });

    kit.resetCalls();
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
    const notified = await h.postJson('/api/v1/notify', { uri: uriOf(ALICE, 'r07') }, { ip: '198.51.100.2' });
    expect(notified.status).toBe(202);
    expect(schema('NotifyAccepted', notified.body)).toBe('valid');
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: uriOf(ALICE, 'r07'), source: 'notify' }]);

    // /health/live is answered by the process alone: not one statement reaches the database.
    const live = await h.record(() => h.request('/health/live'));
    expect(live.result.status).toBe(200);
    expect(schema('Live', live.result.body)).toBe('valid');
    expect(live.result.body).toEqual({ status: 'live' });
    expect(live.statements).toEqual([]);

    // Unknown router paths: the JSON 404 envelope, never the SPA's index.html.
    const unrouted = await h.record(async () => {
      for (const path of [
        '/api/x',
        '/api/v1/nope',
        `/api/v1/users/${ALICE}/nope`,
        '/health/x',
        '/internal/x',
        '/api',
        // /oauth/ is a router prefix on the Node host (ADR 0005 §3.7): no SPA fallback.
        '/oauth/callback?code=x&state=y',
      ]) {
        const r = await h.request(path);
        expectEnvelope(r, 404, 'not_found');
        expect(r.text.includes('<div id="app">')).toBe(false);
      }
      // An encoded traversal stays inside its segment: the route rejects it, the static server never sees it.
      const traversal = await h.request('/api/v1/scrobbles/..%2F..%2Fassets%2Fapp-3f9a1c2e.js');
      expectEnvelope(traversal, 422, 'validation_failed');
      const wrongMethod = await h.request('/api/v1/meta', { method: 'POST' });
      expectEnvelope(wrongMethod, 405, 'method_not_allowed');
      // The Node dispatcher adds HEAD to its own 405 when GET is registered.
      expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD');
    });
    // The validation and routing answers never read the index.
    expect(unrouted.statements).toEqual([]);

    // Everything else is the SPA's: files from web/dist, index.html for SPA routes.
    for (const path of ['/', '/feed']) {
      const r = await h.request(path);
      expect([path, r.status, r.text]).toEqual([path, 200, INDEX_HTML]);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
    const js = await h.request('/assets/app-3f9a1c2e.js');
    expect([js.status, js.text, js.headers.get('content-type')]).toEqual([
      200,
      APP_JS,
      'text/javascript; charset=utf-8',
    ]);
    expectEnvelope(await h.request('/assets/missing.js'), 404, 'not_found');
  });

  it('inbound x-atmusic-client-ip is stripped and CF-Connecting-IP used', async () => {
    const h = await harness('client-ip', { features: [{ name: 'echo', routes: [ECHO] }] });
    expect(h.config.clientIpHeader).toBe('cf-connecting-ip');
    const notifyFrom = (ip: string, spoofed: string, rkey: string) =>
      h.postJson('/api/v1/notify', { uri: uriOf(CAROL, rkey) }, { ip, headers: { 'x-atmusic-client-ip': spoofed } });

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
    const hints = h.db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri');
    expect(hints).toHaveLength(61);
    expect(hints.map((r) => r.uri)).not.toContain(uriOf(CAROL, 'r999'));
    expect(hints.map((r) => r.uri)).toContain(uriOf(CAROL, 'r998'));

    // What a handler sees: no x-atmusic-* header at all, and the client IP from CF-Connecting-IP.
    const echo = await h.request('/api/test/echo', {
      ip: '203.0.113.9',
      headers: { 'x-atmusic-client-ip': '10.0.0.1', 'X-Atmusic-Admin': 'yes', accept: 'text/html' },
    });
    expect(echo.status).toBe(200);
    const seen = echo.body as { clientIp: string; peer: string; headers: Record<string, string> };
    expect(Object.keys(seen.headers).filter((k) => k.startsWith('x-atmusic-'))).toEqual([]);
    expect(seen.clientIp).toBe('203.0.113.9');
    expect(seen.peer).toBe('127.0.0.1');
    expect(seen.headers['cf-connecting-ip']).toBe('203.0.113.9');
    expect(seen.headers.accept).toBe('text/html');
    // Without the header the trusted loopback peer itself is the client.
    const bare = await h.request('/api/test/echo');
    expect((bare.body as { clientIp: string }).clientIp).toBe('127.0.0.1');
  });

  it('forced storage error → 500 envelope with UUID requestId and no stack trace or file path', async () => {
    const h = await harness('storage-error');
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
    // The log names the failure by error name only.
    const logged = JSON.stringify(h.log.logs);
    expect(logged).not.toContain('SQLITE_IOERR');
    expect(logged).not.toContain('/srv/');

    // The fault is gone and the storage untouched: the same request succeeds.
    const again = await h.request(`/api/v1/users/${ALICE}/scrobbles`);
    expect(again.status).toBe(200);
    expect(schema('ScrobblePage', again.body)).toBe('valid');
    expect(again.headers.get('x-request-id')).not.toBe(failed.headers.get('x-request-id'));
  });

  it('asset miss: SPA route GET/HEAD serves index.html 200, every other miss is JSON not_found with x-request-id', async () => {
    const h = await harness('asset-miss', { dist: dist(true) });
    const PLC = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    const WEB = 'did:web:music.example.test';
    const recording = h.startRecording();

    // An existing file is the static server's answer (headers from _headers).
    const js = await h.request('/assets/app-3f9a1c2e.js');
    expect([js.status, js.text, js.headers.get('cache-control')]).toEqual([
      200,
      APP_JS,
      'public, max-age=31536000, immutable',
    ]);
    const root = await h.request('/');
    expect([root.status, root.text, root.headers.get('cache-control')]).toEqual([200, INDEX_HTML, 'no-cache']);
    // index.html itself is served only at `/`.
    const named = await h.request('/index.html?x=1');
    expect([named.status, named.headers.get('location')]).toEqual([301, '/?x=1']);

    // Every SPA route of the shared table, raw and percent-encoded DIDs alike:
    // index.html with the same method, as a 200 with no redirect.
    const spaPaths = [
      '/feed',
      '/feed/',
      '/signin',
      '/scrobble',
      '/settings',
      `/u/${PLC}`,
      `/u/${PLC}?tab=history`,
      `/u/${encodeURIComponent(PLC)}`,
      `/u/${WEB}`,
      `/u/${encodeURIComponent(WEB)}`,
    ] as const;
    for (const path of spaPaths) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await h.request(path, { method, headers: { accept: 'text/html' } });
        const label = `${method} ${path}`;
        expect([label, r.status], label).toEqual([label, 200]);
        expect(r.headers.get('content-type'), label).toBe('text/html; charset=utf-8');
        expect(r.headers.get('cache-control'), label).toBe('no-cache');
        expect(r.headers.get('location'), label).toBeNull();
        expect(r.headers.get('x-request-id'), label).toMatch(UUID);
        expect(r.text, label).toBe(method === 'GET' ? INDEX_HTML : '');
      }
    }

    // Every other miss: the JSON envelope, and never index.html.
    const misses = [
      '/assets/missing.js',
      '/assets/app-3f9a1c2e.js.map',
      '/unknown',
      '/unknown/api',
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
      // Static Assets configuration files are never served.
      '/_headers',
    ];
    for (const path of misses) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await h.request(path, { method });
        const label = `${method} ${path}`;
        if (method === 'GET') {
          expectEnvelope(r, 404, 'not_found');
        } else {
          expect([label, r.status, r.headers.get('content-type')]).toEqual([label, 404, 'application/json']);
          expect(r.headers.get('x-request-id'), label).toMatch(UUID);
          expect(r.text, label).toBe('');
        }
        expect(r.text.includes('<div id="app">'), label).toBe(false);
      }
    }

    // Traversal and encoding tricks (the oracle's asset_missing_traversal inputs
    // and safe_path rules), judged on the raw request target: the envelope,
    // never index.html.
    for (const path of [
      '/assets%2f..%2fsecret',
      '/assets/%252e%252e/secret',
      '/u/did%3Aplc%3Aa%2Fb',
      `/u/${encodeURIComponent(PLC)}%5C`,
      '/u/%00',
      '/u/%ff',
      '/u/%zz',
      '/feed%',
      '/feed%2',
      '/%2e%2e/secret',
      '/assets/%2E%2E/secret',
      '/u/%2e%2e/secret',
      '/u/a\\b',
      '/assets/../index.html',
    ]) {
      const r = await h.request(path);
      expectEnvelope(r, 404, 'not_found');
      expect([path, r.text.includes('<div id="app">')]).toEqual([path, false]);
    }

    // A non-GET/HEAD to an SPA path with no file behind it: the envelope, never 405 and never index.html.
    for (const [method, path] of [
      ['POST', '/feed'],
      ['POST', `/u/${PLC}`],
      ['POST', `/u/${encodeURIComponent(PLC)}`],
      ['DELETE', '/settings'],
      ['OPTIONS', '/feed'],
    ] as const) {
      const r = await h.request(path, {
        method,
        ...(method === 'OPTIONS' ? {} : { body: '{"x":1}', headers: { 'content-type': 'application/json' } }),
      });
      expectEnvelope(r, 404, 'not_found');
      expect(r.headers.get('allow'), `${method} ${path}`).toBeNull();
    }
    // A non-GET/HEAD to an existing file (`/` is index.html, a hashed asset) is
    // the static server's 405 envelope with Allow: GET, HEAD (ADR 0005 §3.7);
    // on Workers the platform answered it before the Worker ran.
    for (const [method, path] of [
      ['PATCH', '/'],
      ['POST', '/assets/app-3f9a1c2e.js'],
    ] as const) {
      const r = await h.request(path, { method, body: '{"x":1}', headers: { 'content-type': 'application/json' } });
      expectEnvelope(r, 405, 'method_not_allowed');
      expect(r.headers.get('allow'), `${method} ${path}`).toBe('GET, HEAD');
      expect(r.text.includes('<div id="app">')).toBe(false);
    }

    // Spoofed internal headers change nothing about the SPA answer.
    const spoofed = await h.request(`/u/${PLC}`, {
      ip: '203.0.113.9',
      headers: { 'x-atmusic-client-ip': '10.0.0.1', 'X-Atmusic-Admin': 'yes', accept: 'text/html' },
    });
    expect([spoofed.status, spoofed.text]).toEqual([200, INDEX_HTML]);

    // The router prefixes are unchanged: the envelope, whatever dist holds.
    for (const path of ['/api/x', '/health/x', '/internal/x']) expectEnvelope(await h.request(path), 404, 'not_found');
    // Asset misses never touch the index: not one statement reached the database.
    expect(h.stopRecording()).toEqual([]);
    expect(recording).toEqual([]);

    // index.html missing from dist: the envelope for an SPA route, never a 3xx, and the miss is logged.
    const broken: Harness = await harness('asset-miss-no-index', { dist: dist(false) });
    const r = await broken.request('/feed');
    expectEnvelope(r, 404, 'not_found');
    expect(r.headers.get('location')).toBeNull();
    expect(broken.log.logs.filter((l) => l.event === 'assets.index_unavailable')).toEqual([
      expect.objectContaining({ level: 'error', status: 404 }),
    ]);
    expect((await broken.request('/assets/app-3f9a1c2e.js')).status).toBe(200);
  });
});
