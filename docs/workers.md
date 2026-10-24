# Background work: timers, ingest modes and budgets

All background work runs inside the single `IndexDO` ([ADR 0004](adr/0004-cloudflare-workers.md) §5.4–§5.9). There are no worker processes, queues or threads: one Durable Object alarm drives everything, and every step is bounded, durable before it acknowledges anything, and idempotent, because alarms are delivered at least once.

## The alarm multiplexer

Each background task is a row of the `timers` table (`name`, `due_at` in epoch ms). The DO's one alarm is always armed at `min(due_at)` (`worker/src/do/timers.ts`). `alarm()` runs the due timers once each, in this priority order, then re-arms:

| Timer | Cadence | Bound per run | What it does |
| --- | --- | --- | --- |
| `drain` | while hints are due, at most every 2 s | `PLAN` budget (below) | verifies queued hints with `getRecord` proofs and applies them |
| `snapshot` | while snapshot jobs are pending | one job slice | resumes one range snapshot (`getBlocks` MST walk over the prefix key range) |
| `jetstream-watchdog` | 60 s (`socket`) / 5 min (`pulse`) | one connect | keeps the Jetstream connection, or runs one pulse |
| `status-sweep` | hourly | 200 DIDs | `getRepoStatus`: hourly for DIDs active in the last 30 days, daily for the rest |
| `identity-sweep` | daily | 200 DIDs | re-resolves DID documents and checks handles in both directions; a PDS change schedules a snapshot |
| `discovery` | daily, and during gap recovery | 10 pages of 500 | relay `listReposByCollection` for the scrobble, then follow, collection into admission |
| `gc` | daily | 50 DIDs of blocks, 200 hints | deletes `snapshot_blocks` of finished jobs, `verified_commits` older than 7 d, stale `identity_cache` rows and old hint errors |

A timer is claimed (renamed `~running:<name>`) in the same transaction that bumps its failure streak, before its handler starts. A handler that throws, or a DO that dies mid-handler, therefore leaves a durable trace: the timer is rescheduled with backoff (2 s doubling, capped at 5 min) and never dropped, and `timer_failures/<name>` and `timer_failure_streak/<name>` appear in the counters. A run that is still in flight after 15 minutes counts as hung and is taken over. No read-check-write spans an `await`: fetching and verification are async, and each state change is one synchronous `transactionSync` that re-reads its guards.

The cron trigger (`*/5 * * * *`) is not load-bearing. It calls `ensureRunning()`, which re-creates any missing periodic timer and re-arms the alarm, so a lost alarm is back within five minutes. In `pulse` mode it also makes the watchdog due, so each tick starts a pulse (an in-progress pulse is joined, never doubled).

## Ingest modes (`INGEST_MODE`)

Jetstream is a source of hints only; nothing it says is indexed without a signed proof. The subscription is `kinds=commit` for exactly the three configured collections (`<prefix>.scrobble`, `.follow`, `.settings`), alternating between the `JETSTREAM_URLS` hosts on failure.

- **`socket`** (production, Paid). The DO keeps one outbound WebSocket. The watchdog (60 s) reconnects only after a close or error, with backoff of 1 s doubling to 60 s plus jitter, and makes one planned refresh every 15 minutes from the stored cursor; that bounds detection of a half-open connection. Each message is parsed (messages over 64 KiB are dropped and counted) and, in one transaction, its hint is upserted and the cursor advanced, so the cursor never runs ahead of a durable hint. Deploys and runtime updates cut the socket; it resumes from the cursor.
- **`pulse`** (free and staging, Free plan). Every 5 minutes, and on each cron tick, the DO connects from the cursor, drains until an event at least as new as the connect time arrives (the live tail) or 20 s pass, then closes. Lag is at most about 5 minutes and DO duration drops sharply.
- **`off`**. No socket: only notify, snapshots and sweeps run. It is forced whenever `LEXICON_PREFIX` is empty (the namespace gate), and is the right mode for local `wrangler dev`.

**Gap recovery.** On (re)connect the DO enters gap recovery when there is no cursor (first start), Jetstream rejects the cursor, or the cursor is older than `JETSTREAM_LOOKBACK_HOURS` (24, deliberately conservative). It then resumes from the live tail, schedules snapshots for every known active DID in batches of 200 (`ingest_checkpoint.gap_scan_after_did`) and runs one discovery pass. `pending_gap` clears only when all of that has completed, and global indexing stays `recovering` until then. A DID that wrote only during a gap and that the relay does not list is missed until it writes again (ADR §13).

## Hints, proofs and snapshots

Hints name only `(did, collection, rkey)` and come from Jetstream, `POST /api/v1/notify` (our SPA sends it after every write), reconcile, and relay discovery (DID only). The drain processes them by priority (notify, then Jetstream, then reconcile):

1. A suppressed DID's hints are dropped, except for `<prefix>.settings`.
2. An unknown DID goes through admission: at most 50 new DIDs per hour and 1,024 pending snapshot jobs. Admission inserts an inactive user and a snapshot job together; the hint itself is never projected, because activation needs a complete snapshot. A full budget rolls both back (notify answers 503 `queue_full`).
3. 25 or more pending hints for one DID are replaced by one snapshot (`coalesced`).
4. The record is fetched with `com.atproto.sync.getRecord` through SafeFetch (1 MiB, 10 s) after a fresh DID resolution (5-minute cache), and the commit signature, CIDs and MST path are verified. A present record is validated and upserted; a proven absence deletes the projection; an invalid record is excluded with a reason. A proof older than the DID's newest seen revision is retried, then replaced by a snapshot after 5 attempts.
5. No CAR, a missing block or no proof never counts as absence: it schedules a snapshot. Network errors, 5xx and 429 back off per hint (1 s doubling, 5 min cap) and per PDS host (honouring `Retry-After`/`RateLimit-Reset`); after 20 attempts the hint gives up, is counted and becomes a snapshot.

A **snapshot** walks the signed MST of the current head over the key range `[<prefix>., <prefix>/)` only, fetching blocks with `getBlocks` in batches of up to 100 CIDs (8 MiB per response), and applies verified chunks with explicit key intervals, so deletions are proven too. Its frontier persists in `repo_jobs.frontier_json`, so a large repository resumes across alarms, and there is no per-repository record ceiling. A PDS that garbage-collects the old head mid-walk restarts the walk at the new head (at most 5 times). A PDS without `getBlocks` falls back to a streamed `getRepo` capped at 32 MiB. A DID becomes visible only when a complete snapshot commits under its current generation.

## Budgets (`PLAN`)

| Budget | `paid` | `free` |
| --- | --- | --- |
| hints verified per drain run | 200 | 40 |
| subrequests per alarm slice (drain or snapshot) | 200 | 40 |
| snapshot entries applied per slice | 2,000 | 2,000 |
| concurrent proof fetches / per PDS host | 4 / 2 | 4 / 2 |

The Free plan allows 50 subrequests per invocation, so `PLAN=free` must accompany it. Other fixed bounds: notify bodies 2 KiB; notify 60 per minute per client IP (`CF-Connecting-IP`) and 600 per hour per DID, in memory in the singleton (they fail open after a restart); new-DID admission 50 per hour; snapshot jobs 1,024 pending.

## Account status and identity

Account changes are detected without Jetstream account events (amendment A17): a `RepoDeactivated`, `RepoTakendown`, `RepoSuspended` or `RepoNotFound` answer during a proof or snapshot schedules a status check at once, and `status-sweep` bounds the latency to 1 hour for users active in the last 30 days and 24 hours for the rest. An inactive account is hidden immediately; reactivation keeps it hidden until a fresh complete snapshot commits. `identity-sweep` clears a handle that no longer verifies in both directions and resolves conflicts on the unique handle index by clearing the older holder.
