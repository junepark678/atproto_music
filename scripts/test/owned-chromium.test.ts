import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { MIN_CDP_CONNECT_MS } from '../live/owned-chromium.ts';
import { createOwnedIngestTestOwner } from './owned-ingest-test-owner.ts';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
const chromiumExecutable = chromium.executablePath();
const tsx = require.resolve('tsx/cli') as string;
const driver = fileURLToPath(new URL('./owned-chromium-driver.ts', import.meta.url));

function processExists(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function deadlines(launchMs = 800, cleanupMs = launchMs + 500) {
  const launchDeadlineAt = performance.now() + launchMs;
  return { launchDeadlineAt, cleanupDeadlineAt: launchDeadlineAt + cleanupMs - launchMs };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('an unresponsive owned startup process is killed and reaped before ready rejects', async () => {
  const owner = createOwnedIngestTestOwner('unresponsive startup');
  const evidenceDir = await mkdtemp(join(tmpdir(), 'atmusic-owned-test-'));
  owner.deferCleanup(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const pidFile = join(evidenceDir, 'pid');
  // Leave room for the child Node process to start when the full suite is
  // under load; the assertion still verifies it is stopped within the bound.
  const deadline = deadlines(2_000, 2_500);
  const startedAt = performance.now();
  const launch = owner.startChromium({
    interactive: false,
    ...deadline,
    executablePath: process.execPath,
    args: () => [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
  });

  try {
    await expect(launch.ready).rejects.toThrow(/deadline exceeded|budget exhausted/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(performance.now() - startedAt).toBeLessThan(2_200);
    expect(processExists(pid)).toBe(false);
    expect(processExists(pid, true)).toBe(false);
    expect(await launch.terminate()).toMatchObject({
      processStopped: true,
      profileRemoved: true,
      connectionSettled: true,
    });
  } finally {
    await owner.cleanup();
  }
});

test('owner guards synchronous acquisition failure and blocks late resource acquisition after abort cleanup', async () => {
  const owner = createOwnedIngestTestOwner('acquisition and late continuation controls');
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  owner.deferCleanup(() => connect.mockRestore());
  const late = deferred<void>();
  let partialRoot: string | undefined;
  const continuation = late.promise.then(() => {
    expect(() => owner.startChromium({ interactive: false, launchDeadlineAt: 0, cleanupDeadlineAt: 0 })).toThrow(
      'test owner acquisition and late continuation controls is closed',
    );
  });
  try {
    expect(() =>
      owner.startChromium({
        interactive: false,
        ...deadlines(),
        args(profile) {
          partialRoot = dirname(profile);
          throw new Error('injected synchronous failure after profile acquisition');
        },
      }),
    ).toThrow('injected synchronous failure after profile acquisition');
    expect(partialRoot).toBeDefined();
    expect(existsSync(partialRoot!)).toBe(false);
    expect(() => owner.startChromium({ interactive: false, launchDeadlineAt: 0, cleanupDeadlineAt: 0 })).toThrow(
      /launch deadline exceeded/,
    );
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    owner.adoptOwnedGroup(child.pid!, undefined, 'body failure control child');
    expect(() => owner.assertGroupGone(child.pid!)).toThrow(/still alive/);
    throw new Error('controlled body failure');
  } catch (error) {
    expect(error).toMatchObject({ message: 'controlled body failure' });
  } finally {
    await owner.cleanup();
    late.resolve();
    await continuation;
  }
  expect(vi.isMockFunction(chromium.connectOverCDP)).toBe(false);
});

test('owner cleans a failed spawn without a PID and preserves root ownership', async () => {
  const owner = createOwnedIngestTestOwner('missing executable');
  const launch = owner.startChromium({
    interactive: false,
    ...deadlines(2_000, 2_500),
    executablePath: join(tmpdir(), 'atmusic-nonexistent-chromium', 'chrome'),
  });
  expect(launch.pid).toBeUndefined();
  await expect(launch.ready).rejects.toThrow('failed to spawn');
  expect(await launch.terminate()).toEqual({ processStopped: true, profileRemoved: true, connectionSettled: true });
  await owner.cleanup();
  await expect(access(launch.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('owner cancels the operation-drain deadline when pending work settles first', async () => {
  const owner = createOwnedIngestTestOwner('operation drain timer');
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  owner.trackOperation('short real operation', realDelay(10));
  await owner.cleanup();
  expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBeLessThanOrEqual(before);
});

test.fails('runner failure hook kills an owned group before releasing a suspended continuation', async () => {
  const owner = createOwnedIngestTestOwner('runner failure hook control');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  owner.adoptOwnedGroup(child.pid!, undefined, 'runner failure control child');
  const held = deferred<void>();
  owner.deferCleanup(() => held.resolve());
  owner.trackOperation(
    'suspended body continuation',
    held.promise.then(() => expect(() => owner.assertActive()).toThrow(/is closed/)),
  );
  throw new Error('controlled runner failure');
});

test('a pre-ready connection rejection cannot satisfy ready-and-stopped lifecycle coverage', async () => {
  const owner = createOwnedIngestTestOwner('pre-ready rejection');
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  owner.deferCleanup(() => connect.mockRestore());
  try {
    await expect(
      access(chromiumExecutable),
      'installed local Chromium is required for lifecycle acceptance',
    ).resolves.toBeUndefined();
    connect.mockRejectedValue(new Error('controlled CDP rejection before ready'));
    const deadline = deadlines(2_000, 2_500);
    const launch = owner.startChromium({ interactive: false, ...deadline });
    let readyFulfilled = false;
    let sigstopSucceeded = false;
    const readyWithStopWitness = launch.ready.then((browser) => {
      readyFulfilled = true;
      if (launch.pid === undefined) throw new Error('owned Chromium PID is missing after ready');
      process.kill(-launch.pid, 'SIGSTOP');
      sigstopSucceeded = true;
      return browser;
    });
    await expect(readyWithStopWitness).rejects.toThrow('controlled CDP rejection before ready');
    const status = await launch.terminate();
    const evidence = { readyFulfilled, sigstopSucceeded, status };
    expect(readyFulfilled, JSON.stringify(evidence)).toBe(false);
    expect(sigstopSucceeded, JSON.stringify(evidence)).toBe(false);
    expect(status, JSON.stringify(evidence)).toEqual({
      processStopped: true,
      profileRemoved: true,
      connectionSettled: true,
    });
    expect(processExists(launch.pid!)).toBe(false);
    expect(processExists(launch.pid!, true)).toBe(false);
    await expect(access(launch.root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await owner.cleanup();
  }
});

test('actual Chromium cancellation exits promptly and leaves no profile or referenced transport handle', async () => {
  const owner = createOwnedIngestTestOwner('actual Chromium cancellation');
  try {
    await expect(
      access(chromiumExecutable),
      'installed local Chromium is required for lifecycle acceptance',
    ).resolves.toBeUndefined();
    for (const scenario of ['immediate', 'microtask', 'timed', 'stopped-handshake']) {
      const startedAt = performance.now();
      const child = spawnDriver(scenario, owner);
      const result = await child;
      // Node/tsx startup is separate from the owned browser lifecycle. Keep a
      // process-exit bound so a referenced transport handle still fails here.
      expect(performance.now() - startedAt, `${scenario} child exit`).toBeLessThan(10_000);
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as {
        root: string;
        pid: number;
        lifecycleMs: number;
        status: { processStopped: boolean; profileRemoved: boolean; connectionSettled: boolean };
      };
      expect(payload.lifecycleMs, `${scenario} lifecycle`).toBeLessThan(2_000);
      expect(payload.status).toEqual({ processStopped: true, profileRemoved: true, connectionSettled: true });
      expect(() => process.kill(payload.pid, 0)).toThrow();
      expect(() => process.kill(-payload.pid, 0)).toThrow();
      await expect(access(payload.root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await owner.cleanup();
  }
});

test('CDP connection is never started below the minimum remaining budget', async () => {
  const owner = createOwnedIngestTestOwner('minimum CDP budget');
  const deadline = deadlines(450, 850);
  const launch = owner.startChromium({
    interactive: false,
    ...deadline,
    executablePath: process.execPath,
    args: (profile) => [
      '-e',
      `const fs=require('node:fs'); const p=${JSON.stringify(profile)}; setTimeout(()=>fs.writeFileSync(p+'/DevToolsActivePort','9\\n/devtools/browser/test'), 420); setInterval(()=>{},1000)`,
    ],
  });
  try {
    await expect(launch.ready).rejects.toThrow(/budget exhausted/);
    const status = await launch.terminate();
    expect(status).toMatchObject({ processStopped: true, profileRemoved: true, connectionSettled: true });
    expect(processExists(launch.pid!, true)).toBe(false);
    expect(MIN_CDP_CONNECT_MS).toBe(100);
  } finally {
    await owner.cleanup();
  }
});

test('owner reaps a resource adopted after its first cleanup has completed', async () => {
  const owner = createOwnedIngestTestOwner('late IPC adoption');
  await owner.cleanup();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  expect(child.pid).toBeDefined();
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  owner.adoptOwnedGroup(child.pid, undefined, 'late adopted child');
  owner.trackOperation('late adopted child close', closed);
  await owner.cleanup();
  expect(processExists(child.pid!)).toBe(false);
  expect(processExists(child.pid!, true)).toBe(false);
});

test('owner discovers and reaps Chromium when its driver stops before the PID handoff', async () => {
  const owner = createOwnedIngestTestOwner('interrupted driver handoff');
  let acquisitionRoot = '';
  let evidence: { pid: number; root: string; driverPid: number } | undefined;
  const driverResult = spawnDriver('handoff-stop', owner, process.env, (root) => {
    acquisitionRoot = root;
  });
  owner.trackOperation('interrupted driver close', driverResult);
  try {
    const until = Date.now() + 5_000;
    while (evidence === undefined) {
      try {
        evidence = JSON.parse(await readFile(join(acquisitionRoot, 'handoff.json'), 'utf8')) as typeof evidence;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (Date.now() >= until) throw new Error('driver did not reach the pre-IPC handoff barrier');
        await realDelay(10);
      }
    }
    expect(evidence.pid).toBeDefined();
    expect(processExists(evidence.pid, true)).toBe(true);
    expect(await readFile(`/proc/${evidence.driverPid}/stat`, 'utf8')).toMatch(/\) T /);
    // No Chromium IPC message has arrived: discovery must use pre-spawn ownership.
    await owner.cleanup();
    await driverResult;
    expect(processExists(evidence.driverPid, true)).toBe(false);
    expect(processExists(evidence.pid)).toBe(false);
    expect(processExists(evidence.pid, true)).toBe(false);
    await expect(access(evidence.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(acquisitionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    // Safety guard for a deliberately broken discovery control, exact PID only.
    if (evidence !== undefined && processExists(evidence.pid, true))
      owner.adoptOwnedGroup(evidence.pid, evidence.root, 'handoff negative-control safety guard');
    await owner.cleanup();
  }
});

test('Playwright ECONNRESET is observed and its artifacts stay inside the removed owned root', async () => {
  const owner = createOwnedIngestTestOwner('Playwright ECONNRESET');
  const tempRoot = await mkdtemp(join(tmpdir(), 'atmusic-owned-artifact-test-'));
  owner.deferCleanup(() => rmSync(tempRoot, { recursive: true, force: true }));
  try {
    const result = await spawnDriver('reset', owner, { ...process.env, TMPDIR: tempRoot });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      readyError: string;
      status: { processStopped: boolean; profileRemoved: boolean; connectionSettled: boolean };
    };
    expect(payload.readyError).toMatch(/ECONNRESET|socket hang up|WebSocket|closed/i);
    expect(payload.status).toEqual({ processStopped: true, profileRemoved: true, connectionSettled: true });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(tempRoot)).filter((entry) => entry.startsWith('playwright-artifacts'))).toEqual([]);
  } finally {
    await owner.cleanup();
  }
});

function spawnDriver(
  scenario: string,
  owner: ReturnType<typeof createOwnedIngestTestOwner>,
  env: NodeJS.ProcessEnv = process.env,
  onAcquisition?: (root: string) => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    owner.assertActive();
    const acquisitionRoot = mkdtempSync(join(env.TMPDIR ?? tmpdir(), 'atmusic-owned-driver-'));
    owner.adoptOwnedGroup(undefined, acquisitionRoot, `driver acquisition directory ${scenario}`);
    onAcquisition?.(acquisitionRoot);
    const processChild = spawn(process.execPath, [tsx, driver, scenario], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: owner.childEnvironment({ ...env, TMPDIR: acquisitionRoot }),
    });
    if (processChild.pid !== undefined)
      owner.adoptOwnedGroup(processChild.pid, undefined, `owned Chromium driver ${scenario}`);
    let stdout = '';
    let stderr = '';
    processChild.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    processChild.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    processChild.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'pid' in message &&
        'root' in message &&
        typeof message.pid === 'number' &&
        typeof message.root === 'string'
      )
        owner.adoptOwnedGroup(message.pid, message.root, `driver Chromium ${scenario}`);
    });
    processChild.once('error', reject);
    processChild.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}
