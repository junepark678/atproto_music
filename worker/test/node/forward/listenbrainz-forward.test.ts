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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { migrate } from '../../../src/do/migrate';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import { LASTFM_EXPIRY_MS, LISTENBRAINZ_EXPIRY_MS } from '../../../src/forward/forward-outbox';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { saveLink } from '../../../src/forward/links';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { openSqliteDb, type SqliteDb } from '../../../src/node/sqlite-db';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz, type LbSubmission } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

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

const listensOf = (s: LbSubmission) =>
  (s.json as { payload: Array<{ track_metadata: { track_name: string } }> }).payload;

function queueDelete(w: World, linkId: string, id: string, listenedAt: number, artist: string, track: string) {
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  const now = w.clock.nowMs();
  w.app.db.run(
    `INSERT INTO listenbrainz_deletes
    (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
    VALUES(?,?,?,1,?,?, ?,?,?,?,?,'api','queued',0,?,?,?,?)`,
    id,
    id,
    linkId,
    ALICE,
    id,
    listenedAt,
    artistKey,
    trackKeyValue,
    artist,
    track,
    now,
    now + 7 * DAY,
    now,
    now,
  );
}

describe('ListenBrainz forwarding', () => {
  it('persists the matched upstream target, then deletes that exact listen on a later paced invocation', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const msid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const [aKey, tKey] = trackKey('STRASSE', '  TARGET   TRACK  ');
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt - 1,
        recording_msid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        track_metadata: { artist_name: 'Straße', track_name: 'target track' },
      },
      {
        listened_at: listenedAt + 1,
        recording_msid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        track_metadata: { artist_name: 'Straße', track_name: 'target track' },
      },
      {
        listened_at: listenedAt,
        recording_msid: msid,
        track_metadata: {
          artist_name: 'Straße',
          track_name: 'target track',
          additional_info: { recording_mbid: MBID },
        },
      },
      {
        listened_at: listenedAt,
        recording_msid: msid,
        track_metadata: { artist_name: 'Straße', track_name: 'target track' },
      },
      {
        listened_at: listenedAt + 2,
        recording_msid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        track_metadata: { artist_name: 'Straße', track_name: 'target track' },
      },
    ]);
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('delete-test','event-1',?,1,?,'identity-1',?,?,?, 'STRASSE','  TARGET   TRACK  ','api','queued',0,?,?,?,?)`,
      linkId,
      ALICE,
      listenedAt,
      aKey,
      tKey,
      w.clock.nowMs(),
      w.clock.nowMs() + DAY,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );

    const first = await runDeleteSlice({
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    });
    expect(first.state).toBe('target_persisted');
    expect(
      w.app.db.one('SELECT target_msid,target_listened_at,state FROM listenbrainz_deletes WHERE id=?', 'delete-test'),
    ).toEqual({ target_msid: msid, target_listened_at: listenedAt, state: 'queued' });
    expect(w.lb.deletions).toEqual([]);
    w.clock.advance(1000);
    const second = await runDeleteSlice({
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    });
    expect(second.state).toBe('sent');
    expect(w.lb.deletions).toEqual([
      { user: 'alice_lb', token: TOKEN, scheme: 'Token', listened_at: listenedAt, recording_msid: msid },
    ]);
    expect(w.lb.listens('alice_lb')).toHaveLength(5); // HTTP 200 is async acceptance, not absence confirmation.
    expect(
      w.app.db.one('SELECT state,target_msid,target_listened_at FROM listenbrainz_deletes WHERE id=?', 'delete-test'),
    ).toEqual({ state: 'sent', target_msid: msid, target_listened_at: listenedAt });
  });

  it('reopens durable lookup target and reuses the exact candidate after a transient POST failure', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const msid = '12121212-1212-4212-8212-121212121212';
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt + 1,
        recording_msid: msid,
        track_metadata: { artist_name: 'Restart Artist', track_name: 'Restart Track' },
      },
    ]);
    queueDelete(w, linkId, 'restart-delete', listenedAt, 'Restart Artist', 'Restart Track');
    const initialDeps = {
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    };
    expect((await runDeleteSlice(initialDeps)).state).toBe('target_persisted');
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-delete-restart-'));
    const path = join(dir, 'restart.db');
    await sqlite.backup(w.app.db.raw, path);
    await w.app.close();
    let db: SqliteDb | null = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      expect(migrate(db)).toEqual({ status: 'ready', version: 42 });
      expect(
        db.one('SELECT target_msid,target_listened_at FROM listenbrainz_deletes WHERE id=?', 'restart-delete'),
      ).toEqual({
        target_msid: msid,
        target_listened_at: listenedAt + 1,
      });
      const dependencies = {
        db,
        clock: w.clock,
        random: w.rt.random,
        box: w.rt.box,
        client: w.rt.listenbrainz,
        pacing: new UpstreamPacing(w.clock),
      };
      w.clock.advance(1000);
      w.lb.fail({ status: 503, path: '/1/delete-listen' });
      expect((await runDeleteSlice(dependencies)).state).toBe('retry');
      const retry = db.one<{ target_msid: string; target_listened_at: number; due_at: number }>(
        'SELECT target_msid,target_listened_at,due_at FROM listenbrainz_deletes WHERE id=?',
        'restart-delete',
      );
      expect(retry).toMatchObject({ target_msid: msid, target_listened_at: listenedAt + 1 });
      db.close();
      db = openSqliteDb(path, { busyTimeoutMs: 200 });
      expect(migrate(db)).toEqual({ status: 'ready', version: 42 });
      w.clock.set(new Date(retry!.due_at).toISOString());
      expect(
        (
          await runDeleteSlice({
            ...dependencies,
            db,
            pacing: new UpstreamPacing(w.clock),
          })
        ).state,
      ).toBe('sent');
      expect(w.lb.deletions).toEqual([
        { user: 'alice_lb', token: TOKEN, scheme: 'Token', listened_at: listenedAt + 1, recording_msid: msid },
      ]);
      expect(
        db.one('SELECT state,target_msid,target_listened_at FROM listenbrainz_deletes WHERE id=?', 'restart-delete'),
      ).toEqual({
        state: 'sent',
        target_msid: msid,
        target_listened_at: listenedAt + 1,
      });
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('production forward timer dispatches queued deletion work after live forward priority', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const msid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const [aKey, tKey] = trackKey('Timer Artist', 'Timer Track');
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt,
        recording_msid: msid,
        track_metadata: { artist_name: 'Timer Artist', track_name: 'Timer Track' },
      },
    ]);
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('timer-delete','event-timer',?,1,?,'identity-timer',?,?,?, 'Timer Artist','Timer Track','api','queued',0,?,?,?,?)`,
      linkId,
      ALICE,
      listenedAt,
      aKey,
      tKey,
      w.clock.nowMs(),
      w.clock.nowMs() + DAY,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    w.scrobbles(1, 'live-priority');
    const core = w.app.composed.core;
    core.extensionTimers.kick('forward');
    await core.tick('extension');
    expect(w.lb.submissions).toHaveLength(1);
    expect(w.app.db.one('SELECT target_msid FROM listenbrainz_deletes WHERE id=?', 'timer-delete')).toEqual({
      target_msid: null,
    });
    w.clock.advance(1000);
    await core.tick('extension');
    expect(w.app.db.one('SELECT target_msid FROM listenbrainz_deletes WHERE id=?', 'timer-delete')).toEqual({
      target_msid: msid,
    });
    w.clock.advance(1000);
    await core.tick('extension');
    expect(w.lb.deletions).toHaveLength(1);
    expect(w.app.db.one('SELECT state FROM listenbrainz_deletes WHERE id=?', 'timer-delete')).toEqual({
      state: 'sent',
    });
  });

  it('production timer wakes at the retry deadline when persisted backoff is later', async () => {
    const w = await world();
    const linkId = w.link();
    const now = w.clock.nowMs();
    queueDelete(w, linkId, 'deadline-wakeup', 1768392000, 'Deadline Artist', 'Deadline Track');
    const deadline = now + 5_000;
    w.app.db.run(
      "UPDATE listenbrainz_deletes SET due_at=?,deadline_at=? WHERE id='deadline-wakeup'",
      now + 60_000,
      deadline,
    );
    const core = w.app.composed.core;
    core.extensionTimers.kick('forward');
    await core.tick('extension');
    expect(w.seen).toEqual([]);
    expect(w.app.db.one("SELECT due_at FROM timers WHERE name='forward'")).toEqual({ due_at: deadline });
  });

  it('ignores saturated same-second pages even when one visible near candidate looks usable', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const exactCandidateMsid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const [artist, track] = trackKey('Flood Artist', 'Flood Track');
    w.lb.seedListens(
      'alice_lb',
      Array.from({ length: 1001 }, (_, i) => ({
        listened_at: listenedAt - 1,
        recording_msid: i === 0 ? exactCandidateMsid : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        track_metadata: {
          artist_name: i === 0 ? 'Flood Artist' : `Other ${i}`,
          track_name: i === 0 ? 'Flood Track' : 'Other',
        },
      })),
    );
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('saturated','saturated',?,1,?,'saturated',?,?,?,'Flood Artist','Flood Track','api','queued',0,?,?,?,?)`,
      linkId,
      ALICE,
      listenedAt,
      artist,
      track,
      w.clock.nowMs(),
      w.clock.nowMs() + DAY,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    const run = () =>
      runDeleteSlice({
        db: w.app.db,
        clock: w.clock,
        random: w.rt.random,
        box: w.rt.box,
        client: w.rt.listenbrainz,
        pacing: w.rt.pacing,
      });
    expect((await run()).state).toBe('ignored');
    expect(w.app.db.one('SELECT state,last_error FROM listenbrainz_deletes WHERE id=?', 'saturated')).toEqual({
      state: 'ignored',
      last_error: 'ambiguous_saturated',
    });
    expect(w.lb.deletions).toEqual([]);
    expect(w.lb.calls.filter({ path: '/1/user/alice_lb/listens' }).map((call) => call.params)).toEqual([
      { min_ts: ['1768391998'], count: ['1000'] },
    ]);
  });

  it('never substitutes an MBID for a missing recording_msid and enforces the seven-day deadline before egress', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const [artist, track] = trackKey('Missing Artist', 'Missing Track');
    w.intercept(() =>
      Response.json({
        payload: {
          listens: [
            {
              listened_at: listenedAt,
              track_metadata: {
                artist_name: 'Missing Artist',
                track_name: 'Missing Track',
                mbid_mapping: { recording_mbid: MBID },
              },
            },
          ],
        },
      }),
    );
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('missing-msid','missing-msid',?,1,?,'missing-msid',?,?,?,'Missing Artist','Missing Track','api','queued',0,?,?,?,?)`,
      linkId,
      ALICE,
      listenedAt,
      artist,
      track,
      w.clock.nowMs(),
      w.clock.nowMs() + DAY,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    const deps = {
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    };
    expect((await runDeleteSlice(deps)).state).toBe('ignored');
    expect(w.lb.deletions).toEqual([]);
    w.app.db.run(
      "UPDATE listenbrainz_deletes SET state='queued',due_at=?,deadline_at=? WHERE id='missing-msid'",
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    expect((await runDeleteSlice(deps)).state).toBe('expired');
    expect(w.seen).toHaveLength(1);
  });

  it('same-account relink keeps delete work, while a different remote expires the old generation', async () => {
    const w = await world();
    const linkId = w.link();
    const now = w.clock.nowMs();
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('relink-delete','relink-delete',?,1,?,'identity',1,'a','t','A','T','api','queued',0,?,?,?,?)`,
      linkId,
      ALICE,
      now,
      now + DAY,
      now,
      now,
    );
    saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: TOKEN },
    );
    expect(w.app.db.one('SELECT generation,state FROM listenbrainz_deletes WHERE id=?', 'relink-delete')).toEqual({
      generation: 1,
      state: 'queued',
    });
    saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'new_lb_account', credential: TOKEN },
    );
    expect(
      w.app.db.one('SELECT generation,state,last_error FROM listenbrainz_deletes WHERE id=?', 'relink-delete'),
    ).toEqual({ generation: 1, state: 'expired', last_error: 'account_changed' });
  });

  it('retries transient delete failure with the persisted target and stops exactly at the attempt budget', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const msid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const [aKey, tKey] = trackKey('Retry Artist', 'Retry Track');
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt,
        recording_msid: msid,
        track_metadata: { artist_name: 'Retry Artist', track_name: 'Retry Track' },
      },
    ]);
    w.app.db.run(
      `INSERT INTO listenbrainz_deletes
      (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
      VALUES('retry-delete','retry-delete',?,1,?,'retry-key',?,?,?,'Retry Artist','Retry Track','api','queued',30,?,?,?,?)`,
      linkId,
      ALICE,
      listenedAt,
      aKey,
      tKey,
      w.clock.nowMs(),
      w.clock.nowMs() + DAY,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    const deps = {
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    };
    expect((await runDeleteSlice(deps)).state).toBe('target_persisted');
    w.clock.advance(1000);
    w.lb.fail({ status: 503, path: '/1/delete-listen' });
    expect((await runDeleteSlice(deps)).state).toBe('retry');
    const pinned = w.app.db.one<{ target_msid: string; target_listened_at: number; attempts: number; due_at: number }>(
      'SELECT target_msid,target_listened_at,attempts,due_at FROM listenbrainz_deletes WHERE id=?',
      'retry-delete',
    );
    expect(pinned).toMatchObject({ target_msid: msid, target_listened_at: listenedAt, attempts: 32 });
    w.clock.set(new Date(pinned!.due_at).toISOString());
    expect((await runDeleteSlice(deps)).state).toBe('failed');
    expect(
      w.app.db.one<{ attempts: number }>('SELECT attempts FROM listenbrainz_deletes WHERE id=?', 'retry-delete'),
    ).toEqual({ attempts: 32 });
    expect(w.lb.deletions).toEqual([]);
  });

  it('malformed lookup retries instead of being classified as a successful no-match', async () => {
    const w = await world();
    const linkId = w.link();
    queueDelete(w, linkId, 'malformed-lookup', 1768392000, 'Malformed Artist', 'Malformed Track');
    w.intercept(() =>
      Response.json({
        payload: {
          listens: [
            {
              listened_at: 1768392000,
              recording_msid: 'not-a-uuid',
              track_metadata: { artist_name: 'Malformed Artist', track_name: 'Malformed Track' },
            },
          ],
        },
      }),
    );

    const result = await runDeleteSlice({
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    });

    expect(result.state).toBe('lookup_retry');
    expect(
      w.app.db.one('SELECT state,last_error,attempts FROM listenbrainz_deletes WHERE id=?', 'malformed-lookup'),
    ).toEqual({
      state: 'queued',
      last_error: 'malformed_response',
      attempts: 1,
    });
  });

  it.each([
    { status: 400, state: 'failed', error: 'upstream_400', linkStatus: 'active' },
    { status: 401, state: 'failed', error: 'credential_revoked', linkStatus: 'revoked' },
    { status: 429, state: 'queued', error: 'rate_limited', linkStatus: 'active' },
  ])('classifies delete HTTP $status without false success', async ({ status, state, error, linkStatus }) => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt,
        recording_msid: 'abababab-abab-4bab-8bab-abababababab',
        track_metadata: { artist_name: 'Status Artist', track_name: 'Status Track' },
      },
    ]);
    queueDelete(w, linkId, `status-${status}`, listenedAt, 'Status Artist', 'Status Track');
    const deps = {
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    };
    expect((await runDeleteSlice(deps)).state).toBe('target_persisted');
    w.clock.advance(1000);
    w.intercept(() =>
      Response.json({ error: 'safe fixture error' }, { status, headers: { 'X-RateLimit-Reset-In': '17' } }),
    );

    expect((await runDeleteSlice(deps)).state).toBe(status === 429 ? 'retry' : 'failed');
    expect(
      w.app.db.one('SELECT state,last_error,attempts FROM listenbrainz_deletes WHERE id=?', `status-${status}`),
    ).toMatchObject({
      state,
      last_error: error,
      attempts: 2,
    });
    expect(w.app.db.one('SELECT status FROM linked_accounts WHERE id=?', linkId)).toEqual({ status: linkStatus });
    expect(w.lb.deletions).toEqual([]);
  });

  it('an in-flight delete success after a different-remote relink cannot settle the expired old-generation row', async () => {
    const w = await world();
    const linkId = w.link();
    const listenedAt = 1768392000;
    const msid = '99999999-9999-4999-8999-999999999999';
    w.lb.seedListens('alice_lb', [
      {
        listened_at: listenedAt,
        recording_msid: msid,
        track_metadata: { artist_name: 'Fence Artist', track_name: 'Fence Track' },
      },
    ]);
    queueDelete(w, linkId, 'generation-fence', listenedAt, 'Fence Artist', 'Fence Track');
    const deps = {
      db: w.app.db,
      clock: w.clock,
      random: w.rt.random,
      box: w.rt.box,
      client: w.rt.listenbrainz,
      pacing: w.rt.pacing,
    };
    expect((await runDeleteSlice(deps)).state).toBe('target_persisted');
    w.clock.advance(1000);

    let release!: () => void;
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestStartedAt = w.clock.nowMs();
    w.intercept(async () => {
      entered();
      await responseGate;
      return Response.json(
        { status: 'ok' },
        { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-In': '600' } },
      );
    });
    const inflight = runDeleteSlice(deps);
    await requestEntered;
    saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'new_remote', credential: TOKEN },
    );
    release();

    expect((await inflight).state).toBe('stale_response');
    expect(w.app.db.one('SELECT state,last_error FROM listenbrainz_deletes WHERE id=?', 'generation-fence')).toEqual({
      state: 'expired',
      last_error: 'account_changed',
    });
    expect(w.app.db.one('SELECT remote_user,status FROM linked_accounts WHERE id=?', linkId)).toEqual({
      remote_user: 'new_remote',
      status: 'active',
    });
    expect(w.rt.pacing.listenbrainzAvailableAt(`link:${linkId}:generation:1`)).toBe(requestStartedAt + 1000);
    expect(w.rt.pacing.listenbrainzAvailableAt(`link:${linkId}:generation:2`)).toBe(Number.NEGATIVE_INFINITY);
    expect(
      w.app.db.one(
        'SELECT last_success_ms,last_failure_ms,last_error,consecutive_failures FROM linked_accounts WHERE id=?',
        linkId,
      ),
    ).toEqual({ last_success_ms: null, last_failure_ms: null, last_error: null, consecutive_failures: 0 });
  });
  it('delete client uses the pinned policy fetch, parses top-level MSID separately from MBID, and accepts async delete 200', async () => {
    const w = await world();
    w.link();
    const seenRequests: Request[] = [];
    w.intercept(async (req) => {
      seenRequests.push(req);
      return Response.json(
        {
          payload: {
            listens: [
              {
                listened_at: 100,
                recording_msid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                track_metadata: { artist_name: 'Artist', track_name: 'Track', mbid_mapping: { recording_mbid: MBID } },
              },
              {
                listened_at: 101,
                recording_msid: null,
                track_metadata: {
                  artist_name: 'No MSID',
                  track_name: 'Track',
                  additional_info: { recording_mbid: MBID },
                },
              },
            ],
          },
        },
        { headers: { 'X-RateLimit-Remaining': '4' } },
      );
    });
    w.intercept(async (req) => {
      seenRequests.push(req);
      expect(new URL(req.url).pathname).toBe('/1/delete-listen');
      return Response.json({ status: 'ok' });
    });
    const page = await w.rt.listenbrainz.listWindowPage('alice_lb', TOKEN, 98, 1000);
    expect(page).toMatchObject({
      ok: true,
      value: [
        { listenedAt: 100, recordingMsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', artist: 'Artist', track: 'Track' },
        { listenedAt: 101, recordingMsid: null, artist: 'No MSID', track: 'Track' },
      ],
    });
    expect(new URL(seenRequests[0]!.url).search).toBe('?min_ts=98&count=1000');
    expect(seenRequests[0]!.headers.get('authorization')).toBe(`Token ${TOKEN}`);
    const deleted = await w.rt.listenbrainz.deleteListen(TOKEN, {
      listened_at: 100,
      recording_msid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(deleted).toMatchObject({ ok: true, accepted: true });
    expect(seenRequests[1]!.method).toBe('POST');
    expect(seenRequests[1]!.headers.get('authorization')).toBe(`Token ${TOKEN}`);
    expect(await seenRequests[1]!.clone().json()).toEqual({
      listened_at: 100,
      recording_msid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('delete client classifies malformed pages and malformed delete success distinctly', async () => {
    const w = await world();
    w.link();
    w.intercept(() => Response.json({ payload: { listens: [{ listened_at: 'bad', track_metadata: {} }] } }));
    expect(await w.rt.listenbrainz.listWindowPage('alice_lb', TOKEN, 10, 10)).toMatchObject({
      ok: false,
      kind: 'malformed',
      status: 502,
    });
    w.intercept(() => Response.json({ status: 'queued' }));
    expect(
      await w.rt.listenbrainz.deleteListen(TOKEN, {
        listened_at: 10,
        recording_msid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toMatchObject({ ok: false, kind: 'malformed', status: 502 });
    w.intercept(() =>
      Response.json({
        payload: {
          listens: [
            { listened_at: 10, recording_msid: 'not-a-uuid', track_metadata: { artist_name: 'A', track_name: 'B' } },
          ],
        },
      }),
    );
    expect(await w.rt.listenbrainz.listWindowPage('alice_lb', TOKEN, 8, 10)).toMatchObject({
      ok: false,
      kind: 'malformed',
      error: 'malformed recording_msid',
    });
  });

  it('delete client preserves 429 rate headers and permanent HTTP status classification', async () => {
    const w = await world();
    w.link();
    w.intercept(() =>
      Response.json({ error: 'slow down' }, { status: 429, headers: { 'X-RateLimit-Reset-In': '17' } }),
    );
    expect(await w.rt.listenbrainz.listWindowPage('alice_lb', TOKEN, 10, 10)).toMatchObject({
      ok: false,
      kind: 'status',
      status: 429,
      rate: { resetInS: 17 },
    });
  });

  it('a live listen goes as single, a backlog as import batches of at most 100, now playing as playing_now once', async () => {
    const w = await world();
    w.link();

    // One live listen: `single`, with the original metadata and our Token.
    w.scrobbles(1);
    await w.run();
    expect(w.lb.submissions).toHaveLength(1);
    expect(w.lb.submissions[0]).toMatchObject({
      user: 'alice_lb',
      token: TOKEN,
      scheme: 'Token',
      listenType: 'single',
    });
    expect(w.lb.submissions[0]?.json).toEqual({
      listen_type: 'single',
      payload: [
        {
          listened_at: Date.parse('2026-01-14T00:01:00Z') / 1000,
          track_metadata: {
            artist_name: 'Artist 1',
            track_name: 'Track 1',
            release_name: 'Album',
            additional_info: { recording_mbid: MBID, duration_ms: 180_000 },
          },
        },
      ],
    });

    // A backlog of 250: import batches of 100, 100 and 50, oldest first, one request per second.
    w.scrobbles(250);
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      const report = await w.run();
      expect(report.requests).toBe(1);
    }
    const imports = w.lb.submissions.slice(1);
    expect(imports.map((s) => [s.listenType, listensOf(s).length])).toEqual([
      ['import', 100],
      ['import', 100],
      ['import', 50],
    ]);
    expect(imports.flatMap((s) => listensOf(s).map((l) => l.track_metadata.track_name))).toEqual(
      Array.from({ length: 250 }, (_, i) => `Track ${i + 2}`),
    );
    const times = w.seen.map(([, , t]) => t);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(SECOND);
    expect(w.rows().every((r) => r.state === 'sent')).toBe(true);

    // Now playing: `playing_now` without listened_at, sent once.
    w.clock.advance(SECOND);
    const startedAtMs = w.clock.nowMs();
    const play: ForwardItem = {
      kind: 'nowplaying',
      startedAtMs,
      artist: 'Band',
      track: 'Song',
      payload: { track: { artist: 'Band', track: 'Song', album: 'Record' }, startedAtMs, origin: 'listenbrainz' },
    };
    expect(w.enqueue([play])).toBe(1);
    await w.run();
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const playing = w.lb.submissions.filter((s) => s.listenType === 'playing_now');
    expect(playing.map((s) => s.json)).toEqual([
      {
        listen_type: 'playing_now',
        payload: [{ track_metadata: { artist_name: 'Band', track_name: 'Song', release_name: 'Record' } }],
      },
    ]);
    expect(w.lb.playingNow('alice_lb')).toMatchObject({ artist_name: 'Band', track_name: 'Song' });

    // A now playing that fails (503) is not retried.
    w.clock.advance(SECOND);
    const again = w.clock.nowMs();
    w.enqueue([
      { ...play, startedAtMs: again, payload: { track: { artist: 'Band', track: 'Song' }, startedAtMs: again } },
    ]);
    w.lb.fail({ status: 503, path: '/1/submit-listens' });
    await w.run();
    const failed = w.rows().at(-1);
    expect(failed).toMatchObject({ kind: 'nowplaying', state: 'failed', attempts: 1 });
    expect(failed?.last_error).toBe('http_503');
    const count = w.seen.length;
    for (let i = 0; i < 5; i++) {
      w.clock.advance(MINUTE);
      await w.run();
    }
    expect(w.seen.length).toBe(count);
  });

  it('love and unlove go as recording feedback by MBID, and without an MBID they are not forwarded', async () => {
    const w = await world();
    const linkId = w.link();
    const m = w.app.composed.core.deps;
    const MBID_IMPORTED = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
    const MBID_OTHER_APP = '9a8b7c6d-5e4f-4321-9fed-cba987654321';

    const love = async (input: Record<string, string>, origin: 'listenbrainz' | 'import' = 'listenbrainz') =>
      expect((await enqueueLove(m, { did: ALICE, input, origin })).ok).toBe(true);
    const unlove = async (artist: string, track: string) =>
      expect((await enqueueUnlove(m, { did: ALICE, artist, track, origin: 'listenbrainz' })).ok).toBe(true);

    // Queued through the real pipeline (N2-05): a love carries its MBID, an unlove only the track.
    // 1. A live love with an MBID, then a live unlove that spells the track differently (same love key).
    await love({ artist: 'Band', track: 'Song', recordingMbid: MBID });
    await unlove('BAND', ' song ');
    // 2. An imported love queues no forward row; a later live unlove still finds its MBID.
    await love({ artist: 'Imported', track: 'Tune', recordingMbid: MBID_IMPORTED }, 'import');
    await unlove('Imported', 'Tune');
    // 3. A love another app wrote is known only from the loves projection.
    const [artistKey, trackKeyPart] = trackKey('Elsewhere', 'Piece');
    w.app.db.run(`INSERT OR IGNORE INTO users(did, joined_at) VALUES (?, '2026-01-10T00:00:00.000000000Z')`, ALICE);
    w.app.db.run(
      `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
       VALUES (?, ?, ?, ?, 'Elsewhere', 'Piece', NULL, ?, ?, ?, '2026-01-10T00:00:00.000000000Z', '2026-01-10T00:00:01.000Z')`,
      `at://${ALICE}/fm.other.love/3kotherapp222`,
      ALICE,
      '3kotherapp222',
      'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
      artistKey,
      trackKeyPart,
      MBID_OTHER_APP,
    );
    await unlove('Elsewhere', 'Piece');
    // 4. A love without an MBID, and its unlove: no MBID is known anywhere.
    await love({ artist: 'Nobody', track: 'Knows' });
    await unlove('Nobody', 'Knows');
    const [nobodyArtist, nobodyTrack] = trackKey('Nobody', 'Knows');
    w.app.db.run(
      "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,created_at_ms) VALUES(?,?,'','unmatched',?)",
      nobodyArtist,
      nobodyTrack,
      w.clock.nowMs(),
    );

    const queued = w.rows();
    expect(queued.map((r) => r.kind)).toEqual(['love', 'unlove', 'unlove', 'unlove', 'love', 'unlove']);
    // The unloves as enqueueUnlove wrote them: no recordingMbid.
    for (const r of queued.filter((q) => q.kind === 'unlove')) {
      expect(JSON.parse(r.payload_json)).not.toHaveProperty('recordingMbid');
    }

    for (let i = 0; i < 10; i++) {
      await w.run();
      w.clock.advance(SECOND);
    }
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: MBID, score: 1 },
      { recording_mbid: MBID, score: 0 },
      { recording_mbid: MBID_IMPORTED, score: 0 },
      { recording_mbid: MBID_OTHER_APP, score: 0 },
    ]);
    expect(w.lb.feedback.every((f) => f.token === TOKEN)).toBe(true);
    const settled = w.rows();
    expect(settled.map((r) => [r.link_id, r.kind, r.state, r.last_error])).toEqual([
      [linkId, 'love', 'sent', null],
      [linkId, 'unlove', 'sent', null],
      [linkId, 'unlove', 'sent', null],
      [linkId, 'unlove', 'sent', null],
      [linkId, 'love', 'ignored', 'no_recording_mbid'],
      [linkId, 'unlove', 'ignored', 'no_recording_mbid'],
    ]);
    // The resolved MBID is recorded on each sent unlove row.
    expect(settled.filter((r) => r.kind === 'unlove').map((r) => JSON.parse(r.payload_json).recordingMbid)).toEqual([
      MBID,
      MBID_IMPORTED,
      MBID_OTHER_APP,
      undefined,
    ]);
    expect(w.seen.map(([meth, p]) => `${meth} ${p}`)).toEqual(Array(4).fill('POST /1/feedback/recording-feedback'));
  });

  it('keeps same-key love toggles FIFO through backoff while a different track proceeds', async () => {
    const w = await world();
    w.link();
    const addLove = async (artist: string, track: string, mbid: string) =>
      expect(
        (
          await enqueueLove(w.app.composed.core.deps, {
            did: ALICE,
            input: { artist, track, recordingMbid: mbid },
            origin: 'listenbrainz',
          })
        ).ok,
      ).toBe(true);
    const addUnlove = async (artist: string, track: string) =>
      expect(
        (await enqueueUnlove(w.app.composed.core.deps, { did: ALICE, artist, track, origin: 'listenbrainz' })).ok,
      ).toBe(true);

    await addLove('Band', 'Song', MBID);
    await addUnlove('BAND', ' song ');
    const otherMbid = '77777777-7777-4777-8777-777777777777';
    await addLove('Other Band', 'Other Song', otherMbid);
    w.lb.fail({ status: 503, path: '/1/feedback/recording-feedback' });
    await w.run();
    const deferredLove = w.rows().find((row) => row.kind === 'love')!;
    const delayedUnlove = w.rows().find((row) => row.kind === 'unlove')!;
    expect(deferredLove).toMatchObject({ state: 'queued', attempts: 1 });
    expect(deferredLove.due_at).toBeGreaterThan(w.clock.nowMs());

    w.clock.advance(SECOND);
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([{ recording_mbid: otherMbid, score: 1 }]);
    expect(w.rows().find((row) => row.id === delayedUnlove.id)?.state).toBe('queued');

    w.clock.set(new Date(deferredLove.due_at).toISOString());
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: otherMbid, score: 1 },
      { recording_mbid: MBID, score: 1 },
    ]);
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: otherMbid, score: 1 },
      { recording_mbid: MBID, score: 1 },
      { recording_mbid: MBID, score: 0 },
    ]);
    expect(
      w
        .rows()
        .filter((row) => row.kind === 'love' || row.kind === 'unlove')
        .map((row) => row.state),
    ).toEqual(['sent', 'sent', 'sent']);
  });

  it('keeps a newer love behind a backoff unlove so the latest state wins', async () => {
    const w = await world();
    w.link();
    const m = w.app.composed.core.deps;
    expect(
      (
        await enqueueLove(m, {
          did: ALICE,
          input: { artist: 'Band', track: 'Song', recordingMbid: MBID },
          origin: 'listenbrainz',
        })
      ).ok,
    ).toBe(true);
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([{ recording_mbid: MBID, score: 1 }]);

    expect((await enqueueUnlove(m, { did: ALICE, artist: 'Band', track: 'Song', origin: 'listenbrainz' })).ok).toBe(
      true,
    );
    expect(
      (
        await enqueueLove(m, {
          did: ALICE,
          input: { artist: 'BAND', track: ' song ', recordingMbid: MBID },
          origin: 'listenbrainz',
        })
      ).ok,
    ).toBe(true);
    w.clock.advance(SECOND);
    w.lb.fail({ status: 503, path: '/1/feedback/recording-feedback' });
    await w.run();
    const delayedUnlove = w.rows().find((row) => row.kind === 'unlove' && row.state === 'queued')!;
    const newerLove = w
      .rows()
      .filter((row) => row.kind === 'love')
      .at(-1)!;
    expect(delayedUnlove).toMatchObject({ attempts: 1, state: 'queued' });
    expect(newerLove.state).toBe('queued');

    w.clock.advance(SECOND);
    await w.run();
    expect(newerLove.state).toBe('queued');
    expect(w.lb.feedback.map((f) => f.json)).toEqual([{ recording_mbid: MBID, score: 1 }]);

    w.clock.set(new Date(delayedUnlove.due_at).toISOString());
    await w.run();
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: MBID, score: 1 },
      { recording_mbid: MBID, score: 0 },
      { recording_mbid: MBID, score: 1 },
    ]);
  });

  it('defers a pending key persistently, lets another key pass, then forwards on match; unresolved expires as mbid_unresolved', async () => {
    const w = await world();
    const link = w.link();
    const m = w.app.composed.core.deps;
    const addLove = async (artist: string, track: string) =>
      enqueueLove(m, { did: ALICE, input: { artist, track }, origin: 'listenbrainz' });
    await addLove('Pending Artist', 'Pending Song');
    const [pendingArtist, pendingTrack] = trackKey('Pending Artist', 'Pending Song');
    const rowA = w.rows()[0]!;
    await w.run();
    expect(w.rows()[0]).toMatchObject({ state: 'queued', attempts: 0 });
    expect(w.seen).toHaveLength(0);
    expect(w.rows()[0]!.due_at).toBeGreaterThan(w.clock.nowMs());

    await addLove('Ready Artist', 'Ready Song');
    const [readyArtist, readyTrack] = trackKey('Ready Artist', 'Ready Song');
    const recording = '77777777-7777-4777-8777-777777777777';
    w.app.db.run(
      "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms) VALUES(?,?,'','matched',?,?)",
      readyArtist,
      readyTrack,
      recording,
      w.clock.nowMs(),
    );
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([{ recording_mbid: recording, score: 1 }]);
    expect(w.rows().find((r) => r.id === rowA.id)?.state).toBe('queued');

    const resolved = '88888888-8888-4888-8888-888888888888';
    w.app.db.run(
      "UPDATE mb_tracks SET status='matched',recording_mbid=? WHERE artist_key=? AND track_key=?",
      resolved,
      pendingArtist,
      pendingTrack,
    );
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: recording, score: 1 },
      { recording_mbid: resolved, score: 1 },
    ]);
    expect(w.rows().find((r) => r.id === rowA.id)?.state).toBe('sent');

    await addLove('Never Artist', 'Never Song');
    const never = w.rows().at(-1)!;
    const [neverArtist, neverTrack] = trackKey('Never Artist', 'Never Song');
    w.app.db.run("UPDATE mb_tracks SET status='pending' WHERE artist_key=? AND track_key=?", neverArtist, neverTrack);
    await w.run();
    expect(w.rows().at(-1)?.state).toBe('queued');
    w.clock.advance(DAY);
    await w.run();
    expect(w.rows().find((r) => r.id === never.id)).toMatchObject({ state: 'ignored', last_error: 'mbid_unresolved' });
    expect(w.seen.every(([, path]) => path === '/1/feedback/recording-feedback')).toBe(true);
    expect(w.rows().find((r) => r.id === never.id)?.link_id).toBe(link);
  });

  it('401 revokes the link; an attempted 429 counts and waits X-RateLimit-Reset-In; 400 is terminal', async () => {
    const w = await world();
    const id = w.link();

    // 401: link revoked, every queued row held.
    w.scrobbles(2);
    w.lb.fail({ status: 401 });
    await w.run();
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', id)).toEqual({
      status: 'revoked',
      last_error: 'token_revoked',
    });
    expect(w.rows().map((r) => r.state)).toEqual(['held', 'held']);
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.seen).toHaveLength(1);

    // Relinked: the held rows resume.
    w.lb.addToken('alice_lb', 'new-token');
    w.link('new-token');
    expect(w.rows().map((r) => r.state)).toEqual(['queued', 'queued']);

    // 429 is an attempted request: rows count it once while waiting for reset.
    w.lb.fail({ status: 429, resetIn: 42 });
    const limitedAt = w.clock.nowMs();
    await w.run();
    expect(w.rows().map((r) => [r.state, r.due_at, r.attempts, r.last_error])).toEqual([
      ['queued', limitedAt + 42 * SECOND, 1, 'http_429'],
      ['queued', limitedAt + 42 * SECOND, 1, 'http_429'],
    ]);
    const seenAfter429 = w.seen.length;
    for (let s = 1; s < 42; s += 10) {
      w.clock.set(new Date(limitedAt + s * SECOND).toISOString());
      await w.run();
    }
    expect(w.seen.length).toBe(seenAfter429);
    w.clock.set(new Date(limitedAt + 42 * SECOND).toISOString());
    await w.run();
    expect(w.seen.length).toBe(seenAfter429 + 1);
    expect(w.lb.submissions.at(-1)).toMatchObject({ token: 'new-token', listenType: 'import' });
    expect(w.rows().map((r) => r.state)).toEqual(['sent', 'sent']);

    // 400 on a single listen: failed with ListenBrainz's error text, never retried.
    const refusal = () =>
      new Response(JSON.stringify({ code: 400, error: 'Value for key listened_at is too low.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    w.clock.advance(SECOND);
    w.scrobbles(1, 'bad');
    w.intercept(refusal);
    await w.run();
    const bad = w.rows().find((r) => r.dedupe_key.startsWith('bad'));
    expect(bad).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error: 'http_400',
    });
    const seenAfter400 = w.seen.length;
    for (let i = 0; i < 5; i++) {
      w.clock.advance(MINUTE);
      await w.run();
    }
    expect(w.seen.length).toBe(seenAfter400);

    // A 400 on an import: each listen is tried alone, so only the bad one fails.
    w.scrobbles(3, 'batch');
    w.intercept(refusal); // the import
    await w.run();
    w.intercept(refusal); // the first listen alone
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const batch = w.rows().filter((r) => r.dedupe_key.startsWith('batch'));
    expect(batch.map((r) => r.state)).toEqual(['failed', 'sent', 'sent']);
    expect(w.seen.slice(seenAfter400).map(([m, p]) => `${m} ${p}`)).toEqual(Array(4).fill('POST /1/submit-listens'));
    expect(w.lb.submissions.slice(-2).map((s) => s.listenType)).toEqual(['single', 'single']);
  });

  it('a 401 for a request sent before a relink leaves the relinked account active with its rows queued', async () => {
    const w = await world();
    const id = w.link();
    w.scrobbles(2);
    // The import is held in flight until `release`; it then reaches the fake,
    // which answers 401 because the old token was reset in the meantime.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    w.intercept(async (req) => {
      arrived();
      await gate;
      return w.lb.fetch(req);
    });

    const running = w.run();
    await inFlight;
    w.lb.addToken('alice_lb', 'new-token');
    expect(w.link('new-token')).toBe(id);
    w.lb.revokeToken(TOKEN);
    release();
    const report = await running;

    expect(report.requests).toBe(1);
    expect(w.lb.submissions).toHaveLength(0);
    // The refusal was of the old token: the fresh link is not revoked and its rows are not held.
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', id)).toEqual({
      status: 'active',
      last_error: null,
    });
    expect(w.rows().map((r) => r.state)).toEqual(['queued', 'queued']);

    // The next run sends them with the new token.
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.lb.submissions).toHaveLength(1);
    expect(w.lb.submissions[0]).toMatchObject({ token: 'new-token', listenType: 'import' });
    expect(w.rows().map((r) => r.state)).toEqual(['sent', 'sent']);
  });

  it('ListenBrainz rows expire after 30 days, not 13', async () => {
    const w = await world();
    const lbId = w.link();
    const sk = w.lastfm.addSession('alice_fm');
    const fmId = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk },
    ).link.id;
    const t0 = w.clock.nowMs();
    w.scrobbles(1, 'old'); // one row per link
    const byLink = (tag: string) => {
      const rows = w.rows().filter((r) => r.dedupe_key.startsWith(tag));
      return { lb: rows.find((r) => r.link_id === lbId), fm: rows.find((r) => r.link_id === fmId) };
    };

    // 14 days later: the Last.fm row has expired (13 days), the ListenBrainz one is still sent.
    w.clock.set(new Date(t0 + 14 * DAY).toISOString());
    const report = await w.run();
    expect(report.expired?.aged).toBe(1);
    expect(byLink('old').fm).toMatchObject({ state: 'expired', last_error: 'expired' });
    expect(byLink('old').lb).toMatchObject({ state: 'sent' });
    expect(w.lastfm.scrobbles).toHaveLength(0);
    expect(w.lb.submissions).toHaveLength(1);
    expect(14 * DAY).toBeGreaterThan(LASTFM_EXPIRY_MS);

    // A ListenBrainz row that cannot be delivered (the link is revoked and relinked late,
    // or the upstream keeps failing) expires once it is more than 30 days old.
    w.scrobbles(1, 'late');
    const t1 = w.clock.nowMs();
    w.lb.fail({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    w.clock.set(new Date(t1 + 29 * DAY).toISOString());
    await w.run();
    expect(byLink('late').lb).toMatchObject({ state: 'queued', attempts: 1 });
    w.clock.set(new Date(t1 + LISTENBRAINZ_EXPIRY_MS + 1).toISOString());
    const late = await w.run();
    expect(late.expired?.aged).toBe(1);
    expect(late.requests).toBe(0);
    expect(byLink('late').lb).toMatchObject({ state: 'expired', last_error: 'expired', attempts: 1 });
  });
});

it('review: external unlove retains its known MBID after terminal forward GC', async () => {
  const { SignedRepo } = await import('@atmusic/atproto/test-support/signed-repo');
  const { fixtureKeys } = await import('@atmusic/atproto/test-support/keys');
  const { applyRecordProof } = await import('../../../src/do/write/apply-record');
  const { seedUser, putProof, deleteProof, OPTS, PREFIX } = await import('../../write/support');
  const w = await world();
  w.link();
  seedUser(w.app.db, ALICE);
  const repo = new SignedRepo(ALICE, (await fixtureKeys()).alice, { clock: w.clock });
  const opts = { ...OPTS, forwarding: { random: seededRandom(999) } };
  const p = await putProof(repo, `${PREFIX}.love`, 'review-love', {
    $type: `${PREFIX}.love`,
    artist: 'Review artist',
    track: 'Review track',
    recordingMbid: MBID,
    createdAt: '2026-01-15T11:00:00Z',
  });
  w.app.db.tx(() => applyRecordProof(w.app.db, p, opts));
  await w.run();
  expect(w.rows().filter((r) => r.kind === 'love' && r.state === 'sent')).toHaveLength(1);
  w.app.db.run("DELETE FROM forward_outbox WHERE state='sent'");
  w.clock.advance(2000);
  const d = await deleteProof(repo, `${PREFIX}.love`, 'review-love');
  w.app.db.tx(() => applyRecordProof(w.app.db, d, opts));
  await w.run();
  expect(w.rows().filter((r) => r.kind === 'unlove')).toHaveLength(1);
  expect(w.rows().find((r) => r.kind === 'unlove')?.state).toBe('sent');
});
