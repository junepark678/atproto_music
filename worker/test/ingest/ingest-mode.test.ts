// W4-02 ingest-mode.ts: pulse and off modes against real DO SQLite and real
// workerd WebSockets served by the fake Jetstream. The 20 s pulse bound is an
// injected timer stepped by the test, and alarms are stepped with runDue after
// advancing the frozen clock; nothing sleeps. Expectations are hardcoded.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
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
import { dueAt, runDue, TIMER_NAMES, type TimerHandlers } from '../../src/do/timers';
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
function step(storage: DurableObjectStorage, m: IngestTestDeps, d: IngestDeps) {
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
  await runInDurableObject(stubFor('mode-pulse-tail'), async (i: HarnessDO, state) => {
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
    const next = step(state.storage, m, d);
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
  await runInDurableObject(stubFor('mode-off'), async (i: HarnessDO, state) => {
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
    expect((await step(state.storage, m, d)).ran).toEqual([]);
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
  await runInDurableObject(stubFor('mode-pulse-quiet'), async (i: HarnessDO, state) => {
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
    await step(state.storage, m, d);
    expect(server.attempts.at(-1)).toMatchObject({ host: EAST, status: 503 });
    expect(checkpointRow(i.db)).toEqual({ ...beforeFailed, host_index: 1 });
    expect(dueAt(i.db, 'jetstream-watchdog')).toBe(T0 + 10 * MINUTE);

    // Pulse 3 on us-west from the stored cursor receives nothing and ends after 20 s.
    clock.set(new Date(T0 + 10 * MINUTE).toISOString());
    const running = step(state.storage, m, d);
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
    expect(checkpointRow(i.db)).toMatchObject({
      connected: 0,
      connected_at_ms: T0 + 10 * MINUTE,
      updated_at_ms: T0 + 10 * MINUTE + PULSE_DRAIN_MAX_MS,
      last_event_time_us: null,
      cursor: r1.seq,
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
      await step(state.storage, m, d);
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
