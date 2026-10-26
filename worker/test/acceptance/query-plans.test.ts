// W6-01 query plans at scale on the Node host (ported by N4-03; ADR 0004 §10.4
// "Query plans", ADR 0005 §15.3; M6.2.3 slow_query_detection).
//
// 100 DIDs × 1,000 scrobbles, real signed repositories on four fake PDS
// hosts, each DID announced through POST /api/v1/notify `{did}` and indexed by
// exactly one range snapshot of its signed head, run by the production core
// alarm (admission → getBlocks walk → applySnapshotChunk → completeSnapshot) on
// node:sqlite. Then the history, global feed, following feed and statistics
// routes are served over HTTP while the composition's pass-through Db
// (entry.ts) records every statement the production read modules run, and
// each recorded statement is planned with EXPLAIN QUERY PLAN on the SQLite the
// Node host runs (3.54.1, asserted):
// - with the schema's indexes: history and stats SEARCH scrobbles by DID
//   through scrobbles_owner_time / scrobbles_stats, the global feed walks
//   scrobbles_global_time in order, and nothing scans scrobbles or sorts it
//   in a temporary B-tree;
// - negative control: with those indexes dropped, the same statements plan a
//   full SCAN of scrobbles, and the routes still answer identically; the
//   statistics cache is invalidated first (production stats_version bump),
//   so the unindexed statistics are recomputed, not replayed from the cache.

import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { FakeRelay } from '@atmusic/atproto/test-support/fake-relay';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { JetstreamConnectError } from '../../src/do/ingest/jetstream-socket';
import { bumpStatsVersion } from '../../src/do/write/account-state';
import { closeHarnesses } from '../composition/support';
import { acceptanceApp, type RecordedStatement } from './entry';
import { checkResponse } from './support/openapi';
import { FOLLOW, flush, PUBLIC_ORIGIN, SCROBBLE } from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const DIDS = 100;
const PER_DID = 1000;
const HOSTS = 4;
const START = '2026-01-15T10:00:00Z';
const START_MS = Date.parse(START);

function didOf(i: number): string {
  const a = String.fromCharCode(97 + Math.floor(i / 26));
  const b = String.fromCharCode(97 + (i % 26));
  return `did:plc:plan${a}${b}${'z'.repeat(18)}`;
}

/** Record j of DID d: listens over ~2 years, 40 artists, 160 tracks, every 7th without album. */
function recordOf(d: number, j: number) {
  const at = new Date(START_MS - (j * 17 * 3600 + d * 60) * 1000).toISOString().replace('.000Z', 'Z');
  const fields: Record<string, unknown> = {
    $type: SCROBBLE,
    artist: `Artist ${(j * 7 + d) % 40}`,
    track: `Track ${j % 160}`,
    listenedAt: at,
    createdAt: at,
  };
  if (j % 7 !== 0) fields.album = `Album ${j % 23}`;
  return fields;
}

const INDEXED_SEARCH =
  /^SEARCH (s|scrobbles|d) USING (COVERING )?INDEX (scrobbles_owner_time|scrobbles_stats) \(did=\?/;
const GLOBAL_ORDERED = /^(SCAN|SEARCH) s USING (COVERING )?INDEX scrobbles_global_time\b/;
const FULL_SCAN = /^SCAN (s|scrobbles|d)$|^SCAN (s|scrobbles|d) USING (COVERING )?INDEX sqlite_autoindex/;
const TEMP_SORT = /USE TEMP B-TREE FOR (ORDER BY|.*ORDER BY)/;

describe('query plans', () => {
  afterEach(closeHarnesses);

  it('with 100 DIDs x 1,000 records, history, feeds and stats use their indexes on SQLite 3.54.1 and the no-index control shows SCAN', async () => {
    // ------------------------------------------------------------ network
    const clock = fixedClock(START);
    const keys = await fixtureKeys();
    const plc = new FakePlc();
    const doh = new FakeDoh();
    const relay = new FakeRelay();
    const hosts = Array.from({ length: HOSTS }, (_, h) => new FakePds(`pds-plan${h}.example.test`, { clock }));
    const handles = new Map<string, string>();
    const viewer = didOf(0);
    const followed = [1, 2, 3, 4, 5].map(didOf);
    for (let d = 0; d < DIDS; d++) {
      const did = didOf(d);
      const handle = `plan${d}.example.test`;
      const repo = new SignedRepo(did, keys.alice, { clock });
      const ops: Array<{ action: 'put'; collection: string; rkey: string; record: unknown }> = Array.from(
        { length: PER_DID },
        (_, j) => ({
          action: 'put',
          collection: SCROBBLE,
          rkey: `p${String(j).padStart(4, '0')}`,
          record: recordOf(d, j),
        }),
      );
      if (d === 0) {
        for (const [k, subject] of followed.entries()) {
          ops.push({
            action: 'put',
            collection: FOLLOW,
            rkey: `follow${k}`,
            record: { $type: FOLLOW, subject, createdAt: '2026-01-01T00:00:00Z' },
          });
        }
      }
      await repo.writes(ops);
      const pds = hosts[d % HOSTS] as FakePds;
      await pds.addAccount(repo, { handle });
      plc.register(did, { signingKey: keys.alice, pds: pds.origin, handle });
      doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
      handles.set(handle, did);
    }
    const transport = routerTransport({ pds: hosts, plc, doh, relay, handles });

    // The production composition on that network; ingestion is notify + snapshot only here.
    // Its log lines (one snapshot.finished per DID) are captured by the harness;
    // warnings and errors must stay empty.
    const app = await acceptanceApp('query-plans', {
      clock,
      random: seededRandom(9),
      transport,
      connectJetstream: async (url) => {
        throw new JetstreamConnectError(null, null, `query-plans: no Jetstream at ${new URL(url).host}`);
      },
      env: { INGEST_MODE: 'off' },
    });
    const h = app.harness;
    let validated = 0;
    const request = async (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string; ip?: string } = {},
    ) => {
      const url = `${PUBLIC_ORIGIN}${path}`;
      const res = await h.request(path, init);
      const body = res.body as Json;
      const verdict = checkResponse(init.method ?? 'GET', url, { status: res.status, headers: res.headers, body });
      if (verdict !== 'valid') throw new Error(`${path}: ${verdict}`);
      validated += 1;
      return { status: res.status, text: res.text, body };
    };
    const inDo = async <R>(fn: (db: Db) => R | Promise<R>) => fn(h.db);
    const alarm = async () => {
      await h.runAlarm();
      await flush();
    };
    // The Node host's SQLite, which these plans are pinned on.
    expect(h.db.one<{ v: string }>('SELECT sqlite_version() AS v')?.v).toBe('3.54.1');

    // ------------------------------------------------------------ ingest
    // Admission takes 50 new DIDs per hour: announce them in two hourly waves.
    for (let wave = 0; wave < 2; wave++) {
      for (let d = wave * 50; d < (wave + 1) * 50; d++) {
        const r = await request('/api/v1/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ did: didOf(d) }),
          ip: `198.51.100.${1 + d}`,
        });
        expect([d, r.status]).toEqual([d, 202]);
      }
      const target = (wave + 1) * 50;
      for (let n = 0; n < 400; n++) {
        const done = await inDo(
          (db) => (db.one<{ n: number }>('SELECT count(*) AS n FROM users WHERE active = 1')?.n ?? 0) >= target,
        );
        if (done) break;
        clock.advance(2_000);
        await alarm();
      }
      if (wave === 0) clock.advance(3_600_000);
    }
    const seeded = await inDo((db) => ({
      scrobbles: db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')?.n,
      active: db.one<{ n: number }>('SELECT count(*) AS n FROM users WHERE active = 1')?.n,
      follows: db.one<{ n: number }>('SELECT count(*) AS n FROM follows')?.n,
      jobs: db.all<{ n: number; reason: string; state: string }>(
        "SELECT count(*) AS n, reason, state FROM repo_jobs WHERE kind = 'snapshot' GROUP BY reason, state",
      ),
      perDid: db.one<{ lo: number; hi: number }>(
        'SELECT min(c) AS lo, max(c) AS hi FROM (SELECT count(*) AS c FROM scrobbles GROUP BY did)',
      ),
    }));
    expect(seeded).toEqual({
      scrobbles: DIDS * PER_DID,
      active: DIDS,
      follows: followed.length,
      // Exactly one snapshot per DID, each complete.
      jobs: [{ n: DIDS, reason: 'admission', state: 'complete' }],
      perDid: { lo: PER_DID, hi: PER_DID },
    });
    // The production logger saw one completed, active snapshot per DID and nothing worse.
    const finished = h.log.logs.filter((e) => e.event === 'snapshot.finished') as Json[];
    expect(finished).toHaveLength(DIDS);
    expect(new Set(finished.map((e) => `${e.did} ${e.outcome} ${e.active}`))).toEqual(
      new Set(Array.from({ length: DIDS }, (_, d) => `${didOf(d)} complete true`)),
    );
    expect(h.log.logs.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
    // Every record came from a verified getBlocks walk of its DID's signed head.
    const getBlocks = hosts.reduce((s, h) => s + h.calls.count({ nsid: 'com.atproto.sync.getBlocks' }), 0);
    const latest = hosts.reduce((s, h) => s + h.calls.count({ nsid: 'com.atproto.sync.getLatestCommit' }), 0);
    expect(latest).toBe(DIDS);
    expect(getBlocks).toBeGreaterThanOrEqual(DIDS * 11);
    expect(hosts.reduce((s, h) => s + h.calls.count({ nsid: 'com.atproto.sync.getRecord' }), 0)).toBe(0);

    // ------------------------------------------------------------ plans
    const target = didOf(42);
    const ROUTES: Array<[string, string]> = [
      ['history', `/api/v1/users/${target}/scrobbles?limit=20`],
      ['global', '/api/v1/feed?scope=global&limit=20'],
      ['following', `/api/v1/feed?scope=following&viewer=${encodeURIComponent(viewer)}&limit=20`],
      ['stats all', `/api/v1/users/${target}/stats?window=all`],
      ['stats 7d', `/api/v1/users/${target}/stats?window=7d`],
      ['stats 30d', `/api/v1/users/${target}/stats?window=30d`],
      ['stats 365d', `/api/v1/users/${target}/stats?window=365d`],
    ];
    /** Serve every route (first pages and a second page from each cursor), recording the SQL the DO ran. */
    const serve = async () => {
      const out: Array<{ label: string; text: string; statements: RecordedStatement[] }> = [];
      for (const [label, path] of ROUTES) {
        for (const page of [1, 2]) {
          if (page === 2 && label.startsWith('stats')) continue;
          let url = path;
          if (page === 2) {
            const first = out.find((o) => o.label === label);
            const cursor = (JSON.parse(first?.text ?? '{}') as Json).nextCursor as string;
            expect([label, typeof cursor]).toEqual([label, 'string']);
            url = `${path}&cursor=${encodeURIComponent(cursor)}`;
          }
          app.handle().record();
          const r = await request(url);
          const statements = app.handle().stopRecording();
          expect([label, page, r.status]).toEqual([label, page, 200]);
          out.push({ label: page === 1 ? label : `${label} p2`, text: r.text, statements });
        }
      }
      return out;
    };
    const indexed = await serve();
    // Sanity: real pages over the large data set.
    const first = (label: string) => JSON.parse(indexed.find((o) => o.label === label)?.text ?? '{}') as Json;
    expect(first('history').items).toHaveLength(20);
    expect(first('global').items).toHaveLength(20);
    expect(new Set(first('following').items.map((s: Json) => s.did))).toEqual(
      new Set(
        first('following')
          .items.map((s: Json) => s.did)
          .filter((d: string) => followed.includes(d)),
      ),
    );
    expect(first('following').items).toHaveLength(20);
    expect(first('stats all').totalScrobbles).toBe(PER_DID);

    const scrobbleQueries = (statements: RecordedStatement[]) =>
      statements.filter((s) => /^\s*(SELECT|WITH)\b/i.test(s.sql) && /\bscrobbles\b/.test(s.sql));
    const plan = (db: Db, st: RecordedStatement, tag: string) =>
      db.all<{ detail: string }>(`EXPLAIN QUERY PLAN /* ${tag} */ ${st.sql}`, ...st.params).map((r) => r.detail);

    const plans = await inDo((db) =>
      indexed.map((o) => ({
        label: o.label,
        plans: scrobbleQueries(o.statements).map((st) => plan(db, st, 'indexed')),
      })),
    );
    for (const { label, plans: list } of plans) {
      expect([label, list.length > 0]).toEqual([label, true]);
      for (const details of list) {
        const text = details.join(' | ');
        expect([label, text, details.filter((d) => FULL_SCAN.test(d))]).toEqual([label, text, []]);
        // Pages of history and the global feed come in index order, never
        // sorted. (The following feed merges one indexed range per followee,
        // `did IN (…)`, and sorts that bounded merge; statistics sort their
        // per-DID groups by count. Both still SEARCH by index, checked below.)
        if (label.startsWith('history') || label.startsWith('global')) {
          expect([label, text, details.filter((d) => TEMP_SORT.test(d))]).toEqual([label, text, []]);
        }
      }
      const all = list.flat();
      if (label.startsWith('global')) {
        expect([label, all.some((d) => GLOBAL_ORDERED.test(d))]).toEqual([label, true]);
      } else if (label.startsWith('following')) {
        expect([label, all.some((d) => INDEXED_SEARCH.test(d))]).toEqual([label, true]);
        expect([
          label,
          all.some((d) => /^SEARCH f USING (COVERING )?INDEX follows_actor_subject \(actor=\?\)/.test(d)),
        ]).toEqual([label, true]);
      } else {
        expect([label, all.some((d) => INDEXED_SEARCH.test(d))]).toEqual([label, true]);
      }
    }

    // ------------------------------------------------------ negative control
    await inDo((db) => {
      for (const ix of ['scrobbles_owner_time', 'scrobbles_global_time', 'scrobbles_stats']) db.run(`DROP INDEX ${ix}`);
    });
    const dropped = await inDo((db) =>
      indexed.map((o) => ({
        label: o.label,
        plans: scrobbleQueries(o.statements).map((st) => plan(db, st, 'no-index')),
      })),
    );
    for (const { label, plans: list } of dropped) {
      const all = list.flat();
      expect([label, all.some((d) => FULL_SCAN.test(d))]).toEqual([label, true]);
      expect([label, all.some((d) => INDEXED_SEARCH.test(d) || GLOBAL_ORDERED.test(d))]).toEqual([label, false]);
    }
    // Same answers without the indexes (only slower): plans change, results do
    // not. The first serve stored every statistics body in the exact cache,
    // so the second serve would replay those bodies; the production
    // stats_version bump (what every scrobble insert, change or delete runs)
    // invalidates them first, so the unindexed serve recomputes statistics
    // from the scrobble rows and compares fresh computations.
    const statsComputed = (statements: RecordedStatement[]) =>
      statements.some((s) => /count\(DISTINCT artist_key\)/.test(s.sql)) &&
      statements.some((s) => /INSERT INTO stats_cache/.test(s.sql));
    expect(
      indexed.filter((o) => o.label.startsWith('stats')).map((o) => [o.label, statsComputed(o.statements)]),
    ).toEqual(ROUTES.filter(([l]) => l.startsWith('stats')).map(([l]) => [l, true]));
    const version = (db: Db) => db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', target)?.v;
    const before = await inDo(version);
    await inDo((db) => db.tx(() => bumpStatsVersion(db, target)));
    expect(await inDo(version)).toBe((before ?? Number.NaN) + 1);
    const unindexed = await serve();
    expect(
      unindexed.filter((o) => o.label.startsWith('stats')).map((o) => [o.label, statsComputed(o.statements)]),
    ).toEqual(ROUTES.filter(([l]) => l.startsWith('stats')).map(([l]) => [l, true]));
    expect(unindexed.map((o) => [o.label, o.text])).toEqual(indexed.map((o) => [o.label, o.text]));
    expect(validated).toBe(DIDS + 2 * indexed.length);
  });
});
