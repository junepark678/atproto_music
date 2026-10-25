# MVP milestone status

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
