// N3-11 (ADR 0005 §6.2, §6.5, §8.4): the projection of the new optional
// scrobble fields. A verified scrobble fills the migration-2 columns from the
// fields its validated record kept (remote spelling), album_artist_key (the
// artist music key of albumArtist) and recording_msid (UUIDv5 of artist_key ‖
// U+0000 ‖ track_key, which every projected scrobble has, §8.4/§8.6); the v1
// columns are written exactly as before. The /api/v1 stats keep grouping by
// (artist_key, album_key) (ADR 0004 §9.1), so records that gain albumArtist
// change no /api/v1 stats response.
//
// Proofs come from real signed repositories through the production verifier
// (verifyRecordProof over the record CAR). The stats case runs the composed
// Node app over the fixture network (tests/fixtures/read_models.json) and
// reads /api/v1/users/{did}/stats over HTTP; expectations are hardcoded.

import { createHash } from 'node:crypto';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { createFixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { recordingMsid } from '@atmusic/core/msid';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db } from '../../../src/do/db';
import { type ApplyOptions, applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { recordingMsidOf, sha1 } from '../../../src/do/write/keys';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, type TestApp } from '../support/app';
import { withMigratedDb } from '../support/node-db';

const P = 'com.example.atmusic';
const SCROBBLE = `${P}.scrobble`;
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW_NS = fromMs(NOW_MS);
const NOW = toStorage(NOW_NS);
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: P, nowNs: NOW_NS };
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(closeApps);

/** The v1 scrobble columns (ADR 0004 schema) except the per-record uri, rkey, cid and revision. */
const V1_COLUMNS = [
  'did',
  'artist',
  'track',
  'album',
  'listened_at',
  'created_at',
  'duration_seconds',
  'recording_mbid',
  'indexed_at',
  'artist_key',
  'track_key',
  'album_key',
] as const;
/** The migration-2 columns (ADR 0005 §6.4) other than recording_msid. */
const FIELD_COLUMNS = [
  'album_artist',
  'album_artist_key',
  'track_number',
  'artist_mbids',
  'release_mbid',
  'release_group_mbid',
  'isrc',
  'submission_client',
  'music_service',
] as const;

const BASE = {
  $type: SCROBBLE,
  artist: '  Björk ',
  track: 'Jóga',
  album: 'Homogenic',
  listenedAt: '2026-01-15T11:00:00Z',
  createdAt: '2026-01-15T11:00:00Z',
  durationSeconds: 305,
  recordingMbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae',
};
const FIELDS = {
  albumArtist: ' Björk  & Friends ',
  trackNumber: 3,
  artistMbids: ['87c5dedd-371d-4a53-9f7f-80522fb7f3cb', 'A74B1B7F-71A5-4011-9441-D0B5E4122711'],
  releaseMbid: 'D2E7A5B1-1C3F-4B8E-9A6D-0F1E2D3C4B5A',
  releaseGroupMbid: '0c9d0b0e-2f6a-4c3b-8d7e-6f5a4b3c2d1e',
  isrc: 'GBAYE0601498',
  submissionClient: 'Navidrome 0.53.3',
  musicService: 'spotify.com',
};

/** The v1 columns of BASE as SQLite quote() literals: exact bytes and storage types. */
const BASE_V1_LITERALS = [
  `'${ALICE}'`,
  "'  Björk '",
  "'Jóga'",
  "'Homogenic'",
  "'2026-01-15T11:00:00.000000000Z'",
  "'2026-01-15T11:00:00.000000000Z'",
  '305',
  "'8f3471b5-7e6a-48da-86a9-c1c07a0f47ae'",
  `'${NOW}'`,
  "'björk'",
  "'jóga'",
  "'homogenic'",
];

async function repoOf(did: string, key: 'alice' | 'bob'): Promise<SignedRepo> {
  const keys = await fixtureKeys();
  return new SignedRepo(did, keys[key], { clock: fixedClock() });
}

async function verified(repo: SignedRepo, collection: string, rkey: string, at?: string): Promise<RecordProof> {
  const car = await repo.getRecordCar(collection, rkey, at === undefined ? {} : { at });
  return verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
}

function seedUser(db: Db, did: string): void {
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', 1)`,
    did,
    NOW,
  );
}

const v1Literals = (db: Db, uri: string) =>
  Object.values(
    db.one<Record<string, string>>(
      `SELECT ${V1_COLUMNS.map((c) => `quote(${c}) AS ${c}`).join(', ')} FROM scrobbles WHERE uri = ?`,
      uri,
    ) ?? {},
  );
const fieldsOf = (db: Db, uri: string) =>
  db.one<Record<string, unknown>>(
    `SELECT ${FIELD_COLUMNS.join(', ')}, recording_msid FROM scrobbles WHERE uri = ?`,
    uri,
  );
const allNull = Object.fromEntries(FIELD_COLUMNS.map((c) => [c, null]));

describe('scrobble field projection', () => {
  it('a verified scrobble with the new fields fills the new columns, album_artist_key and recording_msid; one without them leaves them NULL and the v1 columns byte-identical', async () => {
    // The MSID through core's WebCrypto implementation, independent of the projection's node:crypto one.
    const msid = await recordingMsid(BASE.artist, BASE.track);
    expect(msid).toMatch(UUID_V5);
    expect(recordingMsidOf('björk', 'jóga')).toBe(msid);
    // The projection's synchronous SHA-1: FIPS 180-4 vectors, and OpenSSL for every padding boundary up to 3 blocks.
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(sha1(new Uint8Array()))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
    for (let n = 0; n <= 192; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(hex(sha1(data)), String(n)).toBe(createHash('sha1').update(data).digest('hex'));
    }

    const repo = await repoOf(ALICE, 'alice');
    const withUri = `at://${ALICE}/${SCROBBLE}/r1`;
    const withoutUri = `at://${ALICE}/${SCROBBLE}/r2`;
    const droppedUri = `at://${ALICE}/${SCROBBLE}/r3`;
    await repo.put(SCROBBLE, 'r1', { ...BASE, ...FIELDS });
    const withProof = await verified(repo, SCROBBLE, 'r1');
    await repo.put(SCROBBLE, 'r2', { ...BASE });
    const withoutProof = await verified(repo, SCROBBLE, 'r2');
    // Two invalid new fields (dropped, never fatal) next to a valid one.
    await repo.put(SCROBBLE, 'r3', { ...BASE, albumArtist: 'Björk', isrc: 'gb-aye-06-01498', trackNumber: 0 });
    const droppedProof = await verified(repo, SCROBBLE, 'r3');

    await withMigratedDb(async (db) => {
      seedUser(db, ALICE);
      seedUser(db, BOB);
      for (const proof of [withProof, withoutProof, droppedProof]) {
        expect(db.tx(() => applyRecordProof(db, proof, OPTS))).toMatchObject({ outcome: 'applied' });
      }

      // With the fields: every new column filled, remote spelling kept.
      expect(fieldsOf(db, withUri)).toEqual({
        album_artist: ' Björk  & Friends ',
        album_artist_key: 'björk & friends',
        track_number: 3,
        artist_mbids: '["87c5dedd-371d-4a53-9f7f-80522fb7f3cb","A74B1B7F-71A5-4011-9441-D0B5E4122711"]',
        release_mbid: 'D2E7A5B1-1C3F-4B8E-9A6D-0F1E2D3C4B5A',
        release_group_mbid: '0c9d0b0e-2f6a-4c3b-8d7e-6f5a4b3c2d1e',
        isrc: 'GBAYE0601498',
        submission_client: 'Navidrome 0.53.3',
        music_service: 'spotify.com',
        recording_msid: msid,
      });
      expect(
        db.one('SELECT typeof(track_number) AS t, typeof(artist_mbids) AS m FROM scrobbles WHERE uri = ?', withUri),
      ).toEqual({ t: 'integer', m: 'text' });

      // Without them: every field column and album_artist_key NULL; the MSID is still derived from the keys.
      expect(fieldsOf(db, withoutUri)).toEqual({ ...allNull, recording_msid: msid });
      // Dropped fields are NULL, the valid one is kept.
      expect(fieldsOf(db, droppedUri)).toEqual({
        ...allNull,
        album_artist: 'Björk',
        album_artist_key: 'björk',
        recording_msid: msid,
      });

      // The v1 columns are byte-identical whatever new fields the record carries.
      expect(v1Literals(db, withoutUri)).toEqual(BASE_V1_LITERALS);
      expect(v1Literals(db, withUri)).toEqual(BASE_V1_LITERALS);
      expect(v1Literals(db, droppedUri)).toEqual(BASE_V1_LITERALS);

      // A newer revision of r1 without the fields clears them; the v1 columns stay the same.
      await repo.put(SCROBBLE, 'r1', { ...BASE });
      const cleared = await verified(repo, SCROBBLE, 'r1');
      expect(db.tx(() => applyRecordProof(db, cleared, OPTS))).toMatchObject({ outcome: 'applied' });
      expect(fieldsOf(db, withUri)).toEqual({ ...allNull, recording_msid: msid });
      expect(v1Literals(db, withUri)).toEqual(BASE_V1_LITERALS);

      // The snapshot path projects the same columns.
      const bob = await repoOf(BOB, 'bob');
      const head = await bob.put(SCROBBLE, 's1', { ...BASE, ...FIELDS, artist: 'Kate Bush', track: 'Cloudbusting' });
      const found = await bob.getRecord(SCROBBLE, 's1');
      db.run(
        `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
         VALUES (?, 'snapshot', 'running', 1, 0, ?, ?)`,
        BOB,
        NOW_MS,
        NOW_MS,
      );
      const chunk = db.tx(() =>
        applySnapshotChunk(db, {
          did: BOB,
          generation: 1,
          headRev: head.rev,
          intervalLo: null,
          intervalHi: `${P}/`,
          entries: [{ key: `${SCROBBLE}/s1`, cid: found!.cid, record: found!.value }],
          receiptNs: NOW_NS,
          prefix: P,
          nowNs: NOW_NS,
        }),
      );
      expect(chunk).toEqual({ outcome: 'applied', written: 1, unchanged: 0, deleted: 0 });
      expect(fieldsOf(db, `at://${BOB}/${SCROBBLE}/s1`)).toMatchObject({
        album_artist: ' Björk  & Friends ',
        album_artist_key: 'björk & friends',
        track_number: 3,
        isrc: 'GBAYE0601498',
        recording_msid: await recordingMsid('Kate Bush', 'Cloudbusting'),
      });
    });
  });

  it('/api/v1 stats for the shared fixture are unchanged after records gain albumArtist', async () => {
    const kit = await createFixtureKit();
    const seed = await seedReadModels(kit);
    const app = await startApp({ transport: kit.transport, clock: kit.clock });
    for (const name of ['Alice', 'Bob', 'Carol'] as const) seedUser(app.db, kit.users[name].did);
    let drained = 0;
    const drain = async () => {
      // Every Jetstream commit not yet applied: its record CAR at that commit, verified, then applied.
      for (; drained < kit.jetstream.events.length; drained++) {
        const ev = kit.jetstream.events[drained]!;
        if (ev.kind !== 'commit') continue;
        const user = kit.user(ev.did);
        const repo = kit.repos[user.name];
        const commit = repo.history.find((c) => c.rev === ev.commit.rev)!;
        const car = await repo.getRecordCar(ev.commit.collection, ev.commit.rkey, { at: commit.cid });
        const proof = await verifyRecordProof(car, {
          did: ev.did,
          collection: ev.commit.collection,
          rkey: ev.commit.rkey,
          signingKey: user.key.didKey,
        });
        app.db.tx(() => applyRecordProof(app.db, proof, OPTS));
      }
    };
    await drain();
    expect(seed.records.size).toBeGreaterThan(0);

    const alice = kit.users.Alice.did;
    const windows = ['all', '7d', '30d', '365d'] as const;
    const read = async (a: TestApp) => {
      const out: Record<string, unknown> = {};
      for (const window of windows) {
        const path = `/api/v1/users/${alice}/stats?window=${window}&limit=10`;
        const res = await a.fetch(path);
        const body = await res.json();
        expect(res.status, window).toBe(200);
        expect(checkResponse('GET', path, { status: res.status, headers: res.headers, body }), window).toBe('valid');
        out[window] = body;
      }
      return out;
    };
    const before = await read(app);
    // Hardcoded from TESTING.md / read_models.json: the v1 stats of Alice.
    for (const window of windows) {
      expect(before[window], window).toMatchObject(fixture.expected.aliceStats[window]);
    }
    // TESTING.md "Exact statistics assertions": the all-window albums, grouped by (artist_key, album_key).
    expect((before.all as { topAlbums: unknown[] }).topAlbums).toEqual([
      { artist: 'Björk', album: 'Homogenic', scrobbleCount: 2 },
      { artist: 'Radiohead', album: 'OK Computer', scrobbleCount: 2 },
      { artist: 'Kate Bush', album: 'Hounds of Love', scrobbleCount: 1 },
      { artist: 'Radiohead', album: 'In Rainbows', scrobbleCount: 1 },
    ]);
    const versionBefore = app.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', alice)!.v;

    // Every confirmed scrobble gains an albumArtist; the two OK Computer listens get different ones,
    // so an album-artist grouping would split that album.
    const albumArtists: Record<string, string> = {
      r01: 'Björk',
      r02: 'Various Artists',
      r03: 'Radiohead',
      r04: 'Radiohead',
      r05: 'Kate Bush',
      r06: 'Kate Bush',
      r07: 'Various Artists',
      r09: 'Massive Attack',
      r10: 'Portishead',
    };
    for (const s of fixture.scrobbles) {
      if (s.state !== 'confirmed') continue;
      const name = kit.user(s.owner).name;
      await kit.externalPut(name, SCROBBLE, s.rkey, { ...s.record, albumArtist: albumArtists[s.rkey] });
    }
    await drain();
    expect(
      app.db.all(
        'SELECT rkey, album_artist FROM scrobbles WHERE did = ? AND album_artist IS NOT NULL ORDER BY rkey',
        alice,
      ),
    ).toHaveLength(7);
    // The projection changed (the stats cache is invalidated) ...
    expect(app.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', alice)!.v).toBeGreaterThan(
      versionBefore,
    );
    // ... and the album-artist grouping really differs from the /api/v1 one on this data.
    const groups = (by: string) =>
      app.db.one<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM scrobbles WHERE did = ? AND album_key IS NOT NULL GROUP BY ${by})`,
        alice,
      )!.n;
    expect(groups('artist_key, album_key')).toBe(4);
    expect(groups('coalesce(album_artist_key, artist_key), album_key')).toBe(6);

    // Every /api/v1 stats response is unchanged, and reading them reaches no remote host.
    kit.resetCalls();
    const after = await read(app);
    expect(after).toEqual(before);
    expect(kit.transport.calls.entries).toHaveLength(0);
  });
});
