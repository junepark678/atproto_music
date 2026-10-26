// W5-01 admin, ported by N4-03 from the Workers TCP admin route to the admin
// unix socket of the Node process (ADR 0005 §3.11, §14.4; M6.2.2/metrics_auth,
// whose A16 metrics are the admin status). run() (N3-07) is driven in-process
// with an injected exit, frozen clock, seeded randomness, manual timers, a
// signal emitter, a 200 ms busy timeout and drain window, the empty fixture
// transport, a refusing Jetstream connector and a statfs stub: it opens the
// database file, binds the socket (a 0700 directory holding a 0600 socket),
// migrates, composes and listens on 127.0.0.1:0.
//
// Filesystem permissions are the socket's authentication, so there is no
// token: what this suite proves is that the TCP listener never serves an admin
// route (whatever method or bearer is presented, the JSON 404 before routing,
// with nothing written), and that the socket serves the AdminStatus shape of a
// fresh index plus the host half, reflects work, and keeps the strict bodies.

import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/do/schema';
import type { StatfsFn } from '../../src/node/disk';
import { type ExitCode, type RunningServer, run } from '../../src/node/run';
import { captureLog, manualTimers, refusingJetstream, testSecretsDocument } from '../node/support/app';
import { TEST_BUSY_TIMEOUT_MS } from '../node/support/node-db';
import { BOB, type HttpResult, harnessEnv, rawRequest, schema, T0, UUID } from './support';

const ORIGINAL_FETCH = globalThis.fetch;
const BEARER = 'admin-token-0123456789abcdef0123456789abcdef';
/** Plenty of free space, so readiness raises no low_disk and a backup passes its floor. */
const ROOMY: StatfsFn = () => ({ bavail: 1n << 30n, bsize: 4096n });

interface Started {
  server: RunningServer;
  result: Promise<ExitCode>;
  exits: ExitCode[];
  log: ReturnType<typeof captureLog>;
  dir: string;
}

const started: Started[] = [];

afterEach(async () => {
  for (const s of started.splice(0)) {
    await s.server.shutdown('SIGTERM');
    await s.result;
    rmSync(s.dir, { recursive: true, force: true });
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

async function startProcess(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-admin-'));
  const distDir = join(dir, 'web', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>atmusic</title>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const exits: ExitCode[] = [];
  const log = captureLog();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    ready = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', '--init'],
    env: { ...harnessEnv(dir), ATMUSIC_ASSETS_DIR: distDir, ATMUSIC_SECRETS_FILE: secrets },
    exit: (code) => exits.push(code),
    clock: fixedClock(),
    random: seededRandom(0x5eed),
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: () => {},
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    timers: manualTimers(),
    statfs: ROOMY,
    signals: new EventEmitter(),
    onReady: (s) => ready(s),
  });
  const first = await Promise.race([server, result.then((code) => code)]);
  if (typeof first === 'number') throw new Error(`run() exited ${first} before it was ready`);
  const s = { server: first, result, exits, log, dir };
  started.push(s);
  return s;
}

/** One request over the admin unix socket. */
function viaSocket(socketPath: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
          resolve({ status: res.statusCode ?? 0, headers, text, body: text === '' ? null : JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function errorOf(body: unknown) {
  return (body as { error: { code: string; message: string; requestId: string; fields?: Record<string, string> } })
    .error;
}

/** Every row of every table, for "nothing was written" comparisons. */
function dumpAll(s: RunningServer): string {
  const names = s.db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r.name);
  return JSON.stringify(Object.fromEntries(names.map((t) => [t, s.db.all(`SELECT * FROM "${t}" ORDER BY rowid`)])));
}

const TCP_ADMIN: Array<[method: string, path: string, body?: unknown]> = [
  ['GET', '/internal/admin/status'],
  ['HEAD', '/internal/admin/status'],
  ['POST', '/internal/admin/status'],
  ['POST', '/internal/admin/pitr', { atMs: T0 - 60_000 }],
  ['POST', '/internal/admin/resnapshot', { did: BOB }],
  ['POST', '/internal/admin/backup'],
  ['GET', '/internal/admin'],
  ['GET', '/internal'],
  ['GET', '/admin/status'],
];

describe('worker/src/node/admin-socket.ts', () => {
  it('admin status over the unix socket returns the AdminStatus shape of a fresh index, and /internal/admin/status on the TCP listener is the JSON 404', async () => {
    const { server, log } = await startProcess();
    const socketPath = server.adminSocket;
    // Filesystem permissions are the authentication: a 0600 socket in a 0700 directory.
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);

    // The TCP listener: every admin path, every method, any bearer — the JSON 404,
    // and nothing is written.
    const before = dumpAll(server);
    for (const [method, path, body] of TCP_ADMIN) {
      for (const auth of [undefined, `Bearer ${BEARER}`, 'Basic YWRtaW46YWRtaW4=']) {
        const r = await rawRequest(server.address, path, {
          method,
          headers: {
            ...(auth === undefined ? {} : { authorization: auth }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const label = `${method} ${path} ${auth ?? '-'}`;
        expect([label, r.status]).toEqual([label, 404]);
        expect(r.headers.get('x-request-id'), label).toMatch(UUID);
        if (method !== 'HEAD') {
          expect([label, errorOf(r.body).code, schema('Error', r.body)]).toEqual([label, 'not_found', 'valid']);
          expect(errorOf(r.body).requestId).toBe(r.headers.get('x-request-id'));
          expect(r.text).not.toContain(BEARER);
        }
      }
    }
    expect(dumpAll(server)).toBe(before);
    // The dispatcher logs those as `(internal)`, never by path or header.
    const internal = log.logs.filter((l) => l.event === 'request' && l.route === '(internal)');
    expect(internal).toHaveLength(TCP_ADMIN.filter(([, p]) => p.startsWith('/internal')).length * 3);
    expect(JSON.stringify(log.logs)).not.toContain(BEARER);

    // The socket: the exact AdminStatus shape of a fresh index, plus the host half.
    const fresh = await viaSocket(socketPath, 'GET', '/admin/status');
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('x-request-id')).toMatch(UUID);
    const body = fresh.body as Record<string, unknown>;
    const { schema: schemaState, indexing, ingest, hints, jobs, counters, ...host } = body;
    expect({ schema: schemaState, indexing, ingest, hints, jobs, counters }).toEqual({
      schema: { status: 'ready', version: SCHEMA_VERSION },
      indexing: { state: 'stale', caughtUp: false, lastIndexedAt: null, lagSeconds: null },
      ingest: {
        mode: 'off',
        cursor: null,
        lastEventTimeUs: null,
        connected: false,
        pendingGap: true,
        hostIndex: 0,
      },
      hints: { total: 0, due: 0 },
      jobs: { snapshot: {}, status: {}, identity: {} },
      counters: [],
    });
    expect(schema('Indexing', indexing)).toBe('valid');
    expect(Object.keys(host).sort()).toEqual([
      'backup',
      'disk',
      'links',
      'oauthSessions',
      'queues',
      'uploads',
      'warnings',
    ]);
    expect(host).toMatchObject({
      backup: { ageMs: null },
      queues: { outbox: {}, forward: {}, imports: {} },
      links: {},
      oauthSessions: [],
      disk: { freeBytes: 2 ** 30 * 4096, low: false },
      warnings: [],
    });
    // The same answer IndexCore gives for its half.
    expect({ schema: schemaState, indexing, ingest, hints, jobs, counters }).toEqual(
      JSON.parse(JSON.stringify(await server.app.core.adminStatus())),
    );

    // Work shows up: an admitted DID (through the public TCP route), its snapshot job and the counters.
    const notify = await rawRequest(server.address, '/api/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: BOB }),
    });
    expect(notify.status).toBe(202);
    const busy = await viaSocket(socketPath, 'GET', '/admin/status');
    expect(busy.body).toMatchObject({
      jobs: { snapshot: { pending: 1 }, status: {}, identity: {} },
      counters: [{ name: 'admitted', label: 'notify', value: 1 }],
    });

    // POST /admin/resnapshot: strict body, then the index's scheduling outcome.
    const badBody = await viaSocket(socketPath, 'POST', '/admin/resnapshot', { did: BOB, extra: 1 });
    expect([badBody.status, errorOf(badBody.body).code]).toEqual([422, 'validation_failed']);
    const badDid = await viaSocket(socketPath, 'POST', '/admin/resnapshot', { did: 'nope' });
    expect(badDid.status).toBe(422);
    expect(errorOf(badDid.body).fields).toHaveProperty('did');
    const unknown = await viaSocket(socketPath, 'POST', '/admin/resnapshot', {
      did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect([unknown.status, errorOf(unknown.body).code]).toEqual([404, 'not_found']);
    const again = await viaSocket(socketPath, 'POST', '/admin/resnapshot', { did: BOB });
    expect([again.status, again.body]).toEqual([202, { did: BOB, status: 'already' }]);
    expect(server.db.all("SELECT did, state FROM repo_jobs WHERE kind = 'snapshot'")).toEqual([
      { did: BOB, state: 'pending' },
    ]);
    // A wrong method is 405 with Allow; an unknown path (there is no PITR on Node) is 404.
    const wrong = await viaSocket(socketPath, 'GET', '/admin/resnapshot');
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'POST']);
    const pitr = await viaSocket(socketPath, 'POST', '/admin/pitr', { atMs: T0 - 60_000 });
    expect([pitr.status, errorOf(pitr.body).code]).toEqual([404, 'not_found']);

    // A manual backup through the socket replaces the Workers PITR: a real file, recorded.
    const backup = await viaSocket(socketPath, 'POST', '/admin/backup');
    expect(backup.status).toBe(200);
    expect(backup.body).toMatchObject({ status: 'ok', kind: 'manual' });
    const path = (backup.body as { path: string }).path;
    expect(existsSync(path)).toBe(true);
    expect(server.db.all("SELECT kind, ok, path, error FROM backup_runs WHERE kind = 'manual'")).toEqual([
      { kind: 'manual', ok: 1, path, error: null },
    ]);
    const after = await viaSocket(socketPath, 'GET', '/admin/status');
    expect((after.body as { backup: { ageMs: number | null } }).backup.ageMs).toBe(0);

    // The process is still healthy on TCP.
    const ready = await rawRequest(server.address, '/health/ready');
    expect([ready.status, ready.body]).toEqual([200, { status: 'ready' }]);
  });
});
