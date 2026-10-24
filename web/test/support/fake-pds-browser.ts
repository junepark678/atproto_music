// SPA outbox test support (TEST-ONLY): the W1-05 fake PDS (real signed repos,
// RecordAlreadyExists / InvalidSwap semantics, fault queues, call log) wrapped
// as the `PdsSession` the outbox depends on, a fake AppView serving notify and
// records/status through the real typed `ApiClient`, and a fixture with the
// frozen clock, seeded (or zero-jitter) randomness and a fresh fake-indexeddb.
//
// Crash barriers live here, in the injected session, never in product code:
// `crashOn(nsid, 'before_send')` swallows the request before the PDS sees it;
// `crashOn(nsid, 'after_commit')` lets the PDS commit it and then never
// answers. Either way the runner awaiting it is abandoned (a closed tab) and a
// new runner is created over the same IndexedDB (`fixture.reload()`).

import { type FakePds, fakePds, fixtureToken } from '@atmusic/atproto/test-support/fake-pds';
import { testKey } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { AtUri, Did, NotifyInput, RecordStatus } from '@atmusic/core/api-types';
import type { Random } from '@atmusic/core/deps';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { IDBFactory } from 'fake-indexeddb';
import { ApiClient, type FetchLike } from '../../src/api/client';
import type { PdsSession } from '../../src/oauth/types';
import { type OutboxLocks, OutboxRunner, type RunnerDeps } from '../../src/outbox/runner';
import { type OutboxOperation, OutboxStore } from '../../src/outbox/store';

export const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as Did;
export const CAROL = 'did:plc:cccccccccccccccccccccccc' as Did;
export const PREFIX = FIXTURE_PREFIX;
export const SCROBBLE = `${PREFIX}.scrobble`;
export const FOLLOW = `${PREFIX}.follow`;
export const SETTINGS = `${PREFIX}.settings`;
export const APPVIEW_ORIGIN = 'https://appview.test';

/** A valid scrobble form input at the frozen instant. */
export const SCROBBLE_INPUT = {
  artist: 'Björk',
  track: 'Jóga',
  album: 'Homogenic',
  listenedAt: '2026-01-15T11:58:00Z',
  durationSeconds: 305,
};

// ---------------------------------------------------------------------------
// PdsSession over the fake PDS
// ---------------------------------------------------------------------------

export type CrashStage = 'before_send' | 'after_commit';

export interface SentRequest {
  nsid: string;
  method: string;
  params: Record<string, string>;
  body: Record<string, unknown> | null;
}

interface Barrier {
  nsid: string;
  stage: CrashStage;
  hit: () => void;
}

/** Never settles: the runner awaiting it is abandoned, as when a tab dies mid-request. */
const forever = () => new Promise<Response>(() => undefined);

export class FakePdsSession implements PdsSession {
  /** Every request the outbox handed to the session, including ones a barrier swallowed. */
  readonly sent: SentRequest[] = [];
  signedOut = false;
  private readonly barriers: Barrier[] = [];
  private readonly holds: Array<{ nsid: string; reach: () => void; released: Promise<void> }> = [];

  constructor(
    readonly pds: FakePds,
    readonly did: Did,
  ) {}

  /** Arms a one-shot crash barrier on the next `nsid` request; resolves when it is hit. */
  crashOn(nsid: string, stage: CrashStage): Promise<void> {
    return new Promise((resolve) => {
      this.barriers.push({ nsid, stage, hit: resolve });
    });
  }

  /**
   * Holds the next `nsid` request before it reaches the PDS until `release()`:
   * the request is in flight while the test acts (e.g. enqueues a delete).
   */
  hold(nsid: string): { reached: Promise<void>; release: () => void } {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({ nsid, reach, released });
    return { reached, release };
  }

  sentTo(nsid: string): SentRequest[] {
    return this.sent.filter((r) => r.nsid === nsid);
  }

  async fetchHandler(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/xrpc/')) throw new TypeError(`PdsSession paths are /xrpc/…, got ${path}`);
    const url = new URL(path, this.pds.origin);
    const nsid = url.pathname.slice('/xrpc/'.length);
    const headers = new Headers(init.headers);
    headers.set('authorization', `DPoP ${fixtureToken(this.did)}`);
    let body: Record<string, unknown> | null = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    this.sent.push({ nsid, method: init.method ?? 'GET', params: Object.fromEntries(url.searchParams), body });
    const i = this.barriers.findIndex((b) => b.nsid === nsid);
    const barrier = i < 0 ? undefined : this.barriers.splice(i, 1)[0];
    if (barrier?.stage === 'before_send') {
      barrier.hit();
      return forever();
    }
    const h = this.holds.findIndex((x) => x.nsid === nsid);
    const held = h < 0 ? undefined : this.holds.splice(h, 1)[0];
    if (held !== undefined) {
      held.reach();
      await held.released;
    }
    const req = new Request(url, { ...init, headers });
    const res = await this.pds.fetch(req);
    if (barrier?.stage === 'after_commit') {
      barrier.hit();
      return forever();
    }
    return res;
  }

  async signOut(): Promise<void> {
    this.signedOut = true;
  }
}

// ---------------------------------------------------------------------------
// The AppView's notify and records/status, answered from the fake PDS
// ---------------------------------------------------------------------------

type StatusOverride = (truth: RecordStatus) => RecordStatus;

function parseUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  return m ? { did: m[1]!, collection: m[2]!, rkey: m[3]! } : null;
}

/**
 * records/status as an AppView that verified the PDS's current state: indexed
 * with the PDS CID when present, absent once notified of a missing record,
 * unknown otherwise; `indexing.state` is `suppressed` while settings/self says
 * disabled. Tests can override a URI's answer (e.g. a stale indexed CID) or
 * make the first polls answer `pending`.
 */
export class FakeAppView {
  readonly notified: NotifyInput[] = [];
  readonly statusPolls: AtUri[] = [];
  /** Polls per URI that answer `pending` before the verified state shows. */
  pendingPolls = 0;
  /** notify answers 503 queue_full this many times. */
  notifyFailures = 0;
  private readonly overrides = new Map<string, StatusOverride>();
  private readonly pollsByUri = new Map<string, number>();

  constructor(readonly pds: FakePds) {}

  override(uri: string, fn: StatusOverride): void {
    this.overrides.set(uri, fn);
  }

  clearOverride(uri: string): void {
    this.overrides.delete(uri);
  }

  notifiedUris(): string[] {
    return this.notified.flatMap((n) => (n.uri !== undefined ? [n.uri] : []));
  }

  async truth(uri: AtUri): Promise<RecordStatus> {
    const parts = parseUri(uri);
    const base = { uri, indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: null } };
    if (parts === null || !this.pds.dids().includes(parts.did)) return { ...base, state: 'unknown' } as RecordStatus;
    const repo = this.pds.account(parts.did).repo;
    const nsidPrefix = parts.collection.slice(0, parts.collection.lastIndexOf('.'));
    const settings = await repo.getRecord(`${nsidPrefix}.settings`, 'self');
    const suppressed = (settings?.value as { indexing?: unknown } | undefined)?.indexing === 'disabled';
    const indexing = { ...base.indexing, state: suppressed ? 'suppressed' : 'current' };
    const rec = await repo.getRecord(parts.collection, parts.rkey);
    if (rec !== null && (!suppressed || parts.collection.endsWith('.settings'))) {
      return { uri, state: 'indexed', cid: rec.cid, revision: repo.head!.rev, indexing } as RecordStatus;
    }
    const known = this.notifiedUris().includes(uri);
    return { uri, state: known ? 'absent' : 'unknown', indexing } as RecordStatus;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/v1/notify' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as NotifyInput;
      this.notified.push(body);
      if (this.notifyFailures > 0) {
        this.notifyFailures -= 1;
        return json(503, {
          error: { code: 'queue_full', message: 'queue full', requestId: '00000000-0000-4000-8000-000000000000' },
        });
      }
      return json(202, { state: 'queued' });
    }
    if (url.pathname === '/api/v1/records/status' && (init.method ?? 'GET') === 'GET') {
      const uri = url.searchParams.get('uri') as AtUri;
      this.statusPolls.push(uri);
      const n = (this.pollsByUri.get(uri) ?? 0) + 1;
      this.pollsByUri.set(uri, n);
      let status = await this.truth(uri);
      if (n <= this.pendingPolls && this.notifiedUris().includes(uri)) {
        // Not verified yet: neither the record nor a new opt-out shows.
        status = { uri, state: 'pending', indexing: { ...status.indexing, state: 'current' } };
      }
      const override = this.overrides.get(uri);
      if (override !== undefined) status = override(status);
      return json(200, status);
    }
    return json(404, {
      error: { code: 'not_found', message: 'no route', requestId: '00000000-0000-4000-8000-000000000000' },
    });
  };
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export interface OutboxFixture {
  clock: FixedClock;
  random: Random;
  pds: FakePds;
  repo: SignedRepo;
  session: FakePdsSession;
  appView: FakeAppView;
  api: ApiClient;
  idb: IDBFactory;
  store: OutboxStore;
  /** A runner over the current store and session. */
  runner(overrides?: Partial<RunnerDeps>): OutboxRunner;
  /** A page reload: a new IndexedDB connection and a new session object (barriers dropped). */
  reload(): Promise<void>;
  /** Rows of Alice's outbox, oldest first. */
  ops(): Promise<OutboxOperation[]>;
}

export interface FixtureOptions {
  /** 'zero' makes every jitter draw 0 (exact delay tests); default seeded. */
  jitter?: 'zero' | 'seeded';
  seed?: number;
}

export async function outboxFixture(options: FixtureOptions = {}): Promise<OutboxFixture> {
  const clock = fixedClock();
  const seeded = seededRandom(options.seed ?? 7);
  const random: Random = options.jitter === 'zero' ? { bytes: (n) => seeded.bytes(n), float: () => 0 } : seeded;
  const pds = fakePds('pds.alice.test', { clock });
  const repo = new SignedRepo(ALICE, await testKey('secp256k1', 0x07, 'alice-secp256k1'), { clock });
  await pds.addAccount(repo, { handle: 'alice.test' });
  const appView = new FakeAppView(pds);
  const api = new ApiClient({ baseUrl: APPVIEW_ORIGIN, fetch: appView.fetch });
  const idb = new IDBFactory();
  const fx: OutboxFixture = {
    clock,
    random,
    pds,
    repo,
    session: new FakePdsSession(pds, ALICE),
    appView,
    api,
    idb,
    store: await OutboxStore.open({ indexedDB: idb }),
    runner: (overrides = {}) =>
      new OutboxRunner({
        store: fx.store,
        session: fx.session,
        api,
        clock,
        random,
        prefix: PREFIX,
        ...overrides,
      }),
    async reload() {
      fx.store = await OutboxStore.open({ indexedDB: idb });
      fx.session = new FakePdsSession(pds, ALICE);
    },
    ops: () => fx.store.list(ALICE),
  };
  return fx;
}

/**
 * Runs due work, then jumps the frozen clock to the next due time, until
 * nothing is scheduled (or `maxSteps`). Returns each jump in ms.
 */
export async function runUntilIdle(
  runner: OutboxRunner,
  clock: FixedClock,
  options: { maxSteps?: number; untilMs?: number } = {},
): Promise<number[]> {
  const jumps: number[] = [];
  for (let i = 0; i < (options.maxSteps ?? 200); i++) {
    const next = await runner.runDue();
    if (next === null) return jumps;
    const jump = Math.max(0, next - clock.nowMs());
    if (options.untilMs !== undefined && clock.nowMs() + jump > options.untilMs) return jumps;
    clock.advance(jump);
    jumps.push(jump);
  }
  throw new Error('runUntilIdle: still busy after maxSteps');
}

/** The record currently at `collection/rkey` on Alice's PDS, or null. */
export async function remoteRecord(fx: OutboxFixture, collection: string, rkey: string) {
  return fx.repo.getRecord(collection, rkey);
}

/** A minimal exclusive Web Locks implementation (FIFO waiters, abortable while waiting). */
export function memoryLocks(): OutboxLocks & { holders(name: string): number } {
  const tails = new Map<string, Promise<void>>();
  const held = new Map<string, number>();
  return {
    holders: (name) => held.get(name) ?? 0,
    request(name, options, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        name,
        previous.then(() => mine),
      );
      return previous.then(async () => {
        try {
          if (options.signal?.aborted) {
            throw new DOMException('lock request aborted', 'AbortError');
          }
          held.set(name, (held.get(name) ?? 0) + 1);
          try {
            await callback();
          } finally {
            held.set(name, (held.get(name) ?? 1) - 1);
          }
        } finally {
          release();
        }
      });
    },
  };
}
