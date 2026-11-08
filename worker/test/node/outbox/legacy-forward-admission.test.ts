import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { musicKeyColumns } from '../../../src/do/write/keys';
import { projectionListenKey } from '../../../src/forward/projection';
import { type Harness, LOVE, SCROBBLE, T0, withHarness } from './support';

const BATCH = 'com.example.atmusic.scrobbleBatch';
const LIVE = { random: seededRandom(0x1515) };
const stamp = toStorage(fromMs(T0));

async function proofAt(h: Harness, collection: string, rkey: string) {
  const car = await h.kit.repos.Alice.getRecordCar(collection, rkey);
  return verifyRecordProof(car, {
    did: h.alice,
    collection,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
}

async function proofFor(h: Harness, collection: string, rkey: string) {
  const proof = await proofAt(h, collection, rkey);
  if (proof.state !== 'present') throw new Error(`expected present proof for ${collection}/${rkey}`);
  return proof;
}

function apply(h: Harness, proof: RecordProof) {
  const nowNs = fromMs(h.kit.clock.nowMs());
  return h.db.tx(() =>
    applyRecordProof(h.db, proof, {
      prefix: 'com.example.atmusic',
      nowNs,
      receiptNs: nowNs,
      forwarding: LIVE,
    }),
  );
}

function seedRecordState(h: Harness, uri: string, collection: string, proof: Awaited<ReturnType<typeof proofFor>>) {
  h.db.run(
    `INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at)
     VALUES (?,?,?,?,?,'present',?)`,
    uri,
    h.alice,
    collection,
    proof.commit.rev,
    proof.cid ?? null,
    stamp,
  );
}

function seedScrobbleRow(
  h: Harness,
  args: {
    uri: string;
    recordUri?: string;
    listenId?: string;
    rkey: string;
    revision: string;
    cid: string;
    artist: string;
    track: string;
    album?: string;
    listenedAt: string;
    createdAt: string;
  },
) {
  const keys = musicKeyColumns(args.artist, args.track, args.album ?? null);
  h.db.run(
    `INSERT INTO scrobbles(uri,record_uri,listen_id,cid,did,rkey,revision,artist,track,album,listened_at,created_at,
       indexed_at,artist_key,track_key,album_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args.uri,
    args.recordUri ?? null,
    args.listenId ?? null,
    args.cid,
    h.alice,
    args.rkey,
    args.revision,
    args.artist,
    args.track,
    args.album ?? null,
    toStorage(fromMs(Date.parse(args.listenedAt))),
    toStorage(fromMs(Date.parse(args.createdAt))),
    stamp,
    keys.artist_key,
    keys.track_key,
    keys.album_key,
  );
}

it('upgrades a migration-14 database and conservatively seeds old single, batch, and love projections before live reprojection', async () => {
  await withHarness(
    async (h) => {
      h.seedUser(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');

      const singleRkey = '3klegacy-single';
      const singleUri = `at://${h.alice}/${SCROBBLE}/${singleRkey}`;
      const single = {
        $type: SCROBBLE,
        artist: 'Björk',
        track: 'Jóga',
        album: 'Homogenic',
        listenedAt: '2026-01-14T09:00:00Z',
        createdAt: '2026-01-14T09:00:00Z',
      };
      await h.kit.externalPut('Alice', SCROBBLE, singleRkey, single);
      const oldSingleProof = await proofFor(h, SCROBBLE, singleRkey);
      seedRecordState(h, singleUri, SCROBBLE, oldSingleProof);
      seedScrobbleRow(h, {
        uri: singleUri,
        rkey: singleRkey,
        revision: oldSingleProof.commit.rev,
        cid: oldSingleProof.cid!,
        artist: 'Björk',
        track: 'Jóga',
        album: 'Homogenic',
        listenedAt: single.listenedAt,
        createdAt: single.createdAt,
      });
      const singleIdentity = projectionListenKey(
        h.alice,
        '2026-01-14T09:00:00.000Z',
        musicKeyColumns('Björk', 'Jóga', 'Homogenic').artist_key,
        musicKeyColumns('Björk', 'Jóga', 'Homogenic').track_key,
      );
      h.db.run(
        `INSERT INTO import_jobs(id,did,source,created_at_ms,updated_at_ms) VALUES ('legacy-import',?,'lastfm_json',?,?)`,
        h.alice,
        T0,
        T0,
      );
      h.db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,import_job_id,due_at,created_at_ms,updated_at_ms)
         VALUES ('legacy-import-op',?,'scrobble.create','import',1,?,?, 'legacy-import',?,?,?)`,
        h.alice,
        SCROBBLE,
        singleRkey,
        T0,
        T0,
        T0,
      );
      h.db.run(
        `INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms)
         VALUES (?,?,'legacy-import-op','import',?)`,
        h.alice,
        singleIdentity,
        T0,
      );

      const batchRkey = '3klegacy-batch';
      const batchUri = `at://${h.alice}/${BATCH}/${batchRkey}`;
      const entryId = '3jzfcijpj2z2a';
      const batch = {
        $type: BATCH,
        createdAt: '2026-01-14T10:00:00Z',
        listens: [
          {
            id: entryId,
            artist: 'Radiohead',
            track: 'No Surprises',
            listenedAt: '2026-01-13T10:00:00Z',
            createdAt: '2026-01-13T10:00:00Z',
          },
        ],
      };
      await h.kit.externalPut('Alice', BATCH, batchRkey, batch);
      const oldBatchProof = await proofFor(h, BATCH, batchRkey);
      seedRecordState(h, batchUri, BATCH, oldBatchProof);
      seedScrobbleRow(h, {
        uri: `${batchUri}#${entryId}`,
        recordUri: batchUri,
        listenId: entryId,
        rkey: batchRkey,
        revision: oldBatchProof.commit.rev,
        cid: oldBatchProof.cid!,
        artist: 'Radiohead',
        track: 'No Surprises',
        listenedAt: '2026-01-13T10:00:00Z',
        createdAt: '2026-01-13T10:00:00Z',
      });

      const loveRkey = '3klegacy-love';
      const loveUri = `at://${h.alice}/${LOVE}/${loveRkey}`;
      const love = {
        $type: LOVE,
        artist: 'PJ Harvey',
        track: 'The Desperate Kingdom of Love',
        createdAt: '2026-01-14T11:00:00Z',
      };
      await h.kit.externalPut('Alice', LOVE, loveRkey, love);
      const oldLoveProof = await proofFor(h, LOVE, loveRkey);
      seedRecordState(h, loveUri, LOVE, oldLoveProof);
      const loveKeys = musicKeyColumns(love.artist, love.track, null);
      h.db.run(
        `INSERT INTO loves(uri,did,rkey,cid,artist,track,album,artist_key,track_key,recording_mbid,created_at,indexed_at)
         VALUES (?,?,?,?,?,?,NULL,?,?,NULL,?,?)`,
        loveUri,
        h.alice,
        loveRkey,
        oldLoveProof.cid!,
        love.artist,
        love.track,
        loveKeys.artist_key,
        loveKeys.track_key,
        toStorage(fromMs(Date.parse(love.createdAt))),
        stamp,
      );

      // The target really is an old-schema database: migration 14 has no admission or incarnation tables.
      expect(h.db.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 14 });
      h.restart();
      expect(h.db.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 19 });

      await h.kit.externalPut('Alice', SCROBBLE, singleRkey, { ...single, album: 'Metadata only' });
      expect(apply(h, await proofFor(h, SCROBBLE, singleRkey)).outcome).toBe('applied');
      expect(
        h.db.one<{ path: string; source_service: string | null }>(
          'SELECT path,source_service FROM forward_admissions WHERE did=? AND identity_key=?',
          h.alice,
          singleIdentity,
        ),
      ).toEqual({ path: 'import', source_service: 'lastfm' });

      await h.kit.externalPut('Alice', BATCH, batchRkey, {
        ...batch,
        listens: [{ ...batch.listens[0], track: 'No Surprises (remaster)' }],
      });
      expect(apply(h, await proofFor(h, BATCH, batchRkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='scrobble'")).toEqual([]);

      await h.kit.externalPut('Alice', LOVE, loveRkey, { ...love, track: 'The Desperate Kingdom of Love (edit)' });
      expect(apply(h, await proofFor(h, LOVE, loveRkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind IN ('love','unlove')")).toEqual([]);
      expect(
        h.db.one<{ path: string; state: string }>('SELECT path,state FROM love_incarnations WHERE uri=?', loveUri),
      ).toEqual({
        path: 'snapshot',
        state: 'present',
      });

      // New identities still forward; the upgrade does not globally disable live delivery.
      const newRkey = '3klegacy-newlive';
      await h.kit.externalPut('Alice', SCROBBLE, newRkey, {
        $type: SCROBBLE,
        artist: 'New Artist',
        track: 'New Listen',
        listenedAt: '2026-01-14T12:00:00Z',
        createdAt: '2026-01-14T12:00:00Z',
      });
      expect(apply(h, await proofFor(h, SCROBBLE, newRkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='scrobble'")).toHaveLength(1);

      await h.kit.externalDelete('Alice', LOVE, loveRkey);
      expect(apply(h, await proofAt(h, LOVE, loveRkey)).outcome).toBe('absent');
      await h.kit.externalPut('Alice', LOVE, loveRkey, love);
      expect(apply(h, await proofFor(h, LOVE, loveRkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='love'")).toHaveLength(1);
      expect(
        h.db.one<{ id: string }>('SELECT id FROM linked_accounts WHERE did=? AND service=?', h.alice, 'lastfm')?.id,
      ).toBe(lastfm);
    },
    { migrations: MIGRATIONS.slice(0, 14) },
  );
});

it('legacy absence tombstones seed a snapshot admission idempotently across migration restart', async () => {
  await withHarness(
    async (h) => {
      h.seedUser(h.alice);
      h.link(h.alice, 'lastfm');
      const rkey = '3klegacy-tombstone';
      const uri = `at://${h.alice}/${SCROBBLE}/${rkey}`;
      await h.kit.externalPut('Alice', SCROBBLE, rkey, {
        $type: SCROBBLE,
        artist: 'Old Artist',
        track: 'Old Track',
        listenedAt: '2026-01-14T08:00:00Z',
        createdAt: '2026-01-14T08:00:00Z',
      });
      const oldProof = await proofFor(h, SCROBBLE, rkey);
      h.db.run(
        `INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at)
         VALUES (?,?,?,?,NULL,'absent',?)`,
        uri,
        h.alice,
        SCROBBLE,
        oldProof.commit.rev,
        stamp,
      );
      h.restart();
      await h.kit.externalPut('Alice', SCROBBLE, rkey, {
        $type: SCROBBLE,
        artist: 'Old Artist',
        track: 'Old Track',
        listenedAt: '2026-01-14T08:00:00Z',
        createdAt: '2026-01-14T08:00:00Z',
      });
      const first = await proofFor(h, SCROBBLE, rkey);
      expect(apply(h, first).outcome).toBe('applied');
      expect(h.db.one('SELECT path FROM forward_admissions WHERE did=?', h.alice)).toEqual({ path: 'snapshot' });
      h.restart();
      await h.kit.externalPut('Alice', SCROBBLE, rkey, {
        $type: SCROBBLE,
        artist: 'Old Artist',
        track: 'Old Track (metadata)',
        listenedAt: '2026-01-14T08:00:00Z',
        createdAt: '2026-01-14T08:00:00Z',
      });
      expect(apply(h, await proofFor(h, SCROBBLE, rkey)).outcome).toBe('applied');
      expect(h.db.all('SELECT * FROM forward_outbox')).toEqual([]);
      expect(h.db.all('SELECT path FROM forward_admissions')).toHaveLength(2);
    },
    { migrations: MIGRATIONS.slice(0, 14) },
  );
});

it('a love recreation after a migration-14 absence boundary is admitted once, then metadata reprojection stays quiet', async () => {
  await withHarness(
    async (h) => {
      h.seedUser(h.alice);
      h.link(h.alice, 'lastfm');
      const rkey = '3klegacy-love-recreate';
      const uri = `at://${h.alice}/${LOVE}/${rkey}`;
      const oldLove = {
        $type: LOVE,
        artist: 'PJ Harvey',
        track: 'The River',
        createdAt: '2026-01-13T11:00:00Z',
      };
      await h.kit.externalPut('Alice', LOVE, rkey, oldLove);
      await proofFor(h, LOVE, rkey);
      await h.kit.externalDelete('Alice', LOVE, rkey);
      const absence = await proofAt(h, LOVE, rkey);
      expect(absence.state).toBe('absent');
      h.db.run(
        `INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at)
         VALUES (?,?,?,?,NULL,'absent',?)`,
        uri,
        h.alice,
        LOVE,
        absence.commit.rev,
        stamp,
      );

      h.restart();
      await h.kit.externalPut('Alice', LOVE, rkey, { ...oldLove, track: 'The River (recreated)' });
      expect(apply(h, await proofFor(h, LOVE, rkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='love'")).toHaveLength(1);
      const incarnationKey = h.db.one<{ incarnation_key: string }>(
        'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
        uri,
      )!.incarnation_key;

      h.restart();
      await h.kit.externalPut('Alice', LOVE, rkey, { ...oldLove, track: 'The River (metadata)' });
      expect(apply(h, await proofFor(h, LOVE, rkey)).outcome).toBe('applied');
      expect(h.db.all("SELECT kind FROM forward_outbox WHERE kind='love'")).toHaveLength(1);
      expect(h.db.one('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)).toEqual({
        incarnation_key: incarnationKey,
      });
    },
    { migrations: MIGRATIONS.slice(0, 14) },
  );
});
