// Deterministic scrobbler fakes for the Node e2e stack. The parent starts one
// IPC child per upstream; children serve only on 127.0.0.1 and use the shared
// numbered command/answer envelope used by the other e2e child processes.
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '../../packages/core/test-support/clock';
import { FakeLastfm, serveFake as serveLastfm } from '../../worker/test/node/support/fake-lastfm';
import { FakeListenBrainz } from '../../worker/test/node/support/fake-listenbrainz';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const LASTFM_API_KEY = 'e2e-lastfm-api-key';
const LASTFM_API_SECRET = 'e2e-lastfm-api-secret';
const LASTFM_USER = 'e2e-lastfm-user';
const LISTENBRAINZ_USER = 'e2e-listenbrainz-user';
const LISTENBRAINZ_TOKEN = 'e2e-listenbrainz-token';
const ENTRY = fileURLToPath(import.meta.url);

export interface FakeUpstreams {
  lastfmOrigin: string;
  listenBrainzOrigin: string;
  authorizeLastfmToken(token: string, user?: string): Promise<void>;
  snapshot(): Promise<{ lastfm: unknown; listenbrainz: unknown }>;
  close(): Promise<void>;
}

interface IpcMessage {
  type?: unknown;
  id?: unknown;
  role?: unknown;
  action?: unknown;
  token?: unknown;
  user?: unknown;
  origin?: unknown;
  result?: unknown;
  error?: unknown;
}

function fail(message: IpcMessage, error: unknown): void {
  process.send?.({ type: 'answer', id: message.id, error: error instanceof Error ? error.message : String(error) });
}

async function runChild(role: string): Promise<void> {
  if (!process.send) throw new Error('fake upstream child requires IPC');
  const clock = fixedClock(new Date(FIXED_NOW).toISOString());
  const lastfm = new FakeLastfm({
    clock,
    apiKey: LASTFM_API_KEY,
    secret: LASTFM_API_SECRET,
    host: 'lastfm.test',
  });
  lastfm.addUser(LASTFM_USER);
  lastfm.seedHistory(LASTFM_USER, [
    { artist: 'Seed Artist', track: 'Seed Track', uts: Math.floor(FIXED_NOW / 1000) - 3600 },
  ]);
  const listenbrainz = new FakeListenBrainz({ clock, host: 'listenbrainz.test' });
  listenbrainz.addToken(LISTENBRAINZ_USER, LISTENBRAINZ_TOKEN);

  const server = await serveLastfm(role === 'lastfm' ? lastfm : listenbrainz);
  process.send({ type: 'ready', role, origin: server.origin });
  let closing: Promise<void> | null = null;
  process.on('message', (raw: unknown) => {
    const message = raw as IpcMessage;
    if (message.type !== 'command' || !Number.isSafeInteger(message.id)) return;
    const answer = (result?: unknown) => process.send?.({ type: 'answer', id: message.id, result });
    try {
      if (message.action === 'authorizeLastfmToken' && role === 'lastfm') {
        if (typeof message.token !== 'string' || typeof message.user !== 'string')
          throw new TypeError('invalid Last.fm authorization command');
        lastfm.authorizeToken(message.token, message.user);
        lastfm.addUser(message.user);
        answer(true);
      } else if (message.action === 'snapshot') {
        answer(
          role === 'lastfm'
            ? { scrobbles: lastfm.scrobbles, nowPlaying: lastfm.nowPlayingCalls, calls: lastfm.calls.entries }
            : { submissions: listenbrainz.submissions, calls: listenbrainz.calls.entries },
        );
      } else if (message.action === 'stop') {
        closing ??= server.close();
        void closing.then(() => answer(true));
      } else throw new Error(`unsupported ${role} fake command ${String(message.action)}`);
    } catch (error) {
      fail(message, error);
    }
  });
  process.on('SIGTERM', () => {
    void server.close().finally(() => process.exit(0));
  });
}

function childMessage(child: ChildProcess, message: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
  if (!child.connected) return Promise.reject(new Error('fake upstream child IPC is closed'));
  return new Promise((resolve, reject) => {
    const id = Number(message.id);
    const timeout = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`fake upstream command ${id} timed out`));
    }, timeoutMs);
    const onMessage = (raw: unknown) => {
      const response = raw as IpcMessage;
      if (response.type !== 'answer' || response.id !== id) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      if (typeof response.error === 'string') reject(new Error(response.error));
      else resolve(response.result);
    };
    child.on('message', onMessage);
    child.send({ type: 'command', ...message }, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      reject(error);
    });
  });
}

async function startChild(role: 'lastfm' | 'listenbrainz'): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, '--child', role], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const startup = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${role} fake failed to announce ready`)), 10_000);
    const onMessage = (raw: unknown) => {
      const message = raw as IpcMessage;
      if (message.type !== 'ready' || message.role !== role) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      if (typeof message.origin === 'string') resolve(message.origin);
      else reject(new Error(`${role} fake announced no origin`));
    };
    child.on('message', onMessage);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`${role} fake exited during startup (${code ?? signal})`));
    });
  });
  try {
    return { child, origin: await startup };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

/** Starts the real local fake processes; caller owns and must close the result. */
export async function startFakeUpstreams(): Promise<FakeUpstreams> {
  const started: Array<{ child: ChildProcess; origin: string }> = [];
  try {
    started.push(await startChild('lastfm'));
    started.push(await startChild('listenbrainz'));
  } catch (error) {
    await Promise.all(started.map(({ child }) => stopChild(child)));
    throw error;
  }
  const lastfm = started[0]!;
  const listenbrainz = started[1]!;
  let commandId = 0;
  let closed = false;
  return {
    lastfmOrigin: lastfm.origin,
    listenBrainzOrigin: listenbrainz.origin,
    authorizeLastfmToken(token, user = LASTFM_USER) {
      if (closed) return Promise.reject(new Error('fake upstreams are closed'));
      return childMessage(lastfm.child, { id: ++commandId, action: 'authorizeLastfmToken', token, user }).then(
        () => undefined,
      );
    },
    async snapshot() {
      if (closed) throw new Error('fake upstreams are closed');
      const [lastfmSnapshot, listenbrainzSnapshot] = await Promise.all([
        childMessage(lastfm.child, { id: ++commandId, action: 'snapshot' }),
        childMessage(listenbrainz.child, { id: ++commandId, action: 'snapshot' }),
      ]);
      return { lastfm: lastfmSnapshot, listenbrainz: listenbrainzSnapshot };
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(started.map(({ child }) => stopChild(child, ++commandId)));
    },
  };
}

async function stopChild(child: ChildProcess, id = 1): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await childMessage(child, { id, action: 'stop' }, 2_000);
  } catch {
    // Continue through signal-based cleanup if the IPC stop was missed.
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

if (process.argv[2] === '--child') {
  const role = process.argv[3];
  if (role !== 'lastfm' && role !== 'listenbrainz') throw new Error(`unknown fake upstream role ${String(role)}`);
  await runChild(role);
}
