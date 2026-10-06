# Fixed API v1 payload contract

This is the fixed API contract encoded in `api/openapi.yaml`. The backend implements these routes with deterministic integration coverage. Owned-namespace production writes and backfills use exact current-head verification; production relay progress and full packaged/live acceptance remain unresolved. See [validation evidence](../VALIDATION.md) for actual checks and limitations. Changes require an explicit issue amendment.

## Shared shapes

All timestamps are UTC RFC3339 strings. IDs are strings. Absent optional record fields are omitted, not replaced with empty strings. Handles can be `null` when no current verified handle exists. Query validation failures are 422 with `error.fields`; malformed JSON and malformed cursors are 400.

```text
Error = {error: {code: string, message: string, requestId: UUID, fields?: {fieldName: string}}}
Indexing = {state: "current"|"recovering"|"stale"|"suppressed",
            caughtUp: boolean, lastIndexedAt: timestamp|null, lagSeconds: number|null}
Scrobble = {uri: AT_URI, cid: CID, did: DID, revision: string,
            artist: string, track: string, album?: string,
            listenedAt: timestamp, createdAt: timestamp,
            durationSeconds?: integer, recordingMbid?: UUID, indexedAt: timestamp}
Follow = {uri: AT_URI, cid: CID, actor: DID, subject: DID, createdAt: timestamp}
Page<T> = {items: T[], nextCursor: string|null, asOf: timestamp, indexing: Indexing}
Accepted = {operationId: string, state: "pending"}
Operation = {operationId: string, kind: "scrobble_create"|"scrobble_delete"|"follow_create"|"follow_delete",
             state: "pending"|"succeeded"|"failed", attempts: integer,
             createdAt: timestamp, updatedAt: timestamp,
             recordUri: AT_URI|null, failureCode: string|null}
```

Lists use default `limit=20`, maximum 100 and `cursor`. Statistics top lists use default `limit=10`, maximum 100, without cursor. `limit=0`, negative, noninteger or above maximum returns 422; do not silently clamp.

Missing/malformed session yields 401. Known private operation owned by another authenticated DID yields 403; absent operation yields 404. Cross-owner scrobble mutation yields 403; an authenticated URI owner can repeat a completed deletion with 204. Invalid Origin or CSRF yields 403 before any mutation or outbound write.

## Endpoints and outcomes

| Route | Request | Success payload / status |
| --- | --- | --- |
| GET `/health/live` | none | 200 `{status:"live"}` |
| GET `/health/ready` | none | 200 `{status:"ready"}` when storage/writer initialized; otherwise 503 Error |
| GET `/api/v1/meta` | none | 200 `{name:"atproto_music",version,stage:"scaffold"\|"backend"\|"product",capabilities:string[],lexiconPrefix:string\|null,indexing:Indexing}` |
| GET `/oauth/client-metadata.json` | none | 200 AT Protocol OAuth client metadata conforming to pinned spec; not an application JSON envelope |
| POST `/api/v1/auth/start` | `{handle:string}` and allowed Origin | 200 `{authorizationUrl:string}` |
| GET `/api/v1/auth/callback` | OAuth query parameters | 303 redirect to configured origin `/feed`, after session cookie issued; errors use Error with 400 or 401 according to cause |
| GET `/api/v1/auth/session` | session cookie | 200 `{did:DID,handle:string\|null,csrfToken:string,expiresAt:timestamp}` |
| POST `/api/v1/auth/logout` | cookie, CSRF, Origin; no body | 204, cleared cookie |
| GET `/api/v1/resolve` | `handle` | 200 `{did:DID,handle:string,verified:true}`; unresolved 404, mismatch 422 |
| POST `/api/v1/scrobbles` | local input below, session, CSRF, Origin, Idempotency-Key | 201 `{scrobble:Scrobble}` if confirmed, otherwise 202 Accepted |
| GET `/api/v1/scrobbles/{id}` | URL-encoded full AT URI | 200 `{scrobble:Scrobble}`; inactive/tombstoned/unconfirmed/absent record 404 |
| DELETE `/api/v1/scrobbles/{id}` | owner cookie, CSRF, Origin; no body | 202 Accepted until signed remote absence is verified, including locally unknown URI; 204 after verified absence or guaranteed cancellation before any create attempt; failed replay 502 Error with original operation Location |
| GET `/api/v1/operations/{id}` | owner cookie | 200 Operation, including safe terminal failure state |
| GET `/api/v1/users/{did}/scrobbles` | `limit`, `cursor` | 200 Page<Scrobble> |
| GET `/api/v1/feed` | `scope=global\|following`, `limit`, `cursor` | 200 Page<Scrobble>; following requires session |
| GET `/api/v1/users/{did}/profile` | DID | 200 Profile below; unknown/inactive 404 |
| GET `/api/v1/users/{did}/stats` | `window=all\|7d\|30d\|365d`, `limit` | 200 Statistics below; default window all |
| PUT `/api/v1/follows/{did}` | cookie, CSRF, Origin; no body | 201 `{follow:Follow}` if confirmed, 202 Accepted if pending, 200 `{follow:Follow}` if existing confirmed edge |
| DELETE `/api/v1/follows/{did}` | cookie, CSRF, Origin; no body | 202 Accepted while aggregate removal pending, 204 after confirmed removal or already absent edge; failed replay 502 Error with original operation Location |
| GET `/api/v1/users/{did}/following` | `limit`, `cursor` | 200 Page<Follow> |
| GET `/api/v1/users/{did}/followers` | `limit`, `cursor` | 200 Page<Follow> |
| GET `/api/v1/account/export` | owner cookie | 200 `{schemaVersion:1,did:DID,exportedAt:timestamp,indexing:Indexing,scrobbles:Scrobble[],follows:Follow[]}`, attachment `music-export.json` |
| DELETE `/api/v1/account/local-data` | cookie, CSRF, Origin; no body | 204 after local atomic disconnect; public PDS records retained |

Disconnect retains only the minimal DID suppression marker needed to prevent automatic reingestion; it does not claim erasure from the external PDS or other services. Export contains the owner's indexed public records and snapshot indexing metadata, with no credentials. See [account control limits](../account-controls.md).

`/api/v1/meta` includes the full frozen shape and advertises only initialized capabilities. Empty global indexing begins as recovering, not a fabricated current state. Unknown collection owner DIDs do not cause unbounded implicit network fetching.

Local scrobble POST accepts only `artist`, `track`, `listenedAt`, optional `album`, `durationSeconds`, `recordingMbid`. `$type`, `did`, `owner`, `createdAt`, `uri`, `cid` and any other fields are rejected with 422. The server derives owner from session, sets `createdAt`, and builds the AT Protocol record. The posted record must have `$type=<configuredPrefix>.scrobble`; clients do not choose that value through this API.

```text
Profile = {did:DID, handle:string|null, joinedAt:timestamp, indexedAt:timestamp|null,
           totalScrobbles:integer, followerCount:integer, followingCount:integer,
           indexing:Indexing}
Statistics = {did:DID, window:"all"|"7d"|"30d"|"365d", asOf:timestamp,
              totalScrobbles:integer, distinctArtists:integer, distinctTracks:integer,
              topArtists:[{artist:string,scrobbleCount:integer}],
              topTracks:[{artist:string,track:string,scrobbleCount:integer}],
              topAlbums:[{artist:string,album:string,scrobbleCount:integer}]}
```

Rank arrays order by count descending, then normalized group tuple ascending. Display values use the newest record in each group with AT URI tie-break. Profile counts and follower edges use confirmed active state. For duplicate external follow records representing one edge, serialize the lexicographically smallest active AT URI as its representative; do not double-count it.

Deletion clarification: a failed durable delete retains its original terminal operation and returns `502 deletion_failed` with `Location: /api/v1/operations/{originalId}` on repeat, rather than claiming removal. Scrobble local absence alone cannot prove PDS absence. A follow DELETE operates on one persisted bounded set of all known owned duplicate records for the edge, including preceding pending creates and the deterministic canonical URI. One operation succeeds only after every target has verified absence at a common signed repository revision. Alternating pending PUT/DELETE intents retain separate operation identities and execute after their persisted predecessors become terminal. Deletes use the verified record CID as `swapRecord`; a changed remote payload is reconciled before retry and an unrelated follow subject is retained. A fresh explicit PUT may reconcile an already verified matching remote edge, preserving its original `createdAt` without overwriting it. These private operation rules preserve the frozen public schemas.

Idempotency replay returns the currently valid original operation/result, never inserts another request. Same key with a changed canonical input returns 409 `idempotency_conflict`. Retain key/digest until account local-data disconnect. Idempotency-Key must be 1–128 printable ASCII characters; invalid header is 400 `invalid_idempotency_key`.

Missing CSRF session state is not solved by weakening the request. CSRF can be fetched through authenticated GET session. OAuth start is the exception to token-based CSRF: it checks Origin and creates single-use OAuth state; callback validates that state and issuer. No API response exposes upstream access/refresh tokens or private signing keys.
