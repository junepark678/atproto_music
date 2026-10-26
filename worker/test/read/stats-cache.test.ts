// W3-02: the exact statistics cache (ADR 0004 §5.8 "Exact stats cache";
// M5.2.3 cache_invalidation, M5.1.3 delete_effect).
//
// A cached body is reused only when users.stats_version is unchanged and no
// row of the DID crossed either window bound since it was computed; a reused
// body carries the current asOf. These tests drive the real module against
// node:sqlite, compare every answer with the uncached computation at the
// same asOf, and assert the stats_cache row (as_of, lower, version) after each
// request: a hit leaves it untouched, a miss rewrites it. Data comes from real
// signed repositories through the production verifier and apply path.

import type { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import type { StatsWindow } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs } from '@atmusic/core/timestamp';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import { computeStatistics, stats, statsWithCache } from '../../src/do/read/stats';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { routes, STATS_PATTERN } from '../../src/http/stats';
import type { RequestCtx } from '../../src/http/types';
import { ALICE, OPTS, repoFor, SCROBBLE, scrobble, seedUser, uriOf } from '../write/support';
import { HARNESS_ENV, inTestDb, makeDbIndex, openTestDb, type TestDb } from './node-harness';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addFormat('at-did', /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/);
  ajv.addFormat('music-text', /^[\s\S]*\S[\s\S]*$/u);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const statisticsSchema = openapiValidator('Statistics');

const route = routes.find((r) => r.method === 'GET' && r.pattern === STATS_PATTERN)!;

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(3),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
});

async function applyVerified(store: TestDb, repo: SignedRepo, rkey: string): Promise<string> {
  const car = await repo.getRecordCar(SCROBBLE, rkey);
  const proof = await verifyRecordProof(car, {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  return inTestDb(store, (db) => db.tx(() => applyRecordProof(db, proof, OPTS)).outcome);
}

async function put(store: TestDb, repo: SignedRepo, rkey: string, record: Record<string, unknown>) {
  await repo.put(SCROBBLE, rkey, record);
  expect(await applyVerified(store, repo, rkey)).toBe('applied');
}

/** Alice's fixture scrobbles r01..r07 (r08 created and deleted), via signed commits. */
async function seedAlice() {
  const store = await openTestDb();
  await inTestDb(store, (db) => seedUser(db, ALICE));
  const repo = await repoFor('alice');
  for (const s of fixture.scrobbles) if (s.owner === ALICE) await put(store, repo, s.rkey, { ...s.record });
  await repo.delete(SCROBBLE, 'r08');
  expect(await applyVerified(store, repo, 'r08')).toBe('absent');
  return { store, repo };
}

const ns = (iso: string) => fromMs(Date.parse(iso));

/**
 * One module request at `iso`, inside the DO: how it was served, the answer,
 * the uncached computation at the same asOf, the stats_cache row afterwards
 * and the current stats_version.
 */
function request(store: TestDb, window: StatsWindow, iso: string) {
  return inTestDb(store, (db) => {
    const asOfNs = ns(iso);
    const served = statsWithCache(db, { did: ALICE, window, limit: 10, asOfNs });
    const uncached = computeStatistics(db, ALICE, window, 10, asOfNs);
    const row = db.one<{ as_of: string; lower: string | null; version: number }>(
      'SELECT as_of, lower, version FROM stats_cache WHERE did = ? AND win = ? AND lim = 10',
      ALICE,
      window,
    );
    const version = db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', ALICE)!.v;
    return { ...served, uncached, row, version };
  });
}

/** GET through the real route: status, schema, one RPC, no remote calls. */
async function getStats(store: TestDb, query: string) {
  const index = makeDbIndex({ db: store }, { stats });
  const ctx: RequestCtx = {
    env: HARNESS_ENV,
    index,
    requestId: '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b',
    clock: fixedClock(),
    cursorKey,
    clientIp: '203.0.113.11',
  };
  const path = `${STATS_PATTERN.replace('{did}', ALICE)}${query}`;
  const res = await route.handler(new Request(`https://music.example.test${path}`), ctx, { did: ALICE });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as Record<string, unknown>;
  expect(statisticsSchema(body)).toBe('valid');
  expect(body.asOf).toBe('2026-01-15T12:00:00.000000000Z');
  expect(index.calls.map((c) => c.method)).toEqual(['stats']);
  expect(index.networkAttempts).toEqual([]);
  return body;
}

it('cache hit only when version unchanged and no row crossed either bound; result equals uncached', async () => {
  const { store, repo } = await seedAlice();
  // A future-dated listen (accepted: receipt 12:00:00 + 300 s) that will cross the upper bound at 12:01.
  await put(store, repo, 'x1', scrobble({ artist: 'Portishead', track: 'Roads', listenedAt: '2026-01-15T12:01:00Z' }));
  const v0 = await inTestDb(
    store,
    (db) => db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', ALICE)!.v,
  );

  // 1. First request: miss, computed and stored at asOf.
  let r = await request(store, 'all', '2026-01-15T12:00:00Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics?.totalScrobbles).toBe(7);
  expect(r.row).toEqual({ as_of: '2026-01-15T12:00:00.000000000Z', lower: null, version: v0 });

  // 2. Same asOf, nothing changed: hit, identical to the uncached answer.
  r = await request(store, 'all', '2026-01-15T12:00:00Z');
  expect(r.cache).toBe('hit');
  expect(r.statistics).toEqual(r.uncached);

  // 3. asOf moved but no row in (12:00:00, 12:00:30]: hit with the *current* asOf; row untouched.
  r = await request(store, 'all', '2026-01-15T12:00:30Z');
  expect(r.cache).toBe('hit');
  expect(r.statistics?.asOf).toBe('2026-01-15T12:00:30.000000000Z');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.row?.as_of).toBe('2026-01-15T12:00:00.000000000Z');

  // 4. x1 (12:01:00) is in (asOf0, asOf1]: the upper probe forces a miss; x1 now counts.
  r = await request(store, 'all', '2026-01-15T12:01:00Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics?.totalScrobbles).toBe(8);
  expect(r.statistics?.topArtists).toContainEqual({ artist: 'Portishead', scrobbleCount: 1 });
  expect(r.row).toEqual({ as_of: '2026-01-15T12:01:00.000000000Z', lower: null, version: v0 });

  // 5. Asking for an earlier asOf crosses x1 the other way: miss, x1 no longer counts.
  r = await request(store, 'all', '2026-01-15T12:00:30Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics?.totalScrobbles).toBe(7);

  // 6. 7d: r03 sits exactly on the lower bound 2026-01-08T12:00:00 at asOf 12:00:00.
  r = await request(store, '7d', '2026-01-15T12:00:00Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics?.totalScrobbles).toBe(4);
  expect(r.row).toEqual({
    as_of: '2026-01-15T12:00:00.000000000Z',
    lower: '2026-01-08T12:00:00.000000000Z',
    version: v0,
  });
  // Half a second later r03 is in [lower0, lower1) and nothing is in (asOf0, asOf1]: the lower probe misses.
  r = await request(store, '7d', '2026-01-15T12:00:00.500Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics?.totalScrobbles).toBe(3);
  expect(r.row?.lower).toBe('2026-01-08T12:00:00.500000000Z');
  // Both bounds move again with no row in either gap: hit.
  r = await request(store, '7d', '2026-01-15T12:00:30Z');
  expect(r.cache).toBe('hit');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics?.asOf).toBe('2026-01-15T12:00:30.000000000Z');
  expect(r.row?.as_of).toBe('2026-01-15T12:00:00.500000000Z');

  // 7. A verified change bumps stats_version: a miss even though no bound moved and the
  //    changed row (r06, 2025) is outside the 7d window. The answer is unchanged.
  const before = r.statistics;
  await put(store, repo, 'r06', {
    ...fixture.scrobbles.find((s) => s.rkey === 'r06')!.record,
    album: 'The Whole Story',
  });
  r = await request(store, '7d', '2026-01-15T12:00:30Z');
  expect(r.version).toBe(v0 + 1);
  expect(r.cache).toBe('miss');
  expect(r.statistics).toEqual(r.uncached);
  expect(r.statistics).toEqual(before);
  expect(r.row?.version).toBe(v0 + 1);
  // ...and the all-time body picks up the change.
  r = await request(store, 'all', '2026-01-15T12:00:30Z');
  expect(r.cache).toBe('miss');
  expect(r.statistics?.topAlbums).toContainEqual({ artist: 'Kate Bush', album: 'The Whole Story', scrobbleCount: 1 });
  expect(r.statistics?.topAlbums).not.toContainEqual({
    artist: 'Kate Bush',
    album: 'Hounds of Love',
    scrobbleCount: 1,
  });

  // 8. A stored body under a stale version is never served, even when asOf is identical.
  await inTestDb(store, (db) =>
    db.run('UPDATE stats_cache SET version = version - 1 WHERE did = ? AND win = ?', ALICE, 'all'),
  );
  r = await request(store, 'all', '2026-01-15T12:00:30Z');
  expect(r.cache).toBe('miss');
  expect(r.row?.version).toBe(v0 + 1);
});

it('delete r01 invalidates: all → 6 listens, Homogenic 1', async () => {
  const { store, repo } = await seedAlice();
  const all0 = await getStats(store, '');
  expect([all0.totalScrobbles, all0.distinctArtists, all0.distinctTracks]).toEqual([7, 3, 6]);
  expect(all0.topAlbums).toContainEqual({ artist: 'Björk', album: 'Homogenic', scrobbleCount: 2 });
  const d7 = await getStats(store, '?window=7d');
  expect(d7.totalScrobbles).toBe(4);
  const versionBefore = await inTestDb(
    store,
    (db) => db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', ALICE)!.v,
  );

  // Signed deletion of r01; its exclusion proof is verified and applied.
  await repo.delete(SCROBBLE, 'r01');
  expect(await applyVerified(store, repo, 'r01')).toBe('absent');
  const db = await inTestDb(store, (db) => ({
    r01: db.one('SELECT uri FROM scrobbles WHERE uri = ?', uriOf(ALICE, SCROBBLE, 'r01')),
    state: db.one<{ state: string }>('SELECT state FROM record_state WHERE uri = ?', uriOf(ALICE, SCROBBLE, 'r01')),
    version: db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', ALICE)!.v,
  }));
  expect(db).toEqual({ r01: null, state: { state: 'absent' }, version: versionBefore + 1 });

  // TESTING.md: all-time 6 listens, 3 artists, 6 tracks, Homogenic 1; rankings recomputed exactly.
  const all1 = await getStats(store, '');
  expect([all1.totalScrobbles, all1.distinctArtists, all1.distinctTracks]).toEqual([6, 3, 6]);
  expect(all1.topArtists).toEqual([
    { artist: 'Radiohead', scrobbleCount: 3 },
    { artist: 'Kate Bush', scrobbleCount: 2 },
    // r02 is now the newest Björk listen, so its spelling displays.
    { artist: '  BJÖRK  ', scrobbleCount: 1 },
  ]);
  expect(all1.topTracks).toEqual([
    { artist: '  BJÖRK  ', track: 'jóga', scrobbleCount: 1 },
    { artist: 'Kate Bush', track: 'Cloudbusting', scrobbleCount: 1 },
    { artist: 'Kate Bush', track: 'Running Up That Hill', scrobbleCount: 1 },
    { artist: 'Radiohead', track: 'Karma Police', scrobbleCount: 1 },
    { artist: 'Radiohead', track: 'No Surprises', scrobbleCount: 1 },
    { artist: 'Radiohead', track: 'Weird Fishes', scrobbleCount: 1 },
  ]);
  expect(all1.topAlbums).toEqual([
    { artist: 'Radiohead', album: 'OK Computer', scrobbleCount: 2 },
    { artist: '  BJÖRK  ', album: ' HOMOGENIC ', scrobbleCount: 1 },
    { artist: 'Kate Bush', album: 'Hounds of Love', scrobbleCount: 1 },
    { artist: 'Radiohead', album: 'In Rainbows', scrobbleCount: 1 },
  ]);
  // The 7d body is invalidated too: r02, r03, r07 remain.
  const d7b = await getStats(store, '?window=7d');
  expect([d7b.totalScrobbles, d7b.distinctArtists, d7b.distinctTracks]).toEqual([3, 2, 3]);
  expect(d7b.topArtists).toEqual([
    { artist: 'Radiohead', scrobbleCount: 2 },
    { artist: '  BJÖRK  ', scrobbleCount: 1 },
  ]);

  // Both cache rows were rewritten under the new version with the recomputed bodies.
  const rows = await inTestDb(store, (db) =>
    db.all<{ win: string; version: number; body: string }>(
      'SELECT win, version, body FROM stats_cache WHERE did = ? ORDER BY win',
      ALICE,
    ),
  );
  expect(rows.map((x) => [x.win, x.version, JSON.parse(x.body).statistics.totalScrobbles])).toEqual([
    ['7d', versionBefore + 1, 3],
    ['all', versionBefore + 1, 6],
  ]);
});
