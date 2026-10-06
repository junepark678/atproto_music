# Cursor pagination

History is ordered by the `listenedAt` instant descending, then the full AT URI
descending. Equal timestamps represent separate listens; URI ordering determines
their order. Timestamp comparison retains nanosecond precision. SQLite stores
ordering timestamps as fixed-width UTC RFC3339 strings with nine fractional digits.

`GET /api/v1/feed` uses the same ordering and pagination. Its default scope is
`global`, which includes all active confirmed music records, including the
viewer's own records. Scope `following` requires an application session and
includes actors with a current active confirmed custom music-follow edge from
that viewer. It does not implicitly include the viewer or use Bluesky follows.
An anonymous following request returns HTTP 401. Invalid scopes return HTTP 422
with `error.fields.scope`.

Clients pass `nextCursor` back unchanged and stop when it is `null`. An unchanged
dataset produces every matching URI once, in the same order as an unpaginated
query. Page size defaults to 20 and may be changed between requests within 1–100.
Invalid limits produce HTTP 422 with `error.fields.limit`.

A cursor retains the initial upper `(timestamp, URI)` tuple, the last returned
tuple, and the original `asOf`. Later pages include only current records at or
below the initial upper tuple and strictly below the last tuple. A newer arrival
above the initial upper tuple appears on a fresh traversal. A record deleted
before it is returned disappears from the ongoing traversal.

This is a traversal over current records, with no historical snapshot isolation.
An update that moves an unreturned record above the upper or last tuple can omit
it. An update that moves an already returned record below the last tuple can
return that URI again. `asOf` stays fixed as response metadata and does not freeze
record versions, deletion state, account state, or follow membership.

The version 1 token uses `base64url(JSON).base64url(HMAC-SHA256)`, without padding.
The authenticated JSON binds the query type, requested DID or feed scope, the
viewer for a private following feed, both tuple boundaries, and `asOf`. The
signing key is separately derived from the configured application key using
HMAC-SHA256 with the context `atmusic:cursor:hmac-sha256:v1`. Neither key nor any
session/token secret is serialized. The payload is authenticated, not encrypted.
Retaining the application key allows valid cursors to continue after a restart;
changing it invalidates existing cursors.

The decoder checks the HMAC before interpreting the JSON and uses constant-time
signature verification. Tampering, malformed base64, unsupported versions, or a
different query/DID/scope/viewer produce HTTP 400 `invalid_cursor`. A failed cursor
never silently starts a fresh traversal.

The deterministic codec suite is `cargo test --locked -p atmusic-core --test
cursor -- --nocapture`. HTTP and SQLite pagination regressions are in
`cargo test --locked -p atmusic-server --test history_cursor -- --nocapture`.
Feed regression tests are in `cargo test --locked -p atmusic-server --test
feed_cursor -- --nocapture`.
The HTTP fixtures generate signed repositories with deterministic test keys and
revisions. Before each seed or mutation is applied to SQLite, the production
verifier checks the commit signature, CID hashes, signed MST membership and record
schema. Successor fixtures cover create, update, delete and music-follow removal.
These deterministic tests cover pagination and current-state filtering; required
external-PDS/relay acceptance runs remain separate milestone evidence.
