import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '@atmusic/atproto/transport';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { albumKey, trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import { createBox } from '../../../src/crypto/box';
import type { Db, SqlParam } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { LOVE_BRIDGE_EXCLUSION_SQL, runLinkBackfill } from '../../../src/forward/backfill';
import { saveLink } from '../../../src/forward/links';
import { resolveLoveRecording } from '../../../src/forward/love-recording';
import { RETAINED_RECORD_PROVENANCE_SQL, retainedRecordProvenance } from '../../../src/forward/projection';
import { createJob, IMPORT_FETCH_CAPS, type ImportRuntime, intervalPacer, runImports } from '../../../src/imports/jobs';
import { fsUploadStore } from '../../../src/imports/uploads';
import { writeSlice } from '../../../src/imports/writer';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { LOVE, T0, withHarness } from '../outbox/support';
import { testSecretsDocument } from '../support/app';

const TRACK = { artist: 'Example Artist', track: 'Example Song', album: 'Example Album' };
const FALLBACK_TRACK = { artist: 'Example Artist', track: 'Fallback Song', album: 'Fallback Album' };
const IMPORTED_TRACK = { artist: 'Imported Artist', track: 'Imported Song', album: 'Imported Album' };
const MBID = '123e4567-e89b-42d3-a456-426614174000';

function lookupDb(statuses: Record<string, string>, matches: Record<string, string> = {}): Db {
  return {
    all: () => [],
    run: () => ({ rowsWritten: 0 }),
    tx: (fn) => fn(),
    one: (sql: string, ...params: (string | number | null | ArrayBuffer)[]) => {
      const album = String(params[2] ?? '');
      if (sql.includes('recording_mbid')) {
        const recording = matches[album];
        return recording ? { status: 'matched', recording_mbid: recording } : null;
      }
      const status = statuses[album];
      return status ? { status } : null;
    },
  } as Db;
}

const primaryAlbumKey = '';
const fallbackAlbumKey = albumKey(TRACK.artist, TRACK.album)?.[1] ?? '';
let backfillRun = 0;

async function projectLove(
  h: Parameters<Parameters<typeof withHarness>[0]>[0],
  rkey: string,
  createdAt = '2026-01-10T00:00:00Z',
  track = TRACK,
  recordingMbid: string | null = MBID,
) {
  const repo = h.kit.repos.Alice;
  await repo.put(LOVE, rkey, {
    $type: LOVE,
    ...track,
    ...(recordingMbid === null ? {} : { recordingMbid }),
    createdAt,
  });
  const car = await repo.getRecordCar(LOVE, rkey);
  const proof = await verifyRecordProof(car, {
    did: h.alice,
    collection: LOVE,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
  const nowNs = fromMs(T0);
  h.db.tx(() => applyRecordProof(h.db, proof, { prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs }));
  return `at://${h.alice}/${LOVE}/${rkey}`;
}

async function backfill(h: Parameters<Parameters<typeof withHarness>[0]>[0], observeBridge?: () => void) {
  const all = h.db.all.bind(h.db);
  const one = h.db.one.bind(h.db);
  const materialized: string[] = [];
  const scalarSql: string[] = [];
  h.db.all = ((sql: string, ...params: SqlParam[]) => {
    if (/FROM love_import_bridges\b/.test(sql)) materialized.push(sql);
    return all(sql, ...params);
  }) as typeof h.db.all;
  h.db.one = ((sql: string, ...params: SqlParam[]) => {
    if (/FROM love_import_bridges\b/.test(sql)) {
      scalarSql.push(sql);
      observeBridge?.();
    }
    return one(sql, ...params);
  }) as typeof h.db.one;
  let result: number;
  try {
    result = await runLinkBackfill(h.db, seededRandom(934 + backfillRun++), T0);
  } finally {
    h.db.all = all;
    h.db.one = one;
  }
  expect(materialized).toEqual([]);
  for (const sql of scalarSql) expect(sql).toBe(LOVE_BRIDGE_EXCLUSION_SQL);
  return result;
}

function importRuntime(h: Parameters<Parameters<typeof withHarness>[0]>[0]): ImportRuntime {
  const transport = Object.assign(async (req: Request) => h.kit.transport(req), {
    fixture: true as const,
  }) as unknown as Transport;
  return {
    m: h.m,
    uploadDir: join(h.ctx.dir, 'imports'),
    lastfm: null,
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
    pacers: { lastfm: intervalPacer(), listenbrainz: intervalPacer() },
    diskLow: () => false,
    uploads: fsUploadStore,
    box: null,
  };
}

async function importLoveFromLastfm(h: Parameters<Parameters<typeof withHarness>[0]>[0], id: string) {
  const dir = join(h.ctx.dir, 'imports');
  mkdirSync(dir, { recursive: true });
  const content = JSON.stringify([
    {
      recenttracks: {
        track: [
          {
            artist: { '#text': IMPORTED_TRACK.artist },
            name: IMPORTED_TRACK.track,
            album: { '#text': '' },
            date: { uts: '1768003200' },
          },
        ],
      },
    },
  ]);
  const path = join(dir, `${id}.upload`);
  writeFileSync(path, content, { mode: 0o600 });
  createJob(h.db, {
    id,
    did: h.alice,
    source: 'lastfm_json',
    remoteUser: null,
    uploadPath: path,
    uploadBytes: content.length,
    now: T0,
  });
  const runtime = importRuntime(h);
  for (
    let attempt = 0;
    attempt < 10 && h.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id=?', id)?.state !== 'writing';
    attempt++
  ) {
    await runImports(runtime, T0);
  }
  h.db.run("UPDATE import_jobs SET source='lastfm_api' WHERE id=?", id);
  h.db.run(
    `UPDATE import_items SET record_json=json_object('kind','love','input',json_object(
      'artist',?,'track',?,'recordingMbid',?)) WHERE job_id=?`,
    IMPORTED_TRACK.artist,
    IMPORTED_TRACK.track,
    MBID,
    id,
  );
  expect(await writeSlice(h.m, { id, did: h.alice }, T0)).toMatchObject({ created: 1 });
  await h.runUntilIdle();
  for (let attempt = 0; attempt < 10; attempt++) await runImports(runtime, T0);
  const operation = h.ops("kind='love.put'").at(-1);
  if (!operation?.result_uri) throw new Error('imported love has no written PDS URI');
  const rkey = operation.result_uri.slice(operation.result_uri.lastIndexOf('/') + 1);
  const repo = h.kit.repos.Alice;
  const car = await repo.getRecordCar(LOVE, rkey);
  const proof = await verifyRecordProof(car, {
    did: h.alice,
    collection: LOVE,
    rkey,
    signingKey: h.kit.users.Alice.key.didKey,
  });
  const nowNs = fromMs(T0);
  h.db.tx(() => applyRecordProof(h.db, proof, { prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs }));
  return operation.result_uri;
}

describe('backfill love recording eligibility', () => {
  it('uses a matched album-less projection tuple before the album fallback', () => {
    expect(
      resolveLoveRecording(
        lookupDb(
          { [primaryAlbumKey]: 'matched', [fallbackAlbumKey]: 'matched' },
          {
            [primaryAlbumKey]: MBID,
            [fallbackAlbumKey]: '223e4567-e89b-42d3-a456-426614174000',
          },
        ),
        TRACK,
      ),
    ).toEqual({ mbid: MBID });
  });

  it('uses a compatible matched album tuple when the primary tuple has no match', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'unmatched' }, { [fallbackAlbumKey]: MBID }), TRACK),
    ).toEqual({ mbid: MBID });
  });

  it('keeps a pending primary unresolved even when its album fallback is terminal', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'pending', [fallbackAlbumKey]: 'unmatched' }), TRACK),
    ).toEqual({ pending: true });
  });

  it('is terminal only after both primary and album tuples are unmatched', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'unmatched', [fallbackAlbumKey]: 'unmatched' }), TRACK),
    ).toEqual({ terminal: true });
  });

  it('queries the canonical track keys with primary first', () => {
    const queried: string[] = [];
    const db = lookupDb({ [primaryAlbumKey]: 'pending' });
    const originalOne = db.one.bind(db);
    db.one = ((sql: string, ...params: (string | number | null | ArrayBuffer)[]) => {
      if (sql.includes('recording_mbid')) queried.push(String(params[2]));
      return originalOne(sql, ...params);
    }) as Db['one'];
    resolveLoveRecording(db, TRACK);
    expect(queried).toEqual(['', fallbackAlbumKey]);
  });

  it('reconstructs a deleted legacy incarnation during production backfill and forwards once', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const uri = await projectLove(h, 'legacy-reconstruction');
      h.db.run('DELETE FROM love_incarnations WHERE uri=?', uri);
      const link = h.link(h.alice, 'lastfm');

      for (let turn = 0; turn < 3; turn++) await backfill(h);
      await backfill(h);

      expect(h.db.one('SELECT incarnation_key,state,path FROM love_incarnations WHERE uri=?', uri)).toMatchObject({
        incarnation_key: expect.stringMatching(/^love:.*:legacy:/),
        state: 'present',
        path: 'snapshot',
      });
      expect(
        h.db.one('SELECT identity_key FROM forward_admissions WHERE identity_key LIKE ?', `love:${uri}:legacy:%`),
      ).toBeNull();
      expect(
        h.db.all("SELECT kind,payload_json FROM forward_outbox WHERE link_id=? AND kind='love'", link),
      ).toHaveLength(1);
    });
  });

  it('does not replace an existing API incarnation with a synthetic legacy identity', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const link = h.link(h.alice, 'lastfm');
      const accepted = await enqueueLove(h.m, { did: h.alice, input: TRACK, origin: 'web' });
      if (!accepted.ok) throw new Error(JSON.stringify(accepted.reason));
      await h.runUntilIdle();
      const operation = h.op(accepted.operation.id);
      const rkey = operation.result_uri!.slice(operation.result_uri!.lastIndexOf('/') + 1);
      const repo = h.kit.repos.Alice;
      const car = await repo.getRecordCar(LOVE, rkey);
      const proof = await verifyRecordProof(car, {
        did: h.alice,
        collection: LOVE,
        rkey,
        signingKey: h.kit.users.Alice.key.didKey,
      });
      const nowNs = fromMs(T0);
      h.db.tx(() => applyRecordProof(h.db, proof, { prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs }));
      const uri = operation.result_uri!;
      const before = h.db.one<{ incarnation_key: string; path: string }>(
        'SELECT incarnation_key,path FROM love_incarnations WHERE uri=?',
        uri,
      );

      for (let turn = 0; turn < 3; turn++) await backfill(h);

      expect(h.db.one('SELECT incarnation_key,path FROM love_incarnations WHERE uri=?', uri)).toEqual(before);
      expect(before?.path).toBe('api');
      expect(
        h.db.all<{ payload_json: string }>(
          "SELECT payload_json FROM forward_outbox WHERE link_id=? AND kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
          link,
        ),
      ).toHaveLength(0);
    });
  });

  it('does not backfill a love after a signed absence proof marks its incarnation absent', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const uri = await projectLove(h, 'confirmed-absent');
      h.link(h.alice, 'lastfm');
      const repo = h.kit.repos.Alice;
      await repo.delete(LOVE, 'confirmed-absent');
      const car = await repo.getRecordCar(LOVE, 'confirmed-absent');
      const proof = await verifyRecordProof(car, {
        did: h.alice,
        collection: LOVE,
        rkey: 'confirmed-absent',
        signingKey: h.kit.users.Alice.key.didKey,
      });
      const nowNs = fromMs(T0);
      h.db.tx(() => applyRecordProof(h.db, proof, { prefix: 'com.example.atmusic', nowNs, receiptNs: nowNs }));

      for (let turn = 0; turn < 3; turn++) await backfill(h);

      expect(h.db.one('SELECT state FROM love_incarnations WHERE uri=?', uri)).toMatchObject({ state: 'absent' });
      expect(h.db.one('SELECT uri FROM loves WHERE uri=?', uri)).toBeNull();
      expect(
        h.db.all("SELECT kind FROM forward_outbox WHERE kind='love' AND payload_json LIKE '%backfill%'"),
      ).toHaveLength(0);
    });
  });

  it('suppresses a love when explicit API unlove arrives between discovery and settlement', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      await projectLove(h, 'intent-settlement-race');
      h.link(h.alice, 'lastfm');
      expect(await backfill(h)).toBe(1); // discovers and stages the real projected love
      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: TRACK.artist,
        track: TRACK.track,
        origin: 'web',
      });
      expect(unlove.ok).toBe(true);
      await backfill(h); // settlement re-reads the latest explicit intent

      expect(
        h.db
          .all<{ kind: string; payload_json: string }>(
            "SELECT kind,payload_json FROM forward_outbox WHERE kind IN ('love','unlove') ORDER BY rowid",
          )
          .map((r) => r.kind),
      ).toEqual(['unlove']);
    });
  });

  it('suppresses a projected snapshot love when explicit API unlove exists before discovery', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      await projectLove(h, 'intent-before-discovery');
      h.link(h.alice, 'lastfm');
      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: TRACK.artist,
        track: TRACK.track,
        origin: 'web',
      });
      expect(unlove.ok).toBe(true);

      for (let turn = 0; turn < 3; turn++) await backfill(h);

      expect(
        h.db.all<{ kind: string }>(
          "SELECT kind FROM forward_outbox WHERE kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
        ),
      ).toHaveLength(0);
      expect(h.db.all<{ kind: string }>("SELECT kind FROM forward_outbox WHERE kind='unlove'")).toHaveLength(1);
    });
  });

  it('does not let a late first snapshot or legacy reconstruction revive a prior explicit unlove', async () => {
    for (const legacy of [false, true]) {
      await withHarness(async (h) => {
        h.seedUser(h.alice);
        h.link(h.alice, 'lastfm');
        const unlove = await enqueueUnlove(h.m, {
          did: h.alice,
          artist: TRACK.artist,
          track: TRACK.track,
          origin: 'web',
        });
        expect(unlove.ok).toBe(true);
        const uri = await projectLove(h, legacy ? 'late-legacy-proof' : 'late-snapshot-proof');
        if (legacy) h.db.run('DELETE FROM love_incarnations WHERE uri=?', uri);
        await backfill(h);
        await backfill(h);

        expect(
          h.db.all<{ kind: string }>(
            "SELECT kind FROM forward_outbox WHERE kind='love' AND payload_json LIKE '%backfill%'",
          ),
        ).toHaveLength(0);
      });
    }
  });

  it('allows history again when a later explicit API love replaces the unlove intent', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.link(h.alice, 'lastfm');
      const uri = await projectLove(h, 'later-api-love');
      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: TRACK.artist,
        track: TRACK.track,
        origin: 'web',
      });
      expect(unlove.ok).toBe(true);
      const love = await enqueueLove(h.m, {
        did: h.alice,
        input: { artist: TRACK.artist, track: TRACK.track },
        origin: 'web',
      });
      expect(love.ok).toBe(true);
      for (let turn = 0; turn < 3; turn++) await backfill(h);

      expect(
        h.db
          .all<{ kind: string; payload_json: string }>(
            "SELECT kind,payload_json FROM forward_outbox WHERE kind='love' ORDER BY rowid",
          )
          .some((r) => JSON.parse(r.payload_json).origin === 'backfill'),
      ).toBe(true);
      expect(h.db.one('SELECT state FROM love_incarnations WHERE uri=?', uri)).toEqual({ state: 'present' });
    });
  });

  it('documents the alias residual: unlove intent on one title does not suppress a different-title history key', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const link = h.link(h.alice, 'lastfm');
      const unlove = await enqueueUnlove(h.m, {
        did: h.alice,
        artist: TRACK.artist,
        track: TRACK.track,
        origin: 'web',
      });
      expect(unlove.ok).toBe(true);
      const alias = { artist: TRACK.artist, track: 'Example Song (Live)', album: TRACK.album };
      await projectLove(h, 'alias-residual-history', '2026-01-10T00:00:00Z', alias, MBID);

      for (let turn = 0; turn < 3; turn++) await backfill(h);

      expect(
        h.db.all<{ payload_json: string }>(
          "SELECT payload_json FROM forward_outbox WHERE link_id=? AND kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
          link,
        ),
      ).toHaveLength(1);
    });
  });

  it('backfills ListenBrainz loves with the matched primary MBID, falling back only when primary is unmatched', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const link = h.link(h.alice, 'listenbrainz');
      await projectLove(h, 'primary-mbid', '2026-01-10T00:00:02Z');
      await projectLove(h, 'fallback-mbid', '2026-01-10T00:00:01Z', FALLBACK_TRACK, null);
      const [artistKey, trackKeyValue] = trackKey(TRACK.artist, TRACK.track);
      const fallbackArtistTrack = trackKey(FALLBACK_TRACK.artist, FALLBACK_TRACK.track);
      const fallbackAlbum = albumKey(FALLBACK_TRACK.artist, FALLBACK_TRACK.album)![1];
      const fallbackMbid = '223e4567-e89b-42d3-a456-426614174000';
      h.db.run(
        "UPDATE mb_tracks SET status='matched',recording_mbid=? WHERE artist_key=? AND track_key=? AND album_key=''",
        MBID,
        artistKey,
        trackKeyValue,
      );
      h.db.run(
        "UPDATE mb_tracks SET status='unmatched',recording_mbid=NULL WHERE artist_key=? AND track_key=? AND album_key=''",
        fallbackArtistTrack[0],
        fallbackArtistTrack[1],
      );
      h.db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms) VALUES(?,?,?,'matched',?,?)",
        fallbackArtistTrack[0],
        fallbackArtistTrack[1],
        fallbackAlbum,
        fallbackMbid,
        T0,
      );
      await backfill(h);
      await backfill(h);
      await backfill(h);

      const payloads = h.db
        .all<{ payload_json: string }>(
          "SELECT payload_json FROM forward_outbox WHERE link_id=? AND kind='love' AND json_extract(payload_json,'$.origin')='backfill' ORDER BY rowid",
          link,
        )
        .map(({ payload_json }) => JSON.parse(payload_json) as Record<string, unknown>);
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ recordingMbid: MBID, album: TRACK.album, origin: 'backfill' });
      expect(payloads[1]).toMatchObject({
        recordingMbid: fallbackMbid,
        album: FALLBACK_TRACK.album,
        origin: 'backfill',
      });
    });
  });

  it('keeps an imported love excluded from its source link while allowing the other service', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const uri = await projectLove(h, 'snapshot-import-reuse', '2026-01-10T00:00:00Z', IMPORTED_TRACK);
      expect(await importLoveFromLastfm(h, 'l1-source-import-love')).toBe(uri);
      h.account(h.alice);
      const secrets = parseSecrets(testSecretsDocument());
      const linkDeps = {
        db: h.db,
        clock: h.kit.clock,
        random: h.m.random,
        box: createBox(secrets.encryptionKeys, seededRandom(345)),
      };
      const lastfm = saveLink(linkDeps, {
        did: h.alice,
        service: 'lastfm',
        remoteUser: 'imported-user',
        credential: 'session',
      }).link.id;
      const listenbrainz = saveLink(linkDeps, {
        did: h.alice,
        service: 'listenbrainz',
        remoteUser: 'other-user',
        credential: 'token',
      }).link.id;
      expect(h.db.one('SELECT state,source_service FROM love_import_bridges WHERE uri=?', uri)).toMatchObject({
        state: 'bound',
        source_service: 'lastfm',
      });
      const before = h.db.all<{ link_id: string; payload_json: string }>(
        "SELECT link_id,payload_json FROM forward_outbox WHERE kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
      );
      let bridgeReads = 0;
      for (let turn = 0; turn < 8; turn++) await backfill(h, () => bridgeReads++);
      expect(bridgeReads).toBeGreaterThanOrEqual(3);
      expect(
        h.db.one('SELECT backfill_state,backfill_done,backfill_total FROM linked_accounts WHERE id=?', listenbrainz),
      ).toEqual({
        backfill_state: 'done',
        backfill_done: 1,
        backfill_total: 1,
      });
      const rows = h.db.all<{ link_id: string; payload_json: string }>(
        "SELECT link_id,payload_json FROM forward_outbox WHERE kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
      );
      expect(before).toHaveLength(0);
      expect(h.db.one('SELECT uri FROM loves WHERE uri=?', uri)).not.toBeNull();
      expect(h.db.one('SELECT path,source_service,state FROM love_incarnations WHERE uri=?', uri)).toMatchObject({
        path: 'snapshot',
        source_service: null,
        state: 'present',
      });
      expect(rows.map((row) => row.link_id)).toEqual([listenbrainz]);
      expect(rows.some((row) => row.link_id === lastfm)).toBe(false);
    });
  });

  it('treats a bound import bridge with unknown source as excluded from every destination', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const uri = await projectLove(h, 'snapshot-unknown-import', '2026-01-10T00:00:00Z', IMPORTED_TRACK);
      const accepted = await enqueueLove(h.m, {
        did: h.alice,
        input: { ...IMPORTED_TRACK, recordingMbid: MBID },
        origin: 'import',
      });
      if (!accepted.ok) throw new Error(JSON.stringify(accepted.reason));
      await h.runUntilIdle();
      expect(h.op(accepted.operation.id).result_uri).toBe(uri);
      h.account(h.alice);
      const secrets = parseSecrets(testSecretsDocument());
      const linkDeps = {
        db: h.db,
        clock: h.kit.clock,
        random: h.m.random,
        box: createBox(secrets.encryptionKeys, seededRandom(346)),
      };
      const lastfm = saveLink(linkDeps, {
        did: h.alice,
        service: 'lastfm',
        remoteUser: 'unknown-source-lastfm',
        credential: 'session',
      }).link.id;
      const listenbrainz = saveLink(linkDeps, {
        did: h.alice,
        service: 'listenbrainz',
        remoteUser: 'unknown-source-lb',
        credential: 'token',
      }).link.id;
      expect(h.db.one('SELECT state,source_service FROM love_import_bridges WHERE uri=?', uri)).toEqual({
        state: 'bound',
        source_service: null,
      });

      for (let turn = 0; turn < 8; turn++) await backfill(h);

      expect(
        h.db.all<{ link_id: string }>(
          "SELECT link_id FROM forward_outbox WHERE kind='love' AND json_extract(payload_json,'$.origin')='backfill'",
        ),
      ).toEqual([]);
      expect(h.db.one('SELECT backfill_state FROM linked_accounts WHERE id=?', lastfm)).toEqual({
        backfill_state: 'done',
      });
      expect(h.db.one('SELECT backfill_state FROM linked_accounts WHERE id=?', listenbrainz)).toEqual({
        backfill_state: 'done',
      });
    });
  });

  it('uses bounded indexes for retained provenance and import bridge exclusions', async () => {
    await withHarness(async (h) => {
      const provenanceSql = RETAINED_RECORD_PROVENANCE_SQL;
      for (const [id, createdAt, origin] of [
        ['older-target', 1, 'lastfm'],
        ['newer-target', 2, 'lastfm'],
        ['newest-target', 3, 'import'],
      ] as const) {
        h.db.run(
          `INSERT INTO operations
           (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
           VALUES(?,'did:plc:plan-test','love.put',?,0,?,'found-target','succeeded',0,?,?)`,
          id,
          origin,
          LOVE,
          createdAt,
          createdAt,
        );
      }
      for (const rkey of ['missing-target', 'found-target']) {
        const plan = h.db
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${provenanceSql}`, 'did:plc:plan-test', LOVE, rkey)
          .map((row) => row.detail)
          .join(' | ');
        expect(plan).toContain('operations_record_target (did=? AND collection=? AND rkey=?)');
        expect(plan).not.toMatch(/TEMP B-TREE|operations_did_state/);
      }
      expect(
        h.db.one<{ origin: string; source: string | null }>(provenanceSql, 'did:plc:plan-test', LOVE, 'found-target'),
      ).toEqual({ origin: 'import', source: null });

      const one = h.db.one.bind(h.db);
      let productionProbes = 0;
      h.db.one = ((sql: string, ...params: SqlParam[]) => {
        if (sql === RETAINED_RECORD_PROVENANCE_SQL) productionProbes++;
        return one(sql, ...params);
      }) as typeof h.db.one;
      try {
        expect(retainedRecordProvenance(h.db, 'did:plc:plan-test', LOVE, 'found-target')).toEqual({
          path: 'import',
          sourceService: null,
        });
      } finally {
        h.db.one = one;
      }
      expect(productionProbes).toBe(1);
      const bridgeSql = LOVE_BRIDGE_EXCLUSION_SQL;
      const bridgePlan = h.db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${bridgeSql}`,
          h.alice,
          `at://${h.alice}/${LOVE}/rkey`,
          'incarnation',
          2,
        )
        .map((row) => row.detail)
        .join(' | ');
      expect(bridgePlan).toContain('COVERING INDEX love_import_bridges_source_class');
      expect(bridgePlan).toContain('<expr>=?');
      expect(bridgePlan).not.toMatch(/SCAN|TEMP B-TREE/);
    });
  });

  it('matches the source-class index exclusion semantics for known, unknown, and non-text sources', async () => {
    await withHarness(async (h) => {
      const values: Array<string | null | number | ArrayBuffer> = [
        null,
        'lastfm',
        'lastfm_api',
        'lastfm_json',
        'listenbrainz',
        'listenbrainz_api',
        'listenbrainz_zip',
        'spotify',
        '',
        'LASTFM',
        'lastfm ',
        1,
        Uint8Array.from(Buffer.from('lastfm')).buffer,
      ];
      for (const [i, source] of values.entries()) {
        const uri = `at://${h.alice}/${LOVE}/bridge-${i}`;
        h.db.run(
          `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
           VALUES(?,?,?,?,?,'bound',?)`,
          h.alice,
          `op-${i}`,
          uri,
          `inc-${i}`,
          source,
          i,
        );
        for (const [service, destination] of [
          ['lastfm', 1],
          ['listenbrainz', 2],
        ] as const) {
          const actual =
            h.db.one<{ x: number }>(LOVE_BRIDGE_EXCLUSION_SQL, h.alice, uri, `inc-${i}`, destination) !== null;
          const classified =
            typeof source !== 'string'
              ? null
              : ['lastfm', 'lastfm_api', 'lastfm_json'].includes(source)
                ? 'lastfm'
                : ['listenbrainz', 'listenbrainz_api', 'listenbrainz_zip'].includes(source)
                  ? 'listenbrainz'
                  : null;
          expect(actual).toBe(classified === null || classified === service);
        }
      }
    });
  });
});
