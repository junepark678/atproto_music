# Cursor pagination

History, feeds and follow lists are keyset traversals with authenticated, opaque cursors. The codec is [`packages/core/src/cursor.ts`](../packages/core/src/cursor.ts), a byte-compatible port of `crates/core/src/cursor.rs`: tokens produced by the Rust oracle decode, and tokens produced here are identical (`tests/goldens/cursors.json`).

## Order and pages

History (`GET /api/v1/users/{did}/scrobbles`) and feeds (`GET /api/v1/feed`) are ordered by the `listenedAt` instant descending, then by the full AT URI descending. Equal timestamps are separate listens, ordered by URI; timestamps compare at nanosecond precision (they are stored as fixed-width 30-character UTC strings, [storage.md](storage.md)). Follow lists order by the representative edge's `(createdAt, uri)` descending ([follows.md](follows.md)).

`limit` defaults to 20 and may change between requests within 1–100. Any other value is 422 with `error.fields.limit`; nothing is clamped. Clients pass `nextCursor` back unchanged and stop when it is `null`. On an unchanged dataset the pages together return every matching URI exactly once, in the order of the unpaginated query.

## Feeds and the `viewer` parameter

`GET /api/v1/feed?scope=global` (the default) lists every visible scrobble, the viewer's own included. `GET /api/v1/feed?scope=following&viewer=<did>` lists the scrobbles of the actors that `<did>` currently follows with a visible music-follow record (`<prefix>.follow`; Bluesky follows play no part). It does not include the viewer's own scrobbles.

The following feed needs no session (amendment A8, ADR §15 Q7): follow records are public, so `viewer` is public input naming whose follow graph to use, not authentication. The SPA passes the signed-in user's DID.

- `scope` is `global` or `following`; anything else, or a repeated parameter, is 422 `fields.scope`.
- `viewer` must be a DID for either scope (422 `fields.viewer` otherwise); it is required for `following` (422 `fields.viewer` when missing). For `global` it neither filters nor binds the cursor.
- An unknown viewer, or one who follows nobody visible, gets 200 with an empty page.
- The cursor binds the viewer: a following-feed cursor issued for one viewer is 400 `invalid_cursor` for another viewer or for the global feed, and a global cursor is rejected for any following feed.

Visibility applies inside the traversal: only active, unsuppressed actors with complete snapshots appear, and a follow edge counts only while its actor is active ([profiles.md](profiles.md)).

## What a cursor fixes, and what it does not

A cursor carries the initial upper `(timestamp, URI)` tuple, the last returned tuple, and the original `asOf`. Later pages include only current records at or below the upper tuple and strictly below the last tuple:

- a record that arrives above the upper tuple appears only on a fresh traversal;
- a record deleted before it was returned disappears from the ongoing traversal;
- an update that moves an unreturned record above the upper or last tuple can omit it, and an update that moves an already returned record below the last tuple can return that URI again.

This is a traversal over current records, not a snapshot: `asOf` stays fixed as response metadata and does not freeze record versions, deletions, account state or follow membership.

## Token format and verification

A version 1 token is `base64url(JSON).base64url(HMAC-SHA256)`, without padding. The authenticated JSON is `{"version":1,"binding":{"query","did","scope","viewer"},"upper":{"timestamp","uri"},"last":{…},"asOf"}`: it binds the query type (`history`, `feed`, `following`, `followers`), the requested DID or the feed scope, the viewer of a following feed, both tuples and `asOf`. The payload is authenticated, not encrypted.

The HMAC key is `HMAC-SHA256(CURSOR_KEY, "atmusic:cursor:hmac-sha256:v1")`, imported once per Worker isolate as a non-extractable WebCrypto key. `CURSOR_KEY` is the Worker secret (at least 32 bytes, hex; [deployment.md](deployment.md)); it is never serialised or logged. Keeping it lets cursors survive deploys and DO restarts; rotating it invalidates every outstanding cursor and nothing else.

The decoder checks sizes and strict base64url, then verifies the HMAC in constant time (`crypto.subtle.verify`) before it reads any JSON, then checks version 1, the exact binding and the tuples. Tampering, malformed base64, an unsupported version, or another query, DID, scope or viewer all give HTTP 400 `invalid_cursor`. A rejected cursor never silently starts a fresh traversal.

## Tests

Run with `npm test` (workerd, deterministic, no network):

- `packages/core/test/cursor.test.ts`: the codec, key derivation, the 32-byte key floor, the Rust golden tokens;
- `worker/test/read/history.test.ts`, `worker/test/read/feed.test.ts`, `worker/test/read/cursor-http.test.ts`: pagination over the shared fixture through the real ingestion path (signed commits verified before they are applied), page unions, arrivals above the anchor, deletions during a traversal, the documented reorder behaviour, and every `invalid_cursor` case (one-bit tamper, wrong DID, scope or viewer, wrong version, bad base64).
