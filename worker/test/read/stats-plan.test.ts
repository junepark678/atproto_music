// W3-02: statistics query plans (ADR 0004 §10.4 "Query plans", M5.1.3
// query_plan). 100 DIDs × 1,000 scrobbles are seeded, each DID through one
// range snapshot of a real signed repository (applySnapshotChunk +
// completeSnapshot, the production apply path), so the projection holds
// 100,000 rows with production music keys. Every statement the stats module
// and its exact cache run is then planned with EXPLAIN QUERY PLAN:
// - with the schema's indexes, scrobbles is only ever *searched* by DID
//   through scrobbles_owner_time / scrobbles_stats (and display rows by the URI
//   primary key), never scanned;
// - negative control: with the scrobbles indexes dropped, the same statements
//   plan a full SCAN of scrobbles, and they still return identical results.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { StatsWindow } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { computeStatistics, type Statement, statsStatements, windowBounds } from '../../src/do/read/stats';
import { cacheProbes } from '../../src/do/read/stats-cache';
import { applySnapshotChunk, completeSnapshot } from '../../src/do/write/apply-snapshot';
import { NOW_NS, PREFIX, SCROBBLE, scrobble, seedSnapshotJob, seedUser } from '../write/support';
import { inTestDb, openTestDb, type TestDb } from './node-harness';

const DIDS = 100;
const PER_DID = 1000;
const WINDOWS: StatsWindow[] = ['all', '7d', '30d', '365d'];
const BASE_MS = Date.parse('2026-01-15T12:00:00Z');

function didOf(i: number): string {
  const a = String.fromCharCode(97 + Math.floor(i / 26));
  const b = String.fromCharCode(97 + (i % 26));
  return `did:plc:plan${a}${b}${'z'.repeat(18)}`;
}

/** Record j of DID d: listens spread over ~2 years, 40 artists, 160 tracks, every 7th without album. */
function recordOf(d: number, j: number) {
  const at = new Date(BASE_MS - (j * 17 * 3600 + d * 60) * 1000).toISOString().replace('.000Z', 'Z');
  const artist = `Artist ${(j * 7 + d) % 40}`;
  const fields: Record<string, unknown> = { artist, track: `Track ${j % 160}`, listenedAt: at, createdAt: at };
  if (j % 7 !== 0) fields.album = `Album ${j % 23}`;
  return scrobble(fields);
}

async function seed(store: TestDb): Promise<void> {
  const keys = await fixtureKeys();
  for (let d = 0; d < DIDS; d++) {
    const did = didOf(d);
    const repo = new SignedRepo(did, keys.alice, { clock: fixedClock() });
    const ops = Array.from({ length: PER_DID }, (_, j) => ({
      action: 'put' as const,
      collection: SCROBBLE,
      rkey: `p${String(j).padStart(4, '0')}`,
      record: recordOf(d, j),
    }));
    const commit = await repo.writes(ops);
    const entries = commit.ops
      .map((op) => ({ key: op.path, cid: op.cid!, record: op.record }))
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    await inTestDb(store, (db) => {
      const generation = seedUser(db, did, { active: false });
      seedSnapshotJob(db, did, generation);
      const chunk = db.tx(() =>
        applySnapshotChunk(db, {
          did,
          generation,
          headRev: commit.rev,
          intervalLo: null,
          intervalHi: `${PREFIX}/`,
          entries,
          receiptNs: NOW_NS,
          prefix: PREFIX,
          nowNs: NOW_NS,
        }),
      );
      expect(chunk).toEqual({ outcome: 'applied', written: PER_DID, unchanged: 0, deleted: 0 });
      const done = db.tx(() =>
        completeSnapshot(db, { did, generation, headRev: commit.rev, accountActive: true, nowNs: NOW_NS }),
      );
      expect(done).toEqual({ outcome: 'complete', active: true });
    });
  }
}

/**
 * The plan of `st`. `tag` makes the SQL text distinct: workerd caches prepared
 * statements by text, and a cached EXPLAIN QUERY PLAN keeps reporting the plan
 * it was prepared with even after DROP INDEX, so the negative control must
 * prepare its own statements.
 */
function plan(db: Db, st: Statement, tag = 'indexed'): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN /* ${tag} */ ${st.sql}`, ...st.params).map((r) => r.detail);
}

/** Every statement one stats request (and a cache check against an older computation) runs. */
function statementsFor(did: string, window: StatsWindow): Array<[string, Statement]> {
  const bounds = windowBounds(window, NOW_NS);
  const older = windowBounds(window, NOW_NS - 3_600_000_000_000n);
  const st = statsStatements(did, bounds, 10);
  const probes = cacheProbes(did, older, bounds);
  if (probes === null) throw new Error('bounds are comparable');
  return [
    [`${window} totals`, st.totals],
    [`${window} artists`, st.artists],
    [`${window} tracks`, st.tracks],
    [`${window} albums`, st.albums],
    ...probes.map((p, k) => [`${window} cache probe ${k}`, p] as [string, Statement]),
  ];
}

// scrobbles_album_stats (ADR 0005 §6.4, migration 2) is the per-DID album
// index; the planner may serve the album ranking from it.
const INDEXED_SEARCH =
  /^SEARCH (s|scrobbles) USING (COVERING )?INDEX (scrobbles_owner_time|scrobbles_stats|scrobbles_album_stats) \(did=\?/;
const FULL_SCAN = /^SCAN (s|scrobbles)\b/;

it('EXPLAIN QUERY PLAN uses scrobbles_owner_time/scrobbles_stats; negative control without indexes shows SCAN', async () => {
  const store = await openTestDb();
  await seed(store);
  const target = didOf(42);
  await inTestDb(store, (db) => {
    expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: DIDS * PER_DID });
    expect(db.one('SELECT count(*) AS n FROM users WHERE active = 1')).toEqual({ n: DIDS });
    expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE did = ?', target)).toEqual({ n: PER_DID });

    const before = new Map<StatsWindow, unknown>();
    for (const w of WINDOWS) {
      const result = computeStatistics(db, target, w, 10, NOW_NS);
      expect(result.totalScrobbles).toBeGreaterThan(0);
      before.set(w, result);
      for (const [name, st] of statementsFor(target, w)) {
        const details = plan(db, st);
        expect(
          details.some((d) => INDEXED_SEARCH.test(d)),
          `${name}: ${details.join(' | ')}`,
        ).toBe(true);
        expect(
          details.filter((d) => FULL_SCAN.test(d)),
          `${name}: ${details.join(' | ')}`,
        ).toEqual([]);
        // Ranking statements fetch each display row by the URI primary key.
        if (/artists|tracks|albums/.test(name)) {
          expect(details, name).toContain('SEARCH d USING INDEX sqlite_autoindex_scrobbles_1 (uri=?)');
        }
      }
    }
    // The windows are real ranges over this data set (all ⊋ 365d ⊋ 30d ⊋ 7d).
    const totals = WINDOWS.map((w) => (before.get(w) as { totalScrobbles: number }).totalScrobbles);
    expect(totals[0]).toBe(PER_DID);
    expect(totals[0]! > totals[3]! && totals[3]! > totals[2]! && totals[2]! > totals[1]!).toBe(true);

    // Negative control: without the scrobbles indexes the same statements scan the table.
    for (const idx of ['scrobbles_owner_time', 'scrobbles_stats', 'scrobbles_global_time', 'scrobbles_album_stats']) {
      db.run(`DROP INDEX ${idx}`);
    }
    for (const w of WINDOWS) {
      for (const [name, st] of statementsFor(target, w)) {
        const details = plan(db, st, 'no-index control');
        expect(
          details.some((d) => FULL_SCAN.test(d)),
          `${name}: ${details.join(' | ')}`,
        ).toBe(true);
        expect(
          details.some((d) => INDEXED_SEARCH.test(d)),
          name,
        ).toBe(false);
      }
      // Same answers: the plans differ, the query does not.
      expect(computeStatistics(db, target, w, 10, NOW_NS)).toEqual(before.get(w));
    }
  });
}, 600_000);
