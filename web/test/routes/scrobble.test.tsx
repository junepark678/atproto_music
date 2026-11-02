import { afterEach, describe, expect, it, vi } from 'vitest';
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
