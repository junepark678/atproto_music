import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { startOwnedChromium } from '../live/owned-chromium.ts';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const chromiumExecutable = require('@playwright/test').chromium.executablePath() as string;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

test('an unresponsive owned startup process is killed and reaped before ready rejects', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'atmusic-owned-test-'));
  const pidFile = join(evidenceDir, 'pid');
  const timeoutMs = 700;
  const startedAt = performance.now();
  const launch = startOwnedChromium(false, timeoutMs, 250, {
    executablePath: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
  });

  await expect(launch.ready).rejects.toThrow(/deadline exceeded/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  const emittedAt = performance.now();
  expect(emittedAt - startedAt).toBeLessThan(timeoutMs + 250);
  expect(processExists(pid)).toBe(false);
  expect(await launch.terminate(performance.now() + 100)).toEqual({ processStopped: true, profileRemoved: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(processExists(pid)).toBe(false);
  await rm(evidenceDir, { recursive: true, force: true });
});

test('installed local Chromium launches over loopback CDP and is reaped on close', async () => {
  try {
    await access(chromiumExecutable);
  } catch {
    return;
  }

  const launch = startOwnedChromium(false, 15_000);
  const browser = await launch.ready;
  const contexts = browser.contexts();
  expect(contexts.length).toBeGreaterThan(0);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');
  await context.close();
  await browser.close();
  expect(await launch.terminate(performance.now() + 5_000)).toEqual({ processStopped: true, profileRemoved: true });
});
