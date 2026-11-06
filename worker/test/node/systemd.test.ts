// systemd notifications (ADR 0005 §3.10, §14.1; N3-07): READY=1 after listen,
// WATCHDOG=1 every WatchdogSec/3 while the probes pass, and
// EXTEND_TIMEOUT_USEC during the startup pre-migration backup and migration.
// run() is driven in-process with an injected notify spawner, manual timers and
// an injected monotonic clock; nothing waits for a real 20 s.

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS } from '../../src/do/schema';
import type { HostTimers, TimerHandle } from '../../src/node/alarm';
import { type BridgeOptions, type BridgeServer, createServer } from '../../src/node/http-bridge';
import { type ExitCode, type RunningServer, type RunOptions, run } from '../../src/node/run';
import { openSqliteDb } from '../../src/node/sqlite-db';
import {
  createNotifier,
  EXTEND_INTERVAL_MS,
  EXTEND_TIMEOUT_USEC,
  startWatchdog,
  watchdogIntervalMs,
} from '../../src/node/systemd';
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

function fixture(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-systemd-'));
  dirs.push(dir);
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  return {
    dir,
    dbPath: join(dir, 'state', 'atmusic.db'),
    env: {
      ...testEnv(dir),
      ATMUSIC_ASSETS_DIR: dist,
      ATMUSIC_SECRETS_FILE: secrets,
      NOTIFY_SOCKET: join(dir, 'notify.sock'),
      ...env,
    },
  };
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

interface Note {
  state: string;
  /** For READY=1: whether the listener was bound and accepted a connection right then. */
  listening?: boolean;
}

interface Harness {
  notes: Note[];
  result: Promise<ExitCode>;
  server: Promise<RunningServer>;
  log: ReturnType<typeof captureLog>;
}

/** run() with a spawner that records every state and probes the listener when READY=1 arrives. */
function startRun(
  env: Record<string, string | undefined>,
  args: string[],
  extra: Partial<RunOptions>,
  stamp: (state: string) => void = () => {},
): Harness {
  const notes: Note[] = [];
  let bridge: BridgeServer | null = null;
  const log = captureLog();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((resolve) => {
    ready = resolve;
  });
  const result = run({
    argv: ['node', 'main.mjs', ...args],
    env,
    exit: () => {},
    clock: fixedClock(),
    random: seededRandom(5),
    pid: 4242,
    busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: () => {},
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    signals: new EventEmitter(),
    serverFactory: (options: BridgeOptions) => {
      bridge = createServer(options);
      return bridge;
    },
    notifySpawner: async (states, spawnEnv) => {
      expect(spawnEnv).toEqual({ NOTIFY_SOCKET: env.NOTIFY_SOCKET });
      for (const state of states) {
        stamp(state);
        if (state === 'READY=1') {
          const b = bridge as BridgeServer | null;
          const port = b?.address?.port;
          const listening = b?.server.listening === true && port !== undefined && (await accepts(port));
          notes.push({ state, listening });
        } else {
          notes.push({ state });
        }
      }
    },
    onReady: (s) => ready(s),
    ...extra,
  });
  cleanups.push(async () => {
    const s = await Promise.race([server, result.then(() => null)]);
    if (s !== null) await s.shutdown();
    await result;
  });
  return { notes, result, server, log };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('systemd notify', () => {
  it('with NOTIFY_SOCKET set, READY=1 follows listen and WATCHDOG=1 is sent every WatchdogSec/3 only while the db and event-loop probes pass', async () => {
    const f = fixture({ WATCHDOG_USEC: '60000000', WATCHDOG_PID: '4242' });
    const timers = manualTimers();
    let mono = 1_000_000;
    const h = startRun(f.env, ['--init'], { timers, monotonicNow: () => mono });
    await h.server;
    await tick();
    // READY=1 once, after listen: at that moment the port accepted a connection.
    const readies = h.notes.filter((n) => n.state === 'READY=1');
    expect(readies).toEqual([{ state: 'READY=1', listening: true }]);
    // The watchdog: one live interval of WatchdogSec/3 = 20 s.
    const watchdog = timers.pending().filter((t) => t.kind === 'interval' && t.delayMs === 20_000);
    expect(watchdog).toHaveLength(1);
    expect(watchdogIntervalMs({ WATCHDOG_USEC: '60000000' }, 1)).toBe(20_000);
    const pings = () => h.notes.filter((n) => n.state === 'WATCHDOG=1').length;
    expect(pings()).toBe(0);

    // On time, db answering: a ping.
    mono += 20_000;
    watchdog[0]?.callback();
    await tick();
    expect(pings()).toBe(1);
    // The loop stalled 6 s past the period (lag ≥ 5 s): no ping for that tick.
    mono += 26_000;
    watchdog[0]?.callback();
    await tick();
    expect(pings()).toBe(1);
    expect(h.log.logs.find((l) => l.event === 'systemd.watchdog_skipped')).toMatchObject({ lagMs: 6_000, db: true });
    // Back on time: pings again.
    mono += 20_000;
    watchdog[0]?.callback();
    await tick();
    expect(pings()).toBe(2);
    expect(h.notes.findIndex((n) => n.state === 'WATCHDOG=1')).toBeGreaterThan(
      h.notes.findIndex((n) => n.state === 'READY=1'),
    );

    // The db probe: a failing or throwing SELECT 1 sends nothing.
    const sent: string[] = [];
    const notifier = createNotifier({
      env: { NOTIFY_SOCKET: '/run/x' },
      log: captureLog().logger,
      spawn: async (states) => {
        sent.push(...states);
      },
    });
    let dbOk: boolean | 'throw' = true;
    const unitTimers = manualTimers();
    let now = 0;
    const unit = startWatchdog({
      notifier,
      intervalMs: 20_000,
      timers: unitTimers,
      now: () => now,
      log: captureLog().logger,
      dbProbe: () => {
        if (dbOk === 'throw') throw new Error('SQLITE_IOERR');
        return dbOk;
      },
    });
    const fire = async () => {
      now += 20_000;
      unitTimers.pending()[0]?.callback();
      await notifier.flush();
    };
    await fire();
    dbOk = false;
    await fire();
    dbOk = 'throw';
    await fire();
    dbOk = true;
    await fire();
    expect(sent).toEqual(['WATCHDOG=1', 'WATCHDOG=1']);
    expect(unit.report()).toEqual({ sent: 2, skipped: 2 });
    unit.stop();
    expect(unitTimers.pending()).toEqual([]);

    // WATCHDOG_PID naming another process: no watchdog at all.
    expect(watchdogIntervalMs({ WATCHDOG_USEC: '60000000', WATCHDOG_PID: '1' }, 4242)).toBeNull();
    const other = fixture({ WATCHDOG_USEC: '60000000', WATCHDOG_PID: '4243' });
    const otherTimers = manualTimers();
    const o = startRun(other.env, ['--init'], { timers: otherTimers });
    await o.server;
    expect(otherTimers.pending().filter((t) => t.kind === 'interval' && t.delayMs === 20_000)).toEqual([]);
    expect(o.log.logs.find((l) => l.event === 'run.ready')?.watchdogMs).toBeNull();

    // Without NOTIFY_SOCKET nothing is ever spawned.
    const silent = fixture({ NOTIFY_SOCKET: undefined, WATCHDOG_USEC: '60000000' });
    const s = startRun(silent.env, ['--init'], { timers: manualTimers() });
    await s.server;
    await tick();
    expect(s.notes).toEqual([]);
  });

  it('during the startup pre-migration backup and migration EXTEND_TIMEOUT_USEC is sent at least every 20 s, and READY=1 comes only after listen', async () => {
    const f = fixture();
    // A database at version 1, large enough that its pre-migration backup takes many event-loop turns.
    mkdirSync(dirname(f.dbPath), { recursive: true });
    const legacy = openSqliteDb(f.dbPath, { create: true, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS });
    expect(migrate(legacy, MIGRATIONS.slice(0, 1))).toEqual({ status: 'ready', version: 1 });
    legacy.run('CREATE TABLE padding (x BLOB NOT NULL)');
    legacy.tx(() => {
      for (let i = 0; i < 4000; i++) legacy.run('INSERT INTO padding (x) VALUES (randomblob(3900))');
    });
    legacy.close();

    // Virtual time: every event-loop turn while the 20 s extension interval is
    // armed is one virtual second, and the interval fires at each multiple of
    // its period. The spawner stamps each EXTEND with the virtual time.
    const manual = manualTimers();
    let virtual = 0;
    let clearedAt: number | null = null;
    let eventsAtClear: string[] = [];
    const extendStamps: number[] = [];
    const pumps = new Set<TimerHandle & { cleared: boolean }>();
    const h: { log: ReturnType<typeof captureLog> | null } = { log: null };
    const timers: HostTimers = {
      ...manual,
      setInterval(callback, intervalMs) {
        if (intervalMs !== EXTEND_INTERVAL_MS) return manual.setInterval(callback, intervalMs);
        const handle: TimerHandle & { cleared: boolean } = { cleared: false };
        pumps.add(handle);
        const pump = () => {
          if (handle.cleared) return;
          virtual += 1_000;
          if (virtual % intervalMs === 0) callback();
          setImmediate(pump);
        };
        setImmediate(pump);
        return handle;
      },
      clearInterval(handle) {
        if (pumps.has(handle as TimerHandle & { cleared: boolean })) {
          (handle as { cleared: boolean }).cleared = true;
          clearedAt = virtual;
          eventsAtClear = (h.log?.logs ?? []).map((l) => l.event);
          return;
        }
        manual.clearInterval(handle);
      },
    };
    const started = startRun(f.env, [], { timers }, (state) => {
      if (state.startsWith('EXTEND_TIMEOUT_USEC=')) extendStamps.push(virtual);
    });
    h.log = started.log;
    const server = await started.server;
    await tick();

    // The keeper ran exactly over the pre-migration backup and the migration.
    expect(pumps.size).toBe(1);
    expect(clearedAt).not.toBeNull();
    expect(eventsAtClear.filter((e) => e === 'backup.completed' || e === 'run.migrated')).toEqual([
      'backup.completed',
      'run.migrated',
    ]);
    expect(started.log.logs.find((l) => l.event === 'backup.completed')?.kind).toBe('pre_migration');
    // EXTEND_TIMEOUT_USEC=60000000 at once, then at every 20 s of the phase:
    // no gap longer than 20 s, up to the end of the phase.
    const extends_ = started.notes.filter((n) => n.state.startsWith('EXTEND_TIMEOUT_USEC='));
    expect(new Set(extends_.map((n) => n.state))).toEqual(new Set([`EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`]));
    expect(EXTEND_TIMEOUT_USEC).toBe(60_000_000);
    expect(extendStamps[0]).toBe(0);
    expect(extendStamps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < extendStamps.length; i++) {
      expect((extendStamps[i] as number) - (extendStamps[i - 1] as number)).toBeLessThanOrEqual(20_000);
    }
    expect((clearedAt as unknown as number) - (extendStamps[extendStamps.length - 1] as number)).toBeLessThan(20_000);
    // READY=1 once, after every EXTEND, while the listener was accepting.
    const states = started.notes.map((n) => n.state);
    expect(states.filter((s) => s === 'READY=1')).toHaveLength(1);
    expect(states.lastIndexOf(`EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`)).toBeLessThan(states.indexOf('READY=1'));
    expect(started.notes.find((n) => n.state === 'READY=1')).toEqual({ state: 'READY=1', listening: true });
    expect(await accepts(server.address.port)).toBe(true);
  }, 60_000);
});
