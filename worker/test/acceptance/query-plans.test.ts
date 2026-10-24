// W6-01 query plans at scale (ADR 0004 §10.4 "Query plans"; M6.2.3
// slow_query_detection).
//
// 100 DIDs × 1,000 scrobbles, real signed repositories on four fake PDS
// hosts, each DID announced through POST /api/v1/notify `{did}` and indexed by
// exactly one range snapshot of its signed head, run by the real IndexDO alarm
// (admission → getBlocks walk → applySnapshotChunk → completeSnapshot). Then
// the history, global feed, following feed and statistics routes are served
// over HTTP while the TestIndexDO's pass-through Db records every statement the
// production read modules run, and each recorded statement is planned with
// EXPLAIN QUERY PLAN:
// - with the schema's indexes: history and stats SEARCH scrobbles by DID
//   through scrobbles_owner_time / scrobbles_stats, the global feed walks
//   scrobbles_global_time in order, and nothing scans scrobbles or sorts it
//   in a temporary B-tree;
// - negative control: with those indexes dropped, the same statements plan a
//   full SCAN of scrobbles, and the routes still answer identically.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { FakeRelay } from '@atmusic/atproto/test-support/fake-relay';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/do/db';
import { doDb } from '../../src/do/db';
import type { Env } from '../../src/env';
import { createWorker } from '../../src/router';
import { ACCEPTANCE, type RecordedStatement, resetControl, type TestIndexDO } from './entry';
import { checkResponse } from './support/openapi';
import { acceptanceEnv, FOLLOW, flush, freshName, SCROBBLE } from './support/seed';

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
  it('100×1,000 seeded records: history/feed/stats plans use indexes; negative control scans', async () => {
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

    // The real IndexDO on that network; ingestion is notify + snapshot only here.
    resetControl({ clock, random: seededRandom(9), transport, env: { INGEST_MODE: 'off' } });
    const name = freshName('query-plans');
    const stub = acceptanceEnv.INDEX.get(
      acceptanceEnv.INDEX.idFromName(name),
    ) as unknown as DurableObjectStub<TestIndexDO>;
    const worker = createWorker({ clock, random: seededRandom(13), indexName: name });
    const workerEnv = acceptanceEnv as unknown as Env;
    let validated = 0;
    const request = async (path: string, init: RequestInit & { ip?: string } = {}) => {
      const url = `https://music.example.test${path}`;
      const headers = new Headers(init.headers);
      if (init.ip !== undefined) headers.set('cf-connecting-ip', init.ip);
      const req = new Request(url, { ...init, headers });
      const res = await worker.fetch(req, workerEnv, {} as ExecutionContext);
      const text = await res.text();
      const body = JSON.parse(text) as Json;
      const verdict = checkResponse(req.method, url, { status: res.status, headers: res.headers, body });
      if (verdict !== 'valid') throw new Error(`${path}: ${verdict}`);
      validated += 1;
      return { status: res.status, text, body };
    };
    const inDo = <R>(fn: (db: Db, i: TestIndexDO) => R | Promise<R>) =>
      runInDurableObject(stub, (i: TestIndexDO, state) => fn(doDb(state.storage), i));
    const alarm = async () => {
      await runDurableObjectAlarm(stub);
      await flush();
    };

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
          await inDo((_db, i) => i[ACCEPTANCE]().record());
          const r = await request(url);
          const statements = await inDo((_db, i) => i[ACCEPTANCE]().stopRecording());
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
    // Same answers without the indexes (only slower): plans change, results do not.
    const unindexed = await serve();
    expect(unindexed.map((o) => [o.label, o.text])).toEqual(indexed.map((o) => [o.label, o.text]));
    expect(validated).toBe(DIDS + 2 * indexed.length);
  });
});
