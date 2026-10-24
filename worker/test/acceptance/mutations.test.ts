// W6-01 mutation acceptance (ADR 0004 §10.3 "Mutations"; TESTING.md "Mutation
// expectations"). Proves M3.3.3/read_model_removal, M4.3.2/follow_change,
// M4.4.1/independent_mutation, M5.1.3/update_artist, M5.3.3/unfollow_target,
// M5.4.2/social_acceptance and M5.4.2/mutation_acceptance.
//
// Every mutation is a real signed commit on the owner's fake PDS (createRecord
// / deleteRecord as the SPA outbox would send them, or a commit by another
// app straight into the repository), which reaches the real IndexDO only as a
// fake Jetstream event: the production drain fetches the getRecord proof,
// verifies it and applies it. Account deactivation is detected by stepping
// the production status-sweep timer (A17). Expected values are hardcoded from
// TESTING.md; each step asserts HTTP status and schema, DO tables and the
// fixture network's call counts.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  ALICE,
  AS_OF,
  BOB,
  CAROL,
  FOLLOW,
  GET_RECORD,
  inSocket,
  rkeyOf,
  SCROBBLE,
  type Seeded,
  seedAcceptance,
  uriOf,
} from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const rkeys = (body: Json): string[] => (body.items as Array<{ uri: string }>).map((s) => rkeyOf(s.uri));
const enc = encodeURIComponent;
const GLOBAL_FEED = ['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

function dueOf(db: Db, name: string): number | null {
  return db.one<{ due_at: number }>('SELECT due_at FROM timers WHERE name = ?', name)?.due_at ?? null;
}

async function stats(a: Seeded, did: string, window = 'all'): Promise<Json> {
  const r = await a.request(`/api/v1/users/${did}/stats?window=${window}&limit=100`);
  expect(r.status).toBe(200);
  return r.body;
}

async function history(a: Seeded, did: string): Promise<string[]> {
  const r = await a.request(`/api/v1/users/${did}/scrobbles?limit=100`);
  expect(r.status).toBe(200);
  return rkeys(r.body);
}

async function feed(a: Seeded, query: string): Promise<string[]> {
  const r = await a.request(`/api/v1/feed?${query}&limit=100`);
  expect(r.status).toBe(200);
  return rkeys(r.body);
}

async function counts(a: Seeded, did: string): Promise<[number, number]> {
  const r = await a.request(`/api/v1/users/${did}/profile`);
  expect(r.status).toBe(200);
  return [(r.body as Json).followerCount, (r.body as Json).followingCount];
}

const hints = (db: Db) => db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n ?? 0;

/**
 * Run the drain for the hints the socket just queued: an alarm at the current
 * instant, then (when an earlier drain of this instance started less than 2 s
 * ago, the drain floor) alarms 2 s apart until no hint remains.
 */
async function drainNow(a: Seeded): Promise<void> {
  expect(await a.inDo(hints)).toBeGreaterThan(0);
  expect(await a.alarm()).toBe(true);
  await a.alarmsUntil((db) => hints(db) === 0, { max: 3 });
}

describe('mutation acceptance', () => {
  it('delete r01 → 6/6/3, Homogenic 1, history r07,r02,…', async () => {
    const a = await seedAcceptance('delete-r01');
    const r01 = a.seed.records.get(uriOf(ALICE, 'r01'));
    if (r01 === undefined) throw new Error('no r01');

    // The SPA's delete: deleteRecord with swapRecord on Alice's own PDS.
    const deleted = await inSocket(a, () => a.kit.deleteRecord('Alice', SCROBBLE, 'r01', r01.cid));
    const rev = deleted.commit?.rev;
    expect(await a.inDo((db) => db.all('SELECT uri, source FROM hints'))).toEqual([
      { uri: uriOf(ALICE, 'r01'), source: 'jetstream' },
    ]);
    await drainNow(a);
    expect(a.kit.clock.nowMs()).toBe(Date.parse(AS_OF));

    // DO state: the row is gone, the URI is verified absent at the deleting revision.
    const after = await a.inDo((db) => ({
      row: db.one('SELECT uri FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r01')),
      state: db.one('SELECT state, revision FROM record_state WHERE uri = ?', uriOf(ALICE, 'r01')),
      alice: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)?.n,
    }));
    expect(after).toEqual({ row: null, state: { state: 'absent', revision: rev }, alice: 6 });
    // One proof fetch (an exclusion proof), and the one app write of this test.
    expect(a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(1);
    expect(a.kit.pds.Alice.calls.count({ nsid: 'com.atproto.repo.deleteRecord' })).toBe(1);
    expect(a.kit.pds.Alice.calls.entries.length).toBe(2);
    expect(a.kit.pds.Bob.calls.entries.length + a.kit.pds.Carol.calls.entries.length).toBe(0);

    // 6 listens, 6 tracks, 3 artists; Homogenic 1.
    const all = await stats(a, ALICE);
    expect([all.totalScrobbles, all.distinctTracks, all.distinctArtists]).toEqual([6, 6, 3]);
    expect(all.topAlbums.map((x: Json) => [x.album, x.scrobbleCount])).toEqual([
      ['OK Computer', 2],
      [' HOMOGENIC ', 1],
      ['Hounds of Love', 1],
      ['In Rainbows', 1],
    ]);
    // Display spelling now comes from r02, the newest (only) record of its group.
    expect(all.topArtists.map((x: Json) => [x.artist, x.scrobbleCount])).toEqual([
      ['Radiohead', 3],
      ['Kate Bush', 2],
      ['  BJÖRK  ', 1],
    ]);
    expect(await history(a, ALICE)).toEqual(['r07', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(await feed(a, 'scope=global')).toEqual(['r09', 'r10', 'r07', 'r02', 'r03', 'r04', 'r05', 'r06']);
    // The record lookup and record status agree.
    const lookup = await a.request(`/api/v1/scrobbles/${enc(uriOf(ALICE, 'r01'))}`);
    expect(lookup.status).toBe(404);
    const status = await a.request(`/api/v1/records/status?uri=${enc(uriOf(ALICE, 'r01'))}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ uri: uriOf(ALICE, 'r01'), state: 'absent', revision: rev });
  });

  it('r03 artist→Björk → Björk 3, Kate Bush 2, Radiohead 2, total 7', async () => {
    const a = await seedAcceptance('r03-artist');
    const before = await a.inDo((db) =>
      db.one<{ cid: string; artist_key: string; track_key: string }>(
        'SELECT cid, artist_key, track_key FROM scrobbles WHERE uri = ?',
        uriOf(ALICE, 'r03'),
      ),
    );
    expect(before).toMatchObject({ artist_key: 'radiohead', track_key: 'weird fishes' });

    // Another app updates r03 in Alice's repository (an independent mutation).
    const commit = await inSocket(a, () =>
      a.kit.externalPut('Alice', SCROBBLE, 'r03', {
        $type: SCROBBLE,
        artist: 'Björk',
        track: 'Weird Fishes',
        listenedAt: '2026-01-08T12:00:00Z',
        createdAt: '2026-01-08T12:00:00Z',
        album: 'In Rainbows',
      }),
    );
    expect(commit.ops.map((o) => [o.action, o.rkey])).toEqual([['update', 'r03']]);
    await drainNow(a);

    const row = await a.inDo((db) => ({
      r03: db.one<{ cid: string }>(
        'SELECT cid, revision, artist, artist_key, track_key FROM scrobbles WHERE uri = ?',
        uriOf(ALICE, 'r03'),
      ),
      alice: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)?.n,
    }));
    expect(row).toEqual({
      r03: {
        cid: commit.ops[0]?.cid,
        revision: commit.rev,
        artist: 'Björk',
        artist_key: 'björk',
        track_key: 'weird fishes',
      },
      alice: 7,
    });
    expect(row.r03?.cid).not.toBe(before?.cid);
    expect(a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(1);
    expect(a.kit.transport.calls.count({ service: 'pds' })).toBe(1);

    const all = await stats(a, ALICE);
    expect([all.totalScrobbles, all.distinctArtists, all.distinctTracks]).toEqual([7, 3, 6]);
    expect(all.topArtists).toEqual([
      { artist: 'Björk', scrobbleCount: 3 },
      { artist: 'Kate Bush', scrobbleCount: 2 },
      { artist: 'Radiohead', scrobbleCount: 2 },
    ]);
    // The track identity moved to Björk; no extra listen was inserted.
    expect(all.topTracks).toEqual([
      { artist: 'Björk', track: 'Jóga', scrobbleCount: 2 },
      { artist: 'Björk', track: 'Weird Fishes', scrobbleCount: 1 },
      { artist: 'Kate Bush', track: 'Cloudbusting', scrobbleCount: 1 },
      { artist: 'Kate Bush', track: 'Running Up That Hill', scrobbleCount: 1 },
      { artist: 'Radiohead', track: 'Karma Police', scrobbleCount: 1 },
      { artist: 'Radiohead', track: 'No Surprises', scrobbleCount: 1 },
    ]);
    expect(all.topAlbums).toEqual([
      { artist: 'Björk', album: 'Homogenic', scrobbleCount: 2 },
      { artist: 'Radiohead', album: 'OK Computer', scrobbleCount: 2 },
      { artist: 'Björk', album: 'In Rainbows', scrobbleCount: 1 },
      { artist: 'Kate Bush', album: 'Hounds of Love', scrobbleCount: 1 },
    ]);
    expect(await history(a, ALICE)).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
  });

  it('remove Alice→Bob → following feed empty; global unchanged', async () => {
    const a = await seedAcceptance('unfollow');
    const rkey = await followRkey(BOB);
    const followUri = uriOf(ALICE, rkey, FOLLOW);
    const follow = a.seed.records.get(followUri);
    if (follow === undefined) throw new Error('no follow');
    expect(await feed(a, `scope=following&viewer=${enc(ALICE)}`)).toEqual(['r09']);
    expect(await counts(a, ALICE)).toEqual([0, 1]);
    expect(await counts(a, BOB)).toEqual([1, 0]);

    // The SPA's unfollow: deleteRecord of the follow record with swapRecord.
    const deleted = await inSocket(a, () => a.kit.deleteRecord('Alice', FOLLOW, rkey, follow.cid));
    await drainNow(a);
    const tables = await a.inDo((db) => ({
      follows: db.all('SELECT uri FROM follows'),
      state: db.one('SELECT state, revision FROM record_state WHERE uri = ?', followUri),
      scrobbles: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')?.n,
    }));
    expect(tables).toEqual({ follows: [], state: { state: 'absent', revision: deleted.commit?.rev }, scrobbles: 9 });
    expect(a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(1);
    expect(a.kit.pds.Bob.calls.entries).toEqual([]);

    expect(await feed(a, `scope=following&viewer=${enc(ALICE)}`)).toEqual([]);
    expect(await feed(a, 'scope=global')).toEqual(GLOBAL_FEED);
    expect(await history(a, BOB)).toEqual(['r09']);
    expect(await counts(a, ALICE)).toEqual([0, 0]);
    expect(await counts(a, BOB)).toEqual([0, 0]);
    const following = await a.request(`/api/v1/users/${ALICE}/following`);
    expect(following.status).toBe(200);
    expect((following.body as Json).items).toEqual([]);
  });

  it('Carol→Bob duplicates 2, then 2, then 1', async () => {
    const a = await seedAcceptance('duplicates');
    const follow = (createdAt: string) => ({ $type: FOLLOW, subject: BOB, createdAt });
    // Two external Carol→Bob follow records under non-deterministic rkeys.
    await inSocket(a, async () => {
      await a.kit.externalPut('Carol', FOLLOW, '3lcarolbob001', follow('2026-01-15T11:50:00Z'));
      await a.kit.externalPut('Carol', FOLLOW, '3lcarolbob002', follow('2026-01-15T11:51:00Z'));
    });
    await drainNow(a);
    const d1 = uriOf(CAROL, '3lcarolbob001', FOLLOW);
    const d2 = uriOf(CAROL, '3lcarolbob002', FOLLOW);
    const rows = (db: Db) =>
      db.all<{ uri: string }>('SELECT uri FROM follows WHERE subject = ? ORDER BY uri', BOB).map((r) => r.uri);
    const aliceEdge = uriOf(ALICE, await followRkey(BOB), FOLLOW);
    expect(await a.inDo(rows)).toEqual([aliceEdge, d1, d2]);
    expect(a.kit.pds.Carol.calls.count({ nsid: GET_RECORD })).toBe(2);

    const followers = async () => {
      const r = await a.request(`/api/v1/users/${BOB}/followers`);
      expect(r.status).toBe(200);
      return (r.body as Json).items.map((f: Json) => [f.actor, f.uri]);
    };
    // Three records, two edges: Carol's edge is represented by her smallest URI.
    expect(await counts(a, BOB)).toEqual([2, 0]);
    expect(await counts(a, CAROL)).toEqual([0, 1]);
    expect(await followers()).toEqual([
      [CAROL, d1],
      [ALICE, aliceEdge],
    ]);

    // Delete one duplicate: still 2, now represented by the other record.
    await inSocket(a, () => a.kit.externalDelete('Carol', FOLLOW, '3lcarolbob001'));
    await drainNow(a);
    expect(await a.inDo(rows)).toEqual([aliceEdge, d2]);
    expect(await counts(a, BOB)).toEqual([2, 0]);
    expect(await followers()).toEqual([
      [CAROL, d2],
      [ALICE, aliceEdge],
    ]);

    // Delete the other: back to 1.
    await inSocket(a, () => a.kit.externalDelete('Carol', FOLLOW, '3lcarolbob002'));
    await drainNow(a);
    expect(await a.inDo(rows)).toEqual([aliceEdge]);
    expect(await counts(a, BOB)).toEqual([1, 0]);
    expect(await counts(a, CAROL)).toEqual([0, 0]);
    expect(await followers()).toEqual([[ALICE, aliceEdge]]);
    // Two proof fetches per step (a present proof each, then an exclusion proof each); no app write.
    expect(a.kit.pds.Carol.calls.count({ nsid: GET_RECORD })).toBe(4);
    expect(a.kit.pds.Carol.calls.count({ nsid: 'com.atproto.repo.createRecord' })).toBe(0);
  });

  it('deactivate Alice hides her; reactivation current only after snapshot', async () => {
    const a = await seedAcceptance('deactivate');
    const sweepAt = await a.inDo((db) => dueOf(db, 'status-sweep'));
    expect(sweepAt).not.toBeNull();

    // Alice's PDS deactivates her; the next hourly status sweep notices (A17).
    a.kit.pds.Alice.deactivate(ALICE);
    a.kit.clock.set(new Date(sweepAt as number).toISOString());
    expect(await a.alarm()).toBe(true);
    const hidden = await a.inDo((db) => ({
      users: db.all('SELECT did, active, indexing_state FROM users ORDER BY did'),
      alice: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)?.n,
      follows: db.one<{ n: number }>('SELECT count(*) AS n FROM follows')?.n,
    }));
    expect(hidden.users).toEqual([
      { did: ALICE, active: 0, indexing_state: 'recovering' },
      { did: BOB, active: 1, indexing_state: 'current' },
      { did: CAROL, active: 1, indexing_state: 'current' },
    ]);
    // Hidden, not deleted: the rows stay stored.
    expect([hidden.alice, hidden.follows]).toEqual([7, 1]);
    expect(a.kit.pds.Alice.calls.count({ nsid: 'com.atproto.sync.getRepoStatus' })).toBe(1);

    const profile = await a.request(`/api/v1/users/${ALICE}/profile`);
    expect(profile.status).toBe(404);
    expect(await history(a, ALICE)).toEqual([]);
    expect(await feed(a, 'scope=global')).toEqual(['r09', 'r10']);
    expect(await feed(a, `scope=following&viewer=${enc(ALICE)}`)).toEqual([]);
    // Her follow edge is hidden; Bob's and Carol's records remain.
    expect(await counts(a, BOB)).toEqual([0, 0]);
    expect(await history(a, BOB)).toEqual(['r09']);
    expect(await history(a, CAROL)).toEqual(['r10']);
    expect((await a.request(`/api/v1/users/${ALICE}/export`)).status).toBe(404);

    // Reactivation: the next sweep sees her active again and schedules a snapshot;
    // she stays hidden until that snapshot completes.
    a.kit.pds.Alice.reactivate(ALICE);
    const nextSweep = await a.inDo((db) => dueOf(db, 'status-sweep'));
    a.kit.clock.set(new Date(nextSweep as number).toISOString());
    expect(await a.alarm()).toBe(true);
    const pending = await a.inDo((db) => ({
      user: db.one('SELECT active, indexing_state FROM users WHERE did = ?', ALICE),
      jobs: db.all(
        "SELECT did, state, reactivate FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')",
      ),
    }));
    expect(pending).toEqual({
      user: { active: 0, indexing_state: 'recovering' },
      jobs: [{ did: ALICE, state: 'pending', reactivate: 1 }],
    });
    expect((await a.request(`/api/v1/users/${ALICE}/profile`)).status).toBe(404);
    expect(await feed(a, 'scope=global')).toEqual(['r09', 'r10']);
    const status = await a.request(`/api/v1/records/status?uri=${enc(uriOf(ALICE, 'r01'))}`);
    expect(status.body).toMatchObject({ state: 'pending', indexing: { state: 'recovering' } });

    a.kit.resetCalls();
    await a.alarmsUntil((db) => db.one('SELECT 1 AS x FROM users WHERE did = ? AND active = 1', ALICE) !== null);
    // The reactivation snapshot verified her current signed head before she reappeared.
    expect(a.kit.pds.Alice.calls.count({ nsid: 'com.atproto.sync.getLatestCommit' })).toBe(1);
    expect(a.kit.pds.Alice.calls.count({ nsid: 'com.atproto.sync.getBlocks' })).toBeGreaterThan(0);
    expect(await a.inDo((db) => db.one('SELECT active, indexing_state FROM users WHERE did = ?', ALICE))).toEqual({
      active: 1,
      indexing_state: 'current',
    });
    const back = await a.request(`/api/v1/users/${ALICE}/profile`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      did: ALICE,
      totalScrobbles: 7,
      followingCount: 1,
      indexing: { state: 'current' },
    });
    expect(await history(a, ALICE)).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(await feed(a, 'scope=global')).toEqual(GLOBAL_FEED);
    expect(await counts(a, BOB)).toEqual([1, 0]);
  });
});
