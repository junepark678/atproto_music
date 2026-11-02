# M4 #83 coverage-failure contract proposal — review only

**Status: draft / owner review required / not published.** This note reconciles existing #83 wording with the accepted Jetstream/current-proof architecture. It does **not** amend GitHub, ADRs, issue state, runtime behavior, or the accepted architecture. All M4 issues remain open; M7 is excluded.

## Scope and evidence

The local issue audit records M4 #83 (`M4.4.1`, independent-writer federation harness) as open and describes its named `coverage_failure` outcome as: *“second PDS absent from configured relay” → “explicit indexing-unavailable evidence, never a federation pass.”* The current published issue body, not this proposal or the local planning mirror, remains authoritative until its owner accepts a change.

The accepted design is Jetstream commit **hints**, followed by current-head signed-record proof or verified range snapshots; it does not use relay events as authority. ADR 0004 §5.5 and §5.7 specify persisted cursor/gap recovery and snapshots for known DIDs, while §16.2 explicitly limits coverage to the configured relay/Jetstream population and notes that PDSs outside crawl coverage need another discovery/notify path. ADR 0005 §3.4 carries the Jetstream socket design onto the Node host. Neither ADR defines a per-DID Jetstream coverage signal.

The controlled test `worker/test/acceptance/federation.test.ts › an external commit omitted by configured Jetstream DID coverage remains unindexed without a gap signal` shows this limitation concretely: the fake PDS accepts Carol's independent XRPC create, but the test Jetstream omits Carol's commit from replay/live delivery; no hint or proof request is produced, the projection/feed stays unchanged, and `users.indexing_state` remains `current`. There is no input from which the runtime can infer that a record changed. This is a negative characterization of the current architecture, **not** evidence of successful coverage detection. The separate live preflight blocks when it lacks `ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF`; that variable is an operator-supplied prerequisite, not proof that the stream actually carried each DID.

## Exact reconciliation needed

The phrase “absent from configured relay” currently conflates three different states:

1. **No coverage evidence/configuration.** The acceptance runner can and should refuse before live network activity, report `blocked`/`indexing unavailable`, and never emit a federation pass. The existing missing-reference offline regression checks this fail-closed behavior.
2. **Known unsupported PDS or explicitly excluded DID.** An operator/source can report that coverage does not include the acceptance identity. The harness can classify this as unsupported/blocked using that external evidence; the app cannot derive it from absent events.
3. **Silent per-DID omission despite an asserted coverage claim.** The app receives no event or error. With commit hints alone, its local observations are indistinguishable from a DID whose repository had no change. It cannot truthfully mark a gap or `indexing unavailable` for that DID without another observation channel.

Thus the negative fixture is not equivalent to the named `coverage_failure` acceptance expectation if that expectation requires the runtime to detect state 3. Treating a configured host, coverage reference, offline preflight, or fixture omission as proof of actual source coverage would also be incorrect.

## Owner decision requested

Choose one contract direction before describing #83 as reconciled:

### Option A — retain event-driven Jetstream; qualify the failure contract (recommended)

Keep Jetstream as a best-effort event hint source and signed proof/snapshot as authority. Amend the issue to require:

- **Preflight:** missing, unsupported, or unverified external coverage evidence blocks the live run before any write/interruption and is recorded as `blocked` / `indexing unavailable`; it is never a federation pass.
- **Deterministic negative:** controlled per-DID omission proves the current runtime does not detect a silent omission; no test claims runtime `recovering`, `unavailable`, or complete coverage from this fixture.
- **Live evidence:** report the provider/source's coverage statement and independently observe test mutations from both PDSs under the same release; a reference alone is not proof. Retain all independent-writer, mutation, process-recovery, latency, cleanup, and release-binding requirements.
- **Status semantics:** define `current` narrowly as “locally reconciled to the last observed signed repository state,” not “all external changes are guaranteed observed.” Do not use it as a coverage attestation.

This preserves the accepted event-driven architecture but cannot promise detection of every silent provider omission. If the original issue intended that stronger guarantee, Option A is a product-contract amendment and requires explicit approval, not reinterpretation by the implementer.

### Option B — require runtime detection of silent omissions

Add an authoritative reconciliation channel for each indexed DID (for example, bounded periodic signed-head probes with durable comparison and explicit degraded status). Before implementation, obtain an ADR/owner decision specifying the authoritative source, scheduling/admission limits, PDS host budgets, unknown/unavailable and stale-state semantics, maximum detection interval, snapshot interaction, and behavior during upstream outages. A probe failure must not be confused with a changed repository, and a `getLatestCommit` mismatch alone must not authorize projection changes without signed proof. Add deterministic tests and resource/latency bounds before changing public status semantics. This is new scope, not a toggle of the Jetstream connector.

## Proposed append for #83, only if Option A is approved

> **Coverage boundary (owner-approved text required):** Jetstream events are hints; absence of a per-DID event is not proof that the DID did not change. The live harness must fail closed before mutation when independent-PDS coverage is missing, unsupported, or not evidenced, and report `blocked`/`indexing unavailable`, never a federation pass. An operator-supplied reference is not itself proof that the source delivered both identities. The controlled silent-omission fixture documents that the current runtime cannot infer a missed event and must not be reported as coverage detection. Any claim that runtime status detects silent omission requires a separately approved authoritative reconciliation design and its tests. Preserve all original independent-write, update/delete, app-write-count, fault/recovery, latency, cleanup, and release-bound evidence requirements not explicitly amended here.

This wording is a **proposal**, not approval. If the owner chooses Option B or another direction, replace the proposal accordingly and update the architecture, tests, live runner, and case map before claiming reconciliation.

## Current disposition

- #83 remains **OPEN**; no GitHub mutation was made and no duplicate issue is proposed because the gap is already tracked by #83.
- The deterministic omission test and offline preflight are accurately mapped as separate fixture/preflight evidence; neither closes the full named acceptance case.
- The public deployment is not an acceptance target: the observed tunnel currently has no healthy app behind it, production schema publication is incomplete, and production Jetstream configuration is absent. No live network mutation or production action is authorized by this proposal.
- #84's broader process-level fault/convergence matrix and #85's current-Node live runner plus genuine two-PDS/Jetstream evidence remain separate blockers.
