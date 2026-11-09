import type { RecordProof } from '@atmusic/atproto/verify/types';
import { recordingMsid } from '@atmusic/core/msid';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { recordStatus } from '../../src/do/ingest/notify';
import { exportUser } from '../../src/do/read/export';
import { feed } from '../../src/do/read/feed';
import { history } from '../../src/do/read/history';
import { lookup } from '../../src/do/read/lookup';
import { readProfileCore } from '../../src/do/read/profile';
import { globalTrackCounts, rangeStatsWithCache } from '../../src/do/read/range-stats';
import { listensByTimestamp, recentPage } from '../../src/do/read/recent';
import { computeStatistics } from '../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../src/do/read/visibility';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../src/do/write/apply-snapshot';
import { projectionListenKey } from '../../src/forward/projection';
import { scrobbleDto } from '../../src/http/scrobbles-read';
import { resolveFeedbackTarget } from '../../src/listenbrainz/feedback';
import { withMigratedDb } from '../node/support/node-db';
import {
  ALICE,
  deleteProof,
  liveApplyOptions,
  NOW_NS,
  OPTS,
  PREFIX,
  putProof,
  repoFor,
  scrobble,
  seedSnapshotJob,
  seedUser,
  uriOf,
} from './support';

const BATCH = `${PREFIX}.scrobbleBatch`;
const ID_A = '2222222222222';
const ID_B = '3333333333333';
const ID_C = '5555555555555';
const RKEY_1 = '4444444444444';
const LISTENED_AT = '2026-01-14T11:00:00Z';
const listen = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  ...scrobble({ artist: 'Artist', track: 'Track', listenedAt: LISTENED_AT, ...fields }),
  $type: undefined,
});
const batchRecord = (...listens: Record<string, unknown>[]) => ({
  $type: BATCH,
  createdAt: '2026-01-15T11:00:00Z',
  listens: listens.map(({ $type: _type, ...rest }) => rest),
});
const apply = (db: Db, p: RecordProof) => db.tx(() => applyRecordProof(db, p, OPTS));

describe('batch projection and visibility', () => {
  it('forwards each first-admitted live batch member once across replacement and container moves', async () => {
    const repo = await repoFor('alice');
    const first = await putProof(
      repo,
      BATCH,
      '3lbqbatch01ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' })),
    );
    const moved = await putProof(
      repo,
      BATCH,
      '3lbqbatch02ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' })),
    );
    const added = await putProof(
      repo,
      BATCH,
      '3lbqbatch01ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' }), listen(ID_C, { track: 'Third' })),
    );
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
        VALUES ('batch-link',?,'lastfm','alice',X'00','test',?,?)`,
        ALICE,
        Date.parse('2026-01-15T12:00:00Z'),
        Date.parse('2026-01-15T12:00:00Z'),
      );
      const liveRandom = seededRandom(14);
      db.tx(() => applyRecordProof(db, first, liveApplyOptions(first, liveRandom)));
      expect(db.all("SELECT * FROM forward_outbox WHERE kind='scrobble'")).toHaveLength(2);
      db.tx(() => applyRecordProof(db, moved, liveApplyOptions(moved, liveRandom)));
      expect(db.all("SELECT * FROM forward_outbox WHERE kind='scrobble'")).toHaveLength(2);
      db.tx(() => applyRecordProof(db, added, liveApplyOptions(added, liveRandom, 'update')));
      expect(db.all("SELECT * FROM forward_outbox WHERE kind='scrobble'")).toHaveLength(3);
    });
  });

  it('snapshot batch admissions do not forward, including a later live revision', async () => {
    const repo = await repoFor('alice');
    const first = await putProof(
      repo,
      BATCH,
      '3lbqbatch03ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' })),
    );
    const later = await putProof(
      repo,
      BATCH,
      '3lbqbatch03ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' }), listen(ID_C, { track: 'Third' })),
    );
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
        VALUES ('snapshot-link',?,'lastfm','alice',X'00','test',?,?)`,
        ALICE,
        Date.parse('2026-01-15T12:00:00Z'),
        Date.parse('2026-01-15T12:00:00Z'),
      );
      db.tx(() => applyRecordProof(db, first, OPTS));
      expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
      expect(db.all("SELECT * FROM forward_admissions WHERE path='snapshot'")).toHaveLength(2);
      db.tx(() => applyRecordProof(db, later, liveApplyOptions(later, seededRandom(15), 'update')));
      expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
    });
  });

  it('honors existing API/import member admissions and excludes invalid batch members', async () => {
    const repo = await repoFor('alice');
    const proof = await putProof(
      repo,
      BATCH,
      '3lbqbatch04ab',
      batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' }), listen(ID_C, { track: '   ' })),
    );
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
        VALUES ('marker-link',?,'lastfm','alice',X'00','test',?,?)`,
        ALICE,
        Date.parse('2026-01-15T12:00:00Z'),
        Date.parse('2026-01-15T12:00:00Z'),
      );
      for (const [track, source] of [
        ['Track', 'web'],
        ['Second', 'import'],
      ] as const) {
        const [artistKey, trackKeyValue] = trackKey('Artist', track);
        const key = projectionListenKey(ALICE, LISTENED_AT, artistKey, trackKeyValue);
        db.run(
          'INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms) VALUES (?,?,NULL,?,?)',
          ALICE,
          key,
          source,
          Date.parse('2026-01-15T12:00:00Z'),
        );
      }
      db.tx(() => applyRecordProof(db, proof, liveApplyOptions(proof, seededRandom(16))));
      expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
    });
  });
  it('projects a verified external batch through snapshot, update, delete, and recreation proofs', async () => {
    const repo = await repoFor('alice');
    const rkey = '3lbqbatch01ab';
    const created = await putProof(repo, BATCH, rkey, batchRecord(listen(ID_A)));
    if (created.state !== 'present') throw new Error('expected a present batch proof');
    const snapshotRecord = await repo.getRecord(BATCH, rkey, { at: created.commit.cid });
    expect(snapshotRecord).not.toBeNull();
    const updated = await putProof(repo, BATCH, rkey, batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' })));
    const deleted = await deleteProof(repo, BATCH, rkey);
    const recreated = await putProof(repo, BATCH, rkey, batchRecord(listen(ID_C, { track: 'Again' })));

    await withMigratedDb((db) => {
      const generation = seedUser(db, ALICE);
      seedSnapshotJob(db, ALICE, generation);
      const container = uriOf(ALICE, BATCH, rkey);
      const byUri = () =>
        db.all<{ uri: string }>('SELECT uri FROM scrobbles WHERE record_uri = ? ORDER BY uri', container);
      const statsQuery = {
        did: ALICE,
        entity: 'tracks' as const,
        lower: Date.parse('2026-01-14T00:00:00Z'),
        upper: Date.parse('2026-01-16T00:00:00Z'),
        limit: null,
        offset: 0,
        rangeKey: 'batch-lifecycle',
      };
      const stats = () => rangeStatsWithCache({ db, clock: { nowMs: () => 1768478400000 } }, statsQuery);
      expect(
        db.tx(() =>
          applySnapshotChunk(db, {
            did: ALICE,
            generation,
            headRev: created.commit.rev,
            intervalLo: `${PREFIX}.`,
            intervalHi: `${BATCH}/${rkey}`,
            entries: [{ key: `${BATCH}/${rkey}`, cid: created.cid, record: snapshotRecord!.value }],
            receiptNs: NOW_NS,
            prefix: PREFIX,
            nowNs: NOW_NS,
          }),
        ).outcome,
      ).toBe('applied');
      expect(byUri()).toEqual([{ uri: `${container}#${ID_A}` }]);
      expect(db.all('SELECT artist_key,track_key,album_key FROM mb_tracks')).toEqual([
        { artist_key: 'artist', track_key: 'track', album_key: '' },
      ]);
      const afterCreate = stats();
      expect([afterCreate.cache, afterCreate.stats?.totals.listens]).toEqual(['miss', 1]);
      expect(apply(db, updated).outcome).toBe('applied');
      expect(byUri()).toEqual([{ uri: `${container}#${ID_A}` }, { uri: `${container}#${ID_B}` }]);
      expect(db.all('SELECT artist_key,track_key,album_key FROM mb_tracks ORDER BY track_key')).toEqual([
        { artist_key: 'artist', track_key: 'second', album_key: '' },
        { artist_key: 'artist', track_key: 'track', album_key: '' },
      ]);
      const afterUpdate = stats();
      expect([afterUpdate.cache, afterUpdate.stats?.totals.listens]).toEqual(['miss', 2]);
      expect(apply(db, deleted).outcome).toBe('absent');
      expect(byUri()).toEqual([]);
      const afterDelete = stats();
      expect([afterDelete.cache, afterDelete.stats?.totals.listens]).toEqual(['miss', 0]);
      expect(apply(db, recreated).outcome).toBe('applied');
      expect(byUri()).toEqual([{ uri: `${container}#${ID_C}` }]);
      expect([stats().cache, stats().stats?.totals.listens]).toEqual(['miss', 1]);
      expect(
        exportUser(
          {
            db,
            clock: { nowMs: () => 1768478400000 },
            config: { ingestMode: 'off' },
          } as unknown as ModuleDeps,
          ALICE,
        )?.scrobbles.map((row) => row.listenId),
      ).toEqual([ID_C]);
    });
  });

  it('isolates invalid items, prefers visible singles, restores batches after single delete, and reaffirms exact snapshot keys', async () => {
    const repo = await repoFor('alice');
    const batch = await putProof(
      repo,
      BATCH,
      RKEY_1,
      batchRecord(listen(ID_A), listen(ID_C), listen(ID_B, { artist: '   ' })),
    );
    const single = await putProof(
      repo,
      `${PREFIX}.scrobble`,
      'single',
      scrobble({ artist: ' artist ', track: 'Track', listenedAt: LISTENED_AT }),
    );
    await repo.put(`${PREFIX}.scrobble`, 'unrelated', scrobble({ artist: 'Other', track: 'Title' }));
    const head = repo.head!;
    const currentBatch = await repo.getRecord(BATCH, RKEY_1, { at: head.cid });
    expect(currentBatch).not.toBeNull();
    const deletedSingle = await deleteProof(repo, `${PREFIX}.scrobble`, 'single');

    await withMigratedDb(async (db) => {
      const generation = seedUser(db, ALICE);
      seedSnapshotJob(db, ALICE, generation);
      expect(apply(db, batch).outcome).toBe('applied');
      expect(db.all('SELECT uri,record_uri,listen_id FROM scrobbles ORDER BY uri')).toEqual([
        { uri: `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`, record_uri: uriOf(ALICE, BATCH, RKEY_1), listen_id: ID_A },
        { uri: `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`, record_uri: uriOf(ALICE, BATCH, RKEY_1), listen_id: ID_C },
      ]);
      const duplicateProbe = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT 1 FROM scrobbles one WHERE one.did = ? AND one.record_uri IS NULL
         AND one.artist_key = ? AND one.track_key = ? AND one.listened_at >= ? AND one.listened_at < ?`,
        ALICE,
        'artist',
        'track',
        '2026-01-14T11:00:00',
        '2026-01-14T11:00:00Z',
      );
      expect(duplicateProbe.some((step) => step.detail.includes('scrobbles_single_visibility'))).toBe(true);
      const m = {
        db,
        clock: { nowMs: () => 1768478400000 },
        config: { prefix: PREFIX, ingestMode: 'off' },
      } as unknown as ModuleDeps;
      expect(history(m, { did: ALICE, limit: 10 }).rows.map((r) => r.uri)).toEqual([
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`,
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`,
      ]);
      expect(feed(m, { scope: 'global', limit: 10 }).rows.map((r) => r.uri)).toEqual([
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`,
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`,
      ]);
      expect(recentPage(m, { did: ALICE as never, limit: 10 })?.rows.map((r) => r.uri)).toEqual([
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`,
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`,
      ]);
      expect(listensByTimestamp(m, { did: ALICE as never, count: 10 })?.rows.map((r) => r.uri)).toEqual([
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`,
        `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`,
      ]);
      expect(readProfileCore(db, ALICE, 1768478400000, 'off')?.totalScrobbles).toBe(2);
      expect(computeStatistics(db, ALICE as never, 'all', 10, NOW_NS).totalScrobbles).toBe(2);
      expect(globalTrackCounts(db, 'artist', 'track')).toEqual({ listeners: 1, playcount: 2 });
      expect(exportUser(m, ALICE)?.scrobbles).toHaveLength(2);
      expect(exportUser(m, ALICE)?.scrobbles.find((r) => r.listenId === ID_A)).toMatchObject({
        uri: `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`,
        recordUri: uriOf(ALICE, BATCH, RKEY_1),
        listenId: ID_A,
      });
      const itemUri = `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`;
      expect(lookup(m, itemUri)).toMatchObject({ listen_id: ID_A });
      expect(scrobbleDto(lookup(m, itemUri)!)).toMatchObject({
        recordUri: uriOf(ALICE, BATCH, RKEY_1),
        listenId: ID_A,
      });
      expect(lookup(m, `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_B}`)).toBeNull();
      expect(recordStatus(m, itemUri)).toMatchObject({
        uri: itemUri,
        state: 'indexed',
        cid: batch.state === 'present' ? batch.cid : '',
      });
      const msid = await recordingMsid('Artist', 'Track');
      expect(await resolveFeedbackTarget(m, ALICE, { msid, mbid: null })).toMatchObject({
        source: 'indexed',
        track: 'Track',
      });
      expect(apply(db, single).outcome).toBe('applied');
      const visible = () =>
        db
          .all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.uri`, ALICE)
          .map((r) => r.uri);
      expect(visible()).toEqual([uriOf(ALICE, `${PREFIX}.scrobble`, 'single')]);
      expect(history(m, { did: ALICE, limit: 10 }).rows.map((r) => r.uri)).toEqual([
        uriOf(ALICE, `${PREFIX}.scrobble`, 'single'),
      ]);
      expect(feed(m, { scope: 'global', limit: 10 }).rows.map((r) => r.uri)).toEqual([
        uriOf(ALICE, `${PREFIX}.scrobble`, 'single'),
      ]);
      expect(recentPage(m, { did: ALICE as never, limit: 10 })?.rows.map((r) => r.uri)).toEqual([
        uriOf(ALICE, `${PREFIX}.scrobble`, 'single'),
      ]);
      expect(listensByTimestamp(m, { did: ALICE as never, count: 10 })?.rows.map((r) => r.uri)).toEqual([
        uriOf(ALICE, `${PREFIX}.scrobble`, 'single'),
      ]);
      expect(computeStatistics(db, ALICE as never, 'all', 10, NOW_NS).totalScrobbles).toBe(1);
      expect(globalTrackCounts(db, 'artist', 'track')).toEqual({ listeners: 1, playcount: 1 });
      expect(exportUser(m, ALICE)?.scrobbles).toHaveLength(1);
      expect(await resolveFeedbackTarget(m, ALICE, { msid, mbid: null })).toMatchObject({
        source: 'indexed',
        track: 'Track',
      });
      const chunk = db.tx(() =>
        applySnapshotChunk(db, {
          did: ALICE,
          generation,
          headRev: head.rev,
          intervalLo: `${PREFIX}.`,
          intervalHi: `${BATCH}/${RKEY_1}`,
          entries: [
            { key: `${BATCH}/${RKEY_1}`, cid: batch.state === 'present' ? batch.cid : '', record: currentBatch!.value },
          ],
          receiptNs: NOW_NS,
          prefix: PREFIX,
          nowNs: NOW_NS,
        }),
      );
      expect(chunk).toMatchObject({ outcome: 'applied', written: 0, unchanged: 1 });
      expect(db.one('SELECT revision FROM record_state WHERE uri = ?', uriOf(ALICE, BATCH, RKEY_1))).toEqual({
        revision: head.rev,
      });
      expect(apply(db, deletedSingle).outcome).toBe('absent');
      expect(visible()).toEqual([`${uriOf(ALICE, BATCH, RKEY_1)}#${ID_A}`, `${uriOf(ALICE, BATCH, RKEY_1)}#${ID_C}`]);
    });
  });

  it('sweeps a container absent from a newer signed snapshot, deleting every listen and invalidating stats', async () => {
    const repo = await repoFor('alice');
    const rkey = '3lbqsweep01ab';
    const kept = '3lbqsweep02ab';
    const created = await putProof(repo, BATCH, rkey, batchRecord(listen(ID_A), listen(ID_B, { track: 'Second' })));
    if (created.state !== 'present') throw new Error('expected a present batch proof');
    const keptProof = await putProof(repo, BATCH, kept, batchRecord(listen(ID_C, { track: 'Kept' })));
    if (keptProof.state !== 'present') throw new Error('expected a present batch proof');
    // The remote deletes the first container; only a snapshot (no live delete proof) reports it.
    await repo.delete(BATCH, rkey);
    const head = repo.head!;

    await withMigratedDb((db) => {
      const generation = seedUser(db, ALICE);
      seedSnapshotJob(db, ALICE, generation);
      expect(apply(db, created).outcome).toBe('applied');
      expect(apply(db, keptProof).outcome).toBe('applied');
      const container = uriOf(ALICE, BATCH, rkey);
      const keptUri = uriOf(ALICE, BATCH, kept);
      const visible = () =>
        db
          .all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.uri`, ALICE)
          .map((r) => r.uri);
      expect(visible()).toEqual([`${container}#${ID_A}`, `${container}#${ID_B}`, `${keptUri}#${ID_C}`]);
      const statsBefore = db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did = ?', ALICE)!;

      // A stale snapshot head below an applied container revision is refused by the per-URI guard.
      const stale = db.tx(() =>
        applySnapshotChunk(db, {
          did: ALICE,
          generation,
          headRev: '2222222222222',
          intervalLo: `${PREFIX}.`,
          intervalHi: `${BATCH}/${kept}`,
          entries: [],
          receiptNs: NOW_NS,
          prefix: PREFIX,
          nowNs: NOW_NS,
        }),
      );
      expect(stale).toMatchObject({ outcome: 'applied', deleted: 0 });
      expect(visible()).toHaveLength(3);

      // The kept container is unchanged (same CID, no body): reaffirmed, never swept.
      const chunk = db.tx(() =>
        applySnapshotChunk(db, {
          did: ALICE,
          generation,
          headRev: head.rev,
          intervalLo: `${PREFIX}.`,
          intervalHi: `${BATCH}/${kept}`,
          entries: [{ key: `${BATCH}/${kept}`, cid: keptProof.cid }],
          receiptNs: NOW_NS,
          prefix: PREFIX,
          nowNs: NOW_NS,
        }),
      );
      expect(chunk).toMatchObject({ outcome: 'applied', written: 0, unchanged: 1, deleted: 1 });
      expect(db.all('SELECT uri FROM scrobbles WHERE record_uri = ?', container)).toEqual([]);
      expect(db.one('SELECT state, revision FROM record_state WHERE uri = ?', container)).toEqual({
        state: 'absent',
        revision: head.rev,
      });
      // Fragment URIs never get a record_state row of their own.
      expect(db.one('SELECT count(*) AS n FROM record_state WHERE uri LIKE ?', `${container}#%`)).toEqual({ n: 0 });
      expect(db.one('SELECT revision FROM record_state WHERE uri = ?', keptUri)).toEqual({ revision: head.rev });
      expect(visible()).toEqual([`${keptUri}#${ID_C}`]);
      expect(
        db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did = ?', ALICE)!.stats_version,
      ).toBe(statsBefore.stats_version + 1);
      // An older live proof of the swept container cannot resurrect it.
      expect(apply(db, created).outcome).not.toBe('applied');
      expect(visible()).toEqual([`${keptUri}#${ID_C}`]);
    });
  });

  it('excludes a container when no entries validate or safe byte limits fail, removing old listens', async () => {
    const repo = await repoFor('alice');
    const first = await putProof(repo, BATCH, '5555555555555', batchRecord(listen(ID_A)));
    const partial = await putProof(
      repo,
      BATCH,
      '5555555555555',
      batchRecord(listen(ID_B), listen(ID_A, { listenedAt: 'not-a-date' })),
    );
    const invalid = await putProof(
      repo,
      BATCH,
      '5555555555555',
      batchRecord(listen(ID_B, { listenedAt: 'not-a-date' })),
    );
    // Over the ingest bound (2,000,000 DAG-CBOR bytes, the PDS's commit block limit).
    const oversized = await putProof(repo, BATCH, '6666666666666', {
      ...batchRecord(listen(ID_A)),
      unknown: 'x'.repeat(2_000_000),
    });
    // Above every write limit but within the ingest bound: a valid container another writer committed.
    const large = await putProof(repo, BATCH, '6666666666667', {
      ...batchRecord(listen(ID_A)),
      unknown: 'x'.repeat(1_500_000),
    });
    const deletedRecord = await putProof(repo, BATCH, '7777777777777', batchRecord(listen(ID_A)));
    const deleted = await deleteProof(repo, BATCH, '7777777777777');
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      expect(apply(db, first).outcome).toBe('applied');
      expect(apply(db, partial).outcome).toBe('applied');
      expect(
        db.all<{ listen_id: string }>(
          'SELECT listen_id FROM scrobbles WHERE record_uri = ?',
          uriOf(ALICE, BATCH, '5555555555555'),
        ),
      ).toEqual([{ listen_id: ID_B }]);
      expect(apply(db, invalid).outcome).toBe('excluded');
      expect(db.all('SELECT * FROM scrobbles WHERE record_uri = ?', uriOf(ALICE, BATCH, '5555555555555'))).toEqual([]);
      expect(
        db.one('SELECT state,collection FROM record_state WHERE uri = ?', uriOf(ALICE, BATCH, '5555555555555')),
      ).toEqual({ state: 'excluded', collection: BATCH });
      expect(apply(db, oversized).outcome).toBe('excluded');
      expect(db.all('SELECT * FROM scrobbles WHERE record_uri = ?', uriOf(ALICE, BATCH, '6666666666666'))).toEqual([]);
      expect(apply(db, large).outcome).toBe('applied');
      expect(
        db.all('SELECT listen_id FROM scrobbles WHERE record_uri = ?', uriOf(ALICE, BATCH, '6666666666667')),
      ).toEqual([{ listen_id: ID_A }]);
      expect(apply(db, deletedRecord).outcome).toBe('applied');
      expect(apply(db, deleted).outcome).toBe('absent');
      expect(db.all('SELECT * FROM scrobbles WHERE record_uri = ?', uriOf(ALICE, BATCH, '7777777777777'))).toEqual([]);
      // Five changes as before, plus the large container's projection.
      expect(db.one('SELECT stats_version FROM users WHERE did = ?', ALICE)).toEqual({ stats_version: 6 });
    });
  });

  it('applies partial item suppression and keeps delete intents collection-aware', async () => {
    const repo = await repoFor('alice');
    const proof = await putProof(repo, BATCH, RKEY_1, batchRecord(listen(ID_A), listen(ID_B, { artist: 'Other' })));
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      expect(apply(db, proof).outcome).toBe('applied');
      const container = uriOf(ALICE, BATCH, RKEY_1);
      const visible = () =>
        db
          .all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did = ? ORDER BY s.uri`, ALICE)
          .map((r) => r.uri);
      db.run(
        'INSERT INTO listen_removals(did,record_uri,listen_id,created_at_ms) VALUES(?,?,?,?)',
        ALICE,
        container,
        ID_A,
        1,
      );
      expect(visible()).toEqual([`${container}#${ID_B}`]);
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,due_at,created_at_ms,updated_at_ms)
         VALUES('other-collection',?,'scrobble.delete','web',0,?, ?,1,1,1)`,
        ALICE,
        `${PREFIX}.scrobble`,
        RKEY_1,
      );
      expect(visible()).toEqual([`${container}#${ID_B}`]);
      db.run('DELETE FROM operations WHERE id = ?', 'other-collection');
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,due_at,created_at_ms,updated_at_ms)
         VALUES('batch-delete',?,'scrobble.delete','web',0,?, ?,1,1,1)`,
        ALICE,
        BATCH,
        RKEY_1,
      );
      expect(visible()).toEqual([]);
    });
  });
});
