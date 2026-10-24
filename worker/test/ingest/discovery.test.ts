// W4-03 discovery.ts: relay listReposByCollection paging into bounded
// admission (ADR 0004 §5.4 hint sources, §5.5 gap recovery, §5.6; amendment
// A6), against real DO SQLite and the fixture relay. A relay listing is a
// hint naming only a DID: it may create an inactive users row and a pending
// snapshot job, never a projected record. Every expected value is hardcoded
// from the relay contents set up here.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type FixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  DISCOVERY_STATE_COUNTER,
  discover,
  gapDiscoveryPending,
  LIST_REPOS_BY_COLLECTION,
  readDiscoveryState,
  requestGapDiscovery,
} from '../../src/do/ingest/discovery';
import { dueAt } from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';
import { NOW_STORAGE, seedUser } from '../write/support';
import { depsFor, kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

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

    await runInDurableObject(stubFor('discovery-pages'), async (i: HarnessDO) => {
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

    await runInDurableObject(stubFor('discovery-gap'), async (i: HarnessDO) => {
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
});
