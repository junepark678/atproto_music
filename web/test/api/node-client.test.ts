import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const uri = `at://${did}/com.example.atmusic.scrobble/r01`;
const operation = {
  id: 'op-1',
  kind: 'scrobble.create',
  origin: 'web',
  state: 'queued',
  attempts: 0,
  createdAt: '2026-01-15T12:00:00Z',
  updatedAt: '2026-01-15T12:00:00Z',
};

describe('Node v1.2 API client methods', () => {
  it('matches the session, write, operation and logout routes and headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new ApiClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/api/v1/auth/session'))
          return Response.json({
            did,
            handle: 'alice.test',
            username: 'alice',
            csrfToken: 'csrf',
            status: 'active',
            expiresAt: '2026-12-01T00:00:00Z',
          });
        if (url.endsWith('/api/v1/auth/start'))
          return Response.json({ authorizeUrl: 'https://as.test/oauth/authorize' });
        if (url.endsWith('/api/v1/auth/logout')) return new Response(null, { status: 204 });
        if (url.endsWith('/api/v1/operations/op-1')) return Response.json(operation);
        return Response.json({ operation }, { status: 202 });
      },
    });
    await client.authSession();
    await client.authStart('alice.test');
    await client.createScrobble(
      { artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' },
      'csrf',
      'key-1',
      did,
    );
    await client.deleteScrobble(uri, 'csrf', 'key-2', did);
    await client.follow(did, 'csrf', 'key-3', did);
    await client.unfollow(did, 'csrf', 'key-4', did);
    await client.setIndexing('disabled', 'csrf', 'key-5', did);
    await client.operation('op-1');
    await client.authLogout('csrf', did);
    expect(calls.map(({ url, init }) => `${init.method} ${new URL(url, 'https://music.test').pathname}`)).toEqual([
      'GET /api/v1/auth/session',
      'POST /api/v1/auth/start',
      'POST /api/v1/scrobbles',
      `DELETE /api/v1/scrobbles/${encodeURIComponent(uri)}`,
      `PUT /api/v1/follows/${did}`,
      `DELETE /api/v1/follows/${did}`,
      'PUT /api/v1/account/indexing',
      'GET /api/v1/operations/op-1',
      'POST /api/v1/auth/logout',
    ]);
    for (const call of calls.filter(({ init }) => ['POST', 'PUT', 'DELETE'].includes(init.method ?? ''))) {
      const headers = new Headers(call.init.headers);
      if (!call.url.endsWith('/api/v1/auth/start')) expect(headers.get('X-CSRF-Token')).toBe('csrf');
      if (headers.has('Idempotency-Key')) expect(headers.get('Idempotency-Key')).toMatch(/^key-/);
      expect(call.init.credentials).toBe('same-origin');
    }
  });

  it('passes the initiating account DID through the default session transport', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === '/api/v1/auth/session')
        return Response.json({
          did,
          handle: 'alice.test',
          username: 'alice',
          csrfToken: 'live-csrf',
          status: 'active',
          expiresAt: '2026-12-01T00:00:00Z',
        });
      return Response.json({ operation }, { status: 202 });
    });
    try {
      const client = new ApiClient();
      await client.createScrobble({ artist: 'Artist', track: 'Track' }, 'stale-csrf', 'key-1', did);
      expect(calls.map(({ url }) => url)).toEqual(['/api/v1/auth/session', '/api/v1/scrobbles']);
      expect(new Headers(calls[1]?.init?.headers).get('X-CSRF-Token')).toBe('live-csrf');
      expect(calls[1]?.init?.credentials).toBe('same-origin');
    } finally {
      fetcher.mockRestore();
    }
  });
});
