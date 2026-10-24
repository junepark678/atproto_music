# Deploying atmusic on Cloudflare Workers

atmusic is one Worker (`atmusic`) with one SQLite-backed Durable Object (`IndexDO`, a single instance), Workers Static Assets for the SPA, one cron trigger (`*/5 * * * *`) and one required secret (`CURSOR_KEY`). There is no server, database service, reverse proxy, encryption key or OAuth credential to operate: the browser SPA is the OAuth client and writes to each user's own PDS ([ADR 0004](adr/0004-cloudflare-workers.md) §1, §9.2 A1–A3).

| Piece | Where it is configured |
| --- | --- |
| Worker, DO binding and migration, cron, routes, vars | [`worker/wrangler.jsonc`](../worker/wrangler.jsonc) |
| Secrets `CURSOR_KEY` (required), `ADMIN_TOKEN` (optional) | `wrangler secret put`, per environment |
| OAuth client metadata and `_headers` (CSP) | generated at build time by `scripts/gen-config.ts` into `web/public`, copied into `web/dist` |
| Deploy | [`scripts/deploy.sh`](../scripts/deploy.sh) locally, [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) in CI |

This guide deploys the code. It does not close the live acceptance gates (OAuth on two independent PDSs, Jetstream coverage, the 24 h socket soak; W6-05), which are recorded per Worker version id.

## Deployment values

The owner decided these on 2026-10-24 (ADR §15 Q3). They are build- and deploy-time configuration in `worker/wrangler.jsonc`, not code:

| Value | Production |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://music.214510.xyz`, a custom domain on the owner's zone `214510.xyz` |
| OAuth `client_id` | `https://music.214510.xyz/oauth/client-metadata.json`; it must never change once anyone has signed in |
| `LEXICON_PREFIX` | `dev.pythonplayer123.music`: collections `dev.pythonplayer123.music.scrobble`, `.follow` and `.settings` |
| NSID authority | `music.pythonplayer123.dev`, in the owner's zone `pythonplayer123.dev` |
| Plan | Workers Paid (`PLAN=paid`, `INGEST_MODE=socket`) |

`com.example.atmusic` is the test fixture prefix. It must never be published: `gen-config.ts`, `check-bundle.ts` and `deploy.sh` all refuse it, as well as an empty prefix and any origin or prefix that differs from the env's vars in `worker/wrangler.jsonc`. Another operator copies [`config/atmusic.workers.example.jsonc`](../config/atmusic.workers.example.jsonc) over `worker/wrangler.jsonc` and replaces every example value with a domain and NSID prefix they own.

## Environments

`env.free` and `env.staging` are wrangler named environments. Each one deploys as its own Worker (`atmusic-free`, `atmusic-staging`), so each has its own Durable Object namespace (its own index), its own secrets, and, because the hostname differs, its own OAuth `client_id`.

| Env | Worker | Origin | `PLAN` | `INGEST_MODE` | Use |
| --- | --- | --- | --- | --- | --- |
| production (top level) | `atmusic` | `https://music.214510.xyz` | `paid` | `socket` | the public service; Workers Paid |
| `staging` | `atmusic-staging` | `https://music-staging.214510.xyz` | `free` | `pulse` | pre-release checks against the real network |
| `free` | `atmusic-free` | `https://music-free.214510.xyz` | `free` | `pulse` | development and private hobby use on the Free plan |

The staging and free hostnames are subdomains chosen for this deployment, not owner decisions; change them in `worker/wrangler.jsonc` before anyone signs in on those environments if the owner prefers others. `durable_objects` and `vars` are not inheritable in wrangler, so both named envs re-declare them; `limits` is cleared (`cpu_ms` is a Paid-only setting).

## One-time setup

1. **Account and plan.** Use the owner's Cloudflare account, which holds both zones. Subscribe it to Workers Paid before the first production deploy (see [Plan tier](#plan-tier)).
2. **Custom domain.** Nothing is created by hand: the `routes` entry `{ "pattern": "music.214510.xyz", "custom_domain": true }` makes the first deploy attach the hostname to the Worker, create its DNS record and issue its certificate. A `*.workers.dev` URL or a route on a zone the owner does not control is not acceptable, because the `client_id` is derived from the origin and must never change.
3. **NSID ownership.** Publish the `_lexicon.music.pythonplayer123.dev` TXT record that atproto lexicon resolution reads (`did=<the DID that publishes the lexicon schema records>`) in zone `pythonplayer123.dev`. Then set `NAMESPACE_OWNERSHIP_REF` in each env's vars to a reviewable reference to that record. Until it is set, `parseConfig` reports `publication: false`: ingestion of the decided collections runs, `/api/v1/meta` omits the `publication` capability and the SPA hides its write UI.
4. **Secrets**, once per environment (add `--env staging` or `--env free` for those). Run them before the first deploy; `wrangler secret put` offers to create the Worker if it does not exist yet.

   ```sh
   openssl rand -hex 32 | npx wrangler secret put CURSOR_KEY --config worker/wrangler.jsonc
   # Optional: enables /internal/admin/{status,pitr,resnapshot}; at least 32 characters.
   openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.jsonc
   npx wrangler secret list --config worker/wrangler.jsonc
   ```

   `CURSOR_KEY` is the HMAC application key for pagination cursors (at least 32 bytes, hex; derived exactly as `crates/core/src/cursor.rs`). Rotating it invalidates every outstanding cursor (clients get 400 `invalid_cursor` and restart their traversal) and nothing else. `ADMIN_TOKEN` is compared in constant time; keep it in a password manager, because `pitr-restore.ts` needs its value. Neither value is ever logged, and neither belongs in a file in the repository.
5. **GitHub environments** (only for the workflow). Create environments named `production`, `staging` and `free`, each with required reviewers, the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. Create the token from the "Edit Cloudflare Workers" template, restricted to the owner's account and the `214510.xyz` zone.
6. **First deploy.** A pending Durable Object migration (the v1 `IndexDO` class) cannot go through `wrangler versions upload`, so the first deploy of each environment uses `wrangler deploy`:

   ```sh
   bash scripts/deploy.sh --dry-run          # everything except the upload
   bash scripts/deploy.sh --initial          # wrangler deploy; applies migration v1
   ```

   or dispatch the workflow with `initial: true`. The IndexDO runs its schema migration in its constructor on first use, so there is no migrate step. The smoke test then expects `/health/ready` 200 and `/api/v1/meta` with the configured `lexiconPrefix` and a non-`scaffold` stage. Indexing starts `recovering`: the first Jetstream connection has no cursor, so gap recovery and relay discovery run (see [workers.md](workers.md)).

## Routine deploys

```sh
bash scripts/deploy.sh --dry-run                 # preflight, gen-config, vite build, wrangler deploy --dry-run
bash scripts/deploy.sh                           # the full deploy (production)
bash scripts/deploy.sh --env staging             # a named env
```

`deploy.sh` runs, in order:

0. **Preflight**, before anything is written or uploaded. It refuses (exit 1, every problem listed):
   - an empty, invalid or fixture `LEXICON_PREFIX`, a non-https `PUBLIC_ORIGIN`, a route off the origin's host, or `PUBLIC_ORIGIN`/`LEXICON_PREFIX` environment overrides that differ from the env's vars;
   - a Worker without the `CURSOR_KEY` secret, as `wrangler secret list` reports it (names only; secret values are never read), or secrets that cannot be listed.
1. `bash scripts/check-ts.sh`, the repository gate (skipped by `--dry-run` and `--skip-checks`).
2. `npx tsx scripts/gen-config.ts --env <env>`: `web/public/oauth/client-metadata.json` and `web/public/_headers`.
3. `npm run build:web` (`vite build` into `web/dist`).
4. `npx tsx scripts/check-bundle.ts --env <env> --release`: runs `wrangler deploy --dry-run --outdir worker/dist`, refuses a bundle that contains test seams (`test-support`, `fixedClock`, the fixture transport, `node:crypto`) or exceeds 3 MiB gzip, refuses built assets whose metadata or headers differ from the configured origin and prefix, and prints the bundle SHA-256.
5. `wrangler versions upload`, recording the Worker version id (with `--initial`: `wrangler deploy`).
6. `wrangler versions deploy <id>@100% --yes`.
7. The smoke test: `GET /health/live`, `/health/ready` and `/api/v1/meta` on the origin, with retries.

Every wrangler command takes `--config worker/wrangler.jsonc` and, for a named env, `--env <env>`. `WRANGLER` may name another wrangler executable; it authenticates with `CLOUDFLARE_API_TOKEN` or a prior `wrangler login`. A real deploy writes `work/deploy/<env>-<version id>.json` with the env, origin, prefix, version id, bundle SHA-256 and commit: the release evidence of A19, which replaces the old musl artifact checksum. `bash scripts/deploy.sh --preflight` and `--smoke-only` run those steps alone.

The workflow (`Deploy Worker`, manual dispatch only) runs the same steps in the environment-protected job, with the version id and bundle SHA-256 in the job summary. It never sets Worker secrets.

## Rollback and failed upgrades

- **Code.** `npx wrangler rollback --config worker/wrangler.jsonc [--env <env>]`, or `wrangler versions deploy <previous id>@100%`. The version ids are in the deploy evidence and `wrangler versions list`.
- **Storage is not rolled back with code.** Schema migrations are forward-only. A version older than the stored schema keeps answering `/health/ready` with 503 (`too_new`) and `meta.stage: scaffold` instead of reading a schema it does not know. A migration that fails rolls back completely inside its `transactionSync`, leaving the previous schema version.
- **Bad data after a bad version.** Restore the IndexDO to a point before it with Durable Object point-in-time recovery, or rebuild from the network; see [backup.md](backup.md).

## Plan tier

Workers Paid ($5/month minimum) is required for production (ADR §11, §15 Q4):

- the always-on Jetstream socket (`INGEST_MODE=socket`) keeps the one DO resident at about 332k GB-s/month, inside Paid's 400k included, but close to the Free plan's 13k GB-s/day;
- `PLAN=paid` sets the alarm slice budgets to 200 hints and 200 subrequests per slice; Free's 50-subrequest limit forces 40 (`PLAN=free`);
- `limits.cpu_ms: 30000` exists only on Paid.

The estimate for 1,000 users, 30k scrobbles/day and 300k API calls/day is about $6–8/month plus the domain; hobby scale (100 users, 1k scrobbles/day) is the $5 minimum. The Free plan (staging, free) runs `pulse` mode, which keeps DO duration well under the daily allowance and holds about 8k ingested records/day and 90k API calls/day. Free quotas fail hard: `/api/*` errors while the static SPA keeps serving. One DO holds 10 GB, about 10M scrobbles. [operations.md](operations.md) covers cost monitoring.

## Local development

```sh
npm ci
cp worker/.dev.vars.example worker/.dev.vars     # then set CURSOR_KEY=$(openssl rand -hex 32)
npx tsx scripts/gen-config.ts --env local        # loopback OAuth client hint, no CSP
npm run build:web
npx wrangler dev --config worker/wrangler.jsonc --var INGEST_MODE:off   # http://127.0.0.1:8787
```

`--var INGEST_MODE:off` keeps a local Worker from opening a socket to the public Jetstream; notify, snapshots and sweeps still run. The SPA's own dev server (`npm run dev --workspace @atmusic/web`, http://127.0.0.1:5173) proxies `/api` and `/health` to it. Local sign-in uses the atproto loopback `client_id` (`http://localhost?redirect_uri=…`, ADR §5.1). End-to-end tests run against a local `@atproto/dev-env` PDS (`npm run test:e2e`); the deterministic suites never touch the network (`npm test`, `bash scripts/check-ts.sh`).
