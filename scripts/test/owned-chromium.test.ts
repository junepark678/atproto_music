import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { MIN_CDP_CONNECT_MS, startOwnedChromium } from '../live/owned-chromium.ts';

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

function killGroupForCleanup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // terminate() below owns confirmation; this is only a final best-effort guard.
  }
}

function deadlines(launchMs = 800, cleanupMs = launchMs + 500) {
  const launchDeadlineAt = performance.now() + launchMs;
  return { launchDeadlineAt, cleanupDeadlineAt: launchDeadlineAt + cleanupMs - launchMs };
}

test('an unresponsive owned startup process is killed and reaped before ready rejects', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'atmusic-owned-test-'));
  const pidFile = join(evidenceDir, 'pid');
  // Leave room for the child Node process to start when the full suite is
  // under load; the assertion still verifies it is stopped within the bound.
  const deadline = deadlines(2_000, 2_500);
  const startedAt = performance.now();
  const launch = startOwnedChromium({
    interactive: false,
    ...deadline,
    executablePath: process.execPath,
    args: () => [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
  });

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
  await rm(evidenceDir, { recursive: true, force: true });
});

test('a pre-ready connection rejection cannot satisfy ready-and-stopped lifecycle coverage', async () => {
  await expect(
    access(chromiumExecutable),
    'installed local Chromium is required for lifecycle acceptance',
  ).resolves.toBeUndefined();
  const connect = vi
    .spyOn(chromium, 'connectOverCDP')
    .mockRejectedValue(new Error('controlled CDP rejection before ready'));
  const deadline = deadlines(2_000, 2_500);
  const launch = startOwnedChromium({ interactive: false, ...deadline });
  let readyFulfilled = false;
  let sigstopSucceeded = false;
  const readyWithStopWitness = launch.ready.then((browser) => {
    readyFulfilled = true;
    if (launch.pid === undefined) throw new Error('owned Chromium PID is missing after ready');
    process.kill(-launch.pid, 'SIGSTOP');
    sigstopSucceeded = true;
    return browser;
  });
  try {
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
    connect.mockRestore();
    if (launch.pid !== undefined) killGroupForCleanup(launch.pid);
    await launch.terminate();
    await launch.ready.catch(() => undefined);
    await rm(launch.root, { recursive: true, force: true });
  }
});

test('actual Chromium cancellation exits promptly and leaves no profile or referenced transport handle', async () => {
  await expect(
    access(chromiumExecutable),
    'installed local Chromium is required for lifecycle acceptance',
  ).resolves.toBeUndefined();
  for (const scenario of ['immediate', 'microtask', 'timed', 'stopped-handshake']) {
    const startedAt = performance.now();
    const child = spawnDriver(scenario);
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
});

test('CDP connection is never started below the minimum remaining budget', async () => {
  const deadline = deadlines(450, 850);
  const launch = startOwnedChromium({
    interactive: false,
    ...deadline,
    executablePath: process.execPath,
    args: (profile) => [
      '-e',
      `const fs=require('node:fs'); const p=${JSON.stringify(profile)}; setTimeout(()=>fs.writeFileSync(p+'/DevToolsActivePort','9\\n/devtools/browser/test'), 420); setInterval(()=>{},1000)`,
    ],
  });
  await expect(launch.ready).rejects.toThrow(/budget exhausted/);
  const status = await launch.terminate();
  expect(status).toMatchObject({ processStopped: true, profileRemoved: true, connectionSettled: true });
  expect(processExists(launch.pid!, true)).toBe(false);
  expect(MIN_CDP_CONNECT_MS).toBe(100);
});

test('Playwright ECONNRESET is observed and its artifacts stay inside the removed owned root', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'atmusic-owned-artifact-test-'));
  const result = await spawnDriver('reset', { ...process.env, TMPDIR: tempRoot });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout.trim()) as {
    readyError: string;
    status: { processStopped: boolean; profileRemoved: boolean; connectionSettled: boolean };
  };
  expect(payload.readyError).toMatch(/ECONNRESET|socket hang up|WebSocket|closed/i);
  expect(payload.status).toEqual({ processStopped: true, profileRemoved: true, connectionSettled: true });
  const { readdir } = await import('node:fs/promises');
  expect((await readdir(tempRoot)).filter((entry) => entry.startsWith('playwright-artifacts'))).toEqual([]);
  await rm(tempRoot, { recursive: true, force: true });
});

function spawnDriver(
  scenario: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [tsx, driver, scenario], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    processChild.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    processChild.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    processChild.once('error', reject);
    processChild.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}
