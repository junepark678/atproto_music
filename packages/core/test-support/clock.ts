import type { Clock } from '../src/deps';

/** The frozen test instant from docs/planning/TESTING.md. */
export const FIXTURE_NOW_ISO = '2026-01-15T12:00:00Z';

export type FixedClock = Clock & {
  set(iso: string): void;
  advance(ms: number): void;
};

function parseIso(iso: string): number {
  // Only full RFC 3339 UTC instants: a bare date or a local time is ambiguous.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(iso)) {
    throw new RangeError(`fixedClock needs a UTC RFC 3339 instant with ms precision at most, got ${iso}`);
  }
  const ms = Date.parse(iso);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0, 19) !== iso.slice(0, 19)) {
    throw new RangeError(`fixedClock got an invalid calendar instant: ${iso}`);
  }
  return ms;
}

/**
 * A clock that never moves on its own. Time changes only through `set` and
 * `advance`, so nothing in a test ever sleeps.
 */
export function fixedClock(iso = FIXTURE_NOW_ISO): FixedClock {
  let now = parseIso(iso);
  return {
    nowMs: () => now,
    set(next: string) {
      now = parseIso(next);
    },
    advance(ms: number) {
      if (!Number.isSafeInteger(ms)) {
        throw new RangeError(`fixedClock.advance needs an integer number of ms, got ${ms}`);
      }
      const next = now + ms;
      if (!Number.isSafeInteger(next)) {
        throw new RangeError('fixedClock.advance left the safe integer range');
      }
      now = next;
    },
  };
}
