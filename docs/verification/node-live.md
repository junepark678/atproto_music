# Node live evidence (schema v3)

Node evidence is separate from historical Workers evidence. An inventory and
each gate document use `schemaVersion: 3`, `runtime: "node"`, and
`fixtureOnly: false`. The current `docs/verification/live-evidence.json` is a
legacy Workers record and stays blocked under the Node verifier; it is not a
Node acceptance fixture.

## Release identity and trust boundary

The release is identified by the full, nonzero 40-hex source commit and the
nonzero SHA-256 of the production `worker/dist/node/main.mjs` bytes (ADR 0005
B11). The inventory records these under `release`:

```json
{
  "schemaVersion": 3,
  "runtime": "node",
  "fixtureOnly": false,
  "release": { "commit": "<40 lowercase hex>", "bundleSha256": "<64 lowercase hex>" },
  "prerequisites": {
    "ownedLexiconPrefix": "<owned namespace>",
    "publicHttpsOrigin": "https://<production host>",
    "identities": [
      { "did": "<dedicated DID A>", "pds": "https://<PDS A>" },
      { "did": "<dedicated DID B>", "pds": "https://<independent PDS B>" }
    ],
    "independentPdsOperatorsVerified": true,
    "jetstreamCoverageVerified": true
  },
  "gates": { "<gate name>": { "...": "gate document" } }
}
```

Each gate document repeats `schemaVersion`, `runtime`, `fixtureOnly`, and has
top-level `gate`, `result`, `commit`, `bundleSha256`, `recordedAt`,
`testCommand`, `origin`, `lexiconPrefix`, `pds`, `subjects`, `results`, and
`cleanup` fields. A `failed` gate also carries a nonempty `failures` array; a
`blocked` gate carries a nonempty `missing` array. A standalone gate does not
need an inventory or nested `release` object. The verifier validates only the
named gate in that mode. Both gate and inventory identity must match
independently trusted values supplied to the verifier; the verifier never
learns the expected release from the evidence itself.
`--artifact` hashes the artifact locally. If both it and `--bundle-sha256` are
given, their hashes must match.

```sh
# Node inventory (schema v3 auto-dispatches to the Node verifier)
python3 scripts/verify_live_evidence.py inventory.json --commit "$COMMIT" --bundle-sha256 "$SHA256"
python3 scripts/verify_live_evidence.py inventory.json --commit "$COMMIT" --artifact worker/dist/node/main.mjs

# One Node gate, validated independently; --node also makes this mode explicit
python3 scripts/verify_live_evidence.py --gate gate.json --node --commit "$COMMIT" --bundle-sha256 "$SHA256"

# An explicit Node request with missing identity is BLOCKED
python3 scripts/verify_live_evidence.py --node
```

Exit codes are **0 PASS**, **1 FAIL**, and **2 BLOCKED**. Missing, malformed,
zero, or mismatched expected/recorded identity, a fixture or schema/runtime
confusion, missing prerequisites, invalid provenance, and unknown gates block.
A gate can be FAIL only with valid independent identity and provenance plus a
nonempty `failures` list. An inventory can be FAIL only when its own identity
and prerequisites and the failed gate's identity/provenance are valid. A gate
with `result: "passed"` cannot carry failures. Inventory PASS requires every
required gate to be complete and supported.

The verifier shares applicable structural checks for public HTTPS origin,
owned namespace, PDS identities, result shape, and cleanup. It does not infer
confidential Node OAuth interoperability from the historical Workers browser
OAuth evidence. The accepted Node OAuth contract requires, for each of the two
PDS identities, a sealed host session row showing `private_key_jwt`, DPoP-bound
tokens, and a refresh token; the observed token subject must match the DID. The
issuer hostname observed from that sealed session must match the DID's
prerequisite PDS host. The granted scope must contain `atproto` and create,
update, and delete on each of
the four Node collections `<prefix>.scrobble`, `<prefix>.follow`,
`<prefix>.settings`, and `<prefix>.love`; any `transition:*` token invalidates
that grant. This four-collection rule is separate from the historical Workers
`full_repo_grant` rule, which remains three collections.

The same authenticated session must exercise all twelve direct PDS CRUD
permissions (create, update, delete on each collection) with successful
responses and verified record state. It must also exercise the seven app
write intents (`scrobble.create`, `scrobble.delete`, `follow.put`,
`follow.delete`, `love.put`, `love.delete`, and `settings.put`) and verify
their terminal operation state and record presence or absence. After the app's
sign-out completes, the host must confirm the sealed local session row is gone
and make a refresh request with the captured pre-sign-out refresh token; only
an upstream OAuth `invalid_grant` rejection proves revocation. Evidence may
contain booleans, outcome enums, DIDs, collection names, statuses, and CIDs,
but never tokens, cookies, passwords, or DPoP/private-key material.

The Node OAuth driver and strict verifier contract now implement these
observations. `oauth` is a supported Node gate, but no live OAuth result is
recorded by this change. The gate still exits 2 before browser or network work
when prerequisites are missing, and a PASS requires two independently
operated PDS identities plus release-bound evidence that satisfies every
check above. Enabling the evidence contract does not itself complete the live
OAuth milestone or the full Node inventory.

The Node SSRF probe driver is ported. `npx tsx scripts/live/ssrf_probe.ts
--emit-probe` emits a host-side probe using the production pinned transport;
running the emitted probe is an explicit operator action and makes network
requests to the configured controlled names and private-address literals. The
runner writes its detailed result to a newly created owner-only (`0600`) local
file. That private artifact contains the controlled hostnames, exact probe
target URLs, and DNS answer addresses needed for offline validation. Treat it
as sensitive operational data: do not publish it or commit it. The runner's
console and the schema-v3 gate evidence contain only an allowlisted summary;
they exclude probe target URLs, hostnames, addresses, response bodies, headers,
and raw exception messages. The common evidence envelope still includes the
configured public origin. Its required inputs are
`ATMUSIC_LIVE_SSRF_HOSTS` (`label=host` pairs for `rfc1918`, `loopback`, and
`metadata`) and `ATMUSIC_LIVE_SSRF_PROBE_RESULT` (absolute result-file path),
along with the common Node release identity and origin/prefix. The no-input
gate invocation exits 2 before reading a result or opening a connection.
`ssrfProbe` remains blocked by this verifier: its probe-result provenance and
acceptance contract are not approved, and the gate is not enabled in
`NODE_SUPPORTED_GATES`. A recorded probe cannot change that.

The Node socket-soak collector records protected Unix-socket observations, but
it also remains blocked until Node metrics, thresholds, and restart/reconnect
semantics are accepted. Workers Cloudflare/DO analytics do not stand in for
Node acceptance. Unknown gates never enable PASS.

Run `npx tsx scripts/live/node_oauth_check.ts` only against the deployed Node
origin. It requires the Node release identity, both independently operated
PDS identities and implementation names, `ATMUSIC_LIVE_HANDLE_A` and
`ATMUSIC_LIVE_HANDLE_B`, and either both `ATMUSIC_LIVE_PASSWORD_A` and
`ATMUSIC_LIVE_PASSWORD_B` or `ATMUSIC_LIVE_OAUTH_INTERACTIVE=1`. Its optional
`ATMUSIC_LIVE_OAUTH_TIMEOUT_S` accepts 30–3600 seconds. Missing or malformed
inputs produce blocked schema-v3 evidence before any network or browser
operation. With valid inputs it performs the sealed-session observation,
direct CRUD, seven app writes, sign-out, and upstream refresh-rejection checks.
No live OAuth gate has yet been executed against an accepted release.

### Dev-env OAuth preflight (advisory only)

`npx tsx scripts/live/devenv_oauth_check.ts` validates only the presence and
shape of `ATMUSIC_DEVENV_PDS_URL` and `ATMUSIC_DEVENV_HTTPS_ORIGIN`. The origin
must be a bare HTTPS origin; the PDS value must be a bare HTTP or HTTPS origin.
The client ID is derived from the origin's `/oauth/client-metadata.json`, and
the production client authenticates with `private_key_jwt`; no client secret
is needed. The local regression
`worker/test/node/bff/devenv-oauth.test.ts` exercises the production confidential
client against a real `@atproto/dev-env` PDS: exchange, the four repository
grants, create/delete, replacement-session revocation, and provider token-store
cleanup. It uses a host-restricted fixture transport and does not contact the
Internet. The test drives the provider authorization decision through its
server APIs rather than exercising its browser consent UI.

`devenv_oauth_check.ts` remains a preflight only. It performs no network,
socket, child-process, or browser operation and exits 2 with a blocked document
even when both inputs are valid; it does not run the fixture suite or produce
operator evidence. The local fixture suite is run separately as a deterministic
regression and does not consume the preflight's inputs.

Its schema-v3 document has `runtime: "node"`, `fixtureOnly: true`,
`gate: "devenvOauth"`, and `result: "blocked"`. It is not one of the five
required production gates and must not be added to `live-evidence.json` or used
to satisfy the production `oauth` gate. This advisory result does not prove
live confidential-client interop with an independently operated provider and
does not complete N6-02.

### Node ingest driver (N6-02 slice)

Run `npx tsx scripts/live/node_ingest_check.ts` only against the deployed Node
origin. It uses the app's `/signin` UI for identity A, then reads the active
session and `csrfToken` from `GET /api/v1/auth/session`; it does not observe or
claim results about the server-side OAuth exchange. The scrobble is submitted
to `POST /api/v1/scrobbles`, its operation is polled until `succeeded`, and
`/api/v1/records/status` is polled until `indexed`. The succeeded operation
CID, indexed status CID, and independent production `verifyRecordAt` proof CID
must all match.

Identity B uses `ATMUSIC_LIVE_APP_PASSWORD_B` only with PDS B
`com.atproto.server.createSession`, `com.atproto.repo.createRecord`, and
`com.atproto.repo.deleteRecord`. The gate waits for its URI to index and checks
the PDS write response CID against status and independent proof CIDs. Both
records are deleted and must reconcile to `absent`; the independent
`verifyAbsent` proof must use the existing `exclusionProof` or `snapshot`
method and a head newer than the present proof.
The evidence records those method fields for pairing with the PDS capability
evidence.

The Node outbox persists operation `updatedAt` when the write succeeds and
queues an indexing hint in the same transaction. Jetstream events also queue
hints; neither source marks the record indexed. The independent IndexCore
proof/apply path drives `records/status` to `indexed` or `absent`, which is why
the gate waits for status and then fetches a fresh record proof. Publish
`lagMs` is an approximate wall-clock interval from the successful write
timestamp to the first indexed status observation. For the direct PDS B write,
the PDS create answer is the starting timestamp. Both include status polling
delay and possible clock skew; they are not upstream request latency or a
precise Jetstream latency measurement. Delete `lagMs` is measured from the
successful delete operation timestamp for A or the PDS delete response for B
to the first absent status observation, with the same polling and clock-skew
limits. Cleanup attempts both deletes after a failure and records each created
AT URI as deleted and reconciled, delete accepted but absence unproven, or
`LEFT BEHIND` so an operator can follow up.
The ephemeral browser context is discarded; this gate makes no upstream
session-revocation claim.

Required inputs are the Node release identity and origin/prefix, the two PDS
identities/endpoints/implementation names and independence evidence,
`ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF`, handles A and B,
`ATMUSIC_LIVE_APP_PASSWORD_B`, and either `ATMUSIC_LIVE_PASSWORD_A` or
`ATMUSIC_LIVE_OAUTH_INTERACTIVE=1`. The timeout is optional and defaults to
300 seconds. Missing prerequisites are listed in a blocked schema-v3 document
and cause exit 2 before browser launch or network requests. This driver does
not contact Last.fm or ListenBrainz. It is operator-run and is not invoked by
the acceptance suite; deterministic no-network, inert-import, and mocked-flow
tests do not establish live acceptance.

## Historical compatibility and live-driver boundary

Without `--node`, schema-v1/v2 Workers inventory and gate documents continue
through the historical Workers validators, including Worker UUID checks. That
path is regression-tested and cannot satisfy Node CLI acceptance. Schema-v3
Node documents dispatch to the Node verifier; `--node` explicitly requires
Node mode even for a standalone gate.

N6-02 requires every operator driver to validate its required
`ATMUSIC_LIVE_*` inputs before making any network request. If any are missing,
the driver must exit **2**, print a blocked document listing each missing
variable name, and make no network request. No gate contacts Last.fm or
ListenBrainz. No Node live acceptance has been recorded. A deterministic test
now exercises the confidential client against a local `@atproto/dev-env` PDS,
but production OAuth interop with independently operated providers remains
deferred, as do the operator SSRF probe and Node soak. Full N6-02 and M6 live
acceptance stay open.

## Shared harness validation

Drivers may declare `NodeGateSpec.observations` as top-level `results` keys
with an `accept(value)` validator. Every declared key must be an own property
of `results`, and its validator must return `null` to accept it. Missing keys,
rejections, and validator exceptions produce `failed` evidence with an
`observation <key>:` diagnostic. Omitting this opt-in declaration preserves
existing driver behavior; it does not establish that a driver has complete
accepted observations or extend verifier gate support.

The optional synchronous `localChecks(env)` hook runs only after all ordinary
requirements and `extraChecks` succeed, before the gate body. It is restricted
by contract to filesystem reads and local tools such as `git` and
`node --version`; it must not perform network or browser work. Reported problems
and exceptions produce blocked evidence and prevent body execution. This is
an ordering contract, not a sandbox for arbitrary hook code.

Shared output redacts supplied secret environment values, including key,
cookie and CSRF inputs, and absolute home/runtime paths under `/home/` and
`/run/user/`. URL sanitization decodes mixed percent and Unicode escapes before
normalizing URL separators and stripping credentials, queries and fragments.
Drivers must still select evidence fields deliberately rather than dump
upstream responses.

### S1 and ingest audit repair receipt — 2026-11-03

Astra approved the code scope `88a146f..889c916` at full code revision
`889c9169d88e15f6b0ee8aaa6f6e44b416e33532`, with no remaining blockers.
This is a deterministic code-review receipt, not hosted CI or live acceptance.
The review covered required observations, local-check ordering and blocked-path
tripwires, production-normalized app-record ownership before deletion, mixed
URL-escape redaction, bounded late-launch handling, and truthful teardown.

The scoped implementation and regression files are
`scripts/live/node-live-gate.ts`, `scripts/live/node_ingest_check.ts`,
`scripts/live/workers_oauth_check.ts`, `scripts/test/node-live-gate.test.ts`,
and `scripts/test/node-ingest.test.ts`; this runbook records the contracts and
receipt. No benchmark files or verifier gate support changed.

Executed checks:

- `npx vitest run --project scripts scripts/test/node-ingest.test.ts scripts/test/node-live-gate.test.ts scripts/test/node-pds-compat.test.ts`
  — **66 passed**, independently repeated by Astra.
- `python3 -B scripts/test_live_evidence.py` — **28 passed**, independently
  repeated by Astra; the historical inventory remains blocked.
- `npx tsc -b` — passed.
- `npx biome check scripts/live/node_ingest_check.ts scripts/live/workers_oauth_check.ts scripts/live/node-live-gate.ts scripts/test/node-ingest.test.ts scripts/test/node-live-gate.test.ts`
  and `git diff --check` — passed.

App ownership uses the production builder to normalize the run's input and
compares its full digest with independently proved content, retaining the
verified server-assigned `createdAt`. Page, context and browser close attempts
are bounded by the remaining budget; unresolved cleanup fails the gate.
Promise races do not guarantee cancellation of an arbitrary injected launcher.
Local checks remain a caller contract rather than a network sandbox.

No live requests or OAuth exchanges ran. Driver/live acceptance remains
withheld. `oauth` is a supported Node evidence gate, while `ssrfProbe` and
`socketSoak` remain unsupported and blocked. Shared helper extraction and
migration are outside this slice.

## Dev-env OAuth advisory regression (D7)

The completed Sonnet readiness discovery reports that `@atproto/oauth-provider`
can fetch discoverable HTTPS client metadata and JWKS through valid public TLS
without a provider change. This is implementation readiness information, not
an executed OAuth exchange or live acceptance receipt; no OAuth or live network
was run for that discovery.

The current end-to-end stack uses `FakeOAuthAs` and `FakePds`. Separately,
`worker/test/node/bff/devenv-oauth.test.ts` runs the production confidential
OAuth client against a real local `@atproto/dev-env` PDS. This advisory test
covers exchange, the four repository grants, create/delete, replacement-session
revocation, and token-store cleanup. It drives provider authorization through
server APIs rather than its browser consent UI, and is not a live or browser
consent test.

The standalone `devenv_oauth_check.ts` remains a shape-only preflight that exits
2 with a blocked document. The fixture test and preflight do not add a required
production gate or produce operator evidence. In particular:

- `devenvOauth` is not among the required production gates;
- its fixture-only blocked document cannot satisfy `oauth`;
- no independently operated PDS live OAuth result has been recorded.

`NODE_SUPPORTED_GATES` remains unchanged. `ssrfProbe` and `socketSoak` stay
blocked, and the dedicated-identity OAuth/ingest live runs remain owner-skipped
until their prerequisites are supplied.

## Node ingest timeout and recovery semantics

`npx tsx scripts/live/node_ingest_check.ts` accepts an optional
`ATMUSIC_LIVE_INGEST_TIMEOUT_S` from 1 through 3600 seconds (default 300). This
is one total monotonic budget for the run. The driver reserves part of that
budget for ambiguous-write recovery, conditional cleanup, and browser teardown;
requests and poll calls use the remaining phase budget.

The app scrobble request is frozen with its original idempotency key before it
is sent. If its acknowledgement is lost or malformed, recovery replays that
same payload and key, then polls the returned operation DTO. The direct PDS B
write uses one preallocated TID and one create request. An ambiguous response
is resolved only by reading that exact key, comparing canonical record digests,
and independently verifying the CID. Cleanup uses `swapRecord` with the
verified CID. An absence observation while a create may still commit remains
unresolved; the driver does not replay the create or treat that observation as
cleanup proof. HTTP 202 for a delete is only acceptance: the operation and a
newer independently verified absence are required for reconciliation.

Unresolved operations and subjects are recorded in `results` and make the
gate fail. Browser errors are represented by fixed phase names; shared Node
evidence output strips URL credentials, query strings, and fragments before
writing stdout, stderr, or the evidence file.
