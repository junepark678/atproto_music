import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';
import { insertOperation } from '../../../src/outbox/operations';
// Forwarding to linked ListenBrainz accounts (ADR 0005 §12.2, §12.3, §11.3;
// N3-08): `single` for a live listen, `import` batches of ≤ 100 for a
// backlog, `playing_now` once, recording feedback by MBID, 401 revocation,
// the X-RateLimit-Reset-In wait on 429, 400 as a permanent failure, and the
// 30-day expiry.
//
// The real composition (support/app.ts) with the links feature, the frozen
// clock 2026-01-15T12:00:00Z (stepped, never slept) and seeded randomness.
// ListenBrainz is the fake at listenbrainz.test behind the fixture router; it
// accepts a submission only with a registered `Token`.

import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { SqlParam } from '../../../src/do/db';
import {
  FORWARD_LOVE_RECORDING_LOOKUP_SQL,
  type ForwardRuntime,
  LOVE_RECORDING_HISTORY_LOOKUP_SQL,
  LOVE_RECORDING_HISTORY_PAGE_SQL,
  runForward,
} from '../../../src/forward/forwarder';
import { saveLink } from '../../../src/forward/links';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

interface World {
  app: TestApp;
  clock: FixedClock;
  lb: FakeListenBrainz;
  lastfm: FakeLastfm;
  rt: ForwardRuntime;
  /** Every request to listenbrainz.test: [method, path, clock ms]. */
  seen: Array<[string, string, number]>;
  /** Answers the next ListenBrainz request with this response instead of the fake (which `res` may still call). */
  intercept(res: (req: Request) => Response | Promise<Response>): void;
  link(credential?: string): string;
  scrobbles(n: number, tag?: string): void;
  enqueue(items: ForwardItem[]): number;
  rows(): ForwardOutboxRow[];
  run(): ReturnType<typeof runForward>;
}

async function world(): Promise<World> {
  const clock = fixedClock();
  const lb = new FakeListenBrainz({ clock, rateLimit: 10_000 });
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  lb.addToken('alice_lb', TOKEN);
  const seen: Array<[string, string, number]> = [];
  const intercepts: Array<(req: Request) => Response | Promise<Response>> = [];
  const lbEndpoint = async (req: Request) => {
    const url = new URL(req.url);
    seen.push([req.method, url.pathname, clock.nowMs()]);
    const next = intercepts.shift();
    return next === undefined ? lb.fetch(req) : next(req);
  };
  const app = await startApp({
    clock,
    secrets: parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } }),
    transport: routerTransport({ hosts: { 'listenbrainz.test': lbEndpoint, 'lastfm.test': lastfm } }),
    features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
    env: {
      LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
      LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
      LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
    },
  });
  ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
  const rt = (app.composed.app as unknown as { links: LinksService }).links.forwarding;
  const random = seededRandom(23);
  let seq = 0;
  const w: World = {
    app,
    clock,
    lb,
    lastfm,
    rt,
    seen,
    intercept: (res) => intercepts.push(res),
    link(credential = TOKEN) {
      return saveLink(
        { db: app.db, clock, random: rt.random, box: rt.box },
        { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential },
      ).link.id;
    },
    enqueue: (items) => enqueueForwards(app.db, { did: ALICE, items, now: clock.nowMs(), random }),
    scrobbles(n, tag = 's') {
      const items: ForwardItem[] = [];
      for (let i = 0; i < n; i++) {
        seq += 1;
        items.push({
          kind: 'scrobble',
          listenKey: `${tag}-${seq}`,
          payload: {
            listen: {
              artist: `Artist ${seq}`,
              track: `Track ${seq}`,
              listenedAt: new Date(Date.parse('2026-01-14T00:00:00Z') + seq * MINUTE).toISOString(),
              album: 'Album',
              recordingMbid: MBID,
              durationSeconds: 180,
            },
            origin: 'listenbrainz',
          },
        });
      }
      w.enqueue(items);
    },
    rows: () => app.db.all<ForwardOutboxRow>('SELECT * FROM forward_outbox ORDER BY created_at_ms, rowid'),
    run: () => runForward(rt, clock.nowMs()),
  };
  return w;
}

afterEach(async () => {
  await closeApps();
});

const OTHER = '11111111-2222-4333-8444-555555555555';
function operation(w: World, id: string, kind: string, record: unknown, at: number) {
  w.app.db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,due_at,created_at_ms,updated_at_ms) VALUES(?,?,?,'web',0,'fm.rocksky.love',?,?,?,?,?)`,
    id,
    ALICE,
    kind,
    record === null ? null : JSON.stringify(record),
    record === null ? null : 'digest',
    at,
    at,
    at,
  );
}
function unlove(w: World, id = 'delete', artist = 'Band', track = 'Song') {
  w.enqueue([{ kind: 'unlove', operationId: id, payload: { artist, track } }]);
}
async function drain(w: World, n = 4) {
  for (let i = 0; i < n; i++) {
    await w.run();
    w.clock.advance(10000);
  }
}
it('legacy retained sent forward love with NULL keys still supplies the unlove MBID with MB disabled', async () => {
  const w = await world();
  w.link();
  w.enqueue([
    { kind: 'love', operationId: 'old', payload: { artist: 'ＢＡＮＤ', track: ' Song ', recordingMbid: MBID } },
  ]);
  w.app.db.run("UPDATE forward_outbox SET state='sent',love_artist_key=NULL,love_track_key=NULL");
  w.clock.advance(1);
  unlove(w);
  await drain(w);
  expect(w.rows()[0]!.love_artist_key).toBe('band');
  expect(w.rows()[0]!.love_track_key).toBe('song');
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('fallback uses retained intent if unlove has no existing operation pointer', async () => {
  const w = await world();
  w.link();
  operation(w, 'old', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, w.clock.nowMs() - 100);
  unlove(w, 'missing-pointer');
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('fallback preserves created-at precedence over operation insertion order', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'newer', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, at - 1);
  operation(w, 'older', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: OTHER }, at - 100);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w);
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('exact retained display with a NUL component keeps its old matching semantics', async () => {
  const w = await world();
  w.link();
  w.enqueue([
    { kind: 'love', operationId: 'old', payload: { artist: 'Band\0Part', track: 'Song', recordingMbid: MBID } },
  ]);
  w.app.db.run("UPDATE forward_outbox SET state='sent'");
  w.clock.advance(1);
  unlove(w, 'delete', 'Band\0Part');
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('all 100 ready lanes eventually send with <=32 fetched rows on every five-request run', async () => {
  const w = await world();
  w.link();
  w.enqueue(
    Array.from({ length: 100 }, (_, i) => ({
      kind: 'love' as const,
      operationId: `all-${i}`,
      payload: { artist: `Band ${i}`, track: 'Song', recordingMbid: MBID },
    })),
  );
  const all = w.app.db.all.bind(w.app.db);
  let fetched = 0;
  w.app.db.all = ((sql: string, ...args: SqlParam[]) => {
    const r = all(sql, ...args);
    if (sql.includes('SELECT rowid,love_artist_key,love_track_key,priority,due_at,head_created_at_ms'))
      fetched += r.length;
    return r;
  }) as typeof all;
  for (let i = 0; i < 20; i++) {
    fetched = 0;
    for (let j = 0; j < 5; j++)
      w.intercept(async (req) => {
        const r = await w.lb.fetch(req);
        w.clock.advance(1000);
        return r;
      });
    const r = await w.run();
    expect(r.requests).toBe(5);
    expect(fetched).toBeLessThanOrEqual(32);
  }
  expect(w.rows().filter((r) => r.state === 'sent')).toHaveLength(100);
});

it('initializer is bounded, rolls back cursor on crash, protects deadline pending', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  w.app.db.tx(() => {
    for (let i = 0; i < 300; i++)
      operation(
        w,
        `init-${i}`,
        'love.put',
        {
          artist: i === 299 ? '  ＢＡＮＤ  ' : `Other${i}`,
          track: i === 299 ? ' SONG ' : 'Other',
          recordingMbid: MBID,
        },
        at - 100,
      );
    operation(w, 'delete', 'love.delete', null, at);
  });
  unlove(w);
  w.app.db.run('UPDATE forward_outbox SET created_at_ms=?', at - 25 * 3600000);
  const run = w.app.db.run.bind(w.app.db);
  w.app.db.run = ((sql: string, ...args: SqlParam[]) => {
    if (sql.startsWith('UPDATE forward_love_recording_history_state SET')) throw new Error('crash-before-cursor');
    return run(sql, ...args);
  }) as typeof run;
  await expect(w.run()).rejects.toThrow('crash-before-cursor');
  w.app.db.run = run;
  expect(w.app.db.one<{ n: number }>('SELECT count(*) n FROM forward_love_recording_history')!.n).toBe(0);
  const all = w.app.db.all.bind(w.app.db);
  let scanned = 0;
  w.app.db.all = ((sql: string, ...args: SqlParam[]) => {
    const rows = all(sql, ...args);
    if (sql.includes('SELECT rowid,did,kind,created_at_ms,record_json FROM operations')) scanned += rows.length;
    return rows;
  }) as typeof all;
  for (let i = 0; i < 2; i++) {
    scanned = 0;
    const r = await w.run();
    expect(scanned).toBe(128);
    expect(r.nextDueMs).not.toBeNull();
    expect(w.rows()[0]!.state).toBe('queued');
    w.clock.advance(10000);
  }
  await w.run();
  expect(scanned).toBeLessThanOrEqual(256);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});

it.each(['queued', 'sent', 'failed', 'held', 'ignored', 'expired'])(
  'retained normalized history picks the latest usable record across state %s',
  async (state) => {
    const w = await world();
    w.link();
    w.enqueue([
      { kind: 'love', operationId: 'old', payload: { artist: 'Straße', track: 'ＳＯＮＧ', recordingMbid: OTHER } },
    ]);
    w.app.db.run("UPDATE forward_outbox SET state='sent'");
    w.clock.advance(1);
    w.enqueue([
      { kind: 'love', operationId: 'new', payload: { artist: ' STRASSE ', track: ' song ', recordingMbid: MBID } },
    ]);
    w.app.db.run(
      'UPDATE forward_outbox SET state=?,due_at=? WHERE dedupe_key=?',
      state,
      w.clock.nowMs() + 3600000,
      'new',
    );
    w.clock.advance(1);
    unlove(w, 'delete', 'strasse', 'Song');
    if (state === 'queued') w.app.db.run("UPDATE forward_outbox SET state='sent' WHERE dedupe_key='new'");
    await drain(w);
    expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
  },
);

it('legacy operation initialization resumes on reopened handles and interleaved insertOperation stays idempotent', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  w.app.db.tx(() => {
    for (let i = 0; i < 300; i++)
      operation(w, `restart-${i}`, 'love.put', { artist: `Other${i}`, track: 'Other', recordingMbid: MBID }, at);
  });
  const path = (w.app.db as SqliteDb).path;
  (w.app.db as SqliteDb).close();
  for (let i = 0; i < 4; i++) {
    const db = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      const rt = { ...w.rt, db, pacing: new UpstreamPacing(w.clock) };
      await runForward(rt, w.clock.nowMs());
      if (i === 0) {
        insertOperation(
          db,
          {
            id: 'live-during',
            did: ALICE,
            kind: 'love.put',
            origin: 'web',
            collection: 'fm.rocksky.love',
            rkey: null,
            dueAt: at,
            prepared: { record: { artist: 'ＳＴＲＡＳＳＥ', track: 'Song', recordingMbid: MBID }, digest: 'digest' },
          },
          at,
        );
      }
      if (i === 2) {
        expect(
          db.one<{ complete: number }>('SELECT complete FROM forward_love_recording_history_state')!.complete,
        ).toBe(1);
        insertOperation(
          db,
          {
            id: 'live-after',
            did: ALICE,
            kind: 'love.put',
            origin: 'web',
            collection: 'fm.rocksky.love',
            rkey: null,
            dueAt: at,
            prepared: { record: { artist: 'Straße', track: 'Song', recordingMbid: OTHER }, digest: 'digest' },
          },
          at,
        );
        insertOperation(
          db,
          {
            id: 'final-delete',
            did: ALICE,
            kind: 'love.delete',
            origin: 'web',
            collection: 'fm.rocksky.love',
            rkey: null,
            dueAt: at,
          },
          at,
        );
        enqueueForwards(db, {
          did: ALICE,
          now: at,
          random: seededRandom(84),
          items: [{ kind: 'unlove', operationId: 'final-delete', payload: { artist: 'strasse', track: 'Song' } }],
        });
      }
      if (i === 3)
        expect(
          db.one<{ n: number }>("SELECT count(*) n FROM forward_love_operation_targets WHERE artist_key='strasse'")!.n,
        ).toBe(2);
    } finally {
      db.close();
    }
    w.clock.advance(10000);
  }
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: OTHER, score: 0 });
});
it('initializer ignores malformed and invalid legacy names without changing validation', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  for (const [i, artist] of [' ', 'a'.repeat(257), '\ud800'].entries())
    operation(w, `bad${i}`, 'love.put', { artist, track: 'Song', recordingMbid: OTHER }, at);
  operation(w, 'good', 'love.put', { artist: 'ＢＡＮＤ', track: ' Song ', recordingMbid: MBID }, at);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w);
  await drain(w);
  expect(w.app.db.one<{ n: number }>('SELECT count(*) n FROM forward_love_recording_history')!.n).toBe(1);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});

it('operation target lookup resumes bounded pages past newer rowids and returns the exact older target', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'eligible', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, at - 100);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w, 'delete');
  for (let i = 0; i < 140; i++)
    operation(w, `later-${i}`, 'love.put', { artist: 'Band', track: 'Song', recordingMbid: OTHER }, at + 1000 + i);
  await drain(w, 8);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
  expect(w.app.db.one<{ n: number }>('SELECT count(*) n FROM forward_unlove_lookup_progress')!.n).toBe(0);
});

it('database insert failure during initialization rolls back its cursor and retries the page', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'old', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, at - 100);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w);
  const run = w.app.db.run.bind(w.app.db);
  let failed = false;
  w.app.db.run = ((sql: string, ...args: SqlParam[]) => {
    if (!failed && sql.includes('INSERT OR IGNORE INTO forward_love_operation_targets\n')) {
      failed = true;
      throw new Error('target-insert-failure');
    }
    return run(sql, ...args);
  }) as typeof run;
  await expect(w.run()).rejects.toThrow('target-insert-failure');
  w.app.db.run = run;
  expect(
    w.app.db.one<{ cursor_rowid: number }>('SELECT cursor_rowid FROM forward_love_operation_targets_state')!
      .cursor_rowid,
  ).toBe(0);
  expect(w.app.db.one<{ n: number }>('SELECT count(*) n FROM forward_love_operation_targets')!.n).toBe(0);
  await drain(w, 4);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});

it('exported retained lookup SQL returns the newest same-key target', async () => {
  const w = await world();
  const db = w.app.db;
  const linkId = w.link();
  const generation = db.one<{ generation: number }>(
    'SELECT generation FROM linked_accounts WHERE id=?',
    linkId,
  )!.generation;
  db.run(
    'INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid) VALUES(?,?,?,?,?,?,?)',
    1,
    linkId,
    generation,
    'band',
    'song',
    10_001,
    MBID,
  );
  expect(db.all(FORWARD_LOVE_RECORDING_LOOKUP_SQL, linkId, generation, 'band', 'song', 10_002, 2)).toEqual([
    { recording_mbid: MBID },
  ]);
  expect(db.all(LOVE_RECORDING_HISTORY_LOOKUP_SQL, ALICE, 'band', 'song')).toEqual([]);
  expect(db.all(LOVE_RECORDING_HISTORY_PAGE_SQL, ALICE, 'band', 'song', 10_000, 1)).toEqual([]);
});
