// N2-06: ListenBrainz listening-activity and daily-activity (ADR 0005 §8.5,
// §10.1), anchored on the frozen clock 2026-01-15T12:00:00Z (a Thursday).
//
// Alice's fixture records go through the production verifier and apply path.
// The hand-computed UTC buckets:
//
//   r01, r07  2026-01-15T11:00Z  Thursday 11h     r02  2026-01-14T11:00Z  Wednesday 11h
//   r03       2026-01-08T12:00Z  Thursday 12h     r04  2025-12-16T12:00Z  Tuesday 12h
//   r05       2025-01-15T12:00Z  Wednesday 12h    r06  2025-01-14T11:00Z  Tuesday 11h
//   x1        2026-01-15T12:03:20Z (200 s after now, accepted within +300 s): never counted.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import { dailyActivity, listeningActivity } from '../../../src/do/read/activity';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { withMigratedDb } from '../support/node-db';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const ALICE = fixture.users.Alice.did;
const CAROL = fixture.users.Carol.did;
const NOW_NS = fromMs(Date.parse('2026-01-15T12:00:00Z'));
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };

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

async function apply(db: Db, repo: SignedRepo, rkey: string): Promise<string> {
  const car = await repo.getRecordCar(SCROBBLE, rkey);
  const proof = await verifyRecordProof(car, {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  return db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
}

async function seedAlice(db: Db): Promise<void> {
  seedUser(db, ALICE);
  const alice = new SignedRepo(ALICE, (await fixtureKeys()).alice, { clock: fixedClock() });
  for (const s of fixture.scrobbles.filter((x) => x.owner === ALICE)) {
    await alice.put(SCROBBLE, s.rkey, { ...s.record });
    expect(await apply(db, alice, s.rkey)).toBe('applied');
  }
  await alice.delete(SCROBBLE, 'r08');
  expect(await apply(db, alice, 'r08')).toBe('absent');
  const at = '2026-01-15T12:03:20Z';
  await alice.put(SCROBBLE, 'x1', {
    $type: SCROBBLE,
    artist: 'Radiohead',
    track: 'Reckoner',
    listenedAt: at,
    createdAt: at,
  });
  expect(await apply(db, alice, 'x1')).toBe('applied');
  expect(db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)!.n).toBe(8);
}

/** The buckets with listens, as [label, count]; and the number of buckets. */
function nonEmpty(r: ReturnType<typeof listeningActivity>) {
  return r!.buckets.filter((b) => b.count > 0).map((b) => [b.label, b.count]);
}

describe('listening activity', () => {
  it('listening-activity and daily-activity counts for the fixture equal the hand-computed UTC buckets', async () => {
    await withMigratedDb(async (db) => {
      await seedAlice(db);
      const m = { db, clock: fixedClock() };

      // week: the previous Monday week and the one before, by day.
      const week = listeningActivity(m, { did: ALICE, range: 'week' })!;
      expect(week.buckets).toHaveLength(14);
      expect(week.buckets[0]).toEqual({
        fromMs: Date.parse('2025-12-29T00:00:00Z'),
        toMs: Date.parse('2025-12-30T00:00:00Z'),
        label: 'Monday 29 December 2025',
        count: 0,
      });
      expect(week.buckets.at(-1)!.label).toBe('Sunday 11 January 2026');
      expect(nonEmpty(week)).toEqual([['Thursday 08 January 2026', 1]]);

      // this_week: Monday 5 January to now; x1 lies after now and does not count.
      const thisWeek = listeningActivity(m, { did: ALICE, range: 'this_week' })!;
      expect(thisWeek.buckets).toHaveLength(11);
      expect(nonEmpty(thisWeek)).toEqual([
        ['Thursday 08 January 2026', 1],
        ['Wednesday 14 January 2026', 1],
        ['Thursday 15 January 2026', 2],
      ]);

      // month: December 2025 and November 2025, by day.
      const month = listeningActivity(m, { did: ALICE, range: 'month' })!;
      expect(month.buckets).toHaveLength(61);
      expect(nonEmpty(month)).toEqual([['16 December 2025', 1]]);

      // year: 2025 and 2024, by month.
      const year = listeningActivity(m, { did: ALICE, range: 'year' })!;
      expect(year.buckets).toHaveLength(24);
      expect(year.buckets[0]!.label).toBe('January 2024');
      expect(nonEmpty(year)).toEqual([
        ['January 2025', 2],
        ['December 2025', 1],
      ]);

      // this_year: 2025 and January 2026 up to now.
      const thisYear = listeningActivity(m, { did: ALICE, range: 'this_year' })!;
      expect(thisYear.buckets).toHaveLength(13);
      expect(nonEmpty(thisYear)).toEqual([
        ['January 2025', 2],
        ['December 2025', 1],
        ['January 2026', 4],
      ]);

      // all_time: only years with listens.
      const allTime = listeningActivity(m, { did: ALICE, range: 'all_time' })!;
      expect(allTime.buckets.map((b) => [b.label, b.count])).toEqual([
        ['2025', 3],
        ['2026', 4],
      ]);

      // daily-activity over all_time: the 7 × 24 zero-filled UTC grid.
      const daily = dailyActivity(m, { did: ALICE, range: 'all_time' })!;
      expect(Object.keys(daily.activity)).toEqual([
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
      ]);
      const cells = Object.entries(daily.activity).flatMap(([day, hours]) => {
        expect(hours.map((h) => h.hour)).toEqual([...Array(24).keys()]);
        return hours.filter((h) => h.listen_count > 0).map((h) => [day, h.hour, h.listen_count]);
      });
      expect(cells).toEqual([
        ['Tuesday', 11, 1],
        ['Tuesday', 12, 1],
        ['Wednesday', 11, 1],
        ['Wednesday', 12, 1],
        ['Thursday', 11, 2],
        ['Thursday', 12, 1],
      ]);
      const weekDaily = dailyActivity(m, { did: ALICE, range: 'week' })!;
      const weekCells = Object.entries(weekDaily.activity).flatMap(([day, hours]) =>
        hours.filter((h) => h.listen_count > 0).map((h) => [day, h.hour, h.listen_count]),
      );
      expect(weekCells).toEqual([['Thursday', 12, 1]]);

      // Once now passes x1 it counts (Thursday 12h, 2026, 15 January).
      m.clock.set('2026-01-15T12:05:00Z');
      expect(listeningActivity(m, { did: ALICE, range: 'all_time' })!.buckets.map((b) => b.count)).toEqual([3, 5]);
      expect(dailyActivity(m, { did: ALICE, range: 'all_time' })!.activity.Thursday[12]!.listen_count).toBe(2);

      // Unknown users have no activity.
      expect(listeningActivity(m, { did: CAROL, range: 'week' })).toBeNull();
      expect(dailyActivity(m, { did: CAROL, range: 'week' })).toBeNull();
    });
  });
});
