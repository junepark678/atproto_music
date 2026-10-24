// W4-02 jetstream-socket.ts and checkpoint.ts against real DO SQLite and real
// workerd WebSockets (WebSocketPair through the production connector, served
// by the fake Jetstream). Timers are stepped with runDue after advancing the
// frozen clock; nothing sleeps. Proves M1.1.1/version_policy,
// M4.2.1/expired_cursor and M4.2.1/bounded_reconnect, and the status truth the
// production socket writers produce. Expectations are hardcoded.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import type { Db } from '../../src/do/db';
import { gapOnConnect, noteRestart, type ScheduleGapRecovery } from '../../src/do/ingest/checkpoint';
import {
  closeSocket,
  connect,
  RECONNECT_CAP_MS,
  reconnectDelayMs,
  socketStatus,
  socketWatchdog,
  subscribeUrl,
} from '../../src/do/ingest/jetstream-socket';
import { indexing, updateCheckpointBookkeeping } from '../../src/do/status';
import { dueAt, runDue, TIMER_NAMES, type TimerHandlers } from '../../src/do/timers';
import { incrementCounter } from '../../src/do/write/keys';
import {
  checkpointRow,
  flush,
  type IngestTestDeps,
  ingestDeps,
  type JetstreamServer,
  jetstreamServer,
} from '../fixtures/jetstream-server';
import type { HarnessDO } from '../harness/harness-do';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-01-15T12:00:00Z');
const P = 'com.example.atmusic';
const S = `${P}.scrobble`;
const F = `${P}.follow`;
const SETTINGS = `${P}.settings`;
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REV = '3lbcdefghijkl';
const CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const EAST = 'jetstream.us-east.example.test';
const WEST = 'jetstream.us-west.example.test';
const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents';

const validIndexing = (() => {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema('openapi#/components/schemas/Indexing')!;
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
})();

/** The global Indexing in socket mode, schema-checked. */
function status(db: Db, nowMs: number): Indexing {
  const result = indexing(db, nowMs, { mode: 'socket' });
  expect(validIndexing(result)).toBe('valid');
  return result;
}

/** A scrobble commit event for `rkey`, at `timeUs` (default: the clock). */
function commit(rkey: string, timeUs?: number, collection = S) {
  return {
    kind: 'commit' as const,
    did: ALICE,
    commit: { rev: REV, operation: 'create' as const, collection, rkey, cid: CID },
    ...(timeUs === undefined ? {} : { timeUs }),
  };
}

const hintUris = (db: Db) => db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri').map((r) => r.uri);
const seqsSent = (server: JetstreamServer) => server.last().sent.map((t) => (JSON.parse(t) as { seq: number }).seq);

/** Step the alarm multiplexer: only the watchdog does work. */
async function step(
  storage: DurableObjectStorage,
  m: IngestTestDeps,
  server: JetstreamServer,
  o: { gap?: ScheduleGapRecovery } = {},
) {
  const handlers = Object.fromEntries(TIMER_NAMES.map((n) => [n, async () => {}])) as unknown as TimerHandlers;
  handlers['jetstream-watchdog'] = async (now) => {
    await socketWatchdog(m, server.connect, now, o.gap === undefined ? {} : { scheduleGapRecovery: o.gap });
  };
  const report = await runDue(storage, m.db, m.clock.nowMs(), handlers, { maxRuns: 10 });
  expect(report.failed).toEqual([]);
  await flush();
  return report;
}

describe('jetstream socket', () => {
  it('subscribe URL has kinds=commit and the three collections only', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock });
    await runInDurableObject(stubFor('socket-url'), async (i: HarnessDO) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      expect(await connect(m, server.connect, clock.nowMs())).toMatchObject({ ok: true, gap: 'no_cursor' });
      expect(server.attempts.length).toBe(1);
      const first = server.attempts[0]!;
      expect(first.status).toBe(101);
      expect(first.url.protocol).toBe('https:');
      expect(first.url.host).toBe('jetstream.example.test');
      expect(first.url.pathname).toBe(SUBSCRIBE_PATH);
      expect([...new Set(first.url.searchParams.keys())]).toEqual(['kinds', 'collections']);
      expect(first.url.searchParams.getAll('kinds')).toEqual(['commit']);
      expect(first.url.searchParams.getAll('collections')).toEqual([S, F, SETTINGS]);
      // The fake saw the upgrade with exactly that subscription.
      expect(server.at('jetstream.example.test').calls.count({ status: 101 })).toBe(1);
      expect(server.last().kinds).toEqual(['commit']);
      expect(server.last().collections).toEqual([S, F, SETTINGS]);
      expect(checkpointRow(i.db)).toMatchObject({ connected: 1, mode: 'socket', host_index: 0 });

      // Only subscribed collections arrive: a post is filtered upstream, a settings record is hinted.
      server.append(commit('p1', undefined, 'app.bsky.feed.post'));
      const settings = server.append({
        kind: 'commit',
        did: ALICE,
        commit: { rev: REV, operation: 'create', collection: SETTINGS, rkey: 'self', cid: CID },
      });
      await flush();
      expect(seqsSent(server)).toEqual([settings.seq]);
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${SETTINGS}/self`]);
      expect(checkpointRow(i.db)).toMatchObject({ cursor: settings.seq });

      // A reconnect adds only the cursor.
      closeSocket(m, clock.nowMs());
      expect(await connect(m, server.connect, clock.nowMs())).toMatchObject({ ok: true, gap: null });
      const second = server.attempts[1]!;
      expect([...new Set(second.url.searchParams.keys())]).toEqual(['kinds', 'collections', 'cursor']);
      expect(second.url.searchParams.getAll('kinds')).toEqual(['commit']);
      expect(second.url.searchParams.getAll('collections')).toEqual([S, F, SETTINGS]);
      expect(second.cursor).toBe(settings.seq);

      // Any valid prefix derives exactly its scrobble, follow and settings collections (A10).
      const other = ingestDeps(i.db, clock, { mode: 'socket', prefix: 'org.example.other' });
      const url = new URL(subscribeUrl(other, 0, null));
      expect(url.searchParams.getAll('kinds')).toEqual(['commit']);
      expect(url.searchParams.getAll('collections')).toEqual([
        'org.example.other.scrobble',
        'org.example.other.follow',
        'org.example.other.settings',
      ]);
      closeSocket(m, clock.nowMs());
    });
  });

  it('silent socket is not reconnected; planned refresh happens at 15 min from stored cursor', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock });
    await runInDurableObject(stubFor('socket-silent'), async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      expect(await connect(m, server.connect, T0)).toMatchObject({ ok: true });
      const first = server.last();
      server.append(commit('r1'));
      const e2 = server.append(commit('r2'));
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ cursor: e2.seq, connected: 1, connected_at_ms: T0 });
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + MINUTE);

      // Fourteen watchdog runs over a silent stream: no reconnect, no write to the checkpoint.
      const quiet = checkpointRow(i.db);
      for (let minute = 1; minute <= 14; minute++) {
        clock.set(new Date(T0 + minute * MINUTE).toISOString());
        const report = await step(state.storage, m, server);
        expect(report.ran).toContain('jetstream-watchdog');
        expect(server.attempts.length).toBe(1);
        expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + (minute + 1) * MINUTE);
      }
      expect(first.closed).toBe(false);
      expect(checkpointRow(i.db)).toEqual(quiet);

      // At 15 min: a planned refresh on the same host, resuming from the stored cursor.
      clock.set(new Date(T0 + 15 * MINUTE).toISOString());
      await step(state.storage, m, server);
      expect(server.attempts.length).toBe(2);
      expect(server.attempts[1]).toMatchObject({ host: 'jetstream.example.test', cursor: e2.seq, status: 101 });
      expect(first.closed).toBe(true);
      expect(first.closeCode).toBe(1000);
      expect(server.live()).toEqual([server.last()]);
      // The inclusive cursor re-delivers e2 only; its hint coalesces.
      expect(seqsSent(server)).toEqual([e2.seq]);
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${S}/r1`, `at://${ALICE}/${S}/r2`]);
      expect(checkpointRow(i.db)).toMatchObject({
        cursor: e2.seq,
        connected: 1,
        connected_at_ms: T0 + 15 * MINUTE,
        updated_at_ms: T0 + 15 * MINUTE,
        host_index: 0,
      });
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 16 * MINUTE);
      expect(socketStatus(m).streak).toBe(0);
      closeSocket(m, clock.nowMs());
    });
  });

  it('quiet link longer than lookback does not trigger gap recovery on planned refresh; real disconnect gap still does', async () => {
    const clock = fixedClock();
    // The fake keeps exactly our 24 h lookback, so it refuses any cursor that aged past it.
    const server = jetstreamServer({ clock, lookbackHours: 24 });
    const stub = stubFor('socket-quiet-lookback');
    const gapCalls: number[] = [];
    const gap: ScheduleGapRecovery = (_db, now) => {
      gapCalls.push(now);
    };
    let e1Seq = 0;
    let lastOpen = 0;
    await runInDurableObject(stub, async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      // First start (a gap by definition), then one wanted event at T0 and silence for 26 hours.
      expect(await connect(m, server.connect, T0, { scheduleGapRecovery: gap })).toMatchObject({ gap: 'no_cursor' });
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      e1Seq = server.append(commit('r1')).seq;
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ cursor: e1Seq, last_event_time_us: T0 * 1000 });

      // 104 planned refreshes, one every 15 minutes, over a socket that never delivers a new event.
      for (let n = 1; n <= 104; n++) {
        const at = T0 + n * 15 * MINUTE;
        clock.set(new Date(at).toISOString());
        await step(state.storage, m, server, { gap });
        const attempt = server.attempts.at(-1)!;
        expect([n, attempt.status]).toEqual([n, 101]);
        // Refresh 1 resumes from e1 (the first link saw a new event: nothing is confirmed). The
        // links after it see only the inclusive re-delivery of e1 or nothing, so every later
        // refresh resumes 60 s before the previous link opened.
        const expected = n === 1 ? e1Seq : (at - 15 * MINUTE - MINUTE) * 1000;
        expect([n, attempt.cursor]).toEqual([n, expected]);
        expect(checkpointRow(i.db)).toMatchObject({ connected: 1, connected_at_ms: at, pending_gap: 0 });
      }
      lastOpen = T0 + 104 * 15 * MINUTE;
      expect(lastOpen - T0).toBe(26 * HOUR);
      // No gap recovery beyond the first start: no cursor was ever refused or abandoned.
      expect(gapCalls).toEqual([T0]);
      expect(server.attempts.slice(1).every((a) => a.status === 101 && a.cursor !== null)).toBe(true);
      expect(server.attempts).toHaveLength(105);
      // Only e1 (and its inclusive re-delivery on refresh 1, coalesced) reached the queue.
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${S}/r1`]);
      expect(status(i.db, clock.nowMs())).toMatchObject({ state: 'current' });
      expect(i.db.one("SELECT count(*) AS n FROM counters WHERE name = 'jetstream_invalid'")).toEqual({ n: 0 });

      // The advanced resume point is durable: the instance dies with the link open.
      server.sever();
      await flush();
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      // Two minutes later the new instance records the drop and reconnects: still no gap.
      clock.set(new Date(lastOpen + 2 * MINUTE).toISOString());
      expect(noteRestart(i.db, clock.nowMs())).toBe(true);
      expect(checkpointRow(i.db)).toMatchObject({ cursor: (lastOpen - 16 * MINUTE) * 1000, pending_gap: 0 });
      await step(state.storage, m, server, { gap });
      expect(server.attempts.at(-1)).toMatchObject({ cursor: (lastOpen - 16 * MINUTE) * 1000, status: 101 });
      expect(gapCalls).toEqual([T0]);
      expect(checkpointRow(i.db)).toMatchObject({ connected: 1, pending_gap: 0 });

      // A real disconnect: the server drops the link 5 minutes in (no planned refresh, nothing
      // confirmed), and the instance stays cut off for 25 hours.
      const dropAt = lastOpen + 7 * MINUTE;
      clock.set(new Date(dropAt).toISOString());
      server.last().close(1001, 'going away');
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ connected: 0, updated_at_ms: dropAt });
      // The drop confirmed nothing: the resume point is still the one the link opened with.
      expect(checkpointRow(i.db).cursor).toBe((lastOpen - 16 * MINUTE) * 1000);

      const back = dropAt + 25 * HOUR;
      clock.set(new Date(back).toISOString());
      await step(state.storage, m, server, { gap });
      // Continuity was lost for longer than the lookback: gap recovery, from the live tail.
      expect(server.attempts.at(-1)).toMatchObject({ cursor: null, status: 101 });
      expect(gapCalls).toEqual([T0, back]);
      expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 1, connected: 1, cursor: back * 1000 });
      expect(status(i.db, back)).toMatchObject({ state: 'recovering', caughtUp: false });
      closeSocket(m, clock.nowMs());
    });
  });

  it('close triggers reconnect delays 1,2,4,…,60s and rotates us-east→us-west', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock, hosts: [EAST, WEST] });
    await runInDurableObject(stubFor('socket-backoff'), async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket', hosts: [EAST, WEST] });
      const hostOf = (attempt: number) => (attempt % 2 === 0 ? EAST : WEST);

      // How attempt n ends: the server closes it, the socket errors, or the upgrade is refused (503).
      const plan = ['close', 'error', 'refuse', 'close', 'close', 'refuse', 'close', 'error'] as const;
      const delays: number[] = [];
      let lastDropAt = T0;
      for (const [n, how] of plan.entries()) {
        if (how === 'refuse') server.at(hostOf(n)).faults.add({}, { kind: 'status', status: 503 });
        if (n === 0) {
          expect(await connect(m, server.connect, T0)).toMatchObject({ ok: true, hostIndex: 0 });
        } else {
          // Before the backoff passes the watchdog does nothing.
          const due = dueAt(i.db, 'jetstream-watchdog')!;
          expect(await socketWatchdog(m, server.connect, due - 1)).toMatchObject({ action: 'backoff' });
          expect(server.attempts.length).toBe(n);
          clock.set(new Date(due).toISOString());
          await step(state.storage, m, server);
        }
        expect(server.attempts.length).toBe(n + 1);
        expect(server.attempts[n]).toMatchObject({ host: hostOf(n), status: how === 'refuse' ? 503 : 101 });
        const dropAt = clock.nowMs();
        if (how === 'close') server.last().close(1001, 'going away');
        if (how === 'error') server.last().error('fixture socket error');
        await flush();
        delays.push(dueAt(i.db, 'jetstream-watchdog')! - dropAt);
        if (how !== 'refuse') lastDropAt = dropAt;
        // Disconnected since the drop; a refused connect writes no connection evidence.
        expect(checkpointRow(i.db)).toMatchObject({
          connected: 0,
          updated_at_ms: lastDropAt,
          host_index: (n + 1) % 2,
        });
        expect(socketStatus(m).open).toBeNull();
      }
      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * SECOND));
      expect(server.attempts.map((a) => a.host)).toEqual(plan.map((_, n) => hostOf(n)));

      // A connection that stays open 60 s resets the streak: its close backs off 1 s again.
      clock.set(new Date(dueAt(i.db, 'jetstream-watchdog')!).toISOString());
      await step(state.storage, m, server);
      expect(server.attempts.at(-1)).toMatchObject({ host: EAST, status: 101 });
      expect(checkpointRow(i.db)).toMatchObject({ connected: 1, host_index: 0 });
      clock.advance(60 * SECOND);
      server.last().close(1001, 'going away');
      await flush();
      expect(dueAt(i.db, 'jetstream-watchdog')! - clock.nowMs()).toBe(SECOND);
      expect(checkpointRow(i.db)).toMatchObject({ connected: 0, host_index: 1, updated_at_ms: clock.nowMs() });

      // Jitter is injected (zero above): it adds at most 20 % and never passes the 60 s cap.
      expect(reconnectDelayMs(1, 0.5)).toBe(1_100);
      expect(reconnectDelayMs(3, 1)).toBe(4_800);
      expect(reconnectDelayMs(7, 0.99)).toBe(RECONNECT_CAP_MS);
      const jittered = reconnectDelayMs(4, seededRandom(3).float());
      expect(jittered).toBeGreaterThanOrEqual(8_000);
      expect(jittered).toBeLessThanOrEqual(9_600);
    });
  });

  it('cursor older than lookback sets pending_gap and resumes from live tail', async () => {
    const clock = fixedClock();
    // The fake retains 48 h, so only our own 24 h lookback check can refuse the old cursor.
    const server = jetstreamServer({ clock, lookbackHours: 48 });
    await runInDurableObject(stubFor('socket-gap'), async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      const gapCalls: number[] = [];
      const gap: ScheduleGapRecovery = (db, now) => {
        // W4-01's scheduler runs inside the connect transaction (a nested transaction here).
        db.tx(() => incrementCounter(db, 'test_gap_scheduled', ''));
        gapCalls.push(now);
      };
      const gapsScheduled = () =>
        i.db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'test_gap_scheduled'")?.value ?? 0;

      // First start: no cursor is a gap too.
      expect(await connect(m, server.connect, T0, { scheduleGapRecovery: gap })).toMatchObject({
        ok: true,
        gap: 'no_cursor',
      });
      expect(gapCalls).toEqual([T0]);
      // The resume point is the live tail (a time_us cursor at the attempt instant), not "no cursor".
      expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 1, connected: 1, cursor: T0 * 1000 });
      // The gap recovery finished (W4-01 maybeClearGap's bookkeeping write).
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      const e1 = server.append(commit('r1'));
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ cursor: e1.seq, last_event_time_us: T0 * 1000, pending_gap: 0 });
      server.last().close(1001, 'going away');
      await flush();

      // Exactly 24 h after the cursor's event it is inside the lookback; 1 ms later it is not.
      const cp = { cursor: e1.seq, lastEventTimeUs: T0 * 1000 };
      expect(gapOnConnect(cp, T0 + 24 * HOUR, 24)).toBeNull();
      expect(gapOnConnect(cp, T0 + 24 * HOUR + 1, 24)).toBe('cursor_too_old');

      // An event published while disconnected, then the reconnect 24 h + 1 s after e1.
      server.append(commit('r2', (T0 + HOUR) * 1000));
      const at = T0 + 24 * HOUR + SECOND;
      clock.set(new Date(at).toISOString());
      await step(state.storage, m, server, { gap });
      expect(server.attempts.map((a) => [a.cursor, a.status])).toEqual([
        [null, 101],
        [null, 101], // the live tail, not the 24 h old cursor
      ]);
      expect(seqsSent(server)).toEqual([]); // r2 is not replayed; gap recovery snapshots cover it
      expect(gapCalls).toEqual([T0, at]);
      expect(gapsScheduled()).toBe(2);
      expect(checkpointRow(i.db)).toMatchObject({
        pending_gap: 1,
        connected: 1,
        connected_at_ms: at,
        // The 24 h old cursor is abandoned to gap recovery; the resume point is the tail.
        cursor: at * 1000,
        last_event_time_us: null,
      });
      expect(status(i.db, at)).toMatchObject({ state: 'recovering', caughtUp: false });

      // Live events flow from the tail.
      const e3 = server.append(commit('r3'));
      await flush();
      expect(seqsSent(server)).toEqual([e3.seq]);
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${S}/r1`, `at://${ALICE}/${S}/r3`]);
      expect(checkpointRow(i.db)).toMatchObject({ cursor: e3.seq, last_event_time_us: e3.timeUs });

      // A cursor Jetstream rejects (400 OutdatedCursor) is a gap as well: retried once from the live tail.
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      closeSocket(m, clock.nowMs());
      clock.advance(2 * HOUR);
      server.at('jetstream.example.test').lookbackHours = 1;
      expect(await connect(m, server.connect, clock.nowMs(), { scheduleGapRecovery: gap })).toMatchObject({
        ok: true,
        gap: 'cursor_rejected',
      });
      expect(server.attempts.slice(2).map((a) => [a.cursor, a.status])).toEqual([
        [e3.seq, 400],
        [null, 101],
      ]);
      const rejectedAt = clock.nowMs();
      expect(gapCalls).toEqual([T0, at, rejectedAt]);
      expect(gapsScheduled()).toBe(3);
      expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 1, connected: 1, cursor: rejectedAt * 1000 });

      // The gap is handled once. W4-01 finishes the recovery; two quiet planned
      // refreshes (15 and 30 min) resume from the stored tail cursor, which the
      // fake accepts: no new gap, no second recovery, pending_gap stays clear.
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      // (Each link is quiet, so from the second refresh on the resume point is the previous
      // link's open instant minus 60 s, ADR §15 Q11: the first link opened at the tail itself.)
      const resumeAt = (minutes: number) => (minutes === 15 ? rejectedAt : rejectedAt + (minutes - 16) * MINUTE) * 1000;
      for (const minutes of [15, 30]) {
        clock.set(new Date(rejectedAt + minutes * MINUTE).toISOString());
        await step(state.storage, m, server, { gap });
        expect(server.attempts.at(-1)).toMatchObject({ cursor: resumeAt(minutes), status: 101 });
        expect(checkpointRow(i.db)).toMatchObject({
          pending_gap: 0,
          connected: 1,
          connected_at_ms: rejectedAt + minutes * MINUTE,
          cursor: resumeAt(minutes),
        });
        // Not recovering again (caughtUp stays false only because the r1/r3 hints are undrained here).
        expect(status(i.db, clock.nowMs())).toMatchObject({ state: 'current', caughtUp: false, lagSeconds: null });
      }
      expect(server.attempts.slice(4).map((a) => [a.cursor, a.status])).toEqual([
        [rejectedAt * 1000, 101],
        [(rejectedAt + 14 * MINUTE) * 1000, 101],
      ]);
      expect(gapCalls).toEqual([T0, at, rejectedAt]);
      expect(gapsScheduled()).toBe(3);
      // A live event after the tail cursor is still delivered from it and moves the cursor on.
      const e4 = server.append(commit('r4'));
      await flush();
      expect(seqsSent(server)).toEqual([e4.seq]);
      expect(checkpointRow(i.db)).toMatchObject({ cursor: e4.seq, last_event_time_us: e4.timeUs });
      closeSocket(m, clock.nowMs());
    });
  });

  it('a quiet reconnect does not hide a cursor older than lookback: its connect instant bounds the cursor time', async () => {
    const clock = fixedClock();
    // The fake retains 96 h and silently serves the old cursor: only our 24 h check can see the gap.
    const server = jetstreamServer({ clock, lookbackHours: 96 });
    await runInDurableObject(stubFor('socket-quiet-age'), async (i: HarnessDO) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      const gapCalls: number[] = [];
      const gap: ScheduleGapRecovery = (_db, now) => {
        gapCalls.push(now);
      };
      expect(await connect(m, server.connect, T0, { scheduleGapRecovery: gap })).toMatchObject({ gap: 'no_cursor' });
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      const e1 = server.append(commit('r1'));
      await flush();
      closeSocket(m, clock.nowMs());

      // A quiet reconnect (it ends before any event, the inclusive replay included).
      clock.advance(MINUTE);
      const quietAt = clock.nowMs();
      expect(await connect(m, server.connect, quietAt, { scheduleGapRecovery: gap })).toMatchObject({
        ok: true,
        gap: null,
      });
      closeSocket(m, clock.nowMs());
      expect(checkpointRow(i.db)).toMatchObject({
        cursor: e1.seq,
        last_event_time_us: null,
        connected: 0,
        connected_at_ms: quietAt,
        pending_gap: 0,
      });
      // The sequence cursor's event predates the quiet connect, so quietAt bounds its time.
      const cp = { cursor: e1.seq, lastEventTimeUs: null, connectedAtMs: quietAt, updatedAtMs: quietAt };
      expect(gapOnConnect(cp, quietAt + 24 * HOUR, 24)).toBeNull();
      expect(gapOnConnect(cp, quietAt + 24 * HOUR + 1, 24)).toBe('cursor_too_old');

      // Down 72 h (more than the 24 h lookback), then reconnect: a gap, from the live tail.
      clock.advance(72 * HOUR);
      const back = clock.nowMs();
      expect(await connect(m, server.connect, back, { scheduleGapRecovery: gap })).toMatchObject({
        ok: true,
        gap: 'cursor_too_old',
      });
      expect(server.attempts.map((a) => [a.cursor, a.status])).toEqual([
        [null, 101],
        [e1.seq, 101],
        [null, 101],
      ]);
      expect(gapCalls).toEqual([T0, back]);
      expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 1, connected: 1, cursor: back * 1000 });
      expect(status(i.db, back)).toMatchObject({ state: 'recovering', caughtUp: false });
      closeSocket(m, clock.nowMs());
    });
  });

  it('a throw after the upgrade is accepted closes the socket with 1011, writes no connection evidence, and the watchdog reconnects once', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock, hosts: [EAST, WEST] });
    await runInDurableObject(stubFor('socket-post-upgrade-throw'), async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket', hosts: [EAST, WEST] });
      let failNext = true;
      const gapCalls: number[] = [];
      // The injected W4-01 scheduler: the first call writes, then throws (inside the connect transaction).
      const gap: ScheduleGapRecovery = (db, now) => {
        db.tx(() => incrementCounter(db, 'test_gap_scheduled', ''));
        gapCalls.push(now);
        if (failNext) {
          failNext = false;
          throw new Error('fixture: gap recovery failed');
        }
      };
      const gapsScheduled = () =>
        i.db.one<{ value: number }>("SELECT value FROM counters WHERE name = 'test_gap_scheduled'")?.value ?? 0;
      const before = checkpointRow(i.db);
      expect(before).toMatchObject({ connected: 0, pending_gap: 1, cursor: null, host_index: 0 });

      // First start has no cursor (a gap), so the throwing scheduler runs after the upgrade.
      expect(await connect(m, server.connect, T0, { scheduleGapRecovery: gap })).toEqual({
        ok: false,
        reason: 'failed',
        url: subscribeUrl(m, 0, null),
        status: null,
        error: 'local_failure',
        retryAtMs: T0 + SECOND,
      });
      await flush();
      expect(server.attempts.map((a) => [a.host, a.status])).toEqual([[EAST, 101]]);
      // The accepted socket is closed by us with 1011, not left open queuing frames.
      const first = server.last();
      expect(first.closed).toBe(true);
      expect(first.closeCode).toBe(1011);
      expect(server.live()).toEqual([]);
      expect(socketStatus(m)).toEqual({ open: null, streak: 1, nextAttemptAtMs: T0 + SECOND });
      // Nothing of the connect transaction is stored (the scheduler's own write rolled back too);
      // only the failed-connect host rotation is.
      expect(checkpointRow(i.db)).toEqual({ ...before, host_index: 1 });
      expect(gapCalls).toEqual([T0]);
      expect(gapsScheduled()).toBe(0);
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + SECOND);
      expect(m.log.entries.map((e) => e.event)).toEqual([
        'jetstream_connect_bookkeeping_failed',
        'jetstream_connect_failed',
      ]);
      // An event published now reaches no socket of ours.
      server.append(commit('r0'));
      await flush();
      expect(first.sent).toEqual([]);
      expect(hintUris(i.db)).toEqual([]);

      // Before the backoff passes the watchdog opens nothing.
      expect(await socketWatchdog(m, server.connect, T0 + SECOND - 1, { scheduleGapRecovery: gap })).toMatchObject({
        action: 'backoff',
      });
      expect(server.attempts.length).toBe(1);

      // The watchdog retries on the rotated host and opens exactly one new connection.
      clock.set(new Date(T0 + SECOND).toISOString());
      await step(state.storage, m, server, { gap });
      expect(server.attempts.map((a) => [a.host, a.cursor, a.status])).toEqual([
        [EAST, null, 101],
        [WEST, null, 101],
      ]);
      expect(server.live().length).toBe(1);
      expect(server.last()).not.toBe(first);
      expect(gapCalls).toEqual([T0, T0 + SECOND]);
      expect(gapsScheduled()).toBe(1);
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 1,
        connected_at_ms: T0 + SECOND,
        pending_gap: 1,
        host_index: 1,
        cursor: (T0 + SECOND) * 1000,
      });
      expect(socketStatus(m).open).toMatchObject({ hostIndex: 1, mode: 'socket' });
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + SECOND + MINUTE);
      const e1 = server.append(commit('r1'));
      await flush();
      expect(seqsSent(server)).toEqual([e1.seq]);
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${S}/r1`]);
      closeSocket(m, clock.nowMs());
    });
  });

  it('DO eviction marks connected=false on restart and watchdog reconnects', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock });
    const stub = stubFor('socket-evict');
    let e1Seq = 0;
    await runInDurableObject(stub, async (i: HarnessDO) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      expect(await connect(m, server.connect, T0)).toMatchObject({ ok: true });
      e1Seq = server.append(commit('r1')).seq;
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 1,
        connected_at_ms: T0,
        updated_at_ms: T0,
        cursor: e1Seq,
      });
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + MINUTE);
      // The instance dies with its socket open (see jetstream-server.ts `sever`):
      // no close handler of ours runs, so the stored flag stays connected.
      server.sever();
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ connected: 1, updated_at_ms: T0 });
    });

    await evictDurableObject(stub);
    clock.set(new Date(T0 + 20 * SECOND).toISOString());
    await runInDurableObject(stub, async (i: HarnessDO) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      // No socket survives an eviction, but the stored flag still says connected.
      expect(socketStatus(m).open).toBeNull();
      expect(checkpointRow(i.db)).toMatchObject({ connected: 1 });
      // IndexDO's constructor records the drop (W5-01 calls noteRestart).
      expect(noteRestart(i.db, clock.nowMs())).toBe(true);
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 0,
        updated_at_ms: T0 + 20 * SECOND,
        connected_at_ms: T0,
        cursor: e1Seq,
      });
    });

    // A second restart does not move the disconnect instant.
    await evictDurableObject(stub);
    clock.set(new Date(T0 + 40 * SECOND).toISOString());
    await runInDurableObject(stub, async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket' });
      expect(noteRestart(i.db, clock.nowMs())).toBe(false);
      expect(checkpointRow(i.db)).toMatchObject({ connected: 0, updated_at_ms: T0 + 20 * SECOND });
      expect(status(i.db, clock.nowMs())).toMatchObject({ caughtUp: false });

      // The watchdog timer survived; when it fires, this instance reconnects from the stored cursor.
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + MINUTE);
      clock.set(new Date(T0 + MINUTE).toISOString());
      const report = await step(state.storage, m, server);
      expect(report.ran).toEqual(['drain', 'jetstream-watchdog']); // drain is a no-op stub here
      expect(server.attempts.map((a) => [a.cursor, a.status])).toEqual([
        [null, 101],
        [e1Seq, 101],
      ]);
      expect(seqsSent(server)).toEqual([e1Seq]);
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 1,
        connected_at_ms: T0 + MINUTE,
        updated_at_ms: T0 + MINUTE,
        cursor: e1Seq,
        host_index: 0,
      });
      expect(hintUris(i.db)).toEqual([`at://${ALICE}/${S}/r1`]);
      expect(socketStatus(m).open).not.toBeNull();
      expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 2 * MINUTE);
      closeSocket(m, clock.nowMs());
    });
  });

  it('connect, messages, close and host rotation drive indexing(): lagSeconds null until the first event, exact while flowing, null after a quiet reconnect drops, stale exactly 5 min after the drop', async () => {
    const clock = fixedClock();
    const server = jetstreamServer({ clock, hosts: [EAST, WEST] });
    await runInDurableObject(stubFor('socket-lag'), async (i: HarnessDO, state) => {
      const m = ingestDeps(i.db, clock, { mode: 'socket', hosts: [EAST, WEST] });
      expect(await connect(m, server.connect, T0)).toMatchObject({ ok: true, hostIndex: 0, gap: 'no_cursor' });
      expect(status(i.db, T0)).toEqual({ state: 'recovering', caughtUp: false, lastIndexedAt: null, lagSeconds: null });
      // The first-start gap recovery finished (W4-01's bookkeeping write). The
      // resume point is the live tail the gap connect stored, so the index is
      // current, but no event of this connection is known: no lag.
      updateCheckpointBookkeeping(i.db, { pendingGap: false });
      expect(checkpointRow(i.db)).toMatchObject({ cursor: T0 * 1000, last_event_time_us: null });
      expect(status(i.db, T0)).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: null });

      // Events flow on us-east: lag is now minus the newest event time, in whole seconds.
      clock.set(new Date(T0 + 10 * SECOND).toISOString());
      server.at(EAST).append(commit('r1', (T0 + 7 * SECOND) * 1000));
      await flush();
      expect(status(i.db, clock.nowMs())).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: 3,
      });
      clock.advance(2_500);
      expect(status(i.db, clock.nowMs()).lagSeconds).toBe(5);
      const e2 = server.at(EAST).append(commit('r2', (T0 + 12 * SECOND) * 1000));
      await flush();
      expect(status(i.db, clock.nowMs()).lagSeconds).toBe(0);

      // The server closes: disconnected (not yet stale), the host rotates to us-west,
      // and the closed connection keeps its last event.
      const drop1 = clock.nowMs();
      server.last().close(1001, 'going away');
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({ connected: 0, updated_at_ms: drop1, host_index: 1, cursor: e2.seq });
      expect(status(i.db, drop1)).toEqual({ state: 'current', caughtUp: false, lastIndexedAt: null, lagSeconds: 0 });

      // The reconnect after 1 s goes to us-west and is quiet: no event of this connection yet.
      clock.set(new Date(drop1 + SECOND).toISOString());
      await step(state.storage, m, server);
      expect(server.attempts.at(-1)).toMatchObject({ host: WEST, cursor: e2.seq, status: 101 });
      expect(seqsSent(server)).toEqual([]);
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 1,
        connected_at_ms: drop1 + SECOND,
        last_event_time_us: null,
        cursor: e2.seq,
        host_index: 1,
      });
      expect(status(i.db, clock.nowMs())).toEqual({
        state: 'current',
        caughtUp: true,
        lastIndexedAt: null,
        lagSeconds: null,
      });

      // It drops before its first event: lag stays null (no fallback to the older
      // connection's event) and the host rotates back to us-east.
      clock.advance(30 * SECOND);
      const drop2 = clock.nowMs();
      server.last().error('fixture socket error');
      await flush();
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 0,
        updated_at_ms: drop2,
        host_index: 0,
        last_event_time_us: null,
      });
      expect(status(i.db, drop2)).toEqual({ state: 'current', caughtUp: false, lastIndexedAt: null, lagSeconds: null });

      // Every reconnect is refused: failed connects write no connection evidence,
      // so the disconnect instant stays drop2 while the hosts keep rotating.
      server.at(EAST).faults.add({}, { kind: 'status', status: 503 }, Number.POSITIVE_INFINITY);
      server.at(WEST).faults.add({}, { kind: 'status', status: 503 }, Number.POSITIVE_INFINITY);
      const attemptsBefore = server.attempts.length;
      for (let due = dueAt(i.db, 'jetstream-watchdog')!; due <= drop2 + 5 * MINUTE; ) {
        clock.set(new Date(due).toISOString());
        await step(state.storage, m, server);
        expect(server.attempts.at(-1)!.status).toBe(503);
        expect(checkpointRow(i.db)).toMatchObject({
          connected: 0,
          updated_at_ms: drop2,
          connected_at_ms: drop1 + SECOND,
        });
        due = dueAt(i.db, 'jetstream-watchdog')!;
      }
      const refused = server.attempts.slice(attemptsBefore);
      expect(refused.length).toBeGreaterThanOrEqual(5);
      expect(refused.map((a) => a.host)).toEqual(refused.map((_, n) => (n % 2 === 0 ? EAST : WEST)));

      // Stale exactly 5 min after the drop: not at 5 min, at 5 min + 1 ms.
      expect(status(i.db, drop2 + 5 * MINUTE)).toEqual({
        state: 'current',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: null,
      });
      expect(status(i.db, drop2 + 5 * MINUTE + 1)).toEqual({
        state: 'stale',
        caughtUp: false,
        lastIndexedAt: null,
        lagSeconds: null,
      });
    });
  });
});
