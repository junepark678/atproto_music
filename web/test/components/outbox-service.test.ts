import { afterEach, expect, it, vi } from 'vitest';
import { OutboxService } from '../../src/components/outbox-service';
import type { Session } from '../../src/session/client';

const session: Session = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
const uri = `at://${session.did}/com.example.atmusic.scrobble/r01`;
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('refresh notifies subscribers only after server state changes', async () => {
  const row = {
    id: 'op-1',
    did: session.did,
    kind: 'scrobble_create',
    state: 'queued',
    uri: undefined,
    cid: undefined,
    failureCode: undefined,
    reason: undefined,
    dueAt: Date.now() + 2000,
    attempts: 0,
    notified: true,
    polls: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessionStorage.setItem(`atmusic:server-operations:${session.did}`, JSON.stringify([row]));
  let state: 'queued' | 'succeeded' = 'queued';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://music.test');
    if (url.pathname === '/api/v1/operations/op-1')
      return Response.json({
        id: 'op-1',
        kind: 'scrobble.create',
        origin: 'web',
        state,
        attempts: 0,
        uri: state === 'succeeded' ? uri : undefined,
        createdAt: '2026-01-15T12:00:00Z',
        updatedAt: '2026-01-15T12:00:00Z',
      });
    if (url.pathname === '/api/v1/records/status') return Response.json({ uri, state: 'indexed' });
    throw new Error(`unexpected request ${url.pathname}`);
  });
  const service = new OutboxService(session, 'com.example.atmusic');
  const listener = vi.fn();
  service.subscribe(listener);
  await service.refresh();
  expect(listener).not.toHaveBeenCalled();
  state = 'succeeded';
  await service.refresh();
  expect(listener).toHaveBeenCalledOnce();
  expect((await service.list())[0]?.state).toBe('indexed');
  await service.stop();
});
