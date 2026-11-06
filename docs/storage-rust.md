# Frozen Rust SQLite schema (M1 / #43)

This is the schema reference for the **Rust oracle**, not the Node deployment.
The authoritative SQL is [`crates/storage/migrations/`](../crates/storage/migrations/).
The current Node schema and migration policy are described in [storage.md](storage.md).
The two databases are different formats; neither runtime can open the other's
file as an upgrade path.

## Conventions

All columns below are `NOT NULL` unless marked `?`. Types are `TEXT`, except
columns explicitly marked `INTEGER` or `BLOB`. Primary keys are non-null.
Foreign-key enforcement is enabled when opening the database. Owner references
point to `users.did` with `ON DELETE CASCADE`, unless stated otherwise. The SQL
checks listed below are database constraints, not a claim that arbitrary SQL
has the same validation as the typed record API. In particular, migration 1
stores timestamp text without the Node schema's TS30 length check.

## Migration 1 (`0001_initial.sql`)

| Table | Columns | Constraints and secondary indexes |
|---|---|---|
| `users` | `did` PK, `handle?`, `joined_at`, `indexed_at?`, `active` INTEGER default 1, `revision?`, `indexing_state` default `recovering` | `active IN (0,1)`; state in `current,recovering,stale,suppressed`; `users_verified_handle(handle)` UNIQUE WHERE handle IS NOT NULL |
| `scrobbles` | `uri` PK, `cid`, `did` FK users, `revision`, `artist`, `track`, `album?`, `listened_at`, `created_at`, `duration_seconds?` INTEGER, `recording_mbid?`, `indexed_at`, `artist_key`, `track_key`, `album_key?`, `confirmed` INTEGER default 1 | duration 1–86400 if present; confirmed 0/1; `scrobbles_owner_time(did,listened_at DESC,uri DESC)`, `scrobbles_global_time(listened_at DESC,uri DESC)`, `scrobbles_stats(did,artist_key,track_key,listened_at)` |
| `follows` | `uri` PK, `cid`, `actor` FK users, `subject`, `revision`, `created_at`, `indexed_at`, `confirmed` INTEGER default 1 | actor != subject; confirmed 0/1; `follows_actor_subject(actor,subject,uri)`, `follows_subject_actor(subject,actor,uri)`; distinct URIs can represent the same edge |
| `operations` | `operation_id` PK, `owner` FK users, `kind`, `state` default `pending`, `attempts` INTEGER default 0, `created_at`, `updated_at`, `record_uri?`, `failure_code?` | kind in `scrobble_create,scrobble_delete,follow_create,follow_delete`; state in `pending,succeeded,failed`; attempts 0–10; succeeded implies NULL failure_code; `operations_owner(owner,operation_id)` |
| `outbox` | `operation_id` PK/FK operations CASCADE, `owner` FK users, `collection`, `rkey`, `payload_json?`, `canonical_digest?`, `due_at`, `locked_at?` | payload and digest are either both NULL or both non-NULL; `outbox_due(due_at,operation_id)` |
| `idempotency` | `owner` FK users, `key`, `digest`, `operation_id` FK operations CASCADE | composite PK `(owner,key)`; key length 1–128; the same key for another owner is independent |
| `tombstones` | `uri` PK, `owner` FK users, `revision?`, `operation_id?` FK operations SET NULL, `created_at`, `pending` INTEGER default 0 | pending 0/1 |
| `oauth_states` | `state_hash` PK, `encrypted_material` BLOB, `issuer`, `did`, `created_at` INTEGER, `expires_at` INTEGER | expires_at > created_at; DID deliberately has no users FK (pre-sign-in state) |
| `oauth_tokens` | `owner` PK/FK users, `encrypted_material` BLOB, `generation` INTEGER default 0, `expires_at` INTEGER | generation >= 0 |
| `sessions` | `session_hash` PK, `owner` FK users, `csrf_hash`, `encrypted_material` BLOB, `created_at` INTEGER, `expires_at` INTEGER | expires_at > created_at; `sessions_owner(owner)`, `sessions_expiry(expires_at)` |
| `relay_checkpoints` | `relay` PK, `sequence` INTEGER, `revision?`, `indexed_at` | sequence >= 0 |
| `indexing_status` | `scope` PK, `state`, `caught_up` INTEGER default 0, `last_indexed_at?`, `lag_seconds?` INTEGER | state in `current,recovering,stale,suppressed`; caught_up 0/1; lag >= 0; seeded `global,recovering,0` |
| `suppression` | `did` PK, `suppressed_at` | no users FK: suppression survives removal of indexed owner rows |

SQLite creates primary-key indexes in addition to the explicitly named indexes
above. Public scrobble/follow rows represent confirmed repository state; queue
acknowledgement alone does not insert a public row. Owner-only operations and
idempotency scope are enforced by the typed repositories as well as these keys.

## Later migrations

- **2 — `0002_operation_dependencies.sql`:**
  `operation_dependencies(operation_id,predecessor_id)`, composite PK, both
  FKs to operations with CASCADE; CHECK operation_id != predecessor_id;
  index `operation_dependencies_predecessor(predecessor_id)`.
- **3 — `0003_backfill.sql`:**
  `repo_backfills(did PK/FK users CASCADE,state,backfill_complete INTEGER DEFAULT 0,
  revision?,pds?,reactivate INTEGER DEFAULT 0,generation INTEGER DEFAULT 1,
  updated_at,failure_code?)`. State is `pending,running,complete,failed`, flags
  are 0/1, generation >= 1; index `repo_backfills_pending(state,updated_at,did)`.
  `relay_recovery(relay PK,pending_gap INTEGER DEFAULT 1,connected INTEGER DEFAULT 0,
  last_event_at?,prior_sequence? INTEGER,reason?,updated_at)`. Flags are 0/1;
  prior_sequence >= 0 when present. Completing one DID's backfill does not clear
  a relay-wide gap.
- **4 — `0004_backfill_generation.sql`:**
  `backfill_generation(singleton INTEGER PK,last_generation INTEGER)`. CHECK
  singleton = 1, integer last_generation >= 0; initially seeded from the maximum
  repo_backfills generation (or zero). This global counter survives account
  removal and prevents reuse of a recovery generation.

The migrations set `PRAGMA user_version` to 1–4. Migration application, rollback,
reopen and future-schema refusal are tested in `crates/storage/tests/migrations.rs`.
Schema keys, FK behavior and checks are exercised in `crates/storage/tests/schema.rs`;
typed owner privacy and atomic writes in `repositories.rs`; bounded writer and
lock behavior in `concurrency.rs`.

Reproduce the storage suites (requires the repository-pinned Rust toolchain):

```sh
cargo test --locked -p atmusic-storage --tests
```

This is a command reference, not a claim of a fresh pinned-toolchain execution.
See the [implementation record](verification/implementation-agent-13.md) for
commands actually executed and toolchain limitations.
