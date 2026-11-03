import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { OperationStatus } from '../../src/components/operation-status';
import { OutboxService } from '../../src/components/outbox-service';
import { type ScreenServices, ServicesProvider } from '../../src/components/services';
import type { OutboxOperation } from '../../src/outbox/overlay';
import { ScrobbleForm } from '../../src/routes/scrobble';
import { type Session, sessionClient } from '../../src/session/client';
import { announceSessionReady, listenForSessionReady } from '../../src/session/reauth-channel';
import { AppStateContext, createAppState, setSession } from '../../src/state/store';

const session: Session = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
const operation = {
  id: 'op-123',
  kind: 'scrobble.create',
  origin: 'web',
  attempts: 1,
  createdAt: '2026-01-15T12:00:00Z',
  updatedAt: '2026-01-15T12:00:00Z',
};
const uri = `at://${session.did}/com.example.atmusic.scrobble/r01`;

afterEach(() => vi.unstubAllGlobals());
describe('web/test/routes/scrobble.test.tsx', () => {
  it('invalid input shows field errors and does not create a scrobble operation', async () => {
    const outbox = new OutboxService(session, 'com.example.atmusic');
    const scrobble = vi.fn();
    outbox.scrobble = scrobble;
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({
        signIn: async () => undefined,
        signOut: async () => undefined,
        expiry: async () => null,
      }),
      outbox: async () => outbox,
      closeOutbox: async () => undefined,
    };
    const state = createAppState();
    setSession(state, session);
    const root = document.createElement('div');
    render(
      <AppStateContext.Provider value={state}>
        <ServicesProvider value={services}>
          <ScrobbleForm outbox={outbox} />
        </ServicesProvider>
      </AppStateContext.Provider>,
      root,
    );
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelectorAll('[data-field-error]').length).toBeGreaterThan(0));
    expect(root.querySelector('[data-field-error="artist"]')?.textContent).toContain('Enter the artist');
    expect(root.querySelector('[data-field-error="track"]')?.textContent).toContain('Enter the track');
    expect(scrobble).not.toHaveBeenCalled();
    render(null, root);
    await outbox.stop();
  });

  it('a late submit response cannot clear a newer draft after the form remounts', async () => {
    const outbox = new OutboxService(session, 'com.example.atmusic');
    let complete!: (value: { ok: true; op: OutboxOperation }) => void;
    outbox.scrobble = vi.fn(() => new Promise<{ ok: true; op: OutboxOperation }>((resolve) => (complete = resolve)));
    const state = createAppState();
    setSession(state, session);
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({
        signIn: async () => undefined,
        signOut: async () => undefined,
        expiry: async () => null,
      }),
      outbox: async () => outbox,
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div');
    const renderForm = () =>
      render(
        <AppStateContext.Provider value={state}>
          <ServicesProvider value={services}>
            <ScrobbleForm outbox={outbox} />
          </ServicesProvider>
        </AppStateContext.Provider>,
        root,
      );
    renderForm();
    const artist = root.querySelector<HTMLInputElement>('input[name="artist"]')!;
    const track = root.querySelector<HTMLInputElement>('input[name="track"]')!;
    artist.value = 'Submitted Artist';
    artist.dispatchEvent(new Event('input', { bubbles: true }));
    track.value = 'Submitted Track';
    track.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(outbox.scrobble).toHaveBeenCalledTimes(1));

    render(null, root);
    renderForm();
    const restoredArtist = root.querySelector<HTMLInputElement>('input[name="artist"]')!;
    restoredArtist.value = 'Newer Artist';
    restoredArtist.dispatchEvent(new Event('input', { bubbles: true }));
    const newerRevision = state.scrobbleDraft.value?.revision;
    complete({
      ok: true,
      op: {
        id: 'late-op',
        did: session.did,
        kind: 'scrobble_create',
        uri,
        state: 'queued',
        seq: 1,
        dueAt: Date.now() + 2_000,
        attempts: 1,
        notified: true,
        polls: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>('input[name="artist"]')?.value).toBe('Newer Artist'),
    );
    expect(state.scrobbleDraft.value?.revision).toBe(newerRevision);
    expect(state.scrobbleDraft.value?.values.artist).toBe('Newer Artist');
    render(null, root);
    await outbox.stop();
  });

  it('shows sign-in after a 401, then restores the in-memory draft with a fresh write intent after reauthentication', async () => {
    sessionClient().unauthorized();
    const keys: string[] = [];
    let sessionReads = 0;
    let writeCount = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname === '/api/v1/auth/session') {
        sessionReads += 1;
        return Response.json({ ...session, csrfToken: `csrf-${sessionReads}` });
      }
      if (url.pathname === '/api/v1/scrobbles') {
        writeCount += 1;
        keys.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
        if (writeCount === 1) {
          return Response.json({ error: { code: 'session_expired', message: 'session expired' } }, { status: 401 });
        }
        return Response.json(
          {
            operation: {
              ...operation,
              id: 'op-after-reauth',
              state: 'queued',
            },
          },
          { status: 202 },
        );
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });

    const state = createAppState();
    state.meta.value = {
      name: 'atproto_music',
      version: 'test',
      stage: 'product',
      capabilities: ['read', 'publication'],
      lexiconPrefix: 'com.example.atmusic',
      indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 },
    };
    const updateState = sessionClient().subscribe((current, reauthRequired) => {
      setSession(state, current, null, { reauthRequired });
    });
    const stopListening = listenForSessionReady(sessionClient());
    vi.spyOn(state.api, 'profile').mockRejectedValue(new Error('profile unavailable'));
    const outboxes: OutboxService[] = [];
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({
        signIn: async () => undefined,
        signOut: async () => undefined,
        expiry: async () => null,
      }),
      outbox: async ({ session: current, prefix }) => {
        const next = new OutboxService(current, prefix);
        outboxes.push(next);
        return next;
      },
      closeOutbox: async () => {
        await Promise.all(outboxes.map((outbox) => outbox.stop()));
      },
    };
    const root = document.createElement('div');
    document.body.append(root);
    try {
      await sessionClient().getSession();
      (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('https://music.test/scrobble');
      render(
        <ServicesProvider value={services}>
          <App state={state} loadMetaOnMount={false} />
        </ServicesProvider>,
        root,
      );
      await vi.waitFor(() => expect(root.querySelector('input[name="artist"]')).not.toBeNull());

      const artist = root.querySelector<HTMLInputElement>('input[name="artist"]')!;
      const track = root.querySelector<HTMLInputElement>('input[name="track"]')!;
      artist.value = 'Draft Artist';
      artist.dispatchEvent(new Event('input', { bubbles: true }));
      track.value = 'Draft Track';
      track.dispatchEvent(new Event('input', { bubbles: true }));
      expect(sessionStorage.getItem('atmusic:scrobble-draft')).toBeNull();
      expect(
        Array.from({ length: sessionStorage.length }, (_, index) =>
          sessionStorage.getItem(sessionStorage.key(index) ?? ''),
        ).join('\n'),
      ).not.toContain('Draft Artist');
      root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      await vi.waitFor(() => expect(root.textContent).toContain('Sign in to publish scrobbles'));
      expect(root.querySelector('input[name="artist"]')).toBeNull();
      expect(root.querySelector('button[type="submit"]')).toBeNull();
      expect(state.reauthRequired.value).toBe(true);
      expect(state.scrobbleDraft.value).toEqual({
        did: session.did,
        revision: expect.any(Number),
        values: expect.objectContaining({ artist: 'Draft Artist', track: 'Draft Track' }),
      });

      // This is the same signal sent by the OAuth callback page after its
      // full-page redirect. The parent tab refreshes its cookie session while
      // retaining the draft in memory.
      announceSessionReady();
      await vi.waitFor(() => expect(root.querySelector('input[name="artist"]')).not.toBeNull());
      expect(root.querySelector<HTMLInputElement>('input[name="artist"]')?.value).toBe('Draft Artist');
      expect(root.querySelector<HTMLInputElement>('input[name="track"]')?.value).toBe('Draft Track');
      expect(root.textContent).not.toContain('Loading your outbox');

      root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(writeCount).toBe(2);
        expect(state.scrobbleDraft.value).toBeNull();
      });
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[1]).not.toBe(keys[0]);
      expect(outboxes.length).toBeGreaterThanOrEqual(2);
    } finally {
      updateState();
      stopListening();
      sessionClient().unauthorized();
      render(null, root);
      await Promise.all(outboxes.map((outbox) => outbox.stop()));
      root.remove();
      sessionStorage.clear();
    }
  });

  it('submitting the form posts with a fresh Idempotency-Key and shows queued, published, then indexed from operation and record-status polling', async () => {
    let operationPoll = 0;
    const requests: { path: string; init: RequestInit }[] = [];
    const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = new URL(String(input), 'https://music.test').pathname;
      requests.push({ path, init });
      if (path === '/api/v1/auth/session') return Response.json(session);
      if (path === '/api/v1/scrobbles')
        return Response.json({ operation: { ...operation, state: 'queued' } }, { status: 202 });
      if (path === '/api/v1/operations/op-123') {
        operationPoll++;
        return Response.json({
          ...operation,
          state: operationPoll === 1 ? 'queued' : 'succeeded',
          uri,
        });
      }
      if (path === '/api/v1/records/status') return Response.json({ uri, state: 'indexed' });
      throw new Error(`unexpected request ${path}`);
    };
    vi.stubGlobal('fetch', fetcher);
    const outbox = new OutboxService(session, 'com.example.atmusic');
    const result = await outbox.scrobble({ artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('write was rejected');
    expect((await outbox.list())[0]?.state).toBe('queued');
    const write = requests.find((request) => request.path === '/api/v1/scrobbles');
    expect(write?.init.method).toBe('POST');
    expect(new Headers(write?.init.headers).get('Idempotency-Key')).toBeTruthy();
    await outbox.refresh();
    expect((await outbox.list())[0]?.state).toBe('queued');
    await outbox.refresh();
    expect((await outbox.list())[0]?.state).toBe('indexed');
    expect(requests.filter((request) => request.path === '/api/v1/operations/op-123')).toHaveLength(2);
    expect(requests.some((request) => request.path === '/api/v1/records/status')).toBe(true);
    await outbox.stop();
  });

  it('excluded or failed status shows the failure code, stops polling and never shows published success', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://music.test').pathname;
      if (path === '/api/v1/auth/session') return Response.json(session);
      if (path === '/api/v1/scrobbles')
        return Response.json({ operation: { ...operation, id: 'op-excluded', state: 'queued' } }, { status: 202 });
      if (path === '/api/v1/operations/op-excluded')
        return Response.json({ ...operation, id: 'op-excluded', state: 'succeeded', uri });
      if (path === '/api/v1/records/status')
        return Response.json({ uri, state: 'excluded', reason: 'record_not_visible' });
      throw new Error(`unexpected request ${path}`);
    });
    const outbox = new OutboxService(session, 'com.example.atmusic');
    await outbox.scrobble({ artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' });
    await outbox.refresh();
    const row = (await outbox.list()).find((candidate) => candidate.id === 'op-excluded');
    expect(row?.state).toBe('failed');
    expect(row?.failureCode).toBe('record_excluded');
    expect(row?.reason).toBe('record_not_visible');
    const root = document.createElement('div');
    render(<OperationStatus op={row!} />, root);
    expect(root.textContent).toContain('record_not_visible');
    expect(root.textContent).not.toContain('published to your PDS');
    render(null, root);
    await outbox.stop();
  });

  it('cancels an in-flight operation poll when the page service stops', async () => {
    let pollSignal: AbortSignal | undefined;
    const row = {
      id: 'op-pending',
      kind: 'scrobble.create',
      origin: 'web',
      attempts: 0,
      uri,
      state: 'queued',
      createdAt: '2026-01-15T12:00:00Z',
      updatedAt: '2026-01-15T12:00:00Z',
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'https://music.test').pathname;
      if (path === '/api/v1/auth/session') return Response.json(session);
      if (path === '/api/v1/scrobbles') return Response.json({ operation: row }, { status: 202 });
      return new Promise<Response>((_resolve, reject) => {
        pollSignal = init.signal ?? undefined;
        pollSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const outbox = new OutboxService(session, 'com.example.atmusic');
    await outbox.scrobble({ artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' });
    const poll = outbox.refresh();
    await vi.waitFor(() => expect(pollSignal).toBeDefined());
    await outbox.stop();
    await poll;
    expect(pollSignal?.aborted).toBe(true);
  });
});
