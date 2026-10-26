// The in-process journey world (ADR 0005 §15.2, §15.4 "In-process journeys";
// N4-01). TEST-ONLY; not a test file: the journey suites and the features
// test import it.
//
// One world is the whole production process, run in-process: node/run.ts
// `run()` with the production feature list (node/features.ts), over a
// temporary state directory, a real 0600 secrets file and a minimal web/dist,
// exactly as the systemd unit would start it except for the injected inputs
// every run() test passes (ADR §3.10 "How process behaviour is tested"):
//
//   - the frozen clock (fixedClock, 2026-01-15T12:00:00Z) and seeded Random;
//     `advance(ms)` moves the clock and the faked Date together (the OAuth
//     library reads Date.now() for assertion and DPoP `iat`s);
//   - manual timers: nothing fires on its own; `pump()` runs the core lane
//     (IndexCore.alarm) and the extension lane (IndexCore.extensionAlarm)
//     explicitly, so every step of a journey is observable;
//   - the fixture network: one router transport over the fake OAuth AS
//     (as.test), a fake PDS whose accounts accept only DPoP-bound tokens
//     (pds.example.test), the fake PLC directory, the fake DoH resolver, fake
//     Last.fm (lastfm.test) and fake ListenBrainz (listenbrainz.test), plus
//     the app itself at music.example.test (the AS fetches our client
//     metadata and JWKS from the running process). Nothing leaves the
//     process; an unrouted host fails like a failed DNS lookup;
//   - the memoryLink Jetstream connector over a FakeJetstream that echoes
//     every commit the fake PDS makes (`pds.onCommit` → `appendCommit`);
//   - a capturing logger with no redaction list at all, so a secret that
//     reached any log call shows up in `log.lines`.
//
// run() replaces globalThis.fetch with the unpinned-fetch stub (ADR §3.5);
// the world talks to the listener with the fetch captured before that, and
// restores it when the last world closes.

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeJetstream, memoryLink } from '@atmusic/atproto/test-support/fake-jetstream';
import { FakeOAuthAs } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { type FixtureKeys, fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { Transport } from '@atmusic/atproto/transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { vi } from 'vitest';
import { type ConnectJetstream, JetstreamConnectError } from '../../../src/do/ingest/jetstream-socket';
import type { OutboundTransports } from '../../../src/node/features';
import { type ExitCode, type RunningServer, type RunOptions, run } from '../../../src/node/run';
import { captureLog, manualTimers, TEST_PUBLIC_ORIGIN, testEnv, testSecretsDocument } from '../support/app';
import { FakeLastfm, md5Hex } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';
import { TEST_BUSY_TIMEOUT_MS } from '../support/node-db';

/** The fetch Node had before any run() replaced it with the unpinned stub. */
export const REAL_FETCH: typeof fetch = globalThis.fetch;

export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const APP_HOST = new URL(TEST_PUBLIC_ORIGIN).host;
export const PDS_HOST = 'pds.example.test';
/** The reserved-domain test prefix with ownership evidence: the publication gate is open (writes.test.ts). */
export const OWNED = 'org.example.music';
export const SCROBBLE = `${OWNED}.scrobble`;
export const LASTFM_API_KEY = '0123456789abcdef0123456789abcdef';
export const LASTFM_SECRET = 'owner-shared-secret-for-journeys';
/** The public pair ATMUSIC_LASTFM_KNOWN_CLIENTS ships (Pano Scrobbler, ADR §7.4). */
export const PANO = 'panoScrobbler';
export const SESSION_COOKIE = '__Host-atmusic_session';
export const BINDING_COOKIE = '__Host-atmusic_oauth';

export const ALICE = 'did:plc:alicealicealicealicealic';
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';

const JOURNEY_ENV = {
  LEXICON_PREFIX: OWNED,
  NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org',
  INGEST_MODE: 'socket',
  LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
  LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
  LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
  ATMUSIC_SIGNIN_DIDS: `${ALICE},${BOB}`,
};

export interface WorldOptions {
  /** Give the owner's Last.fm key pair to the secrets (default true). */
  lastfmKey?: boolean;
  /** Environment overrides (undefined removes a default). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Wraps the fixture router into the transport run() gets (the features test's spy). */
  outbound?: (router: FixtureTransport) => OutboundTransports;
  /** null: no connector override, so run() builds the production one over the `jetstream` wire. */
  connectJetstream?: ConnectJetstream | null;
  /** run()'s server factory (to observe the moment it listens). */
  serverFactory?: RunOptions['serverFactory'];
}

export interface Answer {
  status: number;
  headers: Headers;
  text: string;
  /** JSON when the body parses, else the text. */
  body: unknown;
  cookies: string[];
}

export interface User {
  name: string;
  did: string;
  handle: string;
  repo: SignedRepo;
}

export interface Signed {
  did: string;
  /** The `__Host-atmusic_session` value. */
  token: string;
  csrf: string;
}

export interface SendOptions {
  as?: Signed;
  /** JSON (stringified), a string, or raw bytes. */
  body?: unknown;
  /** application/x-www-form-urlencoded parameters. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/** One outbound request the process sent into the fixture network. */
export interface Outbound {
  method: string;
  host: string;
  path: string;
  /** The Authorization scheme (`DPoP`, `Bearer`, `Token`, …), or null. */
  scheme: string | null;
  /** Whether a DPoP proof header was sent. */
  dpop: boolean;
}

/** One answer the world saw, for the secret scans. */
export interface Seen {
  method: string;
  path: string;
  status: number;
  text: string;
}

const worlds = new Set<World>();

/** Last.fm's api_sig: every parameter except api_sig, format and callback, sorted, secret appended. */
export function lastfmSig(params: Record<string, string>, secret: string): string {
  const names = Object.keys(params)
    .filter((n) => n !== 'format' && n !== 'callback' && n !== 'api_sig')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return md5Hex(names.map((n) => n + params[n]).join('') + secret);
}

function cookieValue(cookies: readonly string[], name: string): string | null {
  for (const c of cookies) {
    const m = new RegExp(`^${name}=([^;]*);`).exec(c);
    if (m !== null && m[1] !== '') return m[1] as string;
  }
  return null;
}

export class World {
  readonly dir: string;
  readonly clock: FixedClock;
  readonly as: FakeOAuthAs;
  readonly pds: FakePds;
  readonly plc = new FakePlc();
  readonly doh = new FakeDoh();
  readonly lastfm: FakeLastfm;
  readonly lb: FakeListenBrainz;
  readonly jetstream: FakeJetstream;
  readonly router: FixtureTransport;
  /** The router as run() gets it: every request the process sends is recorded in `outbound`. */
  readonly transport: FixtureTransport;
  readonly outbound: Outbound[] = [];
  readonly log = captureLog();
  readonly timers = manualTimers();
  /** Every answer the world received from the app, in order. */
  readonly seen: Seen[] = [];
  /** Credential values the sign-ins handled (cookies, CSRF tokens, the authorization code and state). */
  readonly credentials = new Set<string>();
  /** The last /oauth/callback path and query a sign-in used (single use). */
  lastCallback: { path: string; binding: string } | null = null;
  readonly env: Record<string, string | undefined>;
  readonly options: WorldOptions;
  keys!: FixtureKeys;
  private current: { server: RunningServer; result: Promise<ExitCode>; signals: EventEmitter } | null = null;
  private readonly users: User[] = [];

  constructor(options: WorldOptions = {}) {
    this.options = options;
    this.dir = mkdtempSync(join(tmpdir(), 'atmusic-journey-'));
    this.clock = fixedClock();
    vi.setSystemTime(this.clock.nowMs());
    this.as = new FakeOAuthAs({ clock: this.clock, random: seededRandom(101) });
    this.pds = new FakePds(PDS_HOST, { clock: this.clock, authorizationServer: this.as });
    this.lastfm = new FakeLastfm({ clock: this.clock, apiKey: LASTFM_API_KEY, secret: LASTFM_SECRET });
    this.lb = new FakeListenBrainz({ clock: this.clock });
    this.jetstream = new FakeJetstream({ clock: this.clock });
    // The AS fetches our client metadata and JWKS from the running process.
    const self = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      return this.fetchRaw(`${url.pathname}${url.search}`, { method: req.method });
    };
    this.router = routerTransport({
      pds: [this.pds],
      plc: this.plc,
      doh: this.doh,
      hosts: {
        [this.as.host]: this.as.fetch,
        [APP_HOST]: self,
        'lastfm.test': this.lastfm,
        'listenbrainz.test': this.lb,
      },
    });
    this.as.connect(this.router);
    const router = this.router;
    this.transport = Object.assign(
      (req: Request) => {
        const url = new URL(req.url);
        const auth = req.headers.get('authorization');
        this.outbound.push({
          method: req.method,
          host: url.hostname,
          path: url.pathname,
          scheme: auth === null ? null : (auth.split(' ')[0] ?? null),
          dpop: req.headers.has('dpop'),
        });
        return router(req);
      },
      { fixture: true as const, calls: router.calls, hostnames: router.hostnames },
    );
    this.pds.onCommit((_did, commit) => {
      this.jetstream.appendCommit(commit);
    });

    const dist = join(this.dir, 'web', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>atmusic</title>');
    const doc = testSecretsDocument();
    const secretsPath = join(this.dir, 'secrets.json');
    writeFileSync(
      secretsPath,
      JSON.stringify(
        options.lastfmKey === false ? doc : { ...doc, lastfm: { apiKey: LASTFM_API_KEY, sharedSecret: LASTFM_SECRET } },
      ),
    );
    chmodSync(secretsPath, 0o600);
    this.env = {
      ...testEnv(this.dir),
      ATMUSIC_ASSETS_DIR: dist,
      ATMUSIC_SECRETS_FILE: secretsPath,
      ...JOURNEY_ENV,
      ...options.env,
    };
    worlds.add(this);
  }

  /** Starts the process (run()) and resolves once it listens. */
  async start(): Promise<RunningServer> {
    if (this.current !== null) throw new Error('the world is already running');
    this.keys ??= await fixtureKeys();
    const signals = new EventEmitter();
    let onReady: (s: RunningServer) => void = () => {};
    const ready = new Promise<RunningServer>((resolve) => {
      onReady = resolve;
    });
    const connect =
      this.options.connectJetstream === null
        ? {}
        : {
            connectJetstream:
              this.options.connectJetstream ??
              memoryLink(this.jetstream, { connectError: (s, e, m) => new JetstreamConnectError(s, e, m) }),
          };
    const options: RunOptions = {
      argv: ['node', 'main.mjs', '--init'],
      env: this.env,
      clock: this.clock,
      random: seededRandom(0x5eed),
      busyTimeoutMs: TEST_BUSY_TIMEOUT_MS,
      drainMs: 200,
      log: this.log.logger,
      stdout: () => {},
      stderr: () => {},
      configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
      transport: this.transport as Transport,
      ...(this.options.outbound === undefined ? {} : { outbound: this.options.outbound(this.transport) }),
      ...connect,
      timers: this.timers,
      ...(this.options.serverFactory === undefined ? {} : { serverFactory: this.options.serverFactory }),
      signals,
      onReady: (s) => onReady(s),
    };
    const result = run(options);
    const server = await Promise.race([
      ready,
      result.then((code) => Promise.reject(new Error(`run() exited ${code} before listening`))),
    ]);
    this.current = { server, result, signals };
    return server;
  }

  get server(): RunningServer {
    if (this.current === null) throw new Error('the world is not running');
    return this.current.server;
  }

  /** ATMUSIC_DB of this world (STATE_DIRECTORY/atmusic.db). */
  get dbPath(): string {
    return join(this.dir, 'state', 'atmusic.db');
  }

  get db() {
    return this.server.db;
  }

  get core() {
    return this.server.app.core;
  }

  /** SIGTERM drain, then the process exit code. */
  async stop(): Promise<ExitCode> {
    const current = this.current;
    if (current === null) return 0;
    this.current = null;
    await current.server.shutdown('SIGTERM');
    return current.result;
  }

  /** Stop, then start the same state directory and fakes again (close and reopen the database). */
  async restart(): Promise<RunningServer> {
    const code = await this.stop();
    if (code !== 0) throw new Error(`run() exited ${code}`);
    return this.start();
  }

  async close(): Promise<void> {
    worlds.delete(this);
    try {
      await this.stop();
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  advance(ms: number): void {
    this.clock.advance(ms);
    vi.setSystemTime(this.clock.nowMs());
  }

  // -- the fixture world ------------------------------------------------------

  /** A user on the fake PDS (DPoP only), PLC, DoH and the fake AS. */
  async addUser(name: string, did: string): Promise<User> {
    this.keys ??= await fixtureKeys();
    const handle = `${name}.test`;
    const repo = new SignedRepo(did, this.keys.alice, { clock: this.clock });
    await this.pds.addAccount(repo, { handle, auth: 'dpop' });
    this.plc.register(did, { signingKey: this.keys.alice, pds: this.pds.origin, handle });
    this.doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
    this.as.addAccount(did, { handle });
    const user = { name, did, handle, repo };
    this.users.push(user);
    return user;
  }

  // -- HTTP -------------------------------------------------------------------

  /** A request to the running listener (path and query), recorded in `seen`. */
  async fetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await REAL_FETCH(`http://${this.server.address.authority}${path}`, { redirect: 'manual', ...init });
    const text = await res.clone().text();
    this.seen.push({ method: init.method ?? 'GET', path, status: res.status, text });
    return res;
  }

  async send(method: string, path: string, o: SendOptions = {}): Promise<Answer> {
    const headers = new Headers(o.headers);
    if (o.as !== undefined) {
      headers.set('cookie', `${SESSION_COOKIE}=${o.as.token}`);
      if (method !== 'GET' && method !== 'HEAD') {
        headers.set('origin', TEST_PUBLIC_ORIGIN);
        headers.set('x-csrf-token', o.as.csrf);
      }
    }
    let body: string | Uint8Array | undefined;
    if (o.form !== undefined) {
      body = new URLSearchParams(o.form).toString();
      headers.set('content-type', 'application/x-www-form-urlencoded');
    } else if (o.body instanceof Uint8Array) {
      body = o.body;
    } else if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const res = await this.fetchRaw(path, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, headers: res.headers, text, body: parsed, cookies: res.headers.getSetCookie() };
  }

  /** A full sign-in through /api/v1/auth/start, the fake AS and /oauth/callback. */
  async signIn(user: User): Promise<Signed> {
    const started = await this.send('POST', '/api/v1/auth/start', {
      body: { handle: user.handle },
      headers: { origin: TEST_PUBLIC_ORIGIN },
    });
    if (started.status !== 200) throw new Error(`auth/start answered ${started.status}: ${started.text}`);
    const binding = cookieValue(started.cookies, BINDING_COOKIE);
    if (binding === null) throw new Error('auth/start set no binding cookie');
    const authorizeUrl = (started.body as { authorizeUrl: string }).authorizeUrl;
    const res = await this.router(new Request(authorizeUrl));
    const location = res.headers.get('location');
    if (res.status !== 303 || location === null) throw new Error(`authorize answered ${res.status}`);
    const back = new URL(location);
    for (const name of ['code', 'state']) {
      const value = back.searchParams.get(name);
      if (value !== null) this.credentials.add(value);
    }
    this.credentials.add(binding);
    this.lastCallback = { path: `${back.pathname}${back.search}`, binding };
    const callback = await this.send('GET', `${back.pathname}${back.search}`, {
      headers: { cookie: `${BINDING_COOKIE}=${binding}` },
    });
    if (callback.status !== 303) throw new Error(`callback answered ${callback.status}: ${callback.text}`);
    const token = cookieValue(callback.cookies, SESSION_COOKIE);
    if (token === null) throw new Error('the callback set no session cookie');
    this.credentials.add(token);
    const session = await this.send('GET', '/api/v1/auth/session', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    this.credentials.add((session.body as { csrfToken: string }).csrfToken);
    // The admitted DID's snapshot runs on the core lane (only): until then the index has no verified
    // handle for it. The extension lane is left alone, so a journey decides when its timers run.
    await this.until(() => this.isCurrent(user.did), { extensions: false });
    return { did: user.did, token, csrf: (session.body as { csrfToken: string }).csrfToken };
  }

  /** The index holds the DID's verified handle and its snapshot finished. */
  isCurrent(did: string): boolean {
    const row = this.db.one<{ handle: string | null; indexing_state: string }>(
      'SELECT handle, indexing_state FROM users WHERE did = ?',
      did,
    );
    return row !== null && row.handle !== null && row.indexing_state === 'current';
  }

  /** A signed POST /2.0/ call in Pano's shape (form body, format=json, the public pair). */
  async lastfm2(params: Record<string, string>, o: { apiKey?: string; secret?: string; sign?: boolean } = {}) {
    const p: Record<string, string> = { ...params, api_key: o.apiKey ?? PANO };
    if (o.sign !== false) p.api_sig = lastfmSig(p, o.secret ?? PANO);
    p.format = 'json';
    return this.send('POST', '/2.0/', { form: p, headers: { 'user-agent': 'Pano Scrobbler/3.6 (Android)' } });
  }

  /** A GET /2.0/ read (no signature). */
  async lastfmRead(params: Record<string, string>) {
    const q = new URLSearchParams({ ...params, api_key: PANO, format: 'json' });
    return this.send('GET', `/2.0/?${q.toString()}`);
  }

  // -- timers -----------------------------------------------------------------

  /** Lets queued socket events and promise chains run. */
  async settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** One run of the lanes asked for (both by default), then a settle. */
  async pump(o: { core?: boolean; extensions?: boolean } = {}): Promise<void> {
    if (o.core !== false) await this.core.alarm();
    await this.settle();
    if (o.extensions !== false) await this.core.extensionAlarm();
    await this.settle();
  }

  /**
   * Pumps until `done()` holds, advancing the clock by `stepMs` between rounds
   * (the drain's 2 s floor and retry delays need time to pass). Throws after
   * `maxRounds`.
   */
  async until(
    done: () => boolean | Promise<boolean>,
    o: { stepMs?: number; maxRounds?: number; core?: boolean; extensions?: boolean } = {},
  ): Promise<number> {
    const max = o.maxRounds ?? 40;
    for (let round = 0; round < max; round++) {
      if (await done()) return round;
      await this.pump({
        ...(o.core === undefined ? {} : { core: o.core }),
        ...(o.extensions === undefined ? {} : { extensions: o.extensions }),
      });
      if (await done()) return round + 1;
      this.advance(o.stepMs ?? 2_500);
    }
    throw new Error(`condition not reached after ${max} rounds`);
  }

  count(table: string, where = '1', ...args: Array<string | number>): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...args)?.n ?? -1;
  }
}

/** Closes every world still open and restores the global fetch (afterEach). */
export async function closeWorlds(): Promise<void> {
  for (const w of [...worlds]) await w.close();
  globalThis.fetch = REAL_FETCH;
}

/** A started world with Alice (and optionally Bob) on the fakes. */
export async function startWorld(options: WorldOptions = {}): Promise<{ w: World; alice: User; bob: User }> {
  const w = new World(options);
  const alice = await w.addUser('alice', ALICE);
  const bob = await w.addUser('bob', BOB);
  await w.start();
  return { w, alice, bob };
}
