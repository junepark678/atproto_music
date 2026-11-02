# Public records, export and disconnect

> **Architecture and scope:** The SPA/browser-side flows and ADR 0004 references on this page describe the earlier Workers product. The current Node architecture in [ADR 0005](adr/0005-local-node-host-and-compat-apis.md) uses a confidential BFF and stores OAuth/session and protocol credentials server-side; the legacy SPA is not asserted to be compatible with that BFF (M7 is excluded). Current public per-DID export, credential disconnect, and indexing suppression are distinct behaviors. They do not implement the published owner-only export or atomic credential-removal + local-data-removal + suppression contract; those differences remain for owner reconciliation.

Scrobbles, listening history, statistics, profiles and music follows are public. Each account's PDS holds its authoritative records; this AppView keeps a verified copy, and other services may keep copies of their own. The AppView covers the accounts it discovers (Jetstream, relay discovery, sign-in) and promises neither universal discovery nor complete historical coverage. The earlier browser/Workers sign-in, write, and opt-out flow is described in [ADR 0004](adr/0004-cloudflare-workers.md) §5.1–§5.3, A2, A3; it is not a description of the current Node BFF.

## Export

`GET /api/v1/users/{did}/export` (amendment A9) returns `{schemaVersion: 1, did, exportedAt, indexing, scrobbles, follows}` for one DID: its indexed public scrobbles (newest first, as the public `Scrobble` payload) and its representative follow edges, with per-DID indexing metadata. In the earlier Workers implementation these fields were read in one synchronous Durable Object transaction; the current Node route uses the Node index service, not a Durable Object. It is a JSON attachment (`music-export.json`) with `Cache-Control: no-store`.

- It is public, like the records it contains: no session, cookie or token.
- An unknown, inactive or opted-out DID is 404; a malformed DID is 422 `fields.did`.
- It contains no exclusion reasons, hints, jobs, identity cache, counters or configuration. This describes the response payload, not server credential storage: the current Node BFF does hold credentials, so public-response secrecy must be assessed against that architecture rather than a “no credentials on the server” assumption.
- It is an export of what this index holds, not a PDS archive; `indexing` says how fresh it is. For the authoritative copy, export the repository from the PDS.

The settings-screen download and pre-disconnect flow refers to the legacy SPA only; this page does not establish that the bundled legacy UI interoperates with the current Node BFF.

## Disconnect: the signed opt-out record

This section describes indexing suppression via a record the owner writes to their own repository (amendments A10, N4; ADR §15 Q2), `<prefix>.settings/self` with key `literal:self` (schema [`lexicons/settings.json`](../lexicons/settings.json)). It is separate from the current Node `DELETE /api/v1/account/connection` credential/session disconnect: neither mechanism alone performs the published atomic credential removal + local-data removal + suppression operation.

```json
{ "indexing": "disabled", "createdAt": "2026-01-15T12:00:00.000Z" }
```

The client/outbox and table-transaction details below describe the earlier Workers/IndexDO implementation; they are not a description of the current Node SQLite implementation. In that historical SPA flow, the browser writes the record through its outbox with `putRecord` (the literal key is the owner's single, replaceable choice), then sends `POST /api/v1/notify`. When the IndexDO has verified the record (signature, CID and MST proof, like any other record), one `transactionSync`:

- deletes the DID's scrobbles, its own follows, `record_state`, hints, jobs, statistics cache, snapshot and commit caches, identity cache and per-DID indexing state, and its `users` row;
- inserts `suppression(did, settings_uri, settings_rev, suppressed_at)`;
- keeps the global `backfill_generation`, so a later reconnect gets a fresh, never reused generation.

From then on only `<prefix>.settings` hints are processed for that DID; everything else is dropped unverified. Other users' follow records that point at the DID stay theirs and stay stored, but are hidden, because the subject is not an active user. `GET /api/v1/records/status?uri=at://<did>/<prefix>.settings/self` reports `indexing.state: "suppressed"` once the opt-out has applied.

**Privacy.** The opt-out is itself a public record. It is honoured for a DID the index has never seen, and so it survives a full rebuild of the index ([backup.md](backup.md)). Disconnect makes no deletion request to the PDS: the user's scrobbles and follows stay public there and in any other service's copy. To remove them, delete the records ([deletion.md](deletion.md)) or the account at the PDS.

## Reconnect

The revision rule below describes the indexing-suppression policy. Its settings-screen, suppression-row, range-snapshot and generation mechanics are the earlier Workers/IndexDO implementation, not proof of the current Node SQLite restart or recovery behavior. In that historical flow, the owner deletes `settings/self`, or writes `{indexing: "enabled"}`, from the settings screen. A verified absence of the record, or `enabled` at a revision newer than the stored `settings_rev`, deletes the suppression row and admits a range snapshot with a fresh generation. An older or equal revision, or an invalid settings record, changes nothing: a stale "disabled" proof can never re-suppress after a newer reconnect, and a stale "enabled" can never undo a newer disconnect. Public visibility returns only when the complete verified snapshot commits.

## Sign-out

The sign-out behavior and 14-day browser-client session statement here describe the legacy SPA/Workers flow, not the current Node BFF session contract. The Node API exposes `POST /api/v1/auth/logout`; its server-side session and OAuth revocation behavior is implemented in `worker/src/http/auth.ts` and is distinct from clearing browser IndexedDB. Do not infer current Node UI compatibility or session duration from the historical SPA description.

## Tests

`worker/test/write/suppression.test.ts` and the drain suites in `worker/test/ingest/` cover the historical opt-out transaction, suppression of later hints, hidden incoming follows and reconnect ordering through the verifier; `worker/test/read/export.test.ts` covers the public export payload, attachment headers and 404s, not the original owner-only authorization matrix or export-specific credential leakage; `worker/test/node/http/auth.test.ts` covers current Node auth/disconnect routes. `web/test/routes/settings.test.tsx` and `web/test/outbox/settings.test.ts` cover the legacy settings screen and its outbox operations, not Node BFF UI compatibility. All run with `npm test`.
