// W5-01 worker/src/router.ts + worker/src/index.ts composition: the production
// Worker fetch over the real IndexDO (JS RPC, DO SQLite, alarm-driven
// ingestion of read_models.json from real signed repositories).
// Proves M1.2.3/packaged_http, M1.4.2/safe_errors (with error.test.ts),
// M6.1.1/asset_missing_traversal (Worker side), M6.1.2/untrusted_forwarded and
// M6.2.1/bounded_state (client-IP keying).

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
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
});
