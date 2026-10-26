// The in-process 5-minute ensureRunning interval that replaced the Workers
// `*/5` cron trigger (ADR 0005 §2.2, §3.3; W5-01's scheduled.test.ts, ported
// by N4-03). The production composition (support.ts) arms it through the
// NodeScheduler; the test fires the recorded interval the way the timer would
// and asserts what IndexCore.ensureRunning() restores: the periodic timer rows
// and the core lane's alarm at min(due_at), which then runs.
//
// The old second case (pulse mode, one pulse per cron tick) has no Node
// counterpart: parseNodeConfig admits INGEST_MODE socket and off only (B17);
// node-port-inventory.json records the replacement.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dueAt, nextDue } from '../../src/do/timers';
import { ENSURE_RUNNING_INTERVAL_MS, HEARTBEAT_INTERVAL_MS } from '../../src/node/alarm';
import { closeHarnesses, control, harness, resetControl, T0 } from './support';

describe('worker/src/node/alarm.ts ensureRunning interval', () => {
  beforeEach(() => {
    resetControl();
  });
  afterEach(closeHarnesses);

  it('the 5-minute ensureRunning interval re-arms a lost alarm chain', async () => {
    const h = await harness('interval');
    // The composition armed exactly one 5-minute interval (and the 30 s wake heartbeat).
    const intervals = h.timers.pending().filter((t) => t.kind === 'interval');
    expect(intervals.map((t) => t.delayMs).sort((a, b) => a - b)).toEqual([
      HEARTBEAT_INTERVAL_MS,
      ENSURE_RUNNING_INTERVAL_MS,
    ]);

    // A first alarm runs every due timer, so the index is in its steady state.
    expect((await h.request('/health/ready')).status).toBe(200);
    expect(await h.runAlarm()).toBe(true);
    const steady = {
      next: nextDue(h.db),
      alarm: h.coreAlarm(),
      timers: h.db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM timers ORDER BY name'),
    };
    expect(steady.timers).toEqual([
      { name: 'discovery', due_at: T0 + 86_400_000 },
      { name: 'gc', due_at: T0 + 86_400_000 },
      { name: 'identity-sweep', due_at: T0 + 86_400_000 },
      { name: 'status-sweep', due_at: T0 + 3_600_000 },
    ]);
    expect(steady.next).toBe(T0 + 3_600_000);
    expect(steady.alarm).toBe(T0 + 3_600_000);

    // The alarm chain is lost (and so is a timer row): nothing would ever run again.
    control.clock.advance(60_000);
    await h.core.host.alarm.deleteAlarm();
    h.db.run("DELETE FROM timers WHERE name = 'gc'");
    expect(h.coreAlarm()).toBeNull();
    expect(await h.runAlarm()).toBe(false);

    // One tick of the interval.
    expect(await h.fireInterval(ENSURE_RUNNING_INTERVAL_MS)).toBe(1);
    // The missing periodic timer is back (due now) and the alarm points at min(due_at).
    expect(dueAt(h.db, 'gc')).toBe(T0 + 60_000);
    expect(nextDue(h.db)).toBe(T0 + 60_000);
    expect(h.coreAlarm()).toBe(T0 + 60_000);
    // The heartbeat would also have fired it: it is overdue by the wall clock.
    expect(h.coreAlarm()).toBeLessThanOrEqual(control.clock.nowMs());
    // And the re-armed alarm runs exactly the restored timer.
    expect(await h.runAlarm()).toBe(true);
    expect(h.core.lastAlarm?.ran).toEqual(['gc']);
    expect(h.core.lastAlarm?.failed).toEqual([]);
    expect(dueAt(h.db, 'gc')).toBe(T0 + 60_000 + 86_400_000);
    expect(h.coreAlarm()).toBe(T0 + 3_600_000);

    // A second tick changes nothing that is already scheduled.
    const before = h.db.all('SELECT name, due_at FROM timers ORDER BY name');
    expect(await h.fireInterval(ENSURE_RUNNING_INTERVAL_MS)).toBe(1);
    expect(h.db.all('SELECT name, due_at FROM timers ORDER BY name')).toEqual(before);
    expect(h.coreAlarm()).toBe(T0 + 3_600_000);
    // No tick failed (the interval logs failures by name only).
    expect(h.log.logs.filter((l) => l.event === 'interval.ensure_running_failed')).toEqual([]);
  });
});
