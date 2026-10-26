// The Node composition harness of the composition, acceptance and bench
// suites (ADR 0005 §3.2, §3.10, §15.1–§15.3; N4-03). TEST-ONLY.
//
// It replaces the workerd test entry (the TestIndexDO whose only override was
// `buildDeps`) with a Node composition factory: `harness(label)` builds the
// production composition — node/compose.ts over node/sqlite-db.ts, the
// production route table, dispatcher, static files and the real HTTP bridge on
// 127.0.0.1:0 — and overrides dependencies only through compose's options:
//
// - a temporary release root holding the database file (opened with the test
//   busy timeout and migrated before compose, as run() does), `web/dist` and
//   the state and runtime directories;
// - the NodeConfig of the real parseNodeConfig with the test-only
//   `fixtureOrigins` and `allowFixturePrefix` options (public origin
//   https://music.example.test, listen 127.0.0.1:0, the fixture
//   LEXICON_PREFIX, INGEST_MODE off unless a test sets it, client-IP mode
//   `cf-connecting-ip`, so a request's `ip` travels as that header from a
//   trusted loopback peer, as through exposure option A);
// - deterministic secrets (worker/test/node/support/app.ts);
// - `control`: the clock (a frozen clock read through a delegating Clock, so
//   `control.clock` may be replaced before a harness starts), randomness, the
//   transport (marked `fixture: true`, so the production SafeFetch policy
//   admits only the reserved fixture hosts and still runs its DoH pre-check,
//   redirect refusal and body caps) and the Jetstream connector, both called
//   through `control` on every use;
// - a Db wrapper over the production adapter that (a) records every statement
//   while a test asks it to (`record`) and (b) throws a configured error for
//   matching SQL (`control.dbFault`, fault injection through the Db
//   interface); it delegates otherwise and never changes a result;
// - manual timers: the scheduler's alarms and intervals are recorded and never
//   fire on their own. A test runs the core alarm with `runAlarm()` (the
//   NodeAlarm's own wake, then its idle promise: the production IndexCore.alarm
//   and its re-arm in `finally`), and fires the 5-minute ensureRunning
//   interval with `fireInterval(ENSURE_RUNNING_INTERVAL_MS)`;
// - a capturing logger: the production redacting logger (with the redactions
//   run() derives from the secrets) writing into `log`.
//
// Restart is close-and-reopen of the same file plus a recomposed app
// (`restart()`): the listener closes, every timer stops, the database closes
// without any shutdown write (a process that died), and the next composition
// opens the same file, migrates if needed and starts (noteRestart, lease
// reclaim, both lanes armed) on a new port.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createFixtureKit,
  type FixtureKit,
  type KitOptions,
  type SeedResult,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openapiText from '../../../api/openapi.yaml?raw';
import type { IndexCore } from '../../src/app/index-core';
import type { Db, SqlParam } from '../../src/do/db';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import { closeSocket, JetstreamConnectError } from '../../src/do/ingest/jetstream-socket';
import { migrate } from '../../src/do/migrate';
import type { NodeAlarm } from '../../src/node/alarm';
import { type ComposedApp, compose, type Feature, readSchemaState } from '../../src/node/compose';
import { type NodeConfig, type NodeEnv, parseNodeConfig } from '../../src/node/config';
import { type BoundAddress, type BridgeServer, createServer } from '../../src/node/http-bridge';
import type { Secrets } from '../../src/node/secrets';
import { openSqliteDb, type SqliteDb } from '../../src/node/sqlite-db';
import {
  type CapturedLog,
  captureLog,
  DEFAULT_DIST,
  type ManualTimers,
  manualTimers,
  testEnv,
  testSecrets,
} from '../node/support/app';
import { TEST_BUSY_TIMEOUT_MS } from '../node/support/node-db';

export const T0 = Date.parse('2026-01-15T12:00:00Z');
export const PUBLIC_ORIGIN = 'https://music.example.test';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Control

export interface DbFault {
  match: RegExp;
  message: string;
  /** Matching statements that still throw. */
  remaining: number;
}

export interface RecordedStatement {
  sql: string;
  params: SqlParam[];
}

export interface CompositionControl {
  clock: FixedClock;
  random: Random;
  transport: Transport;
  connectJetstream: ConnectJetstream;
  /** Environment overrides of the next harness (undefined removes a default). */
  env: Record<string, string | undefined>;
  dbFault: DbFault | null;
  /** Outbound requests the default (refusing) transport saw. */
  refused: string[];
}

function refusingTransport(refused: string[]): Transport {
  return async (req) => {
    refused.push(req.url);
    throw new TypeError(`composition fixture: no network for ${new URL(req.url).host}`);
  };
}

const refuseJetstream: ConnectJetstream = async (url) => {
  throw new JetstreamConnectError(null, null, `composition fixture: no Jetstream at ${new URL(url).host}`);
};

function defaults(): CompositionControl {
  const refused: string[] = [];
  return {
    clock: fixedClock(),
    random: seededRandom(5),
    transport: refusingTransport(refused),
    connectJetstream: refuseJetstream,
    env: {},
    dbFault: null,
    refused,
  };
}

/** The live control object; `resetControl` replaces its fields, never the object. */
export const control: CompositionControl = defaults();

export function resetControl(o: Partial<CompositionControl> = {}): CompositionControl {
  Object.assign(control, defaults(), o);
  return control;
}

/** A fixture kit on the control's clock, wired as the transport. */
export async function kitControl(
  o: Partial<CompositionControl> = {},
  kitOptions: KitOptions = {},
): Promise<FixtureKit> {
  const kit = await createFixtureKit(kitOptions);
  resetControl({ ...o, clock: kit.clock, transport: kit.transport });
  return kit;
}

/** The secret strings the logger must never print (as run() derives them). */
export function redactionsOf(secrets: Secrets): string[] {
  const out: string[] = [];
  const cursor = Buffer.from(secrets.cursorKey);
  out.push(cursor.toString('base64'), cursor.toString('hex'), cursor.toString('base64url'));
  for (const { key } of secrets.encryptionKeys) {
    const b = Buffer.from(key);
    out.push(b.toString('base64'), b.toString('hex'), b.toString('base64url'));
  }
  for (const jwk of secrets.oauthSigningKeys) out.push(jwk.d);
  return out;
}

// ---------------------------------------------------------------------------
// The Db wrapper

interface Recorder {
  log: RecordedStatement[] | null;
}

function controlledDb(inner: Db, recorder: Recorder): Db {
  const before = (sql: string, params: SqlParam[]) => {
    recorder.log?.push({ sql, params: [...params] });
    const f = control.dbFault;
    if (f !== null && f.remaining > 0 && f.match.test(sql)) {
      f.remaining -= 1;
      throw new Error(f.message);
    }
  };
  return {
    all<T>(sql: string, ...p: SqlParam[]): T[] {
      before(sql, p);
      return inner.all<T>(sql, ...p);
    },
    one<T>(sql: string, ...p: SqlParam[]): T | null {
      before(sql, p);
      return inner.one<T>(sql, ...p);
    },
    run(sql: string, ...p: SqlParam[]) {
      before(sql, p);
      return inner.run(sql, ...p);
    },
    tx: (fn) => inner.tx(fn),
  };
}

// ---------------------------------------------------------------------------
// HTTP

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Uint8Array;
  /** Sent as CF-Connecting-IP (the configured client-IP header) from the loopback peer. */
  ip?: string;
}

/** One request to `address` with the request target exactly as given (no URL normalisation). */
export function rawRequest(address: BoundAddress, target: string, o: RequestOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  for (const [k, v] of new Headers(o.headers as HeadersInit | undefined)) headers[k] = v;
  if (o.ip !== undefined) headers['cf-connecting-ip'] = o.ip;
  const body = o.body === undefined ? undefined : typeof o.body === 'string' ? Buffer.from(o.body) : o.body;
  if (body !== undefined) headers['content-length'] = String(body.byteLength);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: address.host, port: address.port, method: o.method ?? 'GET', path: target, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
          }
          let parsed: unknown = null;
          if ((out.get('content-type') ?? '').includes('json') && text !== '') parsed = JSON.parse(text);
          resolve({ status: res.statusCode ?? 0, headers: out, text, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// The harness

export interface HarnessOptions {
  /** Environment overrides on top of `control.env` (undefined removes a default). */
  env?: Record<string, string | undefined>;
  /** Files of `<release>/web/dist`; default DEFAULT_DIST. */
  dist?: Readonly<Record<string, string | Uint8Array>>;
  features?: readonly Feature[];
  secrets?: Secrets;
  /** False: compose over a database that was never migrated (schema `pending`). */
  migrate?: boolean;
  /** Free space below ATMUSIC_MIN_FREE_BYTES; default never. */
  diskLow?: () => boolean;
}

export interface Harness {
  readonly label: string;
  /** The release root (removed by close()). */
  readonly dir: string;
  readonly dbPath: string;
  readonly config: NodeConfig;
  readonly secrets: Secrets;
  /** Every log line of every composition of this harness. */
  readonly log: CapturedLog;
  /** The open database handle of the current composition (the adapter, not the wrapper). */
  readonly db: SqliteDb;
  readonly app: ComposedApp;
  readonly core: IndexCore;
  readonly timers: ManualTimers;
  readonly address: BoundAddress;
  /** Compositions so far (1 + restarts). */
  readonly compositions: number;
  /** One request through the HTTP bridge; JSON bodies are parsed. */
  request(target: string, o?: RequestOptions): Promise<HttpResult>;
  postJson(target: string, body: unknown, o?: RequestOptions): Promise<HttpResult>;
  /** Runs `fn` and returns what it returned with every statement the composition's Db ran meanwhile. */
  record<R>(fn: () => R | Promise<R>): Promise<{ result: R; statements: RecordedStatement[] }>;
  startRecording(): RecordedStatement[];
  stopRecording(): RecordedStatement[];
  /** The core lane's pending alarm (wall-clock ms), or null. */
  coreAlarm(): number | null;
  /** Runs the core lane's alarm once when one is pending; false when none is armed. */
  runAlarm(): Promise<boolean>;
  /** Fires every recorded interval of `periodMs` once and waits for the alarms to settle. */
  fireInterval(periodMs: number): Promise<number>;
  /** Advance `stepMs` and run the alarm until `done` holds; returns the alarms run. */
  alarmsUntil(
    done: (db: SqliteDb) => boolean | Promise<boolean>,
    o?: { max?: number; stepMs?: number },
  ): Promise<number>;
  /** Close-and-reopen of the same file plus a recomposed app. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

const open = new Set<Harness>();

function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** The harness environment for a release root. */
export function harnessEnv(dir: string): Record<string, string | undefined> {
  return { ...testEnv(dir), ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip' };
}

export async function harness(label: string, options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `atmusic-${label.replace(/[^a-z0-9-]/gi, '')}-`));
  const distDir = join(dir, 'web', 'dist');
  writeFiles(distDir, options.dist ?? DEFAULT_DIST);
  const env: NodeEnv = { ...harnessEnv(dir), ...control.env, ...options.env };
  const config = parseNodeConfig(env, { fixtureOrigins: true, allowFixturePrefix: true, releaseRoot: dir });
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const secrets = options.secrets ?? testSecrets();
  const log = captureLog(redactionsOf(secrets));
  const clock: Clock = { nowMs: () => control.clock.nowMs() };
  const random: Random = {
    bytes: (n) => control.random.bytes(n),
    float: () => control.random.float(),
  };
  const transport: Transport & { fixture: true } = Object.assign((req: Request) => control.transport(req), {
    fixture: true as const,
  });
  const connectJetstream: ConnectJetstream = (url) => control.connectJetstream(url);
  const recorder: Recorder = { log: null };

  let db: SqliteDb | null = null;
  let app: ComposedApp | null = null;
  let bridge: BridgeServer | null = null;
  let address: BoundAddress | null = null;
  let timers: ManualTimers | null = null;
  let compositions = 0;
  let first = true;

  const up = async (): Promise<void> => {
    db = openSqliteDb(config.dbPath, { busyTimeoutMs: TEST_BUSY_TIMEOUT_MS, create: first });
    first = false;
    // As run(): a pending schema is migrated before compose (on the first
    // composition only unless `migrate: false`).
    if ((options.migrate !== false || compositions > 0) && readSchemaState(db).status === 'pending') {
      const migration = migrate(db);
      if (migration.status !== 'ready')
        throw new Error(`harness database did not migrate: ${JSON.stringify(migration)}`);
    }
    timers = manualTimers();
    app = await compose(config, secrets, {
      db: controlledDb(db, recorder),
      transport,
      connectJetstream,
      features: options.features ?? [],
      clock,
      random,
      log: log.logger,
      timers,
      diskLow: options.diskLow ?? (() => false),
    });
    bridge = createServer({ publicOrigin: config.publicOrigin, listen: config.listen, handler: app.handler, random });
    address = await bridge.start();
    compositions += 1;
  };

  const down = async (): Promise<void> => {
    try {
      await bridge?.close();
    } finally {
      app?.stop();
      await app?.scheduler.whenIdle();
      db?.close();
      bridge = null;
      app = null;
      db = null;
    }
  };

  const need = <T>(value: T | null, what: string): T => {
    if (value === null) throw new Error(`harness ${label}: no ${what} (closed?)`);
    return value;
  };

  let closed = false;
  const h: Harness = {
    label,
    dir,
    dbPath: config.dbPath,
    config,
    secrets,
    log,
    get db() {
      return need(db, 'database');
    },
    get app() {
      return need(app, 'composition');
    },
    get core() {
      return need(app, 'composition').core;
    },
    get timers() {
      return need(timers, 'timers');
    },
    get address() {
      return need(address, 'listener');
    },
    get compositions() {
      return compositions;
    },
    request: (target, o) => rawRequest(need(address, 'listener'), target, o),
    postJson(target, body, o = {}) {
      const headers = new Headers(o.headers as HeadersInit | undefined);
      headers.set('content-type', 'application/json');
      return h.request(target, { ...o, method: 'POST', headers, body: JSON.stringify(body) });
    },
    async record(fn) {
      const log: RecordedStatement[] = [];
      recorder.log = log;
      try {
        const result = await fn();
        return { result, statements: log };
      } finally {
        recorder.log = null;
      }
    },
    startRecording() {
      recorder.log = [];
      return recorder.log;
    },
    stopRecording() {
      const out = recorder.log ?? [];
      recorder.log = null;
      return out;
    },
    coreAlarm: () => (h.core.host.alarm as NodeAlarm).nextDueMs(),
    async runAlarm() {
      const alarm = h.core.host.alarm as NodeAlarm;
      if (alarm.nextDueMs() === null) return false;
      if (!alarm.wake()) return false;
      await alarm.whenIdle();
      return true;
    },
    async fireInterval(periodMs) {
      const due = h.timers.pending().filter((t) => t.kind === 'interval' && t.delayMs === periodMs);
      for (const t of due) t.callback();
      await flushTasks();
      await h.app.scheduler.whenIdle();
      return due.length;
    },
    async alarmsUntil(done, o = {}) {
      const max = o.max ?? 40;
      for (let n = 0; n < max; n++) {
        if (await done(h.db)) return n;
        control.clock.advance(o.stepMs ?? 2_000);
        await h.runAlarm();
        await flushTasks();
      }
      if (await done(h.db)) return max;
      throw new Error(`condition not reached after ${max} alarms`);
    },
    async restart() {
      await down();
      await up();
    },
    async close() {
      if (closed) return;
      closed = true;
      open.delete(h);
      try {
        // As run()'s SIGTERM drain: the Jetstream link closes (1000) before the database.
        if (app !== null) {
          try {
            closeSocket(app.core.deps, clock.nowMs());
          } catch {
            // A test may already have closed the database under a fault.
          }
          await flushTasks();
        }
        await down();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  open.add(h);
  try {
    await up();
  } catch (error) {
    await h.close();
    throw error;
  }
  return h;
}

/** Closes every harness still open (afterEach). */
export async function closeHarnesses(): Promise<void> {
  for (const h of [...open]) await h.close();
}

/** Lets queued socket events, microtasks and immediate timers run (no clock involved). */
export async function flushTasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// OpenAPI schemas (AJV against api/openapi.yaml)

const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);
ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
ajv.addSchema({ $id: 'openapi', components: (JSON.parse(openapiText) as { components: unknown }).components });

/** 'valid', or AJV's error text for `value` against components.schemas[name]. */
export function schema(name: string, value: unknown): string {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return (validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors);
}

// ---------------------------------------------------------------------------
// The shared fixture through the production ingestion path

export const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const CAROL = 'did:plc:cccccccccccccccccccccccc';
export const PREFIX = 'com.example.atmusic';
export const SCROBBLE = `${PREFIX}.scrobble`;
export const FOLLOW = `${PREFIX}.follow`;
export const uriOf = (did: string, rkey: string) => `at://${did}/${SCROBBLE}/${rkey}`;

/** Users whose complete snapshot made them visible. */
export function activeUsers(db: Db): string[] {
  return db.all<{ did: string }>('SELECT did FROM users WHERE active = 1 ORDER BY did').map((r) => r.did);
}

export function openSnapshotJobs(db: Db): number {
  return (
    db.one<{ n: number }>(
      `SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')`,
    )?.n ?? 0
  );
}

/**
 * read_models.json published as real signed commits (seedReadModels), then
 * each account announced through POST /api/v1/notify `{did}` and indexed by
 * the core alarm (admission → range snapshot → apply).
 */
export async function ingestFixture(h: Harness, kit: FixtureKit): Promise<SeedResult> {
  const seed = await seedReadModels(kit);
  for (const did of [ALICE, BOB, CAROL]) {
    const r = await h.postJson('/api/v1/notify', { did }, { ip: '198.51.100.1' });
    if (r.status !== 202) throw new Error(`notify ${did}: ${r.status} ${r.text}`);
  }
  await h.alarmsUntil((db) => activeUsers(db).length === 3 && openSnapshotJobs(db) === 0);
  return seed;
}

// The two setup helpers of worker/test/write/support.ts, copied so these
// suites import nothing that still reaches cloudflare:* (N4-04 de-shims it).

const NOW_STORAGE = toStorage(fromMs(T0));

/**
 * Test setup only: a known account row (what admission plus a completed
 * snapshot leave behind), with a generation from the global allocator.
 */
export function seedUser(db: Db, did: string, o: { active?: boolean } = {}): number {
  const row = db.one<{ last_generation: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation',
  ) as { last_generation: number };
  const active = o.active ?? true;
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    did,
    NOW_STORAGE,
    active ? 1 : 0,
    active ? 'active' : 'unknown',
    active ? 'current' : 'recovering',
    row.last_generation,
  );
  return row.last_generation;
}

/** Test setup only: the running `repo_jobs(did,'snapshot')` row a snapshot holds. */
export function seedSnapshotJob(db: Db, did: string, generation: number, o: { reactivate?: boolean } = {}): void {
  db.run(
    `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
     VALUES (?, 'snapshot', 'running', ?, ?, ?, ?)`,
    did,
    generation,
    o.reactivate ? 1 : 0,
    T0,
    T0,
  );
}
