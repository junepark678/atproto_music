// Route-screen test support (TEST-ONLY; W3-06).
//
// - `fakeApi`: the AppView as an injected fetch behind the real typed
//   `ApiClient`, so every response is decoded exactly as in production. Each
//   test registers handlers per `METHOD /path`; every request is logged.
//   notify and records/status can be delegated to the W2-07 `FakeAppView`,
//   which answers from the fake PDS.
// - `testServices`: frozen clock, seeded randomness, a manual ticker, an
//   injected session port and (optionally) an outbox service built over the
//   W2-07 fixture (fake PDS session + fake-indexeddb), whose runner the test
//   drives with `runDue()`.
// - `mount`: renders the real <App> (router, lazy screens, shell) at a URL.
// - Shared data: the TESTING.md fixture rows projected by the Rust oracle
//   (tests/goldens/stats_read_models.json), normalized to the API's
//   timestamp form.

import type { Did, Meta, Profile, Scrobble, ScrobblePage, Statistics, StatsWindow } from '@atmusic/core/api-types';
import type { Clock } from '@atmusic/core/deps';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { render } from 'preact';
import { vi } from 'vitest';
import { ApiClient, type FetchLike } from '../../src/api/client';
import { App } from '../../src/app';
import { createOutboxService, type OutboxService } from '../../src/components/outbox-service';
import { type ScreenServices, ServicesProvider, type SessionPort, type Ticker } from '../../src/components/services';
import type { SessionExpiry } from '../../src/oauth/session';
import type { PdsSession } from '../../src/oauth/types';
import { type AppState, createAppState } from '../../src/state/store';
import { type OutboxFixture, outboxFixture, PREFIX } from '../support/fake-pds-browser';

export const ORIGIN = 'https://music.test';
export const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Did;
export const CAROL = 'did:plc:cccccccccccccccccccccccc' as Did;
export const UNKNOWN = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' as Did;
export const REQUEST_ID = 'a858325e-7dd0-4b1b-baaa-3b65af37f963';
export { PREFIX };

const INDEXING_CURRENT = { state: 'current', caughtUp: true, lastIndexedAt: '2026-01-15T12:00:00Z', lagSeconds: 0 };

export const META_PUBLISH: Meta = {
  name: 'atproto_music',
  version: '0.1.0',
  stage: 'product',
  capabilities: ['read', 'stats', 'follows', 'notify', 'indexing', 'publication'],
  lexiconPrefix: PREFIX,
  indexing: { ...INDEXING_CURRENT, state: 'current' },
};

/** A read-only deployment: no owned prefix, no `publication` (A20). */
export const META_READ_ONLY: Meta = {
  ...META_PUBLISH,
  capabilities: ['read', 'stats', 'follows', 'notify', 'indexing'],
  lexiconPrefix: null,
};

// ---------------------------------------------------------------------------
// Fixture data (the Rust oracle's projection of tests/fixtures/read_models.json)
// ---------------------------------------------------------------------------

/** `2026-01-15T11:00:00.000000000Z` → `2026-01-15T11:00:00Z`. */
function apiTime(value: string): string {
  return value.replace(/\.0+Z$/, 'Z');
}

interface GoldenRow {
  uri: string;
  cid: string;
  did: string;
  revision: string;
  artist: string;
  track: string;
  album?: string;
  listenedAt: string;
  createdAt: string;
  indexedAt: string;
}

interface Goldens {
  rows: Record<'globalFeed' | 'aliceHistory' | 'aliceFollowingFeed', GoldenRow[]>;
  statistics: Record<'Alice', Record<StatsWindow, Statistics>>;
}

// Read through Vite (the file is outside this package's TypeScript root).
const goldenFiles = import.meta.glob<Goldens>('../../../tests/goldens/stats_read_models.json', {
  eager: true,
  import: 'default',
});
const goldens = Object.values(goldenFiles)[0] as Goldens;

function toScrobble(row: GoldenRow): Scrobble {
  const out: Scrobble = {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    revision: row.revision,
    artist: row.artist,
    track: row.track,
    listenedAt: apiTime(row.listenedAt),
    createdAt: apiTime(row.createdAt),
    indexedAt: apiTime(row.indexedAt),
  };
  if (row.album !== undefined) out.album = row.album;
  return out;
}

/** The global feed in server order: r09, r10, r07, r01 … r06. */
export const GLOBAL_FEED: Scrobble[] = goldens.rows.globalFeed.map(toScrobble);
/** Alice's history in server order: r07, r01 … r06. */
export const ALICE_HISTORY: Scrobble[] = goldens.rows.aliceHistory.map(toScrobble);
export const ALICE_FOLLOWING_FEED: Scrobble[] = goldens.rows.aliceFollowingFeed.map(toScrobble);

export function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

export function aliceStats(window: StatsWindow): Statistics {
  const s = goldens.statistics.Alice[window];
  return { ...s, asOf: apiTime(s.asOf), window } as Statistics;
}

export function page(items: Scrobble[], nextCursor: string | null, indexing = INDEXING_CURRENT): ScrobblePage {
  return { items, nextCursor, asOf: '2026-01-15T12:00:00Z', indexing } as ScrobblePage;
}

export function profileOf(did: Did, handle: string | null, overrides: Partial<Profile> = {}): Profile {
  return {
    did,
    handle,
    joinedAt: '2026-01-01T00:00:00Z',
    indexedAt: '2026-01-15T12:00:00Z',
    totalScrobbles: 7,
    followerCount: 0,
    followingCount: 1,
    indexing: { ...INDEXING_CURRENT, state: 'current' },
    ...overrides,
  } as Profile;
}

export function emptyStats(did: Did, window: StatsWindow): Statistics {
  return {
    did,
    window,
    asOf: '2026-01-15T12:00:00Z',
    totalScrobbles: 0,
    distinctArtists: 0,
    distinctTracks: 0,
    topArtists: [],
    topTracks: [],
    topAlbums: [],
  };
}

// ---------------------------------------------------------------------------
// The fake AppView
// ---------------------------------------------------------------------------

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export type Handler = (req: ApiRequest) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function envelope(status: number, code: string, message = 'error'): Response {
  return json(status, { error: { code, message, requestId: REQUEST_ID } });
}

export interface FakeApi {
  api: ApiClient;
  fetch: FetchLike;
  requests: ApiRequest[];
  on(route: string, handler: Handler): void;
  count(route: string): number;
  /** Requests to a route, e.g. `GET /api/v1/feed`. */
  calls(route: string): ApiRequest[];
}

export interface FakeApiOptions {
  meta?: Meta;
  /** Handles `POST /api/v1/notify` and `GET /api/v1/records/status` (the W2-07 FakeAppView). */
  delegate?: FetchLike;
}

export function fakeApi(options: FakeApiOptions = {}): FakeApi {
  const routes = new Map<string, Handler>();
  const requests: ApiRequest[] = [];
  routes.set('GET /api/v1/meta', () => json(200, options.meta ?? META_PUBLISH));
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const req: ApiRequest = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body };
    requests.push(req);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const key = `${method} ${url.pathname}`;
    const delegated = key === 'POST /api/v1/notify' || key === 'GET /api/v1/records/status';
    if (delegated && options.delegate && !routes.has(key)) return options.delegate(input, init);
    const handler = routes.get(key);
    if (handler) return handler(req);
    return envelope(404, 'not_found', 'The resource is absent or inactive.');
  };
  return {
    api: new ApiClient({ baseUrl: ORIGIN, fetch }),
    fetch,
    requests,
    on: (route, handler) => {
      routes.set(route, handler);
    },
    count: (route) => requests.filter((r) => `${r.method} ${r.path}` === route).length,
    calls: (route) => requests.filter((r) => `${r.method} ${r.path}` === route),
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export class ManualTicker implements Ticker {
  readonly timers = new Map<number, { ms: number; tick: () => void }>();
  #next = 0;
  /** Every interval ever started (cleared or not). */
  started = 0;

  every(ms: number, tick: () => void): () => void {
    const id = ++this.#next;
    this.started++;
    this.timers.set(id, { ms, tick });
    return () => {
      this.timers.delete(id);
    };
  }

  active(): number {
    return this.timers.size;
  }

  tickAll(): void {
    for (const t of [...this.timers.values()]) t.tick();
  }
}

export class FakeSessionPort implements SessionPort {
  readonly signIns: string[] = [];
  signOuts = 0;
  signInError: unknown = null;
  expiryValue: SessionExpiry | null = null;
  onSignOut: (() => Promise<void> | void) | null = null;

  async signIn(handle: string): Promise<void> {
    this.signIns.push(handle);
    if (this.signInError !== null) throw this.signInError;
  }
  async signOut(): Promise<void> {
    this.signOuts++;
    await this.onSignOut?.();
  }
  async expiry(): Promise<SessionExpiry | null> {
    return this.expiryValue;
  }
}

export interface TestServices extends ScreenServices {
  ticker: ManualTicker;
  outboxRequests: number;
  closed: number;
}

export function testServices(
  options: { clock?: Clock; outbox?: OutboxService | null; session?: SessionPort } = {},
): TestServices {
  const ticker = new ManualTicker();
  const services: TestServices = {
    clock: options.clock ?? fixedClock(),
    random: seededRandom(11),
    ticker,
    outboxRequests: 0,
    closed: 0,
    session: async () => options.session ?? new FakeSessionPort(),
    async outbox(request) {
      services.outboxRequests++;
      const outbox = options.outbox ?? null;
      if (outbox === null) throw new Error('this test has no outbox');
      if (request.session !== outbox.session) throw new Error('outbox requested for another session');
      return outbox;
    },
    async closeOutbox() {
      services.closed++;
      await options.outbox?.stop();
    },
  };
  return services;
}

/** Alice's outbox over the W2-07 fixture (fake PDS, fake AppView status), runner driven by the test. */
export interface OutboxWorld {
  fx: OutboxFixture;
  clock: FixedClock;
  api: FakeApi;
  outbox: OutboxService;
  session: PdsSession;
  services: TestServices;
  state: AppState;
}

export async function outboxWorld(options: { meta?: Meta; port?: SessionPort } = {}): Promise<OutboxWorld> {
  const fx = await outboxFixture({ jitter: 'zero' });
  const api = fakeApi({ meta: options.meta ?? META_PUBLISH, delegate: fx.appView.fetch });
  const outbox = createOutboxService({
    store: fx.store,
    session: fx.session,
    api: api.api,
    clock: fx.clock,
    random: fx.random,
    prefix: PREFIX,
    autoStart: false,
  });
  const services = testServices({ clock: fx.clock, outbox, ...(options.port ? { session: options.port } : {}) });
  const state = createAppState({ api: api.api });
  state.session.value = fx.session;
  return { fx, clock: fx.clock, api, outbox, session: fx.session, services, state };
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/** Sets the page URL (happy-dom's test API). */
export function setUrl(path: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(new URL(path, ORIGIN).href);
}

export interface Mounted {
  root: HTMLElement;
  main(): HTMLElement;
  unmount(): void;
}

export function mount(path: string, state: AppState, services: ScreenServices): Mounted {
  setUrl(path);
  const root = document.createElement('div');
  document.body.append(root);
  render(
    <ServicesProvider value={services}>
      <App state={state} />
    </ServicesProvider>,
    root,
  );
  return {
    root,
    main: () => {
      const main = root.querySelector('main');
      if (!main) throw new Error('no <main>');
      return main;
    },
    unmount: () => {
      render(null, root);
      root.remove();
    },
  };
}

/** Waits until `fn` stops throwing (real timers; nothing here sleeps on the frozen clock). */
export function until<T>(fn: () => T, timeout = 2_000): Promise<T> {
  return vi.waitFor(fn, { timeout, interval: 5 });
}

/** Lets pending promise callbacks and preact renders run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) ?? null;
}

export function linkByText(root: ParentNode, text: string): HTMLAnchorElement | null {
  return Array.from(root.querySelectorAll('a')).find((a) => (a.textContent ?? '').trim() === text) ?? null;
}

export function type(input: Element | null, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The rkeys of the scrobble list items under `root`, in DOM order. */
export function listedRkeys(root: ParentNode, selector = 'ol.scrobble-list > li'): string[] {
  return Array.from(root.querySelectorAll(selector)).map((li) => rkeyOf(li.getAttribute('data-uri') ?? ''));
}

export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Every text node under `el`, joined with single spaces (block boundaries become spaces). */
export function words(el: Node | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) parts.push(n.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The shell's navigation labels. */
export function navLabels(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('header nav a')).map((a) => text(a));
}
