import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';

export interface OwnedChromiumLaunch {
  ready: Promise<Browser>;
  /** Kill and reap only this launch's process group, then remove its profile. */
  terminate(deadlineAt: number): Promise<{ processStopped: boolean; profileRemoved: boolean }>;
}

export interface OwnedChromiumOptions {
  executablePath?: string;
  args?: string[];
}

function remaining(deadlineAt: number): number {
  const ms = Math.floor(deadlineAt - performance.now());
  if (ms <= 0) throw new Error('owned Chromium deadline exceeded');
  return ms;
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

async function waitForGroupGone(pid: number, deadlineAt: number): Promise<void> {
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining(deadlineAt))));
  }
}

function within<T>(promise: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  const timeout = remaining(deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeout);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Launch Chromium directly so its owned process group exists before startup
 * begins. Playwright's chromium.launch() can reject while its own detached
 * cleanup continues, leaving the caller without a handle to the browser.
 */
export function startOwnedChromium(
  interactive: boolean,
  timeoutMs: number,
  cleanupReserveMs = 250,
  options: OwnedChromiumOptions = {},
): OwnedChromiumLaunch {
  let child: ChildProcess | undefined;
  let profile: string | undefined;
  let browser: Browser | undefined;
  let termination: Promise<{ processStopped: boolean; profileRemoved: boolean }> | undefined;
  const launchDeadline = performance.now() + timeoutMs;

  const terminate = (deadlineAt: number): Promise<{ processStopped: boolean; profileRemoved: boolean }> => {
    if (termination !== undefined) return termination;
    termination = (async () => {
      if (child !== undefined) {
        const closed = waitForClose(child);
        if (child.pid !== undefined) {
          try {
            // detached:true gives this launch a private process group. Chromium
            // renderer/GPU children inherit it; never signal an unrelated PID.
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              try {
                child.kill('SIGKILL');
              } catch {
                // The close observation below decides whether cleanup is confirmed.
              }
            }
          }
        }
        try {
          await within(closed, deadlineAt, 'owned Chromium process reap');
          if (child.pid !== undefined) await waitForGroupGone(child.pid, deadlineAt);
        } catch {
          return { processStopped: false, profileRemoved: false };
        }
      }
      if (profile !== undefined) {
        try {
          await within(rm(profile, { recursive: true, force: true }), deadlineAt, 'owned Chromium profile cleanup');
        } catch {
          return { processStopped: true, profileRemoved: false };
        }
      }
      return { processStopped: true, profileRemoved: true };
    })();
    return termination;
  };

  const ready = (async () => {
    try {
      const { chromium } = await import('@playwright/test');
      profile = await mkdtemp(join(tmpdir(), 'atmusic-ingest-chromium-'));
      remaining(launchDeadline - cleanupReserveMs);
      child = spawn(
        options.executablePath ?? chromium.executablePath(),
        options.args ?? [
          '--no-first-run',
          '--no-default-browser-check',
          '--no-sandbox',
          '--disable-background-networking',
          '--disable-component-update',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          ...(interactive ? [] : ['--headless=new']),
          'about:blank',
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.once('error', () => undefined);
      child.once('exit', () => undefined);

      const portFile = join(profile, 'DevToolsActivePort');
      let endpoint: string | undefined;
      while (endpoint === undefined) {
        remaining(launchDeadline - cleanupReserveMs);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chromium exited during startup');
        try {
          const activePort = (await readFile(portFile, 'utf8')).trim().split('\n');
          const port = Number(activePort[0]);
          const path = activePort[1];
          if (Number.isInteger(port) && port > 0 && path?.startsWith('/devtools/browser/'))
            endpoint = `http://127.0.0.1:${port}`;
        } catch {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(20, remaining(launchDeadline - cleanupReserveMs))),
          );
        }
      }
      const { chromium: playwrightChromium } = await import('@playwright/test');
      browser = await within(
        playwrightChromium.connectOverCDP(endpoint),
        launchDeadline - cleanupReserveMs,
        'Chromium CDP connection',
      );
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Chromium exited during CDP connection');
      return browser;
    } catch (error) {
      await terminate(performance.now() + cleanupReserveMs);
      throw error;
    }
  })();

  return {
    ready,
    terminate: (deadlineAt) => terminate(deadlineAt),
  };
}
