import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterAll, onTestFailed, onTestFinished, vi } from 'vitest';
import type { OwnedChromiumLaunch, OwnedChromiumOptions } from '../live/owned-chromium.ts';
import { startOwnedChromium } from '../live/owned-chromium.ts';

interface Operation {
  label: string;
  settled: boolean;
  outcome: 'pending' | 'fulfilled' | 'rejected';
  error?: string;
  done: Promise<void>;
}

interface Resource {
  label: string;
  pid?: number;
  root?: string;
  launch?: OwnedChromiumLaunch;
}

interface OwnerRecord {
  name: string;
  token: string;
  closed: boolean;
  resources: Resource[];
  operations: Operation[];
  errors: string[];
  cleanup?: Promise<void>;
}

const owners: OwnerRecord[] = [];
const OWNER_ENV = 'ATMUSIC_TEST_INGEST_OWNER';

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

/** Read-only inventory, scoped by a per-owner marker inherited at spawn time.
 * The driver and every detached browser are owned before IPC can deliver a PID.
 * Exact registered roots also cover explicitly adopted fixtures without a marker.
 */
function ownedProcesses(record: OwnerRecord): Array<{ pid: number; group: number }> {
  const roots = record.resources.flatMap((resource) => (resource.root === undefined ? [] : [resource.root]));
  const found: Array<{ pid: number; group: number }> = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const env = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0');
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      const marked = env.includes(`${OWNER_ENV}=${record.token}`);
      const rooted = args.some((arg) =>
        roots.some((root) => arg === root || arg.startsWith(`${root}/`) || arg.includes(`=${root}/`)),
      );
      if (!marked && !rooted) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      if (!validPid(pid) || !validPid(group) || pid === process.pid)
        throw new Error(`invalid owned process identity: ${pid}/${group}`);
      found.push({ pid, group });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH' && code !== 'EACCES' && code !== 'EPERM') throw error;
    }
  }
  return found;
}

function discoverAndKill(record: OwnerRecord): void {
  for (const { group } of ownedProcesses(record)) {
    if (!record.resources.some((resource) => resource.pid === group))
      record.resources.push({ pid: group, label: 'physical owned process inventory' });
  }
  for (const resource of record.resources) {
    if (resource.pid === undefined) continue;
    try {
      killGroup(resource.pid);
    } catch (error) {
      record.errors.push(`${resource.label} SIGKILL failed: ${String(error)}`);
    }
  }
}

function exists(pid: number, group = false): boolean {
  if (!validPid(pid)) throw new RangeError('invalid owned PID');
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killGroup(pid: number): void {
  const ownStat = readFileSync('/proc/self/stat', 'utf8');
  const ownGroup = Number(ownStat.slice(ownStat.lastIndexOf(')') + 2).split(' ')[2]);
  if (!validPid(pid) || pid === ownGroup) throw new RangeError('refusing to signal the test worker process group');
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitGone(pid: number, group: boolean, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (exists(pid, group)) {
    if (Date.now() >= deadline) return false;
    await realDelay(10);
  }
  return true;
}

async function waitForPromises(promises: readonly Promise<void>[], budgetMs = 2_000): Promise<boolean> {
  if (promises.length === 0) return true;
  const abort = new AbortController();
  try {
    return await Promise.race([
      Promise.all(promises).then(() => true),
      realDelay(budgetMs, false, { signal: abort.signal, ref: false }).catch((error: unknown) => {
        if ((error as Error).name === 'AbortError') return false;
        throw error;
      }),
    ]);
  } finally {
    abort.abort();
  }
}

export interface ControlledBudgetClock {
  startedAt: number;
  now(): number;
  advanceTo(absoluteMs: number): Promise<void>;
}

export interface OwnedIngestTestOwner {
  name: string;
  assertActive(): void;
  deferCleanup(callback: () => void): void;
  useControlledBudgetClock(): ControlledBudgetClock;
  startChromium(options: OwnedChromiumOptions, label?: string): OwnedChromiumLaunch;
  adoptOwnedGroup(pid: number | undefined, root?: string, label?: string): void;
  childEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  trackOperation(label: string, promise: Promise<unknown>): void;
  assertGroupGone(pid: number): void;
  cleanup(): Promise<void>;
}

export function createOwnedIngestTestOwner(name: string): OwnedIngestTestOwner {
  const record: OwnerRecord = { name, token: randomUUID(), closed: false, resources: [], operations: [], errors: [] };
  const restorers: Array<() => void> = [];
  owners.push(record);

  const drain = async () => {
    discoverAndKill(record);
    for (const resource of record.resources) {
      if (resource.pid === undefined) continue;
      if (!(await waitGone(resource.pid, true))) record.errors.push(`${resource.label} process group survived cleanup`);
      if (!(await waitGone(resource.pid, false))) record.errors.push(`${resource.label} PID survived cleanup`);
    }
    const pending = record.operations.filter((operation) => !operation.settled);
    if (!(await waitForPromises(pending.map((operation) => operation.done))))
      record.errors.push(`operations did not settle: ${pending.map((operation) => operation.label).join(', ')}`);
    // IPC adoption and asynchronous startup can finish during the first drain.
    discoverAndKill(record);
    for (const resource of record.resources) {
      if (resource.pid === undefined) continue;
      if (!(await waitGone(resource.pid, true))) record.errors.push(`${resource.label} late group survived cleanup`);
      if (!(await waitGone(resource.pid, false))) record.errors.push(`${resource.label} late PID survived cleanup`);
    }
    for (const resource of record.resources) {
      if (resource.root === undefined) continue;
      try {
        rmSync(resource.root, { recursive: true, force: true });
      } catch (error) {
        record.errors.push(`${resource.label} root removal failed: ${String(error)}`);
      }
      if (existsSync(resource.root)) record.errors.push(`${resource.label} root remains: ${resource.root}`);
    }
    if (record.errors.length > 0) throw new Error(`${name} cleanup failed: ${record.errors.join('; ')}`);
  };
  const appendDrain = () => {
    if (record.cleanup === undefined) return;
    record.cleanup = record.cleanup.catch(() => undefined).then(drain);
    void record.cleanup.catch(() => undefined);
  };
  const latestCleanup = async () => {
    let current: Promise<void> | undefined;
    do {
      current = record.cleanup;
      await current;
    } while (current !== record.cleanup);
  };

  const owner: OwnedIngestTestOwner = {
    name,
    assertActive() {
      if (record.closed) throw new Error(`test owner ${name} is closed`);
    },
    deferCleanup(callback) {
      if (record.closed) {
        callback();
        throw new Error(`cannot register cleanup after test owner ${name} closed`);
      }
      restorers.push(callback);
    },
    useControlledBudgetClock() {
      owner.assertActive();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      owner.deferCleanup(() => vi.useRealTimers());
      const startedAt = performance.now();
      return {
        startedAt,
        now: () => performance.now(),
        async advanceTo(absoluteMs) {
          owner.assertActive();
          const delta = absoluteMs - performance.now();
          if (delta < 0) throw new RangeError('controlled clock cannot move backwards');
          if (delta > 0) await vi.advanceTimersByTimeAsync(delta);
        },
      };
    },
    startChromium(options, label = 'owned Chromium') {
      owner.assertActive();
      const previous = process.env[OWNER_ENV];
      let launch: OwnedChromiumLaunch;
      try {
        process.env[OWNER_ENV] = record.token;
        launch = startOwnedChromium(options);
      } finally {
        if (previous === undefined) delete process.env[OWNER_ENV];
        else process.env[OWNER_ENV] = previous;
      }
      owner.adoptOwnedGroup(launch.pid, launch.root, label);
      const resource = record.resources.at(-1)!;
      resource.launch = launch;
      owner.trackOperation(`${label} ready`, launch.ready);
      return launch;
    },
    adoptOwnedGroup(pid, root, label = 'owned process group') {
      if (pid !== undefined && !validPid(pid)) throw new RangeError('invalid owned PID');
      if (pid === undefined && root === undefined) throw new Error('owned resource needs a PID or root');
      record.resources.push({ label, pid, root });
      if (record.closed) {
        if (pid !== undefined) killGroup(pid);
        appendDrain();
      }
    },
    childEnvironment(env = process.env) {
      owner.assertActive();
      return { ...env, [OWNER_ENV]: record.token };
    },
    trackOperation(label, promise) {
      let settle!: () => void;
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const operation: Operation = { label, settled: false, outcome: 'pending', done };
      record.operations.push(operation);
      void promise.then(
        () => {
          operation.settled = true;
          operation.outcome = 'fulfilled';
          settle();
        },
        (error: unknown) => {
          operation.settled = true;
          operation.outcome = 'rejected';
          operation.error = error instanceof Error ? error.message : String(error);
          settle();
        },
      );
      if (record.closed) appendDrain();
    },
    assertGroupGone(pid) {
      if (exists(pid, true)) throw new Error(`owned process group ${pid} is still alive`);
    },
    cleanup() {
      if (record.closed) return latestCleanup();
      record.closed = true;
      // Release barriers and restore instrumentation before awaiting any IO.
      for (const restore of restorers.splice(0).reverse()) {
        try {
          restore();
        } catch (error) {
          record.errors.push(`restore failed: ${String(error)}`);
        }
      }
      // Both known PIDs and not-yet-handed-off children are synchronously killed.
      discoverAndKill(record);
      record.cleanup = drain();
      void record.cleanup.catch(() => undefined);
      return latestCleanup();
    },
  };

  // Register both callbacks before any launch or process-group SIGSTOP.
  onTestFailed(() => owner.cleanup());
  onTestFinished(() => owner.cleanup());
  return owner;
}

afterAll(async () => {
  const survivors: string[] = [];
  for (const owner of owners) {
    let current: Promise<void> | undefined;
    do {
      current = owner.cleanup;
      try {
        await current;
      } catch (error) {
        survivors.push(`${owner.name}: cleanup rejected: ${String(error)}`);
      }
    } while (current !== owner.cleanup);
    // Read-only physical inventory catches independently detached driver children,
    // including processes whose handoff message never reached the registry.
    for (const { pid, group } of ownedProcesses(owner))
      survivors.push(`${owner.name}: physical PID/group ${pid}/${group}`);
    for (const resource of owner.resources) {
      if (resource.pid !== undefined && exists(resource.pid))
        survivors.push(`${owner.name}: PID ${resource.pid} (${resource.label})`);
      if (resource.pid !== undefined && exists(resource.pid, true))
        survivors.push(`${owner.name}: group ${resource.pid} (${resource.label})`);
      if (resource.root !== undefined && existsSync(resource.root))
        survivors.push(`${owner.name}: root ${resource.root} (${resource.label})`);
    }
    for (const operation of owner.operations) {
      if (!operation.settled) survivors.push(`${owner.name}: pending operation ${operation.label}`);
    }
    survivors.push(...owner.errors.map((error) => `${owner.name}: ${error}`));
  }
  if (survivors.length > 0) throw new Error(`owned ingest resources survived suite: ${survivors.join('\n')}`);
});
