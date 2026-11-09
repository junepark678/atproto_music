import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueRevivedLoves } from '../../../src/musicbrainz/revive-loves';
import { openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';
import { cancelUnsent, insertOperation } from '../../../src/outbox/operations';
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
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { deleteLink, saveLink } from '../../../src/forward/links';
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
    `INSERT INTO operations(id,did,kind,origin,priority,collection,record_json,digest,due_at,created_at_ms,updated_at_ms,send_state) VALUES(?,?,?,'web',0,'fm.rocksky.love',?,?,?,?,?,'unsent')`,
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

it('held deletion removes target before rowid reuse', async () => {
  const w = await world();
  w.link();
  operation(w, 'held-old', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: OTHER }, w.clock.nowMs());
  w.enqueue([
    { kind: 'love', operationId: 'held-old', payload: { artist: 'Band', track: 'Song', recordingMbid: OTHER } },
  ]);
  w.app.db.run("UPDATE forward_outbox SET state='held'");
  expect(cancelUnsent(w.app.db, 'held-old', w.clock.nowMs())).toBe(true);
  expect(w.rows()).toHaveLength(0);
  w.clock.advance(1);
  w.enqueue([{ kind: 'love', operationId: 'new', payload: { artist: 'Band', track: 'Song', recordingMbid: MBID } }]);
  w.app.db.run("UPDATE forward_outbox SET state='sent'");
  w.clock.advance(1);
  unlove(w);
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('cancelled pending unlove cannot lend cursor to reused forward rowid', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'eligible', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, at - 100);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w);
  for (let i = 0; i < 140; i++)
    operation(
      w,
      `later-${i}`,
      'love.put',
      { artist: 'Band', track: 'Song', recordingMbid: i === 139 ? OTHER : MBID },
      at + 1000 + i,
    );
  await w.run();
  w.clock.advance(10000);
  await w.run();
  expect(w.app.db.one<{ n: number }>('SELECT count(*) n FROM forward_unlove_lookup_progress')!.n).toBe(1);
  expect(cancelUnsent(w.app.db, 'delete', w.clock.nowMs())).toBe(true);
  operation(w, 'new-delete', 'love.delete', null, at + 2000);
  unlove(w, 'new-delete');
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: OTHER, score: 0 });
});
it('cancel rolls target and paging-cache cleanup back when canonical row deletion fails', async () => {
  const w = await world();
  const link = w.link();
  const at = w.clock.nowMs();
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w, 'delete');
  w.app.db.run(
    `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,love_lane)
   VALUES('same-love',?,1,?,'love','delete','{"artist":"Band","track":"Song","recordingMbid":"${MBID}"}','held',1,1,1,'band','song',1)`,
    link,
    ALICE,
  );
  const loveRow = w.app.db.one<{ rowid: number }>("SELECT rowid FROM forward_outbox WHERE id='same-love'")!.rowid;
  const unloveRow = w.app.db.one<{ rowid: number }>(
    "SELECT rowid FROM forward_outbox WHERE kind='unlove' AND dedupe_key='delete'",
  )!.rowid;
  w.app.db.run(
    "INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid) VALUES(?,?,1,'band','song',1,?)",
    loveRow,
    link,
    MBID,
  );
  w.app.db.run('INSERT INTO forward_unlove_lookup_progress VALUES(?,1,1)', unloveRow);
  (w.app.db as SqliteDb).raw.exec(
    `CREATE TRIGGER reject_forward_delete BEFORE DELETE ON forward_outbox BEGIN SELECT RAISE(ABORT,'injected delete failure'); END`,
  );
  expect(() => cancelUnsent(w.app.db, 'delete', w.clock.nowMs())).toThrow('injected delete failure');
  expect(w.app.db.one("SELECT state FROM operations WHERE id='delete'")).toEqual({ state: 'queued' });
  expect(w.app.db.one('SELECT forward_rowid FROM forward_love_recording_targets')).toEqual({ forward_rowid: loveRow });
  expect(w.app.db.one('SELECT unlove_rowid FROM forward_unlove_lookup_progress')).toEqual({ unlove_rowid: unloveRow });
  expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 2 });
});
it('link deletion and account disconnect remove paging cursors before deleting unlove rows', async () => {
  const deleted = await world();
  const link = deleted.link();
  operation(deleted, 'delete', 'love.delete', null, deleted.clock.nowMs());
  unlove(deleted);
  const row = deleted.app.db.one<{ rowid: number }>("SELECT rowid FROM forward_outbox WHERE kind='unlove'")!.rowid;
  deleted.app.db.run('INSERT INTO forward_unlove_lookup_progress VALUES(?,1,1)', row);
  expect(deleteLink({ db: deleted.app.db, revocations: new MemoryRevocations(deleted.clock) }, ALICE, link)).toBe(true);
  expect(deleted.app.db.one('SELECT 1 FROM forward_unlove_lookup_progress')).toBeNull();

  const disconnected = await world();
  const didLink = disconnected.link();
  operation(disconnected, 'delete', 'love.delete', null, disconnected.clock.nowMs());
  unlove(disconnected);
  const didRow = disconnected.app.db.one<{ rowid: number }>(
    "SELECT rowid FROM forward_outbox WHERE kind='unlove'",
  )!.rowid;
  disconnected.app.db.run('INSERT INTO forward_unlove_lookup_progress VALUES(?,1,1)', didRow);
  const { disconnectLocally } = await import('../../../src/http/auth');
  disconnectLocally(
    { db: disconnected.app.db, revocations: new MemoryRevocations(disconnected.clock) },
    ALICE,
    disconnected.clock.nowMs(),
  );
  expect(disconnected.app.db.one('SELECT 1 FROM forward_unlove_lookup_progress')).toBeNull();
  expect(disconnected.app.db.one('SELECT 1 FROM linked_accounts WHERE id=?', didLink)).toBeNull();
});
it('forward initialization truly repairs missing caches in every retained state', async () => {
  for (const state of ['sent', 'held', 'failed', 'ignored', 'expired']) {
    const w = await world();
    w.link();
    w.enqueue([
      { kind: 'love', operationId: 'legacy', payload: { artist: 'ＢＡＮＤ', track: 'Song', recordingMbid: MBID } },
    ]);
    w.app.db.run('DELETE FROM forward_love_recording_targets');
    w.app.db.run('UPDATE forward_outbox SET state=?,love_artist_key=NULL,love_track_key=NULL', state);
    w.clock.advance(1);
    unlove(w);
    await drain(w);
    expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
  }
});
it('exact NUL track pair does not collide with artist NUL pair', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'match', 'love.put', { artist: 'Band', track: 'Part\0Song', recordingMbid: MBID }, at - 100);
  operation(w, 'collision', 'love.put', { artist: 'Band\0Part', track: 'Song', recordingMbid: OTHER }, at - 1);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w, 'delete', 'Band', 'Part\0Song');
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('operation paging survives restart and concurrent immutable newer inserts without skipping newest eligible', async () => {
  const w = await world();
  w.link();
  const at = w.clock.nowMs();
  operation(w, 'older', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: OTHER }, at - 200);
  operation(w, 'eligible', 'love.put', { artist: 'Band', track: 'Song', recordingMbid: MBID }, at - 100);
  operation(w, 'delete', 'love.delete', null, at);
  unlove(w);
  for (let i = 0; i < 400; i++)
    operation(w, `later-${i}`, 'love.put', { artist: 'Band', track: 'Song', recordingMbid: OTHER }, at + 1000 + i);
  const path = (w.app.db as SqliteDb).path;
  (w.app.db as SqliteDb).close();
  for (let j = 0; j < 12; j++) {
    const db = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      let fetched = 0;
      const all = db.all.bind(db);
      db.all = ((sql: string, ...args: SqlParam[]) => {
        const rows = all(sql, ...args);
        if (sql.includes('SELECT operation_rowid,created_at_ms,recording_mbid')) fetched += rows.length;
        return rows;
      }) as typeof all;
      const r = await runForward({ ...w.rt, db, pacing: new UpstreamPacing(w.clock) }, w.clock.nowMs());
      expect(fetched).toBeLessThanOrEqual(128);
      if (w.lb.feedback.length === 0) expect(r.nextDueMs).not.toBeNull();
      insertOperation(
        db,
        {
          id: `concurrent-${j}`,
          did: ALICE,
          kind: 'love.put',
          origin: 'web',
          collection: 'fm.rocksky.love',
          rkey: null,
          dueAt: at,
          prepared: { record: { artist: 'Band', track: 'Song', recordingMbid: OTHER }, digest: 'digest' },
        },
        at + 10000 + j,
      );
    } finally {
      db.close();
    }
    w.clock.advance(10000);
  }
  expect(w.lb.feedback.map((f) => f.json)).toEqual([{ recording_mbid: MBID, score: 0 }]);
});

it('resolved MBID enrichment stays indexed through failed request and retry settlement', async () => {
  const w = await world();
  w.link();
  await w.run();
  w.enqueue([{ kind: 'love', operationId: 'resolve', payload: { artist: 'Band', track: 'Song' } }]);
  w.app.db.run(
    "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms) VALUES('band','song','','matched',?,?)",
    MBID,
    w.clock.nowMs(),
  );
  w.intercept(() => new Response('', { status: 503 }));
  await w.run();
  expect(w.rows()[0]!.state).toBe('queued');
  expect(
    w.app.db.one<{ recording_mbid: string }>('SELECT recording_mbid FROM forward_love_recording_targets')!
      .recording_mbid,
  ).toBe(MBID);
  w.app.db.run('DELETE FROM mb_tracks');
  w.clock.advance(3600000);
  await w.run();
  expect(w.rows()[0]!.state).toBe('sent');
  w.clock.advance(10000);
  unlove(w);
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
it('revived love indexes its enriched MBID after initializer completion', async () => {
  const w = await world();
  w.link();
  await w.run();
  w.enqueue([{ kind: 'love', operationId: 'revive', payload: { artist: 'Band', track: 'Song' } }]);
  w.app.db.run("UPDATE forward_outbox SET state='ignored',last_error='mbid_unresolved'");
  const r = enqueueRevivedLoves(w.app.db, { artistKey: 'band', trackKey: 'song' }, MBID, w.clock.nowMs(), 100);
  expect(r.enqueued).toBe(1);
  expect(
    w.app.db.one<{ recording_mbid: string }>('SELECT recording_mbid FROM forward_love_recording_targets')!
      .recording_mbid,
  ).toBe(MBID);
  await w.run();
  w.clock.advance(10000);
  unlove(w);
  await drain(w);
  expect(w.lb.feedback.map((f) => f.json)).toContainEqual({ recording_mbid: MBID, score: 0 });
});
