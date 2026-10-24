// JSON success responses and their Cache-Control values.
//
// Copied from crates/server/src/http: the profile, resolve and export handlers
// set `Cache-Control: no-store` themselves (and records/status replaces the
// dropped operations route, which did too), and the Rust request-id
// middleware stamps `no-store` on every other /api/v1/* response as well. So
// no API response is cacheable: `json()` defaults to `no-store`, and the four
// routes the contract names (API.md, ADR 0004 §5.8, N2, N3) cannot be given
// anything else.

/** `Cache-Control` value of every JSON response unless a route documents otherwise. */
export const NO_STORE = 'no-store';

/** Routes whose `no-store` is part of the contract (API.md, ADR 0004 §5.8, §9.4). */
export const NO_STORE_ROUTES: readonly string[] = [
  '/api/v1/users/{did}/profile',
  '/api/v1/resolve',
  '/api/v1/users/{did}/export',
  '/api/v1/records/status',
];

/**
 * `json(body, status, headers)`: a JSON response. `Content-Type` is
 * `application/json`; `Cache-Control` is `no-store` unless `headers` sets one.
 */
export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`json() needs an HTTP status from 200 to 599, got ${status}`);
  }
  const text = JSON.stringify(body);
  if (text === undefined) throw new TypeError('json() body is not JSON-serialisable');
  const out = new Headers(headers);
  out.set('content-type', 'application/json');
  if (!out.has('cache-control')) out.set('cache-control', NO_STORE);
  return new Response(text, { status, headers: out });
}

/** A `json()` response for one of NO_STORE_ROUTES: `no-store` is forced, whatever `headers` say. */
export function noStoreJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set('cache-control', NO_STORE);
  return json(body, status, out);
}
