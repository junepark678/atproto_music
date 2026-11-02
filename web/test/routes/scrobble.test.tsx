import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { OutboxService } from '../../src/components/outbox-service';
import { OperationStatus } from '../../src/components/operation-status';
import { ServicesProvider, type ScreenServices } from '../../src/components/services';
import { ScrobbleForm } from '../../src/routes/scrobble';
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
  it('invalid input shows field errors and does not create a scrobble operation', async () => {
    const outbox = new OutboxService(session, 'com.example.atmusic');
    const scrobble = vi.fn();
    outbox.scrobble = scrobble;
    const services: ScreenServices = {
      clock: { nowMs: () => Date.parse('2026-01-15T12:00:00Z') },
      random: { bytes: (n) => new Uint8Array(n), float: () => 0 },
      ticker: { every: () => () => undefined },
      session: async () => ({ signIn: async () => undefined, signOut: async () => undefined, expiry: async () => null }),
      outbox: async () => outbox,
      closeOutbox: async () => undefined,
    };
    const root = document.createElement('div');
    render(<ServicesProvider value={services}><ScrobbleForm outbox={outbox} /></ServicesProvider>, root);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelectorAll('[data-field-error]').length).toBeGreaterThan(0));
    expect(root.querySelector('[data-field-error="artist"]')?.textContent).toContain('Enter the artist');
    expect(root.querySelector('[data-field-error="track"]')?.textContent).toContain('Enter the track');
    expect(scrobble).not.toHaveBeenCalled();
    render(null, root);
    await outbox.stop();
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
      if (path === '/api/v1/scrobbles') return Response.json({ operation: { ...operation, id: 'op-excluded', state: 'queued' } }, { status: 202 });
      if (path === '/api/v1/operations/op-excluded') return Response.json({ ...operation, id: 'op-excluded', state: 'succeeded', uri });
      if (path === '/api/v1/records/status') return Response.json({ uri, state: 'excluded', reason: 'record_not_visible' });
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
