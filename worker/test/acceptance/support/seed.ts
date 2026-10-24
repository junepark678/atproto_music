// The shared read-model fixture through the real ingestion path, for the
// acceptance suites (W6-01, ADR 0004 §10.3). TEST-ONLY.
//
// `seedAcceptance(label)`:
//  1. builds the fixture network (createFixtureKit: Alice, Bob and Carol as
//     real signed repositories on three fake PDS hosts, fake PLC, DoH, relay
//     and Jetstream) with its clock at SEED_START, two minutes before the
//     frozen asOf, and wires it into the next TestIndexDO (entry.ts control);
//  2. the first alarm runs the production Jetstream watchdog, which connects
//     the production socket to the fake Jetstream (WebSocketPair connector);
//  3. `seedReadModels(kit)` publishes tests/fixtures/read_models.json inside
//     the DO (the socket belongs to it): Alice's and Bob's records through
//     their PDS's createRecord, Carol's r10 as an external writer, r08 created
//     then deleted. Every commit reaches the index only as a **fake Jetstream
//     event**: a hint, then admission, a range snapshot of the signed head and
//     getRecord proofs, all run by the production alarm;
//  4. alarms are stepped with runDurableObjectAlarm (2 s apart, the drain
//     floor) until no hints remain, no snapshot job is open, all three users
//     are active and no gap is pending;
//  5. the clock is set to the frozen asOf 2026-01-15T12:00:00Z for the reads.
//
// Every HTTP response goes through the production Worker handlers
// (`createWorker`, the code `export default` of src/index.ts runs, here with
// the frozen clock, a seeded Random and a per-test IndexDO name, A18) and is
// validated against api/openapi.yaml (./openapi.ts) before a test sees it.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  createFixtureKit,
  type FixtureKit,
  type FixtureUser,
  type SeedResult,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import type { FixtureCall } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import type { Db } from '../../../src/do/db';
import { doDb } from '../../../src/do/db';
import type { Env } from '../../../src/env';
import { createWorker } from '../../../src/router';
import { flush, type JetstreamServer, jetstreamServer } from '../../fixtures/jetstream-server';
import { ACCEPTANCE, type AcceptanceHandle, resetControl, type TestIndexDO } from '../entry';
import { checkResponse } from './openapi';

export { flush };

/** The acceptance bindings (the harness's Cloudflare.Env augmentation does not describe them). */
export const acceptanceEnv = env as unknown as Env & { PROD_INDEX: Env['INDEX'] };

export const AS_OF = '2026-01-15T12:00:00Z';
export const AS_OF_MS = Date.parse(AS_OF);
/** Seeding runs from here, so reads happen exactly at the frozen asOf afterwards. */
export const SEED_START = '2026-01-15T11:58:00Z';

export const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const CAROL = 'did:plc:cccccccccccccccccccccccc';
export const PREFIX = 'com.example.atmusic';
export const SCROBBLE = `${PREFIX}.scrobble`;
export const FOLLOW = `${PREFIX}.follow`;
export const SETTINGS = `${PREFIX}.settings`;
export const uriOf = (did: string, rkey: string, collection = SCROBBLE) => `at://${did}/${collection}/${rkey}`;
/** The rkey of a scrobble URI. */
export const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

export const GET_RECORD = 'com.atproto.sync.getRecord';
export const GET_BLOCKS = 'com.atproto.sync.getBlocks';
export const CREATE_RECORD = 'com.atproto.repo.createRecord';
export const PUT_RECORD = 'com.atproto.repo.putRecord';
export const DELETE_RECORD = 'com.atproto.repo.deleteRecord';
export const APP_WRITES = [CREATE_RECORD, PUT_RECORD, DELETE_RECORD] as const;

let counter = 0;
/** A DO name no other test uses (A18). */
export function freshName(label: string): string {
  counter += 1;
  return `acceptance-${label}-${counter}`;
}

export interface HttpResult {
  url: string;
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
  /** Always 'valid': `request` throws on any OpenAPI violation. */
  schema: 'valid';
}

export interface Acceptance {
  name: string;
  kit: FixtureKit;
  js: JetstreamServer;
  stub: DurableObjectStub<TestIndexDO>;
  /** Responses validated against api/openapi.yaml so far. */
  validated: number;
  /** One Worker request, validated against api/openapi.yaml (throws on a violation). */
  request(path: string, init?: RequestInit & { ip?: string }): Promise<HttpResult>;
  postJson(path: string, body: unknown, ip?: string): Promise<HttpResult>;
  /** Run `fn` inside the DO with its Db and the test control handle. */
  inDo<R>(fn: (db: Db, handle: AcceptanceHandle, state: DurableObjectState) => R | Promise<R>): Promise<R>;
  /** One alarm (runDurableObjectAlarm), then let socket events settle. */
  alarm(): Promise<boolean>;
  /** Advance `stepMs` and run an alarm until `done` holds; returns the alarms run. */
  alarmsUntil(done: (db: Db) => boolean, o?: { max?: number; stepMs?: number }): Promise<number>;
}

export interface StartOptions {
  /** Clock start (default SEED_START). */
  at?: string;
  envOverrides?: Partial<Env>;
}

/** The fixture network wired into a fresh TestIndexDO whose socket is connected. Nothing is published yet. */
export async function startAcceptance(label: string, o: StartOptions = {}): Promise<Acceptance> {
  const kit = await createFixtureKit({ clock: fixedClock(o.at ?? SEED_START) });
  const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
  resetControl({ clock: kit.clock, random: seededRandom(5), transport: kit.transport, connectJetstream: js.connect });
  const name = freshName(label);
  const workerEnv = {
    ...acceptanceEnv,
    ...o.envOverrides,
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } as unknown as Fetcher,
  } as Env;
  const worker = createWorker({ clock: kit.clock, random: seededRandom(11), indexName: name });
  const stub = acceptanceEnv.INDEX.get(
    acceptanceEnv.INDEX.idFromName(name),
  ) as unknown as DurableObjectStub<TestIndexDO>;

  const a: Acceptance = {
    name,
    kit,
    js,
    stub,
    validated: 0,
    async request(path, init = {}) {
      const { ip, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (ip !== undefined) headers.set('cf-connecting-ip', ip);
      const url = `https://music.example.test${path}`;
      const req = new Request(url, { ...rest, headers });
      const res = await worker.fetch(req, workerEnv, {} as ExecutionContext);
      const text = await res.text();
      let body: unknown = null;
      if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
      const verdict = checkResponse(req.method, url, { status: res.status, headers: res.headers, body });
      if (verdict !== 'valid')
        throw new Error(`${req.method} ${path} → ${res.status} violates api/openapi.yaml: ${verdict}\n${text}`);
      a.validated += 1;
      return { url, status: res.status, headers: res.headers, text, body, schema: 'valid' };
    },
    postJson(path, body, ip = '198.51.100.1') {
      return a.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ip,
      });
    },
    inDo(fn) {
      return runInDurableObject(stub, (instance: TestIndexDO, state) =>
        fn(doDb(state.storage), instance[ACCEPTANCE](), state),
      );
    },
    async alarm() {
      const ran = await runDurableObjectAlarm(stub);
      await flush();
      return ran;
    },
    async alarmsUntil(done, ao = {}) {
      const max = ao.max ?? 60;
      for (let n = 0; n < max; n++) {
        if (await a.inDo((db) => done(db))) return n;
        kit.clock.advance(ao.stepMs ?? 2_000);
        await a.alarm();
      }
      if (await a.inDo((db) => done(db))) return max;
      throw new Error(`condition not reached after ${max} alarms`);
    },
  };

  // The first alarm: the watchdog connects the production socket to the fake Jetstream.
  await a.alarm();
  const live = js.live().length;
  if (live !== 1) throw new Error(`expected one live Jetstream socket after the first alarm, got ${live}`);
  return a;
}

// ---------------------------------------------------------------------------
// Table helpers

export function count(db: Db, sql: string, ...p: Array<string | number>): number {
  return db.one<{ n: number }>(sql, ...p)?.n ?? 0;
}

export const hintCount = (db: Db) => count(db, 'SELECT count(*) AS n FROM hints');
export const openSnapshotJobs = (db: Db) =>
  count(db, `SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')`);
export const activeUsers = (db: Db) =>
  db.all<{ did: string }>('SELECT did FROM users WHERE active = 1 ORDER BY did').map((r) => r.did);
export const pendingGap = (db: Db) =>
  db.one<{ pending_gap: number }>("SELECT pending_gap FROM ingest_checkpoint WHERE stream = 'jetstream'")
    ?.pending_gap ?? 0;

/** Nothing left to do: no hints, no open snapshot job, no pending gap. */
export function settled(db: Db, users: readonly string[] = [ALICE, BOB, CAROL]): boolean {
  const active = activeUsers(db);
  return (
    hintCount(db) === 0 && openSnapshotJobs(db) === 0 && pendingGap(db) === 0 && users.every((u) => active.includes(u))
  );
}

/** The projection and checkpoint tables a rejection must leave byte-identical (ADR 0004 §7.6). */
export function projectionTables(db: Db): Record<string, unknown[]> {
  return {
    scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
    follows: db.all('SELECT * FROM follows ORDER BY uri'),
    record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
    users: db.all('SELECT * FROM users ORDER BY did'),
    suppression: db.all('SELECT * FROM suppression ORDER BY did'),
    ingest_checkpoint: db.all('SELECT * FROM ingest_checkpoint ORDER BY stream'),
  };
}

/** Every application table, in a stable order. */
export function allTables(db: Db): Record<string, unknown[]> {
  const names = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .map((r) => r.name);
  return Object.fromEntries(names.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));
}

/** Visible scrobble URIs of `did` in the stored table (not through any read module). */
export function storedScrobbles(db: Db, did?: string): Array<{ uri: string; cid: string }> {
  return did === undefined
    ? db.all('SELECT uri, cid FROM scrobbles ORDER BY uri')
    : db.all('SELECT uri, cid FROM scrobbles WHERE did = ? ORDER BY uri', did);
}

// ---------------------------------------------------------------------------
// The seeded fixture

export interface SeedCalls {
  /** Every request the seeding sent over the fixture transport (writes and the index's reads). */
  transport: FixtureCall[];
  /** Each fake PDS's own call log during seeding. */
  pds: Record<FixtureUser, FixtureCall[]>;
}

export interface Seeded extends Acceptance {
  seed: SeedResult;
  /** Alarms the seeding needed. */
  seedAlarms: number;
  /** The call logs of the seeding, kept before they were cleared. */
  seedCalls: SeedCalls;
}

/**
 * read_models.json through fake Jetstream events and the production alarm,
 * then the clock at the frozen asOf. The call logs are kept in `seedCalls`
 * and then cleared, so a test counts only its own remote calls;
 * `seed.events` keeps what Jetstream carried.
 */
export async function seedAcceptance(label: string, o: StartOptions = {}): Promise<Seeded> {
  const a = await startAcceptance(label, o);
  const seed = await a.inDo(() => seedReadModels(a.kit, { keepCalls: true }));
  await flush();
  const seedAlarms = await a.alarmsUntil((db) => settled(db));
  if (a.kit.clock.nowMs() > AS_OF_MS)
    throw new Error(`seeding ran past asOf (${new Date(a.kit.clock.nowMs()).toISOString()})`);
  a.kit.clock.set(AS_OF);
  const seedCalls: SeedCalls = {
    transport: [...a.kit.transport.calls.entries],
    pds: {
      Alice: [...a.kit.pds.Alice.calls.entries],
      Bob: [...a.kit.pds.Bob.calls.entries],
      Carol: [...a.kit.pds.Carol.calls.entries],
    },
  };
  a.kit.resetCalls();
  return Object.assign(a, { seed, seedAlarms, seedCalls });
}

/** Publish through the PDS (or externally) inside the DO, so the socket carries the commit, then settle. */
export async function inSocket<R>(a: Acceptance, fn: () => Promise<R>): Promise<R> {
  const out = await a.inDo(() => fn());
  await flush();
  return out;
}
