// Test-only Worker entry for wrangler.acceptance.jsonc (W6-01). TEST-ONLY.
//
// `TestIndexDO` is the production IndexDO with exactly one override,
// `buildDeps` (ADR 0004 §4.4 test seam):
// - a frozen clock (`fixedClock('2026-01-15T12:00:00Z')` by default; each
//   suite passes the fixture kit's fixedClock, which support/seed.ts starts
//   two minutes earlier so that seeding ends before the reads, which all run
//   at exactly 2026-01-15T12:00:00Z unless a test advances it on purpose);
// - a seeded Random;
// - the fixture `routerTransport` (marked `fixture: true`, so the production
//   SafeFetch policy admits only the reserved fixture hosts and still runs its
//   DoH pre-check, redirect refusal and body caps);
// - the WebSocketPair Jetstream connector (worker/test/fixtures/jetstream-server.ts,
//   which wraps the production connector over the fake Jetstream);
// - the fixture prefix: only because wrangler.acceptance.jsonc sets
//   ACCEPTANCE_ALLOW_FIXTURE_PREFIX, which nothing in worker/src reads.
// Migrations, timers, the alarm, every RPC method and every DO module are
// production code.
//
// Two further injections at interfaces IndexDO already takes:
// - `alarms`: the alarm is armed on the real DO storage, but parked a day
//   ahead in real time so workerd never fires it while a test runs (the frozen
//   clock lives in January 2026, so a "due" alarm would fire at once). Tests
//   step it with runDurableObjectAlarm; the logical time IndexDO asked for is
//   recorded per DO.
// - `db`: a pass-through Db that, while a test enables it, records every SQL
//   statement and its parameters (the query-plan suite explains exactly the
//   statements the production read modules ran). It never changes a result.
//
// Test control. The dependencies are fixed in the constructor, so the test
// sets the module-level `control` before a DO's first use. Everything a test
// reads back from a live instance goes through the Symbol-keyed method
// `[ACCEPTANCE]()`, which is reachable only inside the isolate, through
// runInDurableObject: JS RPC dispatches on string names only, and no HTTP
// route leads here (security.test.ts asserts both).
//
// The default export is the production Worker (src/index.ts); `IndexDO` is
// re-exported unmodified for the PROD_INDEX binding, so the security suite
// can show that production code refuses this very environment.

import type { Transport } from '@atmusic/atproto/transport';
import type { Random } from '@atmusic/core/deps';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { parseConfig } from '../../src/config';
import { type Db, doDb, type SqlParam } from '../../src/do/db';
import { envLogger, type IndexDeps, IndexDO, type LogSink } from '../../src/do/index-do';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import type { AlarmStorage } from '../../src/do/timers';
import type { Env, EnvSecrets, EnvVars } from '../../src/env';

export { default } from '../../src/index';
export { IndexDO };

/** The Symbol key of the test control method (never a string: RPC cannot name it). */
export const ACCEPTANCE: unique symbol = Symbol('atmusic.acceptance-control');

/** How far ahead (real time) the real alarm is parked. */
export const PARKED_ALARM_MS = 24 * 3_600_000;

/** The acceptance env flag; read here only, never by worker/src. */
export const ALLOW_FIXTURE_VAR = 'ACCEPTANCE_ALLOW_FIXTURE_PREFIX';

export interface RecordedStatement {
  sql: string;
  params: SqlParam[];
}

export interface AcceptanceControl {
  clock: FixedClock;
  random: Random;
  transport: Transport;
  connectJetstream: ConnectJetstream;
  /** Overrides of the wrangler vars and secrets the IndexDO parses. */
  env: Partial<EnvVars & EnvSecrets>;
  /** Where the production Logger writes its (redacted) lines; default the console. */
  logSink: LogSink;
}

function refusingTransport(): Transport {
  return async (req) => {
    throw new TypeError(`acceptance fixture: no network for ${new URL(req.url).host}`);
  };
}

const refuseJetstream: ConnectJetstream = async (url) => {
  throw new TypeError(`acceptance fixture: no Jetstream at ${new URL(url).host}`);
};

function defaults(): AcceptanceControl {
  return {
    clock: fixedClock('2026-01-15T12:00:00Z'),
    random: seededRandom(5),
    transport: refusingTransport(),
    connectJetstream: refuseJetstream,
    env: {},
    logSink: console,
  };
}

/** The configuration the next constructed TestIndexDO takes. Its fields are replaced, the object never is. */
export const control: AcceptanceControl = defaults();

export function resetControl(o: Partial<AcceptanceControl> = {}): AcceptanceControl {
  Object.assign(control, defaults(), o);
  return control;
}

/** Bookkeeping per DO id (constructions, armed alarm times), kept across evictions. */
interface InstanceLog {
  constructed: number;
  armed: Array<number | null>;
}
const instances = new Map<string, InstanceLog>();

function instanceLog(id: string): InstanceLog {
  let log = instances.get(id);
  if (log === undefined) {
    log = { constructed: 0, armed: [] };
    instances.set(id, log);
  }
  return log;
}

/** What `[ACCEPTANCE]()` hands a test running inside the DO. */
export interface AcceptanceHandle {
  /** The dependencies this instance was built with (production modules use exactly these). */
  readonly deps: IndexDeps;
  /** IndexDO constructions for this DO id (1 + evictions). */
  readonly constructed: number;
  /** Logical alarm times this DO armed, in order (null: deleted). */
  readonly armed: readonly (number | null)[];
  /** Start recording every statement this instance's Db runs; returns the live log. */
  record(): RecordedStatement[];
  /** Stop recording; returns what was recorded. */
  stopRecording(): RecordedStatement[];
}

class RecordingDb implements Db {
  log: RecordedStatement[] | null = null;
  constructor(private readonly inner: Db) {}
  private note(sql: string, params: SqlParam[]) {
    this.log?.push({ sql, params: [...params] });
  }
  all<T>(sql: string, ...p: SqlParam[]): T[] {
    this.note(sql, p);
    return this.inner.all<T>(sql, ...p);
  }
  one<T>(sql: string, ...p: SqlParam[]): T | null {
    this.note(sql, p);
    return this.inner.one<T>(sql, ...p);
  }
  run(sql: string, ...p: SqlParam[]) {
    this.note(sql, p);
    return this.inner.run(sql, ...p);
  }
  tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
    return this.inner.tx(fn);
  }
}

function parkedAlarms(storage: DurableObjectStorage, log: InstanceLog): AlarmStorage {
  return {
    setAlarm(at) {
      log.armed.push(typeof at === 'number' ? at : at.getTime());
      return storage.setAlarm(Date.now() + PARKED_ALARM_MS);
    },
    deleteAlarm() {
      log.armed.push(null);
      return storage.deleteAlarm();
    },
  };
}

export class TestIndexDO extends IndexDO {
  // buildDeps runs inside the IndexDO constructor, before any field of this
  // subclass exists: it keeps nothing on `this`, and [ACCEPTANCE] reads
  // the deps the base class stored.
  protected override buildDeps(env: Env, ctx: DurableObjectState): IndexDeps {
    const log = instanceLog(ctx.id.toString());
    log.constructed += 1;
    const merged = { ...env, ...control.env } as Env;
    const allowFixturePrefix = (merged as unknown as Record<string, unknown>)[ALLOW_FIXTURE_VAR] === 'true';
    const config = parseConfig(merged, { allowFixturePrefix });
    const db = new RecordingDb(doDb(ctx.storage));
    const clock = control.clock;
    const inner = control.transport;
    const transport: Transport & { fixture: true } = Object.assign((req: Request) => inner(req), {
      fixture: true as const,
    });
    const connect = control.connectJetstream;
    return {
      db,
      clock,
      random: control.random,
      transport,
      identity: cachedIdentityResolver(db, { transport, clock }),
      config,
      log: envLogger(merged, control.logSink),
      connectJetstream: (url) => connect(url),
      alarms: parkedAlarms(ctx.storage, log),
    };
  }

  [ACCEPTANCE](): AcceptanceHandle {
    const deps = this.deps;
    if (deps === null || !(deps.db instanceof RecordingDb)) throw new Error('TestIndexDO has no dependencies');
    const db = deps.db;
    const log = instanceLog(this.ctx.id.toString());
    return {
      deps,
      constructed: log.constructed,
      armed: log.armed,
      record() {
        db.log = [];
        return db.log;
      },
      stopRecording() {
        const out = db.log ?? [];
        db.log = null;
        return out;
      },
    };
  }
}
