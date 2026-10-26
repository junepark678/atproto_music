# Storage: the IndexDO SQLite schema

The whole index lives in the SQLite database of one Durable Object, `IndexDO`, a single instance from `idFromName("index-v1")` ([ADR 0004](adr/0004-cloudflare-workers.md) §6). D1, KV, Queues and R2 are not used. The schema is defined in [`worker/src/do/schema.ts`](../worker/src/do/schema.ts).

## Conventions and invariants

- **One writer, synchronous transactions.** Every state change runs in one `db.tx(() => …)` over `ctx.storage.transactionSync`, which rolls back on a throw. `Db.tx` rejects a callback that returns a Promise, and a lint test fails on `tx(async`, so no read-check-write can span an `await`: network fetches and signature checks happen first, then one transaction re-reads its guards (per-URI revision, per-DID revision floor, `users.generation`, suppression) and applies.
- **Timestamps.** Ordering timestamps are TEXT in fixed-width UTC with nine fractional digits, `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ` (30 characters, enforced by `CHECK`), so string order is instant order. Responses render them exactly as the Rust DTOs do. Internal timers are INTEGER epoch milliseconds.
- **Numbers.** Every integer is a safe JavaScript integer (`doDb` asserts `Number.isSafeInteger` and at most 100 bound parameters per statement).
- **Ordering.** SQLite BINARY collation is UTF-8 byte order, which is code-point order and equals Rust `String` order.
- **D1-compatible dialect.** The 100-parameter, 100 KB statement and 2 MB row limits of D1 are respected, so per-DID sharding or a D1 read replica stays possible.
- **Foreign keys.** `scrobbles.did` and `follows.actor` reference `users(did) ON DELETE CASCADE`; disconnect still deletes explicitly.

## Migrations

Migrations are an ordered array in `schema.ts` (currently version 1, `initial_workers_schema`). The DO constructor applies the pending ones under `blockConcurrencyWhile`, inside one `transactionSync`, and records them in `schema_migrations` (which replaces `PRAGMA user_version`). Re-running is a no-op; a failing statement leaves neither it nor any earlier statement of that migration, and the schema version is unchanged. Storage written by newer code (`too_new`) is never touched: `/health/ready` answers 503 and `/api/v1/meta` reports stage `scaffold`. There is no migrate CLI and no downgrade. A schema change is a new migration entry; it is never an edit of an applied one.

## Tables

| Table | Key | Contents |
| --- | --- | --- |
| `users` | `did` | `handle` (verified both ways, unique when set), `handle_checked_at_ms`, `pds`, `joined_at`, `indexed_at`, `active` (0 until the first complete snapshot), `account_status`, `max_rev` (newest verified revision; the stale-PDS floor), `indexing_state`, `generation`, `stats_version`, `last_snapshot_at_ms`, `last_status_check_ms`, `last_activity_ms` |
| `scrobbles` | `uri` | `cid`, `did`, `rkey`, `revision`, `artist`, `track`, `album`, `listened_at`, `created_at`, `duration_seconds` (1–86,400), `recording_mbid`, `indexed_at`, and the typed grouping keys `artist_key`, `track_key`, `album_key`. Indexes `scrobbles_owner_time (did, listened_at DESC, uri DESC)`, `scrobbles_global_time (listened_at DESC, uri DESC)`, `scrobbles_stats (did, artist_key, track_key, listened_at)` |
| `follows` | `uri` | `cid`, `actor`, `subject` (never the actor), `revision`, `created_at`, `indexed_at`. Indexes `(actor, subject, uri)` and `(subject, actor, uri)` |
| `record_state` | `uri` | `did`, `collection`, `revision`, `cid`, `state` present/absent/excluded, `reason` (required when excluded), `verified_at`: the per-URI monotonic guard, so an older proof can never resurrect or overwrite newer state; backs `GET /api/v1/records/status` |
| `suppression` | `did` | `suppressed_at`, `settings_uri`, `settings_rev`: the verified opt-out record and its revision |
| `indexing_status` | `scope` | `state`, `caught_up`, `last_indexed_at`, `lag_seconds`; seeded `('global', 'recovering', 0)` |
| `backfill_generation` | singleton | the global generation counter; it survives disconnect, so a generation is never reused |
| `repo_jobs` | `(did, kind)` | one resumable `snapshot`, `status` or `identity` job per DID: `state`, `generation`, `reason`, `head_rev`, `head_cid`, `frontier_json` (the walk frontier), `restarts`, `reactivate`, `due_at`, `attempts`, `failure_code`, `updated_at_ms`. Index `(kind, state, due_at, did)` |
| `ingest_checkpoint` | `stream` | `cursor`, `last_event_time_us`, `connected`, `pending_gap` (default 1), `gap_scan_after_did`, `mode`, `host_index`, `connected_at_ms`, `updated_at_ms`; seeded `('jetstream', pending_gap=1)` |
| `hints` | `uri` | the ordered, coalescing, durable queue of untrusted `(did, collection, rkey)`: `source` jetstream/notify/reconcile, `priority`, `hint_rev`, `receipt_time`, `due_at`, `attempts`, `last_error`. Indexes `(due_at)`, `(did)` |
| `snapshot_blocks` | `(did, cid)` | CID-verified MST nodes and `getRepo`-fallback blocks of a running snapshot |
| `identity_cache` | `did` | `doc_json`, `signing_key`, `pds`, `handle`, `fetched_at_ms`, `neg_until_ms` (5-minute TTL, 1-hour negative TTL) |
| `verified_commits` | `(did, commit_cid)` | `rev`, `verified_at_ms`: skips a repeated signature check for the same commit (kept 7 days) |
| `host_backoff` | `host` | `until_ms`: per-PDS-host pause honouring `Retry-After` / `RateLimit-Reset` |
| `admission` | `window_start_ms` | `admitted`: the hourly new-DID budget (50) |
| `timers` | `name` | `due_at`: every background task, multiplexed onto the one alarm ([workers.md](workers.md)) |
| `stats_cache` | `(did, win, lim)` | `as_of`, `lower`, `version`, `body`: an exact statistics cache, reused only when provably equal |
| `counters` | `(name, label)` | `value`: operational counters, which replace the Prometheus metrics ([operations.md](operations.md)) |

Only rows with a verified proof exist in `scrobbles` and `follows` (the old `confirmed` flag is gone). Read queries join `users` with `active = 1` and exclude suppressed DIDs, so an inactive, reactivating or opted-out account is hidden from history, feeds, statistics, profiles, follow lists and counts at once. The exact statistics cache is reused at a new `asOf` only when `users.stats_version` is unchanged and two indexed `EXISTS` probes show no row of that DID entered or left the window since; otherwise statistics are exact read-time `GROUP BY` queries.

## Mapping from the Rust SQLite schema

The frozen Rust candidate (`crates/storage/migrations` 0001–0004) remains the test oracle. Its tables map as follows:

| Rust table | Workers fate |
| --- | --- |
| `users` | kept and extended (`pds`, `handle_checked_at_ms`, `account_status`, `max_rev` replacing `revision`, `generation`, `stats_version`, `last_*` columns); `active` now defaults to 0 |
| `scrobbles`, `follows` | kept; `confirmed` dropped, `scrobbles.rkey` added; same indexes |
| `tombstones` | replaced by `record_state` |
| `suppression` | kept, with `settings_uri` and `settings_rev` |
| `indexing_status`, `backfill_generation` | kept |
| `repo_backfills` | replaced by `repo_jobs` |
| `relay_checkpoints`, `relay_recovery` | merged into `ingest_checkpoint` |
| `operations`, `outbox`, `idempotency`, `operation_dependencies` | dropped (A11, A12): the outbox is the SPA's IndexedDB store ([deletion.md](deletion.md), [follows.md](follows.md)) |
| `oauth_states`, `oauth_tokens`, `sessions` | dropped (A3): the server holds no user credentials |
| *(new)* | `hints`, `snapshot_blocks`, `identity_cache`, `verified_commits`, `host_backoff`, `admission`, `timers`, `stats_cache`, `counters` |

## Capacity

One Durable Object holds up to 10 GB: about 10 million scrobbles at roughly 1 KB each with indexes. That is about 11 months at 30k scrobbles/day and decades at hobby scale. The way out is per-DID shards keyed by DID hash, which the module signatures (an explicit `did` everywhere) already allow; it is deferred and not built (ADR §11).

## Tests

`worker/test/storage/sql-conformance.test.ts` runs on real DO SQLite in workerd (52-bit precision, multi-statement bindings, foreign keys, partial unique indexes, `RETURNING`, `ON CONFLICT … WHERE`, rollback on a throw, the 101-parameter error); `worker/test/storage/migrate.test.ts` covers fresh, repeated and failing migrations; `worker/test/read/stats-plan.test.ts` checks with `EXPLAIN QUERY PLAN` that the statistics queries use the indexes; `worker/test/storage/no-async-tx.test.ts` is the `tx(async` lint. Run them with `npm test`.
