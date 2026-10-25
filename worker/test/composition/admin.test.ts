// W5-01 worker/src/http/admin.ts through the production Worker and the real
// IndexDO. Proves M6.2.2/metrics_auth (A16: metrics are /internal/admin/status).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../src/do/schema';
import {
  ADMIN_TOKEN,
  BOB,
  constructed,
  control,
  type Harness,
  harness,
  inDo,
  postJson,
  resetControl,
  schema,
  UUID,
} from './support';

const T0 = Date.parse('2026-01-15T12:00:00Z');

const ADMIN_ROUTES: Array<[method: 'GET' | 'POST', path: string, body?: unknown]> = [
  ['GET', '/internal/admin/status'],
  ['POST', '/internal/admin/pitr', { atMs: T0 - 60_000 }],
  ['POST', '/internal/admin/resnapshot', { did: BOB }],
];

function call(h: Harness, method: 'GET' | 'POST', path: string, body?: unknown, authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (method === 'POST') return postJson(h, path, body ?? {}, { headers });
  return h.request(path, { headers });
}

function errorOf(body: unknown) {
  return (body as { error: { code: string; message: string; requestId: string } }).error;
}

describe('worker/src/http/admin.ts', () => {
  beforeEach(() => {
    resetControl();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('admin routes 404 without ADMIN_TOKEN; wrong token 401 constant-time; status JSON shape', async () => {
    // Disabled: every admin route (and every method on it) is the unknown-path 404,
    // even with a bearer token; the IndexDO is never reached.
    for (const token of [undefined, '', 'short-token']) {
      const off = harness('admin-off', token === undefined ? {} : { ADMIN_TOKEN: token });
      for (const [method, path, body] of ADMIN_ROUTES) {
        for (const auth of [undefined, `Bearer ${ADMIN_TOKEN}`, `Bearer ${token ?? ''}`]) {
          const r = await call(off, method, path, body, auth);
          expect([path, r.status, errorOf(r.body).code]).toEqual([path, 404, 'not_found']);
          expect(schema('Error', r.body)).toBe('valid');
        }
      }
      const wrongMethod = await off.request('/internal/admin/pitr');
      expect(wrongMethod.status).toBe(404);
      expect(constructed(off.stub)).toBe(0);
    }

    resetControl({ env: { ADMIN_TOKEN } });
    const h = harness('admin-on', { ADMIN_TOKEN });

    // Enabled, but no bearer token (or another scheme): still the plain 404.
    for (const auth of [undefined, '', `Basic ${btoa(`admin:${ADMIN_TOKEN}`)}`, 'Bearer', ADMIN_TOKEN]) {
      for (const [method, path, body] of ADMIN_ROUTES) {
        const r = await call(h, method, path, body, auth);
        expect([path, auth, r.status]).toEqual([path, auth, 404]);
      }
    }
    expect(constructed(h.stub)).toBe(0);

    // A wrong bearer token is 401, whatever its length or shared prefix, with the same
    // work: one timingSafeEqual over two 32-byte SHA-256 digests per request.
    const timingSafeEqual = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    const wrong = [
      'x'.repeat(ADMIN_TOKEN.length),
      ADMIN_TOKEN.slice(0, -1),
      `${ADMIN_TOKEN}x`,
      `${ADMIN_TOKEN.slice(0, -1)}${ADMIN_TOKEN.endsWith('f') ? 'e' : 'f'}`,
      'a',
      'z'.repeat(4096),
    ];
    const bodies = new Set<string>();
    for (const token of wrong) {
      for (const [method, path, body] of ADMIN_ROUTES) {
        timingSafeEqual.mockClear();
        const r = await call(h, method, path, body, `Bearer ${token}`);
        expect([token.length, path, r.status]).toEqual([token.length, path, 401]);
        expect(schema('Error', r.body)).toBe('valid');
        expect(r.headers.get('www-authenticate')).toBe('Bearer');
        const error = errorOf(r.body);
        expect(error.code).toBe('unauthorized');
        expect(error.requestId).toMatch(UUID);
        if (token.length >= 8) expect(r.text).not.toContain(token);
        expect(r.text).not.toContain(ADMIN_TOKEN);
        bodies.add(JSON.stringify({ ...error, requestId: null }));
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
        const [a, b] = timingSafeEqual.mock.calls[0] as [ArrayBuffer, ArrayBuffer];
        expect([a.byteLength, b.byteLength]).toEqual([32, 32]);
      }
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ code: 'unauthorized', message: 'A valid bearer token is required.', requestId: null }),
    ]);
    // Rejected requests never reached the IndexDO.
    expect(constructed(h.stub)).toBe(0);
    timingSafeEqual.mockRestore();

    // The right token: GET status, with the exact AdminStatus shape of a fresh index.
    const auth = `Bearer ${ADMIN_TOKEN}`;
    const fresh = await call(h, 'GET', '/internal/admin/status', undefined, auth);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('cache-control')).toBe('no-store');
    expect(fresh.headers.get('x-request-id')).toMatch(UUID);
    expect(fresh.body).toEqual({
      schema: { status: 'ready', version: SCHEMA_VERSION },
      indexing: { state: 'stale', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
      ingest: {
        mode: 'off',
        cursor: null,
        lastEventTimeUs: null,
        connected: false,
        pendingGap: true,
        hostIndex: 0,
      },
      hints: { total: 0, due: 0 },
      jobs: { snapshot: {}, status: {}, identity: {} },
      counters: [],
    });
    expect(schema('Indexing', (fresh.body as { indexing: unknown }).indexing)).toBe('valid');
    expect(fresh.text).not.toContain(ADMIN_TOKEN);

    // Work shows up: an admitted DID, its snapshot job and the counters.
    expect((await postJson(h, '/api/v1/notify', { did: BOB }, { ip: '198.51.100.5' })).status).toBe(202);
    const busy = await call(h, 'GET', '/internal/admin/status', undefined, auth);
    expect(busy.body).toMatchObject({
      jobs: { snapshot: { pending: 1 }, status: {}, identity: {} },
      counters: [{ name: 'admitted', label: 'notify', value: 1 }],
    });

    // POST resnapshot: strict body, then the DO's scheduling outcome.
    const badBody = await call(h, 'POST', '/internal/admin/resnapshot', { did: BOB, extra: 1 }, auth);
    expect([badBody.status, errorOf(badBody.body).code]).toEqual([422, 'validation_failed']);
    const badDid = await call(h, 'POST', '/internal/admin/resnapshot', { did: 'nope' }, auth);
    expect(badDid.status).toBe(422);
    expect((badDid.body as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty('did');
    const unknown = await call(
      h,
      'POST',
      '/internal/admin/resnapshot',
      { did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' },
      auth,
    );
    expect(unknown.status).toBe(404);
    const again = await call(h, 'POST', '/internal/admin/resnapshot', { did: BOB }, auth);
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ did: BOB, status: 'already' });
    expect(await inDo(h.stub, (_i, db) => db.all("SELECT did, state FROM repo_jobs WHERE kind = 'snapshot'"))).toEqual([
      { did: BOB, state: 'pending' },
    ]);

    // POST pitr: atMs must be integer epoch ms within the last 30 days.
    const now = control.clock.nowMs();
    for (const atMs of [now + 1, now - 30 * 86_400_000 - 1, 1.5, '1768478400000', null]) {
      const r = await call(h, 'POST', '/internal/admin/pitr', { atMs }, auth);
      expect([atMs, r.status]).toEqual([atMs, 422]);
      expect((r.body as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty('atMs');
    }
    // workerd's local storage has no point-in-time recovery: the restore cannot be
    // scheduled, the failure is a generic 500 (nothing of the platform message), and
    // the IndexDO is not restarted.
    const before = constructed(h.stub);
    const pitr = await call(h, 'POST', '/internal/admin/pitr', { atMs: now - 60_000 }, auth);
    expect([pitr.status, errorOf(pitr.body).code]).toEqual([500, 'internal_error']);
    expect(pitr.text).not.toContain('point-in-time');
    const ready = await h.request('/health/ready');
    expect(ready.status).toBe(200);
    expect(constructed(h.stub)).toBe(before);
  });
});
