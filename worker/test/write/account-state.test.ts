// W2-04: account state transitions (markInactive, markReactivating) against
// real DO SQLite, observed through the readers' visibility fragments.

import { runInDurableObject } from 'cloudflare:test';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { activeUser, visibleFollowEdge, visibleScrobblesFrom } from '../../src/do/read/visibility';
import { markInactive, markReactivating } from '../../src/do/write/account-state';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { completeSnapshot } from '../../src/do/write/apply-snapshot';
import type { HarnessDO } from '../harness/harness-do';
import {
  ALICE,
  BOB,
  CAROL,
  dump,
  FOLLOW,
  fixtureScrobble,
  follow,
  NOW_MS,
  NOW_NS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  seedUser,
  stubFor,
  uriOf,
  userRow,
} from './support';

/** The profile reader's gate: a visible users row, else 404 before any identity request. */
function profile(db: Db, did: string): { did: string } | null {
  return db.one(`SELECT u.did FROM users u WHERE u.did = ? AND ${activeUser('u')}`, did);
}

function history(db: Db, did: string): string[] {
  return db
    .all<{ uri: string }>(
      `SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.listened_at DESC, s.uri DESC`,
      did,
    )
    .map((r) => r.uri);
}

function globalFeed(db: Db): string[] {
  return db
    .all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} ORDER BY s.listened_at DESC, s.uri DESC`)
    .map((r) => r.uri);
}

/** Profile counts over distinct visible edges. */
function followCounts(db: Db, did: string): { followers: number; following: number } {
  const followers = db.one<{ n: number }>(
    `SELECT count(DISTINCT f.actor) AS n FROM follows f WHERE f.subject = ? AND ${visibleFollowEdge('f')}`,
    did,
  )!.n;
  const following = db.one<{ n: number }>(
    `SELECT count(DISTINCT f.subject) AS n FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')}`,
    did,
  )!.n;
  return { followers, following };
}

describe('account state', () => {
  it('deactivation hides profile/content/follow edge immediately and bumps generation', async () => {
    const alice = await repoFor('alice');
    const bob = await repoFor('bob');
    const carol = await repoFor('carol');
    const proofs: RecordProof[] = [
      await putProof(alice, SCROBBLE, 'r01', fixtureScrobble('r01')),
      await putProof(alice, SCROBBLE, 'r07', fixtureScrobble('r07')),
      await putProof(alice, FOLLOW, 'fbob', follow(BOB)),
      await putProof(bob, SCROBBLE, 'r09', fixtureScrobble('r09')),
      await putProof(carol, FOLLOW, 'falice', follow(ALICE)),
    ];
    const a01 = uriOf(ALICE, SCROBBLE, 'r01');
    const a07 = uriOf(ALICE, SCROBBLE, 'r07');
    const b09 = uriOf(BOB, SCROBBLE, 'r09');

    await runInDurableObject(stubFor('account-state-deactivate'), (i: HarnessDO) => {
      const db = i.db;
      expect([seedUser(db, ALICE), seedUser(db, BOB), seedUser(db, CAROL)]).toEqual([1, 2, 3]);
      for (const p of proofs) expect(db.tx(() => applyRecordProof(db, p, OPTS)).outcome).toBe('applied');
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
         VALUES (?, 'snapshot', 'pending', 1, 1, ?, ?)`,
        ALICE,
        NOW_MS,
        NOW_MS,
      );

      expect(profile(db, ALICE)).toEqual({ did: ALICE });
      expect(history(db, ALICE)).toEqual([a07, a01]);
      expect(globalFeed(db)).toEqual([b09, a07, a01]);
      expect(followCounts(db, ALICE)).toEqual({ followers: 1, following: 1 });
      expect(followCounts(db, BOB)).toEqual({ followers: 1, following: 0 });
      expect(followCounts(db, CAROL)).toEqual({ followers: 0, following: 1 });

      expect(db.tx(() => markInactive(db, ALICE, 'deactivated'))).toEqual({ changed: true, generation: 4 });

      // Hidden at once, everywhere.
      expect(profile(db, ALICE)).toBeNull();
      expect(history(db, ALICE)).toEqual([]);
      expect(globalFeed(db)).toEqual([b09]);
      expect(followCounts(db, BOB)).toEqual({ followers: 0, following: 0 });
      expect(followCounts(db, CAROL)).toEqual({ followers: 0, following: 0 });
      // Stored, not deleted: deactivation is reversible by a fresh snapshot.
      expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)).toEqual({ n: 2 });
      expect(db.one('SELECT count(*) AS n FROM follows')).toEqual({ n: 2 });
      expect(userRow(db, ALICE)).toMatchObject({
        active: 0,
        account_status: 'deactivated',
        indexing_state: 'recovering',
        generation: 4,
      });
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 4 });
      // Explicit deactivation clears the reactivation intent.
      expect(db.one('SELECT reactivate, generation FROM repo_jobs WHERE did = ?', ALICE)).toEqual({
        reactivate: 0,
        generation: 1,
      });
      // Bob and Carol are untouched.
      expect(userRow(db, BOB)).toMatchObject({ active: 1, generation: 2 });
      expect(userRow(db, CAROL)).toMatchObject({ active: 1, generation: 3 });

      // The snapshot that was in flight (generation 1) can no longer activate her.
      const before = dump(db);
      expect(
        db.tx(() =>
          completeSnapshot(db, {
            did: ALICE,
            generation: 1,
            headRev: proofs[2]!.commit.rev,
            accountActive: true,
            nowNs: NOW_NS,
          }),
        ),
      ).toEqual({ outcome: 'superseded' });
      expect(dump(db)).toEqual(before);
      expect(profile(db, ALICE)).toBeNull();

      // Reactivation stays hidden until a complete snapshot under the current generation.
      expect(db.tx(() => markReactivating(db, ALICE))).toEqual({ changed: true, jobFlagged: true });
      expect(profile(db, ALICE)).toBeNull();
      expect(history(db, ALICE)).toEqual([]);
      expect(userRow(db, ALICE)).toMatchObject({ active: 0, account_status: 'active', generation: 4 });
      expect(db.one('SELECT reactivate FROM repo_jobs WHERE did = ?', ALICE)).toEqual({ reactivate: 1 });
      expect(
        db.tx(() =>
          completeSnapshot(db, {
            did: ALICE,
            generation: 4,
            headRev: proofs[2]!.commit.rev,
            accountActive: true,
            nowNs: NOW_NS,
          }),
        ),
      ).toEqual({ outcome: 'complete', active: true });
      expect(profile(db, ALICE)).toEqual({ did: ALICE });
      expect(history(db, ALICE)).toEqual([a07, a01]);
      expect(followCounts(db, BOB)).toEqual({ followers: 1, following: 0 });

      // Unknown DIDs and non-inactive statuses are refused without writes.
      const unchanged = dump(db);
      expect(db.tx(() => markInactive(db, 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', 'takendown'))).toEqual({
        changed: false,
      });
      expect(() => db.tx(() => markInactive(db, BOB, 'active' as never))).toThrow(RangeError);
      expect(dump(db)).toEqual(unchanged);
    });
  });
});
