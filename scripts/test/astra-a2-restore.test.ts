// biome-ignore-all lint/suspicious/noExplicitAny: restored production fixtures adapt injected service dependencies as in accepted independent tests
// scripts/admin/restore.ts (ADR 0005 §14.5, §14.3; plan cases M6.3.1/
// restore_state and M6.3.1/wrong_key; N4-02).
//
// Each test builds a "live" world on a temporary state directory with the real
// modules: a migrated database (worker/src/node/sqlite-db.ts), the revocation
// journal (app/revocations.ts FileRevocations), accounts, web sessions, sealed
// OAuth sessions (bff/oauth-stores.ts), app passwords, a sealed linked
// account, queued operations and a few derived index rows, then takes a real
// online backup (node/backup.ts) and changes the live state after it. The
// restore runs through the CLI's main() with an injected fake systemd: its
// `systemctl --user` answers from unit states the test controls, and its
// `start` really starts the server in-process (node/run.ts run(), with the
// frozen clock, seeded randomness, manual timers, the empty fixture router
// transport and an ephemeral 127.0.0.1 port), so "reports ready" is the real
// /health/ready. The crash test runs the restore in a child process and kills
// it with SIGKILL at each swap step. No real systemctl, network or
// 127.2.0.1:8888 is involved.

import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { connect, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { afterEach, expect, it } from 'vitest';
import { FileRevocations, revocationLogPath } from '../../worker/src/app/revocations.ts';
import { OAuthSessionStore } from '../../worker/src/bff/oauth-stores.ts';
import { createWebSessions } from '../../worker/src/bff/sessions.ts';
import { ensureAccount, renameAccount } from '../../worker/src/credentials/accounts.ts';
import { createAppPassword, revokeAppPassword } from '../../worker/src/credentials/app-passwords.ts';
import { type Box, createBox } from '../../worker/src/crypto/box.ts';
import { executeAuthorizedRemovals } from '../../worker/src/do/ingest/live-pending-removals';
import { migrate } from '../../worker/src/do/migrate.ts';
import { SCHEMA_VERSION } from '../../worker/src/do/schema.ts';
import { applyRecordProof } from '../../worker/src/do/write/apply-record.ts';
import { deleteLink, saveLink } from '../../worker/src/forward/links.ts';
import { createBackups } from '../../worker/src/node/backup.ts';
import { type ExitCode, type RunningServer, run } from '../../worker/src/node/run.ts';
import { parseSecrets, type Secrets } from '../../worker/src/node/secrets.ts';
import { openSqliteDb, type SqliteDb } from '../../worker/src/node/sqlite-db.ts';
import {
  captureLog,
  manualTimers,
  refusingJetstream,
  testEnv,
  testSecretsDocument,
} from '../../worker/test/node/support/app.ts';
import { authorizedLiveOptions } from '../../worker/test/write/support.ts';
import { type CommandResult, main, type RestoreStep } from '../admin/restore.ts';

const _REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUSY_MS = 200;
const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const DID_C = 'did:plc:cccccccccccccccccccccccc';
const PREFIX = 'com.example.atmusic';
const LASTFM_SK = 'lastfm-session-key-of-alice-0123456789';
const ORIGINAL_FETCH = globalThis.fetch;

// ---------------------------------------------------------------------------
// Fixture world

interface World {
  dir: string;
  state: string;
  dbPath: string;
  backupPath: string;
  secretsFile: string;
  secretsDoc: Record<string, unknown>;
  dist: string;
  clock: FixedClock;
  /** Values the tests look up afterwards. */
  ids: Record<string, string>;
  /** The sealed OAuth session of alice as the backup holds it. */
  backupCiphertextA: Uint8Array;
}

const dirs: string[] = [];
const running: Array<{ result: Promise<ExitCode>; server: RunningServer | null }> = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    if (r.server !== null) await r.server.shutdown('SIGTERM');
    await r.result;
  }
  for (const s of netServers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSecrets(path: string, doc: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(doc));
  chmodSync(path, 0o600);
}

/** A secrets document whose only encryption key is `e2` (the backup's sessions are sealed with e1). */
function _secretsWithoutE1(): Record<string, unknown> {
  return { ...testSecretsDocument(), encryptionKeys: [{ id: 'e2', key: Buffer.alloc(32, 0x7e).toString('base64') }] };
}

function savedSession(did: string, refresh: string): never {
  return {
    dpopJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    authMethod: { method: 'private_key_jwt', kid: 'k1' },
    tokenSet: {
      iss: 'https://as.example.test',
      sub: did,
      aud: 'https://pds.example.test',
      scope: 'atproto',
      access_token: `access-${did}`,
      refresh_token: refresh,
      token_type: 'DPoP',
    },
  } as never;
}

function ts30(iso: string): string {
  // 2026-01-15T11:00:00 → 2026-01-15T11:00:00.000000000Z (30 characters).
  return `${iso}.000000000Z`;
}

function insertScrobble(db: SqliteDb, did: string, rkey: string, at: string): void {
  db.run(
    `INSERT INTO scrobbles (uri, cid, did, rkey, revision, artist, track, album, listened_at, created_at, indexed_at,
       artist_key, track_key) VALUES (?, ?, ?, ?, '3l', 'Artist', ?, NULL, ?, ?, ?, 'artist', ?)`,
    `at://${did}/${PREFIX}.scrobble/${rkey}`,
    `bafy${rkey}`,
    did,
    rkey,
    `Track ${rkey}`,
    ts30(at),
    `${at}Z`,
    `${at}Z`,
    `track ${rkey}`,
  );
}

function insertOperation(db: SqliteDb, id: string, did: string, now: number): void {
  db.run(
    `INSERT INTO operations (id, did, kind, origin, priority, collection, rkey, record_json, digest, state, due_at,
       created_at_ms, updated_at_ms) VALUES (?, ?, 'scrobble.create', 'lastfm', 1, ?, ?, '{}', 'digest', 'queued', ?, ?, ?)`,
    id,
    did,
    `${PREFIX}.scrobble`,
    `rk${id}`,
    now,
    now,
    now,
  );
}

interface WorldOptions {
  /** Leave the live database open with its newest commits only in the WAL (for the crash test). */
  keepWal?: boolean;
  /** Extra SQL run on the live database after the backup. */
  liveSql?: string[];
  /** SQL run immediately before the backup for stale-backup merge coverage. */
  backupSql?: string[];
}

/**
 * The live world (module comment). Before the backup (12:00): accounts alice
 * and bob, alice's web session, OAuth sessions of both, app passwords P1
 * (alice) and P3 (bob), alice's Last.fm link, operation op1, scrobble S1, a
 * follow alice→bob, the Jetstream cursor 1000. After it (12:01): scrobble S2,
 * the follow deleted, cursor 2000, alice renamed to alice2, carol signs in
 * (account, OAuth and web session), app password P2, alice signs out, P1
 * revoked, operation op2, and with `journalLinkAndOauth`: alice's link
 * deleted and bob's OAuth session deleted.
 */
async function buildWorld(
  options: WorldOptions & { journalLinkAndOauth?: boolean } = {},
): Promise<World & { live: SqliteDb | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-restore-'));
  dirs.push(dir);
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>atmusic</title>');
  const secretsFile = join(dir, 'secrets.json');
  const secretsDoc = testSecretsDocument();
  writeSecrets(secretsFile, secretsDoc);
  const secrets = parseSecrets(secretsDoc);
  const clock = fixedClock();
  const random = seededRandom(0x5eed);
  const log = captureLog().logger;
  const dbPath = join(state, 'atmusic.db');
  let db = openSqliteDb(dbPath, { create: true, busyTimeoutMs: BUSY_MS });
  expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  const journal = new FileRevocations({ path: revocationLogPath(state), clock });
  const box = createBox(secrets.encryptionKeys, random);
  let deps = { db, clock, random, revocations: journal };
  let sessions = createWebSessions(deps);
  let oauth = new OAuthSessionStore({ db, clock, box, log, revocations: journal });
  const ids: Record<string, string> = {};

  // --- Before the backup ------------------------------------------------------
  db.tx(() => {
    for (const did of [DID_A, DID_B])
      db.run("INSERT INTO users (did, handle, joined_at) VALUES (?, NULL, '2026-01-01T00:00:00Z')", did);
    insertScrobble(db, DID_A, 's1', '2026-01-15T11:00:00');
    db.run(
      `INSERT INTO follows (uri, cid, actor, subject, revision, created_at, indexed_at) VALUES (?, 'bafyf', ?, ?, '3l', ?, ?)`,
      `at://${DID_A}/${PREFIX}.follow/f1`,
      DID_A,
      DID_B,
      ts30('2026-01-15T11:00:00'),
      '2026-01-15T11:00:00Z',
    );
    db.run("UPDATE ingest_checkpoint SET cursor = 1000 WHERE stream = 'jetstream'");
  });
  ensureAccount(deps, { did: DID_A, verifiedHandle: 'alice.test' });
  ensureAccount(deps, { did: DID_B, verifiedHandle: 'bob.test' });
  ids.webA = sessions.create(DID_A).token;
  oauth.set(DID_A, savedSession(DID_A, 'refresh-a1'));
  oauth.set(DID_B, savedSession(DID_B, 'refresh-b1'));
  const p1 = createAppPassword(deps, { did: DID_A, label: 'pano' });
  ids.p1 = p1.password;
  ids.p1Id = p1.id;
  ids.p3 = createAppPassword(deps, { did: DID_B, label: 'phone' }).password;
  ids.link = saveLink(
    { db, clock, random, box },
    { did: DID_A, service: 'lastfm', remoteUser: 'alice', credential: LASTFM_SK },
  ).link.id;
  insertOperation(db, 'op1', DID_A, clock.nowMs());

  for (const sql of options.backupSql ?? []) db.exec(sql);

  const backups = createBackups({ db, dir: join(state, 'backups'), clock, log, minFreeBytes: 0, revocations: journal });
  const outcome = await backups.run('manual');
  if (outcome.status !== 'ok') throw new Error(`backup failed: ${JSON.stringify(outcome)}`);
  const backupPath = outcome.path;
  const backupCiphertextA = new Uint8Array(
    (
      db.one<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM oauth_sessions WHERE did = ?', DID_A) as {
        ciphertext: ArrayBuffer;
      }
    ).ciphertext,
  );

  // Reopen (closing checkpoints the WAL), so every later commit lives in a fresh WAL.
  db.close();
  db = openSqliteDb(dbPath, { busyTimeoutMs: BUSY_MS });
  deps = { db, clock, random, revocations: journal };
  sessions = createWebSessions(deps);
  oauth = new OAuthSessionStore({ db, clock, box, log, revocations: journal });

  // --- After the backup -------------------------------------------------------
  clock.advance(60_000);
  db.tx(() => {
    insertScrobble(db, DID_A, 's2', '2026-01-15T12:00:30');
    db.run('DELETE FROM follows');
    db.run("UPDATE ingest_checkpoint SET cursor = 2000 WHERE stream = 'jetstream'");
  });
  expect(renameAccount(deps, { did: DID_A, username: 'alice2' })).toMatchObject({ ok: true, changed: true });
  db.run("INSERT INTO users (did, handle, joined_at) VALUES (?, NULL, '2026-01-15T12:01:00Z')", DID_C);
  ensureAccount(deps, { did: DID_C, verifiedHandle: 'carol.test' });
  oauth.set(DID_C, savedSession(DID_C, 'refresh-c1'));
  ids.webC = sessions.create(DID_C).token;
  ids.p2 = createAppPassword(deps, { did: DID_A, label: 'web scrobbler' }).password;
  expect(sessions.logout(ids.webA)).toBe(true);
  expect(revokeAppPassword(deps, DID_A, ids.p1Id)).toBe(true);
  insertOperation(db, 'op2', DID_A, clock.nowMs());
  if (options.journalLinkAndOauth === true) {
    expect(deleteLink({ db, revocations: journal }, DID_A, ids.link)).toBe(true);
    oauth.del(DID_B);
  }
  for (const sql of options.liveSql ?? []) db.exec(sql);
  journal.close();

  const world = { dir, state, dbPath, backupPath, secretsFile, secretsDoc, dist, clock, ids, backupCiphertextA };
  if (options.keepWal === true) return { ...world, live: db };
  db.close();
  return { ...world, live: null };
}

/** Overwrites the live database with bytes that are not SQLite (a failed disk). */
function _corruptLive(world: World): Buffer {
  const garbage = Buffer.alloc(8192, 0x5a);
  writeFileSync(world.dbPath, garbage);
  rmSync(`${world.dbPath}-wal`, { force: true });
  return garbage;
}

/**
 * Turns the world's open live database (buildWorld keepWal) into a crash-time
 * pair: the main file and its WAL as they were while it was open, with every
 * post-backup commit only in the WAL (no checkpoint).
 */
function _crashConsistentLive(world: World & { live: SqliteDb | null }): void {
  const live = world.live as SqliteDb;
  const copy = join(world.dir, 'crash');
  mkdirSync(copy);
  copyFileSync(world.dbPath, join(copy, 'atmusic.db'));
  copyFileSync(`${world.dbPath}-wal`, join(copy, 'atmusic.db-wal'));
  live.close();
  rmSync(world.dbPath);
  rmSync(`${world.dbPath}-wal`, { force: true });
  rmSync(`${world.dbPath}-shm`, { force: true });
  copyFileSync(join(copy, 'atmusic.db'), world.dbPath);
  copyFileSync(join(copy, 'atmusic.db-wal'), `${world.dbPath}-wal`);
  // The main file alone does not have the post-backup rows: they live in the WAL.
  const mainOnly = join(copy, 'main-only.db');
  copyFileSync(join(copy, 'atmusic.db'), mainOnly);
  expect(query(mainOnly, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
}

/** Runs `read` on a scratch copy of `path` and its WAL, so the inspected files stay as they are. */
function _onScratchCopy<T>(world: World, label: string, path: string, read: (db: sqlite.DatabaseSync) => T): T {
  const scratch = join(world.dir, `scratch-${label}`);
  mkdirSync(scratch);
  copyFileSync(path, join(scratch, 'x.db'));
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, join(scratch, 'x.db-wal'));
  const db = new sqlite.DatabaseSync(join(scratch, 'x.db'));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function _integrity(db: sqlite.DatabaseSync, table?: string): string[] {
  const sql = table === undefined ? 'PRAGMA integrity_check' : `PRAGMA integrity_check("${table}")`;
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  } catch (error) {
    return [`error: ${(error as { errstr?: string }).errstr ?? String(error)}`];
  }
}

/** The page numbers a WAL file holds frames for (32-byte header, then 24-byte frame headers). */
function _walPages(wal: Buffer, pageSize: number): Set<number> {
  const pages = new Set<number>();
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) pages.add(wal.readUInt32BE(at));
  return pages;
}

/** Overwrites one page of the main database file in place (a bad sector). */
function _damagePage(path: string, page: number, pageSize: number): void {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0x07), 0, pageSize, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// The server and the fake systemd

async function _freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Started {
  server: RunningServer;
  logLines: string[];
}

/** run() of node/run.ts on the world's state directory, as atmusic.service would. */
async function startServer(world: World, port: number, secretsFile = world.secretsFile): Promise<Started> {
  const log = captureLog();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((r) => {
    ready = r;
  });
  const entry: { result: Promise<ExitCode>; server: RunningServer | null } = {
    result: Promise.resolve(0),
    server: null,
  };
  entry.result = run({
    argv: ['node', 'main.mjs'],
    env: {
      ...testEnv(world.dir),
      STATE_DIRECTORY: world.state,
      ATMUSIC_LISTEN: `127.0.0.1:${port}`,
      ATMUSIC_ASSETS_DIR: world.dist,
      ATMUSIC_SECRETS_FILE: secretsFile,
      ATMUSIC_SIGNIN_DIDS: (excludedAtStartup ? [DID_B, DID_C] : [DID_A, DID_B, DID_C]).join(','),
      LISTENBRAINZ_API_ROOT: 'https://lb.example.test/',
    },
    clock: world.clock,
    random: seededRandom(0x77),
    busyTimeoutMs: BUSY_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: (t) => log.lines.push(t),
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: restoreTransport,
    connectJetstream: refusingJetstream(),
    timers: useRealTimers ? nodeTimers : manualTimers(),
    signals: new EventEmitter(),
    onReady: (s) => ready(s),
  });
  running.push(entry);
  const started = await Promise.race([server, entry.result.then((code) => code)]);
  if (typeof started === 'number') throw new Error(`run() exited ${started}: ${log.lines.join('\n')}`);
  entry.server = started;
  return { server: started, logLines: log.lines };
}

async function stopServer(server: RunningServer): Promise<void> {
  const entry = running.find((r) => r.server === server);
  await server.shutdown('SIGTERM');
  if (entry !== undefined) {
    await entry.result;
    running.splice(running.indexOf(entry), 1);
  }
}

function _accepts(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
  });
}

type UnitState = 'active' | 'inactive' | 'failed';

/**
 * A fake `systemctl --user` for atmusic.socket and atmusic.service. The socket
 * unit is a listener on `socketPort` that counts the connections that would
 * socket-activate the service; the service is run() on `servicePort`.
 */
class FakeSystemd {
  readonly units: Record<string, UnitState> = { 'atmusic.socket': 'inactive', 'atmusic.service': 'inactive' };
  readonly events: string[] = [];
  activations = 0;
  server: Started | null = null;
  private listener: NetServer | null = null;

  constructor(
    private readonly world: World,
    private readonly options: {
      servicePort: number | null;
      socketPort?: number;
      /** A unit `stop` leaves running (a stuck stop). */
      stuck?: string;
      secretsFile?: string;
    },
  ) {}

  private async openSocket(): Promise<void> {
    if (this.options.socketPort === undefined) return;
    const listener = createNetServer((socket) => {
      this.activations++;
      socket.destroy();
    });
    await new Promise<void>((r) => listener.listen(this.options.socketPort, '127.0.0.1', () => r()));
    netServers.push(listener);
    this.listener = listener;
  }

  async boot(): Promise<void> {
    await this.openSocket();
    this.units['atmusic.socket'] = 'active';
    if (this.options.servicePort !== null) {
      this.server = await startServer(this.world, this.options.servicePort, this.options.secretsFile);
    }
    this.units['atmusic.service'] = 'active';
  }

  readonly systemctl = async (args: readonly string[]): Promise<CommandResult> => {
    this.events.push(`systemctl ${args.join(' ')}`);
    const [verb, ...units] = args;
    if (verb === 'stop') {
      for (const unit of units) {
        if (unit === this.options.stuck) continue;
        if (unit === 'atmusic.socket' && this.listener !== null) {
          const l = this.listener;
          this.listener = null;
          await new Promise<void>((r) => l.close(() => r()));
          netServers.splice(netServers.indexOf(l), 1);
        }
        if (unit === 'atmusic.service' && this.server !== null) {
          await stopServer(this.server.server);
          this.server = null;
        }
        this.units[unit] = 'inactive';
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'is-active') {
      const states = units.map((u) => this.units[u] ?? 'inactive');
      return { code: states.every((s) => s === 'active') ? 0 : 3, stdout: `${states.join('\n')}\n`, stderr: '' };
    }
    if (verb === 'start') {
      for (const unit of units) {
        if (unit === 'atmusic.socket') await this.openSocket();
        if (unit === 'atmusic.service' && this.options.servicePort !== null) {
          this.server = await startServer(this.world, this.options.servicePort, this.options.secretsFile);
        }
        this.units[unit] = 'active';
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected systemctl ${args.join(' ')}` };
  };
}

interface Restored {
  code: number;
  stdout: string;
  stderr: string;
}

async function restoreCli(
  world: World,
  systemd: FakeSystemd,
  args: string[],
  onStep?: (step: RestoreStep) => void | Promise<void>,
): Promise<Restored> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, world.backupPath], {
    env: { HOME: join(world.dir, 'home') },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    systemctl: systemd.systemctl,
    busyTimeoutMs: BUSY_MS,
    clock: world.clock,
    readyTimeoutMs: 5000,
    onStep: async (step) => {
      systemd.events.push(`step ${step}`);
      await onStep?.(step);
    },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const baseArgs = (world: World) => ['--db', world.dbPath, '--state-dir', world.state, '--secrets', world.secretsFile];

/** Rows of a closed database file (its WAL, if any, applied; nothing is written). */
function query(path: string, sql: string, ...params: sqlite.SQLInputValue[]): Record<string, unknown>[] {
  const db = new sqlite.DatabaseSync(pathToFileURL(path));
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function boxOf(doc: Record<string, unknown>): { box: Box; secrets: Secrets } {
  const secrets = parseSecrets(doc);
  return { box: createBox(secrets.encryptionKeys, seededRandom(1)), secrets };
}

// ---------------------------------------------------------------------------

import { enqueueHints } from '../../worker/src/do/ingest/hints';
import { runDeleteSlice } from '../../worker/src/forward/delete-forwarder';
import { runForward } from '../../worker/src/forward/forwarder';
import { UpstreamPacing } from '../../worker/src/forward/upstream-pacing';
import { nodeTimers } from '../../worker/src/node/alarm';

let remoteDeletes = 0;
let _remoteSubmits = 0;
const restoreTransport = routerTransport({
  hosts: {
    'lb.example.test': async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/1/delete-listen') {
        remoteDeletes++;
        return Response.json({ status: 'ok' });
      }
      if (url.pathname === '/1/submit-listens') {
        _remoteSubmits++;
        return Response.json({ status: 'ok' });
      }
      if (url.pathname.includes('/listens'))
        return Response.json({
          payload: {
            listens: [
              {
                listened_at: 1768474800,
                recording_msid: '00000000-0000-4000-8000-000000000001',
                track_metadata: { artist_name: 'Björk', track_name: 'Jóga' },
              },
            ],
          },
        });
      return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
    },
  },
});
const random = seededRandom(555);
async function signedWorld() {
  remoteDeletes = 0;
  _remoteSubmits = 0;
  const world = await buildWorld();
  const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
  const box = boxOf(world.secretsDoc).box;
  saveLink(
    { db, clock: world.clock, random, box },
    { did: DID_A, service: 'listenbrainz', remoteUser: 'alice', credential: 'fixture-token' },
  );
  db.run('DELETE FROM operations');
  const keys = await fixtureKeys();
  const repo = new SignedRepo(DID_A, keys.alice, { clock: world.clock });
  const collection = `${PREFIX}.scrobble`,
    rkey = '3krestoreproof';
  const record = {
    $type: collection,
    artist: 'Björk',
    track: 'Jóga',
    listenedAt: '2026-01-15T11:00:00Z',
    createdAt: '2026-01-15T11:00:00Z',
  };
  const proof = async () =>
    verifyRecordProof(await repo.getRecordCar(collection, rkey), {
      did: DID_A,
      collection,
      rkey,
      signingKey: repo.key.didKey,
    });
  await repo.put(collection, rkey, record);
  const first = await proof();
  const apply = (db: SqliteDb, p: any, live = false) =>
    db.tx(() =>
      applyRecordProof(db, p, {
        prefix: PREFIX,
        receiptNs: fromMs(world.clock.nowMs()),
        nowNs: fromMs(world.clock.nowMs()),
        ...(live ? { live: authorizedLiveOptions(db, p, random).live } : {}),
      }),
    );
  apply(db, first, true);
  let delivered = 0;
  await runForward({
    db,
    clock: world.clock,
    random,
    log: { log() {} },
    box,
    pacing: new UpstreamPacing(world.clock),
    lastfm: null,
    listenbrainz: {
      submit: async () => {
        delivered++;
        return { ok: true, value: null, rate: { remaining: 100, resetInS: 0 } };
      },
    },
  } as any);
  expect(delivered).toBe(1);
  expect(
    db.one(
      "SELECT count(*) n FROM forward_outbox WHERE kind='scrobble' AND state='sent' AND link_id IN (SELECT id FROM linked_accounts WHERE service='listenbrainz')",
    ),
  ).toEqual({ n: 1 });
  const backup = async () => {
    const out = await createBackups({
      db,
      dir: join(world.state, 'backups'),
      clock: world.clock,
      log: captureLog().logger,
      minFreeBytes: 0,
    }).run('manual');
    if (out.status !== 'ok') throw Error(JSON.stringify(out));
    world.backupPath = out.path;
  };
  return { world, db, repo, proof, first, apply, backup, collection, rkey, uri: `at://${DID_A}/${collection}/${rkey}` };
}
async function realRestore(world: World) {
  const base = world.clock.nowMs(),
    wall = Date.now();
  world.clock.nowMs = () => base + Date.now() - wall;
  const systemd = new FakeSystemd(world, { servicePort: 0 });
  systemd.units['atmusic.service'] = 'active';
  systemd.units['atmusic.socket'] = 'active';
  const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
  expect(result.code, result.stderr).toBe(0);
  expect(systemd.server).not.toBeNull();
  return systemd;
}
it('D12 independent real restore startup and real host timers send positive signed pending removal without hints', async () => {
  const x = await signedWorld();
  await x.repo.delete(x.collection, x.rkey);
  const gone = await x.proof();
  x.apply(x.db, gone);
  enqueueHints(x.db, [
    {
      did: DID_A,
      collection: x.collection,
      rkey: x.rkey,
      source: 'jetstream',
      hintRev: gone.commit.rev,
      live: { operation: 'delete' },
      receiptMs: x.world.clock.nowMs(),
    },
  ]);
  expect(x.db.one('SELECT authorized_rev FROM live_pending_removals WHERE uri=?', x.uri)).toEqual({
    authorized_rev: gone.commit.rev,
  });
  x.db.run('DELETE FROM hints');
  x.db.run('DELETE FROM live_record_evidence');
  x.db.run('DELETE FROM timers');
  await x.backup();
  x.db.close();
  const systemd = await realRestore(x.world);
  await expect.poll(() => remoteDeletes, { timeout: 18000, interval: 100 }).toBe(1);
  expect(systemd.server!.server.db.one("SELECT count(*) n FROM listenbrainz_deletes WHERE state='sent'")).toEqual({
    n: 1,
  });
  console.log('D12 actual timer remote deletes', remoteDeletes);
}, 30000);

let useRealTimers = true;
it('D10 independent real restore replays both direct and delayed signed deletion with one counted upstream delete', async () => {
  useRealTimers = false;
  const x = await signedWorld();
  await x.backup();
  await x.repo.delete(x.collection, x.rkey);
  const gone = await x.proof();
  x.apply(x.db, gone);
  enqueueHints(x.db, [
    {
      did: DID_A,
      collection: x.collection,
      rkey: x.rkey,
      source: 'jetstream',
      hintRev: gone.commit.rev,
      live: { operation: 'delete' },
      receiptMs: x.world.clock.nowMs(),
    },
  ]);
  expect(x.db.one('SELECT count(*) n FROM live_pending_removals WHERE uri=?', x.uri)).toEqual({ n: 1 });
  x.db.close();
  const systemd = await realRestore(x.world);
  const db = systemd.server!.server.db;
  expect(db.one('SELECT count(*) n FROM scrobbles WHERE uri=?', x.uri)).toEqual({ n: 1 });
  expect(db.one('SELECT count(*) n FROM live_pending_removals WHERE uri=?', x.uri)).toEqual({ n: 1 });
  let attempts = 0;
  const traced = {
    all: db.all.bind(db),
    one: db.one.bind(db),
    tx: db.tx.bind(db),
    run(sql: string, ...args: any[]) {
      if (sql.includes('INSERT OR IGNORE INTO listenbrainz_deletes')) attempts++;
      return db.run(sql, ...args);
    },
  };
  x.apply(traced as any, gone, true);
  db.tx(() => executeAuthorizedRemovals(traced, { nowMs: x.world.clock.nowMs(), random, limit: 10 }));
  // The application direct path and pending settle both attempt the same event key.
  expect(attempts).toBe(2);
  expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 1 });
  expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 0 });
  let now = x.world.clock.nowMs(),
    deletes = 0;
  const clock = { nowMs: () => now };
  const deps = {
    db,
    clock,
    random,
    box: boxOf(x.world.secretsDoc).box,
    pacing: new UpstreamPacing(clock),
    client: {
      listWindowPage: async () => ({
        ok: true,
        rate: { remaining: 100, resetInS: 0 },
        value: [
          {
            listenedAt: 1768474800,
            artist: 'Björk',
            track: 'Jóga',
            recordingMsid: '00000000-0000-4000-8000-000000000001',
          },
        ],
      }),
      deleteListen: async () => {
        deletes++;
        return { ok: true, accepted: true, rate: { remaining: 100, resetInS: 0 } };
      },
    },
  };
  for (let i = 0; i < 6; i++) {
    await runDeleteSlice(deps as any);
    now += 1000;
  }
  expect(deletes).toBe(1);
  copyFileSync(`${x.world.dbPath}.pre-restore`, `${x.world.dbPath}.first-pre-restore`);
  rmSync(`${x.world.dbPath}.pre-restore`);
  const secondRestore = await restoreCli(x.world, systemd, [...baseArgs(x.world), '--no-ready-check']);
  expect(secondRestore.code, secondRestore.stderr).toBe(0);
  const replayDb = systemd.server!.server.db;
  expect(replayDb.one('SELECT count(*) n FROM scrobbles WHERE uri=?', x.uri)).toEqual({ n: 1 });
  x.apply(replayDb, gone, false);
  expect(replayDb.one('SELECT count(*) n FROM live_pending_removals WHERE uri=?', x.uri)).toEqual({ n: 1 });
  replayDb.tx(() => executeAuthorizedRemovals(replayDb, { nowMs: x.world.clock.nowMs(), random, limit: 10 }));
  for (let i = 0; i < 6; i++) {
    await runDeleteSlice({ ...deps, db: replayDb } as any);
    now += 1000;
  }
  expect(deletes).toBe(1);
  expect(replayDb.one("SELECT count(*) n FROM listenbrainz_deletes WHERE state='sent'")).toEqual({ n: 1 });
  console.log('D10 direct/delayed insert attempts', attempts, 'counted remote deletes after second restore', deletes);
  useRealTimers = true;
}, 30000);

let excludedAtStartup = false;
it.each(['revoked-link', 'new-generation', 'signin-scope'] as const)(
  'independent restored signed pending cannot escape %s',
  async (mode) => {
    useRealTimers = true;
    excludedAtStartup = mode === 'signin-scope';
    const x = await signedWorld();
    await x.repo.delete(x.collection, x.rkey);
    const gone = await x.proof();
    x.apply(x.db, gone);
    enqueueHints(x.db, [
      {
        did: DID_A,
        collection: x.collection,
        rkey: x.rkey,
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: x.world.clock.nowMs(),
      },
    ]);
    x.db.run('DELETE FROM hints');
    x.db.run('DELETE FROM live_record_evidence');
    x.db.run('DELETE FROM timers');
    await x.backup();
    const link = x.db.one<{ id: string; generation: number }>(
      "SELECT id,generation FROM linked_accounts WHERE did=? AND service='listenbrainz'",
      DID_A,
    )!;
    if (mode === 'revoked-link') {
      const journal = new FileRevocations({ path: revocationLogPath(x.world.state), clock: x.world.clock });
      expect(deleteLink({ db: x.db, revocations: journal }, DID_A, link.id)).toBe(true);
      journal.close();
    }
    if (mode === 'new-generation') {
      const replacement = saveLink(
        { db: x.db, clock: x.world.clock, random, box: boxOf(x.world.secretsDoc).box },
        { did: DID_A, service: 'listenbrainz', remoteUser: 'other-remote', credential: 'different-token' },
      );
      expect(replacement.link.generation).toBeGreaterThan(link.generation);
    }
    x.db.close();
    const systemd = await realRestore(x.world);
    const db = systemd.server!.server.db;
    await expect
      .poll(() => db.one<{ n: number }>('SELECT count(*) n FROM live_pending_removals')!.n, {
        timeout: 8000,
        interval: 100,
      })
      .toBe(0);
    await new Promise((r) => setTimeout(r, 2300));
    expect(remoteDeletes).toBe(0);
    if (mode === 'revoked-link') expect(db.one('SELECT 1 FROM linked_accounts WHERE id=?', link.id)).toBeNull();
    if (mode === 'signin-scope')
      expect(db.one('SELECT status FROM linked_accounts WHERE id=?', link.id)).toEqual({ status: 'revoked' });
    excludedAtStartup = false;
  },
  15000,
);
it('independent signed settings suppression clears only A retained work and restored B timers delete only for B', async () => {
  useRealTimers = true;
  excludedAtStartup = false;
  const x = await signedWorld();
  const keys = await fixtureKeys(),
    other = new SignedRepo(DID_B, keys.bob, { clock: x.world.clock });
  const bobKey = '3kbobpending',
    bobUri = `at://${DID_B}/${x.collection}/${bobKey}`;
  saveLink(
    { db: x.db, clock: x.world.clock, random, box: boxOf(x.world.secretsDoc).box },
    { did: DID_B, service: 'listenbrainz', remoteUser: 'bob', credential: 'bob-token' },
  );
  await other.put(x.collection, bobKey, {
    $type: x.collection,
    artist: 'Björk',
    track: 'Jóga',
    listenedAt: '2026-01-15T11:00:00Z',
    createdAt: '2026-01-15T11:00:00Z',
  });
  const verifyBob = async () =>
    verifyRecordProof(await other.getRecordCar(x.collection, bobKey), {
      did: DID_B,
      collection: x.collection,
      rkey: bobKey,
      signingKey: other.key.didKey,
    });
  x.apply(x.db, await verifyBob(), true);
  let delivered = 0;
  await runForward({
    db: x.db,
    clock: x.world.clock,
    random,
    log: { log() {} },
    box: boxOf(x.world.secretsDoc).box,
    pacing: new UpstreamPacing(x.world.clock),
    lastfm: null,
    listenbrainz: {
      submit: async () => {
        delivered++;
        return { ok: true, value: null, rate: { remaining: 100, resetInS: 0 } };
      },
    },
  } as any);
  expect(delivered).toBe(1);
  await x.repo.delete(x.collection, x.rkey);
  const goneA = await x.proof();
  x.apply(x.db, goneA);
  await other.delete(x.collection, bobKey);
  const goneB = await verifyBob();
  x.apply(x.db, goneB);
  const removals: Array<[string, string, string]> = [
    [DID_A, x.rkey, goneA.commit.rev],
    [DID_B, bobKey, goneB.commit.rev],
  ];
  for (const [did, rkey, rev] of removals)
    enqueueHints(x.db, [
      {
        did,
        collection: x.collection,
        rkey,
        source: 'jetstream',
        hintRev: rev,
        live: { operation: 'delete' },
        receiptMs: x.world.clock.nowMs(),
      },
    ]);
  expect(x.db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 2 });
  await x.repo.put(`${PREFIX}.settings`, 'self', {
    $type: `${PREFIX}.settings`,
    indexing: 'disabled',
    createdAt: '2026-01-15T11:00:00Z',
  });
  const disabled = await verifyRecordProof(await x.repo.getRecordCar(`${PREFIX}.settings`, 'self'), {
    did: DID_A,
    collection: `${PREFIX}.settings`,
    rkey: 'self',
    signingKey: x.repo.key.didKey,
  });
  x.apply(x.db, disabled);
  expect(x.db.all('SELECT uri FROM live_pending_removals')).toEqual([{ uri: bobUri }]);
  expect(x.db.one('SELECT count(*) n FROM live_pending_removal_events WHERE uri=?', x.uri)).toEqual({ n: 0 });
  x.db.run('DELETE FROM hints');
  x.db.run('DELETE FROM live_record_evidence');
  x.db.run('DELETE FROM timers');
  await x.backup();
  x.db.close();
  const systemd = await realRestore(x.world);
  await expect.poll(() => remoteDeletes, { timeout: 18000, interval: 100 }).toBe(1);
  expect(systemd.server!.server.db.all("SELECT did FROM listenbrainz_deletes WHERE state='sent'")).toEqual([
    { did: DID_B },
  ]);
}, 30000);
