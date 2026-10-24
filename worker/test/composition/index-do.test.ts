// W5-01 worker/src/do/index-do.ts: the real IndexDO (TestIndexDO overrides
// only buildDeps) over real DO SQLite, real alarms (runDurableObjectAlarm)
// and DO eviction for restarts (ADR 0004 §5.9, §10.2, A18). Proves
// M1.4.3/drain_success (durability across restart replaces the SIGTERM drain)
// and the W2-05 status truth through the production writers.

import { evictDurableObject } from 'cloudflare:test';
import { SUBSCRIBE_NSID } from '@atmusic/atproto/test-support/fake-jetstream';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminStatus } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { GC_HINTS_PER_RUN } from '../../src/do/index-do';
import { MAX_PENDING_SNAPSHOT_JOBS } from '../../src/do/ingest/admission';
import { requestGapDiscovery } from '../../src/do/ingest/discovery';
import { GAP_SCAN_DONE } from '../../src/do/ingest/snapshot-job';
import { markConnected, updateCheckpointBookkeeping } from '../../src/do/status';
import { nextDue, TIMER_NAMES } from '../../src/do/timers';
import { flush, jetstreamServer } from '../fixtures/jetstream-server';
import { seedUser } from '../write/support';
import {
  ADMIN_TOKEN,
  ALICE,
  activeUsers,
  alarmsUntil,
  armed,
  BOB,
  constructed,
  control,
  harness,
  inDo,
  ingestFixture,
  kitControl,
  postJson,
  resetControl,
  runAlarm,
  SCROBBLE,
  schema,
  uriOf,
} from './support';

const T0 = Date.parse('2026-01-15T12:00:00Z');

function scrobble(listenedAt: string, track = 'Hyperballad') {
  return {
    $type: SCROBBLE,
    artist: 'Björk',
    track,
    album: 'Post',
    listenedAt,
    createdAt: listenedAt,
  };
}

function checkpoint(db: Db) {
  return db.one<{ connected: number; updated_at_ms: number }>(
    "SELECT connected, updated_at_ms FROM ingest_checkpoint WHERE stream = 'jetstream'",
  );
}

const DAY = 24 * 3_600_000;

/** Make only the timers in `names` due now; every other timer waits a day. */
function onlyDueNow(h: { stub: Parameters<typeof inDo>[0] }, names: readonly string[]) {
  return inDo(h.stub, (_i, db) =>
    db.tx(() => {
      const now = control.clock.nowMs();
      for (const name of TIMER_NAMES) {
        const at = names.includes(name) ? now : now + DAY;
        db.run(
          'INSERT INTO timers(name, due_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET due_at = ?',
          name,
          at,
          at,
        );
      }
    }),
  );
}

const rkeys = (body: unknown) =>
  (body as { items: Array<{ uri: string }> }).items.map((s) => s.uri.slice(s.uri.lastIndexOf('/') + 1));

describe('worker/src/do/index-do.ts', () => {
  beforeEach(() => {
    resetControl();
  });

  it('constructor migrates, marks disconnected, arms alarm; alarm runs drain before snapshot', async () => {
    const kit = await kitControl();
    const h = harness('ctor');

    // First instance: migrations applied before anything else runs.
    const first = await inDo(h.stub, async (instance, db) => ({
      ready: await instance.ready(),
      ledger: db.all('SELECT version, name FROM schema_migrations ORDER BY version'),
      timers: db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name),
    }));
    expect(constructed(h.stub)).toBe(1);
    expect(first).toEqual({
      ready: { status: 'ready', version: 1 },
      ledger: [{ version: 1, name: 'initial_workers_schema' }],
      // INGEST_MODE=off: the watchdog runs once to close any socket and record the mode.
      timers: ['discovery', 'gc', 'identity-sweep', 'jetstream-watchdog', 'status-sweep'],
    });
    expect(armed(h.stub)).toEqual([T0]);

    // That instance held a live socket when it died.
    await inDo(h.stub, (_i, db) => db.tx(() => markConnected(db, T0)));
    expect(await inDo(h.stub, (_i, db) => checkpoint(db))).toEqual({ connected: 1, updated_at_ms: T0 });
    control.clock.advance(30_000);
    await evictDurableObject(h.stub);

    // The new instance records the drop at its start (the 1→0 instant) and re-arms.
    const restarted = await inDo(h.stub, async (_i, db, state) => ({
      checkpoint: checkpoint(db),
      next: nextDue(db),
      realAlarm: await state.storage.getAlarm(),
      ledger: db.all('SELECT version FROM schema_migrations'),
    }));
    expect(constructed(h.stub)).toBe(2);
    expect(restarted.checkpoint).toEqual({ connected: 0, updated_at_ms: T0 + 30_000 });
    expect(restarted.ledger).toEqual([{ version: 1 }]);
    expect(restarted.realAlarm).not.toBeNull();
    expect(restarted.next).toBe(T0);
    expect(armed(h.stub).at(-1)).toBe(T0);

    // A due hint (drain) and a due snapshot job (snapshot) in the same alarm.
    const alice = await kit.createRecord('Alice', SCROBBLE, 'a1', scrobble('2026-01-15T11:58:00Z'));
    await kit.createRecord('Bob', SCROBBLE, 'b1', scrobble('2026-01-15T11:57:00Z', 'Isobel'));
    await inDo(h.stub, (_i, db) => db.tx(() => seedUser(db, ALICE)));
    expect((await postJson(h, '/api/v1/notify', { uri: uriOf(ALICE, 'a1') }, { ip: '198.51.100.3' })).status).toBe(202);
    expect((await postJson(h, '/api/v1/notify', { did: BOB }, { ip: '198.51.100.3' })).status).toBe(202);
    const queued = await inDo(h.stub, (_i, db) => ({
      hints: db.all('SELECT uri, source FROM hints'),
      jobs: db.all("SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot'"),
      drain: db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'drain'")?.due_at,
      snapshot: db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'snapshot'")?.due_at,
    }));
    expect(queued).toEqual({
      hints: [{ uri: uriOf(ALICE, 'a1'), source: 'notify' }],
      jobs: [{ did: BOB, state: 'pending', reason: 'admission' }],
      // The hint queue makes the drain durable with the hint, due at once; the admission's
      // job pulls the snapshot timer to the 1 s slice minimum.
      drain: T0 + 30_000,
      snapshot: T0 + 30_000 + 1_000,
    });

    kit.resetCalls();
    control.clock.advance(5_000);
    expect(await runAlarm(h.stub)).toBe(true);
    const after = await inDo(h.stub, (instance, db) => ({
      ran: instance.lastAlarm?.ran ?? [],
      failed: instance.lastAlarm?.failed ?? [],
      scrobbles: db.all('SELECT uri, cid FROM scrobbles ORDER BY uri'),
      hints: db.all('SELECT uri FROM hints'),
      active: activeUsers(db),
    }));
    expect(after.failed).toEqual([]);
    expect(after.ran.slice(0, 2)).toEqual(['drain', 'snapshot']);
    // Observable order on the fixture network: Alice's proof fetch precedes every Bob request.
    const calls = kit.transport.calls.entries;
    const proof = calls.findIndex((c) => c.nsid === 'com.atproto.sync.getRecord' && c.did === ALICE);
    const firstBob = calls.findIndex((c) => c.did === BOB);
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(firstBob).toBeGreaterThan(proof);
    expect(after.hints).toEqual([]);
    expect(after.scrobbles).toContainEqual({ uri: uriOf(ALICE, 'a1'), cid: alice.cid });
    expect(after.active).toContain(ALICE);
  });

  it('restart (eviction) preserves state and resumes alarm', async () => {
    const kit = await kitControl();
    const h = harness('restart');
    await ingestFixture(h, kit);

    const tables = () =>
      inDo(h.stub, (_i, db) => ({
        users: db.all('SELECT * FROM users ORDER BY did'),
        scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
        follows: db.all('SELECT * FROM follows ORDER BY uri'),
        record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
        suppression: db.all('SELECT * FROM suppression ORDER BY did'),
        repo_jobs: db.all('SELECT * FROM repo_jobs ORDER BY did, kind'),
        hints: db.all('SELECT * FROM hints ORDER BY uri'),
        indexing_status: db.all('SELECT * FROM indexing_status ORDER BY scope'),
        backfill_generation: db.all('SELECT * FROM backfill_generation ORDER BY singleton'),
        stats_cache: db.all('SELECT * FROM stats_cache ORDER BY did, win, lim'),
        timers: db.all('SELECT * FROM timers ORDER BY name'),
      }));

    const page1 = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    expect(rkeys(page1.body)).toEqual(['r07', 'r01']);
    const cursor = (page1.body as { nextCursor: string }).nextCursor;
    const all = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=100`);
    // Statistics computed before the restart fill stats_cache.
    const statsBefore = await h.request(`/api/v1/users/${ALICE}/stats`);
    expect(statsBefore.status).toBe(200);

    // Work that is due when the instance dies: a new record announced through notify.
    const r11 = await kit.createRecord('Alice', SCROBBLE, 'r11', scrobble('2026-01-15T11:59:00Z'));
    expect((await postJson(h, '/api/v1/notify', { uri: uriOf(ALICE, 'r11') }, { ip: '198.51.100.4' })).status).toBe(
      202,
    );
    const before = await tables();
    expect(before.stats_cache.length).toBeGreaterThan(0);
    expect(before.indexing_status.length).toBeGreaterThan(0);
    expect(before.backfill_generation).toHaveLength(1);
    expect(before.timers.length).toBeGreaterThan(0);
    const dueBefore = await inDo(h.stub, (_i, db) => nextDue(db));
    const constructions = constructed(h.stub);

    await evictDurableObject(h.stub);
    const after = await tables();
    expect(constructed(h.stub)).toBe(constructions + 1);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // Responses are byte-identical and a cursor issued before the restart continues.
    const allAfter = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=100`);
    expect(allAfter.text).toBe(all.text);
    const statsAfter = await h.request(`/api/v1/users/${ALICE}/stats`);
    expect(statsAfter.status).toBe(200);
    expect(statsAfter.text).toBe(statsBefore.text);
    const page2 = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(page2.status).toBe(200);
    expect(rkeys(page2.body)).toEqual(['r02', 'r03']);

    // The alarm resumed: armed at the same min(due_at), and it runs the pending drain.
    const resumed = await inDo(h.stub, async (_i, db, state) => ({
      next: nextDue(db),
      realAlarm: await state.storage.getAlarm(),
    }));
    expect(resumed.next).toBe(dueBefore);
    expect(resumed.realAlarm).not.toBeNull();
    expect(armed(h.stub).at(-1)).toBe(dueBefore);
    control.clock.advance(5_000);
    expect(await runAlarm(h.stub)).toBe(true);
    const applied = await inDo(h.stub, (instance, db) => ({
      ran: instance.lastAlarm?.ran ?? [],
      row: db.one('SELECT uri, cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11')),
      hints: db.all('SELECT uri FROM hints'),
    }));
    expect(applied.ran[0]).toBe('drain');
    expect(applied.row).toEqual({ uri: uriOf(ALICE, 'r11'), cid: r11.cid });
    expect(applied.hints).toEqual([]);

    // The pre-restart cursor still pages below its anchor: r11 arrived above it and never appears.
    const page3 = await h.request(
      `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${encodeURIComponent((page2.body as { nextCursor: string }).nextCursor)}`,
    );
    expect(rkeys(page3.body)).toEqual(['r04', 'r05']);
  });

  it('status truth through production writers: a fake Jetstream commit applied by the alarm raises admin status lastIndexedAt and sets lagSeconds, and after a socket drop and two constructor restarts the state turns stale exactly 5 min after the drop', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'socket', ADMIN_TOKEN } });
    const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
    control.connectJetstream = js.connect;
    const h = harness('status-truth', { ADMIN_TOKEN });
    const status = async () => {
      const r = await h.request('/internal/admin/status', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(r.status).toBe(200);
      return r.body as AdminStatus;
    };

    // Start-up: the watchdog is due now; the first alarm connects at the live tail (no cursor: a gap).
    let s = await status();
    expect(s.ingest).toMatchObject({ mode: 'socket', connected: false, cursor: null });
    expect(s.indexing).toEqual({ state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null });
    expect(await runAlarm(h.stub)).toBe(true);
    await flush();
    expect(js.attempts.map((a) => [a.host, a.cursor, a.status])).toEqual([['jetstream.example.test', null, 101]]);
    s = await status();
    expect(s.ingest.connected).toBe(true);
    expect(s.indexing).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: null });

    // Alice's first commit reaches the socket: a hint, then admission and a snapshot, all by alarms.
    await inDo(h.stub, () => kit.createRecord('Alice', SCROBBLE, 'a1', scrobble('2026-01-15T11:58:00Z')));
    await flush();
    expect(await inDo(h.stub, (_i, db) => db.all('SELECT uri, source FROM hints'))).toEqual([
      { uri: uriOf(ALICE, 'a1'), source: 'jetstream' },
    ]);
    await alarmsUntil(h, () => inDo(h.stub, (_i, db) => activeUsers(db).includes(ALICE)), { stepMs: 2_000 });

    // A second commit, applied by the drain from its getRecord proof.
    control.clock.set('2026-01-15T12:10:00Z');
    const second = await inDo(h.stub, () =>
      kit.createRecord('Alice', SCROBBLE, 'a2', scrobble('2026-01-15T12:09:00Z', 'Isobel')),
    );
    await flush();
    control.clock.set('2026-01-15T12:10:07Z');
    expect(await runAlarm(h.stub)).toBe(true);
    await flush();
    const applied = await inDo(h.stub, (_i, db) =>
      db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'a2')),
    );
    expect(applied).toEqual({ cid: second.cid });
    s = await status();
    expect(s.indexing.lastIndexedAt).toBe('2026-01-15T12:10:07.000000000Z');
    expect(s.indexing.lagSeconds).toBe(7);
    expect(s.indexing.state).toBe('current');
    expect(s.ingest.lastEventTimeUs).toBe(Date.parse('2026-01-15T12:10:00Z') * 1000);

    // The socket drops at T_DROP; reconnects are refused from then on.
    control.clock.set('2026-01-15T12:11:00Z');
    const T_DROP = control.clock.nowMs();
    kit.jetstream.faults.add({ nsid: SUBSCRIBE_NSID }, { kind: 'status', status: 503, error: 'Unavailable' }, 1000);
    await inDo(h.stub, () => js.last().close(1001, 'server going away'));
    await flush();
    expect(await inDo(h.stub, (_i, db) => checkpoint(db))).toEqual({ connected: 0, updated_at_ms: T_DROP });

    // Two constructor restarts (with failed reconnects between): the disconnect instant never moves.
    const attemptsBefore = js.attempts.length;
    for (let n = 0; n < 2; n++) {
      control.clock.advance(60_000);
      expect(await runAlarm(h.stub)).toBe(true);
      await flush();
      await evictDurableObject(h.stub);
      expect(await inDo(h.stub, (_i, db) => checkpoint(db))).toEqual({ connected: 0, updated_at_ms: T_DROP });
    }
    expect(js.attempts.length).toBeGreaterThan(attemptsBefore);
    expect(js.attempts.slice(attemptsBefore).every((a) => a.status === 503)).toBe(true);
    expect(constructed(h.stub)).toBe(3);

    // Exactly 5 min after the drop: not yet stale; one millisecond later: stale.
    control.clock.set('2026-01-15T12:16:00Z');
    s = await status();
    expect(s.indexing.state).toBe('current');
    expect(s.indexing.caughtUp).toBe(false);
    control.clock.advance(1);
    s = await status();
    expect(s.indexing.state).toBe('stale');
    expect(s.indexing.lastIndexedAt).toBe('2026-01-15T12:10:07.000000000Z');
    expect(T_DROP + 300_000 + 1).toBe(control.clock.nowMs());
  });

  it('hints arriving after a drain wait for the 2 s drain floor, which a stream of hints never postpones', async () => {
    const h = harness('drain-floor');
    const hintAt = (rkey: string) =>
      postJson(h, '/api/v1/notify', { uri: uriOf(BOB, rkey) }, { ip: '198.51.100.6' }).then((r) => r.status);
    const drainDue = () =>
      inDo(h.stub, (_i, db) => db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'drain'")?.due_at);

    // Before any drain of this instance, a hint is due at once.
    expect(await hintAt('h1')).toBe(202);
    expect(await drainDue()).toBe(T0);
    expect(await runAlarm(h.stub)).toBe(true);
    expect(await inDo(h.stub, (instance) => instance.lastAlarm?.ran[0])).toBe('drain');
    // The drain admitted Bob (unknown DID) and consumed the hint.
    expect(await inDo(h.stub, (_i, db) => db.all('SELECT uri FROM hints'))).toEqual([]);

    // Hints every 500 ms after it: the drain stays at T0 + 2 s, it is not pushed back.
    for (const [n, rkey] of ['h2', 'h3', 'h4'].entries()) {
      control.clock.advance(500);
      expect(await hintAt(rkey)).toBe(202);
      expect([n, await drainDue()]).toEqual([n, T0 + 2_000]);
    }
    control.clock.advance(500);
    expect(await runAlarm(h.stub)).toBe(true);
    const batch = await inDo(h.stub, (instance, db) => ({
      ran: instance.lastAlarm?.ran[0],
      hints: db.all('SELECT rkey, attempts FROM hints ORDER BY rkey'),
    }));
    // One drain worked the whole burst (each hint once; Bob's identity is not reachable
    // here, so each backs off instead of applying).
    expect(batch).toEqual({
      ran: 'drain',
      hints: [
        { rkey: 'h2', attempts: 1 },
        { rkey: 'h3', attempts: 1 },
        { rkey: 'h4', attempts: 1 },
      ],
    });
  });

  it('gap hold and clear commit in one transaction', async () => {
    await kitControl({ env: { ADMIN_TOKEN } });
    const h = harness('gap-hold', { ADMIN_TOKEN });
    const adminIngest = async () => {
      const r = await h.request('/internal/admin/status', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(r.status).toBe(200);
      const body = r.body as AdminStatus;
      expect(schema('Indexing', body.indexing)).toBe('valid');
      return body;
    };
    const gapRow = () =>
      inDo(h.stub, (_i, db) =>
        db.one<{ pending_gap: number; gap_scan_after_did: string | null }>(
          "SELECT pending_gap, gap_scan_after_did FROM ingest_checkpoint WHERE stream = 'jetstream'",
        ),
      );
    const onlyDue = (names: string[]) => onlyDueNow(h, names);

    // Gap recovery is under way: its snapshot scan is finished and no gap job is open,
    // but its relay discovery pass has not run yet.
    await inDo(h.stub, (_i, db) => {
      updateCheckpointBookkeeping(db, { pendingGap: true, gapScanAfterDid: GAP_SCAN_DONE });
      requestGapDiscovery(db, control.clock.nowMs());
    });
    expect((await adminIngest()).ingest.pendingGap).toBe(true);

    // The snapshot slice sees "scan done, nothing open" and would clear pending_gap; the
    // instance dies at its next storage read, which is where the discovery pass is consulted.
    await onlyDue(['snapshot']);
    control.dbFault = { match: /FROM counters WHERE name = \? LIMIT 1/, message: 'instance lost', remaining: 1 };
    expect(await runAlarm(h.stub)).toBe(true);
    const crashed = await inDo(h.stub, (instance) => instance.lastAlarm);
    expect(control.dbFault.remaining).toBe(0);
    expect(crashed?.failed.map((f) => f.name)).toEqual(['snapshot']);
    // Nothing committed in between: the gap is still pending, as it must be while discovery runs.
    expect(await gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });

    // A restart (eviction) keeps it, and the status still reports the gap.
    control.dbFault = null;
    await evictDurableObject(h.stub);
    expect(await gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });
    // (INGEST_MODE=off here, so the global state is `stale` regardless; the gap flag is the evidence.)
    let s = await adminIngest();
    expect(s.ingest.pendingGap).toBe(true);
    expect(s.indexing.caughtUp).toBe(false);

    // A healthy snapshot slice holds the gap too (the discovery pass is still pending) ...
    control.clock.advance(1_000);
    await onlyDue(['snapshot']);
    expect(await runAlarm(h.stub)).toBe(true);
    expect(await inDo(h.stub, (instance) => instance.lastAlarm?.ran)).toContain('snapshot');
    expect(await gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });

    // ... and the discovery pass's end clears it, in the discovery handler's own transaction.
    control.clock.advance(1_000);
    await onlyDue(['discovery']);
    expect(await runAlarm(h.stub)).toBe(true);
    const ran = await inDo(h.stub, (instance) => instance.lastAlarm);
    expect(ran?.ran).toContain('discovery');
    expect(ran?.failed).toEqual([]);
    expect(await gapRow()).toEqual({ pending_gap: 0, gap_scan_after_did: null });
    s = await adminIngest();
    expect(s.ingest.pendingGap).toBe(false);
  });

  it('gc is not blocked by retained hints', async () => {
    resetControl();
    const h = harness('gc-retained');
    const now = control.clock.nowMs();
    const old = (minutes: number) => toStorage(fromMs(now - 8 * DAY - minutes * 60_000));
    const unknown = (n: number) => `did:plc:u${String(n).padStart(23, '0')}`;
    const SUPPRESSED = 'did:plc:ssssssssssssssssssssssss';
    const NO_JOB = 'did:plc:nnnnnnnnnnnnnnnnnnnnnnnn';
    const OPEN_JOB = 'did:plc:oooooooooooooooooooooooo';
    const LATER = 'did:plc:llllllllllllllllllllllll';
    const hintsOf = (db: Db) =>
      db.all<{ did: string; n: number }>('SELECT did, count(*) AS n FROM hints GROUP BY did ORDER BY did');

    await inDo(h.stub, (_i, db) =>
      db.tx(() => {
        let minutes = 10_000;
        const failing = (did: string, rkey: string) =>
          db.run(
            `INSERT INTO hints(uri, did, collection, rkey, source, priority, receipt_time, due_at, attempts, last_error)
             VALUES (?, ?, ?, ?, 'jetstream', 1, ?, ?, 20, 'fetch:http_503')`,
            `at://${did}/${SCROBBLE}/${rkey}`,
            did,
            SCROBBLE,
            rkey,
            old(minutes--),
            now + 30 * DAY,
          );
        // The oldest: GC_HINTS_PER_RUN expired hints of DIDs that are not known ...
        for (let n = 0; n < GC_HINTS_PER_RUN; n++) failing(unknown(n), 'h1');
        // ... then hints of a suppressed DID and of a known DID whose snapshot the full queue refuses ...
        seedUser(db, SUPPRESSED);
        db.run("INSERT INTO suppression(did, suppressed_at) VALUES (?, '2026-01-14T12:00:00.000000000Z')", SUPPRESSED);
        for (const rkey of ['h1', 'h2']) failing(SUPPRESSED, rkey);
        seedUser(db, NO_JOB);
        for (const rkey of ['h1', 'h2', 'h3']) failing(NO_JOB, rkey);
        // ... then, newest, a known DID with an open snapshot job and another one without.
        const gen = seedUser(db, OPEN_JOB);
        for (const rkey of ['h1', 'h2']) failing(OPEN_JOB, rkey);
        seedUser(db, LATER);
        failing(LATER, 'h1');
        // The snapshot queue is full (the open job among them), so no new job can be created.
        db.run(
          `INSERT INTO repo_jobs(did, kind, state, generation, reason, due_at, updated_at_ms)
           VALUES (?, 'snapshot', 'pending', ?, 'admission', ?, ?)`,
          OPEN_JOB,
          gen,
          now + 30 * DAY,
          now,
        );
        for (let n = 1; n < MAX_PENDING_SNAPSHOT_JOBS; n++) {
          db.run(
            `INSERT INTO repo_jobs(did, kind, state, generation, reason, due_at, updated_at_ms)
             VALUES (?, 'snapshot', 'pending', 0, 'filler', ?, ?)`,
            `did:plc:q${String(n).padStart(23, '0')}`,
            now + 30 * DAY,
            now,
          );
        }
      }),
    );
    await onlyDueNow(h, ['gc']);

    // The daily gc run, through the alarm (the only timer due).
    expect(await runAlarm(h.stub)).toBe(true);
    const first = await inDo(h.stub, (instance, db) => ({
      ran: instance.lastAlarm?.ran,
      failed: instance.lastAlarm?.failed,
      hints: hintsOf(db),
      job: db.one("SELECT state, reason FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", OPEN_JOB),
      expired: db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'hint_expired'")?.value ?? 0,
      gcDue: db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'gc'")?.due_at,
    }));
    expect(first.ran).toEqual(['gc']);
    expect(first.failed).toEqual([]);
    // The open job's DID got past the 200 + 5 hints that cannot be handed over: its hints are gone.
    expect(first.expired).toBe(2);
    expect(first.job).toEqual({ state: 'pending', reason: 'admission' });
    expect(first.hints.find((r) => r.did === OPEN_JOB)).toBeUndefined();
    // The others are kept: unknown, suppressed, and refused by the full queue.
    expect(first.hints.filter((r) => r.did.startsWith('did:plc:u'))).toHaveLength(GC_HINTS_PER_RUN);
    expect(first.hints.filter((r) => !r.did.startsWith('did:plc:u'))).toEqual([
      { did: LATER, n: 1 },
      { did: NO_JOB, n: 3 },
      { did: SUPPRESSED, n: 2 },
    ]);
    expect(first.gcDue).toBe(now + DAY);

    // Once the queue has room, the next run hands the refused DIDs' hints over as well.
    await inDo(h.stub, (_i, db) => db.run("DELETE FROM repo_jobs WHERE reason = 'filler'"));
    control.clock.advance(DAY);
    await onlyDueNow(h, ['gc']);
    expect(await runAlarm(h.stub)).toBe(true);
    const second = await inDo(h.stub, (instance, db) => ({
      ran: instance.lastAlarm?.ran,
      hints: hintsOf(db),
      jobs: db.all(
        "SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot' AND did IN (?, ?) ORDER BY did",
        LATER,
        NO_JOB,
      ),
      expired: db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'hint_expired'")?.value ?? 0,
    }));
    expect(second.ran).toEqual(['gc']);
    expect(second.expired).toBe(2 + 4);
    expect(second.jobs).toEqual([
      { did: LATER, state: 'pending', reason: 'hint_expired' },
      { did: NO_JOB, state: 'pending', reason: 'hint_expired' },
    ]);
    expect(second.hints.filter((r) => !r.did.startsWith('did:plc:u'))).toEqual([{ did: SUPPRESSED, n: 2 }]);
    expect(second.hints.filter((r) => r.did.startsWith('did:plc:u'))).toHaveLength(GC_HINTS_PER_RUN);
  });
});
