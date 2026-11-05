import { describe, expect, it, vi } from 'vitest';
import { bootstrapSession } from '../../src/session/bootstrap';
import { type Session, SessionClient, sessionClient, sessionFetch } from '../../src/session/client';
import { finishReauthPopup, listenForSessionReady, REAUTH_POPUP_MARKER } from '../../src/session/reauth-channel';
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
  it('only announces and closes the marked reauthentication popup, not a normal bootstrap', () => {
    const announce = vi.fn();
    const close = vi.fn();
    sessionStorage.removeItem(REAUTH_POPUP_MARKER);
    expect(finishReauthPopup(sessionStorage, announce, close)).toBe(false);
    expect(announce).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    sessionStorage.setItem(REAUTH_POPUP_MARKER, '1');
    expect(finishReauthPopup(sessionStorage, announce, close)).toBe(true);
    expect(announce).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(REAUTH_POPUP_MARKER)).toBeNull();
    expect(finishReauthPopup(sessionStorage, announce, close)).toBe(false);
  });

  it('restores only the same account draft after the app state is recreated', () => {
    sessionStorage.removeItem('atmusic:scrobble-draft');
    const values = {
      artist: 'Draft Artist',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    const firstApp = createAppState();
    setSession(firstApp, dto);
    setScrobbleDraft(firstApp, values);
    expect(sessionStorage.getItem('atmusic:scrobble-draft')).toContain('Draft Artist');
    expect(sessionStorage.getItem('atmusic:scrobble-draft')).not.toContain(dto.csrfToken);

    const reloadedApp = createAppState();
    setSession(reloadedApp, dto);
    expect(reloadedApp.scrobbleDraft.value).toEqual({
      did: dto.did,
      revision: 1,
      values,
    });

    const other = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'] };
    const otherApp = createAppState();
    setSession(otherApp, other);
    expect(otherApp.scrobbleDraft.value).toBeNull();
    expect(sessionStorage.getItem('atmusic:scrobble-draft')).toBeNull();
  });

  it('keeps the reauthentication flag when the initial bootstrap restores an expired session', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    const state = createAppState();
    const client = new SessionClient({ fetch: vi.fn().mockResolvedValue(Response.json(reauth)) });

    await expect(
      bootstrapSession(client, (session, reauthRequired, kind) =>
        setSession(state, session, null, { reauthRequired, kind }),
      ),
    ).resolves.toEqual(reauth);

    expect(state.session.value).toEqual(reauth);
    expect(state.reauthRequired.value).toBe(true);
  });

  it('getSession caches csrfToken; every mutation sends X-CSRF-Token with same-origin credentials; 401 shows signed-out and reauth_required shows the re-sign-in banner', async () => {
    const changed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new SessionClient({ fetch: fetcher, onChange: changed });
    await client.getSession();
    const mutation = await client.mutate('/api/v1/write', { method: 'POST' }, dto.did);
    expect(mutation.status).toBe(204);
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(dto.csrfToken);
    expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
    const unauthorized = await client.mutate('/api/v1/write', { method: 'POST' }, dto.did);
    expect(unauthorized.status).toBe(401);
    expect(client.current()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null, true, 'reauth_required');

    const anonymous = new SessionClient({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      onChange: changed,
    });
    await expect(anonymous.getSession()).resolves.toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null, false, 'anonymous');
  });

  it('coalesces concurrent mutation session reads so every caller uses the resolved session', async () => {
    let resolveSession!: (response: Response) => void;
    const pendingSession = new Promise<Response>((resolve) => (resolveSession = resolve));
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/auth/session') return pendingSession;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = new SessionClient({ fetch: fetcher });

    const first = client.mutate('/api/v1/write/first', { method: 'POST' }, dto.did);
    const second = client.mutate('/api/v1/write/second', { method: 'POST' }, dto.did);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveSession(Response.json(dto));
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual([204, 204]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
      '/api/v1/write/first',
      '/api/v1/write/second',
    ]);
  });

  it('makes superseded session-read callers await the replacement read', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstRead = new Promise<Response>((resolve) => (resolveFirst = resolve));
    const secondRead = new Promise<Response>((resolve) => (resolveSecond = resolve));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => firstRead)
      .mockImplementationOnce(() => secondRead)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new SessionClient({ fetch: fetcher });

    const mutation = client.mutate('/api/v1/write', { method: 'POST' }, dto.did);
    const refresh = client.refresh();
    resolveFirst(Response.json(dto));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveSecond(Response.json(dto));
    await expect(refresh).resolves.toEqual(dto);
    await expect(mutation).resolves.toMatchObject({ status: 204 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('accepts reauth_required DTOs but blocks writes except sign-out', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    const changed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(reauth))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new SessionClient({ fetch: fetcher, onChange: changed });
    await expect(client.getSession()).resolves.toEqual(reauth);
    expect(client.current()).toEqual(reauth);
    expect(changed).toHaveBeenLastCalledWith(reauth, true, 'reauth_required');
    await expect(client.mutate('/api/v1/write', { method: 'POST' }, reauth.did)).rejects.toThrow(
      'Sign in again before making changes.',
    );
    await client.logout();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('/api/v1/auth/logout');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(reauth.csrfToken);
    expect(String(fetcher.mock.calls[2]?.[0])).toBe('/api/v1/auth/session');
  });

  it('clears the reauth flag and draft when sign-out is confirmed during a pending refresh', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    let resolveLogout!: (response: Response) => void;
    const pendingLogout = new Promise<Response>((resolve) => (resolveLogout = resolve));
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => (resolveRefresh = resolve));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(reauth))
      .mockImplementationOnce(() => pendingLogout)
      .mockImplementationOnce(() => pendingRefresh)
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const state = createAppState();
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();
    const values = {
      artist: 'Draft Artist',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    setScrobbleDraft(state, values);
    const logout = client.logout();
    const refresh = client.refresh();
    resolveLogout(new Response(null, { status: 204 }));
    await logout;
    resolveRefresh(new Response(null, { status: 401 }));
    await expect(refresh).resolves.toBeNull();
    expect(state.session.value).toBeNull();
    expect(state.reauthRequired.value).toBe(false);
    expect(state.scrobbleDraft.value).toBeNull();
  });

  it('clears reauthentication state after logout returns 401', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    const state = createAppState();
    const values = {
      artist: 'Draft Artist',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(reauth))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();
    setScrobbleDraft(state, values);

    await client.logout();

    expect(state.session.value).toBeNull();
    expect(state.reauthRequired.value).toBe(false);
    expect(state.scrobbleDraft.value).toBeNull();
    expect(sessionStorage.getItem('atmusic:scrobble-draft')).toBeNull();
  });

  it('does not keep the published session when logout reconciliation fails', async () => {
    const state = createAppState();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new TypeError('offline'));
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();

    await expect(client.logout()).resolves.toBeUndefined();

    expect(client.current()).toBeNull();
    expect(state.session.value).toBeNull();
    expect(state.reauthRequired.value).toBe(false);
  });

  it('refreshes a cached expired session on focus when BroadcastChannel is unavailable', async () => {
    const reauth = { ...dto, handle: null, status: 'reauth_required' as const };
    const client = new SessionClient({ fetch: vi.fn().mockResolvedValue(Response.json(reauth)) });
    await client.getSession();
    vi.stubGlobal('BroadcastChannel', undefined);
    const refresh = vi.spyOn(client, 'refresh').mockResolvedValue(dto);
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const stop = listenForSessionReady(client);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    stop();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    vi.unstubAllGlobals();
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
    expect(changed).toHaveBeenLastCalledWith(null, true, 'reauth_required');

    await expect(client.refresh()).resolves.toEqual(dto);
    expect(changed).toHaveBeenLastCalledWith(dto, false, 'authenticated');
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

  it('does not let a mutation 401 from the previous account clear a newer session', async () => {
    let resolveWrite!: (response: Response) => void;
    const pendingWrite = new Promise<Response>((resolve) => (resolveWrite = resolve));
    const bob = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockImplementationOnce(() => pendingWrite)
      .mockResolvedValueOnce(Response.json(bob));
    const client = new SessionClient({ fetch: fetcher });
    await client.getSession();
    const write = client.mutate('/api/v1/write', { method: 'POST' }, dto.did);
    await expect(client.refresh()).resolves.toEqual(bob);
    resolveWrite(new Response(null, { status: 401 }));
    expect((await write).status).toBe(401);
    expect(client.current()).toEqual(bob);
  });

  it('preserves a newer account draft while reconciling logout against a pending refresh', async () => {
    let resolveLogout!: (response: Response) => void;
    const pendingLogout = new Promise<Response>((resolve) => (resolveLogout = resolve));
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => (resolveRefresh = resolve));
    const bob = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockImplementationOnce(() => pendingLogout)
      .mockResolvedValueOnce(Response.json(bob))
      .mockImplementationOnce(() => pendingRefresh)
      .mockResolvedValueOnce(Response.json(bob));
    const state = createAppState();
    const values = {
      artist: 'Bob Draft',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();
    const logout = client.logout();
    await expect(client.refresh()).resolves.toEqual(bob);
    setScrobbleDraft(state, values);
    const refresh = client.refresh();
    resolveLogout(new Response(null, { status: 204 }));
    await logout;
    resolveRefresh(Response.json(dto));
    await expect(refresh).resolves.toEqual(bob);
    expect(client.current()).toEqual(bob);
    expect(state.session.value).toEqual(bob);
    expect(state.scrobbleDraft.value).toEqual({ did: bob.did, revision: 1, values });
  });

  it('does not let a late 401 logout for one account clear a newer account', async () => {
    let resolveLogout!: (response: Response) => void;
    const pendingLogout = new Promise<Response>((resolve) => (resolveLogout = resolve));
    const bob = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockImplementationOnce(() => pendingLogout)
      .mockResolvedValueOnce(Response.json(bob))
      .mockResolvedValueOnce(Response.json(bob));
    const state = createAppState();
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();
    const logout = client.logout();
    await expect(client.refresh()).resolves.toEqual(bob);
    const values = {
      artist: 'Bob Draft',
      track: 'Draft Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    setScrobbleDraft(state, values);

    resolveLogout(new Response(null, { status: 401 }));
    await logout;

    expect(client.current()).toEqual(bob);
    expect(state.session.value).toEqual(bob);
    expect(state.scrobbleDraft.value?.values).toEqual(values);
  });

  it('re-reads the cookie after logout instead of retaining a cached replacement account', async () => {
    let resolveLogout!: (response: Response) => void;
    const pendingLogout = new Promise<Response>((resolve) => (resolveLogout = resolve));
    const bob = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockImplementationOnce(() => pendingLogout)
      .mockResolvedValueOnce(Response.json(bob))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const state = createAppState();
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(state, session, null, { reauthRequired, kind }),
    });
    await client.getSession();
    const logout = client.logout();
    await expect(client.refresh()).resolves.toEqual(bob);

    resolveLogout(new Response(null, { status: 204 }));
    await logout;

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[3]?.[0])).toBe('/api/v1/auth/session');
    expect(client.current()).toBeNull();
    expect(state.session.value).toBeNull();
    expect(state.reauthRequired.value).toBe(false);
  });

  it('does not let an authenticated GET 401 from the previous account clear a newer session', async () => {
    const client = sessionClient();
    let resolveOldGet!: (response: Response) => void;
    const pendingGet = new Promise<Response>((resolve) => (resolveOldGet = resolve));
    const bob = { ...dto, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Session['did'], csrfToken: 'bob-csrf' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(dto))
      .mockImplementationOnce(() => pendingGet)
      .mockResolvedValueOnce(Response.json(bob));
    vi.stubGlobal('fetch', fetcher);
    await client.refresh();
    const oldGet = sessionFetch('/api/v1/account/credentials');
    await expect(client.refresh()).resolves.toEqual(bob);
    resolveOldGet(new Response(null, { status: 401 }));
    expect((await oldGet).status).toBe(401);
    expect(client.current()).toEqual(bob);
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
    setSession(state, null, null, { kind: 'signed_out' });
    expect(state.scrobbleDraft.value).toBeNull();
  });

  it('keeps a persisted draft through anonymous bootstrap and restores it only for the same account', async () => {
    sessionStorage.removeItem('atmusic:scrobble-draft');
    const original = createAppState();
    setSession(original, dto);
    const values = {
      artist: 'Persisted Artist',
      track: 'Persisted Track',
      album: '',
      listenedAt: '2026-01-15T12:00:00Z',
      durationSeconds: '',
      recordingMbid: '',
    };
    setScrobbleDraft(original, values);

    const reloaded = createAppState();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(dto));
    const client = new SessionClient({
      fetch: fetcher,
      onChange: (session, reauthRequired, kind) => setSession(reloaded, session, null, { reauthRequired, kind }),
    });

    await expect(client.getSession()).resolves.toBeNull();
    expect(reloaded.session.value).toBeNull();
    expect(reloaded.scrobbleDraft.value).toBeNull();
    expect(sessionStorage.getItem('atmusic:scrobble-draft')).toContain('Persisted Artist');

    await expect(client.refresh()).resolves.toEqual(dto);
    expect(reloaded.session.value).toEqual(dto);
    expect(reloaded.scrobbleDraft.value).toEqual({ did: dto.did, revision: 1, values });
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
