import { describe, expect, it, vi } from 'vitest';
import { type Session, SessionClient, sessionFetch } from '../../src/session/client';
import { createAppState, setScrobbleDraft, setSession } from '../../src/state/store';

const sources = import.meta.glob<string>('../../src/**/*.{ts,tsx,js,jsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const dto: Session = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf-123',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};

describe('web/test/session/client.test.ts', () => {
  it('getSession caches csrfToken; every mutation sends X-CSRF-Token with same-origin credentials; 401 shows signed-out and reauth_required shows the re-sign-in banner', async () => {
    const changed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new SessionClient({ fetch: fetcher, onChange: changed });
    await client.getSession();
    const mutation = await client.mutate('/api/v1/write', { method: 'POST' });
    expect(mutation.status).toBe(204);
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(dto.csrfToken);
    expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
    const unauthorized = await client.mutate('/api/v1/write', { method: 'POST' });
    expect(unauthorized.status).toBe(401);
    expect(client.current()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null, true);

    const anonymous = new SessionClient({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      onChange: changed,
    });
    await expect(anonymous.getSession()).resolves.toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null, false);
  });

  it('accepts the HTTP 200 reauth_required DTO with a nullable handle and keeps CSRF usable', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    const changed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(reauth))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new SessionClient({ fetch: fetcher, onChange: changed });
    await expect(client.getSession()).resolves.toEqual(reauth);
    expect(client.current()).toEqual(reauth);
    expect(changed).toHaveBeenLastCalledWith(reauth, true);
    expect((await client.mutate('/api/v1/write', { method: 'POST' })).status).toBe(204);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(reauth.csrfToken);
  });

  it('preserves a scrobble draft only through same-account reauthentication', () => {
    const state = createAppState();
    setSession(state, dto);
    const values = {
      artist: 'Draft Artist',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    setScrobbleDraft(state, values);
    setSession(state, null, null, { reauthRequired: true });
    expect(state.scrobbleDraft.value).toEqual({ did: dto.did, values });

    const other = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'] };
    setSession(state, other);
    expect(state.scrobbleDraft.value).toBeNull();
    setScrobbleDraft(state, values);
    setSession(state, null);
    expect(state.scrobbleDraft.value).toBeNull();
  });

  it('the app state store holds the server Session DTO, and no module under web/src imports from web/src/oauth', async () => {
    const state = createAppState();
    setSession(state, dto);
    expect(state.session.value).toEqual(dto);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));
    await sessionFetch('/api/v1/operations/op-1');
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');

    const importPattern = /\b(?:from\s+|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? '';
        if (specifier.split('/').includes('oauth')) offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
