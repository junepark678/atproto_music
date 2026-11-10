import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { applyRecordProof, applyRecordTarget, projectedListensOfRecord } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { musicKeyColumns } from '../../../src/do/write/keys';
import { projectionListenKey, retainedRecordProvenance } from '../../../src/forward/projection';
import { type Harness, SCROBBLE, T0, withHarness } from './support';

const BATCH = 'com.example.atmusic.scrobbleBatch';
const PREFIX = 'com.example.atmusic';
const NOW = fromMs(T0);
const stamp = toStorage(NOW);
const LIVE_RANDOM = seededRandom(0xa030);

async function proofAt(h: Harness, collection: string, rkey: string): Promise<RecordProof> {
  const car = await h.kit.repos.Alice.getRecordCar(collection, rkey);
  return verifyRecordProof(car, {
    did: h.alice,
    collection,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
}

function apply(h: Harness, proof: RecordProof, forwarding = true) {
  return h.db.tx(() =>
    applyRecordProof(h.db, proof, {
      prefix: PREFIX,
      nowNs: fromMs(h.kit.clock.nowMs()),
      receiptNs: fromMs(h.kit.clock.nowMs()),
      ...(forwarding ? { forwarding: { random: LIVE_RANDOM } } : {}),
    }),
  );
}

function seedScrobble(
  h: Harness,
  args: {
    uri: string;
    recordUri?: string;
    rkey: string;
    artist: string;
    track: string;
    listenedAt: string;
    cid?: string;
  },
) {
  const keys = musicKeyColumns(args.artist, args.track, null);
  h.db.run(
    `INSERT INTO scrobbles(uri,record_uri,listen_id,cid,did,rkey,revision,artist,track,album,listened_at,created_at,
       indexed_at,artist_key,track_key,album_key,recording_mbid)
     VALUES (?,?,NULL,?,?,?,'3jzfcijpj2z2a',?,?,NULL,?,?,?, ?,?,NULL,NULL)`,
    args.uri,
    args.recordUri ?? null,
    args.cid ?? 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,import_job_id,due_at,created_at_ms,updated_at_ms)
     VALUES ('legacy-op',?,'scrobble.create','import',1,?,?,'legacy-job',?,?,?)`,
    h.alice,
    collection,
    rkey,
    T0,
    T0,
    T0,
  );
}

function seedRecordState(h: Harness, uri: string, collection: string, revision: string, cid: string | null = null) {
  h.db.run(
    `INSERT INTO record_state(uri,did,collection,revision,cid,state,verified_at) VALUES (?,?,?,?,?,'present',?)`,
    uri,
    h.alice,
    collection,
    revision,
    cid,
    stamp,
  );
}

async function forwardingControl(h: Harness) {
  const links = [h.link(h.alice, 'lastfm'), h.link(h.alice, 'listenbrainz')];
  const rkey = '3kpositive-forward-control';
  await h.kit.externalPut('Alice', SCROBBLE, rkey, {
    $type: SCROBBLE,
    artist: 'Fresh control artist',
    track: 'Fresh control track',
    listenedAt: '2026-01-14T07:00:00Z',
    createdAt: '2026-01-14T07:00:00Z',
  });
  expect(apply(h, await proofAt(h, SCROBBLE, rkey)).outcome).toBe('applied');
  const rows = h.db.all<{ id: string; link_id: string; kind: string; dedupe_key: string }>(
    "SELECT id,link_id,kind,dedupe_key FROM forward_outbox WHERE kind='scrobble' ORDER BY link_id",
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.link_id).sort()).toEqual(links.sort());
  expect(new Set(rows.map((row) => row.dedupe_key)).size).toBe(1);
  return rows;
}

it('seeds Last.fm and snapshot admissions before absence so a new rkey does not echo', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const before = await forwardingControl(h);
    const rkey = '3klegacy-removed';
    const uri = `at://${h.alice}/${SCROBBLE}/${rkey}`;
    const body = {
      $type: SCROBBLE,
      artist: 'Legacy Artist',
      track: 'Legacy Track',
      listenedAt: '2026-01-14T08:00:00Z',
      createdAt: '2026-01-14T08:00:00Z',
    };
    await h.kit.externalPut('Alice', SCROBBLE, rkey, body);
    const original = await proofAt(h, SCROBBLE, rkey);
    if (original.state !== 'present') throw new Error('expected present proof');
    seedRecordState(h, uri, SCROBBLE, original.commit.rev, original.cid);
    const identity = seedScrobble(h, {
      uri,
      rkey,
      artist: body.artist,
      track: body.track,
      listenedAt: body.listenedAt,
      cid: original.cid,
    });
    seedImportProvenance(h, SCROBBLE, rkey);

    await h.kit.externalDelete('Alice', SCROBBLE, rkey);
    expect(apply(h, await proofAt(h, SCROBBLE, rkey)).outcome).toBe('absent');
    expect(
      h.db.one('SELECT path,source_service FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, identity),
    ).toEqual({ path: 'import', source_service: 'lastfm' });

    const newRkey = '3klegacy-reprojected';
    await h.kit.externalPut('Alice', SCROBBLE, newRkey, body);
    expect(apply(h, await proofAt(h, SCROBBLE, newRkey)).outcome).toBe('applied');
    expect(
      h.db.all("SELECT id,link_id,kind,dedupe_key FROM forward_outbox WHERE kind='scrobble' ORDER BY link_id"),
    ).toEqual(before);
  });

  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const before = await forwardingControl(h);
    const rkey = '3ksnapshot-removed';
    const uri = `at://${h.alice}/${SCROBBLE}/${rkey}`;
    const listenedAt = '2026-01-14T09:00:00Z';
    await h.kit.externalPut('Alice', SCROBBLE, rkey, {
      $type: SCROBBLE,
      artist: 'Snapshot Artist',
      track: 'Snapshot Track',
      listenedAt,
      createdAt: listenedAt,
    });
    const original = await proofAt(h, SCROBBLE, rkey);
    if (original.state !== 'present') throw new Error('expected present proof');
    seedRecordState(h, uri, SCROBBLE, original.commit.rev, original.cid);
    const identity = seedScrobble(h, {
      uri,
      rkey,
      artist: 'Snapshot Artist',
      track: 'Snapshot Track',
      listenedAt,
      cid: original.cid,
    });
    await h.kit.externalDelete('Alice', SCROBBLE, rkey);
    expect(apply(h, await proofAt(h, SCROBBLE, rkey)).outcome).toBe('absent');
    expect(h.db.one('SELECT path FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, identity)).toEqual({
      path: 'snapshot',
    });
    const newRkey = '3ksnapshot-reprojected';
    await h.kit.externalPut('Alice', SCROBBLE, newRkey, {
      $type: SCROBBLE,
      artist: 'Snapshot Artist',
      track: 'Snapshot Track',
      listenedAt,
      createdAt: listenedAt,
    });
    expect(apply(h, await proofAt(h, SCROBBLE, newRkey)).outcome).toBe('applied');
    expect(
      h.db.all("SELECT id,link_id,kind,dedupe_key FROM forward_outbox WHERE kind='scrobble' ORDER BY link_id"),
    ).toEqual(before);
  });
});

it('seeds excluded versions and snapshot-sweep absence, while leaving an existing live marker unchanged', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const excludedRkey = '3kexcluded-removed';
    const excludedUri = `at://${h.alice}/${SCROBBLE}/${excludedRkey}`;
    await h.kit.externalPut('Alice', SCROBBLE, excludedRkey, {
      $type: SCROBBLE,
      artist: 'Previously Valid',
      track: 'Track',
      listenedAt: '2026-01-14T10:00:00Z',
      createdAt: '2026-01-14T10:00:00Z',
    });
    const old = await proofAt(h, SCROBBLE, excludedRkey);
    if (old.state !== 'present') throw new Error('expected present proof');
    seedRecordState(h, excludedUri, SCROBBLE, old.commit.rev, old.cid);
    const excludedKey = seedScrobble(h, {
      uri: excludedUri,
      rkey: excludedRkey,
      artist: 'Previously Valid',
      track: 'Track',
      listenedAt: '2026-01-14T10:00:00Z',
      cid: old.cid,
    });
    await h.kit.externalPut('Alice', SCROBBLE, excludedRkey, {
      $type: SCROBBLE,
      artist: '',
      track: 'Invalid replacement',
      listenedAt: '2026-01-14T10:00:00Z',
      createdAt: '2026-01-14T10:00:00Z',
    });
    expect(apply(h, await proofAt(h, SCROBBLE, excludedRkey)).outcome).toBe('excluded');
    expect(
      h.db.one('SELECT path FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, excludedKey),
    ).toEqual({
      path: 'snapshot',
    });

    const liveRkey = '3klive-marker-removed';
    const liveUri = `at://${h.alice}/${SCROBBLE}/${liveRkey}`;
    await h.kit.externalPut('Alice', SCROBBLE, liveRkey, {
      $type: SCROBBLE,
      artist: 'Live Artist',
      track: 'Live Track',
      listenedAt: '2026-01-14T11:00:00Z',
      createdAt: '2026-01-14T11:00:00Z',
    });
    const liveProof = await proofAt(h, SCROBBLE, liveRkey);
    if (liveProof.state !== 'present') throw new Error('expected present proof');
    seedRecordState(h, liveUri, SCROBBLE, liveProof.commit.rev, liveProof.cid);
    const liveKey = seedScrobble(h, {
      uri: liveUri,
      rkey: liveRkey,
      artist: 'Live Artist',
      track: 'Live Track',
      listenedAt: '2026-01-14T11:00:00Z',
      cid: liveProof.cid,
    });
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
       VALUES (?,?,'live',NULL,?,77)`,
      h.alice,
      liveKey,
      T0,
    );
    await h.kit.externalDelete('Alice', SCROBBLE, liveRkey);
    expect(apply(h, await proofAt(h, SCROBBLE, liveRkey)).outcome).toBe('absent');
    expect(
      h.db.one('SELECT path,admission_seq FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, liveKey),
    ).toEqual({
      path: 'live',
      admission_seq: 77,
    });

    const sweepRkey = '3ksnapshot-sweep';
    const sweepUri = `at://${h.alice}/${SCROBBLE}/${sweepRkey}`;
    const sweepKey = seedScrobble(h, {
      uri: sweepUri,
      rkey: sweepRkey,
      artist: 'Sweep Artist',
      track: 'Sweep Track',
      listenedAt: '2026-01-14T12:00:00Z',
    });
    seedRecordState(
      h,
      sweepUri,
      SCROBBLE,
      '3jzfcijpj2z2a',
      'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const generation = h.db.one<{ generation: number }>(
      'SELECT generation FROM users WHERE did=?',
      h.alice,
    )!.generation;
    h.db.run(
      `INSERT INTO repo_jobs(did,kind,state,generation,reactivate,due_at,updated_at_ms)
       VALUES (?,'snapshot','running',?,0,?,?)`,
      h.alice,
      generation,
      T0,
      T0,
    );
    h.db.tx(() =>
      applySnapshotChunk(h.db, {
        did: h.alice,
        generation,
        headRev: '3kzfcijpj2z2a',
        intervalLo: `${PREFIX}.`,
        intervalHi: `${PREFIX}/`,
        entries: [],
        receiptNs: NOW,
        prefix: PREFIX,
        nowNs: NOW,
      }),
    );
    expect(h.db.one('SELECT path FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, sweepKey)).toEqual({
      path: 'snapshot',
    });
  });
});

it('admits a small legacy batch once per identity and preserves existing live admission', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3klarge-legacy-batch';
    const uri = `at://${h.alice}/${BATCH}/${rkey}`;
    const keys: string[] = [];
    let duplicateKey = '';
    for (let i = 0; i < 8; i++) {
      const duplicate = i < 2;
      const artist = duplicate ? 'Duplicate Artist' : `Legacy Artist ${i}`;
      const listenedAt = duplicate ? '2026-01-14T01:00:00Z' : `2026-01-14T00:${String(i).padStart(2, '0')}:00Z`;
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
    expect(before).toHaveLength(8);
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
    expect(h.db.all("SELECT path,source_service FROM forward_admissions WHERE path='import'")).toHaveLength(6);
    expect(new Set(keys).size).toBe(7);
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
  });
});
