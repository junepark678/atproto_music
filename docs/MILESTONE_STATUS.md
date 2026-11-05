# MVP milestone status

> **Historical Workers receipt, not current Node acceptance.** ADR 0005
> supersedes the hosting/auth/write model below. The counts, case retirements,
> commands and operator requirements here belong to the recorded Workers
> commit; “every deterministic gate passes” / “nothing deterministic remains”
> are not statements about the current Node checkout. M1–M6 still need current
> integration/CI and published-contract reconciliation as applicable, plus
> their live gates. Current namespace ownership/publication is recorded in
> [the owner publication receipt](verification/lexicon-publication/README.md);
> it does not establish current Node or live acceptance.
> Worker version ids, ADMIN_TOKEN and Cloudflare Analytics are not Node-host
> prerequisites. See [ADR 0005](adr/0005-local-node-host-and-compat-apis.md),
> [Node deployment](deploy/local-node.md), and the scoped
> [implementation/check record](verification/implementation-agent-13.md).

## Current Node acceptance (ADR 0005 §15)

The Node acceptance gate is `bash scripts/acceptance/node-backend.sh` (wave
N8-01). It runs the 11 steps in [backend-node.md](verification/backend-node.md),
resolves every one of the 258 case-map entries without `--node-wave`, and lists
the live gates as blocked unless `scripts/verify_live_evidence.py --node`
confirms evidence bound to the current commit and Node bundle. It replaces
`scripts/acceptance/node-interim.sh` as the gate from wave 8 on and never
contacts a live service.

Current candidate update (2026-11-06): the full N8 attempt at `396de2d`
**failed** because the production-SPA setup hook exceeded its 10-second budget.
It passed 1,799 executed records; one bundle test was skipped by the failed
suite. Browser E2E (14), protocol replay (7), Python (45), Node tests (477),
bundle guard, case map, goldens, systemd and live refusal controls passed.
`check-ts` stopped before contract validation, so the overall case result was
239 passed, 4 failed, 9 blocked and 6 retired. The exact failed receipt and
runner correction are recorded in [backend-node.md](verification/backend-node.md).
[PR #149](https://github.com/junepark678/atproto_music/pull/149) integrates the
reviewed backend fixes and published-schema guard; final acceptance remains
pending. Live identity gates remain owner-skipped, with no credentials sought.

Earlier successful baseline (2026-11-04): the full N8 gate passed on
clean integration commit `4322f5d`; its bundle SHA-256 and machine-readable
summary are recorded in [backend-node.md](verification/backend-node.md) and
[the exact-head receipt](verification/receipts/node-backend-4322f5d-summary.json).
It executed 1,692 tests/records with 0 failures or skips; all 258 cases resolved
(243 passed, 9 blocked, 6 retired). Playwright passed 14/14 and the
process-backed scrobbler replay passed 7/7. The run also passed the explicit
clean-install/full-check no-workerd acceptance test.

This deterministic pass does **not** close live acceptance: all five
release-bound live gates (oauth, ingest, pdsCompat, ssrfProbe, socketSoak) and
M7.4.3 `live_product` remain blocked. No live services or external providers
were contacted. N6-02 live acceptance remains open. The run also verifies the
N7-01 disposable installation and full check without `workerd`; no milestone
or live gate is closed by this run.

Earlier failed receipts at `c2da66a+dirty`, `4a97dc1`, and the intermediate
`838fa217` run remain historical. Their issues were addressed by subsequent
mapping, retirement, and timing fixes. The clean `be1c0a5`, `e02d96e`, `8d415468`
and `dabaabf` runs are retained as prior exact-head receipts in
[backend-node.md](verification/backend-node.md); `4322f5d` is a prior
successful baseline, not acceptance of the newer candidate. The prior `af4a3ef` run remains recorded as
history there.

Historical Workers receipt follows; nothing below is a current Node statement.


Recorded 2026-10-25 for the Cloudflare Workers backend (ADR 0004).

The acceptance gate `bash scripts/acceptance/workers-backend.sh` ran on commit `6f95c536bfc356ac5ef12524cd3cd6f6c3c34847`, with bundle SHA-256 `e796e5a5…7ab36`, and exited 0. Every deterministic suite passed: 406 tests in the repository gate, 21 backend acceptance tests in workerd, 9 Playwright tests, 25 Python regressions, the bundle guard, the case map and the Rust-oracle goldens. [VALIDATION.md](VALIDATION.md) and [backend-workers.md](verification/backend-workers.md) record the commands and counts.

The 258 named cases ended as follows: **204 passed, 0 failed, 9 blocked and 45 retired.** No test was skipped. All five live gates are **blocked**.

The [MVP plan](planning/MVP.md) requires merged deliverables and executed acceptance, including the applicable live evidence. **No milestone is closed** while its live cases are blocked and nothing is deployed. A deterministic pass does not stand in for live evidence.

| Milestone | Passed | Failed | Blocked | Retired | Remaining completion work |
| --- | --- | --- | --- | --- | --- |
| M1: Contracts and foundation | 31 | 0 | 0 | 11 | Record the owner's evidence for the `dev.pythonplayer123.music` NSID authority (`_lexicon.music.pythonplayer123.dev`), obtain repository CI evidence, and merge the reviewed deliverables. |
| M2: Identity and OAuth | 18 | 0 | 2 | 16 | Live `oauth` and `pdsCompat` gates: browser public-client sign-in on two independent PDSs, granted `repo:` scopes, sign-out, and a disposable record round trip (live_round_trip, live_disposable_record). |
| M3: Scrobble publishing | 29 | 0 | 2 | 5 | Live `ingest` gate: an SPA publish indexed through Jetstream, and delete and reconcile with verified absence (live_create_read, live_delete). |
| M4: Federation and feeds | 33 | 0 | 3 | 0 | Live `ingest` and `socketSoak` gates: an external writer on PDS B, external update and delete, and reconnect convergence over 24 h (live_remote_arrival, live_remote_mutation, live_recovery). |
| M5: Read models and social | 34 | 0 | 0 | 2 | Nothing deterministic remains. Independent external social and statistics observations come with the M4 live gates. |
| M6: Deployment and operations | 28 | 0 | 1 | 7 | Deploy a Worker version with the operator's credentials. Record a schemaVersion 2 live inventory bound to that version id and bundle hash (live_inventory), and run the `ssrfProbe` and `socketSoak` gates. |
| M7: Preact product | 31 | 0 | 1 | 4 | Live product evidence: real OAuth, a direct second-PDS record and the browser feed, on the deployed origin (live_product). |

The required operator inputs are:

- a deployed Worker version id with its bundle hash;
- the production origin `https://music.214510.xyz`;
- the owned prefix, with its ownership evidence;
- dedicated identities on two independently operated PDSs, with evidence that they are independent;
- Jetstream coverage evidence;
- `ADMIN_TOKEN`;
- Cloudflare Analytics read access, for the soak.

Supply them only through the environment. See [workers-live.md](verification/workers-live.md). No live gate has run, and nothing has been deployed by this work.

Retirement of the Rust crates (W7-02) is gated on the owner. Until then, the crates remain the golden oracle.
