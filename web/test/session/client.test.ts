import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFetch, SessionClient } from '../../src/session/client';

afterEach(() => vi.restoreAllMocks());
describe('session client', () => {
  it('bootstraps session before mutation and sends CSRF token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ did: 'did:plc:x', handle: 'x.test', username: 'x', csrfToken: 'token', status: 'active', expiresAt: 'later' })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new SessionClient({ fetch: fetcher });
    await client.mutate('/api/v1/write', { method: 'POST' });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/auth/session');
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('X-CSRF-Token')).toBe('token');
    expect(fetcher.mock.calls[1]![1]?.credentials).toBe('same-origin');
  });
  it('uses GET fetch with same-origin credentials and clears on 401', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const response = await sessionFetch('/api/v1/me');
    expect(response.status).toBe(401);
    expect(fetcher.mock.calls[0]![1]?.credentials).toBe('same-origin');
  });
});
