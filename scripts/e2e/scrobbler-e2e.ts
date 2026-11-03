// Integrated N8 protocol acceptance. This starts the real e2e bundle and
// separate process-backed fakes; only the explicitly allowlisted child hosts
// can receive outbound requests from the bundle.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testSecretsDocument } from '../../worker/test/node/support/app';
import { buildHeaders, main as genConfig, HEADERS_FILE, REPO_ROOT } from '../gen-config';
import { E2E_PREFIX } from './dev-env';
import { type FakeUpstreams, startFakeUpstreams } from './fake-upstreams';
import { LocalCookieJar } from './scrobbler-clients/cookie-jar';
import { runMultiScrobblerLastfm } from './scrobbler-clients/multi-scrobbler-lastfm';
import { submitNavidromeListen } from './scrobbler-clients/navidrome';
import { runPanoLastfm } from './scrobbler-clients/pano-lastfm';
import { runPanoListenBrainz } from './scrobbler-clients/pano-listenbrainz';
import { replayAppJson, replayAppRequest, replayObject, replayString } from './scrobbler-clients/replay';
import { runWebScrobbler } from './scrobbler-clients/web-scrobbler';

const PUBLIC_ORIGIN = 'https://music.214510.xyz';
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const LASTFM_HOST = 'lastfm.test';
const LISTENBRAINZ_HOST = 'listenbrainz.test';
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const SCRIPT_PATH = 'scripts/e2e/scrobbler-e2e.ts';
const BUNDLE_PATH = join(REPO_ROOT, 'worker', 'dist', 'node', 'e2e.mjs');
const PRELOAD_PATH = join(REPO_ROOT, 'scripts/e2e/scrobbler-clients/https-to-loopback.mjs');
const LASTFM_CLIENT_PATH = join(REPO_ROOT, 'scripts/e2e/scrobbler-clients/lastfm-ts-api-client.ts');
const MARKER = '.scrobbler-e2e-gate';
const IPC_TIMEOUT_MS = 15_000;

export const SCROBBLER_CASES = [
  'lastfm-ts-api 2.6.2 in a child process whose --import preload reissues https.request to http://127.2.0.1:<port> with the same path, headers and body bytes: desktop auth, track.scrobble batch and updateNowPlaying against the e2e bundle create PDS records that are indexed and returned by user.getRecentTracks',
  'Pano Last.fm (mobile session) and Pano ListenBrainz (lowercase token, return_msid), multi-scrobbler web auth via /api/auth without a slash, Web Scrobbler (scrobbles and now playing) and Navidrome sequences all land as indexed records readable through /2.0 and /1',
  'every listen accepted in the run is forwarded exactly once to the fake Last.fm and fake ListenBrainz of the linked accounts',
  'the https-to-loopback preload throws for any hostname other than music.214510.xyz, and the client child opens no other connection',
  'five replays of one POST /api/v1/scrobbles with the same Idempotency-Key against the e2e bundle produce one operation and one PDS record',
  'Pano-shaped unsigned GET reads with sk and api_key (user.getRecentTracks, user.getInfo) succeed against the e2e bundle and parse with zero-, one- and many-item pages',
  'a Web Scrobbler ListenBrainz batch with one over-long artist name answers 200, the other listens become indexed records, and the ignored listen is listed by GET /api/v1/account/ignored-listens',
] as const;

interface WireMessage {
  type?: unknown;
  id?: unknown;
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  status?: unknown;
  result?: unknown;
  error?: unknown;
  authority?: unknown;
  action?: unknown;
  apiKey?: unknown;
  token?: unknown;
  phase?: unknown;
  diagnostic?: unknown;
}

interface CaseRecord {
  target: string;
  command: string;
  executed: number;
  result: 'passed' | 'failed' | 'skipped';
  commit: string;
}

interface Session {
  did: string;
  csrfToken: string;
  jar: LocalCookieJar;
}

function writeJsonl(path: string, values: readonly unknown[]): void {
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''));
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error';
}

export async function terminateChild(child: ChildProcess, graceMs = 1500): Promise<void> {
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  if (!isRunning()) return;
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (!isRunning()) return true;
    const exited = once(child, 'exit').then(() => true);
    const timeout = new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), timeoutMs));
    return Promise.race([exited, timeout]);
  };
  try {
    child.kill('SIGTERM');
  } catch {}
  if (await waitForExit(graceMs)) return;
  try {
    child.kill('SIGKILL');
  } catch {}
  if (!(await waitForExit(graceMs))) throw new Error('owned child did not exit after kill fallback');
}

function localHttpRequest(
  origin: string,
  path: string,
  options: { method: string; headers: readonly [string, string][]; body: Buffer | null },
): Promise<Response> {
  const base = new URL(origin);
  const supplied = new URL(path, 'http://fixture.invalid');
  if (supplied.origin !== 'http://fixture.invalid') throw new Error('local fake destination refused');
  const target = new URL(base.origin);
  target.pathname = supplied.pathname;
  target.search = supplied.search;
  if (target.origin !== base.origin) throw new Error('local fake destination refused');
  return new Promise((resolveResponse, reject) => {
    const headers = Object.fromEntries(options.headers);
    headers.host = target.host;
    const req = httpRequest(target, { method: options.method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.once('aborted', () => reject(new Error('local fake response aborted')));
      incoming.once('error', () => reject(new Error('local fake response failed')));
      incoming.once('end', () => {
        const status = incoming.statusCode ?? 502;
        const bodyless = status === 204 || status === 205 || status === 304;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers as IncomingHttpHeaders)) {
          if (value === undefined) continue;
          for (const entry of Array.isArray(value) ? value : [value]) {
            if (typeof entry === 'string') responseHeaders.append(name, entry);
          }
        }
        try {
          resolveResponse(new Response(bodyless ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        } catch {
          reject(new Error('local fake response invalid'));
        }
      });
    });
    req.once('error', () => reject(new Error('local fake request failed')));
    req.end(options.body ?? undefined);
  });
}

function bundleBody(message: WireMessage): Buffer | null {
  if (message.body === null) return null;
  if (typeof message.body !== 'string') throw new Error('malformed bundle request');
  try {
    return Buffer.from(message.body, 'base64');
  } catch {
    throw new Error('malformed bundle body');
  }
}

function bundleHeaders(message: WireMessage): Array<[string, string]> {
  if (!Array.isArray(message.headers)) throw new Error('malformed bundle headers');
  const headers: Array<[string, string]> = [];
  for (const pair of message.headers) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')
      throw new Error('malformed bundle headers');
    headers.push([pair[0], pair[1]]);
  }
  return headers;
}

function responseForBundle(id: number, response: Response): Promise<Record<string, unknown>> {
  return response.arrayBuffer().then((body) => ({
    type: 'response',
    id,
    status: response.status,
    headers: [...response.headers],
    body: Buffer.from(body).toString('base64'),
  }));
}

class BundleProcess {
  readonly #child: ChildProcess;
  readonly #fakes: FakeUpstreams;
  readonly #outbound: Array<Record<string, unknown>> = [];
  #lastJetstreamSeq = 0;
  #lastDrainedCommits: ReturnType<FakeUpstreams['drainCommits']> = [];
  readonly #commands = new Map<number, { resolve(value: unknown): void; reject(): void; timer: NodeJS.Timeout }>();
  #nextCommand = 0;
  #nextResponse: Promise<void> = Promise.resolve();
  #closed = false;
  readonly port: number;

  private constructor(child: ChildProcess, fakes: FakeUpstreams, port: number) {
    this.#child = child;
    this.#fakes = fakes;
    this.port = port;
    child.on('message', (raw: unknown) => this.#message(raw));
    child.on('exit', () => {
      for (const command of this.#commands.values()) {
        clearTimeout(command.timer);
        command.reject();
      }
      this.#commands.clear();
    });
  }

  static async start(fakes: FakeUpstreams, runtimeDir: string, distDir: string, port: number): Promise<BundleProcess> {
    const secretsFile = join(runtimeDir, 'secrets.json');
    const secrets = {
      ...testSecretsDocument(),
      lastfm: { apiKey: 'e2e-lastfm-api-key', sharedSecret: 'e2e-lastfm-api-secret' },
    };
    writeFileSync(secretsFile, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
    chmodSync(secretsFile, 0o600);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATMUSIC_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ATMUSIC_LISTEN: `127.2.0.1:${port}`,
      ATMUSIC_CLIENT_IP_HEADER: 'none',
      ATMUSIC_SIGNIN_DIDS: fakes.accounts.map((account) => account.did).join(','),
      ATMUSIC_SIGNIN_POLICY: 'allowlist',
      ATMUSIC_ASSETS_DIR: distDir,
      ATMUSIC_SECRETS_FILE: secretsFile,
      ATMUSIC_TEST_NOW_MS: String(FIXTURE_NOW_MS),
      ATMUSIC_DB: join(runtimeDir, 'atmusic.db'),
      STATE_DIRECTORY: runtimeDir,
      XDG_RUNTIME_DIR: runtimeDir,
      LEXICON_PREFIX: E2E_PREFIX,
      NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.e2e.atmusic.test',
      NAMESPACE_PUBLICATION_REF: `sha256:${'0'.repeat(64)}`,
      INGEST_MODE: 'socket',
      JETSTREAM_URLS: 'wss://jetstream.test',
      ATMUSIC_TEST_JETSTREAM_WS: fakes.jetstreamUrl,
      JETSTREAM_LOOKBACK_HOURS: '24',
      RELAY_URL: 'https://relay.test/',
      LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
      LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
      LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
      ATMUSIC_LASTFM_KNOWN_CLIENTS: 'panoScrobbler:panoScrobbler:Pano Scrobbler',
    };
    const child = spawn(process.execPath, [BUNDLE_PATH, '--init'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = new Promise<{ authority: string }>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error('bundle startup timeout')), 60_000);
      const onMessage = (raw: unknown) => {
        const message = raw as WireMessage;
        if (message.type === 'ready' && typeof message.authority === 'string') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          resolveReady({ authority: message.authority });
        }
      };
      child.on('message', onMessage);
      child.once('error', () => {
        clearTimeout(timeout);
        rejectReady(new Error('bundle process failed to start'));
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        rejectReady(new Error('bundle exited during startup'));
      });
    });
    try {
      const { authority } = await ready;
      const address = new URL(`http://${authority}`);
      const reportedPort = Number(address.port);
      if (!Number.isSafeInteger(reportedPort) || reportedPort !== port || address.hostname !== '127.2.0.1') {
        throw new Error('bundle listener refused loopback address');
      }
      const bundle = new BundleProcess(child, fakes, port);
      await bundle.health();
      return bundle;
    } catch (error) {
      await terminateChild(child).catch(() => {
        throw new Error('bundle startup child cleanup failed');
      });
      throw error;
    }
  }

  get outbound(): readonly Record<string, unknown>[] {
    return this.#outbound;
  }

  get lastJetstreamSeq(): number {
    return this.#lastJetstreamSeq;
  }

  async health(): Promise<void> {
    const response = await fetch(`http://127.2.0.1:${this.port}/health/live`, { headers: { host: PUBLIC_HOST } });
    if (response.status !== 200) throw new Error('bundle health check failed');
  }

  command(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed || !this.#child.connected) return Promise.reject(new Error('bundle process is closed'));
    const id = ++this.#nextCommand;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.#commands.delete(id);
        rejectCommand(new Error('bundle command timeout'));
      }, IPC_TIMEOUT_MS);
      this.#commands.set(id, {
        resolve: resolveCommand,
        reject: () => rejectCommand(new Error('bundle command failed')),
        timer,
      });
      this.#child.send({ type: 'command', id, action, ...extra }, (error) => {
        if (!error) return;
        const command = this.#commands.get(id);
        if (command) {
          clearTimeout(command.timer);
          this.#commands.delete(id);
          command.reject();
        }
      });
    });
  }

  async pump(ms = 1000, publishCommits = true): Promise<void> {
    await this.#fakes.advance(ms);
    await this.command('pump', { advance: ms });
    this.#lastDrainedCommits = this.#fakes.drainCommits();
    if (publishCommits && this.#lastDrainedCommits.length > 0) {
      const frames = await this.#fakes.appendCommits(this.#lastDrainedCommits.map(({ commit }) => commit));
      for (const frame of frames) {
        try {
          const seq = (JSON.parse(frame) as { seq?: unknown }).seq;
          if (typeof seq === 'number' && Number.isSafeInteger(seq))
            this.#lastJetstreamSeq = Math.max(this.#lastJetstreamSeq, seq);
        } catch {
          throw new Error('fixture Jetstream emitted an invalid frame');
        }
      }
    }
  }

  async inspect(): Promise<Record<string, unknown[]>> {
    const result = await this.command('inspect');
    return replayObject(result) as Record<string, unknown[]>;
  }

  async routeIdentityRequest(
    url: URL,
    method: string,
    headers: Array<[string, string]>,
    body: Buffer | null,
  ): Promise<Response> {
    const request = new Request(url, {
      method,
      headers,
      redirect: 'manual',
      ...(body === null || method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(body) }),
    });
    return this.#fakes.route(request);
  }

  #message(raw: unknown): void {
    const message = raw as WireMessage;
    if (message.type === 'answer' && typeof message.id === 'number') {
      const command = this.#commands.get(message.id);
      if (!command) return;
      clearTimeout(command.timer);
      this.#commands.delete(message.id);
      if (typeof message.error === 'string') command.reject();
      else command.resolve(message.result);
    } else if (message.type === 'request') {
      this.#nextResponse = this.#nextResponse.then(() => this.#route(message)).catch(() => undefined);
    }
  }

  async #route(message: WireMessage): Promise<void> {
    const id = Number(message.id);
    let status: number | null = null;
    let host = 'invalid';
    const method = typeof message.method === 'string' ? message.method : 'UNKNOWN';
    let pathname = '/';
    try {
      if (!Number.isSafeInteger(id) || typeof message.url !== 'string' || typeof message.method !== 'string') {
        throw new Error('malformed outbound request');
      }
      const url = new URL(message.url);
      host = url.hostname;
      pathname = url.pathname;
      if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) {
        throw new Error('outbound URL refused');
      }
      const headers = bundleHeaders(message);
      const body = bundleBody(message);
      let response: Response;
      if (host === LASTFM_HOST) {
        response = await localHttpRequest(this.#fakes.lastfmOrigin, `${url.pathname}${url.search}`, {
          method,
          headers,
          body,
        });
      } else if (host === LISTENBRAINZ_HOST) {
        response = await localHttpRequest(this.#fakes.listenBrainzOrigin, `${url.pathname}${url.search}`, {
          method,
          headers,
          body,
        });
      } else if (
        host === 'as.test' ||
        host === 'pds1.test' ||
        host === 'pds2.test' ||
        host === 'plc.directory' ||
        host === 'cloudflare-dns.com' ||
        host === 'relay.test' ||
        host === 'alice.test' ||
        host === 'bob.test' ||
        host === 'carol.test'
      ) {
        response = await this.routeIdentityRequest(url, method, headers, body);
      } else {
        throw new Error('outbound host refused');
      }
      status = response.status;
      const reply = await responseForBundle(id, response);
      this.#outbound.push({ host, method, path: pathname, status });
      if (this.#child.connected) this.#child.send(reply);
    } catch {
      this.#outbound.push({ host, method, path: pathname, status, refused: true });
      if (this.#child.connected) {
        const reply = {
          type: 'response',
          id,
          status: 599,
          headers: [],
          body: Buffer.from('fixture route refused').toString('base64'),
        };
        this.#child.send(reply);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await terminateChild(this.#child, 3000);
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.2.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

function caseRecord(title: string, result: CaseRecord['result'], commit: string): CaseRecord {
  return {
    target: `${SCRIPT_PATH} › ${title}`,
    command: 'npx tsx scripts/e2e/scrobbler-e2e.ts',
    executed: result === 'skipped' ? 0 : 1,
    result,
    commit,
  };
}

function unixSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    if (/^\d{1,12}$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  throw new Error('protocol read omitted a valid listen timestamp');
}

function recordKey(artist: unknown, track: unknown, timestamp: unknown): string {
  if (typeof artist !== 'string' || artist.length === 0 || typeof track !== 'string' || track.length === 0)
    throw new Error('protocol read omitted listen identity');
  return JSON.stringify([artist, track, unixSeconds(timestamp)]);
}

function assertSameMultiset(expected: readonly string[], observed: readonly string[], source: string): void {
  const counts = (values: readonly string[]) => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const want = counts(expected);
  const got = counts(observed);
  if (want.size !== got.size || [...want].some(([key, count]) => got.get(key) !== count))
    throw new Error(`${source} did not return the exact accepted listen identity multiset`);
}

async function prepareAssets(distDir: string): Promise<void> {
  const vite = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      distDir,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    {
      cwd: join(REPO_ROOT, 'web'),
      env: process.env,
      encoding: 'utf8',
    },
  );
  if (vite.status !== 0) throw new Error('SPA build failed');
  const gen = genConfig(['--origin', PUBLIC_ORIGIN, '--prefix', E2E_PREFIX, '--out', distDir], {
    ...process.env,
    ATMUSIC_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    LEXICON_PREFIX: E2E_PREFIX,
  });
  if (gen !== 0) throw new Error('e2e asset configuration failed');
  writeFileSync(join(distDir, HEADERS_FILE), buildHeaders());
  const build = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-server.ts', '--check'],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf8',
    },
  );
  if (build.status !== 0) throw new Error('Node e2e bundle build failed');
}

async function signIn(
  fakes: FakeUpstreams,
  bundle: BundleProcess,
  account: FakeUpstreams['accounts'][number],
): Promise<Session> {
  const jar = new LocalCookieJar({ publicOrigin: PUBLIC_ORIGIN, transportOrigin: `http://127.2.0.1:${bundle.port}` });
  let stage = 'auth-start';
  try {
    const started = await replayAppRequest(
      jar,
      '/api/v1/auth/start',
      {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ handle: account.handle }),
      },
      [200],
    );
    const authorizeUrl = replayString(replayObject(started.body).authorizeUrl);
    stage = 'provider-authorization';
    const authorization = await fakes.route(new Request(authorizeUrl, { redirect: 'manual' }));
    if (authorization.status !== 303) throw new Error('OAuth provider did not complete fixture authorization');
    const location = authorization.headers.get('location');
    if (!location) throw new Error('OAuth provider returned no callback');
    const callback = new URL(location);
    if (callback.origin !== PUBLIC_ORIGIN) throw new Error('OAuth callback origin refused');
    stage = 'oauth-callback';
    const callbackResponse = await jar.request(`${callback.pathname}${callback.search}`);
    if (callbackResponse.status !== 303) throw new Error('OAuth callback failed');
    const sessionResult = await replayAppRequest(jar, '/api/v1/auth/session', {}, [200]);
    stage = 'session-validation';
    const sessionBody = replayObject(sessionResult.body);
    const did = replayString(sessionBody.did);
    if (did !== account.did) throw new Error('OAuth session DID did not match the requested account');
    return { did, csrfToken: replayString(sessionBody.csrfToken), jar };
  } catch {
    throw new Error(`fixture sign-in failed during ${stage}`);
  }
}

async function createLastfmApp(session: Session): Promise<{ apiKey: string; sharedSecret: string }> {
  const reply = await replayAppJson(
    session.jar,
    '/api/v1/account/lastfm-apps',
    { name: 'N8 Real Client' },
    {
      csrfToken: session.csrfToken,
      publicOrigin: PUBLIC_ORIGIN,
      acceptedStatuses: [201],
    },
  );
  const body = replayObject(reply.body);
  return { apiKey: replayString(body.apiKey), sharedSecret: replayString(body.sharedSecret) };
}

function localClientFetch(bundle: BundleProcess): typeof fetch {
  return async (input, init = {}) => {
    const supplied = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== '127.2.0.1' || Number(url.port) !== bundle.port || url.protocol !== 'http:')
      throw new Error('fixture client transport refused');
    const headers = new Headers(supplied?.headers);
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set('host', PUBLIC_HOST);
    const body = init.body ?? (supplied ? await supplied.arrayBuffer() : undefined);
    return fetch(url, { ...init, headers, body, redirect: 'manual' });
  };
}

async function createAppPassword(session: Session): Promise<string> {
  const result = await replayAppJson(
    session.jar,
    '/api/v1/account/app-passwords',
    { label: 'N8 protocol replay' },
    { csrfToken: session.csrfToken, publicOrigin: PUBLIC_ORIGIN, acceptedStatuses: [201] },
  );
  return replayString(replayObject(result.body).password);
}

async function linkListenBrainz(session: Session, fakes: FakeUpstreams): Promise<string> {
  const tokenReply = await replayAppJson(
    session.jar,
    '/api/v1/account/listenbrainz-tokens',
    { label: 'N8 protocol replay' },
    { csrfToken: session.csrfToken, publicOrigin: PUBLIC_ORIGIN, acceptedStatuses: [201] },
  );
  const incomingClientToken = replayString(replayObject(tokenReply.body).token);
  const linkedUpstreamToken = fakes.listenBrainzToken;
  if (incomingClientToken === linkedUpstreamToken) throw new Error('ListenBrainz fixture credentials must be distinct');
  await replayAppJson(
    session.jar,
    '/api/v1/links/listenbrainz',
    { token: linkedUpstreamToken },
    { csrfToken: session.csrfToken, publicOrigin: PUBLIC_ORIGIN, acceptedStatuses: [201] },
  );
  // The app-issued credential accepted from clients differs from the linked
  // upstream credential used by forwarding.
  return incomingClientToken;
}

async function linkLastfm(session: Session, fakes: FakeUpstreams): Promise<void> {
  const started = await replayAppJson(
    session.jar,
    '/api/v1/links/lastfm/start',
    {},
    { csrfToken: session.csrfToken, publicOrigin: PUBLIC_ORIGIN, acceptedStatuses: [200] },
  );
  const authorizeUrl = new URL(replayString(replayObject(started.body).authorizeUrl));
  const callback = new URL(authorizeUrl.searchParams.get('cb') ?? '');
  const state = callback.searchParams.get('state');
  if (!state || !/^[0-9a-f]{64}$/.test(state)) throw new Error('Last.fm link state was invalid');
  const token = '1234567890abcdef1234567890abcdef';
  await fakes.prepareLastfmLink(token, 'e2e-lastfm-user');
  const completed = await session.jar.request(
    `/api/v1/links/lastfm/callback?${new URLSearchParams({ state, token })}`,
    { redirect: 'manual' },
  );
  if (completed.status !== 303) throw new Error('Last.fm link callback failed');
}

async function runLastfmClient(
  bundle: BundleProcess,
  session: Session,
  account: string,
  credentials: { apiKey: string; sharedSecret: string },
): Promise<{
  result: Record<string, unknown>;
  requests: Array<{ host: string; method: string; path: string; status: number }>;
}> {
  const child = spawn(process.execPath, ['--import', PRELOAD_PATH, LASTFM_CLIENT_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ATMUSIC_E2E_SCROBBLER_PORT: String(bundle.port),
      ATMUSIC_E2E_LASTFM_API_KEY: credentials.apiKey,
      ATMUSIC_E2E_LASTFM_SHARED_SECRET: credentials.sharedSecret,
      ATMUSIC_E2E_LASTFM_USER: account,
      ATMUSIC_E2E_NOW_MS: String(FIXTURE_NOW_MS),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let result: unknown;
  let rejection: Error | null = null;
  let clientPhase = 'startup';
  let safeDiagnostic = '';
  const clientRequests: Array<{ host: string; method: string; path: string; status: number }> = [];
  const completed = new Promise<void>((resolveDone, rejectDone) => {
    const timeout = setTimeout(() => rejectDone(new Error('lastfm-ts-api child timeout')), 30_000);
    child.on('message', (raw: unknown) => {
      const message = raw as WireMessage;
      if ((message as Record<string, unknown>).type === 'request-observed') {
        const observed = message as unknown as { host?: unknown; method?: unknown; path?: unknown; status?: unknown };
        if (
          observed.host === PUBLIC_HOST &&
          typeof observed.method === 'string' &&
          typeof observed.path === 'string' &&
          typeof observed.status === 'number'
        )
          clientRequests.push({
            host: PUBLIC_HOST,
            method: observed.method,
            path: observed.path,
            status: observed.status,
          });
      } else if (
        message.type === 'command' &&
        message.action === 'approveLastfmToken' &&
        typeof message.id === 'number'
      ) {
        void (async () => {
          if (typeof message.apiKey !== 'string' || typeof message.token !== 'string')
            throw new Error('malformed approval IPC');
          const approved = await replayAppJson(
            session.jar,
            '/api/v1/lastfm/authorize',
            {
              apiKey: message.apiKey,
              token: message.token,
            },
            { csrfToken: session.csrfToken, publicOrigin: PUBLIC_ORIGIN, acceptedStatuses: [200] },
          );
          if (replayObject(approved.body).token !== message.token) throw new Error('app authorized a different token');
          child.send({ type: 'answer', id: message.id, result: true });
        })().catch(() => child.send({ type: 'answer', id: message.id as number, result: false }));
      } else if (message.type === 'command' && message.action === 'pumpJetstream' && typeof message.id === 'number') {
        void (async () => {
          let indexed = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            await bundle.pump(1000);
            const inspect = await bundle.inspect();
            const rows = Array.isArray(inspect.scrobbles) ? inspect.scrobbles : [];
            if (rows.length >= 2) {
              indexed = true;
              break;
            }
          }
          child.send({ type: 'answer', id: message.id as number, result: indexed });
        })().catch(() => child.send({ type: 'answer', id: message.id as number, result: false }));
      } else if (message.type === 'answer' && message.id === 0) {
        result = message.result;
        clearTimeout(timeout);
        resolveDone();
      } else if (message.type === 'error') {
        const safePhases = new Set([
          'configuration',
          'get-token',
          'parent-approval',
          'get-session',
          'scrobble',
          'now-playing',
          'jetstream-pump',
          'recent-read',
        ]);
        clientPhase = typeof message.phase === 'string' && safePhases.has(message.phase) ? message.phase : 'unknown';
        const diagnostic = message.diagnostic as Record<string, unknown> | undefined;
        if (diagnostic) {
          const keys = (value: unknown) =>
            Array.isArray(value)
              ? value.filter((item): item is string => typeof item === 'string' && /^[a-zA-Z]+$/.test(item)).join(',')
              : '';
          safeDiagnostic = `; rootKeys=${keys(diagnostic.rootKeys)}; recentKeys=${keys(diagnostic.recentKeys)}; trackType=${typeof diagnostic.trackType === 'string' ? diagnostic.trackType : 'unknown'}; apiError=${typeof diagnostic.apiErrorCode === 'number' ? diagnostic.apiErrorCode : 'none'}`;
        }
        const requests = clientRequests.length
          ? `; requests=${clientRequests.map(({ method, path, status }) => `${method} ${path} ${status}`).join('|')}`
          : '';
        rejection = new Error(`lastfm-ts-api client failed during ${clientPhase}${safeDiagnostic}${requests}`);
        clearTimeout(timeout);
        rejectDone(rejection);
      }
    });
    child.once('error', () => {
      clearTimeout(timeout);
      rejectDone(new Error('lastfm-ts-api child failed'));
    });
    child.once('exit', (code) => {
      if (code !== 0 && result === undefined) {
        clearTimeout(timeout);
        rejectDone(new Error('lastfm-ts-api child exited unsuccessfully'));
      }
    });
  });
  try {
    await completed;
  } finally {
    await terminateChild(child);
  }
  if (clientRequests.length) safeDiagnostic = `; requests=${clientRequests.join('|')}`;
  if (rejection !== null) throw rejection;
  return { result: replayObject(result), requests: clientRequests };
}

async function waitForIndexed(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  did: string,
  minimum: number,
): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt++) {
    await bundle.pump(1000);
    const records = await fakes.listRecords(did, `${E2E_PREFIX}.scrobble`);
    const inspect = await bundle.inspect();
    const indexedRows = inspect.scrobbles ?? [];
    const ownRows = indexedRows.filter((row) => replayObject(row).did === did);
    const checkpoints = inspect.ingest_checkpoint;
    const checkpoint = Array.isArray(checkpoints) ? replayObject(checkpoints[0]) : {};
    if (
      records.length >= minimum &&
      ownRows.length >= minimum &&
      checkpoint.connected === 1 &&
      typeof checkpoint.cursor === 'number' &&
      checkpoint.cursor >= bundle.lastJetstreamSeq
    )
      return;
  }
  throw new Error('indexing did not settle before the bounded fixture deadline');
}

async function clientCase(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  outDir: string,
  commit: string,
): Promise<CaseRecord> {
  const title = SCROBBLER_CASES[0];
  let phase = 'fixture-account';
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('alice fixture account missing');
    phase = 'oauth-signin';
    const session = await signIn(fakes, bundle, alice);
    phase = 'create-lastfm-app';
    const credentials = await createLastfmApp(session);
    phase = 'lastfm-ts-api-client';
    const clientRun = await runLastfmClient(bundle, session, alice.did, credentials);
    const result = clientRun.result;
    writeJsonl(join(outDir, 'client-sockets.jsonl'), clientRun.requests);
    if (
      result.sessionEstablished !== true ||
      result.scrobbleBatchSize !== 2 ||
      !Array.isArray(result.recentTrackNames) ||
      !result.recentTrackNames.includes('First Track') ||
      !result.recentTrackNames.includes('Second Track')
    )
      throw new Error('real client did not report the expected safe result');
    phase = 'socket-indexing';
    await waitForIndexed(bundle, fakes, session.did, 2);
    phase = 'pds-proof';
    const records = await fakes.listRecords(session.did, `${E2E_PREFIX}.scrobble`);
    const names = records.map(({ value }) => value.track).filter((track): track is string => typeof track === 'string');
    if (!names.includes('First Track') || !names.includes('Second Track'))
      throw new Error('PDS did not retain both listens');
    writeJsonl(join(outDir, 'lastfm-ts-api.jsonl'), [{ did: session.did, count: records.length, indexed: true }]);
    return caseRecord(title, 'passed', commit);
  } catch (error) {
    const childPhase =
      phase === 'lastfm-ts-api-client' && error instanceof Error
        ? /lastfm-ts-api client failed during (configuration|get-token|parent-approval|get-session|scrobble|now-playing|jetstream-pump|recent-read|unknown)/.exec(
            error.message,
          )?.[1]
        : undefined;
    const diagnostic =
      phase === 'lastfm-ts-api-client' && error instanceof Error
        ? `${/; rootKeys=[a-zA-Z,]*; recentKeys=[a-zA-Z,]*; trackType=[a-zA-Z]+; apiError=(?:[0-9]+|none)/.exec(error.message)?.[0] ?? ''}${/; requests=(?:GET|POST) [a-zA-Z0-9/._-]+ [0-9]+(?:\|(?:GET|POST) [a-zA-Z0-9/._-]+ [0-9]+)*/.exec(error.message)?.[0] ?? ''}`
        : '';
    const detail = childPhase ? `; client=${childPhase}${diagnostic}` : '';
    writeFileSync(join(outDir, 'lastfm-ts-api.log'), `scenario failed during ${phase}${detail}\n`);
    return caseRecord(title, 'failed', commit);
  }
}

async function combinedClientsCase(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  commit: string,
  outDir: string,
  listenbrainzToken: string,
): Promise<CaseRecord[]> {
  let phase = 'fixture-account';
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('fixture account missing');
    phase = 'oauth-signin';
    const session = await signIn(fakes, bundle, alice);
    phase = 'create-credentials-and-links';
    const appPassword = await createAppPassword(session);
    const origin = `http://127.2.0.1:${bundle.port}`;
    const send = localClientFetch(bundle);
    phase = 'pano-lastfm';
    await runPanoLastfm({
      origin,
      username: alice.handle,
      appPassword,
      listenedAtSeconds: Math.floor(FIXTURE_NOW_MS / 1000) - 300,
      artist: 'N8 Pano Artist',
      track: 'Pano Last.fm Listen',
      durationSeconds: 180,
      fetchImpl: send,
    });
    phase = 'pano-listenbrainz';
    await runPanoListenBrainz({
      origin,
      token: listenbrainzToken,
      listenedAtSeconds: Math.floor(FIXTURE_NOW_MS / 1000) - 240,
      artist: 'N8 Pano Artist',
      track: 'Pano ListenBrainz Listen',
      release: 'N8 Sessions',
      releaseArtist: 'N8 Pano Artist',
      durationMs: 180_000,
      fetchImpl: send,
    });
    phase = 'multi-scrobbler';
    const multi = await runMultiScrobblerLastfm({
      cookie: session.jar.cookieHeader(),
      csrfToken: session.csrfToken,
      transportOrigin: origin,
      beforeRecentRead: () => waitForIndexed(bundle, fakes, session.did, 6),
      onStage: (stage) => {
        phase = `multi-scrobbler:${stage}`;
      },
    });
    if (multi.scrobbleBatchSize !== 2) throw new Error('multi-scrobbler batch was not accepted');
    phase = 'web-scrobbler';
    await runWebScrobbler({
      origin,
      token: listenbrainzToken,
      listenedAtSeconds: Math.floor(FIXTURE_NOW_MS / 1000) - 180,
      fetchImpl: send,
    });
    phase = 'navidrome';
    const navidrome = await submitNavidromeListen(`${origin}/1/`, listenbrainzToken, send);
    if (navidrome !== 'acknowledged') throw new Error('Navidrome listen was not acknowledged');
    phase = 'ignored-listens';
    const ignoredResponse = await session.jar.request('/api/v1/account/ignored-listens');
    if (ignoredResponse.status !== 200) throw new Error('ignored listen page unavailable');
    const ignoredBody = replayObject(await ignoredResponse.json());
    const ignoredItems = ignoredBody.items;
    if (
      !Array.isArray(ignoredItems) ||
      !ignoredItems.some((item) => replayObject(item).artistPreview === 'A'.repeat(128))
    )
      throw new Error('Web Scrobbler ignored listen was not recorded');
    phase = 'socket-indexing';
    await waitForIndexed(bundle, fakes, session.did, 9);
    phase = 'pds-reads';
    const records = await fakes.listRecords(session.did, `${E2E_PREFIX}.scrobble`);
    const expectedKeys = records.map(({ value }) => recordKey(value.artist, value.track, value.listenedAt));
    const pdsOrigin = `http://127.2.0.1:${bundle.port}`;
    const lastfmUrl = new URL('/2.0/', pdsOrigin);
    lastfmUrl.search = new URLSearchParams({
      method: 'user.getRecentTracks',
      user: alice.did,
      api_key: 'panoScrobbler',
      sk: 'n8-pano-read-session',
      format: 'json',
      limit: '50',
      page: '1',
    }).toString();
    const lastfmResponse = await send(lastfmUrl, { headers: { 'user-agent': 'Pano Scrobbler/4.10 (Android)' } });
    if (!lastfmResponse.ok) throw new Error('Last.fm read did not return success');
    const lastfmRoot = replayObject(await lastfmResponse.json());
    const recent = replayObject(lastfmRoot.recenttracks).track;
    if (!Array.isArray(recent)) throw new Error('Last.fm recent read was not an array');
    const lastfmKeys = recent
      .map((raw) => {
        const item = replayObject(raw);
        const attributes = item['@attr'];
        if (
          typeof attributes === 'object' &&
          attributes !== null &&
          (attributes as Record<string, unknown>).nowplaying === 'true'
        )
          return null;
        const artist = replayObject(item.artist)['#text'];
        const date = replayObject(item.date).uts;
        return recordKey(artist, item.name, typeof date === 'string' ? Number(date) : date);
      })
      .filter((key): key is string => key !== null);
    const listenbrainzResponse = await session.jar.request(
      `/1/user/${encodeURIComponent(alice.did)}/listens?count=100`,
    );
    if (!listenbrainzResponse.ok) throw new Error('ListenBrainz read did not return success');
    const listenbrainzPayload = replayObject(replayObject(await listenbrainzResponse.json()).payload);
    if (!Array.isArray(listenbrainzPayload.listens)) throw new Error('ListenBrainz read was not an array');
    const listenbrainzKeys = listenbrainzPayload.listens.map((raw) => {
      const listen = replayObject(raw);
      const metadata = replayObject(listen.track_metadata);
      return recordKey(metadata.artist_name, metadata.track_name, listen.listened_at);
    });
    assertSameMultiset(expectedKeys, lastfmKeys, 'Last.fm read');
    assertSameMultiset(expectedKeys, listenbrainzKeys, 'ListenBrainz read');
    if (records.some(({ value }) => value.track === 'Too Long Artist'))
      throw new Error('ignored listen was published to the PDS');
    if ([...lastfmKeys, ...listenbrainzKeys].some((key) => key.includes('Too Long Artist')))
      throw new Error('ignored listen appeared in a protocol read');
    return [caseRecord(SCROBBLER_CASES[1], 'passed', commit), caseRecord(SCROBBLER_CASES[6], 'passed', commit)];
  } catch {
    writeFileSync(join(outDir, 'combined-clients.log'), `combined clients failed during ${phase}\n`);
    return [caseRecord(SCROBBLER_CASES[1], 'failed', commit), caseRecord(SCROBBLER_CASES[6], 'failed', commit)];
  }
}

async function idempotencyCase(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  commit: string,
  outDir: string,
): Promise<CaseRecord> {
  let phase = 'fixture-account';
  let firstReplayCount = 0;
  let firstReplayUniqueIds = 0;
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('fixture account missing');
    phase = 'oauth-signin';
    const session = await signIn(fakes, bundle, alice);
    const key = 'n8-five-identical-submits';
    const body = JSON.stringify({
      artist: 'N8 Idempotency Artist',
      track: 'One Durable Listen',
      listenedAt: new Date(FIXTURE_NOW_MS - 45_000).toISOString().replace('.000', ''),
    });
    const submit = async () => {
      const response = await session.jar.request('/api/v1/scrobbles', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: PUBLIC_ORIGIN,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': key,
        },
        body,
      });
      if (response.status !== 202) {
        let code = 'unknown';
        try {
          const error = replayObject(await response.json()).error;
          if (
            typeof error === 'object' &&
            error !== null &&
            typeof (error as Record<string, unknown>).code === 'string'
          )
            code = (error as Record<string, unknown>).code as string;
        } catch {}
        throw new Error(`idempotent scrobble returned HTTP ${response.status} ${code}`);
      }
      const acknowledgment = replayObject(await response.json());
      return replayString(replayObject(acknowledgment.operation).id);
    };
    phase = 'five-replays';
    const ids = [await submit(), await submit(), await submit()];
    firstReplayCount = ids.length;
    firstReplayUniqueIds = new Set(ids).size;
    if (new Set(ids).size !== 1) throw new Error('idempotent submissions returned different operations');
    phase = 'operation-poll';
    let terminalState: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      await bundle.pump(1000);
      const status = replayObject(await (await session.jar.request(`/api/v1/operations/${ids[0]}`)).json());
      if (status.state === 'succeeded') {
        terminalState = status.state;
        break;
      }
      if (status.state === 'failed' || status.state === 'cancelled') throw new Error('idempotent operation failed');
    }
    if (terminalState !== 'succeeded') throw new Error('idempotent operation did not reach succeeded');
    phase = 'post-terminal-replay';
    const finalIds = [await submit(), await submit()];
    if (finalIds.some((id) => id !== ids[0])) throw new Error('terminal replay changed operation identity');
    phase = 'pds-proof';
    const records = await fakes.listRecords(alice.did, `${E2E_PREFIX}.scrobble`);
    if (records.filter(({ value }) => value.track === 'One Durable Listen').length !== 1)
      throw new Error('idempotency replay created more than one PDS record');
    const operations = (await bundle.inspect()).operations ?? [];
    const matchingOperations = operations.filter((row) => replayObject(row).id === ids[0]);
    if (matchingOperations.length !== 1 || replayObject(matchingOperations[0]).state !== 'succeeded')
      throw new Error('idempotency did not settle as exactly one durable operation');
    return caseRecord(SCROBBLER_CASES[4], 'passed', commit);
  } catch (error) {
    const status =
      error instanceof Error ? /HTTP (400|401|403|404|409|422|429|500|503) ([a-z_]+)/.exec(error.message) : undefined;
    writeFileSync(
      join(outDir, 'idempotency.log'),
      `idempotency replay failed during ${phase}${status ? ` (HTTP ${status[1]} ${status[2]})` : ''}; ackCount=${firstReplayCount}; uniqueOps=${firstReplayUniqueIds}\n`,
    );
    return caseRecord(SCROBBLER_CASES[4], 'failed', commit);
  }
}

async function panoReadShapesCase(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  commit: string,
  outDir: string,
): Promise<CaseRecord> {
  let phase = 'fixture-account';
  const counts: number[] = [];
  let userInfoShape = 'unread';
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('fixture account missing');
    const origin = `http://127.2.0.1:${bundle.port}`;
    const send = localClientFetch(bundle);
    await waitForIndexed(bundle, fakes, alice.did, 4);
    await bundle.pump(120_000);
    const read = async (query: Record<string, string>) => {
      const url = new URL('/2.0/', origin);
      url.search = new URLSearchParams({ api_key: 'panoScrobbler', format: 'json', ...query }).toString();
      const response = await send(url, { headers: { 'user-agent': 'Pano Scrobbler/4.10 (Android)' } });
      if (response.status !== 200) throw new Error('Pano read returned a non-success status');
      return replayObject(await response.json());
    };
    const common = { method: 'user.getRecentTracks', user: alice.did, sk: 'n8-pano-shape-session' };
    phase = 'empty-page';
    const empty = replayObject((await read({ ...common, from: '2000000000', page: '2' })).recenttracks);
    counts.push(Array.isArray(empty.track) ? empty.track.length : -1);
    phase = 'one-item-page';
    const one = replayObject((await read({ ...common, limit: '1', page: '2' })).recenttracks);
    counts.push(Array.isArray(one.track) ? one.track.length : -1);
    phase = 'many-item-page';
    const many = replayObject((await read({ ...common, limit: '50' })).recenttracks);
    counts.push(Array.isArray(many.track) ? many.track.length : -1);
    if (!Array.isArray(empty.track) || empty.track.length !== 0) throw new Error('empty Pano read shape failed');
    if (!Array.isArray(one.track) || one.track.length !== 1) throw new Error('single Pano read shape failed');
    if (!Array.isArray(many.track) || many.track.length < 2) throw new Error('many Pano read shape failed');
    phase = 'user-info';
    const info = await read({ method: 'user.getInfo', user: alice.did, sk: 'n8-pano-shape-session' });
    const user = replayObject(info.user);
    userInfoShape = `keys=${Object.keys(user).sort().join(',')};name=${String(user.name)};url=${String(user.url)};counts=${typeof user.playcount},${typeof user.artist_count},${typeof user.track_count}`;
    if (
      user.name !== alice.handle ||
      user.url !== `${PUBLIC_ORIGIN}/u/${alice.did}` ||
      typeof user.playcount !== 'string' ||
      typeof user.artist_count !== 'string' ||
      typeof user.track_count !== 'string'
    )
      throw new Error('Pano user.getInfo shape failed');
    return caseRecord(SCROBBLER_CASES[5], 'passed', commit);
  } catch {
    writeFileSync(
      join(outDir, 'pano-reads.log'),
      `Pano read-shape journey failed during ${phase}; counts=${counts.join(',')}; userInfo=${userInfoShape}\n`,
    );
    return caseRecord(SCROBBLER_CASES[5], 'failed', commit);
  }
}

async function socketDeliveryDisabledControl(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
): Promise<{ pdsCommitted: boolean; indexed: boolean; mode: string; cursor: number | null }> {
  let stage = 'fixture-account';
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('negative-control account missing');
    stage = 'signin';
    const session = await signIn(fakes, bundle, alice);
    stage = 'pre-disconnect-checkpoint';
    const before = await bundle.inspect();
    const beforeCheckpointRows = before.ingest_checkpoint;
    const beforeCheckpoint = Array.isArray(beforeCheckpointRows) ? replayObject(beforeCheckpointRows[0]) : {};
    const beforeCursor = typeof beforeCheckpoint.cursor === 'number' ? beforeCheckpoint.cursor : null;
    stage = 'socket-disconnect';
    if ((await fakes.disconnectJetstream()) < 1) throw new Error('negative-control socket was not connected');
    stage = 'write-acknowledgement';
    const response = await session.jar.request('/api/v1/scrobbles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': 'n8-socket-delivery-negative-control',
      },
      body: JSON.stringify({
        artist: 'N8 Socket Control Artist',
        track: 'PDS Only Control',
        listenedAt: new Date(FIXTURE_NOW_MS - 30_000).toISOString().replace('.000', ''),
      }),
    });
    if (response.status !== 202) throw new Error('negative-control write was not accepted');
    const operationId = replayString(replayObject(replayObject(await response.json()).operation).id);
    let succeeded = false;
    stage = 'operation-settlement';
    for (let attempt = 0; attempt < 30; attempt++) {
      // Process the write, but deliberately discard its commit frame instead
      // of appending it to the disconnected Jetstream child.
      await bundle.pump(0, false);
      const operation = replayObject(await (await session.jar.request(`/api/v1/operations/${operationId}`)).json());
      if (operation.state === 'succeeded') {
        succeeded = true;
        break;
      }
      if (operation.state === 'failed' || operation.state === 'cancelled') break;
    }
    if (!succeeded) throw new Error('negative-control PDS write did not settle');
    stage = 'pds-index-separation';
    const pdsRecords = await fakes.listRecords(alice.did, `${E2E_PREFIX}.scrobble`);
    const pdsCommitted = pdsRecords.some(({ value }) => value.track === 'PDS Only Control');
    const inspect = await bundle.inspect();
    const indexed = (inspect.scrobbles ?? []).some((row) => replayObject(row).track === 'PDS Only Control');
    const checkpoints = inspect.ingest_checkpoint;
    const checkpoint = Array.isArray(checkpoints) ? replayObject(checkpoints[0]) : {};
    const mode = typeof checkpoint.mode === 'string' ? checkpoint.mode : '';
    const cursor = typeof checkpoint.cursor === 'number' ? checkpoint.cursor : null;
    if (!pdsCommitted || indexed || checkpoint.connected !== 0 || mode !== 'socket' || cursor !== beforeCursor)
      throw new Error('socket-disabled control did not isolate PDS writes from indexed reads');
    return { pdsCommitted, indexed, mode, cursor };
  } catch (error) {
    throw new Error(`socket negative control failed during ${stage} (${safeErrorName(error)})`);
  }
}

async function forwardingCase(
  bundle: BundleProcess,
  fakes: FakeUpstreams,
  commit: string,
  outDir: string,
  incomingClientToken: string,
): Promise<CaseRecord> {
  let phase = 'fixture-account';
  let expectedForwards = 0;
  let forwardStates = '';
  let forwardsObserved = 0;
  let recordDetails = '';
  let lastfmCount = -1;
  let listenbrainzCount = -1;
  let socketControl = 'not-run';
  let socketControlError = 'none';
  try {
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('fixture account missing');
    const records = await fakes.listRecords(alice.did, `${E2E_PREFIX}.scrobble`);
    expectedForwards = records.length * 2;
    const expectedKeys: string[] = [];
    for (const { value } of records) {
      expectedKeys.push(recordKey(value.artist, value.track, value.listenedAt));
    }
    recordDetails = records
      .map(({ value }) => `${String(value.artist)}|${String(value.track)}|${String(value.listenedAt)}`)
      .join(';');
    phase = 'forward-outbox-settlement';
    let settledRows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 90; attempt++) {
      await bundle.pump(1000);
      const inspect = await bundle.inspect();
      settledRows = (inspect.forward_outbox ?? [])
        .map((row) => replayObject(row))
        .filter((row) => row.did === alice.did && row.kind === 'scrobble');
      forwardsObserved = settledRows.length;
      if (settledRows.length === records.length * 2 && settledRows.every((row) => row.state === 'sent')) break;
    }
    if (
      settledRows.length !== records.length * 2 ||
      !settledRows.every((row) => row.state === 'sent' && row.attempts === 1)
    )
      forwardStates = [
        ...settledRows.reduce(
          (counts, row) => counts.set(String(row.state), (counts.get(String(row.state)) ?? 0) + 1),
          new Map<string, number>(),
        ),
      ]
        .map(([state, count]) => `${state}:${count}`)
        .join(',');
    if (
      settledRows.length !== records.length * 2 ||
      !settledRows.every((row) => row.state === 'sent' && row.attempts === 1)
    )
      throw new Error('forward outbox did not settle once per linked protocol');
    const snapshot = await fakes.snapshot();
    const lastfm = replayObject(snapshot.lastfm);
    const lastfmBatches = Array.isArray(lastfm.scrobbles) ? lastfm.scrobbles : [];
    const lastfmKeys = lastfmBatches.flatMap((batch) => {
      const batchRecord = replayObject(batch);
      if (batchRecord.user !== 'e2e-lastfm-user') throw new Error('Last.fm forwarding used the wrong account');
      const items = batchRecord.items;
      return Array.isArray(items)
        ? items.map((item) => {
            const track = replayObject(item);
            return recordKey(track.artist, track.track, track.timestamp);
          })
        : [];
    });
    const listenbrainz = replayObject(snapshot.listenbrainz);
    const submissions = Array.isArray(listenbrainz.submissions) ? listenbrainz.submissions : [];
    const scrobbleSubmissions = submissions
      .map((submission) => replayObject(submission))
      .filter((submission) => submission.listenType !== 'playing_now');
    if (
      scrobbleSubmissions.some((submission) => submission.token !== fakes.listenBrainzToken) ||
      scrobbleSubmissions.some((submission) => submission.token === incomingClientToken)
    )
      throw new Error('forwarder used the wrong ListenBrainz credential');
    const listenbrainzKeys = submissions.flatMap((submission) => {
      const submissionRecord = replayObject(submission);
      if (submissionRecord.listenType === 'playing_now') return [];
      if (submissionRecord.user !== 'e2e-listenbrainz-user')
        throw new Error('ListenBrainz forwarding used the wrong account');
      const payload = replayObject(submissionRecord.json).payload;
      return Array.isArray(payload)
        ? payload.flatMap((item) => {
            const listen = replayObject(item);
            const metadata = replayObject(listen.track_metadata);
            return [recordKey(metadata.artist_name, metadata.track_name, listen.listened_at)];
          })
        : [];
    });
    lastfmCount = lastfmKeys.length;
    listenbrainzCount = listenbrainzKeys.length;
    assertSameMultiset(expectedKeys, lastfmKeys, 'Last.fm forwarding');
    assertSameMultiset(expectedKeys, listenbrainzKeys, 'ListenBrainz forwarding');
    if (
      lastfmKeys.some((key) => key.includes('Too Long Artist')) ||
      listenbrainzKeys.some((key) => key.includes('Too Long Artist'))
    )
      throw new Error('accepted listen was not forwarded exactly once per service');
    phase = 'socket-delivery-negative-control';
    let negativeControl: Awaited<ReturnType<typeof socketDeliveryDisabledControl>>;
    try {
      negativeControl = await socketDeliveryDisabledControl(bundle, fakes);
    } catch (error) {
      socketControlError =
        error instanceof Error &&
        /^socket negative control failed during [a-z-]+ \((?:Error|[A-Za-z]+Error)\)$/.test(error.message)
          ? error.message
          : safeErrorName(error);
      throw error;
    }
    socketControl = `pds=${negativeControl.pdsCommitted};indexed=${negativeControl.indexed};mode=${negativeControl.mode};cursor=${negativeControl.cursor}`;
    writeFileSync(
      join(outDir, 'ledger.json'),
      `${JSON.stringify({
        acceptedScrobbles: records.length,
        forwardRows: settledRows.length,
        fakeLastfmAccepted: lastfmKeys.length,
        fakeListenBrainzAccepted: listenbrainzKeys.length,
        socketDeliveryNegativeControl: negativeControl,
        exactOncePerService: true,
      })}\n`,
    );
    return caseRecord(SCROBBLER_CASES[2], 'passed', commit);
  } catch {
    writeFileSync(
      join(outDir, 'forwarding.log'),
      `exactly-once forwarding failed during ${phase}; expected=${expectedForwards}; observed=${forwardsObserved}; states=${forwardStates || 'none'}; lastfm=${lastfmCount}; listenbrainz=${listenbrainzCount}; socketControl=${socketControl}; socketControlError=${socketControlError}; records=${recordDetails}\n`,
    );
    return caseRecord(SCROBBLER_CASES[2], 'failed', commit);
  }
}

async function preloadIsolationCase(bundle: BundleProcess, commit: string): Promise<CaseRecord> {
  const source = `import net from 'node:net'; import https from 'node:https'; let opened = 0; const connect = net.connect; net.connect = (...args) => { opened++; return connect(...args); }; try { https.request({ hostname: 'refused.invalid', path: '/' }); process.exitCode = 1; } catch { process.exitCode = opened === 0 ? 0 : 1; }`;
  const child = spawn(process.execPath, ['--import', PRELOAD_PATH, '--input-type=module', '-e', source], {
    cwd: REPO_ROOT,
    env: { ...process.env, ATMUSIC_E2E_SCROBBLER_PORT: String(bundle.port) },
    stdio: 'ignore',
  });
  const code = await new Promise<number>((resolveCode) => child.once('exit', (value) => resolveCode(value ?? 1)));
  return caseRecord(SCROBBLER_CASES[3], code === 0 ? 'passed' : 'failed', commit);
}

export async function runScrobblerE2e(outDir = join(REPO_ROOT, 'work/e2e/scrobbler')): Promise<number> {
  const output = resolve(outDir);
  mkdirSync(output, { recursive: true });
  const markerPath = join(output, MARKER);
  if (
    output !== join(REPO_ROOT, 'work/e2e/scrobbler') &&
    readdirSync(output).length > 0 &&
    !readdirSync(output).includes(MARKER)
  ) {
    console.error('scrobbler-e2e refused an unmarked output directory');
    return 2;
  }
  writeFileSync(markerPath, 'scrobbler-e2e owned output\n');
  writeJsonl(join(output, 'client-sockets.jsonl'), []);
  writeFileSync(join(output, 'ledger.json'), '{}\n');
  const sourceStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (
    sourceStatus.status !== 0 ||
    sourceStatus.stdout.split('\n').some((line) => line !== '' && !/^\?\? node_modules\/?$/.test(line))
  ) {
    writeFileSync(join(output, 'runner.log'), 'scrobbler-e2e requires a clean source commit\n');
    return 2;
  }
  const distDir = join(output, 'dist');
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atmusic-n8-runtime-'));
  const records: CaseRecord[] = [];
  let fakes: FakeUpstreams | null = null;
  let bundle: BundleProcess | null = null;
  let commit = 'unknown';
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (head.status !== 0 || !/^[0-9a-f]{40}\s*$/.test(head.stdout)) throw new Error('commit identity unavailable');
    commit = head.stdout.trim();
    await prepareAssets(distDir);
    const appPort = await freeLoopbackPort();
    fakes = await startFakeUpstreams({ workerPort: appPort, publicHost: new URL(PUBLIC_ORIGIN).hostname });
    bundle = await BundleProcess.start(fakes, runtimeDir, distDir, appPort);
    const alice = fakes.accounts.find((account) => account.name === 'alice');
    if (!alice) throw new Error('fixture account missing');
    const linkingSession = await signIn(fakes, bundle, alice);
    const listenbrainzToken = await linkListenBrainz(linkingSession, fakes);
    await linkLastfm(linkingSession, fakes);
    records.push(await clientCase(bundle, fakes, output, commit));
    records.push(...(await combinedClientsCase(bundle, fakes, commit, output, listenbrainzToken)));
    records.push(await preloadIsolationCase(bundle, commit));
    records.push(await idempotencyCase(bundle, fakes, commit, output));
    records.push(await panoReadShapesCase(bundle, fakes, commit, output));
    records.push(await forwardingCase(bundle, fakes, commit, output, listenbrainzToken));
    writeJsonl(join(output, 'outbound.jsonl'), bundle.outbound);
    writeJsonl(join(output, 'scrobbler-e2e.jsonl'), records);
    return records.every((record) => record.result === 'passed') ? 0 : 1;
  } catch (error) {
    for (const title of SCROBBLER_CASES) {
      if (!records.some((record) => record.target === `${SCRIPT_PATH} › ${title}`)) {
        records.push(caseRecord(title, 'skipped', commit));
      }
    }
    writeJsonl(join(output, 'outbound.jsonl'), bundle?.outbound ?? []);
    writeJsonl(join(output, 'scrobbler-e2e.jsonl'), records);
    writeFileSync(join(output, 'runner.log'), `startup/runtime failure: ${safeErrorName(error)}\n`);
    return 2;
  } finally {
    await bundle?.close().catch(() => undefined);
    await fakes?.close().catch(() => undefined);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function parseArgs(argv: readonly string[]): { out: string } {
  let out = join(REPO_ROOT, 'work/e2e/scrobbler');
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out' && argv[index + 1]) {
      const supplied = argv[++index]!;
      out = isAbsolute(supplied) ? supplied : resolve(supplied);
    } else throw new Error('usage: scrobbler-e2e.ts [--out DIR]');
  }
  return { out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let args: { out: string };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    console.error('usage: scrobbler-e2e.ts [--out DIR]');
    process.exitCode = 2;
    args = { out: join(REPO_ROOT, 'work/e2e/scrobbler') };
  }
  if (process.exitCode !== 2) {
    void runScrobblerE2e(args.out).then((code) => {
      process.exitCode = code;
      const reportPath = join(resolve(args.out), 'scrobbler-e2e.jsonl');
      console.log(`scrobbler-e2e ${code === 0 ? 'passed' : 'failed'}: ${reportPath}`);
    });
  }
}
