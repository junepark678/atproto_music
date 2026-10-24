# Fixed API v1 payload contract

This is the fixed API contract encoded in `api/openapi.yaml`. The backend implements these routes with deterministic integration coverage. Owned-namespace production writes and backfills use exact current-head verification; production relay progress and full packaged/live acceptance remain unresolved. See [validation evidence](../VALIDATION.md) for actual checks and limitations. Changes require an explicit issue amendment.

**Amended by [ADR 0004 §9](../adr/0004-cloudflare-workers.md#9-amended-mvp--api--adr-rules) (contract v1.1, `info.version: 1.1.0`).** The Workers AppView is read-only and every route is public. The browser SPA is the OAuth client and writes to the user's own PDS (A2, A3). The server auth routes, the server scrobble and follow write routes, operation lookup, and the two account routes are dropped (§9.3), together with the `Accepted` and `Operation` schemas. Notify, record status and the public export are added (N1–N3). The following feed takes `viewer` (A8), export moves (A9), and disconnect is a signed settings record (A10). The feed loses its 401 (A8), and client metadata loses its 429 because a static asset never reaches the Worker's rate limiter (A3). Every other shape and status is unchanged. Issue amendment texts: [AMENDMENTS-workers.md](AMENDMENTS-workers.md).

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
NotifyInput = {uri: AT_URI} | {did: DID}
NotifyAccepted = {state: "queued"}
RecordStatus = {uri: AT_URI, state: "indexed"|"pending"|"absent"|"excluded"|"unknown",
                cid?: CID, revision?: string, reason?: string, indexing: Indexing}
```

`RecordStatus`: `indexed` is a visible row and carries its verified `cid` and `revision`. `pending` means a hint or job exists. `absent` is verified absence. `excluded` is a verified record that failed validation, and carries `reason`; `reason` appears only for `excluded`. `unknown` carries no `cid`, `revision` or `reason`.

Lists use default `limit=20`, maximum 100 and `cursor`. Statistics top lists use default `limit=10`, maximum 100, without cursor. `limit=0`, negative, noninteger or above maximum returns 422; do not silently clamp.

No v1.1 route reads a session, cookie, CSRF token or Origin header, so no route returns 401 or 403. The session, private-operation, cross-owner and Origin/CSRF rules of v1.0 are dropped (ADR 0004 §9.3).

## Endpoints and outcomes

| Route | Request | Success payload / status |
| --- | --- | --- |
| GET `/health/live` | none | 200 `{status:"live"}` |
| GET `/health/ready` | none | 200 `{status:"ready"}` when storage/writer initialized; otherwise 503 Error |
| GET `/api/v1/meta` | none | 200 `{name:"atproto_music",version,stage:"scaffold"\|"backend"\|"product",capabilities:string[],lexiconPrefix:string\|null,indexing:Indexing}` |
| GET `/oauth/client-metadata.json` | none | 200 AT Protocol OAuth client metadata conforming to pinned spec; not an application JSON envelope; a build-time static asset with `application_type: "web"` and the single redirect `https://<host>/oauth/callback` (A3) |
| GET `/api/v1/resolve` | `handle` | 200 `{did:DID,handle:string,verified:true}`; unresolved 404, mismatch 422 |
| GET `/api/v1/scrobbles/{id}` | URL-encoded full AT URI | 200 `{scrobble:Scrobble}`; inactive/tombstoned/unconfirmed/absent record 404 |
| GET `/api/v1/users/{did}/scrobbles` | `limit`, `cursor` | 200 Page<Scrobble> |
| GET `/api/v1/feed` | `scope=global\|following`, `viewer`, `limit`, `cursor` | 200 Page<Scrobble>; following requires `viewer=<did>`: 422 `fields.viewer` if missing or invalid, the cursor binds the viewer, an unknown viewer gets an empty page (A8) |
| GET `/api/v1/users/{did}/profile` | DID | 200 Profile below; unknown/inactive 404 |
| GET `/api/v1/users/{did}/stats` | `window=all\|7d\|30d\|365d`, `limit` | 200 Statistics below; default window all |
| GET `/api/v1/users/{did}/following` | `limit`, `cursor` | 200 Page<Follow> |
| GET `/api/v1/users/{did}/followers` | `limit`, `cursor` | 200 Page<Follow> |
| GET `/api/v1/users/{did}/export` | DID | 200 `{schemaVersion:1,did:DID,exportedAt:timestamp,indexing:Indexing,scrobbles:Scrobble[],follows:Follow[]}`, attachment `music-export.json`, `Cache-Control: no-store`; unknown/inactive 404 (A9, N3) |
| POST `/api/v1/notify` | NotifyInput, at most 2 KiB | 202 NotifyAccepted; malformed JSON 400, body over 2 KiB 413, unknown field or invalid/unconfigured URI or DID 422, rate limited 429 with `Retry-After`, new-DID admission exhausted 503 `queue_full` (N1) |
| GET `/api/v1/records/status` | `uri` | 200 RecordStatus, `Cache-Control: no-store`; invalid URI 422 (N2) |

Disconnect retains only the minimal DID suppression marker needed to prevent automatic reingestion; it does not claim erasure from the external PDS or other services. Export contains the owner's indexed public records and snapshot indexing metadata, with no credentials. See [account control limits](../account-controls.md).

Disconnect (A10): the owner writes the repo-signed `<prefix>.settings/self` record ([`lexicons/settings.json`](../../lexicons/settings.json)) with `indexing: "disabled"` and sends notify. Once that record's proof verifies, one transaction deletes the DID's local data and keeps only the suppression marker; only `<prefix>.settings` hints are processed for a suppressed DID. Deleting the record, or `indexing: "enabled"` at a newer revision, lifts the suppression and admits a fresh verified snapshot. The opt-out record is public.

Notify (N1) is an untrusted hint: it can only make the AppView check public signed truth and cannot inject data. `{uri}` must name a record in a configured collection; `{did}` admits an unknown DID, or schedules a snapshot when the last one is over 24 hours old. Limits are 60 requests per minute per client IP (`CF-Connecting-IP`) and 600 per hour per DID; new DIDs enter only through admission (50 per hour, at most 1,024 pending snapshot jobs). A suppressed DID's non-settings hints are accepted with 202 and ignored.

`/api/v1/meta` includes the full frozen shape and advertises only initialized capabilities. Empty global indexing begins as recovering, not a fabricated current state. Unknown collection owner DIDs do not cause unbounded implicit network fetching.

Capabilities (A20) are `read`, `stats`, `follows`, `notify` and `indexing`, plus `publication` only when an owned lexicon prefix is configured; `stage` reflects the Workers composition.

The scrobble form (A2, A12) accepts only `artist`, `track`, `listenedAt`, optional `album`, `durationSeconds`, `recordingMbid`. `$type`, `did`, `owner`, `createdAt`, `uri`, `cid` and any other fields are rejected before an outbox operation exists. No HTTP route accepts this input: the SPA validates it with `@atmusic/core/scrobble`, sets `createdAt`, builds the record with `$type=<configuredPrefix>.scrobble`, and writes it to the owner's own PDS. `api/openapi.yaml` keeps the `ScrobbleInput` schema for that form.

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

Deletion clarification (A12, A13): deletes run in the SPA outbox against the owner's own PDS. A pending deletion hides the record in the owner's view immediately; public views change only once signed absence is verified, typically within seconds through notify. A failed delete stays visible to the owner as failed rather than claiming removal. Scrobble local absence alone cannot prove PDS absence. Deletes use the CID from `GET /api/v1/records/status` as `swapRecord`; `InvalidSwap` re-fetches and reconciles before retry. A delete queued behind a pending create waits for it. Unfollow lists the owner's own follow records from their PDS and deletes every record whose subject matches, each with `swapRecord`; an unrelated follow subject is retained. Alternating follow and unfollow intents retain separate operation identities and execute in order after their persisted predecessors. A follow whose deterministic record already exists with the same subject is success and keeps its original `createdAt` without overwriting it.

Idempotency (A11): there is no server `Idempotency-Key`. The SPA allocates each record key (a TID, or the deterministic follow rkey) once, before the first attempt, and persists it with the canonical payload digest. An ambiguous create is resolved with `getRecord` and a digest comparison: equal is success; a different payload at that key is the client-side terminal `remote_record_conflict`, and the remote record is never overwritten.

No API response exposes upstream access/refresh tokens or private signing keys; the server holds none. OAuth state, PKCE, DPoP and the issuer check are performed in the browser by `@atproto/oauth-client-browser` (A3).
