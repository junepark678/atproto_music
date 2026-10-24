// W6-01 federation acceptance (ADR 0004 §5.3–§5.5, §7, §10.3; TESTING.md
// "Carol's scrobble must be introduced via verified external repository
// ingestion", "Verification rejection tests", "Disconnect"). Proves
// M4.4.1/independent_write, M4.4.2/signature_failure, M4.4.2/convergence,
// M6.3.3/suppression and the acceptance half of M4.3.1/feed_visibility.
//
// Everything reaches the real IndexDO as fake Jetstream events over the
// production socket, and is verified (signature, CIDs, MST path) and applied
// by the production alarm. Corruptions are served by the fake PDS (fault
// injection at the transport boundary only); the verifier is never bypassed.
// Expected values are hardcoded; each step asserts HTTP status and schema
// (support/openapi.ts), DO tables and the fixture network's call counts.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { carResponse } from '@atmusic/atproto/test-support/router-transport';
import { corruptBlockByte, corruptSignature } from '@atmusic/atproto/test-support/signed-repo';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import {
  ALICE,
  APP_WRITES,
  BOB,
  CAROL,
  count,
  FOLLOW,
  GET_RECORD,
  hintCount,
  inSocket,
  projectionTables,
  rkeyOf,
  SCROBBLE,
  SETTINGS,
  type Seeded,
  seedAcceptance,
  settled,
  uriOf,
} from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const enc = encodeURIComponent;
const rkeys = (body: Json): string[] => (body.items as Array<{ uri: string }>).map((s) => rkeyOf(s.uri));
const GLOBAL_FEED = ['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

function scrobble(track: string, listenedAt: string, artist = 'Portishead') {
  return { $type: SCROBBLE, artist, track, listenedAt, createdAt: listenedAt };
}

async function feed(a: Seeded): Promise<string[]> {
  const r = await a.request('/api/v1/feed?scope=global&limit=100');
  expect(r.status).toBe(200);
  return rkeys(r.body);
}

/** A page's rows, next cursor and asOf, serialized: everything but the live indexing state. */
const pageBytes = (body: Json) => JSON.stringify([body.items, body.nextCursor, body.asOf]);

const counter = (db: Db, name: string, label = '') =>
  db.one<{ value: number }>('SELECT value FROM counters WHERE name = ? AND label = ?', name, label)?.value ?? 0;

describe('federation acceptance', () => {
  it('Carol r10 appears only through external ingestion with zero app write calls', async () => {
    const a = await seedAcceptance('external-writer');
    const r10 = uriOf(CAROL, 'r10');
    const seeded = a.seed.records.get(r10);
    expect(seeded).toMatchObject({ did: CAROL, source: 'external', state: 'present' });

    // During seeding Carol's PDS received no app write at all; Alice's and Bob's did.
    const writes = (calls: Array<{ nsid: string | null }>) =>
      calls.filter((c) => (APP_WRITES as readonly (string | null)[]).includes(c.nsid)).length;
    expect(writes(a.seedCalls.pds.Carol)).toBe(0);
    expect(writes(a.seedCalls.pds.Alice)).toBe(10); // r01–r08 creates, the follow, r08's delete
    expect(writes(a.seedCalls.pds.Bob)).toBe(1);
    // What Carol's PDS did serve: verification reads of her signed head.
    const carolReads = a.seedCalls.pds.Carol.map((c) => c.nsid);
    expect(carolReads).toContain('com.atproto.sync.getLatestCommit');
    expect(carolReads).toContain('com.atproto.sync.getBlocks');
    // r10 reached the index as a Jetstream commit event carrying the signer's CID.
    expect(
      a.seed.events
        .filter((e) => e.kind === 'commit' && e.did === CAROL)
        .map((e) => (e.kind === 'commit' ? [e.commit.operation, e.commit.rkey, e.commit.cid] : null)),
    ).toEqual([['create', 'r10', seeded?.cid]]);

    expect(
      await a.inDo((db) => ({
        row: db.one('SELECT uri, cid, did FROM scrobbles WHERE did = ?', CAROL),
        state: db.one('SELECT state FROM record_state WHERE uri = ?', r10),
        user: db.one('SELECT active, indexing_state FROM users WHERE did = ?', CAROL),
      })),
    ).toEqual({
      row: { uri: r10, cid: seeded?.cid, did: CAROL },
      state: { state: 'present' },
      user: { active: 1, indexing_state: 'current' },
    });
    const lookup = await a.request(`/api/v1/scrobbles/${enc(r10)}`);
    expect(lookup.status).toBe(200);
    expect((lookup.body as Json).scrobble).toMatchObject({
      uri: r10,
      cid: seeded?.cid,
      did: CAROL,
      artist: 'Portishead',
      track: 'Roads',
      album: 'Dummy',
    });
    const status = await a.request(`/api/v1/records/status?uri=${enc(r10)}`);
    expect(status.body).toMatchObject({ uri: r10, state: 'indexed', cid: seeded?.cid });
    expect(await feed(a)).toEqual(GLOBAL_FEED);

    // A further external commit by Carol: one Jetstream event, one getRecord proof, no write.
    const commit = await inSocket(a, () =>
      a.kit.externalPut('Carol', SCROBBLE, 'r11', scrobble('Glory Box', '2026-01-15T11:55:00Z')),
    );
    expect(await a.inDo(hintCount)).toBe(1);
    expect(await a.alarm()).toBe(true);
    expect(await a.inDo((db) => db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(CAROL, 'r11')))).toEqual({
      cid: commit.ops[0]?.cid,
    });
    expect(a.kit.pds.Carol.calls.entries.map((c) => c.nsid)).toEqual([GET_RECORD]);
    expect(await feed(a)).toEqual(['r11', 'r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
  });

  it('bad signature / changed block / wrong MST path leave projection and cursor byte-identical', async () => {
    const a = await seedAcceptance('rejections');
    // A record version the index has not seen: its Jetstream event is already
    // durable as a hint (and the checkpoint cursor moved with it).
    const put = await inSocket(a, () =>
      a.kit.externalPut('Alice', SCROBBLE, 'x01', scrobble('Teardrop', '2026-01-15T11:59:30Z', 'Massive Attack')),
    );
    const x01 = uriOf(ALICE, 'x01');
    const recordCid = put.ops[0]?.cid as string;
    const valid = await a.kit.repos.Alice.getRecordCar(SCROBBLE, 'x01');
    // A real signed proof at the same head, but for another key: its MST path does not lead to x01.
    const otherPath = await a.kit.repos.Alice.getRecordCar(SCROBBLE, 'r07');

    const page1 = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    const cursor = (page1.body as Json).nextCursor as string;
    const page2 = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(cursor)}`);
    expect(page2.status).toBe(200);
    const before = await a.inDo(projectionTables);
    const checkpoint = before.ingest_checkpoint;

    const cases = [
      { kind: 'bad signature', car: await corruptSignature(valid), counter: 'bad_signature', plc: 1 },
      { kind: 'changed block', car: corruptBlockByte(valid, recordCid), counter: 'cid_mismatch', plc: 0 },
      { kind: 'wrong MST path', car: otherPath, counter: 'missing_block', plc: 0 },
    ];
    for (const c of cases) {
      a.kit.resetCalls();
      a.kit.pds.Alice.fail({ nsid: GET_RECORD }, { kind: 'respond', respond: () => carResponse(c.car) });
      const failedBefore = await a.inDo((db) => counter(db, 'verify_failed', c.counter));
      // The hint is due (its backoff is at most a few seconds); one drain works it.
      await a.alarmsUntil((db) => counter(db, 'verify_failed', c.counter) === failedBefore + 1, { max: 10 });

      // Fail closed: projection and checkpoint (cursor included) byte-identical.
      const after = await a.inDo(projectionTables);
      expect([c.kind, JSON.stringify(after)]).toEqual([c.kind, JSON.stringify(before)]);
      expect(after.ingest_checkpoint).toEqual(checkpoint);
      expect(await a.inDo((db) => db.one('SELECT uri FROM scrobbles WHERE uri = ?', x01))).toBeNull();
      // Exactly one proof fetch; a signature failure re-resolves the key once (fresh), never more.
      expect([c.kind, a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })]).toEqual([c.kind, 1]);
      expect([c.kind, a.kit.plc.calls.entries.length]).toEqual([c.kind, c.plc]);
      // A cursor issued before the rejection continues byte-identically.
      // (Only the page's indexing lag may move: the clock advanced past the hint's backoff.)
      const again = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(cursor)}`);
      expect([c.kind, again.status, pageBytes(again.body)]).toEqual([c.kind, 200, pageBytes(page2.body)]);
      // The record never became visible.
      expect((await a.request(`/api/v1/scrobbles/${enc(x01)}`)).status).toBe(404);
    }
    // An incomplete MST path is never "absent": it hands the DID to a range snapshot (F4).
    expect(
      await a.inDo((db) =>
        db.all("SELECT did, reason FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')"),
      ),
    ).toEqual([{ did: ALICE, reason: 'missing_block' }]);

    // Served valid, the same record applies (through the snapshot of the signed head or the retried hint).
    a.kit.resetCalls();
    await a.alarmsUntil((db) => db.one('SELECT 1 AS x FROM scrobbles WHERE uri = ?', x01) !== null && settled(db));
    expect(await a.inDo((db) => db.one('SELECT cid FROM scrobbles WHERE uri = ?', x01))).toEqual({ cid: recordCid });
    const fresh = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    expect(rkeys(fresh.body)).toEqual(['x01', 'r07']);
    // The pre-rejection cursor still pages below its anchor: x01 arrived above it.
    const resumed = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(cursor)}`);
    expect(pageBytes(resumed.body)).toBe(pageBytes(page2.body));
    // Nothing invalid entered: the projection differs from `before` by exactly x01.
    const final = await a.inDo(projectionTables);
    expect((final.scrobbles as Array<{ uri: string }>).map((r) => r.uri).filter((u) => u !== x01)).toEqual(
      (before.scrobbles as Array<{ uri: string }>).map((r) => r.uri),
    );
  });

  it('a valid hint still applies after each rejected case', async () => {
    // TESTING.md "Rejection-matrix tables rule", ADR 0004 §10.4: each case
    // changes one invariant, leaves the projection and checkpoint tables
    // byte-identical, and is then followed by a valid hint that applies
    // through the same production socket, drain and verifier.
    const a = await seedAcceptance('rejections-then-valid');
    const put = await inSocket(a, () =>
      a.kit.externalPut('Alice', SCROBBLE, 'x01', scrobble('Teardrop', '2026-01-15T11:59:30Z', 'Massive Attack')),
    );
    const x01 = uriOf(ALICE, 'x01');
    const recordCid = put.ops[0]?.cid as string;
    const valid = await a.kit.repos.Alice.getRecordCar(SCROBBLE, 'x01');
    const otherPath = await a.kit.repos.Alice.getRecordCar(SCROBBLE, 'r07');
    const cases = [
      { kind: 'bad signature', car: await corruptSignature(valid), counter: 'bad_signature' },
      { kind: 'changed block', car: corruptBlockByte(valid, recordCid), counter: 'cid_mismatch' },
      { kind: 'wrong MST path', car: otherPath, counter: 'missing_block' },
    ];
    const scrobbleUris = (t: Record<string, unknown[]>) => (t.scrobbles as Array<{ uri: string }>).map((r) => r.uri);
    const appliedValid: string[] = [];

    for (const [i, c] of cases.entries()) {
      // The rejection. For the whole case Alice's PDS keeps serving the
      // corrupted proof for her getRecord, and a 503 for her other sync
      // reads (the range snapshot a wrong MST path hands her DID to), so
      // x01's backed-off hint can never apply while the valid hint runs.
      const before = await a.inDo(projectionTables);
      a.kit.resetCalls();
      a.kit.pds.Alice.faults.clear();
      a.kit.pds.Alice.fail(
        { nsid: GET_RECORD, did: ALICE },
        { kind: 'respond', respond: () => carResponse(c.car) },
        Number.POSITIVE_INFINITY,
      );
      a.kit.pds.Alice.fail({ did: ALICE }, { kind: 'status', status: 503 }, Number.POSITIVE_INFINITY);
      const failedBefore = await a.inDo((db) => counter(db, 'verify_failed', c.counter));
      await a.alarmsUntil((db) => counter(db, 'verify_failed', c.counter) === failedBefore + 1, { max: 10 });
      const rejected = await a.inDo(projectionTables);
      expect([c.kind, JSON.stringify(rejected)]).toEqual([c.kind, JSON.stringify(before)]);
      expect([c.kind, a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })]).toEqual([c.kind, 1]);
      expect((await a.request(`/api/v1/scrobbles/${enc(x01)}`)).status).toBe(404);

      // Then a valid hint: a new record by Bob, honestly served, arrives as a
      // Jetstream event and applies through the same drain and verifier.
      const rkey = `v0${i + 1}`;
      const uri = uriOf(BOB, rkey);
      const commit = await inSocket(a, () =>
        a.kit.externalPut('Bob', SCROBBLE, rkey, scrobble(`Valid ${i + 1}`, `2026-01-15T11:5${i}:00Z`, 'Björk')),
      );
      expect([c.kind, await a.inDo((db) => db.one('SELECT uri FROM hints WHERE uri = ?', uri))]).toEqual([
        c.kind,
        { uri },
      ]);
      a.kit.resetCalls();
      await a.alarmsUntil((db) => db.one('SELECT 1 AS x FROM scrobbles WHERE uri = ?', uri) !== null, { max: 10 });
      appliedValid.push(uri);

      // Applied with the signer's CID after exactly one proof of Bob's record.
      const row = await a.inDo((db) => db.one('SELECT uri, cid, did, artist FROM scrobbles WHERE uri = ?', uri));
      expect([c.kind, row]).toEqual([c.kind, { uri, cid: commit.ops[0]?.cid, did: BOB, artist: 'Björk' }]);
      expect([c.kind, a.kit.pds.Bob.calls.filter({ nsid: GET_RECORD }).map((x) => x.status)]).toEqual([c.kind, [200]]);
      // Whatever Alice's PDS was asked meanwhile was refused, and x01 is still absent.
      expect([c.kind, a.kit.pds.Alice.calls.entries.filter((x) => x.nsid !== GET_RECORD && x.status !== 503)]).toEqual([
        c.kind,
        [],
      ]);
      expect(await a.inDo((db) => db.one('SELECT uri FROM scrobbles WHERE uri = ?', x01))).toBeNull();
      // The projection differs from the rejected one by exactly the valid record.
      const after = await a.inDo(projectionTables);
      expect([c.kind, scrobbleUris(after).filter((u) => u !== uri)]).toEqual([c.kind, scrobbleUris(rejected)]);
      const states = (t: Record<string, unknown[]>) =>
        (t.record_state as Array<{ uri: string }>).filter((r) => r.uri !== uri);
      expect([c.kind, states(after)]).toEqual([c.kind, states(rejected)]);
      expect([c.kind, after.follows, after.suppression]).toEqual([c.kind, rejected.follows, rejected.suppression]);
      // It is public: the lookup and records/status answer through the Worker (schema-checked).
      const lookup = await a.request(`/api/v1/scrobbles/${enc(uri)}`);
      expect([c.kind, lookup.status, (lookup.body as Json).scrobble.cid]).toEqual([c.kind, 200, commit.ops[0]?.cid]);
      const status = await a.request(`/api/v1/records/status?uri=${enc(uri)}`);
      expect([c.kind, (status.body as Json).state]).toEqual([c.kind, 'indexed']);
    }

    // Every valid record of the matrix is in the global feed; x01 is not.
    const items = rkeys((await a.request('/api/v1/feed?scope=global&limit=100')).body);
    expect(items.filter((k) => k.startsWith('v0')).sort()).toEqual(['v01', 'v02', 'v03']);
    expect(items).not.toContain('x01');
    expect(appliedValid).toEqual([uriOf(BOB, 'v01'), uriOf(BOB, 'v02'), uriOf(BOB, 'v03')]);

    // With Alice's PDS honest again, x01 itself converges to the signer's CID.
    a.kit.pds.Alice.faults.clear();
    a.kit.resetCalls();
    await a.alarmsUntil((db) => db.one('SELECT 1 AS x FROM scrobbles WHERE uri = ?', x01) !== null && settled(db), {
      max: 200,
    });
    expect(await a.inDo((db) => db.one('SELECT cid FROM scrobbles WHERE uri = ?', x01))).toEqual({ cid: recordCid });
  });

  it('settings disabled disconnects Carol; settings deleted reconnects after snapshot', async () => {
    const a = await seedAcceptance('settings');
    const settingsUri = uriOf(CAROL, 'self', SETTINGS);
    const carolFollowRkey = await followRkey(ALICE);

    // Carol also follows Alice, so the disconnect has an actor follow to delete.
    await inSocket(a, () =>
      a.kit.externalPut('Carol', FOLLOW, carolFollowRkey, {
        $type: FOLLOW,
        subject: ALICE,
        createdAt: '2026-01-15T11:59:00Z',
      }),
    );
    await a.alarmsUntil((db) => hintCount(db) === 0);
    const profileOf = (did: string) => a.request(`/api/v1/users/${did}/profile`);
    expect(((await profileOf(ALICE)).body as Json).followerCount).toBe(1);

    // Disconnect: the signed opt-out record, then its proof through the drain.
    const disabled = await inSocket(a, () =>
      a.kit.externalPut('Carol', SETTINGS, 'self', {
        $type: SETTINGS,
        indexing: 'disabled',
        createdAt: '2026-01-15T12:00:00Z',
      }),
    );
    a.kit.resetCalls();
    await a.alarmsUntil((db) => hintCount(db) === 0);
    const suppressed = await a.inDo((db) => ({
      suppression: db.all('SELECT did, settings_uri, settings_rev FROM suppression'),
      users: db.all('SELECT did FROM users ORDER BY did'),
      carol: {
        scrobbles: count(db, 'SELECT count(*) AS n FROM scrobbles WHERE did = ?', CAROL),
        follows: count(db, 'SELECT count(*) AS n FROM follows WHERE actor = ?', CAROL),
        state: count(db, "SELECT count(*) AS n FROM record_state WHERE uri LIKE 'at://' || ? || '/%'", CAROL),
        jobs: count(db, 'SELECT count(*) AS n FROM repo_jobs WHERE did = ?', CAROL),
        hints: count(db, 'SELECT count(*) AS n FROM hints WHERE did = ?', CAROL),
        stats: count(db, 'SELECT count(*) AS n FROM stats_cache WHERE did = ?', CAROL),
      },
      others: count(db, 'SELECT count(*) AS n FROM scrobbles WHERE did != ?', CAROL),
    }));
    expect(suppressed).toEqual({
      suppression: [{ did: CAROL, settings_uri: settingsUri, settings_rev: disabled.rev }],
      users: [{ did: ALICE }, { did: BOB }],
      carol: { scrobbles: 0, follows: 0, state: 0, jobs: 0, hints: 0, stats: 0 },
      others: 8,
    });
    expect(a.kit.pds.Carol.calls.count({ nsid: GET_RECORD })).toBe(1);
    expect((await profileOf(CAROL)).status).toBe(404);
    expect((await a.request(`/api/v1/users/${CAROL}/export`)).status).toBe(404);
    expect(await feed(a)).toEqual(['r09', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(((await profileOf(ALICE)).body as Json).followerCount).toBe(0);
    const r10Status = await a.request(`/api/v1/records/status?uri=${enc(uriOf(CAROL, 'r10'))}`);
    expect(r10Status.body).toMatchObject({ state: 'unknown', indexing: { state: 'suppressed' } });

    // While suppressed, only settings hints are processed: a new scrobble (by
    // Jetstream and by notify) is accepted and ignored, with no proof fetch.
    await inSocket(a, () =>
      a.kit.externalPut('Carol', SCROBBLE, 'r12', scrobble('Sour Times', '2026-01-15T11:58:00Z')),
    );
    const notified = await a.postJson('/api/v1/notify', { uri: uriOf(CAROL, 'r12') });
    expect([notified.status, notified.body]).toEqual([202, { state: 'queued' }]);
    a.kit.resetCalls();
    await a.alarmsUntil((db) => hintCount(db) === 0);
    expect(a.kit.pds.Carol.calls.entries).toEqual([]);
    expect(await a.inDo((db) => count(db, 'SELECT count(*) AS n FROM scrobbles WHERE did = ?', CAROL))).toBe(0);

    // Reconnect: Carol deletes the opt-out. Its verified absence lifts the
    // suppression and admits a fresh snapshot; she stays hidden until it completes.
    const reconnected = await inSocket(a, () => a.kit.externalDelete('Carol', SETTINGS, 'self'));
    a.kit.resetCalls();
    await a.alarmsUntil((db) => db.one('SELECT 1 AS x FROM suppression WHERE did = ?', CAROL) === null);
    const lifted = await a.inDo((db) => ({
      user: db.one('SELECT active, indexing_state FROM users WHERE did = ?', CAROL),
      jobs: db.all(
        "SELECT state FROM repo_jobs WHERE did = ? AND kind = 'snapshot' AND state IN ('pending','running','failed')",
        CAROL,
      ),
      settings: db.one('SELECT state, revision FROM record_state WHERE uri = ?', settingsUri),
    }));
    expect(lifted.user).toEqual({ active: 0, indexing_state: 'recovering' });
    expect(lifted.jobs.length).toBe(1);
    expect((await profileOf(CAROL)).status).toBe(404);
    expect(await feed(a)).toEqual(['r09', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);

    await a.alarmsUntil((db) => settled(db));
    expect(
      await a.inDo((db) => ({
        user: db.one('SELECT active, indexing_state FROM users WHERE did = ?', CAROL),
        scrobbles: db.all<{ uri: string }>('SELECT uri FROM scrobbles WHERE did = ? ORDER BY uri', CAROL),
        follows: db.all('SELECT uri FROM follows WHERE actor = ?', CAROL),
        suppression: db.all('SELECT did FROM suppression'),
      })),
    ).toEqual({
      user: { active: 1, indexing_state: 'current' },
      scrobbles: [{ uri: uriOf(CAROL, 'r10') }, { uri: uriOf(CAROL, 'r12') }],
      follows: [{ uri: uriOf(CAROL, carolFollowRkey, FOLLOW) }],
      suppression: [],
    });
    // The snapshot read Carol's signed head (the one her settings delete produced).
    expect(a.kit.pds.Carol.calls.count({ nsid: 'com.atproto.sync.getLatestCommit' })).toBe(1);
    expect(a.kit.repos.Carol.head?.rev).toBe(reconnected.rev);
    const carol = await profileOf(CAROL);
    expect(carol.status).toBe(200);
    expect(carol.body).toMatchObject({ totalScrobbles: 2, followingCount: 1, indexing: { state: 'current' } });
    expect(((await profileOf(ALICE)).body as Json).followerCount).toBe(1);
    expect(await feed(a)).toEqual(['r12', 'r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
  });

  it('duplicate events, socket drop and expired cursor converge to the exact URI/CID/payload set with no double-counted stats', async () => {
    const a = await seedAcceptance('convergence');
    const baseline = await a.inDo(projectionTables);
    const statsOf = async (did: string) => {
      const r = await a.request(`/api/v1/users/${did}/stats?window=all&limit=100`);
      expect(r.status).toBe(200);
      const b = r.body as Json;
      return [b.totalScrobbles, b.distinctArtists, b.distinctTracks];
    };
    expect(await statsOf(ALICE)).toEqual([7, 3, 6]);

    // 1. Duplicate delivery: every seeding event arrives a second time on the live socket.
    await a.inDo(() => {
      for (const e of a.seed.events) a.js.last().send(e);
    });
    await a.alarmsUntil((db) => hintCount(db) === 0);
    // Duplicate hints coalesce per URI: one proof per distinct record of the
    // twelve events (r01–r10, the follow; r08's create and delete are one URI),
    // no snapshot and no write.
    const pdsCalls = (nsid: string) =>
      a.kit.pds.Alice.calls.count({ nsid }) +
      a.kit.pds.Bob.calls.count({ nsid }) +
      a.kit.pds.Carol.calls.count({ nsid });
    expect(a.seed.events.length).toBe(12);
    expect(pdsCalls(GET_RECORD)).toBe(11);
    expect(pdsCalls('com.atproto.sync.getBlocks')).toBe(0);
    expect(APP_WRITES.map(pdsCalls)).toEqual([0, 0, 0]);
    const dup = await a.inDo(projectionTables);
    expect(dup.scrobbles).toEqual(baseline.scrobbles);
    expect(dup.follows).toEqual(baseline.follows);
    expect(dup.record_state).toEqual(baseline.record_state);
    expect(await statsOf(ALICE)).toEqual([7, 3, 6]);

    // 2. Socket drop: commits made while it is down arrive by inclusive cursor replay.
    await a.inDo(() => a.js.last().close(1001, 'fixture drop'));
    await a.inDo(async () => {
      await a.kit.createRecord('Alice', SCROBBLE, 'r11', scrobble('Hunter', '2026-01-15T11:59:00Z', 'Björk'));
      await a.kit.externalPut('Carol', SCROBBLE, 'r12', scrobble('Sour Times', '2026-01-15T11:57:00Z'));
    });
    expect(a.js.live()).toEqual([]);
    const attempts = a.js.attempts.length;
    await a.alarmsUntil(
      (db) => count(db, 'SELECT count(*) AS n FROM scrobbles WHERE rkey IN (?, ?)', 'r11', 'r12') === 2,
    );
    const replay = a.js.attempts.slice(attempts).filter((x) => x.status === 101);
    expect(replay.length).toBe(1);
    // It resumed from the cursor stored before the drop (Jetstream replays inclusively).
    const stored = baseline.ingest_checkpoint as Array<{ cursor: number }>;
    expect(replay[0]?.cursor).toBe(stored[0]?.cursor);
    expect(stored[0]?.cursor).toBe(a.seed.events.at(-1)?.seq);

    // 3. Expired cursor: down while Bob writes, for longer than this Jetstream
    // instance retains events (1 h here, inside the index's own 24 h lookback,
    // so it is Jetstream that refuses the stored cursor).
    await a.inDo(() => a.js.last().close(1001, 'fixture drop'));
    const r13 = await a.inDo(() =>
      a.kit.createRecord('Bob', SCROBBLE, 'r13', scrobble('Angel', '2026-01-15T11:56:00Z', 'Massive Attack')),
    );
    a.kit.jetstream.lookbackHours = 1;
    a.kit.clock.advance(2 * 3_600_000);
    const before = a.js.attempts.length;
    a.kit.resetCalls();
    await a.alarmsUntil(
      (db) => count(db, 'SELECT count(*) AS n FROM scrobbles WHERE rkey = ?', 'r13') === 1 && settled(db),
      { max: 120 },
    );
    const refused = a.js.attempts.slice(before);
    // The stored cursor was refused (OutdatedCursor), then the socket resumed at the live tail.
    expect(refused[0]?.status).toBe(400);
    expect(refused.some((x) => x.status === 101 && x.cursor === null)).toBe(true);
    expect(await a.inDo((db) => counter(db, 'gap_recovery'))).toBe(2);
    // Gap recovery re-snapshotted every known active DID once, at its signed head.
    expect(
      (['Alice', 'Bob', 'Carol'] as const).map((n) =>
        a.kit.pds[n].calls.count({ nsid: 'com.atproto.sync.getLatestCommit' }),
      ),
    ).toEqual([1, 1, 1]);
    expect(APP_WRITES.map(pdsCalls)).toEqual([0, 0, 0]);

    // Converged: exactly the signer's current records, URI, CID and payload.
    const expected: Array<{ uri: string; cid: string; artist: string; track: string }> = [];
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      for (const r of await a.kit.repos[name].list(SCROBBLE)) {
        const v = r.value as { artist: string; track: string };
        expected.push({ uri: uriOf(a.kit.users[name].did, r.rkey), cid: r.cid, artist: v.artist, track: v.track });
      }
    }
    expected.sort((x, y) => (x.uri < y.uri ? -1 : 1));
    expect(expected.map((e) => rkeyOf(e.uri))).toEqual([
      'r01',
      'r02',
      'r03',
      'r04',
      'r05',
      'r06',
      'r07',
      'r11',
      'r09',
      'r13',
      'r10',
      'r12',
    ]);
    expect(await a.inDo((db) => db.all('SELECT uri, cid, artist, track FROM scrobbles ORDER BY uri'))).toEqual(
      expected,
    );
    expect(expected.find((e) => rkeyOf(e.uri) === 'r13')?.cid).toBe(r13.cid);
    const follows = await a.inDo((db) => db.all('SELECT uri FROM follows'));
    expect(follows).toEqual([{ uri: uriOf(ALICE, await followRkey(BOB), FOLLOW) }]);

    // No listen counted twice.
    expect(await statsOf(ALICE)).toEqual([8, 3, 7]);
    expect(await statsOf(BOB)).toEqual([2, 1, 2]);
    expect(await statsOf(CAROL)).toEqual([2, 1, 2]);
    expect(await a.inDo((db) => count(db, 'SELECT count(*) AS n FROM scrobbles'))).toBe(12);
  });
});
