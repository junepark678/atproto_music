// W5-01 log redaction on the Node host (ported by N4-03; M6.2.2/log_redaction,
// M6.2.2/metrics_auth; ADR 0005 §3.10, §13): every line the production logger
// writes (journald JSON lines; support.ts captures them through compose's
// `log` option with the redactions run() derives from the secrets) and every
// console line, while the composition ingests, serves, refuses and fails,
// plus every error body served meanwhile. The secrets are the cursor key (and
// the other key material of the secrets file), an admin bearer token
// presented on the TCP listener (admin lives on the unix socket, ADR §3.11),
// a bearer marker, and record contents (a track title).

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, INDEX_ERROR_MESSAGE, INDEX_ERROR_NAME } from '../../src/app/index-core';
import { type ExitCode, run } from '../../src/node/run';
import { captureLog, manualTimers, refusingJetstream, testSecretsDocument } from '../node/support/app';
import { flush, jetstreamServer } from './jetstream';
import {
  ALICE,
  activeUsers,
  closeHarnesses,
  control,
  type HttpResult,
  harness,
  harnessEnv,
  kitControl,
  redactionsOf,
  SCROBBLE,
  uriOf,
} from './support';

const TRACK_MARKER = 'TRACK-TITLE-MARKER-5b1f';
const BEARER_MARKER = 'BEARER-MARKER-9c2e-0123456789abcdef';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const BAD_CURSOR_KEY = 'CURSOR-KEY-MARKER-not-base64-77aa77aa77aa77aa77aa77aa77aa77aa';

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

const dirs: string[] = [];

describe('log redaction', () => {
  const consoleLines: string[] = [];
  beforeEach(() => {
    consoleLines.length = 0;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeHarnesses();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('captured logs and error bodies contain no CURSOR_KEY, ADMIN_TOKEN or bearer marker and logs contain no track-title marker', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'socket' } });
    const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
    control.connectJetstream = js.connect;
    const h = await harness('logging');
    const secrets = redactionsOf(h.secrets);
    const cursorBase64 = Buffer.from(h.secrets.cursorKey).toString('base64');
    const cursorHex = Buffer.from(h.secrets.cursorKey).toString('hex');
    const responses: HttpResult[] = [];
    const req = async (p: Promise<HttpResult>) => {
      const r = await p;
      responses.push(r);
      return r;
    };

    // Socket connect, then a commit carrying the marker title: hint → admission → snapshot.
    await req(h.request('/health/ready'));
    expect(await h.runAlarm()).toBe(true);
    await flush();
    await kit.createRecord('Alice', SCROBBLE, 'm1', record('2026-01-15T11:58:00Z', 1));
    await flush();
    await h.alarmsUntil((db) => activeUsers(db).includes(ALICE));
    // A second one through notify and the drain, and one the validator excludes (+300 s bound).
    await kit.createRecord('Alice', SCROBBLE, 'm2', record('2026-01-15T12:00:30Z', 2));
    await kit.createRecord('Alice', SCROBBLE, 'm3', record('2027-06-01T00:00:00Z', 3));
    await flush();
    await req(h.postJson('/api/v1/notify', { uri: uriOf(ALICE, 'm2') }, { ip: '198.51.100.9' }));
    await h.alarmsUntil(
      (db) =>
        db.all('SELECT uri FROM record_state WHERE uri IN (?, ?)', uriOf(ALICE, 'm2'), uriOf(ALICE, 'm3')).length === 2,
    );
    expect(h.db.all('SELECT uri, state FROM record_state WHERE did = ? ORDER BY uri', ALICE)).toEqual([
      { uri: uriOf(ALICE, 'm1'), state: 'present' },
      { uri: uriOf(ALICE, 'm2'), state: 'present' },
      { uri: uriOf(ALICE, 'm3'), state: 'excluded' },
    ]);
    const read = await req(h.request(`/api/v1/users/${ALICE}/scrobbles`));
    expect(read.text).toContain(TRACK_MARKER); // the marker is really in the index

    // Admin on the TCP listener: whatever bearer is presented, the JSON 404 (ADR §3.11);
    // and a bearer on a public route.
    const denied = await req(
      h.request('/internal/admin/status', { headers: { authorization: `Bearer ${BEARER_MARKER}` } }),
    );
    expect(denied.status).toBe(404);
    const token = await req(
      h.request('/internal/admin/status', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    expect(token.status).toBe(404);
    const meta = await req(h.request('/api/v1/meta', { headers: { authorization: `Bearer ${BEARER_MARKER}` } }));
    expect(meta.status).toBe(200);

    // A storage failure (500), malformed input (400/422) and a socket drop.
    control.dbFault = { match: /FROM scrobbles/, message: `boom ${TRACK_MARKER}`, remaining: 1 };
    expect((await req(h.request(`/api/v1/users/${ALICE}/scrobbles`))).status).toBe(500);
    // What leaves IndexCore when a method fails is itself checked: a bare
    // IndexError with no fault text, frame or path.
    const leak = `SQLITE_IOERR ${TRACK_MARKER} for ${ALICE} at /srv/atmusic/worker/src/do/db.ts:71:20`;
    control.dbFault = { match: /FROM scrobbles/, message: leak, remaining: 1 };
    const rejected = await h.core.history({ did: ALICE, limit: 5 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(control.dbFault.remaining).toBe(0);
    expect(rejected).toBeInstanceOf(Error);
    const { name, message, stack } = rejected as Error;
    expect({ name, message }).toEqual({ name: INDEX_ERROR_NAME, message: INDEX_ERROR_MESSAGE });
    expect(String(stack)).toBe(`${INDEX_ERROR_NAME}: ${INDEX_ERROR_MESSAGE}`);
    for (const text of [message, String(stack), JSON.stringify(rejected)]) {
      for (const needle of [TRACK_MARKER, ALICE, '/srv/', 'worker/src/', 'support.ts', 'SQLITE']) {
        expect([needle, text.includes(needle) ? text : false]).toEqual([needle, false]);
      }
    }
    // Argument validation keeps its name and message, but still no frames.
    const invalid = await h.core.history({ did: ALICE, limit: 0 }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(invalid?.name).toBe('RangeError');
    expect(invalid?.message).toMatch(/^page limit must be an integer/);
    expect(String(invalid?.stack)).not.toContain('worker/src/');
    expect((await req(h.request(`/api/v1/users/${ALICE}/scrobbles?cursor=${BEARER_MARKER}`))).status).toBe(400);
    expect((await req(h.request(`/api/v1/feed?scope=following&viewer=${BEARER_MARKER}`))).status).toBe(422);
    js.last().close(1011, `server error ${BEARER_MARKER}`);
    await flush();
    // gc runs (its report is logged), so the alarm path's own lines are captured too.
    control.clock.advance(86_400_000);
    await h.alarmsUntil(() => h.core.lastAlarm?.ran.includes('gc') === true, { max: 3 });

    // A cursor key that does not parse: the process refuses to start (78), naming only the field.
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-badkey-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'web', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'web', 'dist', 'index.html'), '<!doctype html><title>t</title>');
    const secretsFile = join(dir, 'secrets.json');
    writeFileSync(secretsFile, JSON.stringify({ ...testSecretsDocument(), cursorKey: BAD_CURSOR_KEY }));
    chmodSync(secretsFile, 0o600);
    const badKeyLog = captureLog();
    const stderr: string[] = [];
    const exits: ExitCode[] = [];
    const code = await run({
      argv: ['node', 'main.mjs'],
      env: { ...harnessEnv(dir), ATMUSIC_ASSETS_DIR: join(dir, 'web', 'dist'), ATMUSIC_SECRETS_FILE: secretsFile },
      exit: (c) => exits.push(c),
      log: badKeyLog.logger,
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
      transport: routerTransport({}) as FixtureTransport,
      connectJetstream: refusingJetstream(),
      timers: manualTimers(),
      signals: new EventEmitter(),
    });
    expect([code, exits]).toEqual([78, [78]]);
    expect(badKeyLog.logs).toEqual([{ level: 'error', event: 'run.config_error', fields: ['cursorKey'] }]);
    expect(stderr.join('')).toMatch(/^atmusic: configuration error: cursorKey: /);

    // Even a careless call site cannot leak a secret through the production logger:
    // the key material wherever it occurs, any bearer value, any credential-named field.
    // (The Node host holds no admin token; one only ever arrives as a presented bearer.)
    const careless = captureLog(secrets);
    careless.logger.log('error', 'careless', {
      detail: `key=${cursorBase64} hex=${cursorHex} upper=${cursorHex.toUpperCase()} Bearer ${BEARER_MARKER} then Bearer ${ADMIN_TOKEN}`,
      authorization: `Bearer ${BEARER_MARKER}`,
    });
    createLogger(secrets, { log: () => {}, warn: () => {}, error: (line) => consoleLines.push(line) }).log(
      'error',
      'careless',
      { detail: `Bearer ${ADMIN_TOKEN} key=${cursorHex}` },
    );

    // The capture is not vacuous: the flows above did log.
    const lines = [...h.log.lines, ...badKeyLog.lines, ...careless.lines, ...consoleLines, ...stderr];
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
      'run.config_error',
      'gc.done',
      'request',
      'careless',
    ]) {
      expect([event, events.has(event)]).toEqual([event, true]);
    }
    const rpcFailed = h.log.logs.filter((l) => l.event === 'index.rpc_failed');
    expect(rpcFailed).toEqual([
      { method: 'history', error: 'Error', level: 'error', event: 'index.rpc_failed' },
      { method: 'history', error: 'Error', level: 'error', event: 'index.rpc_failed' },
    ]);
    expect(careless.lines[0]).toContain('[redacted]');
    expect(careless.logs[0]?.authorization).toBe('[redacted]');
    // Request lines never carry a query string (the cursor and viewer markers were in queries).
    const requestLines = h.log.logs.filter((l) => l.event === 'request');
    expect(requestLines.length).toBeGreaterThan(5);
    expect(requestLines.every((l) => !JSON.stringify(l).includes('?'))).toBe(true);

    const needles = [...secrets, ADMIN_TOKEN, BEARER_MARKER, BAD_CURSOR_KEY, cursorHex.toUpperCase()];
    expect(needles.length).toBeGreaterThanOrEqual(9);
    for (const line of lines) {
      for (const needle of [...needles, TRACK_MARKER]) {
        expect([needle, line.includes(needle)]).toEqual([needle, false]);
      }
    }
    const errors = responses.filter((r) => r.status >= 400);
    expect(errors.map((r) => r.status).sort()).toEqual([400, 404, 404, 422, 500]);
    for (const r of errors) {
      for (const needle of needles)
        expect([r.status, needle, r.text.includes(needle)]).toEqual([r.status, needle, false]);
      expect(r.text).not.toContain(TRACK_MARKER);
    }
    expect(meta.text).not.toContain(BEARER_MARKER);
  });
});
