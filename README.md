# AT Protocol music

A Last.fm-style service on AT Protocol: scrobbles and music follows are public
records in each user's repository. This AppView indexes them into listening
history, feeds, statistics, profiles and follow graphs.

The accepted architecture is **one local Node 26 process**, a systemd user
service with SQLite ([ADR 0005](docs/adr/0005-local-node-host-and-compat-apis.md)).
The server is a confidential atproto OAuth client/BFF and owns encrypted OAuth
sessions, cookie/CSRF sessions and a durable write outbox. Public indexing still
requires a signed current-head proof or verified repository snapshot. The
`worker/` package name is retained for stable paths; it does not mean that the
accepted production host is Cloudflare Workers.

**Status:** the Node host, server-session browser, Node browser journeys, and
Node acceptance tooling are implemented. The Workers runtime and test shims are
retired. Deterministic acceptance and local benchmarks do not establish live
OAuth interoperability, two-operator PDS coverage, production SSRF behavior, or
the required soak; those gates and operator evidence remain open. No deployment
or milestone closure is claimed. Rust crates remain a frozen regression and
golden-vector oracle.

## Deterministic checks

Requires the Node version in `.nvmrc` (**26.12.1**), Python 3 and the pinned
contract-validator requirements:

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r api/requirements-contracts.txt
npm run check
python3 scripts/validate_case_map.py --check-tests
```

The gate runs typechecking, Biome, all Vitest projects, contracts, structural
case-map checks and the Node bundle guard. Plan assertions support SQLite
**3.54.0 and 3.54.1**; every run checks its actual query plans and records its
actual engine version.
The official Node binary and the owner's system-SQLite build need not report
the same patch version. No test requires the optional `sqlite_stmt` extension.

```sh
npm test                                      # deterministic Vitest workspace
bash scripts/acceptance/node-interim.sh --wave 7 # interim only, not final acceptance
bash scripts/check_goldens.sh                 # Rust oracle; requires pinned Rust
```

`npm run test:e2e` launches the Node fixture stack. The full acceptance record
is produced by `bash scripts/acceptance/node-backend.sh`; absent live evidence
is reported as blocked, not passed.

## Host/build documentation

Read [local Node installation](docs/deploy/local-node.md),
[deployment](docs/deployment.md), [exposure](docs/deploy/exposure.md),
[operations](docs/operations.md), and [backup/restore](docs/backup.md).
Build foundations use `npm run build:web` and
`npx tsx scripts/build-server.ts --check`. The retired Workers deployment
procedure and Rust release workflow are not Node release procedures.
No live acceptance run is recorded. Publication remains fail-closed until
reviewable namespace authority evidence is supplied.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Pure validation, music keys, cursors, write policy and record keys |
| `packages/atproto` | Identity, SafeFetch, CAR/commit/MST verification, snapshots, Jetstream and test fakes |
| `worker/src/node`, `worker/src/app` | Node host, transport, composition, process lifecycle and indexing core |
| `worker/src/bff`, `worker/src/outbox` | Confidential OAuth, sessions, CSRF and server publishing |
| `worker/src/do` | Host-neutral schema, ingestion, reads and timers (historical directory name) |
| `web` | Preact SPA using server sessions and Node-backed account screens |
| `scripts` | Checks, build, installer, admin, Node acceptance and historical live evidence tools |
| `crates`, `tests/goldens` | Frozen Rust oracle and shared vectors |

## Contracts and evidence

- [OpenAPI](api/openapi.yaml), [API plan](docs/planning/API.md),
  [case map](docs/verification/ts-case-map.json)
- [Current and historical storage](docs/storage.md), [Rust schema](docs/storage-rust.md)
- [Node wave plan](docs/planning/node-waves.json), [draft amendments](docs/planning/AMENDMENTS-node.md)
- [Historical validation receipt](docs/VALIDATION.md), [historical milestone counts](docs/MILESTONE_STATUS.md)
- [Live evidence inventory](docs/verification/live-evidence.json): empty/historical;
  it is not accepted Node release evidence

GitHub issue contracts still need explicit reconciliation with ADR 0005.
Fixture passes, mapping existence and blocked/no-environment scripts never
substitute for actual OAuth, lifecycle, federation, social/statistics or restore
observations bound to the deployed Node commit and bundle.
