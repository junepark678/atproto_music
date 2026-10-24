// Query and body admission (API.md "Shared shapes", ADR 0004 §5.8 step 1, N1).
//
// Semantics follow crates/server/src/http/{pagination,stats,feed}.rs:
// - a parameter given twice is 422 naming it ("Parameter must occur only once.");
// - `limit` must be ASCII digits only and within 1..=max: 0, negative,
//   non-integer, empty and above-max values are 422 `fields.limit`, never clamped;
// - `window` is all|7d|30d|365d (default all), `scope` is global|following
//   (default global), anything else 422 naming the field.
// Failures are thrown as ApiError; worker/src/http/error.ts toErrorResponse
// turns them into the envelope.

import { type FeedScope, STATS_WINDOWS, type StatsWindow } from '@atmusic/core/api-types';
import { ApiError } from '@atmusic/core/errors';

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 100;
export const STATS_LIMIT_DEFAULT = 10;
export const STATS_LIMIT_MAX = 100;

export const DUPLICATE_PARAMETER = 'Parameter must occur only once.';

/** 422 `validation_failed` naming one field. */
export function invalidField(field: string, reason: string): ApiError {
  return new ApiError('validation_failed', `query field ${field} is invalid`, { [field]: reason });
}

/** The single value of `name`, or undefined when absent; 422 when it occurs more than once. */
export function singleParam(q: URLSearchParams, name: string): string | undefined {
  const values = q.getAll(name);
  if (values.length > 1) throw invalidField(name, DUPLICATE_PARAMETER);
  return values[0];
}

/** `parseLimit(q, def, max)`: the `limit` query parameter, default `def`, 1..=max, no clamping. */
export function parseLimit(q: URLSearchParams, def: number, max: number): number {
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(def) || def < 1 || def > max) {
    throw new RangeError(`parseLimit needs 1 <= def <= max, got def=${def} max=${max}`);
  }
  const raw = singleParam(q, 'limit');
  if (raw === undefined) return def;
  const reason = `Expected an integer between 1 and ${max}.`;
  if (!/^[0-9]+$/.test(raw)) throw invalidField('limit', reason);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw invalidField('limit', reason);
  return value;
}

/** `parseWindow(q)`: the statistics window, default `all`. */
export function parseWindow(q: URLSearchParams): StatsWindow {
  const raw = singleParam(q, 'window');
  if (raw === undefined) return 'all';
  const window = STATS_WINDOWS.find((w) => w === raw);
  if (window === undefined) throw invalidField('window', 'Expected all, 7d, 30d or 365d.');
  return window;
}

/** `parseScope(q)`: the feed scope, default `global`. */
export function parseScope(q: URLSearchParams): FeedScope {
  const raw = singleParam(q, 'scope');
  if (raw === undefined) return 'global';
  if (raw === 'global' || raw === 'following') return raw;
  throw invalidField('scope', 'Expected global or following.');
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError('payload_too_large', `request body exceeds ${maxBytes} bytes`);
}

function invalidJson(): ApiError {
  return new ApiError('invalid_json', 'request body is not strict JSON');
}

/**
 * Reads at most `maxBytes` of the body without buffering more than that:
 * 413 when the declared Content-Length or the streamed body exceeds the cap
 * (the stream is cancelled at the first byte over it), 400 `invalid_json` for
 * an empty body, invalid UTF-8, a byte-order mark or anything JSON.parse
 * refuses.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`readJsonBody needs a positive byte cap, got ${maxBytes}`);
  }
  const declared = req.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    if (req.body !== null) await req.body.cancel().catch(() => undefined);
    throw tooLarge(maxBytes);
  }

  const buffer = new Uint8Array(maxBytes);
  let length = 0;
  if (req.body !== null) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  }
  if (length === 0) throw invalidJson();

  let text: string;
  try {
    // ignoreBOM keeps a leading U+FEFF in the text, so JSON.parse rejects it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } catch {
    throw invalidJson();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJson();
  }
}
