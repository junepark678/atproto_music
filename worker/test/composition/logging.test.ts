// W5-01 log redaction (M6.2.2/log_redaction, M6.2.2/metrics_auth): every
// console line the production Worker and IndexDO write (Workers Logs) while
// they ingest, serve, refuse and fail, captured in the shared isolate, plus
// every error body served meanwhile. There are no OAuth codes or cookies to
// mark (A3): the secrets are CURSOR_KEY and ADMIN_TOKEN, a presented bearer
// token, and record contents (a track title).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envLogger, INDEX_ERROR_MESSAGE, INDEX_ERROR_NAME } from '../../src/do/index-do';
import { flush, jetstreamServer } from '../fixtures/jetstream-server';
import {
  ADMIN_TOKEN,
  ALICE,
  activeUsers,
  alarmsUntil,
  CURSOR_KEY_HEX,
  compositionEnv,
  control,
  type HttpResult,
  harness,
  inDo,
  kitControl,
  postJson,
  runAlarm,
  SCROBBLE,
  uriOf,
} from './support';

const TRACK_MARKER = 'TRACK-TITLE-MARKER-5b1f';
const BEARER_MARKER = 'BEARER-MARKER-9c2e-0123456789abcdef';
const BAD_CURSOR_KEY = 'CURSOR-KEY-MARKER-not-hex-77aa77aa77aa77aa77aa77aa77aa77aa';

function record(listenedAt: string, n: number) {
  return {
    $type: SCROBBLE,
    artist: 'Portishead',
    track: `${TRACK_MARKER} ${n}`,
    album: `${TRACK_MARKER} album`,
    listenedAt,
    createdAt: listenedAt,
  };
}

describe('log redaction', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captured logs and error bodies contain no CURSOR_KEY, ADMIN_TOKEN or bearer marker and logs contain no track-title marker', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'socket', ADMIN_TOKEN } });
    const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
    control.connectJetstream = js.connect;
    const h = harness('logging', { ADMIN_TOKEN });
    const responses: HttpResult[] = [];
    const req = async (p: Promise<HttpResult>) => {
      const r = await p;
      responses.push(r);
      return r;
    };

    // Socket connect, then a commit carrying the marker title: hint → admission → snapshot.
    await req(h.request('/health/ready'));
    expect(await runAlarm(h.stub)).toBe(true);
    await flush();
    await inDo(h.stub, () => kit.createRecord('Alice', SCROBBLE, 'm1', record('2026-01-15T11:58:00Z', 1)));
    await flush();
    await alarmsUntil(h, () => inDo(h.stub, (_i, db) => activeUsers(db).includes(ALICE)));
    // A second one through notify and the drain, and one the validator excludes (+300 s bound).
    await inDo(h.stub, () => kit.createRecord('Alice', SCROBBLE, 'm2', record('2026-01-15T12:00:30Z', 2)));
    await inDo(h.stub, () => kit.createRecord('Alice', SCROBBLE, 'm3', record('2027-06-01T00:00:00Z', 3)));
    await flush();
    await req(postJson(h, '/api/v1/notify', { uri: uriOf(ALICE, 'm2') }, { ip: '198.51.100.9' }));
    await alarmsUntil(h, () =>
      inDo(
        h.stub,
        (_i, db) =>
          db.all('SELECT uri FROM record_state WHERE uri IN (?, ?)', uriOf(ALICE, 'm2'), uriOf(ALICE, 'm3')).length ===
          2,
      ),
    );
    const states = await inDo(h.stub, (_i, db) =>
      db.all('SELECT uri, state FROM record_state WHERE did = ? ORDER BY uri', ALICE),
    );
    expect(states).toEqual([
      { uri: uriOf(ALICE, 'm1'), state: 'present' },
      { uri: uriOf(ALICE, 'm2'), state: 'present' },
      { uri: uriOf(ALICE, 'm3'), state: 'excluded' },
    ]);
    const read = await req(h.request(`/api/v1/users/${ALICE}/scrobbles`));
    expect(read.text).toContain(TRACK_MARKER); // the marker is really in the index

    // Admin: a wrong bearer (the marker), the right one, and a bearer on a public route.
    const denied = await req(
      h.request('/internal/admin/status', { headers: { authorization: `Bearer ${BEARER_MARKER}` } }),
    );
    expect(denied.status).toBe(401);
    const allowed = await req(
      h.request('/internal/admin/status', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    expect(allowed.status).toBe(200);
    await req(h.request('/api/v1/meta', { headers: { authorization: `Bearer ${BEARER_MARKER}` } }));

    // A storage failure (500), malformed input (400/422) and a socket drop.
    control.dbFault = { match: /FROM scrobbles/, message: `boom ${TRACK_MARKER}`, remaining: 1 };
    expect((await req(h.request(`/api/v1/users/${ALICE}/scrobbles`))).status).toBe(500);
    // workerd reports a rejected RPC in the DO's own log stream (outside the
    // console capture) with the error's message and stack, so what crosses the
    // stub is itself checked: a bare IndexError with no fault text and no DO-side
    // frame or path (workerd adds only the caller's own frames at the call site).
    const leak = `SQLITE_IOERR ${TRACK_MARKER} for ${ALICE} at /srv/atmusic/worker/src/do/db.ts:71:20`;
    control.dbFault = { match: /FROM scrobbles/, message: leak, remaining: 1 };
    const rejected = await h.stub.history({ did: ALICE, limit: 5 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(control.dbFault.remaining).toBe(0);
    expect(rejected).toBeInstanceOf(Error);
    const { name, message, stack } = rejected as Error;
    expect({ name, message }).toEqual({ name: INDEX_ERROR_NAME, message: INDEX_ERROR_MESSAGE });
    for (const text of [message, String(stack), JSON.stringify(rejected)]) {
      for (const needle of [TRACK_MARKER, ALICE, '/srv/', 'worker/src/', 'entry.ts', 'SQLITE']) {
        expect([needle, text.includes(needle) ? text : false]).toEqual([needle, false]);
      }
    }
    // Argument validation keeps its name and message, but still no frames.
    const invalid = await h.stub.history({ did: ALICE, limit: 0 }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(invalid?.name).toBe('RangeError');
    expect(invalid?.message).toMatch(/^page limit must be an integer/);
    expect(String(invalid?.stack)).not.toContain('worker/src/');
    expect((await req(h.request(`/api/v1/users/${ALICE}/scrobbles?cursor=${BEARER_MARKER}`))).status).toBe(400);
    expect((await req(h.request(`/api/v1/feed?scope=following&viewer=${BEARER_MARKER}`))).status).toBe(422);
    await inDo(h.stub, () => js.last().close(1011, `server error ${BEARER_MARKER}`));
    await flush();

    // A CURSOR_KEY that does not parse: 503, logged without its value.
    const badKey = harness('logging-bad-key', { CURSOR_KEY: BAD_CURSOR_KEY });
    expect((await req(badKey.request('/api/v1/meta'))).status).toBe(503);

    // Even a careless call site cannot leak a secret through the production logger.
    envLogger({ ...compositionEnv, ADMIN_TOKEN }).log('error', 'careless', {
      detail: `token=${ADMIN_TOKEN} key=${CURSOR_KEY_HEX} upper=${CURSOR_KEY_HEX.toUpperCase()} Bearer ${BEARER_MARKER}`,
      authorization: `Bearer ${BEARER_MARKER}`,
    });

    // The capture is not vacuous: the flows above did log.
    const events = new Set(
      lines.flatMap((l) => {
        try {
          return [(JSON.parse(l) as { event?: string }).event ?? ''];
        } catch {
          return [];
        }
      }),
    );
    for (const event of [
      'jetstream_connected',
      'jetstream_disconnected',
      'snapshot.finished',
      'request.server_error',
      'index.rpc_failed',
      'config.cursor_key_invalid',
      'gc.done',
      'careless',
    ]) {
      expect([event, events.has(event)]).toEqual([event, true]);
    }
    const rpcFailed = lines.filter((l) => l.includes('"index.rpc_failed"')).map((l) => JSON.parse(l));
    expect(rpcFailed).toEqual([
      { method: 'history', error: 'Error', level: 'error', event: 'index.rpc_failed' },
      { method: 'history', error: 'Error', level: 'error', event: 'index.rpc_failed' },
    ]);
    const careless = lines.find((l) => l.includes('"careless"')) ?? '';
    expect(careless).toContain('[redacted]');

    const secrets = [CURSOR_KEY_HEX, CURSOR_KEY_HEX.toUpperCase(), ADMIN_TOKEN, BEARER_MARKER, BAD_CURSOR_KEY];
    for (const line of lines) {
      for (const needle of [...secrets, TRACK_MARKER]) {
        expect([needle, line.includes(needle)]).toEqual([needle, false]);
      }
    }
    const errors = responses.filter((r) => r.status >= 400);
    expect(errors.map((r) => r.status).sort()).toEqual([400, 401, 422, 500, 503]);
    for (const r of errors) {
      for (const needle of secrets)
        expect([r.status, needle, r.text.includes(needle)]).toEqual([r.status, needle, false]);
      expect(r.text).not.toContain(TRACK_MARKER);
    }
    expect(allowed.text).not.toContain(ADMIN_TOKEN);
  });
});
