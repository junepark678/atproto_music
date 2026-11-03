import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Browser, chromium } from '@playwright/test';

export const MIN_CDP_CONNECT_MS = 100;

export interface OwnedChromiumStop {
  processStopped: boolean;
  profileRemoved: boolean;
  connectionSettled: boolean;
}

export interface OwnedChromiumLaunch {
  ready: Promise<Browser>;
  readonly pid: number | undefined;
  readonly root: string;
  terminate(): Promise<OwnedChromiumStop>;
}

export interface OwnedChromiumOptions {
  interactive: boolean;
  /** Absolute performance.now() timestamp for completing CDP connection. */
  launchDeadlineAt: number;
  /** Absolute performance.now() timestamp for process, connection and profile teardown. */
  cleanupDeadlineAt: number;
  executablePath?: string;
  args?: (profileDir: string) => string[];
}

function remaining(deadlineAt: number): number {
  return Math.floor(deadlineAt - performance.now());
}

async function waitForGroupGone(pid: number, deadlineAt: number): Promise<void> {
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    const delay = Math.min(10, remaining(deadlineAt));
    if (delay <= 0) throw new Error('owned Chromium process group deadline exceeded');
    await sleep(delay);
  }
}

/** Attach rejection handling before checking the deadline or creating a timer. */
function within<T>(promise: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  void promise.catch(() => undefined);
  const timeout = remaining(deadlineAt);
  if (timeout <= 0) return Promise.reject(new Error(`${label} deadline exceeded`));
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

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error('owned Chromium startup cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('owned Chromium startup cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
      .catch(() => undefined);
  });
}

function readEndpoint(portFile: string): string | undefined {
  try {
    const [portLine, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    const port = Number(portLine);
    if (!Number.isInteger(port) || port < 1 || !path?.startsWith('/devtools/browser/')) return undefined;
    return `ws://127.0.0.1:${port}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Start Chromium directly so its process group is owned before this function
 * returns. All filesystem acquisition is synchronous, closing the window in
 * which terminate() could previously complete before startup created resources.
 */
export function startOwnedChromium(options: OwnedChromiumOptions): OwnedChromiumLaunch {
  if (options.cleanupDeadlineAt < options.launchDeadlineAt)
    throw new Error('owned Chromium cleanup deadline must not precede launch deadline');
  if (remaining(options.launchDeadlineAt) <= 0) throw new Error('owned Chromium launch deadline exceeded');

  const root = mkdtempSync(join(tmpdir(), 'atmusic-ingest-chromium-'));
  const profile = join(root, 'profile');
  const artifactsDir = join(root, 'artifacts');
  let child: ChildProcess | undefined;
  try {
    mkdirSync(profile);
    mkdirSync(artifactsDir);
    const args = options.args?.(profile) ?? [
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      ...(options.interactive ? [] : ['--headless=new']),
      'about:blank',
    ];
    if (remaining(options.launchDeadlineAt) <= 0) throw new Error('owned Chromium launch deadline exceeded');
    child = spawn(options.executablePath ?? chromium.executablePath(), args, { detached: true, stdio: 'ignore' });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const childClosed = new Promise<void>((resolve) => child!.once('close', () => resolve()));

  const stop = new AbortController();
  let connection: Promise<Browser> | undefined;
  let connectionSettled = true;
  let connected: Browser | undefined;
  let termination: Promise<OwnedChromiumStop> | undefined;
  const abortStartup = (reason: Error) => {
    if (!stop.signal.aborted) stop.abort(reason);
  };
  const launchTimer = setTimeout(
    () => abortStartup(new Error('owned Chromium launch deadline exceeded')),
    Math.max(0, remaining(options.launchDeadlineAt)),
  );
  const onChildError = () => abortStartup(new Error('owned Chromium failed to spawn'));
  const onChildExit = () => abortStartup(new Error('Chromium exited during startup'));
  child.once('error', onChildError);
  child.once('exit', onChildExit);

  const terminate = (): Promise<OwnedChromiumStop> => {
    abortStartup(new Error('owned Chromium terminated'));
    termination ??= (async () => {
      let processStopped = true;
      let profileRemoved = false;
      let settled = true;
      if (child !== undefined) {
        const closed = childClosed;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              try {
                child.kill('SIGKILL');
              } catch {
                // The close and process-group observations determine confirmation.
              }
            }
          }
        }
        try {
          await within(closed, options.cleanupDeadlineAt, 'owned Chromium process reap');
          if (child.pid !== undefined)
            await within(
              waitForGroupGone(child.pid, options.cleanupDeadlineAt),
              options.cleanupDeadlineAt,
              'owned Chromium process group reap',
            );
        } catch {
          processStopped = false;
        }
      }
      if (connection !== undefined) {
        try {
          await within(
            connection.then(
              () => undefined,
              () => undefined,
            ),
            options.cleanupDeadlineAt,
            'owned Chromium CDP connection settlement',
          );
          settled = connectionSettled;
        } catch {
          settled = false;
        }
      }
      if (connected?.isConnected()) {
        try {
          await within(
            new Promise<void>((resolve) => connected!.once('disconnected', () => resolve())),
            options.cleanupDeadlineAt,
            'owned Chromium CDP disconnect',
          );
        } catch {
          settled = false;
        }
      }
      connectionSettled = settled;
      if (processStopped && settled) {
        if (remaining(options.cleanupDeadlineAt) > 0) {
          try {
            await within(
              rm(root, { recursive: true, force: true }),
              options.cleanupDeadlineAt,
              'owned Chromium profile cleanup',
            );
          } catch {
            // The root check reports whether a timed-out rm has already completed.
          }
        }
        profileRemoved = !existsSync(root);
      }
      return { processStopped, profileRemoved, connectionSettled };
    })();
    return termination;
  };

  const ready = (async () => {
    try {
      let endpoint: string | undefined;
      const portFile = join(profile, 'DevToolsActivePort');
      while (endpoint === undefined) {
        stop.signal.throwIfAborted();
        if (remaining(options.launchDeadlineAt) < MIN_CDP_CONNECT_MS)
          throw new Error('owned Chromium CDP connection budget exhausted');
        endpoint = readEndpoint(portFile);
        if (endpoint === undefined)
          await sleep(Math.min(20, Math.max(1, remaining(options.launchDeadlineAt))), undefined, {
            signal: stop.signal,
          });
      }
      stop.signal.throwIfAborted();
      const timeout = remaining(options.launchDeadlineAt);
      if (timeout < MIN_CDP_CONNECT_MS) throw new Error('owned Chromium CDP connection budget exhausted');
      const connecting = chromium.connectOverCDP(endpoint, { timeout, artifactsDir, isLocal: true });
      connectionSettled = false;
      connection = connecting.then(
        (browser) => {
          connected = browser;
          connectionSettled = true;
          return browser;
        },
        (error: unknown) => {
          connectionSettled = true;
          throw error;
        },
      );
      void connection.catch(() => undefined);
      const browser = await raceSignal(connection, stop.signal);
      stop.signal.throwIfAborted();
      child.off('exit', onChildExit);
      return browser;
    } catch (error) {
      const failure = stop.signal.aborted ? stop.signal.reason : error;
      await terminate();
      throw failure;
    } finally {
      clearTimeout(launchTimer);
      child.off('error', onChildError);
    }
  })();
  void ready.catch(() => undefined);

  return { ready, pid: child.pid, root, terminate };
}
