// The reserved Audioscrobbler 1.2 / 1.2.1 path (ADR 0005 §7.10, §18 Q9; N3-04).
//
// Protocol 1.2 is not supported: its handshake token is md5(md5(password) + t),
// so the server would have to hold a password-equivalent per user. Instead:
// - every GET or POST under `/audioscrobbler/` answers 200 `text/plain` with
//   the one line `FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or
//   ListenBrainz API` (1.2 clients read the body, not the status; a
//   submission or now-playing POST gets the same line, so a client that kept
//   a session id from elsewhere stops there too);
// - so does a handshake sent to the root, `GET /?hs=true` (node/dispatch.ts
//   hands exactly that request to the router, N2-01). Any other request that
//   reaches the root route is the JSON 404 envelope.
// Nothing is parsed, stored or logged beyond the dispatcher's request line
// (which never carries the query, where the 1.2 auth token travels). A POST
// body is discarded unread.

import { errorResponse } from '../http/error';
import type { RouteDef } from '../http/types';

export const AS12_FAILED_LINE = 'FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API';

/** The exact body: the line plus the protocol's LF terminator. */
export const AS12_FAILED_BODY = `${AS12_FAILED_LINE}\n`;

function failed(): Response {
  return new Response(AS12_FAILED_BODY, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const reserved: RouteDef['handler'] = async (req) => {
  await req.body?.cancel().catch(() => undefined);
  return failed();
};

const root: RouteDef['handler'] = async (req, ctx) => {
  if (new URL(req.url).searchParams.get('hs') === 'true') return failed();
  return errorResponse('not_found', undefined, ctx.requestId);
};

/** The 1.2 routes: the reserved path and the root handshake. */
export const routes: RouteDef[] = [
  { method: 'GET', pattern: '/', handler: root },
  { method: 'GET', pattern: '/audioscrobbler/', handler: reserved },
  { method: 'POST', pattern: '/audioscrobbler/', handler: reserved },
  { method: 'GET', pattern: '/audioscrobbler/{path}', handler: reserved },
  { method: 'POST', pattern: '/audioscrobbler/{path}', handler: reserved },
];
