# Operations

The Prometheus listener of the Rust candidate is replaced by three Workers-native views (amendment A16): **Workers Logs**, the **`counters`** table and **`GET /internal/admin/status`**. Public health and indexing truth stay on `/health/*` and `/api/v1/meta`. Cost is watched in the Cloudflare dashboard.

## Health and indexing (public)

| Route | Meaning |
| --- | --- |
| `GET /health/live` | 200 `{status: "live"}`, answered by the Worker without touching the IndexDO |
| `GET /health/ready` | 200 `{status: "ready"}` when the IndexDO's schema is current; 503 `not_ready` when the storage was written by newer code (`too_new`), the configuration does not parse, or the DO cannot answer |
| `GET /api/v1/meta` | `stage` (`backend`; `product` once publication is enabled; `scaffold` while storage is not ready), `capabilities` (`read`, `stats`, `follows`, `notify`, `indexing`, plus `publication` only with an owned prefix and ownership evidence), `lexiconPrefix`, and the global `indexing` state |

`indexing.state` is `recovering` until the first gap recovery completes, `current` while the socket (or the last pulse) is fresh, and `stale` when the socket has been disconnected for more than 5 minutes (two pulse intervals in `pulse` mode). A PDS or Jetstream outage makes indexing stale; it does not make `/health/ready` fail. `deploy.sh --smoke-only` checks all three routes.

## Workers Logs

`observability.enabled` is on in `worker/wrangler.jsonc`, so every Worker and IndexDO invocation is in Workers Logs (dashboard: Workers & Pages → `atmusic` → Logs; or `npx wrangler tail --config worker/wrangler.jsonc [--env <env>]` for a live stream). Application events are one JSON line each, `{"level", "event", …fields}`:

- **errors**: `alarm.failed`, `drain.fetch_error`, `drain.verify_error`, `drain.hint_error`, `snapshot.error`, `snapshot.slice_error`, `status.fetch_error`, `status.job_error`, `status_sweep.error`, `identity_sweep.error`, `discovery.fetch_error`, `jetstream_message_failed`, `index.rpc_failed`, `index.migration_failed`, `index.config_invalid`, `config.cursor_key_invalid`, `cron.ensure_running_failed`, `request.failed`;
- **warnings**: `alarm.timer_failed`, `drain.verify_failed`, `snapshot.failed`, `status.check_failed`, `jetstream_connect_failed`, `jetstream_cursor_rejected`, `jetstream_disconnected`, `resolve_upstream_error`, `request.server_error`, `admin.pitr_scheduled`;
- **info**: `jetstream_connected`, `jetstream_planned_refresh`, `snapshot.finished`, `gc.done`.

The logger never writes record contents. It replaces the `CURSOR_KEY` and `ADMIN_TOKEN` values and any `Bearer` value wherever they occur, and drops any field whose name looks like a credential. Error responses carry a `requestId` (a UUID) that also appears in the matching log line, never a stack trace or file path. `index.config_invalid` or `config.cursor_key_invalid` right after a deploy means a var or secret is wrong: `/health/ready` stays 503 until it is fixed.

## Counters

The `counters` table holds monotonic operational counts (`name`, `label`, `value`), written in the same transaction as the event they count. The ones to watch:

| Counter | Labels | Meaning |
| --- | --- | --- |
| `admitted` | hint source | new DIDs admitted |
| `excluded` | reason | invalid records excluded from the index |
| `verify_failed` | error code | proofs that failed verification (fail closed; nothing applied) |
| `proof_fetch_failed` | error | `getRecord` fetches that failed |
| `hint_gave_up`, `hint_expired`, `hint_dropped`, `coalesced` | | hints abandoned after 20 attempts, expired, dropped, or coalesced into a snapshot |
| `snapshot_scheduled`, `snapshot_completed`, `snapshot_failed`, `snapshot_restarts`, `snapshot_superseded`, `snapshot_reclaimed`, `snapshot_getrepo_fallback`, `snapshot_rescan` | reason or code | range snapshot lifecycle |
| `gap_recovery` | | gap recoveries entered |
| `jetstream_invalid`, `jetstream_notice` | | unparseable or oversize messages; Jetstream notices |
| `status_checked`, `status_check_failed`, `account_hidden`, `account_reactivating` | outcome | `getRepoStatus` results and account visibility changes |
| `handle_cleared`, `handle_conflict`, `pds_changed`, `identity_sweep_failed` | | identity sweep results |
| `discovery_pages`, `discovery_passes`, `discovery_failed`, `discovery_invalid` | | relay discovery |
| `timer_failures`, `timer_failure_streak` | timer name | failed background steps (all-time, and consecutive; the streak row is deleted on success) |

A growing `timer_failure_streak` for one timer, a rising `verify_failed`, or `snapshot_failed` without matching `snapshot_completed` are the signals to look at Workers Logs.

## Admin status

With the `ADMIN_TOKEN` secret set, `GET /internal/admin/status` returns the IndexDO's view in one read: the schema state, global indexing, the ingest checkpoint (mode, cursor, last event time, connected, pending gap, host index), hint totals (all and due), job counts by kind and state, and every counter.

```sh
read -rs ADMIN_TOKEN && export ADMIN_TOKEN
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://music.214510.xyz/internal/admin/status
```

Without the secret the admin routes do not exist (404, like any unknown path); a request without a bearer token is the same 404, and a wrong token is 401. `POST /internal/admin/pitr` ([backup.md](backup.md)) and `POST /internal/admin/resnapshot {did}` (re-walk one DID from its signed head) sit behind the same gate. Durable Objects have no public address, so the Worker's admin routes are the only way in.

## Cost monitoring

Production runs on Workers Paid (ADR §11; [deployment.md](deployment.md#plan-tier)). Watch, in the Cloudflare dashboard:

- **Workers & Pages → `atmusic` → Metrics**: requests, errors and CPU time of the Worker (10M requests/month are included).
- **Durable Objects** (the `IndexDO` namespace): requests (1M/month included; Jetstream messages and alarms count), duration in GB-s (400k/month included; one resident DO uses about 332k), rows read (25B included) and rows written (50M included), and stored data (5 GB-month included; the DO caps at 10 GB).
- **Billing → Usage** and a **billing notification** on the account, so an overage is noticed in days, not at the invoice.

The expected production bill is about $6–8/month at 1,000 users and $5 at hobby scale. Levers if it grows: the exact statistics cache already cuts rows read; `INGEST_MODE=pulse` trades up to 5 minutes of lag for much lower DO duration; per-DID sharding is the documented way past the 10 GB ceiling and is not built. On the Free plan (staging, free) quotas fail hard: `/api/*` errors while the static SPA keeps serving. The 24-hour socket soak (W6-05) measures reconnects, lag, billed DO requests and CPU per alarm for the deployed version.
