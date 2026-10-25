// Shared rig for the server outbox suites (ADR 0005 §5.8, §15.2; N2-05). TEST-ONLY.
//
// - A migrated temporary-file database (support/node-db.ts), reopened to
//   simulate a process restart.
// - The fixture network (packages/atproto/test-support/read-models.ts
//   `createFixtureKit`): real signed repositories on fake PDSs with the
//   reference write limits, fake PLC and DoH. Nothing leaves the process.
// - PdsWriters exactly like production's: requests go through policyFetch
//   (worker/src/node/policy-fetch.ts) over the fixture transport, so the URL
//   policy, `redirect: 'manual'`, the deadline and the body caps apply. A
//   transport spy records every request policyFetch hands it. The writers
//   authenticate with the fake PDS's fixture Bearer token (the DPoP OAuth
//   session is N2-03's; PdsWriter abstracts it).
// - Fault injection only through these injected interfaces: a writer that
//   "crashes" (never answers) before sending or after the PDS answered, a
//   writer source that reports sign-in required, and the fake PDS's own fault
//   queue.
// - Frozen clock 2026-01-15T12:00:00Z, seeded (or zero-jitter) randomness.

import type { FixtureKit } from '@atmusic/atproto/test-support/read-models';
import { createFixtureKit } from '@atmusic/atproto/test-support/read-models';
import type { Random } from '@atmusic/core/deps';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import type { OperationRow } from '../../../src/app/rows';
import { parseConfig } from '../../../src/config';
import type { Logger, LogLevel } from '../../../src/do/contracts';
import { cachedIdentityResolver } from '../../../src/do/ingest/identity-cache';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { PDS_WRITER_CAPS, type PdsWriter, type PdsWriterSource } from '../../../src/outbox/pds-writer';
import { type OutboxDeps, type OutboxRunReport, runOutbox } from '../../../src/outbox/runner';
import { reopen, type TempDbContext, withMigratedDb } from '../support/node-db';

export const PREFIX = 'com.example.atmusic';
export const SCROBBLE = `${PREFIX}.scrobble`;
export const FOLLOW = `${PREFIX}.follow`;
export const SETTINGS = `${PREFIX}.settings`;
export const LOVE = `${PREFIX}.love`;
export const T0 = Date.parse('2026-01-15T12:00:00Z');

export const CREATE = 'com.atproto.repo.createRecord';
export const PUT = 'com.atproto.repo.putRecord';
export const DELETE = 'com.atproto.repo.deleteRecord';
export const APPLY = 'com.atproto.repo.applyWrites';
export const GET = 'com.atproto.repo.getRecord';
export const LIST = 'com.atproto.repo.listRecords';

/** A Random whose jitter is always zero (float() = 0); bytes stay seeded. */
export function zeroJitter(seed = 3): Random {
  const r = seededRandom(seed);
  return { bytes: (n) => r.bytes(n), float: () => 0 };
}

export function testConfig() {
  return parseConfig(
    {
      PUBLIC_ORIGIN: 'https://music.example.test',
      LEXICON_PREFIX: PREFIX,
      NAMESPACE_OWNERSHIP_REF: '',
      INGEST_MODE: 'off',
      JETSTREAM_URLS: '',
      JETSTREAM_LOOKBACK_HOURS: '24',
      RELAY_URL: 'https://relay.example.test',
      PLAN: 'paid',
      DO_LOCATION_HINT: '',
      ADMIN_TOKEN: '',
    } as Parameters<typeof parseConfig>[0],
    { allowFixturePrefix: true },
  );
}

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push(fields === undefined ? { level, event } : { level, event, fields });
    },
  };
}

/** One request policyFetch handed the transport. */
export interface SeenRequest {
  /** The request body's size in bytes (0 without a body). */
  bytes: number;
  method: string;
  url: string;
  redirect: Request['redirect'];
  authorization: string | null;
}

type CrashPoint = 'before_send' | 'after_commit';

/** The writers: one per fixture account, over policyFetch to the account's fake PDS. */
export class TestWriters implements PdsWriterSource {
  /** DIDs whose session needs a new sign-in (writerFor answers null). */
  readonly signedOut = new Set<string>();
  /** Every request a writer sent, with its parsed JSON body (POST) and the answer's status. */
  readonly sent: {
    nsid: string;
    method: string;
    did: string;
    body: Record<string, unknown> | null;
    status?: number;
  }[] = [];
  private crash: { nsid: string; when: CrashPoint; resolve: () => void } | null = null;
  private pause: { nsid: string; reached: () => void; gate: Promise<void> } | null = null;

  constructor(
    private readonly kit: FixtureKit,
    private readonly fetch: ReturnType<typeof bindPolicyFetch>,
  ) {}

  /** The next request for `nsid` never answers: before it is sent, or after the PDS answered. Resolves then. */
  crashOn(nsid: string, when: CrashPoint): Promise<void> {
    return new Promise((resolve) => {
      this.crash = { nsid, when, resolve };
    });
  }

  /**
   * The next request for `nsid` waits (after the PDS answered) until
   * `release()`; `reached` resolves when it is waiting.
   */
  pauseOn(nsid: string): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    this.pause = { nsid, reached, gate };
    return { reached: reachedP, release };
  }

  async writerFor(did: string): Promise<PdsWriter | null> {
    if (this.signedOut.has(did)) return null;
    const user = Object.values(this.kit.users).find((u) => u.did === did);
    if (user === undefined) return null;
    return {
      did,
      fetchHandler: async (pathname, init) => {
        const nsid = new URL(pathname, user.origin).pathname.replace(/^\/xrpc\//, '');
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        const entry: TestWriters['sent'][number] = { nsid, method: init?.method ?? 'GET', did, body };
        this.sent.push(entry);
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${user.token}`);
        const crash = this.crash !== null && this.crash.nsid === nsid ? this.crash : null;
        if (crash?.when === 'before_send') {
          this.crash = null;
          crash.resolve();
          return new Promise<Response>(() => {});
        }
        const response = await this.fetch(new URL(pathname, user.origin), { ...init, headers });
        entry.status = response.status;
        if (crash?.when === 'after_commit') {
          this.crash = null;
          crash.resolve();
          return new Promise<Response>(() => {});
        }
        const pause = this.pause !== null && this.pause.nsid === nsid ? this.pause : null;
        if (pause !== null) {
          this.pause = null;
          pause.reached();
          await pause.gate;
        }
        return response;
      },
    };
  }

  /** Requests sent for one XRPC method. */
  count(nsid: string): number {
    return this.sent.filter((s) => s.nsid === nsid).length;
  }

  /** The XRPC methods sent, in order. */
  order(): string[] {
    return this.sent.map((s) => s.nsid);
  }
}

export interface Harness {
  kit: FixtureKit;
  ctx: TempDbContext;
  m: OutboxDeps;
  db: SqliteDb;
  writers: TestWriters;
  log: ReturnType<typeof recordingLogger>;
  /** Requests policyFetch handed the transport. */
  seen: SeenRequest[];
  alice: string;
  bob: string;
  run(): Promise<OutboxRunReport>;
  /** Runs while the outbox asks to run again right away; returns the reports. */
  runUntilIdle(maxRuns?: number): Promise<OutboxRunReport[]>;
  /** Closes the database and opens the same file again (a process restart), with fresh deps. */
  restart(): void;
  op(id: string): OperationRow;
  ops(where?: string): OperationRow[];
  /** An `accounts` row for `did`. */
  account(
    did: string,
    fields?: Partial<{ oauth_status: string; import_share_pct: number; daily_listen_cap: number }>,
  ): void;
  /** An active linked account. */
  link(
    did: string,
    service: 'lastfm' | 'listenbrainz',
    fields?: Partial<{ status: string; forward_scrobbles: number; forward_now_playing: number }>,
  ): string;
  /** A known, current `users` row (what admission and a completed snapshot leave). */
  seedUser(did: string): void;
}

export interface HarnessOptions {
  random?: Random;
  kit?: FixtureKit;
}

/** Runs `fn` over a fresh harness; the database and its directory are removed afterwards. */
export async function withHarness(fn: (h: Harness) => Promise<void>, o: HarnessOptions = {}): Promise<void> {
  const kit = o.kit ?? (await createFixtureKit({ clock: fixedClock() }));
  const random = o.random ?? seededRandom(11);
  const config = testConfig();
  const log = recordingLogger();
  const seen: SeenRequest[] = [];
  const spy = Object.assign(
    async (request: Request) => {
      const bytes = request.body === null ? 0 : (await request.clone().arrayBuffer()).byteLength;
      seen.push({
        bytes,
        method: request.method,
        url: request.url,
        redirect: request.redirect,
        authorization: request.headers.get('authorization'),
      });
      return kit.transport(request);
    },
    { fixture: true as const },
  );
  const fetch = bindPolicyFetch(createPolicyFetch({ transport: spy }), PDS_WRITER_CAPS);
  const writers = new TestWriters(kit, fetch);
  await withMigratedDb(async (first, ctx) => {
    const depsFor = (db: SqliteDb): OutboxDeps => ({
      db,
      clock: kit.clock,
      random,
      transport: kit.transport,
      identity: cachedIdentityResolver(db, { transport: kit.transport, clock: kit.clock }),
      config,
      log,
      writers,
    });
    const h: Harness = {
      kit,
      ctx,
      m: depsFor(first),
      db: first,
      writers,
      log,
      seen,
      alice: kit.users.Alice.did,
      bob: kit.users.Bob.did,
      run: () => runOutbox(h.m, kit.clock.nowMs()),
      async runUntilIdle(maxRuns = 200) {
        const reports: OutboxRunReport[] = [];
        for (let i = 0; i < maxRuns; i++) {
          const report = await h.run();
          reports.push(report);
          if (report.nextDueMs === null || report.nextDueMs > kit.clock.nowMs()) return reports;
        }
        throw new Error(`outbox still busy after ${maxRuns} runs`);
      },
      restart() {
        const next = reopen(ctx.current);
        h.db = next;
        h.m = depsFor(next);
      },
      op(id) {
        const row = h.db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', id);
        if (row === null) throw new Error(`no operation ${id}`);
        return row;
      },
      ops(where = '1') {
        return h.db.all<OperationRow>(`SELECT * FROM operations WHERE ${where} ORDER BY rowid`);
      },
      account(did, fields = {}) {
        const username = `u${h.db.one<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n + 1}`;
        h.db.run(
          `INSERT INTO accounts(did, username, oauth_status, import_share_pct, daily_listen_cap, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          did,
          username,
          fields.oauth_status ?? 'active',
          fields.import_share_pct ?? 50,
          fields.daily_listen_cap ?? 3000,
          T0,
          T0,
        );
      },
      link(did, service, fields = {}) {
        const id = `link-${service}-${h.db.one<{ n: number }>('SELECT count(*) AS n FROM linked_accounts')!.n + 1}`;
        h.db.run(
          `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
             forward_now_playing, status, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 'e1', ?, ?, ?, ?, ?)`,
          id,
          did,
          service,
          `remote-${service}`,
          new Uint8Array([1, 2, 3]).buffer,
          fields.forward_scrobbles ?? 1,
          fields.forward_now_playing ?? 1,
          fields.status ?? 'active',
          T0,
          T0,
        );
        return id;
      },
      seedUser(did) {
        const row = h.db.one<{ last_generation: number }>(
          'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation',
        )!;
        h.db.run(
          `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
           VALUES (?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current', ?)`,
          did,
          row.last_generation,
        );
      },
    };
    await fn(h);
  });
}

/** A valid live listen input `i` minutes before T0. */
export function listenInput(i: number, o: Partial<{ artist: string; track: string; album: string }> = {}) {
  return {
    artist: o.artist ?? `Artist ${i}`,
    track: o.track ?? `Track ${i}`,
    listenedAt: new Date(T0 - (i + 1) * 60_000).toISOString(),
    ...(o.album !== undefined ? { album: o.album } : {}),
  };
}

/** The record at `collection/rkey` on `did`'s fake PDS repo head, or null. */
export async function remoteRecord(
  kit: FixtureKit,
  name: 'Alice' | 'Bob',
  collection: string,
  rkey: string,
): Promise<{ cid: string; value: unknown } | null> {
  return (await kit.repos[name].getRecord(collection, rkey)) ?? null;
}

/** Every record of `collection` on the account's repo head. */
export async function remoteRecords(kit: FixtureKit, name: 'Alice' | 'Bob', collection: string) {
  return kit.repos[name].list(collection);
}
