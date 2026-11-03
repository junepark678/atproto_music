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

  it('keeps the reauthentication notice through an anonymous refresh and clears it after the cookie session returns', async () => {
    const changed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(dto));
    const client = new SessionClient({ fetch: fetcher, onChange: changed });
    client.unauthorized();
    await expect(client.getSession()).resolves.toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null, true);

    await expect(client.refresh()).resolves.toEqual(dto);
    expect(changed).toHaveBeenLastCalledWith(dto, false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale refresh response when a newer refresh has restored the active session', async () => {
    let resolveInitial!: (response: Response) => void;
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveInitial = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveNewer = resolve)));
    const changed: Array<Session | null> = [];
    const client = new SessionClient({ fetch: fetcher, onChange: (session) => changed.push(session) });
    const initial = client.getSession();
    resolveInitial(Response.json(dto));
    await initial;

    const older = client.refresh();
    const newer = client.refresh();
    resolveNewer(Response.json({ ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' }));
    await expect(newer).resolves.toMatchObject({ did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' });
    resolveOlder(new Response(null, { status: 401 }));
    await expect(older).resolves.toMatchObject({ did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' });

    expect(client.current()?.did).toBe('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(changed.at(-1)?.did).toBe('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('ignores a stale session body that finishes parsing after a newer refresh', async () => {
    let resolveInitial!: (response: Response) => void;
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    let resolveOlderJson!: (value: Session) => void;
    const olderJson = new Promise<Session>((resolve) => (resolveOlderJson = resolve));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveInitial = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveNewer = resolve)));
    const client = new SessionClient({ fetch: fetcher });
    const initial = client.getSession();
    resolveInitial(Response.json(dto));
    await initial;

    const older = client.refresh();
    let jsonStarted!: () => void;
    const started = new Promise<void>((resolve) => (jsonStarted = resolve));
    resolveOlder({
      status: 200,
      ok: true,
      json: () => {
        jsonStarted();
        return olderJson;
      },
    } as Response);
    await started;
    const newer = client.refresh();
    resolveNewer(Response.json({ ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' }));
    await newer;
    resolveOlderJson(dto);
    await older;

    expect(client.current()?.did).toBe('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('refuses to send a stale account write with a newly resolved account CSRF token', async () => {
    const other = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(other));
    const client = new SessionClient({ fetch: fetcher });

    await expect(client.mutate('/api/v1/scrobbles', { method: 'POST', body: '{}' }, dto.did)).rejects.toThrow(
      'The signed-in account changed. Reload before continuing.',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('/api/v1/auth/session');
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
    expect(state.scrobbleDraft.value).toEqual({ did: dto.did, revision: 1, values });

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
