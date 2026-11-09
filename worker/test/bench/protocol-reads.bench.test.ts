// N5-02: protocol read plans and measurements on one deterministic 100k-listen user.
// Timings are receipts for operators; query-plan and cache-equality checks are gates.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { validateScrobbleRecord } from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import { type ApplyOptions, applyRecordProof, scrobbleFieldColumns } from '../../src/do/write/apply-record';
import { musicKeyColumns } from '../../src/do/write/keys';
import { lastfmRoutes } from '../../src/lastfm/routes';
import { listenBrainzRoutes } from '../../src/listenbrainz/routes';
import { closeApps, startApp, type TestApp } from '../node/support/app';

const PREFIX = 'com.example.atmusic';
const SCROBBLE = `${PREFIX}.scrobble`;
const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const APPLY_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const DIRECT_DID = 'did:plc:cccccccccccccccccccccccc';
const NOW_ISO = '2026-01-15T12:00:00Z';
const NOW = Date.parse(NOW_ISO);
const NOW_NS = fromMs(NOW);
const NOW_STORAGE = toStorage(NOW_NS);
const OPTS: ApplyOptions = { receiptNs: NOW_NS, prefix: PREFIX, nowNs: NOW_NS };
const API_KEY = 'pano-test-key';
const LISTENS = 100_000;
// Exercise bounded visibility history using the current migrated schema.
const CREATE_OPERATIONS = 250;
const HIDDEN_LISTENS = 5;
const VISIBLE_LISTENS = LISTENS - HIDDEN_LISTENS;
const SEED = 0x5eed;
const READS = 10;
// The fixture freezes time, so the per-IP read buckets do not refill. Keep
// READS under Last.fm's 18-request and ListenBrainz's 14-request test budgets.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const COLUMNS = `uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,duration_seconds,
  recording_mbid,indexed_at,artist_key,track_key,album_key,album_artist,album_artist_key,track_number,
  artist_mbids,release_mbid,release_group_mbid,isrc,submission_client,music_service,recording_msid`;
const INSERT = `INSERT INTO scrobbles(${COLUMNS}) VALUES (${Array.from({ length: 26 }, () => '?').join(',')})`;
type Generated = { index: number; record: Record<string, unknown> };
type Captured = { sql: string; params: SqlParam[] };
interface QueryPlanStatement {
  sql: string;
  details: string[];
}
interface ProtocolReadsReport {
  schema: 'atmusic/protocol-reads-benchmark@2';
  generatedBy: string;
  generatedAt: string;
  dataset: {
    listens: number;
    seed: number;
    clock: string;
    applyPathRecords: number;
    operations: {
      total: number;
      scrobbleCreateSucceeded: number;
      scrobbleDelete: {
        queued: number;
        running: number;
        blocked: number;
        failed: number;
        succeededMatchingCid: number;
        succeededStaleCid: number;
      };
      visibleScrobbles: number;
      hiddenScrobbles: number;
    };
  };
  plans: {
    source: string;
    topTracks: QueryPlanStatement[];
    recentTracks: QueryPlanStatement[];
    listenbrainzAllTime: QueryPlanStatement[];
    listeningActivityYear: QueryPlanStatement[];
  };
  reads: {
    topTracks: { cached: ReturnType<typeof timing>; uncached: ReturnType<typeof timing> };
    recentTracksPage500: ReturnType<typeof timing>;
    listenbrainzAllTime: ReturnType<typeof timing>;
    listeningActivityYear: ReturnType<typeof timing>;
  };
}

function user(db: Db, did: string, handle: string, username: string): void {
  db.run(
    `INSERT INTO users(did,handle,joined_at,active,account_status,indexing_state,generation)
          VALUES(?,?,?,1,'active','current',1)`,
    did,
    handle,
    NOW_STORAGE,
  );
  db.run('INSERT INTO accounts(did,username,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', did, username, NOW, NOW);
}

function recordFor(index: number, random: ReturnType<typeof seededRandom>): Generated {
  const pair = Math.floor(random.float() * 1800);
  const artist = pair % 120;
  const track = Math.floor(pair / 120);
  const listenedAt = new Date(NOW - (index + 1) * 360_000).toISOString();
  const record: Record<string, unknown> = {
    $type: SCROBBLE,
    artist: `Artist ${String(artist).padStart(3, '0')}`,
    track: `Track ${String(track).padStart(4, '0')}`,
    listenedAt,
    createdAt: NOW_STORAGE,
    ...(index % 11 === 0 ? {} : { album: `Album ${String(track % 360).padStart(3, '0')}` }),
    ...(index % 5 === 0 ? { durationSeconds: 180 + (index % 240) } : {}),
  };
  return { index, record };
}

function projection(record: Record<string, unknown>) {
  const validated = validateScrobbleRecord(record, PREFIX, NOW_NS);
  if (!validated.ok)
    throw new Error(`benchmark generator produced invalid record: ${JSON.stringify(validated.reason)}`);
  const row = validated.row;
  const keys = musicKeyColumns(row.artist, row.track, row.album);
  const fields = scrobbleFieldColumns(row, keys.artist_key, keys.track_key);
  return { row, keys, fields };
}

type PreparedInsert = { run(...values: (string | number | null)[]): unknown };
function directInsert(db: Db, did: string, item: Generated, prepared?: PreparedInsert): void {
  const { row, keys, fields } = projection(item.record);
  const rkey = `r${String(item.index).padStart(13, '0')}`;
  const values = [
    `at://${did}/${SCROBBLE}/${rkey}`,
    `bafyrei${String(item.index).padStart(48, 'a')}`,
    did,
    rkey,
    '3jzfcijpj2z2a',
    row.artist,
    row.track,
    row.album,
    row.listenedAt,
    row.createdAt,
    row.durationSeconds,
    row.recordingMbid,
    NOW_STORAGE,
    keys.artist_key,
    keys.track_key,
    keys.album_key,
    fields.album_artist,
    fields.album_artist_key,
    fields.track_number,
    fields.artist_mbids,
    fields.release_mbid,
    fields.release_group_mbid,
    fields.isrc,
    fields.submission_client,
    fields.music_service,
    fields.recording_msid,
  ];
  if (prepared) prepared.run(...(values as (string | number | null)[]));
  else db.run(INSERT, ...(values as SqlParam[]));
}

function seedOperations(db: TestApp['db']): void {
  const creates = db.raw.prepare(`INSERT INTO operations(
    id,did,kind,origin,priority,collection,rkey,state,attempts,due_at,created_at_ms,updated_at_ms
  ) VALUES(?,?,'scrobble.create','web',0,?,?,'succeeded',1,?,?,?)`);
  const deletes = db.raw.prepare(`INSERT INTO operations(
    id,did,kind,origin,priority,collection,rkey,state,attempts,due_at,created_at_ms,updated_at_ms,swap_cid
  ) VALUES(?,?,'scrobble.delete','web',0,?,?,?,1,?,?,?,?)`);
  db.tx(() => {
    for (let index = 0; index < CREATE_OPERATIONS; index++) {
      const listenIndex = index * Math.floor(LISTENS / CREATE_OPERATIONS);
      const rkey = `r${String(listenIndex).padStart(13, '0')}`;
      creates.run(`bench-create-${index}`, DID, SCROBBLE, rkey, NOW, NOW, NOW);
    }
    const deleteCases = [
      { id: 'queued', index: 0, state: 'queued' },
      { id: 'running', index: 1, state: 'running' },
      { id: 'blocked', index: 2, state: 'blocked' },
      { id: 'failed', index: 3, state: 'failed' },
      { id: 'succeeded-matching', index: 4, state: 'succeeded' },
      { id: 'succeeded-stale', index: 5, state: 'succeeded' },
    ] as const;
    for (const item of deleteCases) {
      const rkey = `r${String(item.index).padStart(13, '0')}`;
      const cid = `bafyrei${String(item.index).padStart(48, 'a')}`;
      deletes.run(
        `bench-delete-${item.id}`,
        DID,
        SCROBBLE,
        rkey,
        item.state,
        NOW,
        NOW,
        NOW,
        item.id === 'succeeded-stale' ? `${cid}-stale` : cid,
      );
    }
  });
}

function plans(db: Db, statements: Captured[]): QueryPlanStatement[] {
  return statements.map((statement) => ({
    sql: statement.sql,
    details: db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.params)
      .map((r) => r.detail),
  }));
}

const nearest = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]!;
function timing(samples: number[]) {
  return { runs: samples.length, p50Ms: nearest(samples, 0.5), p95Ms: nearest(samples, 0.95) };
}
async function measure(
  fn: () => Promise<unknown>,
  runs = READS,
  beforeEach?: () => void,
): Promise<ReturnType<typeof timing>> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    beforeEach?.();
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return timing(samples);
}

function reportFile(): string {
  return process.env.ATMUSIC_PROTOCOL_BENCH_OUT
    ? resolve(process.env.ATMUSIC_PROTOCOL_BENCH_OUT)
    : resolve(REPO_ROOT, 'work/bench/protocol-reads.json');
}

async function fixture(): Promise<{ app: TestApp; captured: Captured[] }> {
  const captured: Captured[] = [];
  const app = await startApp({
    routes: [...lastfmRoutes(), ...listenBrainzRoutes()],
    clock: fixedClock(NOW_ISO),
    wrapDb(db) {
      const wrapped: Db = {
        all<T>(sql: string, ...params: SqlParam[]) {
          captured.push({ sql, params });
          return db.all<T>(sql, ...params);
        },
        one<T>(sql: string, ...params: SqlParam[]) {
          captured.push({ sql, params });
          return db.one<T>(sql, ...params);
        },
        run(sql: string, ...params: SqlParam[]) {
          captured.push({ sql, params });
          return db.run(sql, ...params);
        },
        tx<T>(fn: () => T extends Promise<unknown> ? never : T) {
          return db.tx(fn);
        },
      };
      return wrapped;
    },
  });
  user(app.db, DID, 'bench.test', 'benchuser');
  const random = seededRandom(SEED);
  const stmt = app.db.raw.prepare(INSERT);
  app.db.tx(() => {
    for (let i = 0; i < LISTENS; i++) directInsert(app.db, DID, recordFor(i, random), stmt);
    app.db.run('UPDATE users SET stats_version = 1 WHERE did = ?', DID);
  });
  seedOperations(app.db);
  expect(app.db.one<{ count: number }>('SELECT count(*) AS count FROM scrobbles WHERE did = ?', DID)?.count).toBe(
    LISTENS,
  );
  return { app, captured };
}

async function json(app: TestApp, path: string): Promise<{ body: string; response: Response }> {
  const response = await app.fetch(path);
  return { body: await response.text(), response };
}
const lfm = (method: string, extra: Record<string, string> = {}) =>
  `/2.0/?${new URLSearchParams({ api_key: API_KEY, format: 'json', method, user: 'benchuser', ...extra })}`;
const lb = (path: string) => `/1/stats/user/benchuser/${path}`;

async function applyParity(
  app: TestApp,
): Promise<{ left: Record<string, unknown>[]; right: Record<string, unknown>[] }> {
  user(app.db, APPLY_DID, 'apply.test', 'applyuser');
  user(app.db, DIRECT_DID, 'direct.test', 'directuser');
  const keys = await fixtureKeys();
  const repo = new SignedRepo(APPLY_DID, keys.alice, { clock: fixedClock(NOW_ISO) });
  const random = seededRandom(SEED);
  for (let i = 0; i < 100; i++) {
    const item = recordFor(i, random);
    const rkey = `r${String(i).padStart(13, '0')}`;
    await repo.put(SCROBBLE, rkey, item.record);
    const car = await repo.getRecordCar(SCROBBLE, rkey);
    const proof = await verifyRecordProof(car, {
      did: APPLY_DID,
      collection: SCROBBLE,
      rkey,
      signingKey: repo.key.didKey,
    });
    const result = app.db.tx(() => applyRecordProof(app.db, proof, OPTS));
    expect(result.outcome).toBe('applied');
    directInsert(app.db, DIRECT_DID, item);
  }
  const fields =
    'artist,track,album,listened_at,created_at,duration_seconds,recording_mbid,artist_key,track_key,album_key,album_artist,album_artist_key,track_number,artist_mbids,release_mbid,release_group_mbid,isrc,submission_client,music_service,recording_msid';
  const left = app.db.all<Record<string, unknown>>(
    `SELECT ${fields} FROM scrobbles WHERE did=? ORDER BY listened_at,uri`,
    APPLY_DID,
  );
  const right = app.db.all<Record<string, unknown>>(
    `SELECT ${fields} FROM scrobbles WHERE did=? ORDER BY listened_at,uri`,
    DIRECT_DID,
  );
  expect(left).toHaveLength(100);
  expect(right).toHaveLength(100);
  expect(left).toEqual(right);
  return { left, right };
}

interface RendererContract {
  validatePlanStatement(value: unknown): void;
  validateReport(value: unknown): void;
}
const rendererUrl = new URL('../../../scripts/benchmark-protocol-reads.ts', import.meta.url).href;
async function renderer(): Promise<RendererContract> {
  return (await import(rendererUrl)) as unknown as RendererContract;
}

interface BenchmarkEvidence {
  app: TestApp;
  captured: Captured[];
  applyRows: Record<string, unknown>[];
  directRows: Record<string, unknown>[];
  readPlans: Record<string, QueryPlanStatement[]>;
  uncachedTop: string;
  cachedTop: string;
  receipt: ProtocolReadsReport;
}
let evidence: BenchmarkEvidence;

afterAll(closeApps);

describe('N5-02 protocol read benchmark', () => {
  beforeAll(async () => {
    const out = reportFile();
    rmSync(out, { force: true });
    const { app, captured } = await fixture();
    const parity = await applyParity(app);
    const readPlans = await captureReadPlans(app, captured);
    const { validatePlanStatement, validateReport } = await renderer();

    // Negative controls reject a scan through any table alias but allow CTE scans.
    expect(() =>
      validatePlanStatement({
        sql: 'SELECT * FROM scrobbles s JOIN scrobbles dd ON dd.uri = s.uri',
        details: ['SEARCH s USING INDEX scrobbles_owner_time (did=?)', 'SCAN dd'],
      }),
    ).toThrow(/scans scrobbles alias dd/);
    expect(() =>
      validatePlanStatement({
        sql: 'WITH w AS (SELECT * FROM scrobbles s) SELECT * FROM w',
        details: ['SEARCH s USING INDEX scrobbles_stats (did=?)', 'SCAN w'],
      }),
    ).not.toThrow();
    for (const statements of Object.values(readPlans)) {
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        validatePlanStatement(statement);
        // Pin the naturally selected owner/target probe, without INDEXED BY.
        expect(
          statement.details.some(
            (detail) =>
              detail.includes('operations_scrobble_delete_target') || detail.includes('operations_record_target'),
          ),
        ).toBe(true);
        expect(statement.details.some((detail) => detail.includes('operations_did_state'))).toBe(false);
      }
    }

    const path = lfm('user.getTopTracks', { period: 'overall' });
    clearRangeCache(app, 'lastfm:overall');
    const uncachedTop = await json(app, path);
    expect(uncachedTop.response.status, uncachedTop.body).toBe(200);
    expect(
      app.db.one<{ count: number }>(
        "SELECT count(*) AS count FROM range_stats_cache WHERE did=? AND entity='tracks' AND range_key='lastfm:overall'",
        DID,
      )?.count,
    ).toBe(1);
    const cacheStart = captured.length;
    const cachedTop = await json(app, path);
    expect(cachedTop.response.status, cachedTop.body).toBe(200);
    expect(cachedTop.body).toBe(uncachedTop.body);
    const cachedQueries = captured.slice(cacheStart);
    expect(cachedQueries.some((q) => /\bFROM\s+range_stats_cache\b/i.test(q.sql))).toBe(true);
    expect(cachedQueries.some((q) => /\b(?:FROM|JOIN)\s+scrobbles\b/i.test(q.sql))).toBe(false);

    const report: ProtocolReadsReport = {
      schema: 'atmusic/protocol-reads-benchmark@2',
      generatedBy: 'worker/test/bench/protocol-reads.bench.test.ts',
      generatedAt: new Date().toISOString(),
      dataset: {
        listens: LISTENS,
        seed: SEED,
        clock: NOW_ISO,
        applyPathRecords: 100,
        operations: {
          total: CREATE_OPERATIONS + 6,
          scrobbleCreateSucceeded: CREATE_OPERATIONS,
          scrobbleDelete: {
            queued: 1,
            running: 1,
            blocked: 1,
            failed: 1,
            succeededMatchingCid: 1,
            succeededStaleCid: 1,
          },
          visibleScrobbles: VISIBLE_LISTENS,
          hiddenScrobbles: HIDDEN_LISTENS,
        },
      },
      plans: {
        source: `EXPLAIN QUERY PLAN; Node ${process.version}; node:sqlite ${app.db.one<{ version: string }>('SELECT sqlite_version() AS version')?.version ?? 'unknown'}; ${process.platform}/${process.arch}`,
        topTracks: readPlans.topTracks!,
        recentTracks: readPlans.recentTracks!,
        listenbrainzAllTime: readPlans.listenbrainzAllTime!,
        listeningActivityYear: readPlans.listeningActivityYear!,
      },
      reads: await collectReadings(app),
    };
    validateReport(report);
    const temp = `${out}.tmp`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temp, out);
    evidence = {
      app,
      captured,
      applyRows: parity.left,
      directRows: parity.right,
      readPlans,
      uncachedTop: uncachedTop.body,
      cachedTop: cachedTop.body,
      receipt: report,
    };
  }, 900_000);

  it('on a 100k-listen user the top-tracks, recent-tracks and ListenBrainz stats statements use scrobbles_stats or scrobbles_owner_time and never SCAN scrobbles', () => {
    expect(
      evidence.app.db.one<{ count: number }>('SELECT count(*) AS count FROM scrobbles WHERE did=?', DID)?.count,
    ).toBe(LISTENS);
    expect(
      evidence.app.db.one<{ count: number }>('SELECT count(*) AS count FROM operations WHERE did=?', DID)?.count,
    ).toBe(CREATE_OPERATIONS + 6);
    expect(
      evidence.app.db.one<{ count: number }>(
        `SELECT count(*) AS count FROM scrobbles s WHERE s.did=? AND NOT EXISTS (
          SELECT 1 FROM operations d WHERE d.did=s.did AND d.collection=? AND d.rkey=s.rkey
            AND d.kind='scrobble.delete'
            AND (d.state IN ('queued','running','blocked','failed') OR (d.state='succeeded' AND d.swap_cid=s.cid))
        )`,
        DID,
        SCROBBLE,
      )?.count,
    ).toBe(VISIBLE_LISTENS);
    expect(evidence.applyRows).toHaveLength(100);
    expect(evidence.directRows).toEqual(evidence.applyRows);
    for (const statements of Object.values(evidence.readPlans)) {
      for (const statement of statements) {
        expect(statement.details.some((line) => /INDEX scrobbles_(stats|owner_time)/.test(line))).toBe(true);
      }
    }
  });

  it('the cached getTopTracks body equals the uncached body and the report records p50/p95 for each read', async () => {
    expect(evidence.cachedTop).toBe(evidence.uncachedTop);
    const { validateReport } = await renderer();
    const receipt = JSON.parse(await (await import('node:fs/promises')).readFile(reportFile(), 'utf8')) as unknown;
    validateReport(receipt);
    const checked = receipt as ProtocolReadsReport;
    expect(checked.reads.topTracks.cached.runs).toBe(READS);
    expect(checked.reads.topTracks.uncached.runs).toBe(READS);
    expect(checked.reads.recentTracksPage500.runs).toBe(READS);
    expect(checked.reads.listenbrainzAllTime.runs).toBe(READS);
    expect(checked.reads.listeningActivityYear.runs).toBe(READS);
    for (const measured of [
      checked.reads.topTracks.cached,
      checked.reads.topTracks.uncached,
      checked.reads.recentTracksPage500,
      checked.reads.listenbrainzAllTime,
      checked.reads.listeningActivityYear,
    ]) {
      expect(Number.isFinite(measured.p50Ms) && Number.isFinite(measured.p95Ms)).toBe(true);
      expect(measured.p95Ms).toBeGreaterThanOrEqual(measured.p50Ms);
    }
  });
});

async function captureReadPlans(app: TestApp, captured: Captured[]): Promise<Record<string, QueryPlanStatement[]>> {
  const requests = [
    lfm('user.getTopTracks', { period: 'overall' }),
    lfm('user.getRecentTracks', { page: '500', limit: '200' }),
    lb('recordings?range=all_time&count=100'),
    lb('listening-activity?range=year'),
  ];
  const readPlans: Record<string, QueryPlanStatement[]> = {};
  for (const request of requests) {
    if (request.includes('TopTracks')) clearRangeCache(app, 'lastfm:overall');
    if (request.includes('recordings')) clearRangeCache(app, 'lb:all_time');
    const start = captured.length;
    const response = await json(app, request);
    expect(response.response.status, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      toptracks?: { '@attr': { total: string }; track: unknown[] };
      recenttracks?: { '@attr': { page: string; perPage: string; total: string }; track: unknown[] };
      payload?: {
        user_id: string;
        range: string;
        count?: number;
        recordings?: unknown[];
        listening_activity?: unknown[];
      };
    };
    if (request.includes('TopTracks')) {
      expect(body.toptracks!['@attr'].total).not.toBe('0');
      expect(body.toptracks!.track.length).toBeGreaterThan(0);
    } else if (request.includes('RecentTracks')) {
      expect(body.recenttracks!['@attr']).toMatchObject({
        page: '500',
        perPage: '200',
        total: String(VISIBLE_LISTENS),
      });
      expect(body.recenttracks!.track).toHaveLength(Math.min(200, VISIBLE_LISTENS - 99_800));
    } else if (request.includes('recordings')) {
      expect(body.payload!).toMatchObject({ user_id: 'benchuser', range: 'all_time', count: 100 });
      expect(body.payload!.recordings).toHaveLength(100);
    } else {
      expect(body.payload!.user_id).toBe('benchuser');
      expect(body.payload!.range).toBe('year');
      expect(body.payload!.listening_activity!.length).toBeGreaterThan(0);
    }
    const relevant = captured.slice(start).filter((q) => /\bFROM\s+scrobbles\b|\bJOIN\s+scrobbles\b/i.test(q.sql));
    expect(relevant.length, request).toBeGreaterThan(0);
    const key = request.includes('TopTracks')
      ? 'topTracks'
      : request.includes('RecentTracks')
        ? 'recentTracks'
        : request.includes('recordings')
          ? 'listenbrainzAllTime'
          : 'listeningActivityYear';
    readPlans[key] = plans(app.db, relevant);
  }
  return readPlans;
}

function clearRangeCache(app: TestApp, key: string): void {
  app.db.run('DELETE FROM range_stats_cache WHERE did=? AND entity=? AND range_key=?', DID, 'tracks', key);
}

async function collectReadings(app: TestApp): Promise<ProtocolReadsReport['reads']> {
  const top = lfm('user.getTopTracks', { period: 'overall' });
  const clearTopCache = () =>
    app.db.run("DELETE FROM range_stats_cache WHERE did=? AND entity='tracks' AND range_key='lastfm:overall'", DID);
  const topTracksUncached = await measure(
    async () => {
      const result = await json(app, top);
      if (result.response.status !== 200) throw new Error(`top tracks returned ${result.response.status}`);
    },
    READS,
    clearTopCache,
  );
  await json(app, top);
  const topTracksCached = await measure(async () => {
    const result = await json(app, top);
    if (result.response.status !== 200) throw new Error(`cached top tracks returned ${result.response.status}`);
  });
  const recent = lfm('user.getRecentTracks', { page: '500', limit: '200' });
  const recentTracksPage500 = await measure(async () => {
    const result = await json(app, recent);
    if (result.response.status !== 200) throw new Error(`recent tracks returned ${result.response.status}`);
  });
  const stats = lb('recordings?range=all_time&count=100');
  const listenbrainzAllTime = await measure(
    async () => {
      const result = await json(app, stats);
      if (result.response.status !== 200) throw new Error(`ListenBrainz stats returned ${result.response.status}`);
    },
    READS,
    () => clearRangeCache(app, 'lb:all_time'),
  );
  const activity = lb('listening-activity?range=year');
  const listeningActivityYear = await measure(async () => {
    const result = await json(app, activity);
    if (result.response.status !== 200) throw new Error(`ListenBrainz activity returned ${result.response.status}`);
  });
  return {
    topTracks: { cached: topTracksCached, uncached: topTracksUncached },
    recentTracksPage500,
    listenbrainzAllTime,
    listeningActivityYear,
  };
}
