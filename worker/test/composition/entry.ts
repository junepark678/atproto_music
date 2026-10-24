// Test-only Worker entry for wrangler.composition.jsonc (W5-01). TEST-ONLY.
//
// `TestIndexDO` is the production IndexDO with exactly one override,
// `buildDeps` (ADR 0004 §4.4 test seam): the frozen clock, a seeded Random,
// the fixture Transport (marked `fixture: true`, so the production SafeFetch
// policy admits only the reserved fixture hosts), the fake Jetstream
// connector and the fixture prefix (`allowFixturePrefix`). Everything else —
// migrations, the restart bookkeeping, the timers, the alarm, every RPC
// method and every DO module — is production code.
//
// Two further injections, both at interfaces IndexDO already takes:
// - `alarms`: the alarm is armed on the real DO storage, but at a far-future
//   real time, so workerd never fires it on its own while a test runs (the
//   frozen clock lives in January 2026, and a past alarm would fire at once).
//   Tests run it with `runDurableObjectAlarm`; the logical due time IndexDO
//   asked for is recorded per DO in `control.armed`.
// - `db`: a Db wrapper that throws a configured error for matching SQL
//   (fault injection for the safe-errors test); it delegates otherwise.
//
// The default export is the production Worker (src/index.ts).

import type { Transport } from '@atmusic/atproto/transport';
import type { Random } from '@atmusic/core/deps';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { parseConfig } from '../../src/config';
import { type Db, doDb, type SqlParam } from '../../src/do/db';
import { envLogger, type IndexDeps, IndexDO } from '../../src/do/index-do';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import type { AlarmStorage } from '../../src/do/timers';
import type { Env, EnvSecrets, EnvVars } from '../../src/env';

export { default } from '../../src/index';

/** How far ahead (real time) the real alarm is parked. */
export const PARKED_ALARM_MS = 24 * 3_600_000;

export interface DbFault {
  match: RegExp;
  message: string;
  /** Matching statements that still throw. */
  remaining: number;
}

export interface CompositionControl {
  clock: FixedClock;
  random: Random;
  transport: Transport;
  connectJetstream: ConnectJetstream;
  /** Overrides of the wrangler vars and secrets the IndexDO parses. */
  env: Partial<EnvVars & EnvSecrets>;
  dbFault: DbFault | null;
  /** Logical alarm times IndexDO armed, per DO id (null: deleted). */
  armed: Map<string, Array<number | null>>;
  /** Outbound requests the default (refusing) transport saw. */
  refused: string[];
  /** IndexDO instances constructed, per DO id. */
  constructed: Map<string, number>;
}

function refusingTransport(refused: string[]): Transport {
  return async (req) => {
    refused.push(req.url);
    throw new TypeError(`composition fixture: no network for ${new URL(req.url).host}`);
  };
}

const refuseJetstream: ConnectJetstream = async (url) => {
  throw new TypeError(`composition fixture: no Jetstream at ${new URL(url).host}`);
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
    armed: new Map(),
    refused,
    constructed: new Map(),
  };
}

/** The live control object; its fields are replaced by `resetControl`, the object itself never is. */
export const control: CompositionControl = defaults();

export function resetControl(o: Partial<Omit<CompositionControl, 'armed' | 'refused' | 'constructed'>> = {}) {
  Object.assign(control, defaults(), o);
  return control;
}

function faultyDb(inner: Db): Db {
  const check = (sql: string) => {
    const f = control.dbFault;
    if (f !== null && f.remaining > 0 && f.match.test(sql)) {
      f.remaining -= 1;
      throw new Error(f.message);
    }
  };
  return {
    all<T>(sql: string, ...p: SqlParam[]): T[] {
      check(sql);
      return inner.all<T>(sql, ...p);
    },
    one<T>(sql: string, ...p: SqlParam[]): T | null {
      check(sql);
      return inner.one<T>(sql, ...p);
    },
    run(sql: string, ...p: SqlParam[]) {
      check(sql);
      return inner.run(sql, ...p);
    },
    tx: inner.tx,
  };
}

function parkedAlarms(storage: DurableObjectStorage, id: string): AlarmStorage {
  const log = () => {
    let list = control.armed.get(id);
    if (list === undefined) {
      list = [];
      control.armed.set(id, list);
    }
    return list;
  };
  return {
    setAlarm(at) {
      log().push(typeof at === 'number' ? at : at.getTime());
      return storage.setAlarm(Date.now() + PARKED_ALARM_MS);
    },
    deleteAlarm() {
      log().push(null);
      return storage.deleteAlarm();
    },
  };
}

export class TestIndexDO extends IndexDO {
  protected override buildDeps(env: Env, ctx: DurableObjectState): IndexDeps {
    const id = ctx.id.toString();
    control.constructed.set(id, (control.constructed.get(id) ?? 0) + 1);
    const merged = { ...env, ...control.env } as Env;
    const config = parseConfig(merged, { allowFixturePrefix: true });
    const db = faultyDb(doDb(ctx.storage));
    const clock = control.clock;
    const transport: Transport & { fixture: true } = Object.assign((req: Request) => control.transport(req), {
      fixture: true as const,
    });
    return {
      db,
      clock,
      random: control.random,
      transport,
      identity: cachedIdentityResolver(db, { transport, clock }),
      config,
      log: envLogger(merged),
      connectJetstream: (url) => control.connectJetstream(url),
      alarms: parkedAlarms(ctx.storage, id),
    };
  }
}
