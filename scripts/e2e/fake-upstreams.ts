// Deterministic scrobbler fakes for the Node e2e stack. The parent starts one
// IPC child per upstream; children serve only on 127.0.0.1 and use the shared
// numbered command/answer envelope used by the other e2e child processes.
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeEvent, FakeJetstream, memoryPair } from '@atmusic/atproto/test-support/fake-jetstream';
import type { CommitResult } from '@atmusic/atproto/test-support/signed-repo';
import { type WebSocket, WebSocketServer } from 'ws';
import { fixedClock } from '../../packages/core/test-support/clock';
import { FakeLastfm, serveFake as serveLastfm } from '../../worker/test/node/support/fake-lastfm';
import { FakeListenBrainz } from '../../worker/test/node/support/fake-listenbrainz';
import { startIdentityFixture } from './fixture-world';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const LASTFM_API_KEY = 'e2e-lastfm-api-key';
const LASTFM_API_SECRET = 'e2e-lastfm-api-secret';
const LASTFM_USER = 'e2e-lastfm-user';
const LISTENBRAINZ_USER = 'e2e-listenbrainz-user';
const LISTENBRAINZ_TOKEN = 'e2e-listenbrainz-token';
const ENTRY = fileURLToPath(import.meta.url);

export interface FakeUpstreams {
  identityOrigin: string;
  jetstreamUrl: string;
  lastfmOrigin: string;
  listenBrainzOrigin: string;
  accounts: Array<{ name: string; handle: string; did: string; pdsHost: string }>;
  route(request: Request): Promise<Response>;
  listRecords(
    did: string,
    collection: string,
  ): Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>>;
  drainCommits(): Array<{ did: string; commit: CommitResult }>;
  appendCommits(commits: readonly CommitResult[]): Promise<string[]>;
  authorizeLastfmToken(token: string, user?: string): Promise<void>;
  snapshot(): Promise<{ lastfm: unknown; listenbrainz: unknown }>;
  close(): Promise<void>;
}

type UpstreamRole = 'lastfm' | 'listenbrainz' | 'jetstream';
type IpcCommand =
  | { type: 'command'; id: number; action: 'stop' | 'snapshot' }
  | { type: 'command'; id: number; action: 'authorizeLastfmToken'; token: string; user: string }
  | { type: 'command'; id: number; action: 'appendCommits'; commits: CommitResult[] };
type IpcMessage =
  | { type: 'ready'; role: UpstreamRole; origin: string }
  | { type: 'answer'; id: number; result?: unknown; error?: string }
  | IpcCommand;

function fail(message: IpcCommand, error: unknown): void {
  process.send?.({ type: 'answer', id: message.id, error: error instanceof Error ? error.message : String(error) });
}

async function runScrobblerChild(role: 'lastfm' | 'listenbrainz'): Promise<void> {
  if (!process.send) throw new Error('fake upstream child requires IPC');
  const clock = fixedClock(new Date(FIXED_NOW).toISOString());
  const lastfm =
    role === 'lastfm'
      ? new FakeLastfm({ clock, apiKey: LASTFM_API_KEY, secret: LASTFM_API_SECRET, host: 'lastfm.test' })
      : null;
  if (lastfm) {
    lastfm.addUser(LASTFM_USER);
    lastfm.seedHistory(LASTFM_USER, [
      { artist: 'Seed Artist', track: 'Seed Track', uts: Math.floor(FIXED_NOW / 1000) - 3600 },
    ]);
  }
  const listenbrainz = role === 'listenbrainz' ? new FakeListenBrainz({ clock, host: 'listenbrainz.test' }) : null;
  listenbrainz?.addToken(LISTENBRAINZ_USER, LISTENBRAINZ_TOKEN);

  const server = await serveLastfm(lastfm ?? listenbrainz!);
  process.send({ type: 'ready', role, origin: server.origin });
  let closing: Promise<void> | null = null;
  process.on('message', (raw: unknown) => {
    const message = raw as IpcMessage;
    if (message.type !== 'command') return;
    const answer = (result?: unknown) => process.send?.({ type: 'answer', id: message.id, result });
    try {
      if (message.action === 'authorizeLastfmToken' && role === 'lastfm') {
        if (typeof message.token !== 'string' || typeof message.user !== 'string')
          throw new TypeError('invalid Last.fm authorization command');
        if (!lastfm) throw new Error('authorizeLastfmToken is only valid for the Last.fm child');
        lastfm.authorizeToken(message.token, message.user);
        lastfm.addUser(message.user);
        answer(true);
      } else if (message.action === 'snapshot') {
        answer(
          role === 'lastfm'
            ? { scrobbles: lastfm!.scrobbles, nowPlaying: lastfm!.nowPlayingCalls, calls: lastfm!.calls.entries }
            : { submissions: listenbrainz!.submissions, calls: listenbrainz!.calls.entries },
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

async function runJetstreamChild(): Promise<void> {
  if (!process.send) throw new Error('Jetstream child requires IPC');
  const clock = fixedClock(new Date(FIXED_NOW).toISOString());
  const fake = new FakeJetstream({ clock, host: 'jetstream.test' });
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', async (incoming: IncomingMessage, socket, head) => {
    try {
      const host = incoming.headers.host ?? 'jetstream.test';
      const request = new Request(`http://${host}${incoming.url ?? '/'}`, { headers: { upgrade: 'websocket' } });
      const handshake = await fake.handshake(request, memoryPair);
      if (handshake.kind === 'refused') {
        const body = await handshake.response.text();
        socket.write(
          `HTTP/1.1 ${handshake.response.status} ${handshake.response.statusText}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(incoming, socket, head, (wire: WebSocket) => {
        const memory = handshake.client;
        memory.addEventListener('message', (event) => {
          if (wire.readyState === wire.OPEN)
            wire.send(
              typeof (event as MessageEvent).data === 'string'
                ? (event as MessageEvent).data
                : Buffer.from((event as MessageEvent).data as ArrayBuffer),
            );
        });
        wire.on('message', (data, isBinary) => {
          if (!isBinary) memory.send(data.toString());
          else if (Array.isArray(data)) memory.send(Buffer.concat(data));
          else if (Buffer.isBuffer(data)) memory.send(data);
          else memory.send(data as ArrayBuffer);
        });
        wire.on('close', (code, reason) => {
          try {
            memory.close(code, reason.toString());
          } catch {
            /* already closed */
          }
        });
        wire.on('error', () => {
          try {
            memory.close(1011, 'wire error');
          } catch {
            /* already closed */
          }
        });
        memory.accept();
      });
    } catch (error) {
      socket.destroy(error instanceof Error ? error : undefined);
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const port = (http.address() as AddressInfo).port;
  process.send({ type: 'ready', role: 'jetstream', origin: `ws://127.0.0.1:${port}` });
  let closing: Promise<void> | null = null;
  process.on('message', (raw: unknown) => {
    const message = raw as IpcMessage;
    if (message.type !== 'command') return;
    const answer = (result?: unknown, error?: unknown) =>
      process.send?.({
        type: 'answer',
        id: message.id,
        result,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
    try {
      if (message.action === 'appendCommits' && Array.isArray(message.commits)) {
        answer((message.commits as CommitResult[]).flatMap((commit) => fake.appendCommit(commit).map(encodeEvent)));
      } else if (message.action === 'snapshot') answer(fake.events.map(encodeEvent));
      else if (message.action === 'stop') {
        for (const client of wss.clients) client.close(1001, 'fixture stopping');
        closing ??= new Promise<void>((resolve) => {
          wss.close(() => http.close(() => resolve()));
        });
        void closing.then(() => answer(true));
      } else throw new Error(`unsupported Jetstream command ${String(message.action)}`);
    } catch (error) {
      answer(undefined, error);
    }
  });
  process.on('SIGTERM', () => {
    for (const client of wss.clients) client.terminate();
    void new Promise<void>((resolve) => {
      wss.close(() => http.close(() => resolve()));
    }).finally(() => process.exit(0));
  });
}

function childMessage(child: ChildProcess, message: IpcCommand, timeoutMs = 10_000): Promise<unknown> {
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
    child.send(message, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      reject(error);
    });
  });
}

async function startChild(
  role: 'lastfm' | 'listenbrainz' | 'jetstream',
): Promise<{ child: ChildProcess; origin: string }> {
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
  let identity: Awaited<ReturnType<typeof startIdentityFixture>> | null = null;
  try {
    identity = await startIdentityFixture();
    started.push(await startChild('jetstream'));
    started.push(await startChild('lastfm'));
    started.push(await startChild('listenbrainz'));
  } catch (error) {
    await Promise.all(started.map(({ child }) => stopChild(child)));
    await identity?.close();
    throw error;
  }
  const jetstream = started[0]!;
  const lastfm = started[1]!;
  const listenbrainz = started[2]!;
  let commandId = 0;
  let closed = false;
  return {
    identityOrigin: `http://127.0.0.1:${identity.port}`,
    jetstreamUrl: jetstream.origin,
    lastfmOrigin: lastfm.origin,
    listenBrainzOrigin: listenbrainz.origin,
    accounts: identity.accounts.map(({ name, handle, did, pdsHost }) => ({ name, handle, did, pdsHost })),
    route(request) {
      if (closed) return Promise.reject(new Error('fake upstreams are closed'));
      return identity!.route(request);
    },
    async listRecords(did, collection) {
      const account = identity!.accounts.find((candidate) => candidate.did === did);
      if (!account) throw new Error(`unknown fixture DID ${did}`);
      const url = new URL(`https://${account.pdsHost}/xrpc/com.atproto.repo.listRecords`);
      url.searchParams.set('repo', did);
      url.searchParams.set('collection', collection);
      url.searchParams.set('limit', '100');
      const response = await identity!.route(new Request(url));
      if (!response.ok) throw new Error(`listRecords ${collection} for ${did}: HTTP ${response.status}`);
      return (
        (await response.json()) as { records: Array<{ uri: string; cid: string; value: Record<string, unknown> }> }
      ).records;
    },
    drainCommits: () => identity!.drainCommits(),
    async appendCommits(commits) {
      if (closed) throw new Error('fake upstreams are closed');
      if (commits.length === 0) return [];
      return (await childMessage(jetstream.child, {
        type: 'command',
        id: ++commandId,
        action: 'appendCommits',
        commits: [...commits],
      })) as string[];
    },
    authorizeLastfmToken(token, user = LASTFM_USER) {
      if (closed) return Promise.reject(new Error('fake upstreams are closed'));
      return childMessage(lastfm.child, {
        type: 'command',
        id: ++commandId,
        action: 'authorizeLastfmToken',
        token,
        user,
      }).then(() => undefined);
    },
    async snapshot() {
      if (closed) throw new Error('fake upstreams are closed');
      const [lastfmSnapshot, listenbrainzSnapshot] = await Promise.all([
        childMessage(lastfm.child, { type: 'command', id: ++commandId, action: 'snapshot' }),
        childMessage(listenbrainz.child, { type: 'command', id: ++commandId, action: 'snapshot' }),
      ]);
      return { lastfm: lastfmSnapshot, listenbrainz: listenbrainzSnapshot };
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...started.map(({ child }) => stopChild(child, ++commandId)), identity!.close()]);
    },
  };
}

async function stopChild(child: ChildProcess, id = 1): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await childMessage(child, { type: 'command', id, action: 'stop' }, 2_000);
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
  if (role === 'jetstream') await runJetstreamChild();
  else if (role === 'lastfm' || role === 'listenbrainz') await runScrobblerChild(role);
  else throw new Error(`unknown fake upstream role ${String(role)}`);
}
