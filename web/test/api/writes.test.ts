import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWriteIntent, writes } from '../../src/api/writes';
import type { Session } from '../../src/session/client';

const session: Session = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

describe('server writes', () => {
  it('reuses one Idempotency-Key for a retried intent and receives Retry-After on rate limiting', async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      calls++;
      if (String(_input).endsWith('/api/v1/auth/session')) return Response.json(session);
      keys.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
      if (calls === 2)
        return Response.json(
          { error: { code: 'rate_limited', message: 'slow down', requestId: 'r1' } },
          { status: 429, headers: { 'retry-after': '30' } },
        );
      return Response.json(
        {
          operation: {
            id: 'op-1',
            kind: 'scrobble.create',
            origin: 'web',
            state: 'queued',
            attempts: 0,
            createdAt: '2026-01-15T12:00:00Z',
            updatedAt: '2026-01-15T12:00:00Z',
          },
        },
        { status: 202 },
      );
    });
    const intent = createWriteIntent('same-scrobble-intent');
    const body = { artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' };
    await expect(writes.scrobble(body, intent)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfter: '30',
    });
    await writes.scrobble(body, intent);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
