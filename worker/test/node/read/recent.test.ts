// N2-06: recent listens for user.getRecentTracks / getTrackScrobbles (ADR 0005
// §7.9) and GET /1/user/{user}/listens (§8.4).
//
// Alice's and Bob's fixture records (tests/fixtures/read_models.json) are
// published into real signed repositories and applied through the production
// verifier and apply path into a migrated node:sqlite file. Expected orders and
// counts are worked out by hand from the fixture:
//
//   r07 2026-01-15T11:00:00Z   r01 2026-01-15T11:00:00Z (same instant: uri DESC puts r07 first)
//   r02 2026-01-14T11:00:00Z   r03 2026-01-08T12:00:00Z   r04 2025-12-16T12:00:00Z
//   r05 2025-01-15T12:00:00Z   r06 2025-01-14T11:00:00Z   (r08 deleted)

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import { ListensQueryError, recentListens } from '../../../src/do/read/recent';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { withMigratedDb } from '../support/node-db';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const NOW_NS = fromMs(Date.parse('2026-01-15T12:00:00Z'));
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };

const unix = (iso: string) => Date.parse(iso) / 1000;

function seedUser(db: Db, did: string): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )!.g;
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', ?)`,
    did,
    toStorage(NOW_NS),
    gen,
  );
}

async function put(db: Db, repo: SignedRepo, rkey: string, record: Record<string, unknown>): Promise<void> {
  await repo.put(SCROBBLE, rkey, record);
  const car = await repo.getRecordCar(SCROBBLE, rkey);
  const proof = await verifyRecordProof(car, {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  expect(db.tx(() => applyRecordProof(db, proof, OPTS)).outcome).toBe(proof.state === 'present' ? 'applied' : 'absent');
}

async function seedFixture(db: Db) {
  seedUser(db, ALICE);
  seedUser(db, BOB);
  const keys = await fixtureKeys();
  const alice = new SignedRepo(ALICE, keys.alice, { clock: fixedClock() });
  const bob = new SignedRepo(BOB, keys.bob, { clock: fixedClock() });
  for (const s of fixture.scrobbles) {
    if (s.owner === ALICE) await put(db, alice, s.rkey, { ...s.record });
    else if (s.owner === BOB) await put(db, bob, s.rkey, { ...s.record });
  }
  await alice.delete(SCROBBLE, 'r08');
  const car = await alice.getRecordCar(SCROBBLE, 'r08');
  const proof = await verifyRecordProof(car, {
    did: ALICE,
    collection: SCROBBLE,
    rkey: 'r08',
    signingKey: alice.key.didKey,
  });
  expect(db.tx(() => applyRecordProof(db, proof, OPTS)).outcome).toBe('absent');
  return { alice, bob };
}

const rkeys = (rows: ReadonlyArray<{ rkey: string }>) => rows.map((r) => r.rkey);
const ALL_NEWEST_FIRST = ['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

describe('recent listens', () => {
  it('after/before are exclusive in seconds, results are newest first, and page/limit report total and totalPages', async () => {
    await withMigratedDb(async (db) => {
      const { bob } = await seedFixture(db);
      const m = { db };

      const first = recentListens(m, { did: ALICE, limit: 2, page: 1 })!;
      expect(rkeys(first.rows)).toEqual(['r07', 'r01']);
      expect([first.total, first.totalPages, first.page, first.perPage, first.offset]).toEqual([7, 4, 1, 2, 0]);
      const pages = [1, 2, 3, 4, 5].map((page) => recentListens(m, { did: ALICE, limit: 2, page })!);
      expect(pages.map((p) => rkeys(p.rows))).toEqual([['r07', 'r01'], ['r02', 'r03'], ['r04', 'r05'], ['r06'], []]);
      expect(pages.every((p) => p.total === 7 && p.totalPages === 4)).toBe(true);
      expect(rkeys(recentListens(m, { did: ALICE, limit: 50 })!.rows)).toEqual(ALL_NEWEST_FIRST);
      // An offset is the same page.
      const byOffset = recentListens(m, { did: ALICE, limit: 2, offset: 2 })!;
      expect([rkeys(byOffset.rows), byOffset.page]).toEqual([['r02', 'r03'], 2]);

      // Exclusive bounds: from < t < to.
      const r03 = unix('2026-01-08T12:00:00Z');
      const r02 = unix('2026-01-14T11:00:00Z');
      const between = recentListens(m, { did: ALICE, after: r03, before: r02, limit: 50 })!;
      expect([rkeys(between.rows), between.total, between.totalPages]).toEqual([[], 0, 0]);
      const widened = recentListens(m, { did: ALICE, after: r03 - 1, before: r02 + 1, limit: 50 })!;
      expect([rkeys(widened.rows), widened.total, widened.totalPages]).toEqual([['r02', 'r03'], 2, 1]);
      const fromOnly = recentListens(m, { did: ALICE, after: r03, limit: 1 })!;
      expect([rkeys(fromOnly.rows), fromOnly.total, fromOnly.totalPages]).toEqual([['r07'], 3, 3]);

      // Second precision: a listen at …00.500 has uts …00, so after = …00 excludes it and before = …01 keeps it.
      await put(db, bob, 'b1', {
        $type: SCROBBLE,
        artist: 'Massive Attack',
        track: 'Angel',
        listenedAt: '2026-01-13T00:00:00.500Z',
        createdAt: '2026-01-13T00:00:00.500Z',
      });
      const half = unix('2026-01-13T00:00:00Z');
      expect(rkeys(recentListens(m, { did: BOB, after: half, limit: 10 })!.rows)).toEqual(['r09']);
      expect(rkeys(recentListens(m, { did: BOB, after: half - 1, limit: 10 })!.rows)).toEqual(['r09', 'b1']);
      expect(rkeys(recentListens(m, { did: BOB, before: half, limit: 10 })!.rows)).toEqual([]);
      expect(rkeys(recentListens(m, { did: BOB, before: half + 1, limit: 10 })!.rows)).toEqual(['b1']);

      // user.getTrackScrobbles: one track in any spelling, newest first.
      const track = recentListens(m, { did: ALICE, artist: 'BJÖRK', track: ' jóga', limit: 10 })!;
      expect([rkeys(track.rows), track.total]).toEqual([['r01', 'r02'], 2]);
      expect(recentListens(m, { did: ALICE, artist: 'Radiohead', track: 'Creep', limit: 10 })!.total).toBe(0);

      // Unknown and inactive users are not found.
      expect(recentListens(m, { did: CAROL, limit: 10 })).toBeNull();
      db.run('UPDATE users SET active = 0 WHERE did = ?', BOB);
      expect(recentListens(m, { did: BOB, limit: 10 })).toBeNull();
    });
  });

  it('a min_ts query returns the oldest count listens after min_ts, reversed to newest first; max_ts <= min_ts is an error', async () => {
    await withMigratedDb(async (db) => {
      await seedFixture(db);
      const m = { db };
      const r04 = unix('2025-12-16T12:00:00Z');
      const r02 = unix('2026-01-14T11:00:00Z');

      const oldestAfter = recentListens(m, { did: ALICE, minTs: r04, count: 2 })!;
      expect(rkeys(oldestAfter.rows)).toEqual(['r02', 'r03']);
      expect(oldestAfter.latestListenTs).toBe(unix('2026-01-15T11:00:00Z'));
      expect(oldestAfter.oldestListenTs).toBe(unix('2025-01-14T11:00:00Z'));
      expect(rkeys(recentListens(m, { did: ALICE, minTs: r04, count: 25 })!.rows)).toEqual([
        'r07',
        'r01',
        'r02',
        'r03',
      ]);
      // Without min_ts: the newest count listens.
      expect(rkeys(recentListens(m, { did: ALICE, count: 3 })!.rows)).toEqual(['r07', 'r01', 'r02']);
      // max_ts is exclusive too.
      expect(rkeys(recentListens(m, { did: ALICE, maxTs: r02, count: 25 })!.rows)).toEqual([
        'r03',
        'r04',
        'r05',
        'r06',
      ]);
      expect(rkeys(recentListens(m, { did: ALICE, minTs: r04, maxTs: r02, count: 25 })!.rows)).toEqual(['r03']);
      // count is capped at 1000, and 0 lists nothing (the span is still reported).
      expect(rkeys(recentListens(m, { did: ALICE, count: 5000 })!.rows)).toEqual(ALL_NEWEST_FIRST);
      const none = recentListens(m, { did: ALICE, count: 0 })!;
      expect([none.rows, none.latestListenTs]).toEqual([[], unix('2026-01-15T11:00:00Z')]);

      for (const [minTs, maxTs] of [
        [r02, r02],
        [r02, r04],
      ] as const) {
        let caught: unknown = null;
        try {
          recentListens(m, { did: ALICE, minTs, maxTs, count: 25 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ListensQueryError);
        expect((caught as ListensQueryError).message).toBe('max_ts should be greater than min_ts');
        expect((caught as ListensQueryError).code).toBe('max_ts_not_greater');
      }
      expect(() => recentListens(m, { did: ALICE, count: -1 })).toThrow(RangeError);
      expect(recentListens(m, { did: CAROL, count: 25 })).toBeNull();
    });
  });
});
