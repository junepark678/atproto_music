import type { Meta, Statistics } from '@atmusic/core/api-types';
import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { App } from '../../src/app';
import { followView } from '../../src/components/follow-button';
import type { OutboxService } from '../../src/components/outbox-service';
import { type ScreenServices, ServicesProvider } from '../../src/components/services';
import type { OutboxOperation } from '../../src/outbox/overlay';
import type { Session } from '../../src/session/client';
import { AppStateContext, createAppState } from '../../src/state/store';
import { DID, example, META, mount, SESSION } from './support';

describe('web/test/routes/profile.test.tsx', () => {
  it('renders the indexed profile and its reads from the Node AppView routes', async () => {
    const app = mount(`/u/${DID}`);
    await vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull());
    expect(app.requests.some((path) => path.endsWith(`/api/v1/users/${DID}/profile`))).toBe(true);
    expect(app.root.querySelector('[data-count="scrobbles"]')).not.toBeNull();
    app.cleanup();
  });

  it('stats window switch fetches the requested window and renders the server-ranked top lists', async () => {
    const requested: string[] = [];
    const app = mount(`/u/${DID}`, async (input) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname === '/api/v1/meta') return Response.json(META);
      if (url.pathname.endsWith('/stats')) {
        requested.push(url.searchParams.get('window') ?? 'all');
        const stats = example<Statistics>('stats');
        return Response.json({
          ...stats,
          window: url.searchParams.get('window') ?? 'all',
          totalScrobbles: 7,
          topArtists: [{ artist: 'Server ranked artist', scrobbleCount: 7 }],
        });
      }
      return undefined;
    });
    await vi.waitFor(() => expect(app.root.textContent).toContain('Jóga'));
    app.root.querySelector<HTMLButtonElement>('[data-window="7d"]')!.click();
    await vi.waitFor(() => expect(requested).toContain('7d'));
    await vi.waitFor(() => expect(app.root.textContent).toContain('Server ranked artist'));
    expect(app.root.textContent).toContain('7 scrobbles');
    app.cleanup();
  });

  it('a refreshed verified handle updates on the same DID route', async () => {
    let reads = 0;
    const profile = example<Record<string, unknown>>('profile');
    const app = mount(`/u/${DID}`, async (input) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname.endsWith('/profile')) {
        reads++;
        return Response.json({ ...profile, handle: reads === 1 ? 'alice.test' : 'new-alice.test' });
      }
      return undefined;
    });
    await vi.waitFor(() => expect(app.root.textContent).toContain('@alice.test'));
    app.root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(app.root.textContent).toContain('@new-alice.test'));
    expect(window.location.pathname).toBe(`/u/${DID}`);
    app.cleanup();
  });

  it('recordless profiles show explicit empty history and unknown DIDs show not found', async () => {
    const profile = example<Record<string, unknown>>('profile');
    const stats = example<Statistics>('stats');
    const app = mount(`/u/${DID}`, async (input) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname.endsWith('/profile')) return Response.json({ ...profile, totalScrobbles: 0 });
      if (url.pathname.endsWith('/stats'))
        return Response.json({ ...stats, totalScrobbles: 0, topArtists: [], topTracks: [], topAlbums: [] });
      if (url.pathname.endsWith('/scrobbles'))
        return Response.json({ ...example('scrobble-page'), items: [], nextCursor: null });
      return undefined;
    });
    await vi.waitFor(() => expect(app.root.textContent).toContain('No scrobbles yet'));
    expect(app.root.textContent).toContain('No scrobbles in this window');
    app.cleanup();

    const unknown = mount(`/u/${DID}`, async (input) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname.endsWith('/profile'))
        return Response.json(
          { error: { code: 'not_found', message: 'not found', requestId: '00000000-0000-4000-8000-000000000001' } },
          { status: 404 },
        );
      return undefined;
    });
    await vi.waitFor(() => expect(unknown.root.textContent).toContain('Profile not found'));
    expect(unknown.root.textContent).not.toContain('0 scrobbles');
    unknown.cleanup();
  });

  it('follow is confirmed only after indexing and a failed unfollow never claims removal', () => {
    const op: OutboxOperation = {
      id: 'op-follow',
      did: SESSION.did,
      kind: 'follow_create',
      uri: `at://${SESSION.did}/com.example.atmusic.follow/r01`,
      subject: DID,
      state: 'queued',
      seq: 1,
      dueAt: Date.now(),
      attempts: 0,
      notified: true,
      polls: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const pending = followView({ viewer: SESSION.did, subject: DID, ops: [op], edge: false });
    expect(pending.status).toContain('Follow queued');
    expect(pending.action).toBeNull();
    op.state = 'indexed';
    op.dueAt = null;
    expect(followView({ viewer: SESSION.did, subject: DID, ops: [op], edge: true }).status).toContain(
      'Following (confirmed)',
    );
    op.kind = 'follow_delete';
    op.state = 'failed';
    op.failureCode = 'upstream_error';
    const failed = followView({ viewer: SESSION.did, subject: DID, ops: [op], edge: true });
    expect(failed.status).toContain('follow record was not removed');
    expect(failed.status).toContain('still follow');
    expect(failed.action).toBe('unfollow');

    const unknown = followView({ viewer: SESSION.did, subject: DID, ops: null, edge: 'unknown' });
    expect(unknown.status).toContain('Could not check whether you follow this account');
    expect(unknown.action).toBeNull();
    expect(unknown.recheck).toBe(true);
  });

  it('owner profiles have no follow control and anonymous viewers get a sign-in action', async () => {
    const app = mount(`/u/${DID}`);
    await vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull());
    expect(app.root.textContent).toContain('Sign in to follow this account');
    app.state.session.value = SESSION;
    await vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull());
    expect(app.root.querySelector('.follow-control')).toBeNull();
    app.cleanup();
  });

  it('shows delete controls only on the signed-in owner’s records', async () => {
    const meta: Meta = { ...META, capabilities: [...META.capabilities, 'publication'] };
    const api = new ApiClient({
      fetch: async (input) => {
        const path = new URL(String(input), 'https://music.test').pathname;
        if (path === '/api/v1/meta') return Response.json(meta);
        if (path.endsWith('/profile')) return Response.json(example('profile'));
        if (path.endsWith('/stats')) return Response.json(example('stats'));
        if (path.endsWith('/scrobbles')) return Response.json(example('scrobble-page'));
        if (path.endsWith('/following')) return Response.json(example('follow-page'));
        return Response.json(
          { error: { code: 'not_found', message: 'not found', requestId: 'test' } },
          { status: 404 },
        );
      },
    });
    const state = createAppState({ api });
    state.meta.value = meta;
    const outbox = {
      did: DID,
      session: SESSION,
      refresh: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as OutboxService;
    const mutableOutbox = outbox as unknown as { did: string; session: Session };
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
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://music.test/u/${DID}`);
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <AppStateContext.Provider value={state}>
        <ServicesProvider value={services}>
          <App state={state} loadMetaOnMount={false} />
        </ServicesProvider>
      </AppStateContext.Provider>,
      root,
    );
    await vi.waitFor(() => expect(root.querySelector('.profile-header')).not.toBeNull());
    expect(root.querySelector('button.delete')).toBeNull();
    const visitor = { ...SESSION, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: 'bob.test', username: 'bob' };
    mutableOutbox.did = visitor.did;
    mutableOutbox.session = visitor;
    state.session.value = visitor;
    await vi.waitFor(() => expect(root.querySelector('.follow-control')).not.toBeNull());
    expect(root.querySelector('button.delete')).toBeNull();
    mutableOutbox.did = SESSION.did;
    mutableOutbox.session = SESSION;
    state.session.value = SESSION;
    await vi.waitFor(() => expect(root.querySelector('button.delete')).not.toBeNull());
    expect(root.querySelectorAll('button.delete').length).toBeGreaterThan(0);
    render(null, root);
    root.remove();
  });
});
