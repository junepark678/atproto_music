// W3-04 verify-drain.ts: hints → identity → getRecord proof → verify → apply,
// against real DO SQLite and the fixture network (real signed repositories on
// fake PDSs, fake PLC and DoH, the production SafeFetch policy). Proves
// M5.3.3/pending_confirmed (a confirmed follow becomes an edge only once its
// proof applies), M3.3.3/external_delete, M4.1.3/update_delete,
// M4.1.2/key_rotation and M1.3.4/concurrent_writes. Every expectation is
// hardcoded or comes from the fixture signer, never from the code under test.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { testKey } from '@atmusic/atproto/test-support/keys';
import { type FixtureKit, followRkey } from '@atmusic/atproto/test-support/read-models';
import { carResponse, type FixtureTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { resolveIdentity } from '../../src/do/ingest/identity-cache';
import { drain, drainState } from '../../src/do/ingest/verify-drain';
import { visibleFollowEdge, visibleScrobblesFrom } from '../../src/do/read/visibility';
import { runDue, type TimerHandlers } from '../../src/do/timers';
import type { HarnessDO } from '../harness/harness-do';
import { seedUser } from '../write/support';
import {
  counterValue,
  depsFor,
  enqueue,
  GET_RECORD,
  hint,
  hintRows,
  kit,
  protectedTables,
  snapshotJobs,
} from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const T0 = Date.parse('2026-01-15T12:00:00Z');
const FUTURE_REASON = 'listenedAt: timestamp must be between 1970-01-01 and receipt time plus 300 seconds';

function scrobble(k: FixtureKit, listenedAt: string, extra: Record<string, unknown> = {}) {
  return {
    $type: k.collections.scrobble,
    artist: 'Björk',
    track: 'Hyperballad',
    album: 'Post',
    listenedAt,
    createdAt: '2026-01-15T11:00:00Z',
    ...extra,
  };
}

function rows(db: Db, did?: string) {
  return db.all<{ uri: string; revision: string; cid: string; artist: string; track: string }>(
    `SELECT uri, revision, cid, artist, track FROM scrobbles ${did ? 'WHERE did = ?' : ''} ORDER BY uri`,
    ...(did ? [did] : []),
  );
}

function state(db: Db, uri: string) {
  return db.one('SELECT revision, cid, state, reason FROM record_state WHERE uri = ?', uri);
}

function visible(db: Db, did: string): string[] {
  return db
    .all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.uri`, did)
    .map((r) => r.uri);
}

function follows(db: Db) {
  return db.all('SELECT uri, cid, actor, subject, revision, created_at, indexed_at FROM follows ORDER BY uri');
}

/** Subjects of `actor`'s visible follow edges (the following list). */
function following(db: Db, actor: string): string[] {
  return db
    .all<{ subject: string }>(
      `SELECT f.subject FROM follows f WHERE f.actor = ? AND ${visibleFollowEdge('f')} ORDER BY f.subject`,
      actor,
    )
    .map((r) => r.subject);
}

/** Actors of the visible follow edges to `subject` (the followers list). */
function followers(db: Db, subject: string): string[] {
  return db
    .all<{ actor: string }>(
      `SELECT f.actor FROM follows f WHERE f.subject = ? AND ${visibleFollowEdge('f')} ORDER BY f.actor`,
      subject,
    )
    .map((r) => r.actor);
}

const getRecordCalls = (pds: FakePds, rkey?: string) =>
  pds.calls.filter({ nsid: GET_RECORD }).filter((c) => rkey === undefined || c.params.rkey?.[0] === rkey).length;

/** Let pending microtasks and I/O callbacks run (no clock involved). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('verify drain', () => {
  it('known active DID hint → one getRecord call → row applied with receipt-time validation', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    // Exactly at the receipt bound (+300 s) and one second past it.
    const atBound = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T12:05:00Z'));
    const pastBound = await k.externalPut('Alice', S, 'r2', scrobble(k, '2026-01-15T12:05:01Z', { track: 'Isobel' }));
    const r1Cid = atBound.ops[0]!.cid!;
    k.resetCalls();

    await runInDurableObject(stubFor('drain-known'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      // Both hints received at T0; the drain runs ten minutes later, so only the
      // receipt time (not the drain time) can exclude r2.
      enqueue(db, [hint(k, alice, S, 'r1', { hintRev: atBound.rev })]);
      k.clock.advance(600_000);
      const now = k.clock.nowMs();
      const first = await drain(m, now);
      expect(first.outcomes).toEqual([{ uri: `at://${alice}/${S}/r1`, outcome: 'applied' }]);
      expect(getRecordCalls(k.pds.Alice)).toBe(1);
      expect(k.pds.Alice.calls.filter({ nsid: GET_RECORD })[0]!.params).toEqual({
        did: [alice],
        collection: [S],
        rkey: ['r1'],
      });
      // The head served is r2's commit, which is newer than r1's own: present at that head.
      const head = k.repos.Alice.head!;
      expect(rows(db, alice)).toEqual([
        { uri: `at://${alice}/${S}/r1`, revision: head.rev, cid: r1Cid, artist: 'Björk', track: 'Hyperballad' },
      ]);
      expect(state(db, `at://${alice}/${S}/r1`)).toEqual({
        revision: head.rev,
        cid: r1Cid,
        state: 'present',
        reason: null,
      });
      expect(db.one('SELECT max_rev, stats_version, last_activity_ms FROM users WHERE did = ?', alice)).toEqual({
        max_rev: head.rev,
        stats_version: 1,
        last_activity_ms: now,
      });
      expect(db.one('SELECT indexed_at FROM scrobbles')).toEqual({ indexed_at: '2026-01-15T12:10:00.000000000Z' });
      expect(hintRows(db)).toEqual([]);
      expect(visible(db, alice)).toEqual([`at://${alice}/${S}/r1`]);
      // The proof's commit is remembered for the signature cache.
      expect(db.all('SELECT did, commit_cid, rev FROM verified_commits')).toEqual([
        { did: alice, commit_cid: head.cid, rev: head.rev },
      ]);

      // r2, received at T0 + 600 s - 600 s = T0 as well, is one second past its receipt bound.
      enqueue(db, [hint(k, alice, S, 'r2', { receiptMs: T0, dueAt: now })]);
      const second = await drain(m, now);
      expect(second.outcomes).toEqual([{ uri: `at://${alice}/${S}/r2`, outcome: 'excluded', detail: FUTURE_REASON }]);
      expect(getRecordCalls(k.pds.Alice)).toBe(2);
      expect(getRecordCalls(k.pds.Alice, 'r2')).toBe(1);
      expect(state(db, `at://${alice}/${S}/r2`)).toEqual({
        revision: head.rev,
        cid: pastBound.ops[0]!.cid,
        state: 'excluded',
        reason: FUTURE_REASON,
      });
      expect(rows(db, alice).map((r) => r.uri)).toEqual([`at://${alice}/${S}/r1`]);
      expect(counterValue(db, 'excluded', FUTURE_REASON)).toBe(1);
      // The identity was resolved once and then served from identity_cache.
      expect(k.plc.count(alice)).toBe(1);

      // M5.3.3/pending_confirmed: a follow of Bob confirmed on Alice's PDS (the SPA's
      // queued write) is not an edge until its proof applies.
      const bob = k.users.Bob.did;
      const F = k.collections.follow;
      seedUser(db, bob);
      const rkey = await followRkey(bob);
      const followUri = `at://${alice}/${F}/${rkey}`;
      const followed = await k.externalPut('Alice', F, rkey, {
        $type: F,
        subject: bob,
        createdAt: '2026-01-15T12:09:00Z',
      });
      const followCid = followed.ops[0]!.cid!;
      expect(follows(db)).toEqual([]);
      expect(following(db, alice)).toEqual([]);
      expect(followers(db, bob)).toEqual([]);
      expect(state(db, followUri)).toBeNull();

      enqueue(db, [hint(k, alice, F, rkey, { hintRev: followed.rev })]);
      const third = await drain(m, now);
      expect(third.outcomes).toEqual([{ uri: followUri, outcome: 'applied' }]);
      expect(getRecordCalls(k.pds.Alice)).toBe(3);
      expect(getRecordCalls(k.pds.Alice, rkey)).toBe(1);
      expect(k.pds.Alice.calls.filter({ nsid: GET_RECORD })[2]!.params).toEqual({
        did: [alice],
        collection: [F],
        rkey: [rkey],
      });
      expect(follows(db)).toEqual([
        {
          uri: followUri,
          cid: followCid,
          actor: alice,
          subject: bob,
          revision: followed.rev,
          created_at: '2026-01-15T12:09:00.000000000Z',
          indexed_at: '2026-01-15T12:10:00.000000000Z',
        },
      ]);
      expect(state(db, followUri)).toEqual({ revision: followed.rev, cid: followCid, state: 'present', reason: null });
      expect(following(db, alice)).toEqual([bob]);
      expect(followers(db, bob)).toEqual([alice]);
      expect(db.one('SELECT max_rev FROM users WHERE did = ?', alice)).toEqual({ max_rev: followed.rev });
      expect(hintRows(db)).toEqual([]);
      // The scrobble projection is unchanged by the follow.
      expect(rows(db, alice).map((r) => r.uri)).toEqual([`at://${alice}/${S}/r1`]);
    });
  });

  it('deleted record with exclusion proof → absent and removed from views', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const uri = `at://${alice}/${S}/r1`;
    await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z'));
    k.resetCalls();

    await runInDurableObject(stubFor('drain-delete'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      enqueue(db, [hint(k, alice, S, 'r1')]);
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([{ uri, outcome: 'applied' }]);
      expect(visible(db, alice)).toEqual([uri]);
      const statsBefore = db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did = ?', alice)!;

      // An external app deletes it; the PDS serves a signed exclusion proof.
      const deletion = await k.externalDelete('Alice', S, 'r1');
      k.clock.advance(5_000);
      enqueue(db, [hint(k, alice, S, 'r1', { hintRev: deletion.rev })]);
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([{ uri, outcome: 'absent' }]);
      expect(getRecordCalls(k.pds.Alice)).toBe(2);

      expect(rows(db)).toEqual([]);
      expect(state(db, uri)).toEqual({ revision: deletion.rev, cid: null, state: 'absent', reason: null });
      expect(visible(db, alice)).toEqual([]);
      expect(db.one('SELECT stats_version, max_rev FROM users WHERE did = ?', alice)).toEqual({
        stats_version: statsBefore.stats_version + 1,
        max_rev: deletion.rev,
      });
      expect(hintRows(db)).toEqual([]);
      expect(snapshotJobs(db)).toEqual([]);
    });
  });

  it('RecordNotFound without CAR schedules snapshot and does not delete', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const uri = `at://${alice}/${S}/r1`;
    const put = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z'));
    k.resetCalls();

    await runInDurableObject(stubFor('drain-record-not-found'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      const generation = seedUser(db, alice);
      enqueue(db, [hint(k, alice, S, 'r1')]);
      await drain(m, k.clock.nowMs());
      const projected = { rows: rows(db), state: state(db, uri), user: db.all('SELECT * FROM users') };
      expect(projected.rows).toEqual([
        { uri, revision: put.rev, cid: put.ops[0]!.cid, artist: 'Björk', track: 'Hyperballad' },
      ]);

      // The record is deleted, but this PDS answers RecordNotFound instead of a proof.
      await k.externalDelete('Alice', S, 'r1');
      k.pds.Alice.noExclusionProof = true;
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r1')]);
      const report = await drain(m, k.clock.nowMs());
      expect(report.outcomes).toEqual([{ uri, outcome: 'snapshot_scheduled', detail: 'record_not_found' }]);
      expect(k.pds.Alice.calls.filter({ nsid: GET_RECORD }).map((c) => c.status)).toEqual([200, 400]);

      // Unverified absence deletes nothing: row, record_state and user are byte-identical.
      expect({ rows: rows(db), state: state(db, uri), user: db.all('SELECT * FROM users') }).toEqual(projected);
      expect(visible(db, alice)).toEqual([uri]);
      expect(snapshotJobs(db)).toEqual([{ did: alice, state: 'pending', generation, reason: 'record_not_found' }]);
      expect(hintRows(db)).toEqual([]);
      expect(counterValue(db, 'snapshot_scheduled', 'record_not_found')).toBe(1);
    });
  });

  it('25 hints for one DID collapse into one snapshot job', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const S = k.collections.scrobble;
    k.resetCalls();

    await runInDurableObject(stubFor('drain-coalesce'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      const aliceGen = seedUser(db, alice);
      seedUser(db, bob);
      const rkeys = (n: number) => Array.from({ length: n }, (_, j) => `r${String(j).padStart(2, '0')}`);
      enqueue(
        db,
        rkeys(25).map((r) => hint(k, alice, S, r)),
      );
      // 24 for Bob stay below the threshold and are worked one by one (absent records).
      enqueue(
        db,
        rkeys(24).map((r) => hint(k, bob, S, r)),
      );

      const report = await drain(m, k.clock.nowMs());
      const byOutcome = (o: string) => report.outcomes.filter((x) => x.outcome === o).length;
      expect(report.claimed).toBe(49);
      expect(byOutcome('coalesced')).toBe(1);
      expect(report.outcomes.find((x) => x.outcome === 'coalesced')).toEqual({
        uri: `at://${alice}/${S}/r00`,
        outcome: 'coalesced',
        detail: '25',
      });
      expect(byOutcome('skipped')).toBe(24);
      expect(byOutcome('absent')).toBe(24);

      // Alice: no fetch at all, one snapshot job at her generation, no hint left.
      expect(getRecordCalls(k.pds.Alice)).toBe(0);
      expect(k.plc.count(alice)).toBe(0);
      expect(snapshotJobs(db)).toEqual([{ did: alice, state: 'pending', generation: aliceGen, reason: 'coalesced' }]);
      expect(db.one('SELECT count(*) AS n FROM hints WHERE did = ?', alice)).toEqual({ n: 0 });
      expect(counterValue(db, 'coalesced')).toBe(1);
      // Bob: 24 individual proofs.
      expect(getRecordCalls(k.pds.Bob)).toBe(24);
      expect(db.one("SELECT count(*) AS n FROM record_state WHERE did = ? AND state = 'absent'", bob)).toEqual({
        n: 24,
      });
      expect(hintRows(db)).toEqual([]);
    });
  });

  it('coalescing during a walk keeps its frontier and lease and records one rescan; a hint flood never restarts it', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const H0 = k.repos.Alice.head!.cid; // the head the walk started from
    // 25 records written after H0; their hints are what coalescing deletes.
    const ops = Array.from({ length: 25 }, (_, j) => ({
      action: 'put' as const,
      collection: S,
      rkey: `n${String(j).padStart(2, '0')}`,
      record: scrobble(k, '2026-01-15T11:00:00Z', { track: `New ${j}` }),
    }));
    await k.repos.Alice.writes(ops);
    expect(k.repos.Alice.head!.cid).not.toBe(H0);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-coalesce-rescan'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      const generation = seedUser(db, alice);
      // A many-slice walk paused between slices at H0 (resumes its frontier when due).
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, reason, head_cid, frontier_json, restarts, due_at, updated_at_ms)
         VALUES (?, 'snapshot', 'pending', ?, 'admission', ?, '{"lastKey":"x"}', 0, ?, ?)`,
        alice,
        generation,
        H0,
        T0 + 2_000,
        T0 - 7,
      );
      const users = db.all('SELECT * FROM users');
      const job = () =>
        db.one(
          `SELECT state, generation, reason, head_cid, frontier_json, restarts, due_at, attempts, updated_at_ms
           FROM repo_jobs WHERE did = ? AND kind = 'snapshot'`,
          alice,
        );
      const flood = async () => {
        enqueue(
          db,
          ops.map((o) => hint(k, alice, S, o.rkey, { source: 'notify' })),
        );
        const report = await drain(m, k.clock.nowMs());
        expect(report.outcomes.filter((o) => o.outcome === 'coalesced')).toEqual([
          { uri: expect.any(String), outcome: 'coalesced', detail: '25' },
        ]);
        expect(hintRows(db)).toEqual([]);
      };

      await flood();
      expect(getRecordCalls(k.pds.Alice)).toBe(0);
      // The paused walk keeps its frontier, head, epoch, due time and lease; one rescan request.
      expect(job()).toEqual({
        state: 'pending',
        generation,
        reason: 'admission',
        head_cid: H0,
        frontier_json: '{"lastKey":"x"}',
        restarts: 0,
        due_at: T0 + 2_000,
        attempts: 1,
        updated_at_ms: T0 - 7,
      });

      // A slice in flight at H0 (lease token T0 - 7): a flood every few seconds, as an
      // unauthenticated notify sender could, never takes the row from it.
      db.run(`UPDATE repo_jobs SET state = 'running' WHERE did = ?`, alice);
      for (let n = 0; n < 5; n++) {
        k.clock.advance(3_000);
        await flood();
      }
      expect(job()).toEqual({
        state: 'running',
        generation,
        reason: 'admission',
        head_cid: H0,
        frontier_json: '{"lastKey":"x"}',
        restarts: 0,
        due_at: T0 + 2_000,
        attempts: 6,
        updated_at_ms: T0 - 7,
      });
      // So that slice's guarded frontier write (W4-01 contract) still lands.
      expect(
        db.all(
          `UPDATE repo_jobs SET frontier_json = '{"lastKey":"y"}', updated_at_ms = max(updated_at_ms + 1, ?)
           WHERE did = ? AND kind = 'snapshot' AND state = 'running' AND generation = ? AND updated_at_ms = ?
           RETURNING did`,
          k.clock.nowMs(),
          alice,
          generation,
          T0 - 7,
        ),
      ).toEqual([{ did: alice }]);
      expect(getRecordCalls(k.pds.Alice)).toBe(0);
      expect(counterValue(db, 'coalesced')).toBe(6);
      expect(counterValue(db, 'snapshot_rescan', 'coalesced')).toBe(6);
      expect(counterValue(db, 'snapshot_scheduled', 'coalesced')).toBe(0);

      // A failed walk (repository_changed, in backoff): floods keep its backoff and restarts.
      db.run(
        `UPDATE repo_jobs SET state = 'failed', restarts = 6, failure_code = 'repository_changed', due_at = ?,
           frontier_json = NULL, head_cid = NULL, attempts = 0 WHERE did = ?`,
        T0 + 3_600_000,
        alice,
      );
      k.clock.advance(3_000);
      await flood();
      expect(
        db.one(
          `SELECT state, restarts, failure_code, due_at, attempts FROM repo_jobs WHERE did = ? AND kind = 'snapshot'`,
          alice,
        ),
      ).toEqual({
        state: 'failed',
        restarts: 6,
        failure_code: 'repository_changed',
        due_at: T0 + 3_600_000,
        attempts: 0,
      });
      expect(db.all('SELECT * FROM users')).toEqual(users);
    });
  });

  it('a key change while a fetched proof verifies under the old key leaves verified_commits empty', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const uri = `at://${alice}/${S}/r1`;
    const put = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z'));
    expect(k.repos.Alice.head!.signedBy).toBe(k.keys.alice.didKey);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-key-race'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      // The drain reads the cached key K1, then its getRecord is held at the gate.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const car = await k.repos.Alice.getRecordCar(S, 'r1'); // signed by K1
      k.pds.Alice.fail(
        { nsid: GET_RECORD },
        {
          kind: 'respond',
          respond: async () => {
            await gate;
            return carResponse(car);
          },
        },
      );
      enqueue(db, [hint(k, alice, S, 'r1')]);
      const alarm = drain(m, k.clock.nowMs());
      while (k.pds.Alice.faults.pending > 0) await tick();
      expect(db.one('SELECT signing_key FROM identity_cache WHERE did = ?', alice)).toEqual({
        signing_key: k.keys.alice.didKey,
      });

      // Meanwhile the DID rotates to K2 and another worker's fresh resolution stores it
      // (putIdentity forgets the DID's verified commits, of which there are none yet).
      k.plc.rotateKey(alice, k.keys.aliceRotated);
      const fresh = await resolveIdentity(m, alice, { fresh: true });
      expect(fresh.ok && fresh.identity.signingKey).toBe(k.keys.aliceRotated.didKey);

      // The held proof verifies under K1 after the change: it is not remembered, so no
      // later K1-signed CAR rooted at that commit can skip its signature check.
      open();
      expect((await alarm).outcomes).toEqual([{ uri, outcome: 'applied' }]);
      expect(rows(db)).toEqual([
        { uri, revision: put.rev, cid: put.ops[0]!.cid, artist: 'Björk', track: 'Hyperballad' },
      ]);
      expect(db.all('SELECT * FROM verified_commits')).toEqual([]);
      expect(getRecordCalls(k.pds.Alice)).toBe(1);

      // The same commit served again is verified in full under the current key K2: it fails closed.
      k.pds.Alice.fail({ nsid: GET_RECORD }, { kind: 'respond', respond: () => carResponse(car) });
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r1')]);
      const again = await drain(m, k.clock.nowMs());
      expect(again.outcomes).toEqual([{ uri, outcome: 'verify_failed', detail: 'bad_signature' }]);
      expect(counterValue(db, 'verify_failed', 'bad_signature')).toBe(1);
      expect(db.all('SELECT * FROM verified_commits')).toEqual([]);

      // With the key unchanged, a verified commit is remembered as before (under K2): the PDS
      // re-signs with K2, and the backed-off r1 hint and a new r2 hint both prove at that head.
      k.pds.Alice.faults.clear();
      await k.rotateKey('Alice', k.keys.aliceRotated);
      const put2 = await k.externalPut('Alice', S, 'r2', scrobble(k, '2026-01-15T11:31:00Z'));
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r2')]);
      const last = await drain(m, k.clock.nowMs());
      expect(last.outcomes.map((o) => `${o.uri} ${o.outcome}`).sort()).toEqual([
        `${uri} applied`,
        `at://${alice}/${S}/r2 applied`,
      ]);
      expect(db.all('SELECT did, rev FROM verified_commits')).toEqual([{ did: alice, rev: put2.rev }]);
      expect(hintRows(db)).toEqual([]);
    });
  });

  it('429 with Retry-After pauses host and hint; other hosts proceed', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const S = k.collections.scrobble;
    await k.externalPut('Alice', S, 'a1', scrobble(k, '2026-01-15T11:00:00Z'));
    await k.externalPut('Alice', S, 'a2', scrobble(k, '2026-01-15T11:01:00Z'));
    await k.externalPut('Bob', S, 'b1', scrobble(k, '2026-01-15T11:02:00Z'));
    k.resetCalls();
    k.pds.Alice.rateLimit(GET_RECORD, 30);

    await runInDurableObject(stubFor('drain-429'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      seedUser(db, bob);
      enqueue(db, [hint(k, alice, S, 'a1'), hint(k, bob, S, 'b1')]);

      const first = await drain(m, T0);
      expect(first.outcomes.sort((a, b) => a.uri.localeCompare(b.uri))).toEqual([
        { uri: `at://${alice}/${S}/a1`, outcome: 'fetch_failed', detail: 'fetch:http_429' },
        { uri: `at://${bob}/${S}/b1`, outcome: 'applied' },
      ]);
      // The host is paused for exactly Retry-After; the hint waits for it.
      expect(db.all('SELECT * FROM host_backoff')).toEqual([{ host: 'pds-alice.example.test', until_ms: T0 + 30_000 }]);
      expect(hintRows(db)).toEqual([
        { uri: `at://${alice}/${S}/a1`, attempts: 1, due_at: T0 + 30_000, last_error: 'fetch:http_429' },
      ]);
      expect(rows(db).map((r) => r.uri)).toEqual([`at://${bob}/${S}/b1`]);

      // 10 s later another Alice hint arrives: no request reaches the paused host.
      k.clock.advance(10_000);
      enqueue(db, [hint(k, alice, S, 'a2')]);
      const second = await drain(m, k.clock.nowMs());
      expect(second.outcomes).toEqual([
        { uri: `at://${alice}/${S}/a2`, outcome: 'host_paused', detail: 'pds-alice.example.test' },
      ]);
      expect(getRecordCalls(k.pds.Alice)).toBe(1);
      expect(hintRows(db)).toEqual([
        { uri: `at://${alice}/${S}/a1`, attempts: 1, due_at: T0 + 30_000, last_error: 'fetch:http_429' },
        // Deferred, not failed: no attempt is counted.
        { uri: `at://${alice}/${S}/a2`, attempts: 0, due_at: T0 + 30_000, last_error: 'host_paused' },
      ]);
      // Nothing is due before the pause ends; the drain timer waits for it.
      expect((await drain(m, T0 + 20_000)).claimed).toBe(0);
      expect(db.one("SELECT due_at FROM timers WHERE name = 'drain'")).toEqual({ due_at: T0 + 30_000 });

      // At the end of the pause both apply.
      k.clock.set('2026-01-15T12:00:30Z');
      const third = await drain(m, k.clock.nowMs());
      expect(third.outcomes.map((o) => o.outcome)).toEqual(['applied', 'applied']);
      expect(getRecordCalls(k.pds.Alice)).toBe(3);
      expect(rows(db).map((r) => r.uri)).toEqual([
        `at://${alice}/${S}/a1`,
        `at://${alice}/${S}/a2`,
        `at://${bob}/${S}/b1`,
      ]);
      expect(hintRows(db)).toEqual([]);
      expect(counterValue(db, 'proof_fetch_failed', 'http_status_429')).toBe(1);
    });
  });

  it('key rotation: first verify fails, fresh resolve succeeds', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const uri = `at://${alice}/${S}/r1`;
    k.resetCalls();

    await runInDurableObject(stubFor('drain-key-rotation'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      // The old key is cached (a fresh identity_cache entry).
      const cached = await resolveIdentity(m, alice);
      expect(cached.ok && cached.identity.signingKey).toBe(k.keys.alice.didKey);
      expect(k.plc.count(alice)).toBe(1);

      // The account rotates its key; the PDS signs every new commit with the new one.
      await k.rotateKey('Alice', k.keys.aliceRotated);
      const put = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z'));
      expect(k.repos.Alice.head!.signedBy).toBe(k.keys.aliceRotated.didKey);

      k.clock.advance(60_000); // still inside the cache TTL
      enqueue(db, [hint(k, alice, S, 'r1')]);
      const report = await drain(m, k.clock.nowMs());
      expect(report.outcomes).toEqual([{ uri, outcome: 'applied' }]);
      // One proof fetch, verified twice: the cached key fails, one fresh resolution cures it.
      expect(getRecordCalls(k.pds.Alice)).toBe(1);
      expect(k.plc.count(alice)).toBe(2);
      expect(db.one('SELECT signing_key, fetched_at_ms FROM identity_cache WHERE did = ?', alice)).toEqual({
        signing_key: k.keys.aliceRotated.didKey,
        fetched_at_ms: T0 + 60_000,
      });
      expect(rows(db)).toEqual([
        { uri, revision: put.rev, cid: put.ops[0]!.cid, artist: 'Björk', track: 'Hyperballad' },
      ]);
      expect(counterValue(db, 'verify_failed', 'bad_signature')).toBe(0);

      // A commit signed by a key the DID document never publishes fails closed,
      // even after the fresh resolution.
      await k.pds.Alice.rotateKey(alice, k.keys.bobRotated);
      await k.externalPut('Alice', S, 'r2', scrobble(k, '2026-01-15T11:31:00Z'));
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r2')]);
      const before = { rows: rows(db), users: db.all('SELECT * FROM users'), rs: db.all('SELECT * FROM record_state') };
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([
        { uri: `at://${alice}/${S}/r2`, outcome: 'verify_failed', detail: 'bad_signature' },
      ]);
      expect({
        rows: rows(db),
        users: db.all('SELECT * FROM users'),
        rs: db.all('SELECT * FROM record_state'),
      }).toEqual(before);
      expect(k.plc.count(alice)).toBe(3);
      expect(counterValue(db, 'verify_failed', 'bad_signature')).toBe(1);
      expect(hintRows(db)).toEqual([
        { uri: `at://${alice}/${S}/r2`, attempts: 1, due_at: T0 + 62_000, last_error: 'verify:bad_signature' },
      ]);
    });
  });

  it('two concurrent proofs for one URI arriving out of order end with newest revision', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const uri = `at://${alice}/${S}/r1`;
    const v1 = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z'));
    const car1 = await k.repos.Alice.getRecordCar(S, 'r1'); // the proof at v1's head
    const v2 = await k.externalPut('Alice', S, 'r1', scrobble(k, '2026-01-15T11:30:00Z', { artist: 'Kate Bush' }));
    expect(v1.rev < v2.rev).toBe(true);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-out-of-order'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);

      // The first fetch is slow and answers with the older head's proof.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      k.pds.Alice.fail(
        { nsid: GET_RECORD },
        {
          kind: 'respond',
          respond: async () => {
            await gate;
            return carResponse(car1);
          },
        },
      );
      enqueue(db, [hint(k, alice, S, 'r1', { hintRev: v1.rev })]);
      const alarm = drain(m, k.clock.nowMs());
      while (k.pds.Alice.faults.pending > 0) await tick();

      // Meanwhile the newer event arrives and another drain runs: the URI is in flight, so it is not fetched twice.
      expect(drainState(db, m.config.budget).inFlight.has(uri)).toBe(true);
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r1', { hintRev: v2.rev })]);
      const concurrent = await drain(m, k.clock.nowMs());
      expect(concurrent.claimed).toBe(0);

      // The old proof lands last-but-first: it is applied (it is newer than nothing), and the hint is kept.
      open();
      expect((await alarm).outcomes).toEqual([{ uri, outcome: 'rearmed', detail: 'applied' }]);
      expect(state(db, uri)).toMatchObject({ revision: v1.rev, state: 'present' });
      expect(hintRows(db)).toEqual([{ uri, attempts: 0, due_at: T0, last_error: null }]);

      // The kept hint fetches the current head.
      const next = await drain(m, k.clock.nowMs());
      expect(next.outcomes).toEqual([{ uri, outcome: 'applied' }]);
      expect(rows(db)).toEqual([
        { uri, revision: v2.rev, cid: v2.ops[0]!.cid, artist: 'Kate Bush', track: 'Hyperballad' },
      ]);
      expect(hintRows(db)).toEqual([]);

      // The reverse order: the older proof arrives after the newer one was applied (a stale PDS).
      k.pds.Alice.fail({ nsid: GET_RECORD }, { kind: 'respond', respond: () => carResponse(car1) });
      k.clock.advance(1_000);
      enqueue(db, [hint(k, alice, S, 'r1')]);
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([{ uri, outcome: 'stale', detail: 'stale_head' }]);
      expect(rows(db)).toEqual([
        { uri, revision: v2.rev, cid: v2.ops[0]!.cid, artist: 'Kate Bush', track: 'Hyperballad' },
      ]);
      expect(state(db, uri)).toEqual({ revision: v2.rev, cid: v2.ops[0]!.cid, state: 'present', reason: null });
      expect(getRecordCalls(k.pds.Alice)).toBe(3);
    });
  });

  it('100 hints for distinct URIs from interleaved alarm and RPC calls yield exactly 100 rows', async () => {
    const k = await kit();
    const S = k.collections.scrobble;
    // Five writers on three PDS hosts: the kit's three plus two more on Alice's and Bob's hosts.
    const extra = [
      { did: 'did:plc:dddddddddddddddddddddddd', pds: k.pds.Alice, key: await testKey('secp256k1', 0x21) },
      { did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee', pds: k.pds.Bob, key: await testKey('p256', 0x22) },
    ];
    const repos = [k.repos.Alice, k.repos.Bob, k.repos.Carol];
    for (const e of extra) {
      const repo = new SignedRepo(e.did, e.key, { clock: k.clock });
      await e.pds.addAccount(repo);
      k.plc.register(e.did, { signingKey: e.key, pds: e.pds.origin, handle: null });
      repos.push(repo);
    }
    // 20 records per writer, in one signed commit each.
    const all: Array<{ did: string; rkey: string }> = [];
    for (const repo of repos) {
      const ops = Array.from({ length: 20 }, (_, j) => {
        const rkey = `t${String(j).padStart(2, '0')}`;
        all.push({ did: repo.did, rkey });
        return {
          action: 'put' as const,
          collection: S,
          rkey,
          record: scrobble(k, `2026-01-15T10:${String(j).padStart(2, '0')}:00Z`, { track: `Track ${j}` }),
        };
      });
      await repo.writes(ops);
    }
    expect(all).toHaveLength(100);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-concurrent'), async (i: HarnessDO, ctx) => {
      const db = i.db;
      const base = depsFor(db, k);
      for (const repo of repos) seedUser(db, repo.did);
      const now = k.clock.nowMs();

      // "RPC calls" (notify / jetstream enqueues, and one RPC-side drain) fire while
      // the alarm's proof fetches are in flight: on every getRecord the next batch arrives.
      const batches = [all.slice(0, 40), all.slice(40, 60), all.slice(60, 80), all.slice(80, 100)];
      const rpcDrains: Array<Promise<unknown>> = [];
      let getRecords = 0;
      let maxPerUri = 0;
      let active = 0;
      let peak = 0;
      const activeByHost = new Map<string, number>();
      const peakPerHost = new Map<string, number>();
      const fetching = new Map<string, number>();
      const inner = k.transport;
      const transport = Object.assign(
        async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === `/xrpc/${GET_RECORD}`) {
            getRecords++;
            const key = `${url.searchParams.get('did')}/${url.searchParams.get('rkey')}`;
            const concurrent = (fetching.get(key) ?? 0) + 1;
            fetching.set(key, concurrent);
            maxPerUri = Math.max(maxPerUri, concurrent);
            active++;
            peak = Math.max(peak, active);
            const host = url.hostname;
            const onHost = (activeByHost.get(host) ?? 0) + 1;
            activeByHost.set(host, onHost);
            peakPerHost.set(host, Math.max(peakPerHost.get(host) ?? 0, onHost));
            if (getRecords % 5 === 1 && batches.length > 0) {
              const batch = batches.shift()!.map((h) => hint(k, h.did, S, h.rkey, { source: 'notify' }));
              // The same RPC repeats every URI that is in flight right now (same event, same receipt).
              const repeats = [...drainState(db, base.config.budget).inFlight].map((uri) => {
                const [, , did, , rkey] = uri.split('/');
                return hint(k, did!, S, rkey!, { source: 'notify' });
              });
              expect(repeats.length).toBeGreaterThan(0);
              enqueue(db, [...batch, ...repeats]);
            }
            if (getRecords === 3) rpcDrains.push(drain(m, now));
            // A fetch is in flight until its body has been read to the end (or cancelled).
            let ended = false;
            const end = () => {
              if (ended) return;
              ended = true;
              fetching.set(key, (fetching.get(key) ?? 1) - 1);
              active--;
              activeByHost.set(host, (activeByHost.get(host) ?? 1) - 1);
            };
            let res: Response;
            try {
              res = await inner(req);
            } catch (error) {
              end();
              throw error;
            }
            if (res.body === null) {
              end();
              return res;
            }
            const reader = res.body.getReader();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                // One chunk per pull, a macrotask apart, so other fetches can overlap this one.
                await tick();
                const { done, value } = await reader.read();
                if (done) {
                  end();
                  controller.close();
                } else {
                  controller.enqueue(value);
                }
              },
              cancel(reason) {
                end();
                return reader.cancel(reason);
              },
            });
            return new Response(body, { status: res.status, headers: res.headers });
          }
          return inner(req);
        },
        { fixture: true as const, calls: inner.calls, hostnames: inner.hostnames },
      ) satisfies FixtureTransport;
      const m = { ...base, transport };

      enqueue(
        db,
        batches.shift()!.map((h) => hint(k, h.did, S, h.rkey)),
      );
      const noop = async () => {};
      const handlers: TimerHandlers = {
        drain: async (at) => {
          await drain(m, at);
        },
        snapshot: noop,
        'jetstream-watchdog': noop,
        'status-sweep': noop,
        'identity-sweep': noop,
        discovery: noop,
        gc: noop,
      };
      // Alarms until the queue is empty (each run re-arms `drain` while hints are due).
      for (let alarm = 0; alarm < 10 && db.one<{ n: number }>('SELECT count(*) AS n FROM hints')!.n > 0; alarm++) {
        await runDue(ctx.storage, db, now + alarm * 2_000, handlers, { maxRuns: 7 });
        await Promise.all(rpcDrains);
      }

      expect(batches).toHaveLength(0);
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 100 });
      expect(rows(db).map((r) => r.uri)).toEqual(all.map((h) => `at://${h.did}/${S}/${h.rkey}`).sort());
      expect(db.one("SELECT count(*) AS n FROM record_state WHERE state = 'present'")).toEqual({ n: 100 });
      expect(hintRows(db)).toEqual([]);
      // Every URI was fetched exactly once: no double fetch despite the repeats and the second drain.
      expect(getRecords).toBe(100);
      const fetched = [k.pds.Alice, k.pds.Bob, k.pds.Carol].flatMap((p) =>
        p.calls.filter({ nsid: GET_RECORD }).map((c) => `${c.params.did?.[0]}/${c.params.rkey?.[0]}`),
      );
      expect(new Set(fetched).size).toBe(100);
      expect(maxPerUri).toBe(1);
      // At most 4 fetches at once, and at most 2 per PDS host.
      // Measured at the transport: the limits were reached and never exceeded.
      expect(peak).toBe(4);
      expect(Object.fromEntries(peakPerHost)).toEqual({
        'pds-alice.example.test': 2,
        'pds-bob.example.test': 2,
        'pds-carol.example.test': 2,
      });
      const limiter = drainState(db, m.config.budget).limiter;
      expect(limiter.inFlight).toBe(0);
      expect(drainState(db, m.config.budget).inFlight.size).toBe(0);
      // One signature check per commit: 5 heads, everything else from verified_commits.
      expect(db.one('SELECT count(*) AS n FROM verified_commits')).toEqual({ n: 5 });
    });
  });

  it('RepoDeactivated creates a status job; 20 transient failures give up into a snapshot', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const bob = k.users.Bob.did;
    const S = k.collections.scrobble;
    await k.externalPut('Bob', S, 'b1', scrobble(k, '2026-01-15T11:00:00Z'));
    k.pds.Alice.deactivate(alice);
    k.pds.Bob.serverError(GET_RECORD, 500, 20);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-errors'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k);
      const aliceGen = seedUser(db, alice);
      const bobGen = seedUser(db, bob);
      const before = protectedTables(db);
      enqueue(db, [hint(k, alice, S, 'a1')]);
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([
        { uri: `at://${alice}/${S}/a1`, outcome: 'status_job', detail: 'RepoDeactivated' },
      ]);
      expect(db.all("SELECT did, kind, state, generation, reason FROM repo_jobs WHERE kind = 'status'")).toEqual([
        { did: alice, kind: 'status', state: 'pending', generation: aliceGen, reason: 'RepoDeactivated' },
      ]);
      expect(hintRows(db)).toEqual([]);

      enqueue(db, [hint(k, bob, S, 'b1')]);
      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= 20; attempt++) {
        const report = await drain(m, k.clock.nowMs());
        outcomes.push(...report.outcomes.map((o) => `${o.outcome}:${o.detail}`));
        k.clock.advance(600_000);
      }
      expect(outcomes).toEqual([...Array(19).fill('fetch_failed:fetch:http_500'), 'gave_up:fetch:http_500']);
      expect(getRecordCalls(k.pds.Bob)).toBe(20);
      expect(snapshotJobs(db)).toEqual([{ did: bob, state: 'pending', generation: bobGen, reason: 'gave_up' }]);
      expect(counterValue(db, 'hint_gave_up', 'fetch:http_500')).toBe(1);
      expect(counterValue(db, 'proof_fetch_failed', 'http_status_500')).toBe(20);
      expect(hintRows(db)).toEqual([]);
      // None of it touched the projection.
      expect(protectedTables(db)).toEqual(before);
    });
  });

  it('Paid drain works 200 cached-identity hints in one slice: 200 getRecord calls', async () => {
    const k = await kit();
    const S = k.collections.scrobble;
    // Ten writers (20 hints each, below the coalescing threshold) on the kit's three hosts.
    const repos = [k.repos.Alice, k.repos.Bob, k.repos.Carol];
    const hosts = [k.pds.Alice, k.pds.Bob, k.pds.Carol];
    for (let n = 0; n < 7; n++) {
      const did = `did:plc:${'fghijkl'[n]!.repeat(24)}`;
      const key = await testKey(n % 2 === 0 ? 'secp256k1' : 'p256', 0x30 + n);
      const pds = hosts[n % 3]!;
      const repo = new SignedRepo(did, key, { clock: k.clock });
      await pds.addAccount(repo);
      k.plc.register(did, { signingKey: key, pds: pds.origin, handle: null });
      repos.push(repo);
    }
    const all: string[] = [];
    for (const repo of repos) {
      const ops = Array.from({ length: 20 }, (_, j) => {
        const rkey = `p${String(j).padStart(2, '0')}`;
        all.push(`at://${repo.did}/${S}/${rkey}`);
        return {
          action: 'put' as const,
          collection: S,
          rkey,
          record: scrobble(k, '2026-01-15T11:00:00Z', { track: `Track ${j}` }),
        };
      });
      await repo.writes(ops);
    }
    expect(all).toHaveLength(200);

    await runInDurableObject(stubFor('drain-paid-200'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k, { plan: 'paid' });
      expect(m.config.budget).toMatchObject({ drainHints: 200, concurrentFetches: 4, perHostConcurrency: 2 });
      for (const repo of repos) {
        seedUser(db, repo.did);
        // Warm identity_cache: every identity in this slice is a cache hit.
        expect((await resolveIdentity(m, repo.did)).ok).toBe(true);
      }
      expect(db.one('SELECT count(*) AS n FROM identity_cache')).toEqual({ n: 10 });
      k.resetCalls();
      enqueue(
        db,
        all.map((uri) => {
          const [, , did, , rkey] = uri.split('/');
          return hint(k, did!, S, rkey!);
        }),
      );

      const report = await drain(m, k.clock.nowMs());
      expect(report.claimed).toBe(200);
      expect(report.outcomes.filter((o) => o.outcome === 'applied')).toHaveLength(200);
      expect(report.outcomes.filter((o) => o.outcome === 'budget')).toEqual([]);
      // One getRecord per hint, all in this one slice; no identity was fetched.
      expect(hosts.reduce((n, pds) => n + getRecordCalls(pds), 0)).toBe(200);
      expect(k.plc.calls.count()).toBe(0);
      expect(report.subrequests).toBe(600);
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 200 });
      expect(rows(db).map((r) => r.uri)).toEqual([...all].sort());
      expect(hintRows(db)).toEqual([]);
    });
  });

  it('PLAN=free drain stays within 40 subrequests per slice', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;
    const ops = Array.from({ length: 20 }, (_, j) => ({
      action: 'put' as const,
      collection: S,
      rkey: `f${String(j).padStart(2, '0')}`,
      record: scrobble(k, '2026-01-15T11:00:00Z', { track: `T${j}` }),
    }));
    await k.repos.Alice.writes(ops);
    k.resetCalls();

    await runInDurableObject(stubFor('drain-free'), async (i: HarnessDO) => {
      const db = i.db;
      const m = depsFor(db, k, { plan: 'free' });
      expect(m.config.budget).toMatchObject({ drainHints: 40, subrequestsPerSlice: 40 });
      seedUser(db, alice);
      enqueue(
        db,
        ops.map((o) => hint(k, alice, S, o.rkey)),
      );
      let total = 0;
      for (let slice = 0; slice < 5 && db.one<{ n: number }>('SELECT count(*) AS n FROM hints')!.n > 0; slice++) {
        const before = k.transport.calls.count();
        const report = await drain(m, k.clock.nowMs(), m.config.budget);
        const sent = k.transport.calls.count() - before;
        // What was actually sent never exceeds what was reserved, which never exceeds 40.
        expect(report.subrequests).toBeLessThanOrEqual(40);
        expect(sent).toBeLessThanOrEqual(report.subrequests);
        expect(sent).toBeGreaterThan(0);
        total += report.outcomes.filter((o) => o.outcome === 'applied').length;
        // Hints over budget stay due for the next alarm, untouched.
        for (const o of report.outcomes.filter((x) => x.outcome === 'budget')) {
          expect(db.one('SELECT attempts FROM hints WHERE uri = ?', o.uri)).toEqual({ attempts: 0 });
        }
      }
      expect(total).toBe(20);
      expect(db.one('SELECT count(*) AS n FROM scrobbles')).toEqual({ n: 20 });
      expect(getRecordCalls(k.pds.Alice)).toBe(20);
    });
  });
});
