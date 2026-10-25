// W2-04: applyRecordProof against real DO SQLite (harness DO with the
// production migrations). Proofs come from real signed repositories
// (support.ts); every expectation below is hardcoded, never computed by the
// code under test.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { visibleScrobblesFrom } from '../../src/do/read/visibility';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../src/do/write/apply-snapshot';
import type { HarnessDO } from '../harness/harness-do';
import {
  ALICE,
  deleteProof,
  dump,
  fixtureScrobble,
  NOW_STORAGE,
  OPTS,
  PREFIX,
  putProof,
  recordState,
  repoFor,
  SCROBBLE,
  scrobble,
  seedSnapshotJob,
  seedUser,
  stubFor,
  uriOf,
  userRow,
} from './support';

const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const APPLIED = { outcome: 'applied', admit: false, suppressed: false };
const NOOP = { outcome: 'noop_older', admit: false, suppressed: false };
const STALE = { outcome: 'stale_head', admit: false, suppressed: false };

function cidOf(proof: RecordProof): string {
  if (proof.state !== 'present') throw new Error('expected a present proof');
  return proof.cid;
}

function apply(db: Db, proof: RecordProof) {
  return db.tx(() => applyRecordProof(db, proof, OPTS));
}

/** Visible history of `did`, newest first (the reader's visibility rule). */
function visibleHistory(db: Db, did: string): string[] {
  return db
    .all<{ uri: string }>(
      `SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.listened_at DESC, s.uri DESC`,
      did,
    )
    .map((r) => r.uri);
}

/** Visible all-time listens per artist key, ordered as top artists are. */
function artistCounts(db: Db, did: string): Array<[string, number]> {
  return db
    .all<{ artist_key: string; c: number }>(
      `SELECT s.artist_key, count(*) AS c FROM ${visibleScrobblesFrom()} WHERE s.did = ?
       GROUP BY s.artist_key ORDER BY c DESC, s.artist_key ASC`,
      did,
    )
    .map((r) => [r.artist_key, r.c]);
}

describe('applyRecordProof', () => {
  it('present valid scrobble inserts row with exact keys and record_state present', async () => {
    const repo = await repoFor('alice');
    // r02 of the shared fixture: untrimmed, upper-case display strings.
    const proof = await putProof(repo, SCROBBLE, 'r02', fixtureScrobble('r02'));
    const uri = uriOf(ALICE, SCROBBLE, 'r02');
    expect(proof.commit.rev).toMatch(TID);

    await runInDurableObject(stubFor('apply-record-present'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, proof)).toEqual(APPLIED);

      expect(db.all('SELECT * FROM scrobbles')).toEqual([
        {
          uri,
          cid: cidOf(proof),
          did: ALICE,
          rkey: 'r02',
          revision: proof.commit.rev,
          artist: '  BJÖRK  ',
          track: 'jóga',
          album: ' HOMOGENIC ',
          listened_at: '2026-01-14T11:00:00.000000000Z',
          created_at: '2026-01-14T11:00:00.000000000Z',
          duration_seconds: null,
          recording_mbid: null,
          indexed_at: '2026-01-15T12:00:00.000000000Z',
          artist_key: 'björk',
          track_key: 'jóga',
          album_key: 'homogenic',
          // Migration 2 columns (ADR 0005 §6.4): NULL until N3-11 projects them.
          album_artist: null,
          album_artist_key: null,
          track_number: null,
          artist_mbids: null,
          release_mbid: null,
          release_group_mbid: null,
          isrc: null,
          submission_client: null,
          music_service: null,
          recording_msid: null,
        },
      ]);
      expect(db.all('SELECT * FROM record_state')).toEqual([
        {
          uri,
          did: ALICE,
          collection: SCROBBLE,
          revision: proof.commit.rev,
          cid: cidOf(proof),
          state: 'present',
          reason: null,
          verified_at: NOW_STORAGE,
        },
      ]);
      expect(userRow(db, ALICE)).toMatchObject({ max_rev: proof.commit.rev, stats_version: 1, active: 1 });
      // The W2-05 writer raised both lastIndexedAt high-water marks in the same tx.
      expect(db.one('SELECT indexed_at FROM users WHERE did = ?', ALICE)).toEqual({ indexed_at: NOW_STORAGE });
      expect(db.one("SELECT last_indexed_at FROM indexing_status WHERE scope = 'global'")).toEqual({
        last_indexed_at: NOW_STORAGE,
      });
      expect(visibleHistory(db, ALICE)).toEqual([uri]);
      expect(db.all('SELECT * FROM counters')).toEqual([]);
    });
  });

  it('older revision proof after newer delete is noop (no resurrection)', async () => {
    const repo = await repoFor('alice');
    const p07 = await putProof(repo, SCROBBLE, 'r07', fixtureScrobble('r07'));
    const p08 = await putProof(repo, SCROBBLE, 'r08', fixtureScrobble('r08'));
    const p08gone = await deleteProof(repo, SCROBBLE, 'r08');
    const head = repo.head!;
    const entries = (await repo.entries()).map((e) => ({ key: e.key, cid: e.cid }));
    expect(entries).toEqual([{ key: `${SCROBBLE}/r07`, cid: cidOf(p07) }]);
    const uri08 = uriOf(ALICE, SCROBBLE, 'r08');
    const stub = stubFor('apply-record-durable-delete');

    await runInDurableObject(stub, (i: HarnessDO) => {
      const db = i.db;
      const generation = seedUser(db, ALICE);
      seedSnapshotJob(db, ALICE, generation);
      expect(apply(db, p07)).toEqual(APPLIED);
      expect(apply(db, p08)).toEqual(APPLIED);
      expect(visibleHistory(db, ALICE)).toEqual([uri08, uriOf(ALICE, SCROBBLE, 'r07')]);

      // The newer deletion arrives through a verified snapshot at the deleting head.
      const chunk = db.tx(() =>
        applySnapshotChunk(db, {
          did: ALICE,
          generation,
          headRev: head.rev,
          intervalLo: `${PREFIX}.`,
          intervalHi: `${PREFIX}/`,
          entries,
          receiptNs: OPTS.receiptNs,
          prefix: PREFIX,
          nowNs: OPTS.nowNs,
        }),
      );
      expect(chunk).toEqual({ outcome: 'applied', written: 0, unchanged: 1, deleted: 1 });
      expect(recordState(db, uri08)).toEqual({
        revision: head.rev,
        cid: null,
        state: 'absent',
        reason: null,
        collection: SCROBBLE,
      });

      // The snapshot raised the per-DID floor to its verified head, so the
      // older present proof is refused (stale_head) and changes nothing.
      expect(userRow(db, ALICE)?.max_rev).toBe(head.rev);
      const before = dump(db);
      expect(p08.commit.rev < head.rev).toBe(true);
      expect(apply(db, p08)).toEqual(STALE);
      expect(dump(db)).toEqual(before);
      expect(visibleHistory(db, ALICE)).toEqual([uriOf(ALICE, SCROBBLE, 'r07')]);
    });

    // Restart: the deletion is durable and still wins.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (i: HarnessDO) => {
      const db = i.db;
      const before = dump(db);
      expect(apply(db, p08)).toEqual(STALE);
      expect(dump(db)).toEqual(before);
      expect(db.all('SELECT uri FROM scrobbles WHERE uri = ?', uri08)).toEqual([]);
      expect(recordState(db, uri08)).toMatchObject({ state: 'absent', revision: head.rev });

      // The live exclusion proof at the deleting head passes the floor and is
      // stopped by the per-URI guard: noop_older.
      expect(p08gone.commit.rev).toBe(head.rev);
      expect(apply(db, p08gone)).toEqual(NOOP);
      expect(dump(db)).toEqual(before);
    });

    // Live path: once a newer exclusion proof is applied, the per-DID floor
    // refuses the older present proof before the per-URI guard is reached.
    const repo2 = await repoFor('alice');
    const q08 = await putProof(repo2, SCROBBLE, 'r08', fixtureScrobble('r08'));
    const q08gone = await deleteProof(repo2, SCROBBLE, 'r08');
    await runInDurableObject(stubFor('apply-record-durable-delete-live'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, q08)).toEqual(APPLIED);
      expect(apply(db, q08gone)).toEqual({ outcome: 'absent', admit: false, suppressed: false });
      const before = dump(db);
      expect(apply(db, q08)).toEqual(STALE);
      expect(dump(db)).toEqual(before);
      expect(visibleHistory(db, ALICE)).toEqual([]);
    });
  });

  it('proof rev below users.max_rev returns stale_head and changes nothing', async () => {
    const repo = await repoFor('alice');
    const p01 = await putProof(repo, SCROBBLE, 'r01', fixtureScrobble('r01'));
    const p02 = await putProof(repo, SCROBBLE, 'r02', fixtureScrobble('r02'));
    expect(p01.commit.rev < p02.commit.rev).toBe(true);

    await runInDurableObject(stubFor('apply-record-stale-head'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, p02)).toEqual(APPLIED);
      expect(userRow(db, ALICE)?.max_rev).toBe(p02.commit.rev);

      const before = dump(db);
      expect(apply(db, p01)).toEqual(STALE);
      expect(dump(db)).toEqual(before);
      expect(db.all('SELECT uri FROM scrobbles ORDER BY uri')).toEqual([{ uri: uriOf(ALICE, SCROBBLE, 'r02') }]);
      expect(recordState(db, uriOf(ALICE, SCROBBLE, 'r01'))).toBeNull();
      expect(userRow(db, ALICE)).toMatchObject({ max_rev: p02.commit.rev, stats_version: 1 });
    });
  });

  it('invalid remote record is excluded with reason and not visible', async () => {
    const repo = await repoFor('alice');
    const valid = await putProof(repo, SCROBBLE, 'r03', fixtureScrobble('r03'));
    const blank = await putProof(repo, SCROBBLE, 'r03', { ...fixtureScrobble('r03'), artist: ' 　 ' });
    // 301 s after the hint receipt time (2026-01-15T12:00:00Z).
    const future = await putProof(
      repo,
      SCROBBLE,
      'x01',
      scrobble({ artist: 'A', track: 'B', listenedAt: '2026-01-15T12:05:01Z' }),
    );
    const ok = await putProof(repo, SCROBBLE, 'r07', fixtureScrobble('r07'));
    const r03 = uriOf(ALICE, SCROBBLE, 'r03');
    const x01 = uriOf(ALICE, SCROBBLE, 'x01');
    const blankReason =
      'artist: expected 1–256 Unicode scalars and at most 1024 UTF-8 bytes, with nonempty trimmed text';
    const futureReason = 'listenedAt: timestamp must be between 1970-01-01 and receipt time plus 300 seconds';

    await runInDurableObject(stubFor('apply-record-excluded'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, valid)).toEqual(APPLIED);
      expect(visibleHistory(db, ALICE)).toEqual([r03]);

      // An update to an invalid body removes the listen and records why.
      expect(apply(db, blank)).toEqual({ outcome: 'excluded', reason: blankReason, admit: false, suppressed: false });
      expect(db.all('SELECT uri FROM scrobbles WHERE uri = ?', r03)).toEqual([]);
      expect(recordState(db, r03)).toEqual({
        revision: blank.commit.rev,
        cid: cidOf(blank),
        state: 'excluded',
        reason: blankReason,
        collection: SCROBBLE,
      });

      // A malformed record that never was valid never reaches the projection.
      expect(apply(db, future)).toEqual({ outcome: 'excluded', reason: futureReason, admit: false, suppressed: false });
      expect(db.all('SELECT uri FROM scrobbles WHERE uri = ?', x01)).toEqual([]);
      expect(recordState(db, x01)).toMatchObject({ state: 'excluded', reason: futureReason, cid: cidOf(future) });

      expect(apply(db, ok)).toEqual(APPLIED);
      expect(visibleHistory(db, ALICE)).toEqual([uriOf(ALICE, SCROBBLE, 'r07')]);
      expect(db.all('SELECT name, label, value FROM counters ORDER BY label')).toEqual([
        { name: 'excluded', label: blankReason, value: 1 },
        { name: 'excluded', label: futureReason, value: 1 },
      ]);
      // valid insert, delete on exclusion, r07 insert; the never-valid x01 changed no row.
      expect(userRow(db, ALICE)).toMatchObject({ stats_version: 3, max_rev: ok.commit.rev });
    });
  });

  it('r03 artist change updates keys without inserting a second listen', async () => {
    const repo = await repoFor('alice');
    const seeds: RecordProof[] = [];
    for (const rkey of ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07']) {
      seeds.push(await putProof(repo, SCROBBLE, rkey, fixtureScrobble(rkey)));
    }
    const changed = await putProof(repo, SCROBBLE, 'r03', { ...fixtureScrobble('r03'), artist: 'Björk' });
    const r03 = uriOf(ALICE, SCROBBLE, 'r03');

    await runInDurableObject(stubFor('apply-record-r03-artist'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      for (const p of seeds) expect(apply(db, p)).toEqual(APPLIED);
      expect(artistCounts(db, ALICE)).toEqual([
        ['radiohead', 3],
        ['björk', 2],
        ['kate bush', 2],
      ]);
      expect(userRow(db, ALICE)?.stats_version).toBe(7);

      expect(apply(db, changed)).toEqual(APPLIED);
      expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)).toEqual({ n: 7 });
      expect(
        db.one('SELECT cid, revision, artist, artist_key, track_key, album_key FROM scrobbles WHERE uri = ?', r03),
      ).toEqual({
        cid: cidOf(changed),
        revision: changed.commit.rev,
        artist: 'Björk',
        artist_key: 'björk',
        track_key: 'weird fishes',
        album_key: 'in rainbows',
      });
      expect(artistCounts(db, ALICE)).toEqual([
        ['björk', 3],
        ['kate bush', 2],
        ['radiohead', 2],
      ]);
      expect(recordState(db, r03)).toMatchObject({
        state: 'present',
        revision: changed.commit.rev,
        cid: cidOf(changed),
      });
      expect(userRow(db, ALICE)?.stats_version).toBe(8);
    });
  });

  it('applying the same revision twice changes nothing and a newer revision replaces the payload with one listen', async () => {
    const repo = await repoFor('alice');
    const first = await putProof(repo, SCROBBLE, 'r05', fixtureScrobble('r05'));
    const newer = await putProof(repo, SCROBBLE, 'r05', {
      ...fixtureScrobble('r05'),
      track: 'Running Up That Hill (A Deal with God)',
      durationSeconds: 300,
    });
    const uri = uriOf(ALICE, SCROBBLE, 'r05');

    await runInDurableObject(stubFor('apply-record-same-rev'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, first)).toEqual(APPLIED);
      const before = dump(db);
      expect(apply(db, first)).toEqual(NOOP);
      expect(dump(db)).toEqual(before);
      expect(userRow(db, ALICE)?.stats_version).toBe(1);

      expect(apply(db, newer)).toEqual(APPLIED);
      expect(db.all('SELECT uri, cid, revision, track, track_key, duration_seconds FROM scrobbles')).toEqual([
        {
          uri,
          cid: cidOf(newer),
          revision: newer.commit.rev,
          track: 'Running Up That Hill (A Deal with God)',
          track_key: 'running up that hill (a deal with god)',
          duration_seconds: 300,
        },
      ]);
      expect(visibleHistory(db, ALICE)).toEqual([uri]);
      expect(artistCounts(db, ALICE)).toEqual([['kate bush', 1]]);
      expect(userRow(db, ALICE)).toMatchObject({ stats_version: 2, max_rev: newer.commit.rev });

      // Re-delivery of either proof afterwards changes nothing.
      const after = dump(db);
      expect(apply(db, newer)).toEqual(NOOP);
      expect(apply(db, first)).toEqual(STALE);
      expect(dump(db)).toEqual(after);
    });
  });

  it('two records with identical track and listenedAt under different rkeys are two rows and two listens', async () => {
    const repo = await repoFor('alice');
    const body = scrobble({ artist: 'Kate Bush', track: 'Cloudbusting', listenedAt: '2026-01-15T10:00:00Z' });
    const k1 = await putProof(repo, SCROBBLE, '3lb2aaaaaaaa2', body);
    const k2 = await putProof(repo, SCROBBLE, '3lb2aaaaaaaa3', body);
    // Identical record bytes: the same CID, two distinct records.
    expect(cidOf(k1)).toBe(cidOf(k2));
    const u1 = uriOf(ALICE, SCROBBLE, '3lb2aaaaaaaa2');
    const u2 = uriOf(ALICE, SCROBBLE, '3lb2aaaaaaaa3');

    await runInDurableObject(stubFor('apply-record-same-time'), (i: HarnessDO) => {
      const db = i.db;
      seedUser(db, ALICE);
      expect(apply(db, k1)).toEqual(APPLIED);
      expect(apply(db, k2)).toEqual(APPLIED);
      expect(db.all('SELECT uri, cid, listened_at, artist_key, track_key FROM scrobbles ORDER BY uri')).toEqual([
        {
          uri: u1,
          cid: cidOf(k1),
          listened_at: '2026-01-15T10:00:00.000000000Z',
          artist_key: 'kate bush',
          track_key: 'cloudbusting',
        },
        {
          uri: u2,
          cid: cidOf(k1),
          listened_at: '2026-01-15T10:00:00.000000000Z',
          artist_key: 'kate bush',
          track_key: 'cloudbusting',
        },
      ]);
      expect(
        db.all(
          `SELECT s.artist_key, s.track_key, count(*) AS c FROM ${visibleScrobblesFrom()} WHERE s.did = ?
           GROUP BY s.artist_key, s.track_key`,
          ALICE,
        ),
      ).toEqual([{ artist_key: 'kate bush', track_key: 'cloudbusting', c: 2 }]);
      expect(visibleHistory(db, ALICE)).toEqual([u2, u1]);
      expect(userRow(db, ALICE)?.stats_version).toBe(2);
    });
  });
});
