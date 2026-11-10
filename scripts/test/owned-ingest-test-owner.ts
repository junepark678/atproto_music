import { existsSync, rmSync } from 'node:fs';
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
  pid: number;
  root?: string;
  launch?: OwnedChromiumLaunch;
}

interface OwnerRecord {
  name: string;
  closed: boolean;
  resources: Resource[];
  operations: Operation[];
  errors: string[];
  cleanup?: Promise<void>;
}

const owners: OwnerRecord[] = [];

function exists(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killGroup(pid: number): void {
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
  return Promise.race([Promise.all(promises).then(() => true), realDelay(budgetMs).then(() => false)]);
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
  adoptOwnedGroup(pid: number, root?: string, label?: string): void;
  trackOperation(label: string, promise: Promise<unknown>): void;
  assertGroupGone(pid: number): void;
  cleanup(): Promise<void>;
}

export function createOwnedIngestTestOwner(name: string): OwnedIngestTestOwner {
  const record: OwnerRecord = { name, closed: false, resources: [], operations: [], errors: [] };
  const restorers: Array<() => void> = [];
  owners.push(record);

  const owner: OwnedIngestTestOwner = {
    name,
    assertActive() {
      if (record.closed) throw new Error('test owner ' + name + ' is closed');
    },
    deferCleanup(callback) {
      if (record.closed) {
        callback();
        throw new Error('cannot register cleanup after test owner ' + name + ' closed');
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
      const launch = startOwnedChromium(options);
      owner.adoptOwnedGroup(launch.pid!, launch.root, label);
      const resource = record.resources.at(-1)!;
      resource.launch = launch;
      owner.trackOperation(label + ' ready', launch.ready);
      return launch;
    },
    adoptOwnedGroup(pid, root, label = 'owned process group') {
      const resource: Resource = { label, pid, root };
      record.resources.push(resource);
      if (record.closed) {
        try {
          killGroup(pid);
        } catch (error) {
          record.errors.push(label + ' late kill failed: ' + String(error));
        }
        if (root !== undefined) {
          try {
            rmSync(root, { recursive: true, force: true });
          } catch (error) {
            record.errors.push(label + ' late root removal failed: ' + String(error));
          }
        }
      }
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
    },
    assertGroupGone(pid) {
      if (exists(pid, true)) throw new Error('owned process group ' + pid + ' is still alive');
    },
    cleanup() {
      if (record.cleanup !== undefined) return record.cleanup;
      record.closed = true;
      // Release barriers and restore test instrumentation before awaiting IO.
      for (const restore of restorers.splice(0).reverse()) {
        try {
          restore();
        } catch (error) {
          record.errors.push('restore failed: ' + String(error));
        }
      }
      // Kill only groups that this test owner recorded.
      for (const resource of record.resources) {
        try {
          killGroup(resource.pid);
        } catch (error) {
          record.errors.push(resource.label + ' SIGKILL failed: ' + String(error));
        }
      }
      record.cleanup = (async () => {
        for (const resource of record.resources) {
          if (!(await waitGone(resource.pid, true)))
            record.errors.push(resource.label + ' process group survived cleanup');
          if (!(await waitGone(resource.pid, false))) record.errors.push(resource.label + ' PID survived cleanup');
        }
        const pending = record.operations.filter((operation) => !operation.settled);
        if (!(await waitForPromises(pending.map((operation) => operation.done))))
          record.errors.push('operations did not settle: ' + pending.map((operation) => operation.label).join(', '));
        for (const resource of record.resources) {
          if (resource.root === undefined) continue;
          try {
            rmSync(resource.root, { recursive: true, force: true });
          } catch (error) {
            record.errors.push(resource.label + ' root removal failed: ' + String(error));
          }
          if (existsSync(resource.root)) record.errors.push(resource.label + ' root remains: ' + resource.root);
        }
        if (record.errors.length > 0) throw new Error(name + ' cleanup failed: ' + record.errors.join('; '));
      })();
      return record.cleanup;
    },
  };

  // Register both callbacks before any launch or process-group SIGSTOP.
  onTestFailed(() => owner.cleanup());
  onTestFinished(() => owner.cleanup());
  return owner;
}

afterAll(() => {
  const survivors: string[] = [];
  for (const owner of owners) {
    for (const resource of owner.resources) {
      if (exists(resource.pid)) survivors.push(owner.name + ': PID ' + resource.pid + ' (' + resource.label + ')');
      if (exists(resource.pid, true))
        survivors.push(owner.name + ': group ' + resource.pid + ' (' + resource.label + ')');
      if (resource.root !== undefined && existsSync(resource.root))
        survivors.push(owner.name + ': root ' + resource.root + ' (' + resource.label + ')');
    }
    for (const operation of owner.operations) {
      if (!operation.settled) survivors.push(owner.name + ': pending operation ' + operation.label);
    }
    survivors.push(...owner.errors.map((error) => owner.name + ': ' + error));
  }
  if (survivors.length > 0) throw new Error('owned ingest resources survived suite: ' + survivors.join('\n'));
});
