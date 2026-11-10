// Large forwarding fixtures for ADR 0005 §15.1. The database is the real
// node:sqlite adapter with the production schema; large rows are seeded in
// transactions so the benchmark measures query and state-transition work.

import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, expect, it } from 'vitest';
import { MemoryRevocations } from '../../src/app/revocations';
import { ensureAccount } from '../../src/credentials/accounts';
import type { SqlParam } from '../../src/do/db';
import { LISTENBRAINZ_EXPIRY_MS, MAX_EXPIRY_TRANSITIONS_PER_RUN } from '../../src/forward/forward-outbox';
import {
  FORWARD_LOVE_RECORDING_LOOKUP_SQL,
  LOVE_RECORDING_HISTORY_LOOKUP_SQL,
  LOVE_RECORDING_HISTORY_PAGE_SQL,
  MAX_LOCAL_WORK_PER_RUN,
  nextForwardDue,
  runForward,
} from '../../src/forward/forwarder';
import { saveLink } from '../../src/forward/links';
import { HEAD_SQL, LANE_PICK_SQL, UNFRAMED_SQL } from '../../src/forward/love-lanes';
import { type LinksService, linksFeature } from '../../src/http/links';
import { parseSecrets } from '../../src/node/secrets';
import { enqueueForwards } from '../../src/outbox/forward-enqueue';
import { closeApps, startApp, testSecretsDocument } from '../node/support/app';
import { FakeLastfm } from '../node/support/fake-lastfm';
import { FakeListenBrainz } from '../node/support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const BOB = 'did:plc:bobbobbobbobbobbob';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';

async function benchWorld() {
  const clock = fixedClock();
  const lb = new FakeListenBrainz({ clock, rateLimit: 10_000 });
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  lb.addToken('alice_lb', TOKEN);
  const app = await startApp({
    clock,
    secrets: parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } }),
    transport: routerTransport({ hosts: { 'listenbrainz.test': lb, 'lastfm.test': lastfm } }),
    features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
    env: {
      LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
      LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
      LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
    },
  });
  ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
  const rt = (app.composed.app as unknown as { links: LinksService }).links.forwarding;
  const linkId = saveLink(
    { db: app.db, clock, random: seededRandom(23), box: rt.box },
    { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: TOKEN },
  ).link.id;
  const generation = app.db.one<{ generation: number }>(
    'SELECT generation FROM linked_accounts WHERE id=?',
    linkId,
  )!.generation;
  return { app, clock, lb, rt, linkId, generation };
}

afterEach(async () => closeApps());

it('keeps forwarder query and row work flat from 200 to 2,000 love keys with 1,000 scrobbles', async () => {
  const measure = async (loveCount: number) => {
    const w = await benchWorld();
    const now = w.clock.nowMs();
    w.app.db.tx(() => {
      for (let i = 0; i < 1_000; i++)
        w.app.db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,'scrobble',?,?,'queued',0,0,?,?)`,
          `bench-scrobble-${loveCount}-${i}`,
          w.linkId,
          w.generation,
          ALICE,
          `bench-scrobble-${loveCount}-${i}`,
          JSON.stringify({
            listen: { artist: `Artist ${i}`, track: `Track ${i}`, listenedAt: '2026-01-14T00:00:00Z' },
            origin: 'listenbrainz',
          }),
          now,
          now,
        );
      for (let i = 0; i < loveCount; i++) {
        const artist = `Flat Artist ${i}`;
        const track = `Flat Track ${i}`;
        const [artistKey, trackKeyValue] = trackKey(artist, track);
        w.app.db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key)
           VALUES(?,?,?,?,'love',?,?,'queued',0,0,?,?,?,?)`,
          `flat-love-${loveCount}-${i}`,
          w.linkId,
          w.generation,
          ALICE,
          `flat-love-${loveCount}-${i}`,
          JSON.stringify({ artist, track }),
          now,
          now,
          artistKey,
          trackKeyValue,
        );
      }
    });
    const db = w.app.db;
    const originalAll = db.all.bind(db);
    const originalOne = db.one.bind(db);
    const originalRun = db.run.bind(db);
    let statements = 0;
    let returnedRows = 0;
    let framingRows = 0;
    let laneRows = 0;
    db.all = ((sql: string, ...params: SqlParam[]) => {
      statements++;
      const rows = originalAll(sql, ...params);
      returnedRows += rows.length;
      if (sql.includes(UNFRAMED_SQL) && params[3] !== 1) framingRows += rows.length;
      if (sql.includes(LANE_PICK_SQL)) laneRows += rows.length;
      return rows;
    }) as typeof db.all;
    db.one = ((sql: string, ...params: SqlParam[]) => {
      statements++;
      const row = originalOne(sql, ...params);
      if (row !== null) returnedRows++;
      return row;
    }) as typeof db.one;
    db.run = ((sql: string, ...params: SqlParam[]) => {
      statements++;
      return originalRun(sql, ...params);
    }) as typeof db.run;
    try {
      await runForward({ ...w.rt, db }, now);
      return { statements, returnedRows, framingRows, laneRows };
    } finally {
      db.all = originalAll;
      db.one = originalOne;
      db.run = originalRun;
    }
  };
  const small = await measure(200);
  const large = await measure(2_000);
  expect(large).toEqual(small);
  expect(large.framingRows).toBeLessThanOrEqual(64);
  expect(large.laneRows).toBeLessThanOrEqual(MAX_LOCAL_WORK_PER_RUN);
});

it('bounds love-head row work across a 2,000-row unresolved backlog while forwarding a resolved track', async () => {
  const w = await benchWorld();
  const now = w.clock.nowMs();
  w.app.db.tx(() => {
    for (let i = 0; i < 2_000; i++) {
      const ready = i === 1_999;
      const artist = ready ? 'Ready Artist' : `Unresolved Artist ${i}`;
      const track = ready ? 'Ready Song' : `Unresolved Track ${i}`;
      const [artistKey, trackKeyValue] = trackKey(artist, track);
      w.app.db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
         created_at_ms,updated_at_ms,love_artist_key,love_track_key)
         VALUES(?,?,?,?,'love',?,?,'queued',0,0,?,?,?,?)`,
        `love-backlog-${i}`,
        w.linkId,
        w.generation,
        ALICE,
        `love-backlog-${i}`,
        JSON.stringify({ artist, track, ...(ready ? { recordingMbid: MBID } : {}) }),
        now,
        now,
        artistKey,
        trackKeyValue,
      );
    }
  });
  const db = w.app.db;
  const originalAll = db.all.bind(db);
  const originalOne = db.one.bind(db);
  let laneRowsThisRun = 0;
  let maxHeadVisitsInRun = 0;
  let maxLaneRowsInRun = 0;
  const visitedIds: string[] = [];
  db.all = ((sql: string, ...params: SqlParam[]) => {
    const rows = originalAll(sql, ...params);
    if (sql.includes(LANE_PICK_SQL)) laneRowsThisRun += rows.length;
    return rows;
  }) as typeof db.all;
  db.one = ((sql: string, ...params: SqlParam[]) => {
    const row = originalOne(sql, ...params);
    if (sql === HEAD_SQL && row !== null) visitedIds.push((row as { id: string }).id);
    return row;
  }) as typeof db.one;
  let report: Awaited<ReturnType<typeof runForward>> | null = null;
  try {
    for (let run = 0; run < 130; run++) {
      const visitsBefore = visitedIds.length;
      report = await runForward({ ...w.rt, db }, w.clock.nowMs(), { maxRequests: 5 });
      maxLaneRowsInRun = Math.max(maxLaneRowsInRun, laneRowsThisRun);
      maxHeadVisitsInRun = Math.max(maxHeadVisitsInRun, visitedIds.length - visitsBefore);
      laneRowsThisRun = 0;
      w.clock.advance(1_000);
    }
  } finally {
    db.all = originalAll;
    db.one = originalOne;
  }
  expect(w.lb.feedback.map((feedback) => feedback.json)).toEqual([{ recording_mbid: MBID, score: 1 }]);
  expect(maxLaneRowsInRun).toBeLessThanOrEqual(MAX_LOCAL_WORK_PER_RUN);
  expect(maxHeadVisitsInRun).toBeLessThanOrEqual(MAX_LOCAL_WORK_PER_RUN);
  const firstRepeatAt = visitedIds.findIndex((id, index) => visitedIds.indexOf(id) !== index);
  expect(firstRepeatAt).toBe(2_000);
  expect(new Set(visitedIds.slice(0, firstRepeatAt)).size).toBe(2_000);
  expect(report?.nextDueMs).not.toBeNull();
});

it('bounds exercised unlove target and history reads across initialized unrelated 1k/10k backlogs', async () => {
  const measure = async (count: number, injectBacklogPrefetch = false) => {
    const w = await benchWorld();
    const db = w.app.db;
    const now = w.clock.nowMs();
    db.tx(() => {
      for (let i = 0; i < count; i++) {
        const artist = `Band ${i}`;
        const track = `Song ${i}`;
        db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
           created_at_ms,updated_at_ms,love_artist_key,love_track_key,love_lane)
           VALUES(?,?,?,?,'love',?,?,'queued',0,?,?,?,?,?,1)`,
          `prior-${i}`,
          w.linkId,
          w.generation,
          ALICE,
          `prior-${i}`,
          JSON.stringify({ artist, track, recordingMbid: MBID }),
          now + 3_600_000,
          now,
          now,
          artist.toLowerCase(),
          track.toLowerCase(),
        );
      }
      // Mirror completed production framing and retained-target initialization.
      db.run(`INSERT INTO forward_love_lanes(link_id,generation,love_artist_key,love_track_key,priority,due_at,head_created_at_ms)
        SELECT link_id,generation,love_artist_key,love_track_key,priority,due_at,created_at_ms FROM forward_outbox`);
      db.run(`INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid)
        SELECT rowid,link_id,generation,love_artist_key,love_track_key,created_at_ms,json_extract(payload_json,'$.recordingMbid') FROM forward_outbox`);
      db.run(
        "INSERT INTO mb_tracks(artist_key,track_key,album_key,status,created_at_ms) VALUES('not prior','not prior','','unmatched',?)",
        now,
      );
    });
    w.clock.advance(1);
    enqueueForwards(db, {
      did: ALICE,
      now: w.clock.nowMs(),
      random: seededRandom(93),
      items: [
        { kind: 'unlove', operationId: 'independent-unlove', payload: { artist: 'Not prior', track: 'Not prior' } },
      ],
    });
    db.run(`INSERT INTO forward_love_recording_targets_state(singleton,cursor_rowid,complete)
      SELECT 1,max(rowid),1 FROM forward_outbox`);
    db.run('INSERT INTO forward_love_operation_targets_state(singleton,cursor_rowid,complete) VALUES(1,0,1)');
    const population = {
      loves: db.one<{ n: number }>("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")!.n,
      targets: db.one<{ n: number }>('SELECT count(*) AS n FROM forward_love_recording_targets')!.n,
      lanes: db.one<{ n: number }>('SELECT count(*) AS n FROM forward_love_lanes')!.n,
    };
    const all = db.all.bind(db);
    const one = db.one.bind(db);
    const work = { targetCalls: 0, historyCalls: 0, candidateRows: 0, initializationRows: 0, laneRows: 0 };
    db.all = ((sql: string, ...args: SqlParam[]) => {
      const rows = all(sql, ...args);
      if (sql === LOVE_RECORDING_HISTORY_LOOKUP_SQL || sql === LOVE_RECORDING_HISTORY_PAGE_SQL) {
        work.historyCalls++;
        work.candidateRows += rows.length;
      }
      if (sql.includes('WHERE rowid>? ORDER BY rowid LIMIT 128')) work.initializationRows += rows.length;
      if (sql === LANE_PICK_SQL) work.laneRows += rows.length;
      return rows;
    }) as typeof db.all;
    db.one = ((sql: string, ...args: SqlParam[]) => {
      if (sql === FORWARD_LOVE_RECORDING_LOOKUP_SQL) {
        work.targetCalls++;
        // Negative control: reintroduce a backlog-wide payload prefetch at the
        // actual lookup boundary; identical behavior must fail the work bound.
        if (injectBacklogPrefetch)
          work.candidateRows += all(
            "SELECT payload_json FROM forward_outbox WHERE link_id=? AND generation=? AND kind='love'",
            w.linkId,
            w.generation,
          ).length;
      }
      const row = one(sql, ...args);
      if (sql === FORWARD_LOVE_RECORDING_LOOKUP_SQL && row !== null) work.candidateRows++;
      return row;
    }) as typeof db.one;
    try {
      await runForward(w.rt, w.clock.nowMs());
    } finally {
      db.all = all;
      db.one = one;
    }
    expect(db.one("SELECT state,last_error FROM forward_outbox WHERE kind='unlove'")).toEqual({
      state: 'ignored',
      last_error: 'no_recording_mbid',
    });
    expect(w.lb.feedback).toHaveLength(0);
    expect(population).toEqual({ loves: count, targets: count, lanes: count + 1 });
    expect(work.targetCalls).toBe(1);
    expect(work.historyCalls).toBe(1);
    expect(work.initializationRows).toBe(0);
    return work;
  };
  const oneK = await measure(1_000);
  const tenK = await measure(10_000);
  expect(tenK).toEqual(oneK);
  expect(tenK.candidateRows).toBeLessThanOrEqual(32);
  expect(tenK.laneRows).toBeGreaterThan(0);
  expect(tenK.laneRows).toBeLessThanOrEqual(MAX_LOCAL_WORK_PER_RUN);
  const negativeControl = await measure(1_000, true);
  expect(negativeControl.candidateRows).toBe(1_000);
  expect(negativeControl.candidateRows).toBeGreaterThan(32);
});

it('keeps retained love lookups indexed at 10k same-key history rows', async () => {
  const w = await benchWorld();
  w.app.db.tx(() => {
    for (let i = 1; i <= 10_000; i++)
      w.app.db.run(
        'INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid) VALUES(?,?,?,?,?,?,?)',
        i,
        w.linkId,
        w.generation,
        'band',
        'song',
        10_000 + i,
        `mbid-${i}`,
      );
    for (let i = 1; i <= 10_000; i++)
      w.app.db.run(
        'INSERT INTO forward_love_operation_targets(operation_rowid,did,artist_key,track_key,created_at_ms,recording_mbid) VALUES(?,?,?,?,?,?)',
        i,
        ALICE,
        'band',
        'song',
        10_000 + i,
        `mbid-${i}`,
      );
  });
  const forwardArgs = [w.linkId, w.generation, 'band', 'song', 10_000, 1] as const;
  const plan = (sql: string, ...args: SqlParam[]) =>
    w.app.db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...args)
      .map((row) => row.detail)
      .join(' ');
  const forwardPlan = plan(FORWARD_LOVE_RECORDING_LOOKUP_SQL, ...forwardArgs);
  expect(forwardPlan).toContain('forward_love_recording_targets_latest');
  expect(w.app.db.all(FORWARD_LOVE_RECORDING_LOOKUP_SQL, ...forwardArgs)).toEqual([]);
  expect(plan(LOVE_RECORDING_HISTORY_LOOKUP_SQL, ALICE, 'band', 'song')).toContain(
    'forward_love_operation_targets_latest',
  );
  expect(plan(LOVE_RECORDING_HISTORY_PAGE_SQL, ALICE, 'band', 'song', 10_000, 1)).toContain(
    'forward_love_operation_targets_latest',
  );
});

it('returns a deferred same-key head deadline with the same scheduler probes at 100 and 10,000 rows', async () => {
  const measure = async (count: number) => {
    const w = await benchWorld();
    const now = w.clock.nowMs();
    const [artistKey, trackKeyValue] = trackKey('Blocked Artist', 'Blocked Track');
    w.app.db.tx(() => {
      for (let i = 0; i < count; i++) {
        w.app.db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,love_lane)
           VALUES(?,?,?,?,'love',?,?,'queued',0,?,?,?,?,?,1)`,
          `blocked-${count}-${i}`,
          w.linkId,
          w.generation,
          ALICE,
          `blocked-${count}-${i}`,
          JSON.stringify({ artist: 'Blocked Artist', track: 'Blocked Track' }),
          i === 0 ? now + 60_000 : now,
          now,
          now,
          artistKey,
          trackKeyValue,
        );
      }
      w.app.db.run(
        `INSERT INTO forward_love_lanes(link_id,generation,love_artist_key,love_track_key,priority,due_at,head_created_at_ms)
         VALUES(?,?,?,?,0,?,?)`,
        w.linkId,
        w.generation,
        artistKey,
        trackKeyValue,
        now + 60_000,
        now,
      );
    });
    const all = w.app.db.all.bind(w.app.db);
    const one = w.app.db.one.bind(w.app.db);
    let statements = 0;
    let returnedRows = 0;
    w.app.db.all = ((sql: string, ...params: SqlParam[]) => {
      statements++;
      const rows = all(sql, ...params);
      returnedRows += rows.length;
      return rows;
    }) as typeof w.app.db.all;
    w.app.db.one = ((sql: string, ...params: SqlParam[]) => {
      statements++;
      const row = one(sql, ...params);
      if (row !== null) returnedRows++;
      return row;
    }) as typeof w.app.db.one;
    try {
      return { due: nextForwardDue({ ...w.rt, db: w.app.db }, now), statements, returnedRows, expected: now + 60_000 };
    } finally {
      w.app.db.all = all;
      w.app.db.one = one;
    }
  };
  const hundred = await measure(100);
  const tenThousand = await measure(10_000);
  expect(hundred.due).toBe(hundred.expected);
  expect(tenThousand.due).toBe(tenThousand.expected);
  expect(tenThousand.statements).toBe(hundred.statements);
  expect(tenThousand.returnedRows).toBe(hundred.returnedRows);
});

it('caps expiry transitions and blocks forwarding until a 10k mixed expired backlog drains', async () => {
  const w = await benchWorld();
  const now = w.clock.nowMs();
  const expiredAt = now - LISTENBRAINZ_EXPIRY_MS - 1;
  w.app.db.tx(() => {
    for (let i = 0; i < 10_000; i++) {
      const artist = `Old Artist ${i}`;
      const track = `Old Track ${i}`;
      const [artistKey, trackKeyValue] = trackKey(artist, track);
      w.app.db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key)
         VALUES(?,?,?,?,'love',?,?,'queued',0,0,?,?,?,?)`,
        `expired-love-${i}`,
        w.linkId,
        w.generation,
        ALICE,
        `expired-love-${i}`,
        JSON.stringify({ artist, track, recordingMbid: MBID }),
        expiredAt,
        expiredAt,
        artistKey,
        trackKeyValue,
      );
    }
    for (let i = 0; i < 100; i++) {
      w.app.db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,'love',?,?,'held',0,0,?,?)`,
        `held-expiry-${i}`,
        w.linkId,
        w.generation,
        ALICE,
        `held-expiry-${i}`,
        '{}',
        expiredAt,
        expiredAt,
      );
      const stale = now - 61_000;
      w.app.db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,'nowplaying',?,?,'queued',0,0,?,?)`,
        `stale-np-${i}`,
        w.linkId,
        w.generation,
        ALICE,
        `stale-np-${i}`,
        '{}',
        stale,
        stale,
      );
    }
  });
  const all = w.app.db.all.bind(w.app.db);
  let maxExpiredRows = 0;
  w.app.db.all = ((sql: string, ...params: SqlParam[]) => {
    const rows = all(sql, ...params);
    if (sql.includes('forward_outbox_link_expiry') || sql.includes('forward_outbox_held_expiry'))
      maxExpiredRows = Math.max(maxExpiredRows, rows.length);
    return rows;
  }) as typeof w.app.db.all;
  try {
    let report = await runForward(w.rt, now);
    expect(report.expired).toMatchObject({ pending: true });
    expect(report.requests).toBe(0);
    expect(w.lb.feedback).toHaveLength(0);
    expect(report.expired!.aged + report.expired!.staleNowPlaying + report.expired!.held).toBe(
      MAX_EXPIRY_TRANSITIONS_PER_RUN,
    );
    for (let i = 0; i < 100 && report.expired?.pending; i++) {
      report = await runForward(w.rt, w.clock.nowMs());
      expect(report.requests).toBe(0);
      expect(w.lb.feedback).toHaveLength(0);
      expect(report.expired!.aged + report.expired!.staleNowPlaying + report.expired!.held).toBeLessThanOrEqual(
        MAX_EXPIRY_TRANSITIONS_PER_RUN,
      );
      w.clock.advance(1_000);
    }
    expect(report.expired?.pending).toBe(false);
    expect(w.app.db.one<{ n: number }>("SELECT count(*) n FROM forward_outbox WHERE state='queued'")!.n).toBe(0);
    expect(w.app.db.one<{ n: number }>("SELECT count(*) n FROM forward_outbox WHERE state='held'")!.n).toBe(0);
    expect(maxExpiredRows).toBeLessThanOrEqual(MAX_EXPIRY_TRANSITIONS_PER_RUN);
  } finally {
    w.app.db.all = all;
  }
});

it('gives two links separate 32-row budgets while reaching both 2,000-key tails', async () => {
  const w = await benchWorld();
  const firstLink = w.linkId;
  const bobToken = '6d8e4f2b-1a9c-4f2d-8b7e-3c5d1f9a2b6c';
  w.lb.addToken('bob_lb', bobToken);
  ensureAccount({ db: w.app.db, clock: w.clock }, { did: BOB, verifiedHandle: null });
  const secondLink = saveLink(
    { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
    { did: BOB, service: 'listenbrainz', remoteUser: 'bob_lb', credential: bobToken },
  ).link.id;
  const linkIds = [firstLink, secondLink];
  w.app.db.tx(() => {
    for (const [linkIndex, linkId] of linkIds.entries()) {
      const generation = w.app.db.one<{ generation: number }>(
        'SELECT generation FROM linked_accounts WHERE id=?',
        linkId,
      )!.generation;
      for (let i = 0; i < 2_000; i++) {
        const ready = i === 1_999;
        const artist = ready ? `Ready Artist ${linkIndex}` : `Busy Artist ${linkIndex}-${i}`;
        const track = ready ? `Ready Song ${linkIndex}` : `Busy Track ${linkIndex}-${i}`;
        const [artistKey, trackKeyValue] = trackKey(artist, track);
        w.app.db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key)
           VALUES(?,?,?,?,'love',?,?,'queued',0,?,?,?, ?,?)`,
          `link-${linkIndex}-love-${i}`,
          linkId,
          generation,
          linkIndex === 0 ? ALICE : BOB,
          `link-${linkIndex}-love-${i}`,
          JSON.stringify({ artist, track, ...(ready ? { recordingMbid: MBID } : {}) }),
          w.clock.nowMs(),
          w.clock.nowMs(),
          w.clock.nowMs(),
          artistKey,
          trackKeyValue,
        );
      }
    }
  });
  const all = w.app.db.all.bind(w.app.db);
  const maxFetched = new Map(linkIds.map((id) => [id, 0]));
  const fetchedThisRun = new Map<string, number>();
  w.app.db.all = ((sql: string, ...params: SqlParam[]) => {
    const rows = all(sql, ...params);
    if (sql === LANE_PICK_SQL) {
      const id = String(params[0]);
      fetchedThisRun.set(id, (fetchedThisRun.get(id) ?? 0) + rows.length);
    }
    return rows;
  }) as typeof w.app.db.all;
  try {
    for (let run = 0; run < 70 && w.lb.feedback.length < 2; run++) {
      fetchedThisRun.clear();
      await runForward(w.rt, w.clock.nowMs());
      for (const id of linkIds) {
        const fetched = fetchedThisRun.get(id) ?? 0;
        expect(fetched).toBeLessThanOrEqual(MAX_LOCAL_WORK_PER_RUN);
        maxFetched.set(id, Math.max(maxFetched.get(id) ?? 0, fetched));
      }
      w.clock.advance(1_000);
    }
  } finally {
    w.app.db.all = all;
  }
  expect(linkIds.map((id) => maxFetched.get(id))).toEqual([MAX_LOCAL_WORK_PER_RUN, MAX_LOCAL_WORK_PER_RUN]);
  expect(w.lb.feedback).toHaveLength(2);
  expect(w.lb.feedback.map((feedback) => feedback.json)).toEqual([
    { recording_mbid: MBID, score: 1 },
    { recording_mbid: MBID, score: 1 },
  ]);
});
