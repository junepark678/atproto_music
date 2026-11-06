// N3-11 (ADR 0005 §6.3, §6.5): `<p>.love` records project into `loves`
// behind the same guards as scrobbles and follows, through both the live
// proof path (applyRecordProof) and the snapshot path (applySnapshotChunk),
// and a love URI is accepted by GET /api/v1/records/status and
// POST /api/v1/notify and reaches `indexed` once the drain has verified it.
//
// Every proof is a real signed repository commit (SignedRepo, deterministic
// fixture keys) read back through the production verifier
// (verifyRecordProof over the record CAR); nothing invents a CID or a rev.
// The HTTP case runs the composed Node app over the fixture network (fake
// PDS, PLC and DoH behind the injected transport): no external network.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { createFixtureKit } from '@atmusic/atproto/test-support/read-models';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp } from '../support/app';
import { withMigratedDb } from '../support/node-db';

const P = 'com.example.atmusic';
const LOVE = `${P}.love`;
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW_NS = fromMs(NOW_MS);
const NOW = toStorage(NOW_NS);
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: P, nowNs: NOW_NS };
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';

afterEach(closeApps);

function love(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: LOVE,
    artist: '  Björk ',
    track: 'Jóga',
    album: 'Homogenic',
    recordingMbid: MBID,
    createdAt: '2026-01-15T11:00:00Z',
    ...fields,
  };
}

/** A known, visible account at generation 1 (what admission plus a completed snapshot leave). */
function seedUser(db: Db, did: string): void {
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', 1)`,
    did,
    NOW,
  );
}

async function repoOf(did: string, key: 'alice' | 'bob'): Promise<SignedRepo> {
  const keys = await fixtureKeys();
  return new SignedRepo(did, keys[key], { clock: fixedClock() });
}

/** The production verifier over the record CAR at commit `at` (default: the head). */
async function verified(repo: SignedRepo, rkey: string, at?: string): Promise<RecordProof> {
  const car = await repo.getRecordCar(LOVE, rkey, at === undefined ? {} : { at });
  return verifyRecordProof(car, { did: repo.did, collection: LOVE, rkey, signingKey: repo.key.didKey });
}

const apply = (db: Db, proof: RecordProof) => db.tx(() => applyRecordProof(db, proof, OPTS)).outcome;
const loves = (db: Db) => db.all('SELECT * FROM loves ORDER BY uri');
const state = (db: Db, uri: string) =>
  db.one('SELECT collection, revision, cid, state, reason FROM record_state WHERE uri = ?', uri);
const statsVersion = (db: Db, did: string) =>
  db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did = ?', did)?.stats_version;

describe('love projection', () => {
  it('a verified love record projects into loves; its verified absence removes it; an older revision never resurrects it', async () => {
    const repo = await repoOf(ALICE, 'alice');
    const rkey = '3mchjvhag2a22';
    const uri = `at://${ALICE}/${LOVE}/${rkey}`;
    const put = await repo.put(LOVE, rkey, love());
    const present = await verified(repo, rkey);
    expect(present).toMatchObject({ state: 'present', commit: { rev: put.rev } });
    const del = await repo.delete(LOVE, rkey);
    const absent = await verified(repo, rkey);
    expect(absent).toMatchObject({ state: 'absent', commit: { rev: del.rev } });
    expect(del.rev > put.rev).toBe(true);
    // The older present proof, re-read from the older commit.
    const older = await verified(repo, rkey, put.cid);
    expect(older).toMatchObject({ state: 'present', commit: { rev: put.rev } });

    await withMigratedDb(async (db) => {
      seedUser(db, ALICE);
      seedUser(db, BOB);

      // Live path. Present and valid: one row, raw spelling, production keys.
      expect(apply(db, present)).toBe('applied');
      const cid = present.state === 'present' ? present.cid : '';
      expect(loves(db)).toEqual([
        {
          uri,
          did: ALICE,
          rkey,
          cid,
          artist: '  Björk ',
          track: 'Jóga',
          album: 'Homogenic',
          artist_key: 'björk',
          track_key: 'jóga',
          recording_mbid: MBID,
          created_at: '2026-01-15T11:00:00.000000000Z',
          indexed_at: NOW,
        },
      ]);
      expect(state(db, uri)).toEqual({ collection: LOVE, revision: put.rev, cid, state: 'present', reason: null });
      // A love is not a scrobble: the /api/v1 stats version does not move.
      expect(statsVersion(db, ALICE)).toBe(0);
      // The same proof again is behind the record_state guard: nothing changes.
      expect(apply(db, present)).toBe('noop_older');
      expect(loves(db)).toHaveLength(1);

      // Verified absence: the row is deleted and the URI recorded absent at the newer rev.
      expect(apply(db, absent)).toBe('absent');
      expect(loves(db)).toEqual([]);
      expect(state(db, uri)).toEqual({ collection: LOVE, revision: del.rev, cid: null, state: 'absent', reason: null });

      // The older present proof never resurrects it (per-DID floor), nor does a replay of the absence change anything.
      expect(apply(db, older)).toBe('stale_head');
      expect(apply(db, absent)).toBe('noop_older');
      expect(loves(db)).toEqual([]);
      expect(state(db, uri)).toMatchObject({ revision: del.rev, state: 'absent' });

      // An invalid love (empty artist after trim) is excluded with its reason and never projected.
      const badKey = '3mchjvhag2b22';
      await repo.put(LOVE, badKey, love({ artist: '   ' }));
      expect(apply(db, await verified(repo, badKey))).toBe('excluded');
      expect(loves(db)).toEqual([]);
      expect(state(db, `at://${ALICE}/${LOVE}/${badKey}`)).toMatchObject({ state: 'excluded' });
      expect(
        db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'excluded' AND label LIKE 'artist:%'")
          ?.value,
      ).toBe(1);

      // Snapshot path, for Bob: a chunk at head h1 projects his love; a chunk
      // at h2 without it sweeps it to absent; his h1 proof cannot bring it back.
      const bob = await repoOf(BOB, 'bob');
      const bobKey = '3mchjvhag2c22';
      const bobUri = `at://${BOB}/${LOVE}/${bobKey}`;
      const h1 = await bob.put(LOVE, bobKey, love({ artist: 'Kate Bush', track: 'Cloudbusting', album: undefined }));
      const bobProof = await verified(bob, bobKey);
      const found = await bob.getRecord(LOVE, bobKey);
      expect(found).not.toBeNull();
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
         VALUES (?, 'snapshot', 'running', 1, 0, ?, ?)`,
        BOB,
        NOW_MS,
        NOW_MS,
      );
      const chunk = (headRev: string, entries: { key: string; cid: string; record?: unknown }[]) =>
        db.tx(() =>
          applySnapshotChunk(db, {
            did: BOB,
            generation: 1,
            headRev,
            intervalLo: null,
            intervalHi: `${P}/`,
            entries,
            receiptNs: NOW_NS,
            prefix: P,
            nowNs: NOW_NS,
          }),
        );
      expect(chunk(h1.rev, [{ key: `${LOVE}/${bobKey}`, cid: found!.cid, record: found!.value }])).toEqual({
        outcome: 'applied',
        written: 1,
        unchanged: 0,
        deleted: 0,
      });
      expect(db.all('SELECT uri, cid, artist, album, artist_key, track_key FROM loves WHERE did = ?', BOB)).toEqual([
        {
          uri: bobUri,
          cid: found!.cid,
          artist: 'Kate Bush',
          album: null,
          artist_key: 'kate bush',
          track_key: 'cloudbusting',
        },
      ]);
      expect(state(db, bobUri)).toMatchObject({ revision: h1.rev, state: 'present', cid: found!.cid });

      const h2 = await bob.delete(LOVE, bobKey);
      expect(chunk(h2.rev, [])).toEqual({ outcome: 'applied', written: 0, unchanged: 0, deleted: 1 });
      expect(db.all('SELECT uri FROM loves WHERE did = ?', BOB)).toEqual([]);
      expect(state(db, bobUri)).toEqual({
        collection: LOVE,
        revision: h2.rev,
        cid: null,
        state: 'absent',
        reason: null,
      });
      // The older head's chunk and the older live proof both leave it absent.
      expect(chunk(h1.rev, [{ key: `${LOVE}/${bobKey}`, cid: found!.cid, record: found!.value }])).toMatchObject({
        outcome: 'stale',
        written: 0,
      });
      expect(apply(db, bobProof)).toBe('stale_head');
      expect(db.all('SELECT uri FROM loves WHERE did = ?', BOB)).toEqual([]);
      expect(state(db, bobUri)).toMatchObject({ revision: h2.rev, state: 'absent' });
      expect(statsVersion(db, BOB)).toBe(0);
    });
  });

  it('a love URI passes /api/v1/records/status and /api/v1/notify validation and reports indexed after its proof', async () => {
    const kit = await createFixtureKit();
    const app = await startApp({ transport: kit.transport, clock: kit.clock });
    const alice = kit.users.Alice.did;
    seedUser(app.db, alice);
    const rkey = '3mchjvhag2d22';
    const uri = `at://${alice}/${LOVE}/${rkey}`;
    const status = async (target: string) => {
      const res = await app.fetch(`/api/v1/records/status?uri=${encodeURIComponent(target)}`);
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, headers: res.headers, body };
    };
    const notify = async (body: unknown) => {
      const res = await app.fetch('/api/v1/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
    };

    // Negative control: a collection that is not configured is still 422 fields.uri on both routes.
    const other = `at://${alice}/${P}.playlist/${rkey}`;
    const otherStatus = await status(other);
    expect(otherStatus.status).toBe(422);
    expect(otherStatus.body).toMatchObject({
      error: { code: 'validation_failed', fields: { uri: expect.any(String) } },
    });
    const otherNotify = await notify({ uri: other });
    expect(otherNotify.status).toBe(422);
    expect(otherNotify.body).toMatchObject({
      error: { code: 'validation_failed', fields: { uri: expect.any(String) } },
    });

    // The love URI is admitted: unknown before anything is known of it.
    const before = await status(uri);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ uri, state: 'unknown' });
    expect(checkResponse('GET', '/api/v1/records/status', before)).toBe('valid');

    // Another app writes the love on Alice's PDS; notify queues a verification hint.
    const commit = await kit.externalPut('Alice', LOVE, rkey, love());
    const queued = await notify({ uri });
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ state: 'queued' });
    expect(checkResponse('POST', '/api/v1/notify', queued)).toBe('valid');
    expect(app.db.all('SELECT uri, collection, source FROM hints')).toEqual([
      { uri, collection: LOVE, source: 'notify' },
    ]);
    const pending = await status(uri);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ uri, state: 'pending' });
    expect(app.db.all('SELECT uri FROM loves')).toEqual([]);

    // The drain fetches the record proof from the fake PDS, verifies it and applies it.
    kit.resetCalls();
    await app.composed.core.runAlarmNow();
    expect(kit.pds.Alice.count('com.atproto.sync.getRecord', alice)).toBe(1);
    const record = await kit.repos.Alice.getRecord(LOVE, rkey);
    expect(app.db.all('SELECT uri, cid, artist_key, track_key FROM loves')).toEqual([
      { uri, cid: record!.cid, artist_key: 'björk', track_key: 'jóga' },
    ]);
    const indexed = await status(uri);
    expect(indexed.status).toBe(200);
    expect(indexed.body).toMatchObject({ uri, state: 'indexed', cid: record!.cid, revision: commit.rev });
    expect(indexed.headers.get('cache-control')).toBe('no-store');
    expect(checkResponse('GET', '/api/v1/records/status', indexed)).toBe('valid');
    expect(app.db.all('SELECT uri FROM hints')).toEqual([]);
  });
});
