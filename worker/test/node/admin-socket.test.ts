// The admin interface on a unix socket (ADR 0005 §3.11, §14.4, §14.5; N3-07),
// through run() in-process: the socket's modes, the status route with backup
// age and queue depths, a manual backup, prune-kid, and the TCP listener that
// never serves admin routes.

import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRevocationLog } from '../../src/app/revocations';
import { bytesEqualConstantTime, constantTimeEqual } from '../../src/http/admin';
import { BACKUP_FILE } from '../../src/node/backup';
import { type ExitCode, type RunningServer, run } from '../../src/node/run';
import { captureLog, manualTimers, refusingJetstream, testEnv, testSecretsDocument } from './support/app';
import { TEST_BUSY_TIMEOUT_MS } from './support/node-db';

const ORIGINAL_FETCH = globalThis.fetch;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Started {
  server: RunningServer;
  clock: FixedClock;
  dir: string;
  result: Promise<ExitCode>;
}

async function startServer(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-admin-'));
  dirs.push(dir);
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const clock = fixedClock();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    ready = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', '--init'],
    env: { ...testEnv(dir), ATMUSIC_ASSETS_DIR: dist, ATMUSIC_SECRETS_FILE: secrets },
    exit: () => {},
    clock,
    random: seededRandom(11),
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: 200,
    log: captureLog().logger,
    stdout: () => {},
    stderr: () => {},
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    timers: manualTimers(),
    signals: new EventEmitter(),
    onReady: (s) => ready(s),
  });
  const started = await Promise.race([server, result.then((code) => Promise.reject(new Error(`run exited ${code}`)))]);
  cleanups.push(async () => {
    await started.shutdown('SIGTERM');
    await result;
  });
  return { server: started, clock, dir, result };
}

interface Answer {
  status: number;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function request(
  target: { socketPath: string } | { port: number },
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const where =
      'socketPath' in target
        ? { socketPath: target.socketPath }
        : { host: '127.0.0.1', port: target.port, headers: { host: `127.0.0.1:${target.port}` } };
    const req = http.request(
      {
        ...where,
        method,
        path,
        agent: false,
        headers: {
          ...('headers' in where ? where.headers : {}),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>,
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function insertOperation(s: RunningServer, id: string, state: string): void {
  s.db.run(
    `INSERT INTO operations(id, did, kind, origin, priority, collection, state, due_at, created_at_ms, updated_at_ms)
     VALUES (?, 'did:plc:abcdefghijklmnopqrstuvwx', 'scrobble.create', 'web', 1, 'com.example.atmusic.scrobble', ?, 0, 0, 0)`,
    id,
    state,
  );
}

describe('admin socket', () => {
  it('GET /admin/status over the 0600 unix socket returns adminStatus with backup age and queue depths; POST /admin/backup creates a backup', async () => {
    const { server, clock, dir } = await startServer();
    const socketPath = server.adminSocket;
    expect(socketPath).toBe(join(dir, 'run', 'atmusic', 'admin.sock'));
    // Filesystem permissions are the authentication.
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run', 'atmusic')).mode & 0o777).toBe(0o700);

    insertOperation(server, 'op1', 'queued');
    insertOperation(server, 'op2', 'queued');
    insertOperation(server, 'op3', 'failed');

    const before = await request({ socketPath }, 'GET', '/admin/status');
    expect(before.status).toBe(200);
    expect(before.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    // The core half (IndexCore.adminStatus) ...
    expect(before.json.schema).toEqual({ status: 'ready', version: 2 });
    expect(before.json).toHaveProperty('ingest.mode', 'off');
    expect(before.json).toHaveProperty('hints');
    expect(Array.isArray(before.json.counters)).toBe(true);
    // ... and the host half.
    expect(before.json.queues).toEqual({ outbox: { failed: 1, queued: 2 }, forward: {}, imports: {} });
    expect(before.json.backup).toMatchObject({ ageMs: null, lastSuccess: null, lastRun: null });
    expect(before.json.uploads).toEqual({ dir: join(dir, 'state', 'imports'), bytes: 0 });
    expect(before.json.disk).toMatchObject({ path: join(dir, 'state'), minFreeBytes: 2_147_483_648 });
    expect(typeof (before.json.disk as { freeBytes: unknown }).freeBytes).toBe('number');
    expect(Array.isArray(before.json.warnings)).toBe(true);

    const backup = await request({ socketPath }, 'POST', '/admin/backup');
    expect(backup.status).toBe(200);
    expect(backup.json).toMatchObject({ status: 'ok', kind: 'manual', startedAtMs: clock.nowMs() });
    const path = backup.json.path as string;
    expect(path).toBe(join(dir, 'state', 'backups', 'atmusic-20260115T1200Z.db'));
    expect(BACKUP_FILE.test('atmusic-20260115T1200Z.db')).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(backup.json.bytes).toBe(statSync(path).size);
    expect(server.db.all('SELECT kind, ok, error, path FROM backup_runs')).toEqual([
      { kind: 'manual', ok: 1, error: null, path },
    ]);

    clock.advance(90_000);
    const after = await request({ socketPath }, 'GET', '/admin/status');
    expect(after.json.backup).toMatchObject({
      ageMs: 90_000,
      lastSuccess: { kind: 'manual', file: 'atmusic-20260115T1200Z.db', ageMs: 90_000, bytes: backup.json.bytes },
      lastRun: { kind: 'manual', ok: true, error: null },
      files: { regular: 1, preMigration: [], preRestore: [] },
    });

    // Errors: unknown path, wrong method.
    expect((await request({ socketPath }, 'GET', '/admin/nope')).status).toBe(404);
    const wrong = await request({ socketPath }, 'GET', '/admin/backup');
    expect([wrong.status, wrong.headers.allow]).toEqual([405, 'POST']);

    // The portable constant-time compare works on Node (no subtle.timingSafeEqual here).
    expect(typeof (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual).toBe('undefined');
    expect(await constantTimeEqual('x'.repeat(40), 'x'.repeat(40))).toBe(true);
    expect(await constantTimeEqual('x'.repeat(40), `${'x'.repeat(39)}y`)).toBe(false);
    expect(await constantTimeEqual('short', 'x'.repeat(4096))).toBe(false);
    expect(bytesEqualConstantTime(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);

    // The TCP listener never serves admin routes, under either prefix.
    expect((await request({ port: server.address.port }, 'GET', '/internal/admin/status')).status).toBe(404);
    expect((await request({ port: server.address.port }, 'GET', '/admin/status')).status).toBe(404);
  });

  it('POST /admin/oauth/prune-kid deletes the sessions of a retired kid, journals them, and refuses a signing kid', async () => {
    const { server, dir } = await startServer();
    const socketPath = server.adminSocket;
    const now = 1_768_478_400_000;
    for (const [did, kid] of [
      ['did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', 'k0'],
      ['did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'k0'],
      ['did:plc:cccccccccccccccccccccccc', 'k1'],
    ] as const) {
      server.db.run(
        `INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
        did,
        `u${did.slice(8, 12)}`,
        now,
        now,
      );
      server.db.run(
        `INSERT INTO oauth_sessions(did, ciphertext, key_id, client_kid, last_refresh_ms, created_at_ms, updated_at_ms)
         VALUES (?, X'00', 'e1', ?, ?, ?, ?)`,
        did,
        kid,
        now,
        now,
        now,
      );
    }
    // k1 is the configured signing key: refused, nothing deleted.
    const refused = await request({ socketPath }, 'POST', '/admin/oauth/prune-kid', { kid: 'k1' });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ error: { code: 'validation_failed', fields: { kid: expect.any(String) } } });
    expect(server.db.one<{ n: number }>('SELECT count(*) AS n FROM oauth_sessions')?.n).toBe(3);

    const pruned = await request({ socketPath }, 'POST', '/admin/oauth/prune-kid', { kid: 'k0' });
    expect([pruned.status, pruned.json]).toEqual([200, { kid: 'k0', sessions: 2 }]);
    expect(server.db.all('SELECT did, client_kid FROM oauth_sessions')).toEqual([
      { did: 'did:plc:cccccccccccccccccccccccc', client_kid: 'k1' },
    ]);
    expect(server.db.all('SELECT did, oauth_status FROM accounts ORDER BY did')).toEqual([
      { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', oauth_status: 'reauth_required' },
      { did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', oauth_status: 'reauth_required' },
      { did: 'did:plc:cccccccccccccccccccccccc', oauth_status: 'active' },
    ]);
    const journal = join(dir, 'state', 'revocations.log');
    expect(existsSync(journal)).toBe(true);
    expect(parseRevocationLog(readFileSync(journal, 'utf8')).entries.map((e) => [e.kind, e.did])).toEqual([
      ['oauth_session', 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'],
      ['oauth_session', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'],
    ]);
    // A malformed body is the error envelope.
    const bad = await request({ socketPath }, 'POST', '/admin/oauth/prune-kid', { kid: 'k0', extra: 1 });
    expect(bad.status).toBe(422);
  });
});
