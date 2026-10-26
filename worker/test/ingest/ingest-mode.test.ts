// W4-02 ingest-mode.ts: pulse and off modes against the production SQLite
// adapter (a temporary file, node-index.ts) and the fake Jetstream's sockets
// (test/fixtures/jetstream-server.ts). The 20 s pulse bound is an
// injected timer stepped by the test, and alarms are stepped with runDue after
// advancing the frozen clock; nothing sleeps. Expectations are hardcoded.

import type { Indexing } from '@atmusic/core/api-types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import type { IngestMode } from '../../src/config';
import type { Db } from '../../src/do/db';
import {
  type IngestDeps,
  jetstreamWatchdog,
  PULSE_DRAIN_MAX_MS,
  type PulseTimer,
  pulse,
} from '../../src/do/ingest/ingest-mode';
import { connect, socketStatus } from '../../src/do/ingest/jetstream-socket';
import { indexing, recordEvent, updateCheckpointBookkeeping } from '../../src/do/status';
import { type AlarmStorage, dueAt, runDue, TIMER_NAMES, type TimerHandlers } from '../../src/do/timers';
import {
  checkpointRow,
  flush,
  type IngestTestDeps,
  ingestDeps,
  type JetstreamServer,
  jetstreamServer,
} from '../fixtures/jetstream-server';
import { withIngestIndex } from './node-index';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-01-15T12:00:00Z');
const S = 'com.example.atmusic.scrobble';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REV = '3lbcdefghijkl';
const CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const EAST = 'jetstream.us-east.example.test';
const WEST = 'jetstream.us-west.example.test';

function commit(rkey: string, timeUs?: number) {
  return {
    kind: 'commit' as const,
    did: ALICE,
    commit: { rev: REV, operation: 'create' as const, collection: S, rkey, cid: CID },
    ...(timeUs === undefined ? {} : { timeUs }),
  };
}

const uri = (rkey: string) => `at://${ALICE}/${S}/${rkey}`;
const hintUris = (db: Db) => db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri').map((r) => r.uri);
const seqsSent = (server: JetstreamServer) => server.last().sent.map((t) => (JSON.parse(t) as { seq: number }).seq);
const status = (db: Db, nowMs: number, mode: IngestMode = 'pulse'): Indexing => indexing(db, nowMs, { mode });

/** A PulseTimer the test fires by hand (the 20 s drain bound). */
function manualTimer(): PulseTimer & { armed: Array<{ ms: number; cancelled: boolean }>; fire(): void } {
  const armed: Array<{ ms: number; cancelled: boolean; resolve: () => void }> = [];
  return {
    armed,
    after(ms) {
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const entry = { ms, cancelled: false, resolve };
      armed.push(entry);
      return {
        done,
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    fire() {
      for (const t of armed) if (!t.cancelled) t.resolve();
    },
  };
}

/** One alarm through the timer multiplexer, where only the watchdog does work. */
function step(storage: AlarmStorage, m: IngestTestDeps, d: IngestDeps) {
  const handlers = Object.fromEntries(TIMER_NAMES.map((n) => [n, async () => {}])) as unknown as TimerHandlers;
  handlers['jetstream-watchdog'] = async (now) => {
    await jetstreamWatchdog(m, d, now);
  };
  return runDue(storage, m.db, m.clock.nowMs(), handlers, { maxRuns: 10 }).then((report) => {
    expect(report.failed).toEqual([]);
    return report;
  });
}

it('pulse mode drains to tail then closes; off mode never connects', async () => {
  const clock = fixedClock();
  const server = jetstreamServer({ clock });
  await withIngestIndex(async (i) => {
    const m = ingestDeps(i.db, clock, { mode: 'pulse' });
    const timer = manualTimer();
    const d: IngestDeps = { connectJetstream: server.connect, pulseTimer: timer };

    // History published before the pulse, older than its connect time, and a
    // stored cursor at the first of it (gap recovery done).
    const old = [1, 2, 3].map((n) => server.append(commit(`r${n}`, (T0 - (10 - n) * MINUTE) * 1000)));
    i.db.tx(() => recordEvent(i.db, { cursor: old[0]!.seq, timeUs: old[0]!.timeUs }));
    updateCheckpointBookkeeping(i.db, { pendingGap: false });

    const running = jetstreamWatchdog(m, d, T0);
    await flush();
    // Connected from the cursor; the replay is older than the connect time, so the pulse drains on.
    expect(server.attempts.map((a) => [a.cursor, a.status])).toEqual([[old[0]!.seq, 101]]);
    expect(seqsSent(server)).toEqual(old.map((e) => e.seq));
    expect(server.last().closed).toBe(false);
    expect(timer.armed.map((t) => t.ms)).toEqual([PULSE_DRAIN_MAX_MS]);
    expect(checkpointRow(i.db)).toMatchObject({
      connected: 1,
      mode: 'pulse',
      connected_at_ms: T0,
      cursor: old[2]!.seq,
      last_event_time_us: old[2]!.timeUs,
    });
    // A pulse in progress is joined, never doubled.
    const joined = pulse(m, d, T0);

    // The first event at or after the connect time is the tail: the pulse closes.
    clock.advance(3 * SECOND);
    const live = server.append(commit('r4'));
    expect(live.timeUs).toBe((T0 + 3 * SECOND) * 1000);
    const report = await running;
    expect(report).toMatchObject({ mode: 'pulse', pulse: { started: true, endedBy: 'tail', messages: 4 } });
    expect(await joined).toMatchObject({ started: false, endedBy: 'tail' });
    await flush();
    expect(server.attempts.length).toBe(1);
    expect(server.last().closed).toBe(true);
    expect(server.last().closeCode).toBe(1000);
    expect(socketStatus(m).open).toBeNull();
    expect(timer.armed.map((t) => t.cancelled)).toEqual([true]);
    expect(checkpointRow(i.db)).toMatchObject({
      connected: 0,
      connected_at_ms: T0,
      updated_at_ms: T0 + 3 * SECOND,
      cursor: live.seq,
      last_event_time_us: live.timeUs,
      host_index: 0,
    });
    expect(hintUris(i.db)).toEqual([uri('r1'), uri('r2'), uri('r3'), uri('r4')]);
    expect(status(i.db, clock.nowMs())).toEqual({
      state: 'current',
      caughtUp: true,
      lastIndexedAt: null,
      lagSeconds: 0,
    });
    // The next pulse is durable, 5 min after this one started.
    expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 5 * MINUTE);

    // Between pulses nothing is received.
    server.append(commit('r5'));
    await flush();
    expect(hintUris(i.db)).not.toContain(uri('r5'));
    expect(checkpointRow(i.db)).toMatchObject({ cursor: live.seq });

    // The next alarm pulses from the stored (inclusive) cursor and catches r5 up.
    clock.set(new Date(T0 + 5 * MINUTE).toISOString());
    const next = step(i.storage, m, d);
    await flush();
    expect(server.attempts.at(-1)).toMatchObject({ cursor: live.seq, status: 101 });
    const tail = server.append(commit('r6'));
    await next;
    expect(hintUris(i.db)).toEqual([uri('r1'), uri('r2'), uri('r3'), uri('r4'), uri('r5'), uri('r6')]);
    expect(checkpointRow(i.db)).toMatchObject({ connected: 0, cursor: tail.seq, connected_at_ms: T0 + 5 * MINUTE });
    expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 10 * MINUTE);
  });

  // Off mode: no socket, ever.
  const offServer = jetstreamServer({ clock });
  await withIngestIndex(async (i) => {
    const m = ingestDeps(i.db, clock, { mode: 'off' });
    expect(m.config.ingestMode).toBe('off');
    const d: IngestDeps = { connectJetstream: offServer.connect, pulseTimer: manualTimer() };
    const before = checkpointRow(i.db);
    for (let n = 0; n < 3; n++) {
      expect(await jetstreamWatchdog(m, d, clock.nowMs())).toEqual({ mode: 'off', closed: false });
      clock.advance(5 * MINUTE);
    }
    expect(await connect(m, offServer.connect, clock.nowMs())).toEqual({ ok: false, reason: 'off' });
    expect(offServer.attempts).toEqual([]);
    expect(offServer.fakes[0]!.calls.count()).toBe(0);
    expect(checkpointRow(i.db)).toEqual({ ...before, mode: 'off' });
    // The watchdog is not rescheduled in off mode, so no alarm ever connects.
    expect(dueAt(i.db, 'jetstream-watchdog')).toBeNull();
    expect((await step(i.storage, m, d)).ran).toEqual([]);
    expect(status(i.db, clock.nowMs(), 'off').state).toBe('stale');

    // Switching to off closes a socket a previous mode opened, and marks it disconnected.
    const socketMode = { ...m, config: { ...m.config, ingestMode: 'socket' as const } };
    expect(await connect(socketMode, offServer.connect, clock.nowMs())).toMatchObject({ ok: true });
    expect(offServer.attempts.length).toBe(1);
    clock.advance(SECOND);
    expect(await jetstreamWatchdog(m, d, clock.nowMs())).toEqual({ mode: 'off', closed: true });
    await flush();
    expect(offServer.last().closed).toBe(true);
    expect(checkpointRow(i.db)).toMatchObject({ connected: 0, updated_at_ms: clock.nowMs(), mode: 'off' });
    expect(offServer.attempts.length).toBe(1);
  });
});

it('a pulse that receives no event leaves lagSeconds null and the last successful pulse more than two intervals ago reports stale', async () => {
  const clock = fixedClock();
  const server = jetstreamServer({ clock, hosts: [EAST, WEST] });
  await withIngestIndex(async (i) => {
    const m = ingestDeps(i.db, clock, { mode: 'pulse', hosts: [EAST, WEST] });
    const timer = manualTimer();
    const d: IngestDeps = { connectJetstream: server.connect, pulseTimer: timer };

    // Pulse 1 (first start, live tail) receives r1 at its connect time and ends at the tail.
    const p1 = pulse(m, d, T0);
    await flush();
    const r1 = server.at(EAST).append(commit('r1'));
    expect(await p1).toMatchObject({ endedBy: 'tail', messages: 1, connect: { ok: true, gap: 'no_cursor' } });
    updateCheckpointBookkeeping(i.db, { pendingGap: false }); // W4-01 finished the first-start recovery
    expect(status(i.db, T0)).toEqual({ state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 });

    // Pulse 2: us-east refuses (503). A failed connect writes no connection evidence; the host rotates.
    clock.set(new Date(T0 + 5 * MINUTE).toISOString());
    server.at(EAST).faults.add({}, { kind: 'status', status: 503 });
    const beforeFailed = checkpointRow(i.db);
    await step(i.storage, m, d);
    expect(server.attempts.at(-1)).toMatchObject({ host: EAST, status: 503 });
    expect(checkpointRow(i.db)).toEqual({ ...beforeFailed, host_index: 1 });
    expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 10 * MINUTE);

    // Pulse 3 on us-west from the stored cursor receives nothing and ends after 20 s.
    clock.set(new Date(T0 + 10 * MINUTE).toISOString());
    const running = step(i.storage, m, d);
    await flush();
    expect(server.attempts.at(-1)).toMatchObject({ host: WEST, cursor: r1.seq, status: 101 });
    expect(seqsSent(server)).toEqual([]);
    expect(checkpointRow(i.db)).toMatchObject({
      connected: 1,
      connected_at_ms: T0 + 10 * MINUTE,
      last_event_time_us: null,
    });
    // While it is open no event of this connection is known: lag null, not stale.
    expect(status(i.db, clock.nowMs())).toEqual({
      state: 'current',
      caughtUp: false,
      lastIndexedAt: null,
      lagSeconds: null,
    });
    clock.advance(PULSE_DRAIN_MAX_MS);
    timer.fire();
    await running;
    await flush();
    expect(server.last().closed).toBe(true);
    // A full quiet drain from a 10 min old cursor confirms the link healthy at its connect
    // instant: the resume point moves to 60 s before it (ADR §15 Q11).
    expect(checkpointRow(i.db)).toMatchObject({
      connected: 0,
      connected_at_ms: T0 + 10 * MINUTE,
      updated_at_ms: T0 + 10 * MINUTE + PULSE_DRAIN_MAX_MS,
      last_event_time_us: null,
      cursor: (T0 + 9 * MINUTE) * 1000,
    });
    expect(status(i.db, clock.nowMs())).toEqual({
      state: 'current',
      caughtUp: false,
      lastIndexedAt: null,
      lagSeconds: null,
    });

    // Pulses 4 and 5 are refused on both hosts and write nothing.
    server.at(EAST).faults.add({}, { kind: 'status', status: 503 }, Number.POSITIVE_INFINITY);
    server.at(WEST).faults.add({}, { kind: 'status', status: 503 }, Number.POSITIVE_INFINITY);
    const quiet = checkpointRow(i.db);
    for (const at of [T0 + 15 * MINUTE, T0 + 20 * MINUTE]) {
      clock.set(new Date(at).toISOString());
      await step(i.storage, m, d);
      expect(server.attempts.at(-1)!.status).toBe(503);
      expect(checkpointRow(i.db)).toMatchObject({
        connected: 0,
        connected_at_ms: quiet.connected_at_ms,
        updated_at_ms: quiet.updated_at_ms,
        last_event_time_us: null,
      });
    }
    // Pulse 3 ended normally on us-west (no rotation); each refusal then rotates.
    expect(server.attempts.slice(-2).map((a) => a.host)).toEqual([WEST, EAST]);

    // Two pulse intervals (10 min) after the last successful pulse started: not yet stale; 1 ms later, stale.
    expect(status(i.db, T0 + 20 * MINUTE)).toEqual({
      state: 'current',
      caughtUp: false,
      lastIndexedAt: null,
      lagSeconds: null,
    });
    expect(status(i.db, T0 + 20 * MINUTE + 1)).toEqual({
      state: 'stale',
      caughtUp: false,
      lastIndexedAt: null,
      lagSeconds: null,
    });
  });
});

it('quiet pulses longer than lookback do not trigger gap recovery; a quiet pulse after an outage confirms nothing; a real disconnect gap still does', async () => {
  const clock = fixedClock();
  // The fake keeps exactly our 24 h lookback: an aged cursor is refused upstream too.
  const server = jetstreamServer({ clock, lookbackHours: 24 });
  await withIngestIndex(async (i) => {
    const m = ingestDeps(i.db, clock, { mode: 'pulse' });
    const timer = manualTimer();
    const gapCalls: number[] = [];
    const d: IngestDeps = {
      connectJetstream: server.connect,
      pulseTimer: timer,
      scheduleGapRecovery: (_db, now) => {
        gapCalls.push(now);
      },
    };
    /** One alarm whose pulse drains its full 20 s. */
    const quietPulse = async (at: number) => {
      clock.set(new Date(at).toISOString());
      const running = step(i.storage, m, d);
      await flush();
      clock.advance(PULSE_DRAIN_MAX_MS);
      timer.fire();
      await running;
      await flush();
    };

    // First start: a gap by definition; r1 arrives at the connect time and ends the pulse at the tail.
    const p1 = pulse(m, d, T0);
    await flush();
    const r1 = server.append(commit('r1'));
    expect(await p1).toMatchObject({ endedBy: 'tail', connect: { ok: true, gap: 'no_cursor' } });
    updateCheckpointBookkeeping(i.db, { pendingGap: false });
    expect(gapCalls).toEqual([T0]);

    // 25 hours of pulses every 5 minutes over a stream with no new wanted event.
    const PULSES = 300;
    for (let n = 1; n <= PULSES; n++) {
      const at = T0 + n * 5 * MINUTE;
      await quietPulse(at);
      const attempt = server.attempts.at(-1)!;
      // Pulse 1 resumes from r1 (re-delivered, inclusive); each later one 60 s before the previous pulse.
      const expected = n === 1 ? r1.seq : (at - 6 * MINUTE) * 1000;
      expect([n, attempt.cursor, attempt.status]).toEqual([n, expected, 101]);
      expect([n, checkpointRow(i.db).cursor]).toEqual([n, (at - MINUTE) * 1000]);
    }
    const lastPulse = T0 + PULSES * 5 * MINUTE;
    expect(lastPulse - T0).toBe(25 * 60 * MINUTE);
    expect(gapCalls).toEqual([T0]);
    expect(server.attempts).toHaveLength(PULSES + 1);
    expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 0, connected: 0 });
    expect(hintUris(i.db)).toEqual([uri('r1')]);

    // An outage of 2 h (within the lookback): the next pulse resumes from the stored point
    // without a gap, but a 20 s drain proves nothing about a 2 h replay, so it confirms nothing.
    const afterOutage = lastPulse + 2 * 60 * MINUTE;
    const stored = (lastPulse - MINUTE) * 1000;
    await quietPulse(afterOutage);
    expect(server.attempts.at(-1)).toMatchObject({ cursor: stored, status: 101 });
    expect(checkpointRow(i.db)).toMatchObject({ cursor: stored, pending_gap: 0, connected: 0 });
    expect(gapCalls).toEqual([T0]);

    // A real disconnect longer than the lookback is still a gap: recovery, from the live tail.
    const back = afterOutage + 25 * 60 * MINUTE;
    await quietPulse(back);
    expect(server.attempts.at(-1)).toMatchObject({ cursor: null, status: 101 });
    expect(gapCalls).toEqual([T0, back]);
    expect(checkpointRow(i.db)).toMatchObject({ pending_gap: 1, cursor: back * 1000 });
    expect(status(i.db, back + PULSE_DRAIN_MAX_MS)).toMatchObject({ state: 'recovering' });
  });
  // 302 sequential pulses through the fake sockets: about 4.5 s alone, past the 5 s default
  // under full-suite parallel load (the clock is injected, so only wall time grows).
}, 60_000);
