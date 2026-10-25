// ListenBrainz-shaped responses for /1/ (ADR 0005 §8.1, §8.3, §8.7; N2-08).
//
// - Errors are `{"code": <status>, "error": "<message>"}` (ListenBrainz
//   `APIError.to_dict`), without the offending payload's keys that
//   ListenBrainz merges in (§8.3).
// - Every /1/ response carries Access-Control-Allow-Origin: *,
//   Access-Control-Allow-Headers: Authorization, Content-Type and
//   Access-Control-Max-Age: 21600 (§8.1, ListenBrainz `crossdomain`). OPTIONS
//   answers 200 with an empty body and that set; when the route's methods are
//   given they are sent as Allow and Access-Control-Allow-Methods, as
//   `crossdomain` does from Flask's default OPTIONS response.
// - The rate-limit 429 carries the verbatim brainzutils body and the
//   X-RateLimit-* set (rate-headers.ts), plus Retry-After.
// - Responses are `application/json` and `Cache-Control: no-store`
//   (worker/src/http/json.ts). Cookies are never read or set here.

import { json } from '../http/json';
import { applyRateLimitHeaders } from './rate-headers';

/** ADR 0005 §8.1. The Node bridge's over-cap answers send the same set. */
export const LB_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '21600',
} as const;

/** brainzutils `on_over_limit`. */
export const LB_RATE_LIMITED_MESSAGE =
  'You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit.';

/** Publication gate closed (§8.3): ListenBrainz's queue-unavailable text. */
export const LB_UNAVAILABLE_MESSAGE = 'Cannot submit listens to queue, please try again later.';

/** Sets the CORS set on `headers` and returns it. */
export function applyLbCors(headers: Headers): Headers {
  for (const [name, value] of Object.entries(LB_CORS_HEADERS)) headers.set(name, value);
  return headers;
}

/** A /1/ JSON response with the CORS set. */
export function lbJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  const out = applyLbCors(new Headers(headers));
  return json(body, status, out);
}

/** A ListenBrainz error: `{"code": status, "error": message}` with the CORS set. */
export function lbError(status: number, message: string, headers?: HeadersInit): Response {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`lbError needs an HTTP error status, got ${status}`);
  }
  return lbJson({ code: status, error: message }, status, headers);
}

/** The rate-limit 429: verbatim body, the X-RateLimit-* set and Retry-After. */
export function lbTooManyRequests(
  rateHeaders: Readonly<Record<string, string>>,
  retryAfterSeconds: number,
  message: string = LB_RATE_LIMITED_MESSAGE,
): Response {
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new RangeError(`retryAfterSeconds must be a positive integer, got ${retryAfterSeconds}`);
  }
  const headers = applyRateLimitHeaders(new Headers(), rateHeaders);
  headers.set('retry-after', String(retryAfterSeconds));
  return lbError(429, message, headers);
}

/** The OPTIONS answer: 200, empty body, the CORS set (and Allow / Access-Control-Allow-Methods when given). */
export function lbPreflight(methods?: readonly string[]): Response {
  const headers = applyLbCors(new Headers({ 'cache-control': 'no-store' }));
  if (methods !== undefined && methods.length > 0) {
    const allow = [...new Set([...methods.map((m) => m.toUpperCase()), 'OPTIONS'])].sort().join(', ');
    headers.set('allow', allow);
    headers.set('access-control-allow-methods', allow);
  }
  return new Response(null, { status: 200, headers });
}

/** Adds the CORS set to a response built elsewhere (a new Response; bodies are not copied twice). */
export function withLbCors(response: Response): Response {
  const headers = applyLbCors(new Headers(response.headers));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
