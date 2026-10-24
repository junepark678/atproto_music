// W2-04: applySnapshotChunk / completeSnapshot against real DO SQLite. The
// chunks carry entries enumerated from real signed repositories at a fixed
// head (SignedRepo.entries), the same (key, cid) list the W3-05 walker emits.

import { runInDurableObject } from 'cloudflare:test';
import type { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { visibleScrobblesFrom } from '../../src/do/read/visibility';
import { markInactive } from '../../src/do/write/account-state';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { applySnapshotChunk, completeSnapshot, type SnapshotChunkEntry } from '../../src/do/write/apply-snapshot';
import type { HarnessDO } from '../harness/harness-do';
import {
  ALICE,
  BOB,
  deleteProof,
  dump,
  FOLLOW,
  fixtureScrobble,
  follow,
  NOW_MS,
  NOW_NS,
  OPTS,
  PREFIX,
  putProof,
  recordState,
  repoFor,
  SCROBBLE,
  SETTINGS,
  scrobble,
  seedUser,
  settings,
  stubFor,
  uriOf,
  userRow,
} from './support';

const RANGE_LO = `${PREFIX}.`;
const RANGE_HI = `${PREFIX}/`;
const APPLIED = { outcome: 'applied', admit: false, suppressed: false };

function cidOf(proof: RecordProof): string {
  if (proof.state !== 'present') throw new Error('expected a present proof');
  return proof.cid;
}

/** (key, cid) entries at commit `at`, with bodies only for `withBody` keys (what the walker fetched). */
async function entriesAt(repo: SignedRepo, at: string, withBody: (key: string) => boolean) {
  const out: SnapshotChunkEntry[] = [];
  for (const e of await repo.entries({ at })) {
    if (!withBody(e.key)) {
      out.push({ key: e.key, cid: e.cid });
      continue;
    }
    const slash = e.key.indexOf('/');
    const rec = await repo.getRecord(e.key.slice(0, slash), e.key.slice(slash + 1), { at });
    out.push({ key: e.key, cid: e.cid, record: rec!.value });
  }
  return out;
}

function chunk(db: Db, generation: number, headRev: string, lo: string, hi: string, entries: SnapshotChunkEntry[]) {
  return db.tx(() =>
    applySnapshotChunk(db, {
      did: ALICE,
      generation,
      headRev,
      intervalLo: lo,
      intervalHi: hi,
      entries: entries.filter((e) => e.key > lo && e.key <= hi),
      receiptNs: NOW_NS,
      prefix: PREFIX,
      nowNs: NOW_NS,
    }),
  );
}

function rows(db: Db): Array<{ uri: string; cid: string; revision: string }> {
  return db.all('SELECT uri, cid, revision FROM scrobbles ORDER BY uri');
}

describe('applySnapshotChunk', () => {
  it('chunk deletes rows absent from interval only when revision < headRev', async () => {
    const repo = await repoFor('alice');
    const live: RecordProof[] = [];
    live.push(await putProof(repo, FOLLOW, 'fbob', follow(BOB)));
    for (const rkey of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      live.push(await putProof(repo, SCROBBLE, rkey, scrobble({ artist: 'Kate Bush', track: rkey })));
    }
    // The repository moves on: a2 and the follow are deleted, a6 is created (head H).
    await repo.delete(SCROBBLE, 'a2');
    await repo.delete(FOLLOW, 'fbob');
    await repo.put(SCROBBLE, 'a6', scrobble({ artist: 'Kate Bush', track: 'a6' }));
    const head = repo.head!;
    // a7 is newer than H and arrives live before the snapshot chunks.
    const a7 = await putProof(repo, SCROBBLE, 'a7', scrobble({ artist: 'Kate Bush', track: 'a7' }));
    expect(head.rev < a7.commit.rev).toBe(true);
    // The walker fetched a4..a6 (say, a cold cache) but not a1 and a3; a4 and
    // a5 carry the CID already stored, so they are skipped all the same.
    const entries = await entriesAt(repo, head.cid, (key) => key > `${SCROBBLE}/a3`);
    expect(entries.map((e) => e.key)).toEqual(['a1', 'a3', 'a4', 'a5', 'a6'].map((r) => `${SCROBBLE}/${r}`));
    const u = (rkey: string) => uriOf(ALICE, SCROBBLE, rkey);

    await runInDurableObject(stubFor('apply-snapshot-sweep'), (i: HarnessDO) => {
      const db = i.db;
      const generation = seedUser(db, ALICE, { active: false });
      for (const p of [...live, a7]) expect(db.tx(() => applyRecordProof(db, p, OPTS))).toEqual(APPLIED);
      expect(userRow(db, ALICE)?.stats_version).toBe(6);

      // Chunk 1: (<p>., scrobble/a3]. The follow and a2 are gone at H; a4 and a5
      // lie outside this interval and stay although chunk 1 does not list them.
      expect(chunk(db, generation, head.rev, RANGE_LO, `${SCROBBLE}/a3`, entries)).toEqual({
        outcome: 'applied',
        written: 0,
        unchanged: 2,
        deleted: 2,
      });
      expect(rows(db).map((r) => r.uri)).toEqual([u('a1'), u('a3'), u('a4'), u('a5'), u('a7')]);
      expect(db.all('SELECT uri FROM follows')).toEqual([]);
      expect(recordState(db, u('a2'))).toEqual({
        revision: head.rev,
        cid: null,
        state: 'absent',
        reason: null,
        collection: SCROBBLE,
      });
      expect(recordState(db, uriOf(ALICE, FOLLOW, 'fbob'))).toMatchObject({ state: 'absent', revision: head.rev });
      expect(userRow(db, ALICE)?.stats_version).toBe(7);

      // Chunk 2: (scrobble/a3, <p>/]. a6 is new; a7 is absent from the chunk but
      // newer than H (revision >= headRev), so it survives.
      expect(chunk(db, generation, head.rev, `${SCROBBLE}/a3`, RANGE_HI, entries)).toEqual({
        outcome: 'applied',
        written: 1,
        unchanged: 2,
        deleted: 0,
      });
      const byUri = new Map(rows(db).map((r) => [r.uri, r]));
      expect([...byUri.keys()]).toEqual([u('a1'), u('a3'), u('a4'), u('a5'), u('a6'), u('a7')]);
      expect(byUri.get(u('a6'))).toEqual({ uri: u('a6'), cid: entries[4]!.cid, revision: head.rev });
      expect(byUri.get(u('a7'))).toEqual({ uri: u('a7'), cid: cidOf(a7), revision: a7.commit.rev });
      // Unchanged rows keep their own revisions (no rewrite of unchanged records).
      expect(byUri.get(u('a1'))?.revision).toBe(live[1]!.commit.rev);
      expect(byUri.get(u('a4'))).toEqual({ uri: u('a4'), cid: cidOf(live[4]!), revision: live[4]!.commit.rev });
      expect(byUri.get(u('a5'))).toEqual({ uri: u('a5'), cid: cidOf(live[5]!), revision: live[5]!.commit.rev });
      expect(userRow(db, ALICE)?.stats_version).toBe(8);

      // Re-applying the same chunk is idempotent.
      const before = dump(db);
      expect(chunk(db, generation, head.rev, `${SCROBBLE}/a3`, RANGE_HI, entries)).toMatchObject({
        written: 0,
        deleted: 0,
      });
      expect(dump(db)).toEqual(before);
    });
  });

  it('live hint with newer revision survives snapshot sweep', async () => {
    const repo = await repoFor('alice');
    await repo.put(SCROBBLE, 'r01', fixtureScrobble('r01'));
    await repo.put(SCROBBLE, 'r02', fixtureScrobble('r02'));
    await repo.put(SCROBBLE, 'r03', fixtureScrobble('r03'));
    const h0 = repo.head!;
    // The snapshot fetched every record at H0 (nothing stored yet).
    const entries = await entriesAt(repo, h0.cid, () => true);
    // Meanwhile, live: r01 updated, r02 deleted, r04 created.
    const upd = await putProof(repo, SCROBBLE, 'r01', { ...fixtureScrobble('r01'), album: 'Homogenic (Remastered)' });
    const del = await deleteProof(repo, SCROBBLE, 'r02');
    const add = await putProof(repo, SCROBBLE, 'r04', fixtureScrobble('r04'));
    const finalRepo = (await repo.list(SCROBBLE)).map((r) => ({ uri: uriOf(ALICE, SCROBBLE, r.rkey), cid: r.cid }));
    expect(finalRepo.map((r) => r.uri)).toEqual(['r01', 'r03', 'r04'].map((r) => uriOf(ALICE, SCROBBLE, r)));

    await runInDurableObject(stubFor('apply-snapshot-live-race'), (i: HarnessDO) => {
      const db = i.db;
      const generation = seedUser(db, ALICE, { active: false });
      expect(db.tx(() => applyRecordProof(db, upd, OPTS))).toEqual(APPLIED);
      expect(db.tx(() => applyRecordProof(db, del, OPTS))).toEqual({
        outcome: 'absent',
        admit: false,
        suppressed: false,
      });
      expect(db.tx(() => applyRecordProof(db, add, OPTS))).toEqual(APPLIED);

      // The older snapshot chunk over the whole range: only r03 is written.
      expect(chunk(db, generation, h0.rev, RANGE_LO, RANGE_HI, entries)).toEqual({
        outcome: 'applied',
        written: 1,
        unchanged: 2,
        deleted: 0,
      });
      const r01 = uriOf(ALICE, SCROBBLE, 'r01');
      const r02 = uriOf(ALICE, SCROBBLE, 'r02');
      expect(db.one('SELECT album, album_key, revision FROM scrobbles WHERE uri = ?', r01)).toEqual({
        album: 'Homogenic (Remastered)',
        album_key: 'homogenic (remastered)',
        revision: upd.commit.rev,
      });
      expect(db.all('SELECT uri FROM scrobbles WHERE uri = ?', r02)).toEqual([]);
      expect(recordState(db, r02)).toMatchObject({ state: 'absent', revision: del.commit.rev });

      expect(
        db.tx(() =>
          completeSnapshot(db, { did: ALICE, generation, headRev: h0.rev, accountActive: true, nowNs: NOW_NS }),
        ),
      ).toEqual({ outcome: 'complete', active: true });
      expect(userRow(db, ALICE)).toMatchObject({
        active: 1,
        account_status: 'active',
        indexing_state: 'current',
        last_snapshot_at_ms: NOW_MS,
        max_rev: add.commit.rev,
      });
      // Final state equals the newest verified repository.
      expect(db.all('SELECT uri, cid FROM scrobbles ORDER BY uri')).toEqual(finalRepo);
      expect(
        db.all<{ uri: string }>(
          `SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.listened_at DESC, s.uri DESC`,
          ALICE,
        ),
      ).toEqual([{ uri: r01 }, { uri: uriOf(ALICE, SCROBBLE, 'r03') }, { uri: uriOf(ALICE, SCROBBLE, 'r04') }]);
    });
  });

  it('completeSnapshot is superseded when generation changed (deactivation during snapshot)', async () => {
    const repo = await repoFor('alice');
    await repo.put(FOLLOW, 'fbob', follow(BOB));
    for (const rkey of ['a1', 'a2', 'a3']) await repo.put(SCROBBLE, rkey, scrobble({ artist: 'Björk', track: rkey }));
    const head = repo.head!;
    const entries = await entriesAt(repo, head.cid, () => true);

    await runInDurableObject(stubFor('apply-snapshot-superseded'), (i: HarnessDO) => {
      const db = i.db;
      // Admission state: hidden, recovering, one snapshot job at the user's generation.
      const generation = seedUser(db, ALICE, { active: false });
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
         VALUES (?, 'snapshot', 'running', ?, 1, ?, ?)`,
        ALICE,
        generation,
        NOW_MS,
        NOW_MS,
      );

      expect(chunk(db, generation, head.rev, RANGE_LO, `${SCROBBLE}/a1`, entries)).toEqual({
        outcome: 'applied',
        written: 2,
        unchanged: 0,
        deleted: 0,
      });
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 1 });

      // The account is deactivated while the snapshot runs.
      const inactive = db.tx(() => markInactive(db, ALICE, 'deactivated'));
      expect(inactive).toEqual({ changed: true, generation: generation + 1 });

      const before = dump(db);
      expect(chunk(db, generation, head.rev, `${SCROBBLE}/a1`, RANGE_HI, entries)).toEqual({
        outcome: 'superseded',
        written: 0,
        unchanged: 0,
        deleted: 0,
      });
      expect(
        db.tx(() =>
          completeSnapshot(db, { did: ALICE, generation, headRev: head.rev, accountActive: true, nowNs: NOW_NS }),
        ),
      ).toEqual({ outcome: 'superseded' });
      expect(dump(db)).toEqual(before);
      expect(userRow(db, ALICE)).toMatchObject({
        active: 0,
        account_status: 'deactivated',
        indexing_state: 'recovering',
        generation: generation + 1,
        last_snapshot_at_ms: null,
      });
      expect(db.one("SELECT reactivate FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", ALICE)).toEqual({
        reactivate: 0,
      });
      expect(db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toEqual([]);

      // Control: a snapshot under the current generation does complete.
      expect(
        db.tx(() =>
          completeSnapshot(db, {
            did: ALICE,
            generation: generation + 1,
            headRev: head.rev,
            accountActive: false,
            nowNs: NOW_NS,
          }),
        ),
      ).toEqual({ outcome: 'complete', active: false });
      expect(userRow(db, ALICE)).toMatchObject({ active: 0, indexing_state: 'current', last_snapshot_at_ms: NOW_MS });
    });
  });

  it('a snapshot that finds a disabled settings record suppresses the DID and stops', async () => {
    const repo = await repoFor('alice');
    await repo.put(SCROBBLE, 'a1', scrobble({ artist: 'Björk', track: 'a1' }));
    await repo.put(SETTINGS, 'self', settings('disabled'));
    const head = repo.head!;
    const entries = await entriesAt(repo, head.cid, () => true);

    await runInDurableObject(stubFor('apply-snapshot-settings'), (i: HarnessDO) => {
      const db = i.db;
      const generation = seedUser(db, ALICE, { active: false });
      expect(chunk(db, generation, head.rev, RANGE_LO, RANGE_HI, entries)).toEqual({
        outcome: 'suppressed',
        written: 1,
        unchanged: 0,
        deleted: 0,
      });
      expect(db.all('SELECT did FROM users')).toEqual([]);
      expect(db.all('SELECT uri FROM scrobbles')).toEqual([]);
      expect(db.all('SELECT uri FROM record_state')).toEqual([]);
      expect(db.all('SELECT did, settings_uri, settings_rev FROM suppression')).toEqual([
        { did: ALICE, settings_uri: uriOf(ALICE, SETTINGS, 'self'), settings_rev: head.rev },
      ]);
      expect(
        db.tx(() =>
          completeSnapshot(db, { did: ALICE, generation, headRev: head.rev, accountActive: true, nowNs: NOW_NS }),
        ),
      ).toEqual({ outcome: 'superseded' });
      expect(db.all('SELECT did FROM users')).toEqual([]);
    });
  });
});
