# Fixed API v1 payload contract

This is the fixed API contract encoded in `api/openapi.yaml`. The backend implements these routes with deterministic integration coverage. Owned-namespace production writes and backfills use exact current-head verification; production relay progress and full packaged/live acceptance remain unresolved. See [validation evidence](../VALIDATION.md) for actual checks and limitations. Changes require an explicit issue amendment.

**Amended by [ADR 0004 §9](../adr/0004-cloudflare-workers.md#9-amended-mvp--api--adr-rules) (contract v1.1, `info.version: 1.1.0`).** The Workers AppView is read-only and every route is public. The browser SPA is the OAuth client and writes to the user's own PDS (A2, A3). The server auth routes, the server scrobble and follow write routes, operation lookup, and the two account routes are dropped (§9.3), together with the `Accepted` and `Operation` schemas. Notify, record status and the public export are added (N1–N3). The following feed takes `viewer` (A8), export moves (A9), and disconnect is a signed settings record (A10). The feed loses its 401 (A8), and client metadata loses its 429 because a static asset never reaches the Worker's rate limiter (A3). Every other shape and status is unchanged. Issue amendment texts: [AMENDMENTS-workers.md](AMENDMENTS-workers.md).

**Amended by [ADR 0005](../adr/0005-local-node-host-and-compat-apis.md) B14 (contract v1.2, `info.version: 1.2.0`).** The server becomes one confidential atproto OAuth client (BFF) that writes for signed-in users (B2, B3). Every v1.1 route, status matrix and payload below is unchanged, except that `Scrobble` and `ScrobbleInput` gain the optional §6.2 fields, and `GET /oauth/client-metadata.json` becomes the dynamic confidential-client document beside the new `GET /oauth/jwks.json` (§5.3). v1.2 adds, additively: sign-in (`POST /api/v1/auth/start`, `GET /oauth/callback`), the cookie session (`GET /api/v1/auth/session`, `POST /api/v1/auth/logout`, `DELETE /api/v1/account/connection`), server writes that answer 202 `Accepted` with an `Operation` (state `queued`, `running`, `succeeded`, `failed`, `blocked` or `cancelled`), operation lookup, the account routes (including `GET /api/v1/account/ignored-listens`), protocol credentials, linked accounts and imports, listed in [v1.2 endpoints](#v12-endpoints-adr-0005-b14). Cookie routes read `__Host-atmusic_session`; every unsafe one also needs exactly one `Origin` equal to the public origin and the `X-CSRF-Token` from the session (401 `unauthenticated`, 403 `csrf_failed`). `meta.capabilities` may add `writes`, `lastfm`, `listenbrainz`, `imports` and `forwarding`. The Last.fm 2.0 API (`/2.0/`) and the ListenBrainz API (`/1/`) are specified in ADR 0005 §7 and §8 and in [docs/compat/lastfm.md](../compat/lastfm.md) and [docs/compat/listenbrainz.md](../compat/listenbrainz.md), not here. v1.0's account export and local-data deletion routes are not restored (A9 and A10 stay). Issue amendment texts: [AMENDMENTS-node.md](AMENDMENTS-node.md).

## Shared shapes

All timestamps are UTC RFC3339 strings. IDs are strings. Absent optional record fields are omitted, not replaced with empty strings. Handles can be `null` when no current verified handle exists. Query validation failures are 422 with `error.fields`; malformed JSON and malformed cursors are 400.

```text
Error = {error: {code: string, message: string, requestId: UUID, fields?: {fieldName: string}}}
Indexing = {state: "current"|"recovering"|"stale"|"suppressed",
            caughtUp: boolean, lastIndexedAt: timestamp|null, lagSeconds: number|null}
Scrobble = {uri: AT_URI, cid: CID, did: DID, revision: string,
            artist: string, track: string, album?: string,
            listenedAt: timestamp, createdAt: timestamp,
            durationSeconds?: integer, recordingMbid?: UUID, indexedAt: timestamp,
            albumArtist?: string, trackNumber?: 1..9999, artistMbids?: UUID[] (<=10, distinct),
            releaseMbid?: UUID, releaseGroupMbid?: UUID, isrc?: string, submissionClient?: string,
            musicService?: string}   (the last eight are the optional v1.2 fields, ADR 0005 §6.2)
Follow = {uri: AT_URI, cid: CID, actor: DID, subject: DID, createdAt: timestamp}
Page<T> = {items: T[], nextCursor: string|null, asOf: timestamp, indexing: Indexing}
NotifyInput = {uri: AT_URI} | {did: DID}
NotifyAccepted = {state: "queued"}
RecordStatus = {uri: AT_URI, state: "indexed"|"pending"|"absent"|"excluded"|"unknown",
                cid?: CID, revision?: string, reason?: string, indexing: Indexing}
```

`RecordStatus`: `indexed` is a visible row and carries its verified `cid` and `revision`. `pending` means a hint or job exists. `absent` is verified absence. `excluded` is a verified record that failed validation, and carries `reason`; `reason` appears only for `excluded`. `unknown` carries no `cid`, `revision` or `reason`.

Lists use default `limit=20`, maximum 100 and `cursor`. Statistics top lists use default `limit=10`, maximum 100, without cursor. `limit=0`, negative, noninteger or above maximum returns 422; do not silently clamp.

No v1.1 read route reads a session, cookie, CSRF token or Origin header, so no v1.1 read route returns 401 or 403. The session, private-operation, cross-owner and Origin/CSRF rules that ADR 0004 §9.3 dropped are restored for the v1.2 cookie routes only (ADR 0005 B16); public v1.1 read responses are byte-identical with and without a session cookie.

## Endpoints and outcomes

| Route | Request | Success payload / status |
| --- | --- | --- |
| GET `/health/live` | none | 200 `{status:"live"}` |
| GET `/health/ready` | none | 200 `{status:"ready"}` when storage/writer initialized; otherwise 503 Error |
| GET `/api/v1/meta` | none | 200 `{name:"atproto_music",version,stage:"scaffold"\|"backend"\|"product",capabilities:string[],lexiconPrefix:string\|null,indexing:Indexing}` |
| GET `/oauth/client-metadata.json` | none | 200 AT Protocol OAuth client metadata, not an application JSON envelope: the dynamic confidential-client document of ADR 0005 §5.3, served by the router with `Cache-Control: public, max-age=300` and no cookie: `application_type: "web"`, `token_endpoint_auth_method: "private_key_jwt"` with ES256, `jwks_uri` `https://<host>/oauth/jwks.json`, DPoP-bound tokens, the single redirect `https://<host>/oauth/callback`, and the scopes `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings repo:<p>.love` (B3, B14) |
| GET `/api/v1/resolve` | `handle` | 200 `{did:DID,handle:string,verified:true}`; unresolved 404, mismatch 422 |
| GET `/api/v1/scrobbles/{id}` | URL-encoded full AT URI | 200 `{scrobble:Scrobble}`; inactive/tombstoned/unconfirmed/absent record 404 |
| GET `/api/v1/users/{did}/scrobbles` | `limit`, `cursor` | 200 Page<Scrobble> |
| GET `/api/v1/feed` | `scope=global\|following`, `viewer`, `limit`, `cursor` | 200 Page<Scrobble>; following requires `viewer=<did>`: 422 `fields.viewer` if missing or invalid, the following cursor binds the viewer (the global binding keeps `viewer` null), an unknown viewer gets an empty page (A8) |
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

The scrobble form (A2, A12) accepts only `artist`, `track`, `listenedAt`, optional `album`, `durationSeconds`, `recordingMbid` and, from v1.2, the optional §6.2 fields. `$type`, `did`, `owner`, `createdAt`, `uri`, `cid` and any other fields are rejected before an outbox operation exists. In v1.1 no HTTP route accepted this input and the SPA wrote the record to the owner's PDS itself; from v1.2 `POST /api/v1/scrobbles` accepts it, the server sets `createdAt` and `$type=<configuredPrefix>.scrobble`, and its outbox writes the record (B6, B7).

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

Idempotency (A11, as written for v1.1; B6 amends it for v1.2 below): there is no server `Idempotency-Key`. The SPA allocates each record key (a TID, or the deterministic follow rkey) once, before the first attempt, and persists it with the canonical payload digest. An ambiguous create is resolved with `getRecord` and a digest comparison: equal is success; a different payload at that key is the client-side terminal `remote_record_conflict`, and the remote record is never overwritten.

No API response exposes upstream access/refresh tokens or private signing keys; in v1.1 the server held none (v1.2: see Credentials below). OAuth state, PKCE, DPoP and the issuer check are performed in the browser by `@atproto/oauth-client-browser` (A3).

## v1.2 endpoints (ADR 0005 B14)

Every route here is additive. Auth modes: **session** is the `__Host-atmusic_session` cookie (401 `unauthenticated` without a valid one); **session + CSRF** also needs exactly one `Origin` equal to the public origin and `X-CSRF-Token` from `GET /api/v1/auth/session` (403 `csrf_failed`). Every JSON request body is strict JSON capped at 64 KiB (400 malformed, 413 over the cap, 422 an invalid or unknown field). Writes return 202 `{operation: Operation}` and, with the publication gate closed, 503 `publication_disabled`. Owner-only reads and every response that carries a secret send `Cache-Control: no-store`.

```text
Operation = {id, kind: "scrobble.create"|"scrobble.delete"|"follow.put"|"follow.delete"|"settings.put"|"love.put"|"love.delete",
             origin: "web"|"lastfm"|"listenbrainz"|"import",
             state: "queued"|"running"|"succeeded"|"failed"|"blocked"|"cancelled",
             attempts: 0..10, uri?: AT_URI, cid?: CID, error?: code, createdAt: timestamp, updatedAt: timestamp}
Accepted  = {operation: Operation}
Session   = {did, handle: string|null, username, csrfToken: 64 hex, status: "active"|"reauth_required", expiresAt}
Account   = {did, handle: string|null, username, oauthStatus: "active"|"reauth_required"|"signed_out",
             shareNowPlaying: boolean, importSharePercent: 10..90, capabilities: string[]}
Link      = {id, service: "lastfm"|"listenbrainz", remoteUser, forwardScrobbles, forwardNowPlaying,
             status: "active"|"revoked"|"error", lastError: code|null, createdAt, updatedAt}
ImportJob = {id, source: "lastfm_api"|"lastfm_json"|"listenbrainz_api"|"listenbrainz_zip", remoteUser: string|null,
             state: "waiting_index"|"fetching"|"writing"|"paused"|"done"|"failed"|"cancelled",
             fetched, staged, duplicates, invalid, written, failed, etaSeconds: integer|null, error: code|null,
             createdAt, updatedAt}
Credentials = {appPasswords: [{id, label, createdAt, lastUsedAt}], listenbrainzTokens: [{id, label, createdAt, lastUsedAt}],
               lastfmApps: [{apiKey, name, createdAt}], lastfmSessions: [{id, apiKey, clientName, createdAt, lastUsedAt}]}
```

| Route | Auth | Request | Success payload / status |
| --- | --- | --- | --- |
| GET `/oauth/jwks.json` | none | none | 200 `{keys: [{kty:"EC", crv:"P-256", x, y, kid, alg:"ES256", use:"sig"}]}`, never `d` (§5.4) |
| POST `/api/v1/auth/start` | Origin only | `{handle}` | 200 `{authorizeUrl}` and the `__Host-atmusic_oauth` cookie; 403 `csrf_failed` or `signin_not_allowed`, 422 `fields.handle`, 429 (10/min per IP), 502 `oauth_upstream` |
| GET `/oauth/callback` | `__Host-atmusic_oauth` | `state`, `code`, `iss` or `error` | 303 to `/` (or `/signin?error=denied`) with the session cookie; 403 `oauth_binding_mismatch` or `signin_not_allowed`, 502 `oauth_upstream` |
| GET `/api/v1/auth/session` | session | none | 200 Session; 401 |
| POST `/api/v1/auth/logout` | session + CSRF | `{everywhere?}` | 204 |
| DELETE `/api/v1/account/connection` | session + CSRF | none | 204: OAuth session revoked and deleted, every web session, protocol credential and link deleted, unsent operations cancelled |
| POST `/api/v1/scrobbles` | session + CSRF | ScrobbleInput, `Idempotency-Key` | 202 Accepted; 400 `idempotency_key_required` or `invalid_idempotency_key`, 409 `idempotency_conflict`, 503 `publication_disabled` |
| DELETE `/api/v1/scrobbles/{id}` | session + CSRF | URL-encoded AT URI | 202 Accepted; another DID's record 404 |
| PUT `/api/v1/follows/{did}` | session + CSRF | DID | 202 Accepted |
| DELETE `/api/v1/follows/{did}` | session + CSRF | DID | 202 Accepted |
| PUT `/api/v1/loves` | session + CSRF | `{artist, track, album?, recordingMbid?}` | 202 Accepted (a love that exists is a no-op success) |
| DELETE `/api/v1/loves` | session + CSRF | `artist`, `track` | 202 Accepted |
| PUT `/api/v1/account/indexing` | session + CSRF | `{indexing: "enabled" or "disabled"}` | 202 Accepted (writes the A10 settings record) |
| GET `/api/v1/operations/{id}` | session | operation id | 200 Operation; another session's operation 404 |
| GET `/api/v1/account` | session | none | 200 Account |
| PATCH `/api/v1/account` | session + CSRF | `{username?, shareNowPlaying?, importSharePercent?}` | 200 Account; 409 `username_taken`; 422 `username_invalid` for a dotted name other than the caller's own verified handle |
| GET `/api/v1/account/ignored-listens` | session | `limit`, `cursor` | 200 `{items: [{id, source, reason, listenedAt, artistPreview, trackPreview, createdAt}], nextCursor}` |
| GET `/api/v1/account/credentials` | session | none | 200 Credentials (metadata only) |
| POST `/api/v1/account/app-passwords` | session + CSRF | `{label}` | 201 `{id, label, password, createdAt}`, the password shown once |
| DELETE `/api/v1/account/app-passwords/{id}` | session + CSRF | id | 204 |
| POST `/api/v1/account/listenbrainz-tokens` | session + CSRF | `{label}` | 201 `{id, label, token, createdAt}`, the UUIDv4 token shown once |
| DELETE `/api/v1/account/listenbrainz-tokens/{id}` | session + CSRF | id | 204 |
| POST `/api/v1/account/lastfm-apps` | session + CSRF | `{name}` | 201 `{apiKey, sharedSecret, name, createdAt}`, the secret shown once |
| DELETE `/api/v1/account/lastfm-apps/{apiKey}` | session + CSRF | api_key | 204 |
| DELETE `/api/v1/account/lastfm-sessions/{id}` | session + CSRF | id | 204 |
| POST `/api/v1/lastfm/authorize` | session + CSRF | `{apiKey, token?}` | 200 `{token}`: the desktop token authorized, or a new authorized token for the web flow; unknown or expired 404 |
| GET `/api/v1/links` | session | none | 200 `{items: Link[]}` |
| POST `/api/v1/links/lastfm/start` | session + CSRF | none | 200 `{authorizeUrl}`; 503 `lastfm_not_configured` |
| GET `/api/v1/links/lastfm/callback` | session | `state`, `token` | 303 to `/settings/links`; a state not bound to this session 403, nothing stored |
| POST `/api/v1/links/listenbrainz` | session + CSRF | `{token}` | 201 Link; an invalid token 422 `fields.token` |
| PATCH `/api/v1/links/{id}` | session + CSRF | `{forwardScrobbles?, forwardNowPlaying?}` | 200 Link |
| DELETE `/api/v1/links/{id}` | session + CSRF | id | 204 (credential and queued forward rows deleted) |
| GET `/api/v1/imports` | session | none | 200 `{items: ImportJob[]}` |
| POST `/api/v1/imports` | session + CSRF | `{source: "lastfm" or "listenbrainz", username}` | 202 ImportJob; 409 `import_active`; 503 `lastfm_not_configured` or `publication_disabled` |
| POST `/api/v1/imports/upload` | session + CSRF | `source=lastfm_json` or `listenbrainz_zip`, raw body up to 64 MiB | 202 ImportJob; 409 `import_active`, 413, 429 (3/h per DID), 507 `insufficient_storage` |
| GET `/api/v1/imports/{id}` | session | id | 200 ImportJob; another DID's job 404 |
| POST `/api/v1/imports/{id}/cancel` | session + CSRF | id | 200 ImportJob (new operations stop; queued ones finish) |
| POST `/api/v1/imports/{id}/resume` | session + CSRF | id | 200 ImportJob (a paused job resumes) |

Idempotency (B6, v1.2): `POST /api/v1/scrobbles` requires `Idempotency-Key`, 1–128 characters from `[A-Za-z0-9._~-]` and scoped per DID. The same key and request hash return the same operation; the same key with another hash is 409 `idempotency_conflict`. The TID record key is still allocated once and persisted with the canonical digest before the first attempt, and an ambiguous create is still reconciled by `getRecord` and a digest comparison; a record is never overwritten. Protocol ingress (`/2.0/`, `/1/`) is idempotent through listen keys instead (ADR 0005 §7.7).

Credentials (B3, v1.2): the server holds each DID's OAuth session, sealed with AES-256-GCM at rest; no response returns an access or refresh token, a DPoP key or a client signing key. Issued protocol secrets (app passwords, ListenBrainz tokens, Last.fm shared secrets) are returned once by the route that creates them and stored only as SHA-256, except issued Last.fm shared secrets, which are sealed because signature verification needs them.
