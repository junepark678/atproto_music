# AT Protocol music

A Last.fm-style service on AT Protocol: scrobbles and music follows are public records in each user's own repository, and this AppView indexes them into listening history, feeds, statistics, profiles and follow graphs. Accounts keep their data on their own PDS.

It runs entirely on Cloudflare Workers ([ADR 0004](docs/adr/0004-cloudflare-workers.md)): one Worker, one SQLite-backed Durable Object holding the whole index, Static Assets for the Preact SPA, one cron trigger and one secret. The browser SPA is the atproto OAuth client and writes to the user's PDS; the server holds no user credentials. Every record is indexed only after a signed current-head proof (`getRecord`) or a verified range snapshot (`getBlocks` MST walk).

**Status:** the TypeScript rebuild is implemented and covered by deterministic workerd and browser suites; the live acceptance gates (OAuth and publishing on two independent PDSs, Jetstream coverage, a 24 h socket soak) are recorded per deployed Worker version and report `blocked` until their prerequisites exist. The Rust crates under `crates/` are kept, frozen, as the golden-vector oracle.

## Quickstart

Requires Node 24 LTS (`.nvmrc`) and, for the contract checks, Python 3 with `api/requirements-contracts.txt`.

```sh
npm ci
bash scripts/check-ts.sh                 # the repository gate: tsc -b, biome, vitest, contracts, case map, bundle guard
```

Run it locally:

```sh
cp worker/.dev.vars.example worker/.dev.vars       # set CURSOR_KEY to the output of: openssl rand -hex 32
npx tsx scripts/gen-config.ts --env local          # loopback OAuth client hint
npm run build:web                                  # vite build into web/dist
npx wrangler dev --config worker/wrangler.jsonc --var INGEST_MODE:off
# http://127.0.0.1:8787  (SPA dev server with hot reload: npm run dev --workspace @atmusic/web)
```

Deploy (see [deployment](docs/deployment.md) for the one-time setup: owned domain, NSID ownership, secrets):

```sh
bash scripts/deploy.sh --dry-run         # refuses an empty or fixture prefix and a missing CURSOR_KEY secret
bash scripts/deploy.sh --initial         # first deploy of an environment (applies the Durable Object migration)
bash scripts/deploy.sh                   # later deploys: versions upload + versions deploy, then a smoke test
```

Tests: `npm test` (all vitest projects: `packages/*`, `worker`, `web`, `scripts`), `npm run test:e2e` (Playwright against `wrangler dev` and a local `@atproto/dev-env` PDS), `bash scripts/check_goldens.sh` (Rust-oracle parity). The deterministic suites use the frozen clock `2026-01-15T12:00:00Z`, seeded randomness and no network.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | pure logic shared by Worker and SPA: validation, music keys, cursors, write policy, record keys |
| `packages/atproto` | Workers- and browser-safe I/O: SafeFetch, identity, CAR/commit/MST verification, range snapshots, Jetstream parsing |
| `worker` | the Worker entry, router and HTTP routes, and the `IndexDO` (schema, ingestion, reads, timers) |
| `web` | the Preact SPA: browser OAuth client, IndexedDB outbox, screens |
| `scripts` | gate, build config (`gen-config.ts`), bundle guard, deploy, admin and live-gate tools |
| `crates`, `tests/goldens` | the frozen Rust oracle and its golden vectors |

## Documentation

- [Deployment](docs/deployment.md), [operations](docs/operations.md), [backup and recovery](docs/backup.md)
- [Background work: timers, ingest modes, budgets](docs/workers.md), [storage schema](docs/storage.md)
- [Cursors](docs/cursors.md), [profiles](docs/profiles.md), [follows](docs/follows.md), [deletion](docs/deletion.md), [export and disconnect](docs/account-controls.md)
- [API contract](docs/planning/API.md) (as amended by ADR 0004 §9), [OpenAPI](api/openapi.yaml), [test contract](docs/planning/TESTING.md), [case map](docs/verification/ts-case-map.json)
- [MVP decisions](docs/planning/MVP.md), [Workers wave plan](docs/planning/workers-waves.json), [Milestones](https://github.com/junepark678/atproto_music/milestones)

Fixture-only passes never substitute for the live PDS, relay and browser gates.
