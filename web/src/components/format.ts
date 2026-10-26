// Text formatting shared by the screens. Every time is shown in UTC, the
// zone the API and the statistics windows use, so a reader never has to
// guess the interpretation.

import { ApiDecodeError, ApiError, ApiNetworkError } from '../api/client';

/** `2026-01-15T11:00:00Z` → `2026-01-15 11:00 UTC` (the raw value when it does not parse). */
export function formatUtc(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp;
  const iso = new Date(ms).toISOString();
  const seconds = iso.slice(17, 19);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}${seconds === '00' ? '' : `:${seconds}`} UTC`;
}

/** Epoch ms → the same UTC form. */
export function formatUtcMs(ms: number): string {
  return formatUtc(new Date(ms).toISOString());
}

/** `n scrobble(s)`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A user-safe sentence for a failed API call. Server text is never echoed. */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const ref = ` (${error.code}, request ${error.requestId})`;
    if (error.status === 429) {
      const wait =
        error.retryAfterSeconds !== null ? ` Try again in ${plural(error.retryAfterSeconds, 'second')}.` : '';
      return `Too many requests.${wait}${ref}`;
    }
    if (error.status === 503) return `The service is temporarily unavailable. Try again shortly.${ref}`;
    if (error.status >= 500) return `The server could not answer.${ref}`;
    if (error.status === 404) return `Nothing was found here.${ref}`;
    return `The request was refused.${ref}`;
  }
  if (error instanceof ApiNetworkError) return 'The server could not be reached. Check your connection.';
  if (error instanceof ApiDecodeError) return 'The server sent a response this app does not understand.';
  return 'Something went wrong.';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
