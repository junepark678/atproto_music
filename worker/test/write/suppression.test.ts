// W2-04: the signed settings opt-out (ADR 0004 §5.3) against node:sqlite.

import type { RecordProof } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { activeUser, visibleFollowEdge, visibleScrobblesFrom } from '../../src/do/read/visibility';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { applySettings } from '../../src/do/write/suppression';
import { withMigratedDb } from '../node/support/node-db';
import {
  ALICE,
  BOB,
  CAROL,
  deleteProof,
  dump,
  FOLLOW,
  fixtureScrobble,
  follow,
  NOW_MS,
  NOW_STORAGE,
  OPTS,
  putProof,
  recordState,
  repoFor,
  SCROBBLE,
  SETTINGS,
  seedUser,
  settings,
  uriOf,
} from './support';

const SETTINGS_URI = uriOf(ALICE, SETTINGS, 'self');

/** Tables that may hold rows keyed by a DID (column name per table). */
const DID_COLUMNS: ReadonlyArray<[string, string]> = [
  ['users', 'did'],
  ['scrobbles', 'did'],
  ['follows', 'actor'],
  ['record_state', 'did'],
  ['hints', 'did'],
  ['repo_jobs', 'did'],
  ['stats_cache', 'did'],
  ['snapshot_blocks', 'did'],
  ['verified_commits', 'did'],
  ['identity_cache', 'did'],
  ['indexing_status', 'scope'],
  ['suppression', 'did'],
];

function rowsFor(db: Db, did: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, column] of DID_COLUMNS) {
    out[table] = db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, did)!.n;
  }
  return out;
}

/** Test setup: rows other packages own (drain, snapshot jobs, caches) for `did`. */
function seedAuxiliary(db: Db, did: string): void {
  db.run(
    `INSERT INTO hints(uri, did, collection, rkey, source, priority, receipt_time, due_at)
     VALUES (?, ?, ?, 'r99', 'jetstream', 1, ?, ?)`,
    uriOf(did, SCROBBLE, 'r99'),
    did,
    SCROBBLE,
    NOW_STORAGE,
    NOW_MS,
  );
  db.run(
    "INSERT INTO repo_jobs(did, kind, due_at, updated_at_ms) VALUES (?, 'snapshot', ?, ?), (?, 'status', ?, ?)",
    did,
    NOW_MS,
    NOW_MS,
    did,
    NOW_MS,
    NOW_MS,
  );
  db.run(
    "INSERT INTO stats_cache(did, win, lim, as_of, version, body) VALUES (?, 'all', 10, ?, 1, '{}')",
    did,
    NOW_STORAGE,
  );
  db.run(
    "INSERT INTO snapshot_blocks(did, cid, bytes) VALUES (?, 'bafyblock', ?)",
    did,
    new Uint8Array([1, 2, 3]).buffer,
  );
  db.run(
    "INSERT INTO verified_commits(did, commit_cid, rev, verified_at_ms) VALUES (?, 'bafycommit', '3lb2aaaaaaaa2', ?)",
    did,
    NOW_MS,
  );
  db.run("INSERT INTO identity_cache(did, handle, fetched_at_ms) VALUES (?, 'alice.test', ?)", did, NOW_MS);
  db.run("INSERT INTO indexing_status(scope, state, caught_up) VALUES (?, 'current', 1)", did);
}

function apply(db: Db, proof: RecordProof) {
  return db.tx(() => applyRecordProof(db, proof, OPTS));
}

describe('settings suppression', () => {
  it("disabled settings deletes local data and keeps only suppression marker; other owners' follows to DID hidden", async () => {
    const alice = await repoFor('alice');
    const bob = await repoFor('bob');
    const carol = await repoFor('carol');
    const seed: RecordProof[] = [
      await putProof(alice, SCROBBLE, 'r01', fixtureScrobble('r01')),
      await putProof(alice, FOLLOW, 'fbob', follow(BOB)),
      await putProof(bob, SCROBBLE, 'r09', fixtureScrobble('r09')),
      await putProof(carol, FOLLOW, 'falice', follow(ALICE)),
      await putProof(carol, FOLLOW, 'fbob', follow(BOB)),
    ];
    const disabled = await putProof(alice, SETTINGS, 'self', settings('disabled'));
    const later = await putProof(alice, SCROBBLE, 'r07', fixtureScrobble('r07'));

    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      seedUser(db, BOB);
      seedUser(db, CAROL);
      for (const p of seed) expect(apply(db, p).outcome).toBe('applied');
      seedAuxiliary(db, ALICE);
      const bobBefore = rowsFor(db, BOB);
      const carolBefore = rowsFor(db, CAROL);
      expect(rowsFor(db, ALICE)).toEqual({
        users: 1,
        scrobbles: 1,
        follows: 1,
        record_state: 2,
        hints: 1,
        repo_jobs: 2,
        stats_cache: 1,
        snapshot_blocks: 1,
        verified_commits: 1,
        identity_cache: 1,
        indexing_status: 1,
        suppression: 0,
      });

      expect(apply(db, disabled)).toEqual({ outcome: 'applied', admit: false, suppressed: true });

      // Only the suppression marker is left for Alice.
      expect(rowsFor(db, ALICE)).toEqual({
        users: 0,
        scrobbles: 0,
        follows: 0,
        record_state: 0,
        hints: 0,
        repo_jobs: 0,
        stats_cache: 0,
        snapshot_blocks: 0,
        verified_commits: 0,
        identity_cache: 0,
        indexing_status: 0,
        suppression: 1,
      });
      expect(db.all('SELECT * FROM suppression')).toEqual([
        { did: ALICE, suppressed_at: NOW_STORAGE, settings_uri: SETTINGS_URI, settings_rev: disabled.commit.rev },
      ]);
      // The global generation counter survives (a later admission gets a fresh generation).
      expect(db.one('SELECT last_generation FROM backfill_generation')).toEqual({ last_generation: 3 });
      expect(db.one("SELECT state FROM indexing_status WHERE scope = 'global'")).toEqual({ state: 'recovering' });

      // Other owners keep their rows; Carol→Alice stays stored but is hidden.
      expect(rowsFor(db, BOB)).toEqual(bobBefore);
      expect(rowsFor(db, CAROL)).toEqual(carolBefore);
      expect(db.all('SELECT actor, subject FROM follows ORDER BY subject')).toEqual([
        { actor: CAROL, subject: ALICE },
        { actor: CAROL, subject: BOB },
      ]);
      expect(db.all(`SELECT f.subject FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')}`, CAROL)).toEqual([
        { subject: BOB },
      ]);
      expect(db.one(`SELECT u.did FROM users u WHERE u.did = ? AND ${activeUser('u')}`, ALICE)).toBeNull();
      expect(db.all(`SELECT s.did FROM ${visibleScrobblesFrom()}`)).toEqual([{ did: BOB }]);

      // While suppressed, a newer scrobble proof is ignored and writes nothing.
      const before = dump(db);
      expect(apply(db, later)).toEqual({ outcome: 'ignored', admit: false, suppressed: false });
      // Replaying the same opt-out changes nothing either.
      expect(db.tx(() => applySettings(db, ALICE, disabled, OPTS))).toEqual({
        outcome: 'noop_older',
        admit: false,
        suppressed: false,
      });
      expect(dump(db)).toEqual(before);
    });
  });

  it('enabled/absent settings with newer rev clears suppression and requests admission', async () => {
    const alice = await repoFor('alice');
    const oldEnabled = await putProof(alice, SETTINGS, 'self', settings('enabled'));
    const disabled = await putProof(alice, SETTINGS, 'self', settings('disabled'));
    const enabled = await putProof(alice, SETTINGS, 'self', settings('enabled'));
    const disabledAgain = await putProof(alice, SETTINGS, 'self', settings('disabled'));
    const invalid = await putProof(alice, SETTINGS, 'self', { ...settings('enabled'), indexing: 'paused' });
    const removed = await deleteProof(alice, SETTINGS, 'self');

    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      expect(apply(db, disabled)).toEqual({ outcome: 'applied', admit: false, suppressed: true });

      // An older "enabled" does not lift a newer opt-out.
      let before = dump(db);
      expect(apply(db, oldEnabled)).toEqual({ outcome: 'noop_older', admit: false, suppressed: false });
      expect(dump(db)).toEqual(before);

      // A newer "enabled" lifts it and asks for admission (a fresh snapshot).
      expect(apply(db, enabled)).toEqual({ outcome: 'applied', admit: true, suppressed: false });
      expect(db.all('SELECT * FROM suppression')).toEqual([]);
      expect(recordState(db, SETTINGS_URI)).toEqual({
        revision: enabled.commit.rev,
        cid: enabled.state === 'present' ? enabled.cid : null,
        state: 'present',
        reason: null,
        collection: SETTINGS,
      });
      // Admission is the caller's: no users row or job is created here.
      expect(db.all('SELECT did FROM users')).toEqual([]);
      expect(db.all('SELECT did FROM repo_jobs')).toEqual([]);
      // The stale opt-out can never re-suppress.
      before = dump(db);
      expect(apply(db, disabled)).toEqual({ outcome: 'noop_older', admit: false, suppressed: false });
      expect(dump(db)).toEqual(before);

      // Opt out again (unknown DID now: still honoured), then delete the record.
      expect(apply(db, disabledAgain)).toEqual({ outcome: 'applied', admit: false, suppressed: true });
      expect(db.one('SELECT settings_rev FROM suppression WHERE did = ?', ALICE)).toEqual({
        settings_rev: disabledAgain.commit.rev,
      });
      // An invalid settings record neither opts out nor lifts the opt-out.
      before = dump(db);
      expect(apply(db, invalid)).toEqual({
        outcome: 'excluded',
        reason: 'indexing: expected enabled or disabled',
        admit: false,
        suppressed: false,
      });
      expect(dump(db)).toEqual(before);

      expect(removed.state).toBe('absent');
      expect(apply(db, removed)).toEqual({ outcome: 'absent', admit: true, suppressed: false });
      expect(db.all('SELECT * FROM suppression')).toEqual([]);
      expect(recordState(db, SETTINGS_URI)).toMatchObject({ state: 'absent', revision: removed.commit.rev, cid: null });
    });
  });
});
