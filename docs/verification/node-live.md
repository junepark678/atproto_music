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
OAuth evidence. Node OAuth evidence remains blocked until that driver and its
exchange and upstream-revocation observations have an accepted contract. A
future Node OAuth result must show an actual granted scope containing
`atproto` and create, update, and delete on each of the four Node collections
`<prefix>.scrobble`, `<prefix>.follow`, `<prefix>.settings`, and
`<prefix>.love`; any actual `transition:*` scope token invalidates that
grant. This four-collection rule is separate from the historical Workers
`full_repo_grant` rule, which remains three collections. The Node OAuth gate
is not enabled by this validator rule and remains blocked until the exchange
and revocation evidence contract and driver are implemented. At this stage
only the applicable existing `ingest` and `pdsCompat` structural result
checks can pass as Node standalone gates.
`ssrfProbe` and `socketSoak` also remain blocked until their Node driver
semantics are ported; Workers Cloudflare/DO analytics do not stand in for Node
acceptance. Unknown gates never enable PASS.

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
ListenBrainz. No Node live acceptance has been recorded. Confidential-client
OAuth interop, SSRF probe, and Node soak remain deferred; full N6-02 and M6
live acceptance stay open.

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
