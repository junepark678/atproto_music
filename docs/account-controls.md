# Public records, export and disconnect

Scrobbles, listening history, statistics, profiles and music follows are public. Each account's PDS holds its authoritative records; this AppView keeps a verified copy, and other services may keep copies of their own. The AppView covers the accounts it discovers (Jetstream, relay discovery, sign-in) and promises neither universal discovery nor complete historical coverage. The server holds no user credentials: sign-in, writes and the opt-out below all happen in the browser, against the user's own PDS ([ADR 0004](adr/0004-cloudflare-workers.md) §5.1–§5.3, A2, A3).

## Export

`GET /api/v1/users/{did}/export` (amendment A9) returns `{schemaVersion: 1, did, exportedAt, indexing, scrobbles, follows}` for one DID: its indexed public scrobbles (newest first, as the public `Scrobble` payload) and its representative follow edges, with the per-DID indexing metadata, read in one synchronous DO transaction so records and metadata are one consistent snapshot. It is a JSON attachment (`music-export.json`) with `Cache-Control: no-store`.

- It is public, like the records it contains: no session, cookie or token.
- An unknown, inactive or opted-out DID is 404; a malformed DID is 422 `fields.did`.
- It contains no exclusion reasons, hints, jobs, identity cache, counters or configuration, and there are no credentials on the server to leak.
- It is an export of what this index holds, not a PDS archive; `indexing` says how fresh it is. For the authoritative copy, export the repository from the PDS.

The SPA's settings screen downloads it for the signed-in user and offers it before a disconnect.

## Disconnect: the signed opt-out record

Disconnect is a record the owner writes to their own repository (amendments A10, N4; ADR §15 Q2), `<prefix>.settings/self` with key `literal:self` (schema [`lexicons/settings.json`](../lexicons/settings.json)):

```json
{ "indexing": "disabled", "createdAt": "2026-01-15T12:00:00.000Z" }
```

The SPA writes it through its outbox with `putRecord` (the literal key is the owner's single, replaceable choice), then sends `POST /api/v1/notify`. When the IndexDO has verified the record (signature, CID and MST proof, like any other record), one `transactionSync`:

- deletes the DID's scrobbles, its own follows, `record_state`, hints, jobs, statistics cache, snapshot and commit caches, identity cache and per-DID indexing state, and its `users` row;
- inserts `suppression(did, settings_uri, settings_rev, suppressed_at)`;
- keeps the global `backfill_generation`, so a later reconnect gets a fresh, never reused generation.

From then on only `<prefix>.settings` hints are processed for that DID; everything else is dropped unverified. Other users' follow records that point at the DID stay theirs and stay stored, but are hidden, because the subject is not an active user. `GET /api/v1/records/status?uri=at://<did>/<prefix>.settings/self` reports `indexing.state: "suppressed"` once the opt-out has applied.

**Privacy.** The opt-out is itself a public record. It is honoured for a DID the index has never seen, and so it survives a full rebuild of the index ([backup.md](backup.md)). Disconnect makes no deletion request to the PDS: the user's scrobbles and follows stay public there and in any other service's copy. To remove them, delete the records ([deletion.md](deletion.md)) or the account at the PDS.

## Reconnect

The owner deletes `settings/self`, or writes `{indexing: "enabled"}`, from the settings screen. A verified absence of the record, or `enabled` at a revision newer than the stored `settings_rev`, deletes the suppression row and admits a range snapshot with a fresh generation. An older or equal revision, or an invalid settings record, changes nothing: a stale "disabled" proof can never re-suppress after a newer reconnect, and a stale "enabled" can never undo a newer disconnect. Public visibility returns only when the complete verified snapshot commits.

## Sign-out

Sign-out in the SPA revokes the session upstream (`session.signOut()`), stops the outbox runner and clears IndexedDB. It does not touch the index: published records stay public and indexed. Public browser-client sessions last at most 14 days after authorization (atproto OAuth), and the settings screen shows when the current one ends.

## Tests

`worker/test/write/suppression.test.ts` and the drain suites in `worker/test/ingest/` cover the opt-out transaction, suppression of later hints, hidden incoming follows and reconnect ordering through the real verifier; `worker/test/read/export.test.ts` covers the export payload, attachment headers and 404s; `web/test/routes/settings.test.tsx` and `web/test/outbox/settings.test.ts` cover the settings screen and its outbox operations. All run with `npm test`.
