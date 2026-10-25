// The X-RateLimit-* header set of every /1/ answer (ADR 0005 §8.3, §8.7; N2-08).
//
// ListenBrainz (brainzutils `inject_x_rate_headers`) sends, on every rate-
// limited view:
//   X-RateLimit-Remaining   requests left in the window
//   X-RateLimit-Limit       requests per window
//   X-RateLimit-Reset       Unix seconds at which the window resets
//   X-RateLimit-Reset-In    seconds until then
//   Access-Control-Expose-Headers: X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In
// so browser clients can read them. The same set describes the daily listen
// cap's window on its 429 (§8.3).
//
// Our per-IP and per-token limits are token buckets (worker/src/http/limits.ts),
// not fixed windows. A bucket's "window reset" is the instant it is back at
// capacity, when Remaining equals Limit again. `bucketWindow` gives an upper
// bound of that from the decision alone: with `remaining` whole tokens left,
// at most (capacity - remaining) tokens refill at capacity/windowMs per ms. A
// client that waits Reset-In seconds is therefore always admitted.

import type { RateDecision, RateRule } from '../http/limits';

export const RATE_LIMIT_HEADER_NAMES = [
  'X-RateLimit-Remaining',
  'X-RateLimit-Limit',
  'X-RateLimit-Reset',
  'X-RateLimit-Reset-In',
] as const;

/** brainzutils' exact Access-Control-Expose-Headers value. */
export const RATE_LIMIT_EXPOSE_HEADERS = RATE_LIMIT_HEADER_NAMES.join(',');

/** One limit's state as the headers report it. */
export interface RateWindow {
  limit: number;
  remaining: number;
  /** Whole seconds until Remaining is back at Limit (0 when it already is). */
  resetInSeconds: number;
}

function checkCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/** The window a bucket reports after `decision` (module comment). */
export function bucketWindow(rule: Readonly<RateRule>, decision: RateDecision): RateWindow {
  const remaining = decision.allowed ? Math.min(rule.capacity, Math.max(0, decision.remaining)) : 0;
  const refillMs = Math.ceil(((rule.capacity - remaining) * rule.windowMs) / rule.capacity);
  let resetInSeconds = Math.ceil(refillMs / 1000);
  // A refused request is admitted again after retryAfterSeconds, never later than a full refill.
  if (!decision.allowed) resetInSeconds = Math.max(resetInSeconds, decision.retryAfterSeconds);
  return { limit: rule.capacity, remaining, resetInSeconds };
}

/** The header set for `window` at `nowMs`, as a plain record (header names as ListenBrainz spells them). */
export function rateLimitHeaders(window: RateWindow, nowMs: number): Record<string, string> {
  checkCount('limit', window.limit);
  checkCount('remaining', window.remaining);
  checkCount('resetInSeconds', window.resetInSeconds);
  const reset = Math.floor(nowMs / 1000) + window.resetInSeconds;
  return {
    'Access-Control-Expose-Headers': RATE_LIMIT_EXPOSE_HEADERS,
    'X-RateLimit-Remaining': String(window.remaining),
    'X-RateLimit-Limit': String(window.limit),
    'X-RateLimit-Reset': String(reset),
    'X-RateLimit-Reset-In': String(window.resetInSeconds),
  };
}

/** Sets the header set on `headers` (replacing earlier values) and returns it. */
export function applyRateLimitHeaders(headers: Headers, set: Readonly<Record<string, string>>): Headers {
  for (const [name, value] of Object.entries(set)) headers.set(name, value);
  return headers;
}
