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
semantics are ported. At this stage only the applicable existing `ingest` and
`pdsCompat` structural result checks can pass as Node standalone gates.
`ssrfProbe` and `socketSoak` also remain blocked until their Node driver
semantics are ported; Workers Cloudflare/DO analytics do not stand in for Node
acceptance. Unknown gates never enable PASS.

## Historical compatibility and live-driver boundary

Without `--node`, schema-v1/v2 Workers inventory and gate documents continue
through the historical Workers validators, including Worker UUID checks. That
path is regression-tested and cannot satisfy Node CLI acceptance. Schema-v3
Node documents dispatch to the Node verifier; `--node` explicitly requires
Node mode even for a standalone gate.

N6-02 requires every future operator driver to validate its required
`ATMUSIC_LIVE_*` inputs before making any network request. If any are missing,
the driver must exit **2**, print a blocked document listing each missing
variable name, and make no network request. No gate contacts Last.fm or
ListenBrainz. No Node live acceptance has been recorded. The live drivers,
confidential-client OAuth interop, SSRF probe, and Node soak remain deferred;
full N6-02 and M6 live acceptance stay open.
