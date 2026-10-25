// N1-02: the extension timer lane and lane-scoped timers (ADR 0005 §3.3)
// against real DO SQLite in workerd (the harness DO applies the production
// migrations).
//
// Two layers are exercised:
// - timers.ts directly (`runDue`, `armAlarm`, `nextDue` with a lane), with
//   recording handlers whose blocking is controlled by the test;
// - IndexCore (app/index-core.ts) over the harness storage with a recording
//   Host: its two lanes are driven by two distinct recording AlarmStorage
//   objects, the extension handlers come from CoreExtensions, and the core
//   lane runs the production handlers. A core snapshot slice is held open
//   only through the injected identity resolver (IndexCoreOptions.identity).
//
// Time is the frozen fixture instant; nothing sleeps.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { IdentityResolver, ResolvedIdentity } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CoreExtension, ExtensionContext, Host } from '../../src/app/host';
import { IndexCore } from '../../src/app/index-core';
import { parseConfig } from '../../src/config';
import type { LogLevel } from '../../src/do/contracts';
import { type Db, doDb } from '../../src/do/db';
import { scheduleSnapshot } from '../../src/do/ingest/admission';
import { migrate } from '../../src/do/migrate';
import {
  type AlarmStorage,
  armAlarm,
  CORE_LANE,
  EXTENSION_LANE,
  EXTENSION_TIMER_NAMES,
  type ExtensionTimerName,
  type LaneHandlers,
  nextDue,
  runDue,
  schedule,
  TIMER_FAILURES_COUNTER,
  TIMER_NAMES,
  TIMER_STREAK_COUNTER,
  type TimerHandlers,
  TimerReentryError,
  timerBackoffMs,
} from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';
import { seedUser } from '../write/support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const NOW = Date.parse('2026-01-15T12:00:00Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const UNLIMITED = { maxRuns: 100 };
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

type AlarmCall = { op: 'set'; at: number } | { op: 'delete' };

function recordingAlarms(): { storage: AlarmStorage; calls: AlarmCall[] } {
  const calls: AlarmCall[] = [];
  const storage: AlarmStorage = {
    setAlarm(at: number | Date) {
      calls.push({ op: 'set', at: typeof at === 'number' ? at : at.getTime() });
    },
    deleteAlarm() {
      calls.push({ op: 'delete' });
    },
  };
  return { storage, calls };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks run (no clock involved). */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function timerRows(db: Db) {
  return db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM timers ORDER BY name');
}

function rowOf(db: Db, name: string) {
  return db.one<{ due_at: number }>('SELECT due_at FROM timers WHERE name = ?', name)?.due_at ?? null;
}

function counterOf(db: Db, counter: string, label: string): number | null {
  return (
    db.one<{ value: number }>('SELECT value FROM counters WHERE name = ? AND label = ?', counter, label)?.value ?? null
  );
}

/** Handlers for every core timer that record their calls; `block[name]` holds a handler open. */
function coreHandlers(calls: string[], block: Partial<Record<string, Promise<void>>> = {}): TimerHandlers {
  return Object.fromEntries(
    TIMER_NAMES.map((name) => [
      name,
      async () => {
        calls.push(name);
        await block[name];
      },
    ]),
  ) as unknown as TimerHandlers;
}

function extensionHandlers(calls: string[], block: Partial<Record<string, Promise<void>>> = {}): LaneHandlers {
  return Object.fromEntries(
    EXTENSION_TIMER_NAMES.map((name) => [
      name,
      async () => {
        calls.push(name);
        await block[name];
      },
    ]),
  ) as LaneHandlers;
}

const refusingTransport: Transport = async (req) => {
  throw new TypeError(`no network in tests: ${req.url}`);
};

interface CoreKit {
  core: IndexCore;
  db: Db;
  clock: FixedClock;
  coreAlarm: ReturnType<typeof recordingAlarms>;
  extAlarm: ReturnType<typeof recordingAlarms>;
  logs: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }>;
}

/** IndexCore over the harness storage with a recording Host; migrated, not started. */
function coreKit(
  state: DurableObjectState,
  extensions: CoreExtension[],
  o: { identity?: IdentityResolver } = {},
): CoreKit {
  const db = doDb(state.storage);
  const clock = fixedClock();
  const coreAlarm = recordingAlarms();
  const extAlarm = recordingAlarms();
  const logs: CoreKit['logs'] = [];
  const host: Host = {
    db,
    alarm: coreAlarm.storage,
    extensionAlarm: extAlarm.storage,
    connectJetstream: async () => {
      throw new TypeError('no Jetstream in tests');
    },
    transport: refusingTransport,
    log: {
      log(level, event, fields) {
        logs.push(fields === undefined ? { level, event } : { level, event, fields });
      },
    },
    clock,
    random: seededRandom(7),
  };
  const config = parseConfig(env, { allowFixturePrefix: true });
  const core = new IndexCore(config, host, extensions, o.identity === undefined ? {} : { identity: o.identity });
  core.markMigrated(migrate(state.storage));
  return { core, db, clock, coreAlarm, extAlarm, logs };
}

function extension(
  name: string,
  timers: Partial<Record<ExtensionTimerName, (now: number, ctx: ExtensionContext) => Promise<void>>>,
): CoreExtension {
  return { name, timers };
}

it("TIMER_NAMES is the seven core names, EXTENSION_TIMER_NAMES the six extension names, and nextDue for one lane ignores the other lane's due rows", async () => {
  expect([...TIMER_NAMES]).toEqual([
    'drain',
    'snapshot',
    'jetstream-watchdog',
    'status-sweep',
    'identity-sweep',
    'discovery',
    'gc',
  ]);
  expect([...EXTENSION_TIMER_NAMES]).toEqual([
    'outbox',
    'forward',
    'import',
    'oauth-keepalive',
    'expiry-sweep',
    'backup',
  ]);
  expect(CORE_LANE.names).toBe(TIMER_NAMES);
  expect(EXTENSION_LANE.names).toBe(EXTENSION_TIMER_NAMES);

  await runInDurableObject(stubFor('timers-ext-names'), async (_i: HarnessDO, state) => {
    const db = doDb(state.storage);
    expect(nextDue(db)).toBeNull();
    expect(nextDue(db, EXTENSION_LANE)).toBeNull();

    // An extension row earlier than every core row, and a core row earlier than the other extension rows.
    schedule(db, 'outbox', NOW + SECOND);
    schedule(db, 'drain', NOW + 5 * SECOND);
    schedule(db, 'backup', NOW + 9 * SECOND);
    expect(nextDue(db)).toBe(NOW + 5 * SECOND);
    expect(nextDue(db, CORE_LANE)).toBe(NOW + 5 * SECOND);
    expect(nextDue(db, EXTENSION_LANE)).toBe(NOW + SECOND);

    // A claimed row counts for its own lane only.
    db.run("INSERT INTO timers(name, due_at) VALUES ('~running:backup', ?)", NOW - MINUTE);
    db.run("INSERT INTO timers(name, due_at) VALUES ('~running:gc', ?)", NOW + 2 * SECOND);
    expect(nextDue(db)).toBe(NOW + 2 * SECOND);
    expect(nextDue(db, EXTENSION_LANE)).toBe(NOW - MINUTE);
    // Unknown names belong to no lane.
    db.run("INSERT INTO timers(name, due_at) VALUES ('later-feature', ?)", NOW - 2 * MINUTE);
    expect(nextDue(db)).toBe(NOW + 2 * SECOND);
    expect(nextDue(db, EXTENSION_LANE)).toBe(NOW - MINUTE);

    // A lane subset sees only its names.
    expect(nextDue(db, { names: ['forward', 'import'] })).toBeNull();
    expect(nextDue(db, { names: ['drain'] })).toBe(NOW + 5 * SECOND);

    // armAlarm arms each lane's storage at that lane's minimum.
    const core = recordingAlarms();
    const ext = recordingAlarms();
    expect(armAlarm(core.storage, db)).toBe(NOW + 2 * SECOND);
    expect(armAlarm(ext.storage, db, EXTENSION_LANE)).toBe(NOW - MINUTE);
    expect(core.calls).toEqual([{ op: 'set', at: NOW + 2 * SECOND }]);
    expect(ext.calls).toEqual([{ op: 'set', at: NOW - MINUTE }]);
    expect(() => nextDue(db, { names: ['nope' as ExtensionTimerName] })).toThrow(TypeError);
  });
});

it('runDue with a names subset claims only those timers, and two lanes over two AlarmStorage objects never hit TimerReentryError', async () => {
  await runInDurableObject(stubFor('timers-ext-subset'), async (_i: HarnessDO, state) => {
    const db = doDb(state.storage);
    for (const name of [...TIMER_NAMES, ...EXTENSION_TIMER_NAMES]) schedule(db, name, NOW - MINUTE);
    const calls: string[] = [];
    const handlers = { ...coreHandlers(calls), ...extensionHandlers(calls) };

    // Only the subset (given out of order) runs, in priority order; the rest keep their rows.
    const subset = await runDue(state.storage, db, NOW, handlers, UNLIMITED, { names: ['gc', 'forward', 'drain'] });
    expect(subset).toEqual({
      ran: ['drain', 'gc', 'forward'],
      failed: [],
      deferred: [],
      recovered: [],
      superseded: false,
    });
    expect(calls).toEqual(['drain', 'gc', 'forward']);
    expect(timerRows(db).map((r) => r.name)).toEqual([
      'backup',
      'discovery',
      'expiry-sweep',
      'identity-sweep',
      'import',
      'jetstream-watchdog',
      'oauth-keepalive',
      'outbox',
      'snapshot',
      'status-sweep',
    ]);
    expect(timerRows(db).every((r) => r.due_at === NOW - MINUTE)).toBe(true);

    // The default lane is the core lane: no extension timer runs.
    calls.length = 0;
    const coreRun = await runDue(state.storage, db, NOW, handlers, UNLIMITED);
    expect(coreRun.ran).toEqual(['snapshot', 'jetstream-watchdog', 'status-sweep', 'identity-sweep', 'discovery']);
    expect(timerRows(db).map((r) => r.name)).toEqual(['backup', 'expiry-sweep', 'import', 'oauth-keepalive', 'outbox']);

    // Two lanes over two storage objects run at the same time.
    const coreAlarm = recordingAlarms();
    const extAlarm = recordingAlarms();
    schedule(db, 'snapshot', NOW - MINUTE);
    calls.length = 0;
    const hold = deferred();
    const coreRunning = runDue(coreAlarm.storage, db, NOW, coreHandlers(calls, { snapshot: hold.promise }), UNLIMITED);
    await settle();
    expect(calls).toEqual(['snapshot']);
    const extRun = await runDue(extAlarm.storage, db, NOW, extensionHandlers(calls), UNLIMITED, EXTENSION_LANE);
    expect(extRun.ran).toEqual(['outbox', 'import', 'oauth-keepalive', 'expiry-sweep', 'backup']);
    expect(extRun.recovered).toEqual([]);
    // The core claim is untouched by the extension run.
    expect(timerRows(db)).toEqual([{ name: '~running:snapshot', due_at: NOW - MINUTE }]);

    // Negative control: a second run on the same storage is refused.
    await expect(
      runDue(coreAlarm.storage, db, NOW, coreHandlers([]), UNLIMITED, { names: ['gc'] }),
    ).rejects.toBeInstanceOf(TimerReentryError);
    await expect(
      runDue(coreAlarm.storage, db, NOW, extensionHandlers([]), UNLIMITED, EXTENSION_LANE),
    ).rejects.toBeInstanceOf(TimerReentryError);

    hold.resolve();
    const coreDone = await coreRunning;
    expect(coreDone.ran).toEqual(['snapshot']);
    expect(timerRows(db)).toEqual([]);
  });
});

it('a core runDue started while outbox is claimed leaves ~running:outbox untouched and records no failure', async () => {
  await runInDurableObject(stubFor('timers-ext-orphan-scope'), async (_i: HarnessDO, state) => {
    const db = doDb(state.storage);
    const coreAlarm = recordingAlarms();
    const extAlarm = recordingAlarms();
    schedule(db, 'outbox', NOW - SECOND);
    schedule(db, 'gc', NOW - SECOND);
    const calls: string[] = [];
    const hold = deferred();
    const extRunning = runDue(
      extAlarm.storage,
      db,
      NOW,
      extensionHandlers(calls, { outbox: hold.promise }),
      UNLIMITED,
      EXTENSION_LANE,
    );
    await settle();
    expect(calls).toEqual(['outbox']);
    expect(timerRows(db)).toEqual([
      { name: 'gc', due_at: NOW - SECOND },
      { name: '~running:outbox', due_at: NOW - SECOND },
    ]);
    expect(counterOf(db, TIMER_STREAK_COUNTER, 'outbox')).toBe(1);

    // The core lane runs and arms without seeing the extension claim.
    const coreRun = await runDue(coreAlarm.storage, db, NOW, coreHandlers(calls), UNLIMITED);
    expect(coreRun).toEqual({ ran: ['gc'], failed: [], deferred: [], recovered: [], superseded: false });
    expect(timerRows(db)).toEqual([{ name: '~running:outbox', due_at: NOW - SECOND }]);
    expect(counterOf(db, TIMER_FAILURES_COUNTER, 'outbox')).toBeNull();
    expect(counterOf(db, TIMER_STREAK_COUNTER, 'outbox')).toBe(1);
    expect(armAlarm(coreAlarm.storage, db)).toBeNull();
    expect(coreAlarm.calls).toEqual([{ op: 'delete' }]);

    hold.resolve();
    const extDone = await extRunning;
    expect(extDone).toEqual({ ran: ['outbox'], failed: [], deferred: [], recovered: [], superseded: false });
    expect(timerRows(db)).toEqual([]);
    expect(counterOf(db, TIMER_STREAK_COUNTER, 'outbox')).toBeNull();
    expect(counterOf(db, TIMER_FAILURES_COUNTER, 'outbox')).toBeNull();

    // Positive control: an extension-lane run does recover its own orphan.
    db.run("INSERT INTO timers(name, due_at) VALUES ('~running:forward', ?)", NOW - MINUTE);
    const recovery = await runDue(extAlarm.storage, db, NOW, extensionHandlers([]), { maxRuns: 0 }, EXTENSION_LANE);
    expect(recovery.recovered.map((f) => [f.name, f.retryAtMs])).toEqual([['forward', NOW + timerBackoffMs(1)]]);
    expect(counterOf(db, TIMER_FAILURES_COUNTER, 'forward')).toBe(1);
  });
});

it('extension handlers run on the extension lane in the order outbox, forward, import, oauth-keepalive, expiry-sweep, backup', async () => {
  await runInDurableObject(stubFor('timers-ext-order'), async (_i: HarnessDO, state) => {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
    };
    // Registered across two extensions, in neither the run order nor alphabetical order.
    const a = extension('a', { backup: record('backup'), import: record('import'), outbox: record('outbox') });
    const b = extension('b', {
      'expiry-sweep': record('expiry-sweep'),
      forward: record('forward'),
      'oauth-keepalive': record('oauth-keepalive'),
    });
    const k = coreKit(state, [a, b]);
    expect(k.core.extensionLane.names).toEqual([...EXTENSION_TIMER_NAMES]);
    k.core.start();
    const coreCallsAfterStart = k.coreAlarm.calls.length;
    const coreRowsBefore = timerRows(k.db).filter((r) => (TIMER_NAMES as readonly string[]).includes(r.name));
    expect(coreRowsBefore.length).toBeGreaterThan(0);

    for (const name of [...EXTENSION_TIMER_NAMES].reverse()) {
      expect(k.core.extensionTimers.schedule(name, NOW - SECOND)).toBe(NOW - SECOND);
    }
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'set', at: NOW - SECOND });

    const report = await k.core.tick('extension');
    expect(calls).toEqual([...EXTENSION_TIMER_NAMES]);
    expect(report?.ran).toEqual([...EXTENSION_TIMER_NAMES]);
    expect(k.core.lastExtensionAlarm).toBe(report);
    // No extension row is left, and the extension alarm is deleted (nothing due on its lane).
    expect(timerRows(k.db).filter((r) => (EXTENSION_TIMER_NAMES as readonly string[]).includes(r.name))).toEqual([]);
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'delete' });
    // The core lane was neither run nor re-armed by the extension run.
    expect(k.core.lastAlarm).toBeNull();
    expect(k.coreAlarm.calls).toHaveLength(coreCallsAfterStart);
    expect(timerRows(k.db).filter((r) => (TIMER_NAMES as readonly string[]).includes(r.name))).toEqual(coreRowsBefore);

    // Two extensions may not claim one name, and only extension names are accepted.
    expect(() => coreKit(state, [a, extension('c', { outbox: record('x') })])).toThrow(/already has a handler/);
    expect(() =>
      coreKit(state, [{ name: 'd', timers: { drain: record('drain') } as unknown as CoreExtension['timers'] }]),
    ).toThrow(/not an extension timer name/);
  });
});

it('a timer name without a registered handler is never written to timers and tick() skips it', async () => {
  await runInDurableObject(stubFor('timers-ext-unregistered'), async (_i: HarnessDO, state) => {
    const calls: string[] = [];
    let seen: ExtensionContext | null = null;
    const outbox: CoreExtension = {
      name: 'outbox',
      timers: {
        outbox: async () => {
          calls.push('outbox');
        },
      },
      start(ctx, now) {
        seen = ctx;
        // Scheduling a name nobody handles writes nothing.
        expect(ctx.schedule('forward', now)).toBeNull();
      },
    };
    const k = coreKit(state, [outbox]);
    expect(k.core.extensionLane.names).toEqual(['outbox']);
    k.core.start();
    expect(seen).toBe(k.core.extensionTimers);
    expect(k.core.extensionTimers.schedule('backup', NOW)).toBeNull();
    expect(k.core.extensionTimers.kick('import')).toBeNull();
    const extensionRows = () =>
      timerRows(k.db).filter((r) =>
        [...EXTENSION_TIMER_NAMES, ...EXTENSION_TIMER_NAMES.map((n) => `~running:${n}`)].includes(
          r.name as ExtensionTimerName,
        ),
      );
    expect(extensionRows()).toEqual([]);
    // Nothing was armed for the unregistered names: the lane is empty, so start() deleted the alarm.
    expect(k.extAlarm.calls).toEqual([{ op: 'delete' }]);

    // A row an older build left for an unhandled name is ignored by the lane.
    k.db.run("INSERT INTO timers(name, due_at) VALUES ('forward', ?)", NOW - MINUTE);
    expect(k.core.extensionTimers.kick('outbox')).toBe(NOW);
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'set', at: NOW });
    expect(nextDue(k.db, k.core.extensionLane)).toBe(NOW);

    const report = await k.core.tick('extension');
    expect(report).toEqual({ ran: ['outbox'], failed: [], deferred: [], recovered: [], superseded: false });
    expect(calls).toEqual(['outbox']);
    // forward is neither claimed, rescheduled nor counted, and never armed.
    expect(extensionRows()).toEqual([{ name: 'forward', due_at: NOW - MINUTE }]);
    expect(counterOf(k.db, TIMER_STREAK_COUNTER, 'forward')).toBeNull();
    expect(counterOf(k.db, TIMER_FAILURES_COUNTER, 'forward')).toBeNull();
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'delete' });
    expect(k.extAlarm.calls.some((c) => c.op === 'set' && c.at === NOW - MINUTE)).toBe(false);

    // A core without extensions never touches its extension alarm at all.
    const bare = coreKit(state, []);
    bare.core.start();
    await bare.core.ensureRunning();
    expect(await bare.core.tick('extension')).toBeNull();
    expect(bare.extAlarm.calls).toEqual([]);
    expect(bare.coreAlarm.calls.length).toBeGreaterThan(0);
  });
});

it('a throwing extension handler is re-armed at now+backoff and the core lane drain timer still runs', async () => {
  await runInDurableObject(stubFor('timers-ext-throw'), async (_i: HarnessDO, state) => {
    let attempts = 0;
    const outbox = extension('outbox', {
      outbox: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('outbox upstream failed');
      },
    });
    const k = coreKit(state, [outbox]);
    schedule(k.db, 'drain', NOW);
    expect(k.core.extensionTimers.kick('outbox')).toBe(NOW);

    const failed = await k.core.tick('extension');
    expect(failed?.ran).toEqual([]);
    expect(failed?.failed.map((f) => ({ name: f.name, retryAtMs: f.retryAtMs, streak: f.streak }))).toEqual([
      { name: 'outbox', retryAtMs: NOW + timerBackoffMs(1), streak: 1 },
    ]);
    expect(rowOf(k.db, 'outbox')).toBe(NOW + 2 * SECOND);
    expect(rowOf(k.db, '~running:outbox')).toBeNull();
    expect(counterOf(k.db, TIMER_FAILURES_COUNTER, 'outbox')).toBe(1);
    expect(counterOf(k.db, TIMER_STREAK_COUNTER, 'outbox')).toBe(1);
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'set', at: NOW + 2 * SECOND });
    expect(k.logs).toContainEqual({
      level: 'warn',
      event: 'alarm.timer_failed',
      fields: { lane: 'extension', timer: 'outbox', streak: 1, retryAtMs: NOW + 2 * SECOND, error: 'Error' },
    });
    // The failure never left the lane: no core run, and the drain row is still due.
    expect(k.core.lastAlarm).toBeNull();
    expect(rowOf(k.db, 'drain')).toBe(NOW);

    const coreRun = await k.core.runAlarmNow();
    expect(coreRun?.ran).toEqual(['drain']);
    expect(coreRun?.failed).toEqual([]);
    expect(rowOf(k.db, 'drain')).toBeNull();
    // The core run left the extension retry alone.
    expect(rowOf(k.db, 'outbox')).toBe(NOW + 2 * SECOND);
    expect(counterOf(k.db, TIMER_FAILURES_COUNTER, 'drain')).toBeNull();

    // At the retry time the handler succeeds and the streak is cleared.
    k.clock.advance(2 * SECOND);
    const retried = await k.core.tick('extension');
    expect(retried?.ran).toEqual(['outbox']);
    expect(attempts).toBe(2);
    expect(rowOf(k.db, 'outbox')).toBeNull();
    expect(counterOf(k.db, TIMER_STREAK_COUNTER, 'outbox')).toBeNull();
    expect(counterOf(k.db, TIMER_FAILURES_COUNTER, 'outbox')).toBe(1);
  });
});

it('a kicked outbox handler runs while a core snapshot handler is blocked, and the core watchdog runs while an outbox handler is blocked', async () => {
  await runInDurableObject(stubFor('timers-ext-independent'), async (_i: HarnessDO, state) => {
    // The snapshot slice resolves the DID first; this resolver holds it open.
    const identityHold = deferred();
    const resolving: string[] = [];
    const identity: IdentityResolver = {
      async resolveDid(did): Promise<ResolvedIdentity> {
        resolving.push(did);
        await identityHold.promise;
        throw new TypeError('identity unavailable in this test');
      },
      async resolveHandle(handle) {
        throw new TypeError(`no handle resolution: ${handle}`);
      },
    };
    const outboxCalls: number[] = [];
    let outboxHold: Promise<void> | undefined;
    const outbox = extension('outbox', {
      outbox: async (now) => {
        outboxCalls.push(now);
        await outboxHold;
      },
    });
    const k = coreKit(state, [outbox], { identity });
    seedUser(k.db, ALICE);
    expect(scheduleSnapshot(k.db, ALICE, 'test', NOW).status).toBe('scheduled');
    schedule(k.db, 'snapshot', NOW);

    // 1. The core lane is inside the snapshot slice.
    let coreSettled = false;
    const coreRun = k.core.runAlarmNow().then((r) => {
      coreSettled = true;
      return r;
    });
    await settle();
    expect(resolving).toEqual([ALICE]);
    expect(coreSettled).toBe(false);
    expect(rowOf(k.db, '~running:snapshot')).toBe(NOW);

    // A kick arms the extension alarm now, and the extension lane runs to completion.
    expect(k.core.extensionTimers.kick('outbox')).toBe(NOW);
    expect(k.extAlarm.calls.at(-1)).toEqual({ op: 'set', at: NOW });
    const extReport = await k.core.tick('extension');
    expect(extReport?.ran).toEqual(['outbox']);
    expect(extReport?.recovered).toEqual([]);
    expect(outboxCalls).toEqual([NOW]);
    expect(coreSettled).toBe(false);
    expect(rowOf(k.db, '~running:snapshot')).toBe(NOW);

    identityHold.resolve();
    const coreReport = await coreRun;
    expect(coreReport?.ran).toEqual(['snapshot']);
    expect(rowOf(k.db, '~running:snapshot')).toBeNull();

    // 2. The extension lane is inside a blocked outbox handler.
    const hold = deferred();
    outboxHold = hold.promise;
    expect(k.core.extensionTimers.kick('outbox')).toBe(NOW);
    let extSettled = false;
    const extRun = k.core.tick('extension').then((r) => {
      extSettled = true;
      return r;
    });
    await settle();
    expect(outboxCalls).toEqual([NOW, NOW]);
    expect(rowOf(k.db, '~running:outbox')).toBe(NOW);

    schedule(k.db, 'jetstream-watchdog', NOW);
    const watchdogRun = await k.core.runAlarmNow();
    expect(watchdogRun?.ran).toContain('jetstream-watchdog');
    expect(watchdogRun?.recovered).toEqual([]);
    expect(rowOf(k.db, 'jetstream-watchdog')).not.toBe(NOW);
    expect(extSettled).toBe(false);
    // The live outbox claim is untouched by the core run.
    expect(rowOf(k.db, '~running:outbox')).toBe(NOW);
    expect(counterOf(k.db, TIMER_FAILURES_COUNTER, 'outbox')).toBeNull();

    hold.resolve();
    const extDone = await extRun;
    expect(extDone?.ran).toEqual(['outbox']);
    expect(rowOf(k.db, '~running:outbox')).toBeNull();
  });
});
