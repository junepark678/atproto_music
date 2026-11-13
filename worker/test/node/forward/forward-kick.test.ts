import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import type { ExtensionContext } from '../../../src/app/host';
import { FORWARD_KICK_DEBOUNCE_MS, kickForwardDebounced } from '../../../src/forward/forward-kick';

function timers() {
  const clock = fixedClock();
  const scheduled: Array<[string, number]> = [];
  const context = {
    deps: { clock },
    schedule: (name: string, dueAtMs: number) => {
      scheduled.push([name, dueAtMs]);
      return dueAtMs;
    },
  } as unknown as ExtensionContext;
  return { clock, scheduled, context };
}

it('spaces now-playing forward kicks at least FORWARD_KICK_DEBOUNCE_MS apart without drifting a burst outward', () => {
  const { clock, scheduled, context } = timers();
  const t0 = clock.nowMs();

  expect(kickForwardDebounced(context)).toBe(t0);
  clock.advance(200);
  // Inside the interval: due at its end, not now.
  expect(kickForwardDebounced(context)).toBe(t0 + FORWARD_KICK_DEBOUNCE_MS);
  // A burst while that kick is pending relies on it and schedules nothing new.
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
    ['forward', t0 + FORWARD_KICK_DEBOUNCE_MS],
    ['forward', t0 + 2 * FORWARD_KICK_DEBOUNCE_MS],
    ['forward', t0 + 5_000],
  ]);
});

it('keeps separate debounce state per core', () => {
  const a = timers();
  const b = timers();
  expect(kickForwardDebounced(a.context)).toBe(a.clock.nowMs());
  expect(kickForwardDebounced(b.context)).toBe(b.clock.nowMs());
  expect(a.scheduled).toHaveLength(1);
  expect(b.scheduled).toHaveLength(1);
});
