import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import type { ExtensionContext } from '../../../src/app/host';
import { FORWARD_KICK_DEBOUNCE_MS, kickForwardDebounced } from '../../../src/forward/forward-kick';

/** A fake extension context whose `forward` timer keeps the earlier due time unless forced, like timers.ts. */
function timers() {
  const clock = fixedClock();
  const scheduled: Array<[string, number]> = [];
  let due: number | null = null;
  const context = {
    deps: { clock },
    schedule: (name: string, dueAtMs: number, options?: { force?: boolean }) => {
      scheduled.push([name, dueAtMs]);
      due = options?.force === true || due === null ? dueAtMs : Math.min(due, dueAtMs);
      return due;
    },
  } as unknown as ExtensionContext;
  /** A forwarding pass consuming the timer and rescheduling itself (forced), e.g. at its idle poll. */
  const pass = (nextDueMs: number) => {
    due = nextDueMs;
  };
  return { clock, scheduled, context, due: () => due, pass };
}

it('spaces now-playing forward kicks at least FORWARD_KICK_DEBOUNCE_MS apart without drifting a burst outward', () => {
  const { clock, scheduled, context } = timers();
  const t0 = clock.nowMs();

  expect(kickForwardDebounced(context)).toBe(t0);
  clock.advance(200);
  // Inside the interval: due at its end, not now.
  expect(kickForwardDebounced(context)).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
  // A burst while that kick is pending re-asserts the same due time, never a later one.
  for (let i = 0; i < 50; i++) {
    clock.advance(10);
    expect(kickForwardDebounced(context)).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
  }
  clock.set(new Date(t0 + 1_500).toISOString());
  expect(kickForwardDebounced(context)).toBe(t0 + 2 * FORWARD_KICK_DEBOUNCE_MS);
  clock.set(new Date(t0 + 5_000).toISOString());
  expect(kickForwardDebounced(context)).toBe(t0 + 5_000);

  expect(scheduled).toEqual([
    ['forward', t0],
    ...Array(51).fill(['forward', t0 + FORWARD_KICK_DEBOUNCE_MS]),
    ['forward', t0 + 2 * FORWARD_KICK_DEBOUNCE_MS],
    ['forward', t0 + 5_000],
  ]);
});

it('a kick inside the interval restores the pending due time after a pass rescheduled the timer later', () => {
  const { clock, context, due, pass } = timers();
  const t0 = clock.nowMs();
  kickForwardDebounced(context);
  pass(t0 + 10_000);
  clock.advance(100);
  kickForwardDebounced(context);
  expect(due()).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
  // A pass at 200 ms consumes the timer and reschedules to its idle poll.
  clock.advance(100);
  pass(t0 + 10_200);
  // A now-playing update at 300 ms must not wait for that poll.
  clock.advance(100);
  expect(kickForwardDebounced(context)).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
  expect(due()).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
});

it('keeps separate debounce state per core', () => {
  const a = timers();
  const b = timers();
  expect(kickForwardDebounced(a.context)).toBe(a.clock.nowMs());
  expect(kickForwardDebounced(b.context)).toBe(b.clock.nowMs());
  expect(a.scheduled).toHaveLength(1);
  expect(b.scheduled).toHaveLength(1);
});
