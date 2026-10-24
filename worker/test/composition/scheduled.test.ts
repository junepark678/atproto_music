// W5-01 worker/src/scheduled.ts: the `*/5` cron through the production
// Worker `scheduled` handler and the real IndexDO (ADR 0004 §5.9: cron calls
// ensureRunning(), which re-arms the alarm; §5.5: in pulse mode it starts a
// pulse).

import { createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { dueAt, nextDue } from '../../src/do/timers';
import { flush, jetstreamServer } from '../fixtures/jetstream-server';
import { armed, control, harness, inDo, kitControl, resetControl, runAlarm } from './support';

const T0 = Date.parse('2026-01-15T12:00:00Z');
const cron = () => createScheduledController({ scheduledTime: new Date(T0), cron: '*/5 * * * *' });

describe('worker/src/scheduled.ts', () => {
  beforeEach(() => {
    resetControl();
  });

  it('cron re-arms a deleted alarm', async () => {
    const h = harness('cron');
    // A first alarm runs every due timer, so the index is in its steady state.
    expect((await h.request('/health/ready')).status).toBe(200);
    expect(await runAlarm(h.stub)).toBe(true);
    const steady = await inDo(h.stub, async (_i, db, state) => ({
      next: nextDue(db),
      alarm: await state.storage.getAlarm(),
      timers: db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM timers ORDER BY name'),
    }));
    expect(steady.alarm).not.toBeNull();
    expect(steady.timers).toEqual([
      { name: 'discovery', due_at: T0 + 86_400_000 },
      { name: 'gc', due_at: T0 + 86_400_000 },
      { name: 'identity-sweep', due_at: T0 + 86_400_000 },
      { name: 'status-sweep', due_at: T0 + 3_600_000 },
    ]);
    expect(steady.next).toBe(T0 + 3_600_000);

    // The alarm is lost (and so is a timer row): nothing would ever run again.
    control.clock.advance(60_000);
    await inDo(h.stub, async (_i, db, state) => {
      await state.storage.deleteAlarm();
      db.run("DELETE FROM timers WHERE name = 'gc'");
    });
    expect(await inDo(h.stub, (_i, _db, state) => state.storage.getAlarm())).toBeNull();
    expect(await runAlarm(h.stub)).toBe(false);

    await h.worker.scheduled(cron(), h.env, {} as ExecutionContext);

    const rearmed = await inDo(h.stub, async (_i, db, state) => ({
      alarm: await state.storage.getAlarm(),
      next: nextDue(db),
      gc: dueAt(db, 'gc'),
    }));
    expect(rearmed.alarm).not.toBeNull();
    // The missing periodic timer is back (due now) and the alarm points at min(due_at).
    expect(rearmed.gc).toBe(T0 + 60_000);
    expect(rearmed.next).toBe(T0 + 60_000);
    expect(armed(h.stub).at(-1)).toBe(T0 + 60_000);
    // And the re-armed alarm runs.
    expect(await runAlarm(h.stub)).toBe(true);
    expect(await inDo(h.stub, (instance) => instance.lastAlarm?.ran)).toEqual(['gc']);

    // A second tick changes nothing that is already scheduled.
    const before = await inDo(h.stub, (_i, db) => db.all('SELECT name, due_at FROM timers ORDER BY name'));
    await h.worker.scheduled(cron(), h.env, {} as ExecutionContext);
    expect(await inDo(h.stub, (_i, db) => db.all('SELECT name, due_at FROM timers ORDER BY name'))).toEqual(before);
  });

  it('in pulse mode each cron tick makes a pulse due now, and the alarm runs it', async () => {
    const kit = await kitControl({ env: { INGEST_MODE: 'pulse' } });
    const js = jetstreamServer({ clock: kit.clock, fakes: [kit.jetstream] });
    control.connectJetstream = js.connect;
    const h = harness('cron-pulse');
    expect((await h.request('/health/ready')).status).toBe(200);

    // The start-up pulse: it drains until the live tail or 20 s; this stream is silent,
    // so the server closing the connection is what ends it (no real time passes).
    const first = runAlarm(h.stub);
    await flush();
    await inDo(h.stub, () => js.last().close(1000, 'done'));
    expect(await first).toBe(true);
    expect(js.attempts).toHaveLength(1);
    const nextPulse = await inDo(h.stub, (_i, db) => dueAt(db, 'jetstream-watchdog'));
    expect(nextPulse).toBe(T0 + 5 * 60_000);

    control.clock.advance(60_000);
    await h.worker.scheduled(cron(), h.env, {} as ExecutionContext);
    expect(await inDo(h.stub, (_i, db) => dueAt(db, 'jetstream-watchdog'))).toBe(T0 + 60_000);
    expect(armed(h.stub).at(-1)).toBe(T0 + 60_000);

    const second = runAlarm(h.stub);
    await flush();
    await inDo(h.stub, () => js.last().close(1000, 'done'));
    expect(await second).toBe(true);
    expect(js.attempts).toHaveLength(2);
    expect(js.attempts[1]?.status).toBe(101);
  });
});
