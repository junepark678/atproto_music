# Deferred-love maintenance bounds

Deferred-love maintenance uses two rotated phases. The guaranteed phase gives
each of the five lanes up to 22 charged units in the current turn order. A
second pass shares the remaining part of the 110-unit budget in that same
rotation. A lane that reaches an empty frontier stops for the invocation.

The scheduler reserves these conservative per-step ceilings before executing
mutating SQL. In each lane transaction it measures `total_changes()` around
each step and aborts that transaction before commit if either measured writes
or declared inspection work exceeds the reservation.

| Lane step | Reserved work | Per-step detail |
| --- | ---: | --- |
| INV | 10 | One invalidated intent plus head removal/arming, allocator, authority cursor, and linked-account effects |
| DUE | 21 | Up to 16 child deletions, FIFO arm allocation, head arm, optional completed-link reopen, maintenance requeue allocation and head floor/queue update |
| RR | 21 | Up to 16 child deletions plus scan, arm, and associated updates |
| WIT | 16 | One group step or up to 16 witness rows pruned |
| AUTH | 8 | Up to eight unfiltered authority rows inspected; cursor advances to the last inspected row |

The shared charged-work budget is 110 and maintenance-head visits are capped
at 16 per invocation. WIT is capped at four steps, AUTH at 13 eight-row steps,
and RR and DUE at five steps each; INV is capped at 16 visits. These are shared
ceilings, not independent quotas.

At most 18 changed rows are reserved for metadata: one singleton initialization,
six maintenance-cursor finalizations (RR, WIT, and AUTH once in each phase),
ten lane-counter upserts, and one lane-turn update. Each cursor, counter,
initialization, and lane-turn statement reserves at most one metadata write
and measures its actual SQLite change delta before commit. Spare unit allowance
cannot cover metadata expansion. Cursor and counter writes are in the lane
transaction. Empty initialized runs write zero rows. The
combined charged-work and metadata ceilings are 128 changed rows. A failed
lane rolls back its data, cursor, and counter; earlier lane transactions remain
committed, and the next timer invocation starts with a fresh budget.

`worker/test/node/forward/love-maintenance-accounting.test.ts` contains seven
regressions for the production DUE 20/21-write cases and metadata amplification
at singleton initialization, cursor finalization, lane counters, and final-turn
update. Each verifies transactional rollback on an over-reservation; the
earlier AUTH lane remains committed when a later transaction fails. The
benchmarks also meter the actual statement deltas and retain a 20-row per-step
and 80-statement per-step guard alongside the whole-call budget assertions.

INV uses the existing partial authorization index and a full tuple seek on
`(link_id,generation,operation_id)`. The worker-bench exercises the production
query with 100, 1,000, and 10,000 direct-SQL rows, checks the indexed tuple
range and identical 51-opcode SQLite VM program, and verifies tail and miss
results. The old expanded-OR predicate remains as a negative plan control: it
uses the same prefix index but the plan cannot seek on the complete tuple.

## B2 restore and transport evidence

This is the remaining-matrix record for the named Node tests. Commands run
with CPU affinity 8–11 and one Vitest worker. A PASS is limited to the exact
caller path and assertions named in its row; it does not imply complete
finding01 closure.

| Area | Named proof | Result and boundary |
| --- | --- | --- |
| Populated schema-55 live restore | `scripts/test/restore.test.ts` — “migrates a real schema-55 backup to 56 while preserving a readable schema-55 live receipt and gap” | PASS. Real CLI restore preserves readable live evidence; schema-56 deferred-love tables are empty in this legacy input. |
| Populated schema-56 merge, reopen, coverage timer, cancellation, and wire | `scripts/test/restore.test.ts` — “merges populated schema-56 love state from the readable live DB and reopens it in a fresh server composition” | PASS. The backup and live DB each have all six B2 tables populated; actual CLI restore selects the newer live rows and starts a fresh server composition. The oracle checks exact link/generation/kind/authority joins, same-track sent-love ledger and deferred U, per-head next/live sequence bounds, global head/armed/maintenance/group/authority/due frontiers, and `PRAGMA foreign_key_check`. The fixture creates delivery with `settleRows` and deferred coverage via production enqueue/maintenance. It then invokes the reopened production backfill timer, waits for `done`, enqueues and cancels a later API love, verifies the deferred-coverage history counter remains one, and sends the retained U once through the Fake ListenBrainz client. |
| Populated schema-56 late failure rollback | `scripts/test/restore.test.ts` — “keeps populated schema-56 live and backup state intact when the completed merge fails before the file swap” | PASS. The real CLI builds a complete merged copy, then an injected failure at `merged` aborts before the atomic swap. Full snapshots of all six B2 tables, receipts, gaps, outbox and allocator/cursor rows match on live and backup; the preserved `.pre-restore` copy matches live, backup bytes are identical, temp files are removed, and both live and preserved FK checks pass. |
| Accept-loss, journal replay, cascade, and global cleanup | `scripts/test/restore.test.ts` — “with --accept-loss on an unreadable live db, every web session is gone and each credential, link and OAuth session in revocations.log is deleted from the restored copy” | PASS. Actual CLI `--accept-loss` replays the revocation journal; link-owned B2 rows cascade away, the global conflicted authority remains initially, then production maintenance removes it without resetting allocator frontiers. |
| Source exclusion at enqueue and wire | `worker/test/node/outbox/astra-d050-independent.test.ts` — “enforces source exclusion at production enqueue and wire dispatch for lastfm/listenbrainz”; `worker/test/node/forward/lastfm-forward.test.ts` — “delivers a linked ListenBrainz love through the real signed Last.fm fake”; `worker/test/node/forward/listenbrainz-forward.test.ts` — “imports a real Last.fm love through the pull writer and excludes its source before ListenBrainz wire dispatch” | PASS. Both `stageLovePage`/`writePullSlice` source orders produce one row only for the opposite-service target and deliver one love to the real fixture wire. |
| Equal-time FIFO and delivery fallback | `worker/test/node/outbox/astra-d050-independent.test.ts` — “keeps equal-millisecond love/unlove FIFO through settlement and uses the delivery ledger after row cleanup” | PASS. Actual wire sequence is love/unlove/love; deleting outbox rows leaves `remoteLoveState` backed by the last-sent ledger. |
| Held resume and terminal expiry | `worker/test/node/outbox/astra-d050-independent.test.ts` — “resumes a held love through same-remote relink and sends it exactly once”; “expires a held %s row without transport and retains its local receipt” (`listenbrainz`, `lastfm`) | PASS. Same-remote relink resumes and sends once; held expiry sends nothing and keeps the local receipt for both services. |
| Generation rotation | `worker/test/node/outbox/astra-d050-independent.test.ts` — “does not settle or dispatch a stale-generation row after a real remote rotation” | PASS. Rotation expires the old row; stale settlement and transport do not create a delivery ledger entry. |
| Prior current/no-remote state grid | `worker/test/node/outbox/astra-d050-independent.test.ts` — “runs deferred coverage from a real {listenbrainz,lastfm} link with prior love {queued,held,sent,failed,expired,ignored,cancelled}” | PASS: 14 cases across both services. Coverage emits an unlove for queued/held/sent current-love states and none for failed/expired/ignored/cancelled states with no remote love. Positive cases dispatch through the fake transport; held cases use same-remote `saveLink` before dispatch. |
| Verified projection survivor and removal control | `worker/test/node/outbox/astra-d050-independent.test.ts` — “lets a verified surviving love projection veto deferred unlove, then sends one after verified removal” | PASS. Signed create/delete/create/delete proofs pass through `applyRecordProof`; surviving projection prevents an unlove wire effect, and verified removal allows exactly one after real backfill and forwarding. |
| Coverage resume, cancellation, and maintenance timer | `worker/test/node/forward/love-deferral.test.ts` — “records a disabled-link unlove and emits it once after history coverage resumes”; `worker/test/node/forward/love-deferral-maintenance.test.ts` — “preserves the database across reopen and runs maintenance from the real backfill timer finally” and “reopens a completed history run only for coverage and preserves its history progress” | PASS for the named focused fixtures. These exercise the production backfill/maintenance caller, but are not a post-restore transport continuation. |
| H1/H2 authority and cancellation controls | `worker/test/node/forward/love-deferral.test.ts` — “bridges H1 conflict before A2 authorization and keeps authority until the dependent effect settles”; “keeps H1/H2 conflict sticky for held and MBID-revivable effects as well as the deferred intent”; `worker/test/node/forward/love-deferral-maintenance.test.ts` — “starts frozen integer passes, removes cancellations, and stays within whole-call budgets” | PASS for their asserted conflict, held/MBID revival, cancellation, and maintenance states. Broader caller/transport combinations below remain residual. |
| Revocation-to-unlove and relink transport order | `worker/test/node/outbox/astra-d050-independent.test.ts` — parameterized “keeps a revoked %s love authoritative while an unlove waits, then sends it once after same-remote relink” | PASS for both ListenBrainz and Last.fm. Real enqueue while revoked creates no outbox row or wire call; same-remote `saveLink` plus backfill creates one queued unlove, which settles sent once through each service's fake client. |
| Held terminal expiry receipt | `worker/test/node/outbox/astra-d050-independent.test.ts` — parameterized “expires a held %s row without transport and retains its local receipt” | PASS for both service values. Expiry sends nothing and preserves the unretired receipt. |
| Later API love after coverage reaches DONE | `scripts/test/restore.test.ts` — populated schema-56 merge test above | PASS. The real API love is queued after backfill reaches `done`, maintenance runs, cancellation removes it, and the earlier U remains queued for one delivery; history coverage count stays one. |
| Inherited active-delete survivor behavior | [Separate P1 LIVE-DELETE-SURVIVOR — PR #209](https://github.com/junepark678/atproto_music/pull/209) | OUT OF B2 SCOPE, disclosed. Event-caused deletion can still send an unlove while another same-track love is projected, as reproduced on accepted B1 and B2. The reproduction is moved out of this PR to the separate slice, where it must run red then green; no expected-red case ships in B2. Two destination rows are not a same-link dedupe violation. Import source exclusion remains scoped to the original imported operation identity, not unrelated later live URIs. Explicit API unlove and the later LOVE-UPDATE-CALLER slice remain unchanged. |
| Verified love-record update caller | `docs/planning/PLAN-sync-nowplaying-musicbrainz.md` records that a verified canonical identity change currently does not enqueue the replacement love or remove the old remote love. `worker/test/node/forward/love-authority-signed.test.ts` labels manual update cases as a FUTURE producer model. | ACCEPTED best-effort limitation; old remote love may remain. Manual-enqueue tests are not current caller coverage. No automatic update behavior is implemented here. |
| Cross-slice acceptance | L2, R12, and finding 48 (pull-love cancellation) | DEFERRED to their owning slices; this B2 matrix does not close those requirements or all of finding01. |

Focused commands for the new restore and wire rows:

```sh
taskset -c 8-11 npx vitest run scripts/test/restore.test.ts -t "migrates a real schema-55 backup|merges populated schema-56 love state|completed merge fails before the file swap|unreadable live db, every web session" --maxWorkers=1
taskset -c 8-11 npx vitest run --config vitest.node.config.ts test/node/outbox/astra-d050-independent.test.ts --maxWorkers=1
taskset -c 8-11 npx vitest run --config vitest.node.config.ts test/node/forward/listenbrainz-forward.test.ts -t "imports a real Last.fm love through the pull writer" --maxWorkers=1
taskset -c 8-11 npx vitest run --config vitest.node.config.ts test/node/forward/lastfm-forward.test.ts -t "delivers a linked ListenBrainz love through the real signed Last.fm fake" --maxWorkers=1
taskset -c 8-11 npx vitest run --config vitest.node.config.ts test/node/forward/love-maintenance-accounting.test.ts test/node/forward/love-deferral-maintenance.test.ts test/node/forward/love-deferral.test.ts --maxWorkers=1
taskset -c 8-11 npx vitest run scripts/test/restore.test.ts worker/test/node/outbox/astra-d050-independent.test.ts worker/test/node/forward/listenbrainz-forward.test.ts worker/test/node/forward/lastfm-forward.test.ts --maxWorkers=1
taskset -c 8-11 npm run typecheck
taskset -c 8-11 npx biome check worker/test/node/outbox/astra-d050-independent.test.ts worker/test/node/forward/listenbrainz-forward.test.ts docs/forward-love-maintenance.md
```

The current restore filter passed 4 tests, the transport suite passed 51 tests,
the two producer tests passed 1 each, and the maintenance command passed 35
tests (including the seven accounting regressions). The earlier expanded batch included one explicitly expected source/projection
reproduction. That case is now removed from B2 and belongs to the separate
P1 slice; its prior result is not evidence of a B2 fix. Typecheck, scoped Biome, and `git diff --check` passed.
These are scoped evidence only; exact-head full and hosted gates plus fresh
acceptance review remain outstanding.
