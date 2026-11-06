// W4-03 discovery.ts: relay listReposByCollection paging into bounded
// admission (ADR 0004 §5.4 hint sources, §5.5 gap recovery, §5.6; amendment
// A6), against a real SQLite file and the fixture relay. A relay listing is a
// hint naming only a DID: it may create an inactive users row and a pending
// snapshot job, never a projected record. Every expected value is hardcoded
// from the relay contents set up here.

import { type FixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import type { FixtureTransport } from '@atmusic/atproto/test-support/router-transport';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  DISCOVERY_MAX_CURSOR_CHARS,
  DISCOVERY_STATE_COUNTER,
  type DiscoveryReport,
  discover,
  gapDiscoveryPending,
  LIST_REPOS_BY_COLLECTION,
  readDiscoveryState,
  requestGapDiscovery,
} from '../../src/do/ingest/discovery';
import { GAP_SCAN_DONE, maybeClearGap } from '../../src/do/ingest/snapshot-job';
import { updateCheckpointBookkeeping } from '../../src/do/status';
import { dueAt, runDue, type TimerHandlers } from '../../src/do/timers';
import { NOW_STORAGE, seedUser } from '../write/support';
import { depsFor, kit } from './drain-support';
import { withIngestIndex } from './node-index';

const T0 = Date.parse('2026-01-15T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// did:plc identifiers in byte order of their index (base32 alphabet sorted).
const B32 = '234567abcdefghijklmnopqrstuvwxyz';
function syntheticDid(group: 'f' | 's', index: number): string {
  const enc = B32[(index >> 10) & 31]! + B32[(index >> 5) & 31]! + B32[index & 31]!;
  return `did:plc:${group}${'a'.repeat(20)}${enc}`;
}

function projection(db: Db) {
  return {
    scrobbles: db.all('SELECT * FROM scrobbles'),
    follows: db.all('SELECT * FROM follows'),
    record_state: db.all('SELECT * FROM record_state'),
    hints: db.all('SELECT * FROM hints'),
  };
}

const EMPTY = { scrobbles: [], follows: [], record_state: [], hints: [] };

function admittedUsers(db: Db) {
  return db.all<{ did: string; active: number; account_status: string; indexing_state: string }>(
    'SELECT did, active, account_status, indexing_state FROM users ORDER BY did',
  );
}

function snapshotJobs(db: Db) {
  return db.all<{ did: string; state: string; reason: string }>(
    `SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot' ORDER BY did`,
  );
}

function relayPages(k: FixtureKit) {
  return k.relay.calls.filter({ nsid: LIST_REPOS_BY_COLLECTION }).map((c) => ({
    collection: c.params.collection?.[0],
    limit: c.params.limit?.[0],
    cursor: c.params.cursor?.[0] ?? null,
  }));
}

/** Every call that would fetch, verify or resolve a record or an identity. */
function recordCalls(k: FixtureKit): number {
  return (['Alice', 'Bob', 'Carol'] as const).reduce((n, u) => n + k.pds[u].calls.count(), 0) + k.plc.count();
}

describe('relay discovery', () => {
  it('listReposByCollection pages admit DIDs within budget and never project records', async () => {
    const k = await kit();
    await seedReadModels(k); // the relay lists Alice, Bob and Carol (scrobble) and Alice (follow)
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const carol = k.users.Carol.did;
    const S = k.collections.scrobble;
    const F = k.collections.follow;
    const s = Array.from({ length: 60 }, (_, i) => syntheticDid('s', i));
    const f = Array.from({ length: 3 }, (_, i) => syntheticDid('f', i));
    k.relay.add(S, ...s, 'did:example:not-resolvable');
    k.relay.add(F, ...f);
    // Scrobble listing (DID order): did:example (invalid), Alice (known), Bob, Carol
    // (suppressed), s0..s59 — 64 entries, 13 pages of 5. Follow listing: Alice, f0..f2.
    expect(k.relay.repos(S).length).toBe(64);
    k.resetCalls();

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      db.run('INSERT INTO suppression(did, suppressed_at) VALUES (?, ?)', carol, NOW_STORAGE);
      const aliceBefore = db.one('SELECT * FROM users WHERE did = ?', alice);

      // Run 1: the page budget (10 pages) ends it after 50 listed entries.
      const r1 = await discover(m, T0, { pageLimit: 5 });
      expect(r1).toMatchObject({ pass: 'daily', pages: 10, known: 1, suppressed: 1, invalid: 1, stop: 'page_budget' });
      expect(r1.admitted).toEqual([bob, ...s.slice(0, 46)]);
      const pages1 = relayPages(k);
      expect(pages1.length).toBe(10);
      expect(pages1[0]).toEqual({ collection: S, limit: '5', cursor: null });
      expect(pages1[1]).toEqual({ collection: S, limit: '5', cursor: s[0] });
      expect(pages1[9]).toEqual({ collection: S, limit: '5', cursor: s[40] });
      expect(readDiscoveryState(db)).toEqual({ pass: 'daily', collection: 0, cursor: s[45], pages: 10 });
      expect(dueAt(db, 'discovery')).toBe(T0 + DAY);

      // Run 2, same admission hour: 3 more fill the hourly budget of 50; s49 is refused,
      // so the position stays at the start of that page.
      k.resetCalls();
      const r2 = await discover(m, T0 + 60_000, { pageLimit: 5 });
      expect(r2).toMatchObject({ pages: 1, stop: 'admission_busy', detail: 'hourly_budget' });
      expect(r2.admitted).toEqual(s.slice(46, 49));
      expect(relayPages(k)).toEqual([{ collection: S, limit: '5', cursor: s[45] }]);
      expect(readDiscoveryState(db)).toEqual({ pass: 'daily', collection: 0, cursor: s[45], pages: 10 });
      expect(db.one('SELECT admitted FROM admission')).toEqual({ admitted: 50 });

      // Run 3, next hour: the refused page is read again (s46..s48 are known now), the
      // scrobble listing ends, then the follow listing; the pass completes.
      k.resetCalls();
      const r3 = await discover(m, T0 + HOUR, { pageLimit: 5 });
      expect(r3).toMatchObject({ pages: 4, known: 4, stop: 'complete' });
      expect(r3.admitted).toEqual([...s.slice(49), ...f]);
      expect(relayPages(k)).toEqual([
        { collection: S, limit: '5', cursor: s[45] },
        { collection: S, limit: '5', cursor: s[50] },
        { collection: S, limit: '5', cursor: s[55] },
        { collection: F, limit: '5', cursor: null },
      ]);
      expect(readDiscoveryState(db)).toBeNull();
      expect(db.all('SELECT * FROM counters WHERE name = ?', DISCOVERY_STATE_COUNTER)).toEqual([]);
      expect(dueAt(db, 'discovery')).toBe(T0 + HOUR + DAY);

      // Admission only: inactive, recovering users plus one pending snapshot job each.
      const admitted = [bob, ...s, ...f].sort();
      expect(admitted.length).toBe(64);
      expect(admittedUsers(db).filter((u) => u.did !== alice)).toEqual(
        admitted.map((did) => ({ did, active: 0, account_status: 'unknown', indexing_state: 'recovering' })),
      );
      expect(snapshotJobs(db)).toEqual(admitted.map((did) => ({ did, state: 'pending', reason: 'admission' })));
      expect(db.one("SELECT value FROM counters WHERE name = 'admitted' AND label = 'discovery'")).toEqual({
        value: 64,
      });
      // The known account is untouched; the suppressed one and the invalid DID get nothing.
      expect(db.one('SELECT * FROM users WHERE did = ?', alice)).toEqual(aliceBefore);
      expect(db.one('SELECT did FROM users WHERE did = ?', carol)).toBeNull();
      expect(db.one("SELECT did FROM users WHERE did LIKE 'did:example:%'")).toBeNull();
      expect(dueAt(db, 'snapshot')).toBe(T0);

      // Never a record: no projection row, no hint, and no PDS / PLC request at all.
      expect(projection(db)).toEqual(EMPTY);
      expect(recordCalls(k)).toBe(0);
    });
  });

  it('gap recovery runs one full pass from the start and stays pending until it ends', async () => {
    const k = await kit();
    const S = k.collections.scrobble;
    const s = Array.from({ length: 12 }, (_, i) => syntheticDid('s', i));
    k.relay.add(S, ...s);

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      // A daily pass is half way through the scrobble listing.
      await discover(m, T0, { pageLimit: 5, pages: 1 });
      expect(readDiscoveryState(db)).toEqual({ pass: 'daily', collection: 0, cursor: s[4], pages: 1 });
      expect(gapDiscoveryPending(db)).toBe(false);

      // Gap recovery: one pass from the beginning, due now.
      requestGapDiscovery(db, T0 + 60_000);
      expect(readDiscoveryState(db)).toEqual({ pass: 'gap', collection: 0, cursor: null, pages: 0 });
      expect(gapDiscoveryPending(db)).toBe(true);
      expect(dueAt(db, 'discovery')).toBe(T0 + 60_000);

      // A relay outage keeps the position; the gap pass retries within the hour.
      k.relay.fail({ nsid: LIST_REPOS_BY_COLLECTION }, { kind: 'status', status: 503 });
      k.resetCalls();
      const failed = await discover(m, T0 + 60_000, { pageLimit: 5 });
      expect(failed).toMatchObject({ pages: 0, stop: 'relay_error', detail: 'http_503' });
      expect(readDiscoveryState(db)).toEqual({ pass: 'gap', collection: 0, cursor: null, pages: 0 });
      expect(dueAt(db, 'discovery')).toBe(T0 + 60_000 + HOUR);

      // Two pages per run: the gap pass continues a minute later until it ends.
      const a = await discover(m, T0 + HOUR, { pageLimit: 5, pages: 2 });
      expect(a).toMatchObject({ pass: 'gap', pages: 2, stop: 'page_budget' });
      expect(gapDiscoveryPending(db)).toBe(true);
      expect(dueAt(db, 'discovery')).toBe(T0 + HOUR + 60_000);
      const b = await discover(m, T0 + HOUR + 60_000, { pageLimit: 5, pages: 2 });
      expect(b).toMatchObject({ pass: 'gap', pages: 2, stop: 'complete' });
      expect(gapDiscoveryPending(db)).toBe(false);
      expect(dueAt(db, 'discovery')).toBe(T0 + HOUR + 60_000 + DAY);
      expect(relayPages(k).map((p) => [p.collection, p.cursor])).toEqual([
        [S, null], // the 503
        [S, null],
        [S, s[4]],
        [S, s[9]],
        [k.collections.follow, null],
      ]);
      expect(snapshotJobs(db).map((j) => j.did)).toEqual(s);
      expect(projection(db)).toEqual(EMPTY);
      expect(recordCalls(k)).toBe(0);
    });
  });

  it('a gap request that lands while a relay page is in flight survives the run', async () => {
    const k = await kit();
    const S = k.collections.scrobble;
    const F = k.collections.follow;
    const s = Array.from({ length: 12 }, (_, i) => syntheticDid('s', i));
    k.relay.add(S, ...s);

    await withIngestIndex(async (i) => {
      const db = i.db;
      const base = depsFor(db, k);
      // A daily pass is one page into the scrobble listing; the next run is due tomorrow.
      await discover(base, T0, { pageLimit: 5, pages: 1 });
      expect(readDiscoveryState(db)).toEqual({ pass: 'daily', collection: 0, cursor: s[4], pages: 1 });
      expect(dueAt(db, 'discovery')).toBe(T0 + DAY);

      // The injected transport lets gap recovery start (the DO input gate is open
      // during outbound I/O) after the relay answered and before the run sees the page.
      const T1 = T0 + DAY;
      let gapRequests = 0;
      let armed = true;
      const inner = k.transport;
      const transport = Object.assign(
        async (req: Request) => {
          const res = await inner(req);
          if (armed && new URL(req.url).pathname.endsWith(LIST_REPOS_BY_COLLECTION)) {
            armed = false;
            gapRequests++;
            requestGapDiscovery(db, T1);
          }
          return res;
        },
        { fixture: true as const, calls: inner.calls, hostnames: inner.hostnames },
      ) satisfies FixtureTransport;
      const m = { ...base, transport };
      const reports: DiscoveryReport[] = [];
      const noop = async () => {};
      const handlers: TimerHandlers = {
        drain: noop,
        snapshot: noop,
        'jetstream-watchdog': noop,
        'status-sweep': noop,
        'identity-sweep': noop,
        discovery: async (at) => {
          reports.push(await discover(m, at, { pageLimit: 5, pages: 1 }));
        },
        gc: noop,
      };
      k.resetCalls();

      // The alarm claims the daily run. Its page (s5..s9) arrives after the gap request
      // reset the position: the run admits nothing from it, writes no position, and
      // leaves the gap pass due now instead of pushing the timer to tomorrow.
      const first = await runDue(i.storage, db, T1, handlers, { maxRuns: 7 });
      // (`snapshot` is the one-shot timer the first daily run armed for its admissions.)
      expect(first.ran).toEqual(['snapshot', 'discovery']);
      expect(gapRequests).toBe(1);
      expect(reports[0]).toMatchObject({ pass: 'daily', pages: 0, admitted: [], stop: 'superseded' });
      expect(readDiscoveryState(db)).toEqual({ pass: 'gap', collection: 0, cursor: null, pages: 0 });
      expect(gapDiscoveryPending(db)).toBe(true);
      expect(dueAt(db, 'discovery')).toBe(T1);
      expect(snapshotJobs(db).map((j) => j.did)).toEqual(s.slice(0, 5));

      // The next alarms run the gap pass from the start of the listing to its end, a
      // minute apart (one page per run here), and only then is the pass over.
      for (let n = 0, at = T1; n < 10 && gapDiscoveryPending(db); n++, at += 60_000) {
        expect(dueAt(db, 'discovery')).toBe(at);
        await runDue(i.storage, db, at, handlers, { maxRuns: 7 });
      }
      expect(gapDiscoveryPending(db)).toBe(false);
      expect(reports.slice(1).map((r) => [r.pass, r.stop])).toEqual([
        ['gap', 'page_budget'],
        ['gap', 'page_budget'],
        ['gap', 'page_budget'],
        ['gap', 'complete'],
      ]);
      expect(relayPages(k).map((p) => [p.collection, p.cursor])).toEqual([
        [S, s[4]], // the superseded daily page
        [S, null],
        [S, s[4]],
        [S, s[9]],
        [F, null],
      ]);
      expect(dueAt(db, 'discovery')).toBe(T1 + 3 * 60_000 + DAY);
      expect(snapshotJobs(db).map((j) => j.did)).toEqual(s);
      expect(projection(db)).toEqual(EMPTY);
      expect(recordCalls(k)).toBe(0);
    });
  });

  it('permanently malformed relay page fails bounded and does not wedge gap discovery', async () => {
    const k = await kit();
    const S = k.collections.scrobble;
    const F = k.collections.follow;
    const s = Array.from({ length: 8 }, (_, i) => syntheticDid('s', i));
    const f = syntheticDid('f', 0);
    k.relay.add(S, ...s);
    k.relay.add(F, f);

    await withIngestIndex(async (i) => {
      const db = i.db;
      const base = depsFor(db, k);
      // The relay answers two positions with a permanently malformed page: the second
      // scrobble page holds a non-object repos entry, the first follow page an over-long cursor.
      const inner = k.transport;
      const served: Array<[string | undefined, string | null, 'ok' | 'malformed']> = [];
      const transport = Object.assign(
        async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname.endsWith(LIST_REPOS_BY_COLLECTION)) {
            const collection = url.searchParams.get('collection') ?? undefined;
            const cursor = url.searchParams.get('cursor');
            if (collection === S && cursor === s[4]) {
              served.push([collection, cursor, 'malformed']);
              return Response.json({ repos: [{ did: s[5] }, 42], cursor: s[7] });
            }
            if (collection === F && cursor === null) {
              served.push([collection, cursor, 'malformed']);
              return Response.json({ repos: [{ did: f }], cursor: 'c'.repeat(DISCOVERY_MAX_CURSOR_CHARS + 1) });
            }
            served.push([collection, cursor, 'ok']);
          }
          return inner(req);
        },
        { fixture: true as const, calls: inner.calls, hostnames: inner.hostnames },
      ) satisfies FixtureTransport;
      const m = { ...base, transport };

      // Gap recovery is waiting for this pass (the snapshot scan itself is done).
      updateCheckpointBookkeeping(db, { pendingGap: true, gapScanAfterDid: GAP_SCAN_DONE });
      requestGapDiscovery(db, T0);
      expect(gapDiscoveryPending(db)).toBe(true);

      const runs: DiscoveryReport[] = [];
      let at = T0;
      for (let n = 0; n < 10 && gapDiscoveryPending(db); n++) {
        expect(dueAt(db, 'discovery')).toBe(at);
        runs.push(await discover(m, at, { pageLimit: 5 }));
        // While the gap's pass runs, gap recovery cannot finish (the scan alone is done).
        if (gapDiscoveryPending(db)) expect(maybeClearGap(db)).toBe(false);
        at = dueAt(db, 'discovery')!;
      }
      // Bounded: three answers per bad position, then that listing is given up and the pass ends.
      expect(gapDiscoveryPending(db)).toBe(false);
      expect(runs.map((r) => [r.stop, r.detail ?? null, r.abandoned ?? []])).toEqual([
        ['relay_error', 'malformed_page', []],
        ['relay_error', 'malformed_page', []],
        ['relay_error', 'malformed_page', [S]],
        ['relay_error', 'malformed_page', []],
        ['complete', null, [F]],
      ]);
      expect(served).toEqual([
        [S, null, 'ok'],
        [S, s[4], 'malformed'],
        [S, s[4], 'malformed'],
        [S, s[4], 'malformed'],
        [F, null, 'malformed'],
        [F, null, 'malformed'],
        [F, null, 'malformed'],
      ]);
      // Each retry waited the gap pass's relay retry interval; the last run returned to the daily cadence.
      expect(runs.map((r) => r.nextDueAt)).toEqual([
        T0 + HOUR,
        T0 + 2 * HOUR,
        T0 + 3 * HOUR,
        T0 + 4 * HOUR,
        T0 + 4 * HOUR + DAY,
      ]);
      expect(readDiscoveryState(db)).toBeNull();
      // The errors are recorded: every malformed answer, and each listing given up.
      const counters = (name: string) =>
        db.all<{ label: string; value: number }>(
          'SELECT label, value FROM counters WHERE name = ? ORDER BY label',
          name,
        );
      expect(counters('discovery_failed')).toEqual([{ label: 'malformed_page', value: 6 }]);
      expect(counters('discovery_abandoned')).toEqual([
        { label: F, value: 1 },
        { label: S, value: 1 },
      ]);
      expect(counters('discovery_passes')).toEqual([{ label: 'gap', value: 1 }]);
      // Only the good first page was admitted; nothing from a malformed page.
      expect(snapshotJobs(db).map((j) => j.did)).toEqual(s.slice(0, 5));
      expect(projection(db)).toEqual(EMPTY);
      expect(recordCalls(k)).toBe(0);
      // With its discovery pass over, gap recovery can finish: pending_gap clears.
      expect(db.one('SELECT pending_gap FROM ingest_checkpoint')).toEqual({ pending_gap: 1 });
      expect(maybeClearGap(db)).toBe(true);
      expect(db.one('SELECT pending_gap FROM ingest_checkpoint')).toEqual({ pending_gap: 0 });
    });
  });
});
