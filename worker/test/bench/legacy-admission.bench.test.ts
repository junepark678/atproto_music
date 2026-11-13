// Scale fixture for legacy batch admission and indexed provenance queries (ADR 0005 §15.1).
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { applyRecordTarget, projectedListensOfRecord } from '../../src/do/write/apply-record';
import { musicKeyColumns } from '../../src/do/write/keys';
import { projectionListenKey, retainedRecordProvenance } from '../../src/forward/projection';
import { type Harness, SCROBBLE, T0, withHarness } from '../node/outbox/support';

const BATCH = 'com.example.atmusic.scrobbleBatch';
const PREFIX = 'com.example.atmusic';
const NOW = fromMs(T0);
const stamp = toStorage(NOW);

function seedScrobble(
  h: Harness,
  args: { uri: string; recordUri?: string; rkey: string; artist: string; track: string; listenedAt: string },
) {
  const keys = musicKeyColumns(args.artist, args.track, null);
  h.db.run(
    `INSERT INTO scrobbles(uri,record_uri,listen_id,cid,did,rkey,revision,artist,track,album,listened_at,created_at,indexed_at,artist_key,track_key,album_key,recording_mbid) VALUES (?,?,NULL,?,?,?,'3jzfcijpj2z2a',?,?,NULL,?,?,?, ?,?,NULL,NULL)`,
    args.uri,
    args.recordUri ?? null,
    'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    h.alice,
    args.rkey,
    args.artist,
    args.track,
    toStorage(fromMs(Date.parse(args.listenedAt))),
    toStorage(fromMs(Date.parse(args.listenedAt))),
    stamp,
    keys.artist_key,
    keys.track_key,
  );
  return projectionListenKey(h.alice, args.listenedAt, keys.artist_key, keys.track_key);
}
function seedImportProvenance(h: Harness, collection: string, rkey: string) {
  h.db.run(
    `INSERT INTO import_jobs(id,did,source,created_at_ms,updated_at_ms) VALUES ('legacy-job',?,'lastfm_json',?,?)`,
    h.alice,
    T0,
    T0,
  );
  h.db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,import_job_id,due_at,created_at_ms,updated_at_ms) VALUES ('legacy-op',?,'scrobble.create','import',1,?, ?,'legacy-job',?,?,?)`,
    h.alice,
    collection,
    rkey,
    T0,
    T0,
    T0,
  );
}
it('seeds a large batch once per key and uses indexed provenance lookups', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3klarge-legacy-batch';
    const uri = `at://${h.alice}/${BATCH}/${rkey}`;
    const keys: string[] = [];
    let duplicateKey = '';
    for (let i = 0; i < 1000; i++) {
      const duplicate = i < 2;
      const artist = duplicate ? 'Duplicate Artist' : `Legacy Artist ${i}`;
      const listenedAt = duplicate
        ? '2026-01-14T01:00:00Z'
        : `2026-01-14T00:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z`;
      const key = seedScrobble(h, {
        uri: `${uri}#member-${i}`,
        recordUri: uri,
        rkey,
        artist,
        track: duplicate ? 'Duplicate Track' : `Legacy Track ${i}`,
        listenedAt,
      });
      if (duplicate) duplicateKey = key;
      keys.push(key);
    }
    const duplicateSeq = 41;
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES (?,?,'live',NULL,?,?)`,
      h.alice,
      duplicateKey,
      T0,
      duplicateSeq,
    );
    h.db.run('INSERT INTO forward_admission_clock(singleton,next_seq) VALUES (1,?)', duplicateSeq);
    seedImportProvenance(h, BATCH, rkey);

    const originalOne = h.db.one.bind(h.db);
    let provenanceReads = 0;
    h.db.one = ((sql: string, ...params: Parameters<typeof h.db.one> extends [string, ...infer P] ? P : never) => {
      if (sql.includes('FROM operations AS op') && sql.includes('LEFT JOIN import_jobs')) provenanceReads++;
      return originalOne(sql, ...params);
    }) as typeof h.db.one;
    const before = projectedListensOfRecord(h.db, h.alice, uri);
    expect(before).toHaveLength(1000);
    h.db.tx(() =>
      applyRecordTarget(
        h.db,
        { did: h.alice, kind: 'scrobbleBatch', collection: BATCH, rkey, uri, rev: '3kzfcijpj2z2a', present: null },
        { prefix: PREFIX, nowNs: NOW, receiptNs: NOW },
      ),
    );
    h.db.one = originalOne;
    expect(provenanceReads).toBe(1);
    expect(
      h.db.one(
        'SELECT path,admission_seq FROM forward_admissions WHERE did=? AND identity_key=?',
        h.alice,
        duplicateKey,
      ),
    ).toEqual({ path: 'live', admission_seq: duplicateSeq });
    expect(h.db.all("SELECT path,source_service FROM forward_admissions WHERE path='import'")).toHaveLength(998);
    expect(new Set(keys).size).toBe(999);
    expect(retainedRecordProvenance(h.db, h.alice, BATCH, rkey)).toEqual({ path: 'import', sourceService: 'lastfm' });

    const projectionPlan = h.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT uri FROM scrobbles WHERE uri=? AND did=?
       UNION ALL
       SELECT uri FROM scrobbles WHERE record_uri=? AND did=?`,
      uri,
      h.alice,
      uri,
      h.alice,
    );
    expect(projectionPlan.some((row) => row.detail.includes('sqlite_autoindex_scrobbles_1'))).toBe(true);
    expect(projectionPlan.some((row) => row.detail.includes('scrobbles_record_uri'))).toBe(true);
    expect(projectionPlan.some((row) => row.detail.includes('SCAN scrobbles'))).toBe(false);
    expect(projectionPlan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);

    for (let i = 0; i < 1200; i++) {
      h.db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
         VALUES (?,?, 'scrobble.create','web',0,?,?,?, ?,?,?)`,
        `plan-${i}`,
        h.alice,
        SCROBBLE,
        `record-${i}`,
        i % 4 === 0 ? 'succeeded' : i % 4 === 1 ? 'cancelled' : 'queued',
        T0,
        T0 + i,
        T0 + i,
      );
    }
    const planQueries = [
      `SELECT op.origin,jobs.source FROM operations AS op LEFT JOIN import_jobs AS jobs ON jobs.id=op.import_job_id
       WHERE op.did=? AND op.collection=? AND op.rkey=? ORDER BY op.created_at_ms DESC LIMIT 1`,
      `SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1`,
      `SELECT 1 FROM operations WHERE did=? AND collection=? AND rkey=? AND kind='scrobble.delete' AND state='succeeded' LIMIT 1`,
    ];
    for (const sql of planQueries) {
      const details = h.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, h.alice, SCROBBLE, 'record-777');
      expect(details.some((row) => row.detail.includes('operations_record_target'))).toBe(true);
      expect(details.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
      expect(details.some((row) => row.detail.includes('SCAN operations'))).toBe(false);
    }
  });
});
