// IndexCore on the Node host (ADR 0005 §2.2, §3.2–§3.4, §3.10; N4-03). The
// W5-01 IndexDO suite (index-do.test.ts on workerd) ported to the production
// Node composition (support.ts): node:sqlite instead of DO SQLite, the
// NodeAlarm of the core lane instead of runDurableObjectAlarm, and restart as
// close-and-reopen of the same database file plus a recomposed app instead of
// DO eviction (ADR §15.1). Proves M1.4.3/drain_success (durability across a
// restart) and the W2-05 status truth through the production writers.
//
// The first test is new: IndexCore's socket mode through the production `ws`
// connector (node/jetstream-ws.ts) to a loopback `ws` server on 127.0.0.1:0
// that serves the fake Jetstream (ADR §15.2 loopback exception), and the
// NodeAlarm's retry when the alarm callback itself throws.

import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type FakeJetstream, memoryPair, SUBSCRIBE_NSID } from '@atmusic/atproto/test-support/fake-jetstream';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { GC_HINTS_PER_RUN } from '../../src/app/index-core';
import type { AdminStatus } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { MAX_PENDING_SNAPSHOT_JOBS } from '../../src/do/ingest/admission';
import { requestGapDiscovery } from '../../src/do/ingest/discovery';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import { GAP_SCAN_DONE } from '../../src/do/ingest/snapshot-job';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/do/schema';
import { markConnected, updateCheckpointBookkeeping } from '../../src/do/status';
import { nextDue, TIMER_NAMES, timerBackoffMs } from '../../src/do/timers';
import { createJetstreamWsConnector } from '../../src/node/jetstream-ws';
import { flush, jetstreamServer } from './jetstream';
import {
  ALICE,
  activeUsers,
  BOB,
  closeHarnesses,
  control,
  type Harness,
  harness,
  ingestFixture,
  kitControl,
  resetControl,
  SCROBBLE,
  schema,
  seedUser,
  T0,
  uriOf,
} from './support';

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
function onlyDueNow(h: Harness, names: readonly string[]) {
  const db = h.db;
  db.tx(() => {
    const now = control.clock.nowMs();
    for (const name of TIMER_NAMES) {
      const at = names.includes(name) ? now : now + DAY;
      db.run('INSERT INTO timers(name, due_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET due_at = ?', name, at, at);
    }
  });
}

const rkeys = (body: unknown) =>
  (body as { items: Array<{ uri: string }> }).items.map((s) => s.uri.slice(s.uri.lastIndexOf('/') + 1));

// ---------------------------------------------------------------------------
// A loopback `ws` server in front of a FakeJetstream

interface LoopbackJetstream {
  readonly port: number;
  /** Upgrade requests the server received (path and query). */
  readonly upgrades: string[];
  /** Open server-side `ws` sockets. */
  readonly sockets: Set<WebSocket>;
  close(): Promise<void>;
}

/**
 * Every upgrade runs the fake's own handshake (faults, cursor checks, call
 * log) over an in-memory pair, whose client end is bridged frame by frame to
 * a real `ws` socket: the fake's events travel over TCP to the production
 * connector. A refusal is written as the fake's HTTP answer.
 */
async function loopbackJetstream(fake: FakeJetstream): Promise<LoopbackJetstream> {
  const server: Server = createHttpServer((_req, res) => res.writeHead(426).end());
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const upgrades: string[] = [];
  const sockets = new Set<WebSocket>();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.push(req.url ?? '');
    void (async () => {
      const answer = await fake.handshake(
        new Request(`https://${fake.host}${req.url ?? '/'}`, { headers: { upgrade: 'websocket' } }),
        memoryPair,
      );
      if (answer.kind === 'refused') {
        const body = await answer.response.text();
        socket.end(
          `HTTP/1.1 ${answer.response.status} Refused\r\ncontent-type: application/json\r\n` +
            `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        );
        return;
      }
      // The in-memory client end (workerd's WebSocket shape, test-support/fake-jetstream.ts).
      const client = answer.client as unknown as {
        accept(): void;
        send(data: string): void;
        close(code?: number, reason?: string): void;
        addEventListener(type: 'message' | 'close', listener: (ev: Event) => void): void;
      };
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        client.addEventListener('message', (ev) => ws.send((ev as unknown as { data: string }).data));
        client.addEventListener('close', (ev) => {
          const { code, reason } = ev as unknown as { code: number; reason: string };
          ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
        });
        ws.on('message', (data) => client.send(data.toString()));
        ws.on('close', (code, reason) => {
          sockets.delete(ws);
          try {
            client.close(code === 1005 ? 1000 : code, reason.toString());
          } catch {
            // already closed
          }
        });
        client.accept();
      });
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    upgrades,
    sockets,
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The production `ws` connector, allowed exactly the loopback origin, behind
 * a URL mapping at the ConnectJetstream interface: the configured
 * `wss://jetstream.example.test` subscribe URL is dialled at
 * `ws://127.0.0.1:<port>` with the same path and query.
 */
function loopbackConnector(port: number, dialled: string[]): ConnectJetstream {
  const origin = `ws://127.0.0.1:${port}`;
  const ws = createJetstreamWsConnector({ jetstreamUrls: [origin], handshakeTimeoutMs: 5_000 });
  return (url) => {
    const u = new URL(url);
    const target = `${origin}${u.pathname}${u.search}`;
    dialled.push(target);
    return ws(target);
  };
}

/** Polls `done` (no clock involved) until it holds; real sockets need real event-loop turns. */
async function until(done: () => boolean, what: string, rounds = 400): Promise<void> {
  for (let n = 0; n < rounds; n++) {
    if (done()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const servers: LoopbackJetstream[] = [];

describe('worker/src/app/index-core.ts on the Node host', () => {
  beforeEach(() => {
    resetControl();
  });
  afterEach(async () => {
    await closeHarnesses();
    for (const s of servers.splice(0)) await s.close();
  });

  it('IndexCore on the Node host runs Jetstream socket mode through the ws connector to a loopback server and re-arms the alarm after a throwing tick', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'socket' } });
    const loop = await loopbackJetstream(kit.jetstream);
    servers.push(loop);
    const dialled: string[] = [];
    control.connectJetstream = loopbackConnector(loop.port, dialled);
    const h = await harness('ws-socket');
    expect(h.app.schema.status).toBe('ready');

    // Start-up made the watchdog due now; the first alarm dials the loopback server at the live tail.
    expect(h.coreAlarm()).toBe(T0);
    expect(await h.runAlarm()).toBe(true);
    await until(() => loop.sockets.size === 1, 'the ws connection');
    expect(dialled).toHaveLength(1);
    expect(new URL(dialled[0] as string).searchParams.get('cursor')).toBeNull();
    expect(loop.upgrades).toEqual([new URL(dialled[0] as string).pathname + new URL(dialled[0] as string).search]);
    expect(kit.jetstream.calls.filter({ nsid: SUBSCRIBE_NSID }).map((c) => c.status)).toEqual([101]);
    expect(checkpoint(h.db)).toEqual({ connected: 1, updated_at_ms: T0 });
    expect(h.log.logs.filter((l) => l.event === 'jetstream_connected')).toHaveLength(1);
    expect((await h.core.adminStatus()).ingest).toMatchObject({ mode: 'socket', connected: true });

    // A throwing tick: the reconcile step of the alarm's `finally` fails once (an
    // injected Db fault), so IndexCore.alarm() itself rejects. The NodeAlarm
    // catches it, logs the error name only, and re-arms at now + the timer
    // backoff instead of losing the chain.
    const timersBefore = h.timers.all.length;
    control.dbFault = {
      match: /FROM repo_jobs WHERE kind = 'snapshot' AND state IN \('pending','failed'\)/,
      message: 'disk I/O error near repo_jobs',
      remaining: 1,
    };
    expect(await h.runAlarm()).toBe(true);
    expect(control.dbFault.remaining).toBe(0);
    control.dbFault = null;
    const failure = h.log.logs.filter((l) => l.event === 'alarm.callback_failed');
    expect(failure).toEqual([
      expect.objectContaining({
        level: 'error',
        alarm: 'core',
        error: 'Error',
        streak: 1,
        retryAtMs: T0 + timerBackoffMs(1),
      }),
    ]);
    expect(JSON.stringify(failure)).not.toContain('disk I/O');
    expect(h.coreAlarm()).toBe(T0 + timerBackoffMs(1));
    // The re-arm is a real (recorded) timer of the remaining delay.
    const rearm = h.timers.all.slice(timersBefore).filter((t) => t.kind === 'timeout' && !t.cleared);
    expect(rearm.map((t) => t.delayMs)).toEqual([timerBackoffMs(1)]);
    // The socket is unaffected.
    expect(loop.sockets.size).toBe(1);
    expect(checkpoint(h.db)?.connected).toBe(1);

    // The retry runs cleanly and the chain is back at min(due_at).
    control.clock.advance(timerBackoffMs(1));
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.failed).toEqual([]);
    expect(h.coreAlarm()).toBe(nextDue(h.db));
    expect(h.log.logs.filter((l) => l.event === 'alarm.callback_failed')).toHaveLength(1);

    // Alice's commit travels fake Jetstream → loopback ws → production connector → ingest socket.
    const a1 = await kit.createRecord('Alice', SCROBBLE, 'a1', scrobble('2026-01-15T11:58:00Z'));
    await until(() => h.db.all('SELECT uri FROM hints').length === 1, 'the hint from the socket');
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: uriOf(ALICE, 'a1'), source: 'jetstream' }]);
    const lastEvent = kit.jetstream.events.at(-1);
    expect(
      h.db.one<{ cursor: number }>("SELECT cursor FROM ingest_checkpoint WHERE stream = 'jetstream'")?.cursor,
    ).toBe(lastEvent?.seq);
    // The hint armed the alarm (drain due now); alarms admit Alice and index her signed head.
    expect(h.coreAlarm()).toBeLessThanOrEqual(control.clock.nowMs() + 2_000);
    await h.alarmsUntil((db) => activeUsers(db).includes(ALICE) && db.all('SELECT uri FROM hints').length === 0);
    expect(h.db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'a1'))).toEqual({ cid: a1.cid });
    expect(loop.sockets.size).toBe(1);
    expect(loop.upgrades).toHaveLength(1);
    const read = await h.request(`/api/v1/users/${ALICE}/scrobbles`);
    expect(read.status).toBe(200);
    expect(rkeys(read.body)).toEqual(['a1']);

    // Shutdown closes the link with 1000; the loopback server sees the close.
    await h.close();
    await until(() => loop.sockets.size === 0, 'the close of the ws connection');
    expect(kit.jetstream.connections.at(-1)?.closeCode).toBe(1000);
  });

  it('composition migrates, marks disconnected, arms the core alarm; the alarm runs drain before snapshot', async () => {
    const kit = await kitControl();
    const h = await harness('ctor');

    // First composition: migrations applied before anything else runs.
    expect(h.compositions).toBe(1);
    expect(h.app.schema).toEqual({ status: 'ready', version: SCHEMA_VERSION });
    expect({
      ready: await h.core.ready(),
      ledger: h.db.all('SELECT version, name FROM schema_migrations ORDER BY version'),
      timers: h.db.all<{ name: string }>('SELECT name FROM timers ORDER BY name').map((r) => r.name),
    }).toEqual({
      ready: { status: 'ready', version: SCHEMA_VERSION },
      ledger: MIGRATIONS.map((m) => ({ version: m.version, name: m.name })),
      // INGEST_MODE=off: the watchdog runs once to close any socket and record the mode.
      timers: ['discovery', 'gc', 'identity-sweep', 'jetstream-watchdog', 'status-sweep'],
    });
    expect(h.coreAlarm()).toBe(T0);

    // That process held a live socket when it died.
    h.db.tx(() => markConnected(h.db, T0));
    expect(checkpoint(h.db)).toEqual({ connected: 1, updated_at_ms: T0 });
    control.clock.advance(30_000);
    await h.restart();

    // The new composition records the drop at its start (the 1→0 instant) and re-arms.
    expect(h.compositions).toBe(2);
    expect(checkpoint(h.db)).toEqual({ connected: 0, updated_at_ms: T0 + 30_000 });
    expect(h.db.all('SELECT version FROM schema_migrations')).toEqual(MIGRATIONS.map((m) => ({ version: m.version })));
    expect(nextDue(h.db)).toBe(T0);
    expect(h.coreAlarm()).toBe(T0);

    // A due hint (drain) and a due snapshot job (snapshot) in the same alarm.
    const alice = await kit.createRecord('Alice', SCROBBLE, 'a1', scrobble('2026-01-15T11:58:00Z'));
    await kit.createRecord('Bob', SCROBBLE, 'b1', scrobble('2026-01-15T11:57:00Z', 'Isobel'));
    h.db.tx(() => seedUser(h.db, ALICE));
    expect((await h.postJson('/api/v1/notify', { uri: uriOf(ALICE, 'a1') }, { ip: '198.51.100.3' })).status).toBe(202);
    expect((await h.postJson('/api/v1/notify', { did: BOB }, { ip: '198.51.100.3' })).status).toBe(202);
    expect({
      hints: h.db.all('SELECT uri, source FROM hints'),
      jobs: h.db.all("SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot'"),
      drain: h.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'drain'")?.due_at,
      snapshot: h.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'snapshot'")?.due_at,
    }).toEqual({
      hints: [{ uri: uriOf(ALICE, 'a1'), source: 'notify' }],
      jobs: [{ did: BOB, state: 'pending', reason: 'admission' }],
      // The hint queue makes the drain durable with the hint, due at once; the admission's
      // job pulls the snapshot timer to the 1 s slice minimum.
      drain: T0 + 30_000,
      snapshot: T0 + 30_000 + 1_000,
    });

    kit.resetCalls();
    control.clock.advance(5_000);
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.failed ?? []).toEqual([]);
    expect((h.core.lastAlarm?.ran ?? []).slice(0, 2)).toEqual(['drain', 'snapshot']);
    // Observable order on the fixture network: Alice's proof fetch precedes every Bob request.
    const calls = kit.transport.calls.entries;
    const proof = calls.findIndex((c) => c.nsid === 'com.atproto.sync.getRecord' && c.did === ALICE);
    const firstBob = calls.findIndex((c) => c.did === BOB);
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(firstBob).toBeGreaterThan(proof);
    expect(h.db.all('SELECT uri FROM hints')).toEqual([]);
    expect(h.db.all('SELECT uri, cid FROM scrobbles ORDER BY uri')).toContainEqual({
      uri: uriOf(ALICE, 'a1'),
      cid: alice.cid,
    });
    expect(activeUsers(h.db)).toContain(ALICE);
  });

  it('restart (close and reopen of the database file) preserves state and resumes the alarm', async () => {
    const kit = await kitControl();
    const h = await harness('restart');
    await ingestFixture(h, kit);

    const tables = () => {
      const db = h.db;
      return {
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
      };
    };

    const page1 = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    expect(rkeys(page1.body)).toEqual(['r07', 'r01']);
    const cursor = (page1.body as { nextCursor: string }).nextCursor;
    const all = await h.request(`/api/v1/users/${ALICE}/scrobbles?limit=100`);
    // Statistics computed before the restart fill stats_cache.
    const statsBefore = await h.request(`/api/v1/users/${ALICE}/stats`);
    expect(statsBefore.status).toBe(200);

    // Work that is due when the process dies: a new record announced through notify.
    const r11 = await kit.createRecord('Alice', SCROBBLE, 'r11', scrobble('2026-01-15T11:59:00Z'));
    expect((await h.postJson('/api/v1/notify', { uri: uriOf(ALICE, 'r11') }, { ip: '198.51.100.4' })).status).toBe(202);
    const before = tables();
    expect(before.stats_cache.length).toBeGreaterThan(0);
    expect(before.indexing_status.length).toBeGreaterThan(0);
    expect(before.backfill_generation).toHaveLength(1);
    expect(before.timers.length).toBeGreaterThan(0);
    const dueBefore = nextDue(h.db);
    const compositions = h.compositions;
    const port = h.address.port;

    await h.restart();
    const after = tables();
    expect(h.compositions).toBe(compositions + 1);
    expect(h.address.port).not.toBe(port);
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
    expect(nextDue(h.db)).toBe(dueBefore);
    expect(h.coreAlarm()).toBe(dueBefore);
    control.clock.advance(5_000);
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.ran[0]).toBe('drain');
    expect(h.db.one('SELECT uri, cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11'))).toEqual({
      uri: uriOf(ALICE, 'r11'),
      cid: r11.cid,
    });
    expect(h.db.all('SELECT uri FROM hints')).toEqual([]);

    // The pre-restart cursor still pages below its anchor: r11 arrived above it and never appears.
    const page3 = await h.request(
      `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${encodeURIComponent((page2.body as { nextCursor: string }).nextCursor)}`,
    );
    expect(rkeys(page3.body)).toEqual(['r04', 'r05']);
  });

  it('status truth through production writers: a fake Jetstream commit applied by the alarm raises admin status lastIndexedAt and sets lagSeconds, and after a socket drop and two restarts the state turns stale exactly 5 min after the drop', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'socket' } });
    const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
    control.connectJetstream = js.connect;
    const h = await harness('status-truth');
    // IndexCore.adminStatus is the index half of the admin socket's GET /admin/status.
    const status = async () => (await h.core.adminStatus()) as AdminStatus;

    // Start-up: the watchdog is due now; the first alarm connects at the live tail (no cursor: a gap).
    let s = await status();
    expect(s.ingest).toMatchObject({ mode: 'socket', connected: false, cursor: null });
    expect(s.indexing).toEqual({ state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null });
    expect(await h.runAlarm()).toBe(true);
    await flush();
    expect(js.attempts.map((a) => [a.host, a.cursor, a.status])).toEqual([['jetstream.example.test', null, 101]]);
    s = await status();
    expect(s.ingest.connected).toBe(true);
    expect(s.indexing).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: null });

    // Alice's first commit reaches the socket: a hint, then admission and a snapshot, all by alarms.
    await kit.createRecord('Alice', SCROBBLE, 'a1', scrobble('2026-01-15T11:58:00Z'));
    await flush();
    expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri: uriOf(ALICE, 'a1'), source: 'jetstream' }]);
    await h.alarmsUntil((db) => activeUsers(db).includes(ALICE), { stepMs: 2_000 });

    // A second commit, applied by the drain from its getRecord proof.
    control.clock.set('2026-01-15T12:10:00Z');
    const second = await kit.createRecord('Alice', SCROBBLE, 'a2', scrobble('2026-01-15T12:09:00Z', 'Isobel'));
    await flush();
    control.clock.set('2026-01-15T12:10:07Z');
    expect(await h.runAlarm()).toBe(true);
    await flush();
    expect(h.db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'a2'))).toEqual({ cid: second.cid });
    s = await status();
    expect(s.indexing.lastIndexedAt).toBe('2026-01-15T12:10:07.000000000Z');
    expect(s.indexing.lagSeconds).toBe(7);
    expect(s.indexing.state).toBe('current');
    expect(s.ingest.lastEventTimeUs).toBe(Date.parse('2026-01-15T12:10:00Z') * 1000);

    // The socket drops at T_DROP; reconnects are refused from then on.
    control.clock.set('2026-01-15T12:11:00Z');
    const T_DROP = control.clock.nowMs();
    kit.jetstream.faults.add({ nsid: SUBSCRIBE_NSID }, { kind: 'status', status: 503, error: 'Unavailable' }, 1000);
    js.last().close(1001, 'server going away');
    await flush();
    expect(checkpoint(h.db)).toEqual({ connected: 0, updated_at_ms: T_DROP });

    // Two restarts (with failed reconnects between): the disconnect instant never moves.
    const attemptsBefore = js.attempts.length;
    for (let n = 0; n < 2; n++) {
      control.clock.advance(60_000);
      expect(await h.runAlarm()).toBe(true);
      await flush();
      await h.restart();
      expect(checkpoint(h.db)).toEqual({ connected: 0, updated_at_ms: T_DROP });
    }
    expect(js.attempts.length).toBeGreaterThan(attemptsBefore);
    expect(js.attempts.slice(attemptsBefore).every((a) => a.status === 503)).toBe(true);
    expect(h.compositions).toBe(3);

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
    const h = await harness('drain-floor');
    const hintAt = (rkey: string) =>
      h.postJson('/api/v1/notify', { uri: uriOf(BOB, rkey) }, { ip: '198.51.100.6' }).then((r) => r.status);
    const drainDue = () => h.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'drain'")?.due_at;

    // Before any drain of this composition, a hint is due at once.
    expect(await hintAt('h1')).toBe(202);
    expect(drainDue()).toBe(T0);
    expect(h.coreAlarm()).toBe(T0);
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.ran[0]).toBe('drain');
    // The drain admitted Bob (unknown DID) and consumed the hint.
    expect(h.db.all('SELECT uri FROM hints')).toEqual([]);

    // Hints every 500 ms after it: the drain stays at T0 + 2 s, it is not pushed back.
    for (const [n, rkey] of ['h2', 'h3', 'h4'].entries()) {
      control.clock.advance(500);
      expect(await hintAt(rkey)).toBe(202);
      expect([n, drainDue()]).toEqual([n, T0 + 2_000]);
    }
    control.clock.advance(500);
    expect(await h.runAlarm()).toBe(true);
    // One drain worked the whole burst (each hint once; Bob's identity is not reachable
    // here, so each backs off instead of applying).
    expect({
      ran: h.core.lastAlarm?.ran[0],
      hints: h.db.all('SELECT rkey, attempts FROM hints ORDER BY rkey'),
    }).toEqual({
      ran: 'drain',
      hints: [
        { rkey: 'h2', attempts: 1 },
        { rkey: 'h3', attempts: 1 },
        { rkey: 'h4', attempts: 1 },
      ],
    });
  });

  it('gap hold and clear commit in one transaction', async () => {
    await kitControl();
    const h = await harness('gap-hold');
    const adminIngest = async () => {
      const body = (await h.core.adminStatus()) as AdminStatus;
      expect(schema('Indexing', body.indexing)).toBe('valid');
      return body;
    };
    const gapRow = () =>
      h.db.one<{ pending_gap: number; gap_scan_after_did: string | null }>(
        "SELECT pending_gap, gap_scan_after_did FROM ingest_checkpoint WHERE stream = 'jetstream'",
      );

    // Gap recovery is under way: its snapshot scan is finished and no gap job is open,
    // but its relay discovery pass has not run yet.
    updateCheckpointBookkeeping(h.db, { pendingGap: true, gapScanAfterDid: GAP_SCAN_DONE });
    requestGapDiscovery(h.db, control.clock.nowMs());
    expect((await adminIngest()).ingest.pendingGap).toBe(true);

    // The snapshot slice sees "scan done, nothing open" and would clear pending_gap; the
    // process dies at its next storage read, which is where the discovery pass is consulted.
    onlyDueNow(h, ['snapshot']);
    control.dbFault = { match: /FROM counters WHERE name = \? LIMIT 1/, message: 'process lost', remaining: 1 };
    expect(await h.runAlarm()).toBe(true);
    const crashed = h.core.lastAlarm;
    expect(control.dbFault.remaining).toBe(0);
    expect(crashed?.failed.map((f) => f.name)).toEqual(['snapshot']);
    // Nothing committed in between: the gap is still pending, as it must be while discovery runs.
    expect(gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });

    // A restart (close and reopen) keeps it, and the status still reports the gap.
    control.dbFault = null;
    await h.restart();
    expect(gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });
    // (INGEST_MODE=off here, so the global state is `stale` regardless; the gap flag is the evidence.)
    let s = await adminIngest();
    expect(s.ingest.pendingGap).toBe(true);
    expect(s.indexing.caughtUp).toBe(false);

    // A healthy snapshot slice holds the gap too (the discovery pass is still pending) ...
    control.clock.advance(1_000);
    onlyDueNow(h, ['snapshot']);
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.ran).toContain('snapshot');
    expect(gapRow()).toEqual({ pending_gap: 1, gap_scan_after_did: GAP_SCAN_DONE });

    // ... and the discovery pass's end clears it, in the discovery handler's own transaction.
    control.clock.advance(1_000);
    onlyDueNow(h, ['discovery']);
    expect(await h.runAlarm()).toBe(true);
    const ran = h.core.lastAlarm;
    expect(ran?.ran).toContain('discovery');
    expect(ran?.failed).toEqual([]);
    expect(gapRow()).toEqual({ pending_gap: 0, gap_scan_after_did: null });
    s = await adminIngest();
    expect(s.ingest.pendingGap).toBe(false);
  });

  it('gc is not blocked by retained hints', async () => {
    const h = await harness('gc-retained');
    const now = control.clock.nowMs();
    const old = (minutes: number) => toStorage(fromMs(now - 8 * DAY - minutes * 60_000));
    const unknown = (n: number) => `did:plc:u${String(n).padStart(23, '0')}`;
    const SUPPRESSED = 'did:plc:ssssssssssssssssssssssss';
    const NO_JOB = 'did:plc:nnnnnnnnnnnnnnnnnnnnnnnn';
    const OPEN_JOB = 'did:plc:oooooooooooooooooooooooo';
    const LATER = 'did:plc:llllllllllllllllllllllll';
    const hintsOf = (db: Db) =>
      db.all<{ did: string; n: number }>('SELECT did, count(*) AS n FROM hints GROUP BY did ORDER BY did');

    const db = h.db;
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
    });
    onlyDueNow(h, ['gc']);

    // The daily gc run, through the alarm (the only timer due).
    expect(await h.runAlarm()).toBe(true);
    const expiredCount = () =>
      h.db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'hint_expired'")?.value ?? 0;
    const first = {
      ran: h.core.lastAlarm?.ran,
      failed: h.core.lastAlarm?.failed,
      hints: hintsOf(h.db),
      job: h.db.one("SELECT state, reason FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", OPEN_JOB),
      expired: expiredCount(),
      gcDue: h.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'gc'")?.due_at,
    };
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
    h.db.run("DELETE FROM repo_jobs WHERE reason = 'filler'");
    control.clock.advance(DAY);
    onlyDueNow(h, ['gc']);
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.ran).toEqual(['gc']);
    expect(expiredCount()).toBe(2 + 4);
    expect(
      h.db.all(
        "SELECT did, state, reason FROM repo_jobs WHERE kind = 'snapshot' AND did IN (?, ?) ORDER BY did",
        LATER,
        NO_JOB,
      ),
    ).toEqual([
      { did: LATER, state: 'pending', reason: 'hint_expired' },
      { did: NO_JOB, state: 'pending', reason: 'hint_expired' },
    ]);
    const second = hintsOf(h.db);
    expect(second.filter((r) => !r.did.startsWith('did:plc:u'))).toEqual([{ did: SUPPRESSED, n: 2 }]);
    expect(second.filter((r) => r.did.startsWith('did:plc:u'))).toHaveLength(GC_HINTS_PER_RUN);
  });
});
