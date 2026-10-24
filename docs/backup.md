# Backup and recovery

The index is **derived data**. Every scrobble, follow and opt-out it holds is a copy of a signed record in some user's public repository, and nothing else is stored: no OAuth tokens, sessions, outbox, encryption key or private account data (ADR 0004 §1.1, A3, A12). The authoritative copy of each user's data is their PDS. Recovery therefore has two tools, and neither involves copying files (amendment A15):

1. **Durable Object point-in-time recovery (PITR)**: restore the whole `IndexDO` to its state at any instant in the last 30 days.
2. **Rebuild from the network**: start from an empty index and re-derive it from public repositories through the normal, fully verified ingestion path.

There is deliberately no logical dump or restore command (ADR §3.2). The only operator secret, `CURSOR_KEY`, is not in the index; keep it in a password manager. Losing it costs only outstanding pagination cursors (clients restart their traversal after one 400 `invalid_cursor`).

## Point-in-time recovery

SQLite-backed Durable Objects keep 30 days of point-in-time history. `POST /internal/admin/pitr {atMs}` asks the `IndexDO` for the bookmark of that instant (`ctx.storage.getBookmarkForTime`), schedules it for the next session (`onNextSessionRestoreBookmark`) and aborts the instance, so the next request opens the restored storage. The route exists only while the `ADMIN_TOKEN` secret is set (otherwise it is a 404 like any unknown path) and compares the bearer token in constant time.

Use the operator script, which never takes the token as a flag and never prints it:

```sh
read -rs ADMIN_TOKEN && export ADMIN_TOKEN    # paste the Worker's ADMIN_TOKEN; it stays out of shell history
npx tsx scripts/admin/pitr-restore.ts --help
npx tsx scripts/admin/pitr-restore.ts --at 2026-01-15T11:00:00Z --dry-run      # prints the request only
npx tsx scripts/admin/pitr-restore.ts --at 2026-01-15T11:00:00Z --yes          # production origin
npx tsx scripts/admin/pitr-restore.ts --at 2026-01-15T11:00:00Z --env staging --yes
```

`--at` takes ISO-8601 with a timezone or epoch milliseconds; it must be within the last 30 days and not in the future (the Worker re-checks: 422 `fields.atMs`). The origin is `--origin`, else `PUBLIC_ORIGIN`, else the env's `PUBLIC_ORIGIN` in `worker/wrangler.jsonc`. Exit status 0 means scheduled (202 with the bookmark), 1 means the Worker refused (404: no `ADMIN_TOKEN` on that Worker; 401: wrong token; 422: out of range), 2 means a usage or configuration error and nothing was sent.

After a restore:

- `GET /internal/admin/status` (same bearer token) shows the restored schema version, ingest checkpoint, hint and job counts and counters; `/api/v1/meta` shows the indexing state.
- Everything newer than `--at` is recovered from the network, not lost for good. The Jetstream cursor is the restored one: within `JETSTREAM_LOOKBACK_HOURS` (24) the socket replays from it (hints are idempotent); older than that, the DO enters gap recovery, which snapshots every known active DID and runs relay discovery. Range snapshots cover the whole `<prefix>` key range, so a `settings/self` opt-out written after `--at` is re-applied by the snapshot of that DID, and deletions are proven by its verified enumeration.
- DIDs first admitted after `--at` reappear when they write again, sign in (the SPA sends notify), or are listed by relay discovery.
- PITR restores storage, not code. To undo a bad version, roll the code back first (`npx wrangler rollback --config worker/wrangler.jsonc`, see [deployment.md](deployment.md)), then restore to a point before that version first ran. A restore to a point before a schema migration followed by the same new code simply re-runs the migration.

## Rebuild from the network

A rebuild is the answer when the index is older than the PITR window, when its integrity is in doubt, or when a new environment should hold the same public data. Everything goes through the production verifier: nothing is trusted that is not signed by the repository's current DID key at its current head.

An empty `IndexDO` (a new environment, or a new Durable Object class introduced by a reviewed wrangler migration) starts with no Jetstream cursor, which is itself a gap: it resumes from the live tail, runs relay `listReposByCollection` discovery for the scrobble and follow collections, and admits each discovered DID with a complete range snapshot. Users of the SPA are also admitted when they next sign in, because it sends `POST /api/v1/notify {did}`. One DID at a time can be re-walked from its signed head with `POST /internal/admin/resnapshot {did}` (202 `scheduled`/`already`; 404 for an unknown or opted-out DID; 503 `queue_full`).

What a rebuild reproduces, and what it cannot:

- **Opt-outs survive.** A user's disconnect is the public, repo-signed `<prefix>.settings/self {indexing: "disabled"}` record ([account-controls.md](account-controls.md)). It is honoured for a DID the index has never seen, so a rebuilt index never re-indexes someone who opted out.
- **Coverage is discovery-bounded.** Only DIDs that relay discovery lists, that write after the rebuild, or that sign in again are found. There is no global completeness promise (ADR §13).
- **Admission is rate-limited** to 50 new DIDs per hour and 1,024 pending snapshot jobs, so a rebuild of 1,000 users takes about 20 hours; history, feeds and statistics fill in as snapshots complete, and global indexing reports `recovering` until gap recovery finishes.

Deleting the production `IndexDO` class is irreversible after the 30-day PITR window and needs a reviewed change to the `migrations` of `worker/wrangler.jsonc`; prefer a PITR restore or a parallel environment.

## What is not covered

The deterministic suites exercise the admin token gate, the strict request bodies and the 30-day window check (`worker/test/composition/admin.test.ts`), and `scripts/test/deploy.test.ts` exercises `pitr-restore.ts` against a fake fetch. The local workerd test runtime does not perform a real point-in-time restore, so an actual restore is an operator action outside the suites (plan case M6.1.3/upgrade_failure, A15). Live recovery evidence belongs to the W6-05 gates.
