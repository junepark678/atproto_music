# Batched imports, per-listen removal (slice D)

Slice D is stacked on slice C at `e9144ec`. It adds schema migration 7, a
collection-specific batch delete executor, item suppression in the common
visibility overlay, and compatibility dispatch for Last.fm and ListenBrainz
batch records. It does not publish lexicons or change live environment/PDS
state. See [ADR 0006](../adr/0006-batched-import-records.md) for the durable
contract and rollout/rollback procedure.

## Verification performed

- `npm run typecheck -- --pretty false` — passed after slice D changes.
- `cd worker && npx vitest run --config vitest.node.config.ts --maxWorkers=1 test/node/imports/writer.test.ts test/node/outbox/batch.test.ts test/node/migrate-node.test.ts test/node/http/writes.test.ts test/node/lastfm/write-methods.test.ts test/node/lastfm/read-user.test.ts test/node/listenbrainz/validate-token.test.ts test/node/listenbrainz/feedback.test.ts` — 68 tests passed.
- `npx vitest run --config vitest.config.ts worker/test/storage/schema-v2.test.ts worker/test/node/read/delete-visibility-plan.test.ts worker/test/write/apply-batch.test.ts --maxWorkers=1` — 14 tests passed.
- The Last.fm `user.getRecentTracks`, `library.removeScrobble`, ListenBrainz `recording-feedback`, and `/1/delete-listen` route regressions exercise verified reads and indexed/pending batch entries through their protocol handlers.
- The focused batch executor test confirms partial removal preserves siblings
  and unknown envelope fields, removing the final entry deletes the record,
  two item removals serialize, an InvalidSwap re-reads and preserves a
  concurrent edit, an ambiguous write recovers by readback, and a failed create
  collision does not cause a delete of the other record.
- The import writer test confirms never-sent batches are rewritten only after
  async preparation and snapshot recheck. Split-and-remove coverage verifies
  the child membership, removed-item timestamp and cleared item payload while
  the sibling remains written.
- Migration tests confirm additive migration 7 and retain the migration-4
  delete-target index behavior. Schema-v2 table/index expectation tests are
  recorded separately in the current Node gate.
- Biome formatting/check and `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` — passed; all 258 mapped cases resolve, with no `--node-wave` filter.

No full Node acceptance suite or live service/PDS check was run for this slice.

## Acceptance and security fixes (PR #158)

Stacked on `t3/batch-delete-recovery-parity` at `f30737e`. It closes six Astra
findings against that head without regressing the nine findings closed there.
It adds additive migration 9 and changes no earlier migration, live service,
environment file, lexicon publication, or PDS record.

| Finding | Fix | Regression |
| --- | --- | --- |
| Snapshot sweep skipped batch containers | sweep through `applyRecordTarget`, stored CID via `record_uri` | `apply-batch.test.ts` › sweeps a container absent from a newer signed snapshot… |
| Post-write CID replaced pre-CAS evidence | `listen_removal_cids` evidence; success keeps `swap_cid`; wildcard hides through evidence | `batch.test.ts` › keeps a settled partial removal hidden…, › a $name removal reconciled after its tenth attempt… |
| Legacy attempted singles stalled after absence | two absence reads 60 s apart, then an explicit `unsent` transition the rebatcher accepts at any historical attempt count | `writer.test.ts` › rebatches a proven-absent legacy single after $name…, › settles only the single when a legacy send lands… |
| Fragment status made up absence | verified membership checked apart from the overlay; hidden means `unknown` | `record-status.test.ts` › never reports a hidden batch listen as verified absent |
| Last.fm reused a stale receipt | a visible row always gets a fresh intent | `write-methods.test.ts` › library.removeScrobble removes a restored batch listen again… |
| Scope-shaped 5xx blocked for re-consent | hold only on a classified permanent `forbidden_scope`; transient returns with backoff | `batch.test.ts` › a 5xx $nsid whose body names a scope error…, › a classified 403 $error denial… |

Each new regression failed against the pre-fix source (checked by reverting
the fix files only) and passes with the fix.

- `npm run typecheck` — passed.
- `npx biome check` on every changed file — passed.
- `npx vitest run --maxWorkers=1` on the batch focus set (outbox/batch, write/apply-batch, http/record-status, lastfm/write-methods, imports/writer, ingest/notify, http/writes, journey/import-journey) — 8 files, 94 tests passed.
- `npx vitest run --maxWorkers=1` on worker/test/node/{outbox,imports,lastfm,listenbrainz,read,write}, worker/test/{write,storage}, http/record-status, ingest/notify, http/writes, journey/import-journey, features, harness/local-index, migrate-node — 64 files, 356 tests passed.
- `/tmp/abatch-final/.venv/bin/python scripts/validate_contracts.py` and `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` — passed.

Operator notes: the release applies migration 9 at startup (schema version 9,
compatibility floor 2). Legacy import singles with unknown send history now
wait one extra 60 s recheck before rebatching. No full Node acceptance suite
or live check ran here; the final `scripts/acceptance/node-backend.sh` gate
runs once on the accepted head.

## Interaction fixes (stacked on PR #158)

Stacked on `t3/batch-delete-security-fixes` at `97ded2b`. It closes the six
Astra interaction findings against that head (review of 97ded2b, R1–R6) with
the lead decision that an unknown historical send is never rebatched on
absence or delay. It adds additive migration 10; migrations 1–9 keep their
statements (only the migration-9 comment now says `legacy_absent_at_ms` is
unused). No live service, environment file, lexicon publication or PDS record
was touched.

| Finding | Fix | Regression |
| --- | --- | --- |
| R1 legacy single with a chained removal stranded | no rebatch for unknown sends; the single is read, then created at its original rkey; an unsent single with a dependency runs in the normal lane | `send-certainty.test.ts` › an uncertain legacy import single ($name) with a chained Last.fm removal converges…; `writer.test.ts` › finishes an attempted legacy single…, › only reads an interrupted tenth legacy attempt… |
| R2 accepted request committed after the 60 s rule | two-read rule removed; original-key create is idempotent against a late commit | `writer.test.ts` › an accepted pre-upgrade request that outlives its client abort and any delay, landing $landing… (before read / between read and create / after create) |
| R3 zero-attempt unknown create cancelled locally | explicit `unsent` insertion receipt for every new operation; `cancelUnsent`, disconnect, rebatch and never-sent batch edits require it | `send-certainty.test.ts` › a schema-4 zero-attempt create whose send committed…, › the migrated zero-attempt import single shape…, › a new explicitly unsent create is still cancelled…, › a refunded reauth attempt and a later sign-in never restore certainty… |
| R4 invalid entry reported absent | `verified_membership` keeps valid-TID entries present/excluded per container CID; status uses only it | `record-status.test.ts` › reports a verified present invalid batch entry as excluded, never absent… |
| R5 settlement captured a recreated CID | settlement captures nothing; receipts end at a verified absence newer than `removal_fence_rev` | `batch-incarnation.test.ts` › a recreation at $name proved between the removal commit and its local settlement… |
| R6 same-CID restore hidden forever | same incarnation fence, for containers and entries; snapshot sweeps set it too | `batch-incarnation.test.ts` › a whole-container removal is outlived…, › a partial removal is outlived…, › verified snapshot sweeps and entries… |

Guards that already held and must keep holding: `batch-incarnation.test.ts`
› with no verified absence in between, a same-CID present proof stays in the
removed incarnation; › a $name local removal keeps hiding the target…; ›
privacy: an inactive owner discloses neither…; › a delayed write after the
fence does not move it…; and the existing `batch.test.ts` delayed-proof,
tenth-attempt and new-CID recreation cases.

Evidence:

- Fail-old/pass-new: the new and rewritten tests were copied onto a detached
  97ded2b worktree; 20 fail there (the privacy case fails on the missing table)
  and all pass on this head.
- The reviewer's scripts in `/tmp/atmusic-review-97ded2b` (paths rewritten to
  this worktree): `original`, `upgrade-boundaries` and `interactions` pass
  except one `interactions` case whose own assertion runs after its Last.fm
  removal hides the listen again. Corrected copies (visibility captured before
  that removal; the rejected rebatch expectation of `adversarial` replaced by
  the original-key requirement; schema version 10 in `migration-833`) all pass.
- `npm run typecheck` — passed. Biome check on every changed file — passed.
- `npx vitest run --maxWorkers=1` over worker/test/node/{outbox,imports,lastfm,listenbrainz,journey,http},
  worker/test/{write,read,ingest,http,storage,harness}, migrate-node and
  fake-protocol-upstreams — 97 files, 522 tests passed; the read-model
  bench project (query-plan pins) — 2 files, 8 tests passed.
- `/tmp/abatch-final/.venv/bin/python scripts/validate_contracts.py` and
  `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` — passed.

Remaining limits at that head (both superseded by the commit-fence fixes
below for every receipt settled on migration 11): a recreation at the same CID
with no verified absence observed in between stayed hidden, and a delayed
proof of an unobserved intermediate container version could show the removed
listen until a newer removal proof landed (Astra N1). If an earlier request commits after the original-key create and
the chained delete both succeeded, the record reappears at that rkey (same
bytes, still hidden by the receipt's `swap_cid` until a verified absence);
no client-side rule can fence a server that commits that late. Containers
projected before migration 10 report fragment status `unknown` until re-proved.
The full Node acceptance gate was not run here.

## Commit-fence fixes (stacked on PR #159)

Stacked on `t3/batch-delete-interaction-fixes` at `52b5b08` (PR #160). It closes
the three Astra findings of the 52b5b08 review (N1–N3) with server-enforced
repository-commit fencing (ADR 0006, migration 11). Migrations 1–10 are
unchanged; migration 11 adds `operations.removal_head_rev` and
`removal_commit_rev`. No live service, environment file, lexicon publication
or PDS record was touched.

| Finding | Fix | Regression |
| --- | --- | --- |
| N1 unobserved intermediate version resurfaced the target | every removal write reads `sync.getLatestCommit`, persists the head before the send and sends `swapCommit` + `swapRecord`; a succeeded receipt hides its targets at every revision at or below that head, whatever the CID | `removal-fence.test.ts` › N1: a delayed proof of an unobserved intermediate version applied $when stays removed (before and after settlement) |
| N2 delayed pre-write absence retired the receipt | the boundary is the server-checked head of the write, not `record_state` at send time; the legacy outlived rule applies only to receipts without a head | `removal-fence.test.ts` › N2: a delayed absence and byte-identical restore from before the write…, › N2 (single record)… |
| N3 first-tracked entries lost verified absence | first rows inherit `*`.last_absent_revision and the previous valid version's nonmembership; previously projected entries a valid version drops are recorded absent | `removal-fence.test.ts` › N3: after a real v9 upgrade, a $kind removal… (whole/partial, reopen, Last.fm, legacy receipt), › N3: a partial removal before the first projection…, › N3: an excluded (invalid) container version proves no entry absent |

Head CAS and recovery cases in `removal-fence.test.ts`: ABA (remove plus identical
restore) between the head read and the write is InvalidSwap and then fenced at
the fresh head; a commit to another record retries within the same attempt; a
success without `commit` metadata keeps the pre-send head; a lost response
keeps the persisted head across restart with no second write; an interrupted
tenth attempt reconciles read-only; an unavailable (501), malformed or
regressed head holds the removal without writing or spending an attempt;
restores committed after the removal and proved before settlement are visible
at the same and a new CID and Last.fm removes them; pending and failed intents
still hide. `batch-incarnation.test.ts` replaces its same-CID-without-absence
guard with › a byte-identical restore committed after the fenced removal is a
later incarnation…, keeps the old rule as › a legacy receipt (no
server-checked head)…, and replaces the local-fence refresh test with › the
fence is the server-checked head of the write… The single-record delete path
uses the same fence; its existing tests now expect the head read before each
delete (`delete.test.ts`, `recovery.test.ts`, `send-certainty.test.ts`), and the
production transport classifier (`features.test.ts`) admits
`/xrpc/com.atproto.sync.getLatestCommit` on the pds-writer wire.

Evidence:

- Astra's scripts from `/tmp/atmusic-review-52b5b08`, with paths rewritten to
  this worktree and the expected schema version set to 11: `boundaries`
  (5 FAIL at 52b5b08) and `additional-boundaries` (3 FAIL at 52b5b08) now report
  `{"summary":{"failed":[]}}`, with every case PASS in the JSONL rows. The
  upgrade rows show the target's membership `last_absent_revision` equal to the
  verified absence revision and Last.fm `delete_indexed`. `settlement-cache`,
  `interactions` and `upgrade-boundaries` report no failures. `original`,
  `adversarial` and `migration-833` exit 0, and their JSONL rows match the
  review's output prefix by prefix. The 833-receipt schema-4 migration keeps
  every operation, item, key and counter on the way to schema 11.
- Mutation checks: removing `swapCommit` fails the ABA and unrelated-commit
  tests; removing the head boundary from visibility fails 7 fence tests;
  removing the inherited boundary fails both first-tracking N3 tests.
- `npm run typecheck` passed. Biome check on every changed file passed.
- `vitest run --maxWorkers=1` over worker/test/node/{outbox,imports,lastfm,listenbrainz,journey,http},
  worker/test/{write,read,ingest,http,storage,harness}, migrate-node,
  fake-protocol-upstreams and features: 99 files, 545 tests passed. The
  read-model bench project (query-plan pins): 2 files, 8 tests passed.
- `/tmp/abatch-final/.venv/bin/python scripts/validate_contracts.py` and
  `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` passed.

Operator notes: the release applies migration 11 at startup. Removals now
require the owner's PDS to serve `com.atproto.sync.getLatestCommit` and to
honour `swapCommit`. Otherwise they hold with `repository_head_unavailable`
(or `repository_head_behind_index` for a repository behind the verified index),
retry every 5 s, and are never sent unfenced (ADR 0006 rollout step 6).

Remaining limits: the head and `commit.rev` are the owner PDS's own metadata,
not verified proofs. A PDS that misreports them can change only how its
owner's own removal is displayed here; status endpoints still report only
verified state. A PDS without `getLatestCommit` holds removals until it serves
the endpoint. Receipts that settled before migration 11 keep the migration
9/10 rules, so for them the N1 intermediate-version window and the same-CID
hidden case remain until a newer verified proof of the container lands. Containers projected
before migration 10 still report fragment status `unknown` until re-proved.
The late-commit legacy single constraint (an accepted pre-upgrade create
landing after its chained delete) is unchanged. Single-record removals gain
the fence too. The full Node acceptance gate is reserved for the accepted
final head and was not run here.

## Ordered-completion fixes (stacked on PR #160)

Stacked on `t3/batch-delete-commit-fencing` at `79560fe` (PR #160). It closes
the three Astra findings of the 79560fe review (F1–F3) by separating a
removal's ordered completion boundary from its provisional send fence (ADR
0006, migration 12). Migrations 1–11 are unchanged; migration 12 adds
`operations.removal_done_rev` and `removal_done_basis`. No live service,
environment file, lexicon publication or PDS record was touched.

| Finding | Fix | Regression |
| --- | --- | --- |
| F1 a head read before an absent read was used as the boundary, so a delayed proof of B (committed after the head, removed at D before the read) resurfaced | every absent read is bracketed by a second head read; only a stable bracket (same CID and revision) or a read after an established completion fixes the boundary; a moved head records `absent_after` and reads again in the same attempt. Applies to execution, InvalidSwap, RecordNotFound, failed writes, unknown-index single deletes and read-only tenth reconciles, single and batch | `ordered-completion.test.ts` › F1 batch $mode $kind…, › F1 single %s…, › F1 a failed write ($error)… |
| F2 a 2xx without commit was treated as an enforced CAS; the installed `@atproto/pds` 0.5.40 no-op delete (absent) and put (same bytes) skip `processWrites` and both swaps | only a well-formed `commit` newer than the checked head is `commit` evidence; a metadata-free success (no-op or omitted metadata) and a malformed commit settle only through an ordered absence. The fake PDS now answers both no-ops as the installed handlers do (200, no `commit`, no swap checked) | `ordered-completion.test.ts` › F2 %s…; `reference-noop.test.ts` (the installed handlers, then the fake, same scenarios) |
| F3 recovery replayed a completed removal against a verified later recreation R and advanced its fence past R | completion is durable in `removal_done_rev` (known commit, ordered absence, or verified membership absent after the send fence); once set, a retry only reads back and settles, never writes; a fresh intent removes R | `ordered-completion.test.ts` › F3 %s… (known success and lost response with verified absence, each across restart, then a fresh delete), › F3 a known commit whose first read-back already sees the recreation R…, › F3 single… |

The six recovery controls of the review (lost response, known commit with a
failed read-back, tenth-attempt lost response; partial and whole; recreation
after the recovery's absent read) are committed as › control $mode $kind… and
pass on both heads. Also covered: a first unstable absence followed by a
recreation (`absent_after`, no write, R visible), an unavailable head closing
the bracket (certifies nothing; the next read does), a head behind the send
fence (`repository_head_behind_fence`, no read, write or attempt), an
unavailable head after a send (counted transient, never an uncounted wait),
and the migration-11 rule for receipts without `removal_done_rev`. Existing
tests whose request sequences now include the closing head read, or whose
fake-PDS answer is now the reference no-op, were updated
(`removal-fence.test.ts`, `delete.test.ts`, `recovery.test.ts`); the legacy
receipt simulations also clear the migration 12 columns.

Evidence (every substantive command under `taskset -c 18,19 nice -n 15`,
Vitest always `--maxWorkers=1`, fixture SQLite and in-process transport only):

- Astra's scripts from `/tmp/atmusic-review-79560fe`, with paths rewritten to
  this worktree and the expected schema version set to 12 (`migration-833`,
  `additional-boundaries`; no check weakened): `head-races` (10 FAIL at
  79560fe), `noop-races` (3 FAIL) and `recovery-controls` (3 FAIL, 6 controls)
  now report `{"summary":{"failed":[]}}`. Every data row was inspected: each F1
  and F2 receipt settles with `removal_done_rev` = D (basis `absent`), the
  delayed B proof is applied yet the target stays hidden, unindexed
  (`unknown`) and unexported, statistics count only the sibling (or none) and
  the remote holds only the sibling (or nothing); single deletes now read back
  after the no-op `deleteRecord` 200. Each F3 row and control settles with no
  further PUT/DELETE, R visible, indexed and exported, `removal_done_rev` = D
  (basis `commit` or `verified`). `installed-api-noop` (2 rows) confirms the
  installed handlers' `processWrites=0` and no `commit`. The eight earlier
  suites (`original`, `adversarial`, `interactions`, `upgrade-boundaries`,
  `settlement-cache`, `boundaries`, `additional-boundaries`, `migration-833`)
  exit 0 with empty stderr, and their rows equal the review's output field by
  field except the schema version (11 to 12); the schema-4 migration keeps all
  836 operations, items and keys and the 833 written receipts.
- The new tests on the reviewed head (79560fe sources, the new tests and fake
  PDS copied in): 22 of 30 fail; the 8 passing are the six controls and the
  two fidelity tests. With every `removal_done_*` expectation stripped, each F1
  and F2 case still fails on the target resurfacing and each F3 case on an
  extra write.
- Mutation checks: treating every bracket as stable fails 8 of the 28
  `ordered-completion` tests; never treating completion as established fails 12.
- `npm run typecheck` passed. Biome check on every changed file passed.
  `git diff --check` passed.
- `vitest run --maxWorkers=1` over worker/test/node (all), worker/test/{write,read,ingest,http,acceptance,storage}
  and packages: 156 files, 815 tests passed, none failed or skipped;
  worker/test/{harness,composition}: 8 files, 22 tests passed; the read-model
  bench project (query-plan pins, output redirected outside the repository):
  2 files, 8 tests passed.
- `/tmp/abatch-final/.venv/bin/python scripts/validate_contracts.py` and
  `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` passed.

Operator notes: the release applies migration 12 at startup (two nullable
columns, no backfill). A removal now needs one more `getLatestCommit` after an
absent read; a removal whose head keeps moving reads again at once and
otherwise holds `repository_head_unstable` (no attempt spent) with its
completion kept.

Remaining limits (superseded by the next section, which closes the first):
when the head moved during the only absent read and the
next read already finds a recreation, the boundary stays at the first head; a
delayed proof of a version committed between that head and the absence can be
displayed until a newer proof of the present recreation replaces it (the
listen is present on the PDS then, nothing is written). Verified-absence
completion for a multi-target partial removal uses the oldest per-target
verified absence. Heads, commits and no-op answers are the owner PDS's own
metadata, not verified proofs; a PDS that misreports them changes only how its
owner's removal is displayed here. The installed-handler test pins
`@atproto/pds` 0.5.40 behaviour and must be revisited when that dependency
moves. Receipts settled under migration 11 keep its head rule, so for them the
F1 window remains. The full Node acceptance gate is reserved for the accepted
final head and was not run here.

## No-replay and reached-order fixes (stacked on PR #161)

Stacked on `t3/ordered-removal-completion` at `5e18a99` (PR #161). It closes
the two P1 findings of the Astra 5e18a99 review by keeping durable no-replay
knowledge apart from ordered visibility (ADR 0006, migration 13).
Migrations 1–12 are unchanged; migration 13 adds `operations.removal_reached`
and `removal_reached_at_ms`. No live service, environment file, lexicon
publication or PDS record was touched.

State transitions of one removal (crash boundaries in brackets):

| State | Durable fields | Next | Writes? |
| --- | --- | --- | --- |
| unsent | none | read head and targets; present: persist `removal_head_rev`, send [a crash leaves nothing to reconcile] | yes, under swapCommit/swapRecord |
| send unknown | `removal_head_rev` | lost answer or crash: read; absent → reached `absent`; present → write again under a fresh head [nothing proves the earlier write] | yes (unchanged) |
| received success | `removal_reached` `success` or `commit` (+ `removal_done_rev` for a commit), set before the read-back is awaited | read-back; first head read orders it | never |
| absence captured | `removal_reached` `absent`, set at the absent read | stable bracket → `absent`; moved closing head → `after` (+ one refining read); unavailable closing head → next head read | never |
| reached, unordered | `removal_reached`, no `removal_done_rev` | read-only hold: `waiting`, `removal_reached_unordered`, no attempt spent, wait doubling 5 s → 300 s; 401 blocks; pending overlay hides all targets [restart, reauth or a tenth reconcile resume the same hold] | never |
| exactly ordered | `removal_done_rev` with `commit`, `absent` or `verified` | read-back settles; hidden at or below it | never |
| ordered by the first head after | `removal_done_rev` with `after` | read-back settles; hidden strictly below it until verified ingest proves the record at or above it | never |

| Finding | Fix | Regression |
| --- | --- | --- |
| F1 an absence whose closing head moved, or failed (503/401), was saved as `absent_after` at the head read before it; a present read then settled the whole intent there, so with B (X, Y present) after H, D removing both and R recreating only X, delayed B showed Y (removed, never recreated) | the absence is no-replay knowledge at once; ordering is the first head read after it (the moved closing head, or the next head after an unavailable one), never H; a stable bracket makes it exact; `removal_done_rev` is write-once (equal-revision `after` → `absent` only); `after` hides strictly below the boundary; a sibling's presence decides nothing | `reached-order.test.ts` › F1 $kind, closing head $closing… (partial and whole × moved, 503, 401 with restart and sign-in; delayed B hidden, R visible, fresh intent removes R) |
| F2 a received success without usable commit (the installed reference no-op, or a committed write whose metadata was left out), then R recreated and proven before the read-back with D never ingested, was written again on retry | a semantically valid 2xx answer to the intent's own write persists `removal_reached` `success` before the read-back (deleteRecord: a JSON object; putRecord: the same URI and the CID of the bytes sent; commit metadata absent or malformed; unknown fields ignored); a reached intent only reads; a body that does not answer the request certifies nothing | `reached-order.test.ts` › F2 %s: the installed reference no-op answer…, › F2 %s: an actual commit answered without metadata… (partial, whole, single; no write after restart; fresh intent removes R) |

Also covered: the read-only hold (one head read per poll, waits 5, 10, 20 s,
attempts unchanged, verified R alone does not order it, the next readable head
does), a tenth attempt answered by a no-op whose read-back head fails (held,
counted, never `failed`; the read-only reconcile orders it), the strict `after`
boundary (a recreation committed before an unrelated commit that moved the
closing head stays hidden until a re-proof at the boundary releases it; the
settlement queued the container's verify hint), and success-answer validation
(other URI, other CID, no CID or an array certify nothing). Two
`ordered-completion` expectations changed: a moved closing head followed by a
recreation now settles `after` at R (was `absent_after` at D), and an
unavailable closing head is refined to `absent` by one more closing head (one
more request). The migration ledger tests and the v2 follow-receipt upgrade
list the new migration and columns.

Evidence (every substantive command under `taskset -c 18,19 nice -n 15`,
Vitest always `--maxWorkers=1`, fixture SQLite and in-process transport only):

- Astra's scripts from `/tmp/atmusic-review-5e18a99` (a superset of the
  79560fe set; identical apart from the schema label), with paths rewritten to
  this worktree and the expected schema version set to 13 (`migration-833`,
  `additional-boundaries`); no assertion changed. `completion-boundaries`
  (6 FAIL at 5e18a99), `installed-noop-replay` (3 FAIL) and `metadata-replay`
  (3 FAIL) now report `{"summary":{"failed":[]}}`, as do
  `completion-controls` (10), `established-absence` (1), `head-races` (10),
  `noop-races` (3) and `recovery-controls` (9). Every data row was inspected:
  each unstable case (partial and whole, moved, 503, 401 with restart) ends
  `removal_reached` `absent`, `removal_done_rev` = R, basis `after`, no write;
  delayed B keeps Y hidden before R is ingested and X is visible after it.
  Each no-op and metadata-free case ends `success` → `after` R with zero
  retry requests. The staggered verified case keeps `verified` D1; the
  omitted/malformed-commit controls keep `verified` D with byte-identical
  verified state; the known-commit controls keep `commit` D. The
  established-absence row now proves its boundary: the read after J is
  bracketed by J and J (three heads), so `absent` J is exact. Compared with
  the review's own output, field by field: `installed-api-noop`, `original`,
  `adversarial`, `noop-races`, `upgrade-boundaries`, `interactions`,
  `settlement-cache` and `boundaries` are identical; `additional-boundaries`
  and `migration-833` differ only in the schema label (12 to 13; all 836
  operations, items and keys and the 833 written receipts kept);
  `head-races` differs only in the request order (the refining read reuses
  the moved closing head: HEAD, GET, HEAD, GET, HEAD) and in a never-sent
  removal's fence being the head read before its absent read; and
  `recovery-controls` only in a known commit's failed read-back waiting 5 s
  read-only (attempt still counted) instead of a ~1 s transient retry.
- The new tests on the reviewed head (5e18a99 sources, the new test file
  copied in without the migration 13 field expectations and the validator
  unit test): 15 of 19 fail, each on behavior (done at H as `absent_after`;
  F2 left queued to write again; the tenth attempt `failed`); the 4 passing
  are the invalid-answer controls.
- Mutation checks over `reached-order` and `ordered-completion` (48 tests):
  a non-strict `after` rule fails 16; success answers never certifying fails
  18; the boundary at the head read before the absence fails 11; a reached
  removal answering `present` fails 15; dropping the counted post-send hold
  fails 1.
- `npm run typecheck`, Biome check on every changed file and
  `git diff --check` passed.
- `vitest run --maxWorkers=1` over worker/test/node/{outbox,imports,storage,
  lastfm,listenbrainz,read,http,write}, worker/test/node/{migrate-node,
  features}.test.ts and worker/test/{storage,read,http,write}: 87 files, 509
  tests passed, none failed or skipped; worker/test/{harness,composition}:
  8 files, 22 tests; the read-model bench project (query-plan pins, output
  outside the repository): 2 files, 8 tests.
- `/tmp/abatch-final/.venv/bin/python scripts/validate_contracts.py` and
  `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` passed.

Operator notes: the release applies migration 13 at startup (two nullable
columns, no backfill). A reached removal that cannot read a head holds
`removal_reached_unordered` with a doubling wait capped at 300 s and one head
read per poll; it never spends an attempt or fails for attempts.

Remaining limits (documented behavior, not waivers): an `after` boundary
hides a later incarnation committed between the absence (or the handling of
a no-op) and the first head read after it until verified ingest proves the
record at or above that head; settlement queues the verify hint, and an
unchanged record re-proved there is released. A getRecord absence and a
no-op answer carry no revision, so nothing finer exists without verified
evidence. A completely lost answer is still ambiguous and a read that finds
the targets present writes again under a fresh head and swapRecord.
Verified-absence completion for a multi-target removal uses the oldest
per-target verified absence, relying on ingest's per-URI revision guards.
Heads, commits and answers are the owner PDS's metadata, not verified proofs.
A receipt left with migration 12's `absent_after` basis (only the unreleased
PR #161 rule wrote it) keeps the at-or-below rule; migration-11 receipts keep
their head rule and its F1 window. The installed-handler tests pin
`@atproto/pds` 0.5.40. The full Node acceptance gate is reserved for the
accepted final head and was not run here.

## Unknown-send and same-CID statistics fixes (stacked on PR #162)

Stacked on `t3/removal-no-replay` at `a176da7` (PR #162). It closes the two
findings of the Astra a176da7 review (ADR 0006 "Unknown sends", migration 14).
Migrations 1–13 are unchanged. Migration 14 adds `operations.removal_send_state`,
`removal_send_json`, `removal_send_at_ms` and `removal_superseded_by`. No live
service, environment file, lexicon publication or PDS record was touched.
This supersedes the "completely lost answer" limit recorded above: an
unknown send is no longer written again at a newer head.

State transitions that changed (crash boundaries in brackets):

| State | Durable fields | Next | Writes? |
| --- | --- | --- | --- |
| send pinned | `removal_send_state` `pending`, `removal_send_json` (method, body, head CID and revision), `removal_head_rev`, written in one transaction before the write is awaited | the answer decides [a crash leaves it pending] | the pinned request only |
| send unknown, same root | pending, head still the pinned root | the exact pinned request is sent again (one CAS on that root) | yes, byte-identical |
| send unknown, root moved | pending, any other head | absent → reached `absent`; verified absence after the fence → `verified`; present → read-only hold `removal_send_uncertain`: no attempt spent by the hold (an attempt that sent stays counted), wait doubling 5 s → 300 s, never exhausted [restart, reauth, unblock and the tenth reconcile resume the same hold] | never |
| original refused | `rejected` (a received 4xx of the pinned send itself) | a new fenced send may follow | yes, new fence |
| superseded | `cancelled`, `last_error` `removal_superseded`, `removal_superseded_by` | never runs again; later intents carry the hiding and the writes | never |

A send fenced before migration 14 (a fence, no send state, not reached) is
pending at its fence revision. At that revision a fresh read and send is
pinned. At any other head it holds.

| Finding | Fix | Regression |
| --- | --- | --- |
| F1 a crash after the PDS committed D, a lost response or an invalid `[]` success body, then R recreating the original bytes: the retry replaced its fence by R's root and removed R (9 cases) | the exact request is pinned before the await; an unknown outcome is re-sent only at its own root and otherwise holds read-only; only a 4xx of the pinned original clears it; a new removal never waits behind it and supersedes it once later intents cover its targets; Last.fm and ListenBrainz absorb a repeat until a verified projection is newer than the fence, then admit a fresh intent | `uncertain-send.test.ts` › F1 $kind, $mode… (crash, lost, invalid, 5xx × partial, whole, single: no write after restart, the pin unchanged, bounded hold, reauth and tenth read-only, fresh web intent alone removes R), and the same-root, late-original, rejection, partial-coverage, Last.fm, ListenBrainz and pre-migration-14 cases |
| F2 a same-CID re-proof at J (real notify drain) released the recreation, but stats stayed cached (partial 1 instead of 2, whole 0 instead of 1, single 0 instead of 1) | applying unchanged scrobble bytes at a revision different from the stored one, for a record with a succeeded removal receipt, bumps `stats_version` in the proof's transaction (single and batch; snapshots share the path); cutoffs never move | `after-reproof-stats.test.ts` › %s: the real hint re-proves unchanged R at J… (production `drain`, fixture identity and DNS, sync.getRecord CAR with MST and signature verification; cache filled after settlement and before J; totals, top artists, visibility, status, export, inactive-owner privacy; Y stays removed), and a no-receipt control that keeps the cache |

Intentional changes to existing expectations: `recovery.test.ts` (a crash
after a committed single delete now only reads: one commit, no no-op resend)
and `reached-order.test.ts` (an invalid put answer followed by a recreation
holds `removal_send_uncertain` instead of `remote_delete_unconfirmed`). The
migration ledger tests, the row-shape test and the v2 follow-receipt upgrade
list migration 14.

Evidence (every substantive command under `taskset -c 18,19 nice -n 15`,
Vitest always `--maxWorkers=1`, fixture SQLite and in-process transport only):

- Astra's `new-boundaries.mts` and `new-controls.mts` from
  `/tmp/atmusic-review-a176da7`, copied with their paths rewritten to this
  worktree and no assertion changed: `new-boundaries` 12/12 PASS (12 FAIL at
  a176da7). Each ambiguous row ends `queued`, `removal_send_uncertain`,
  `removal_send_state` `pending`, attempts 1. The restart sends only HEAD and
  GET, and the remote X, Y, Z (or the single) are intact. Each cutoff row
  bumps `stats_version` across the drain, and its totals are 2, 1 and 1.
  `new-controls` 15/15 PASS.
- The 17 prior suites through a copy of `run-probes.py` (output in the
  scratch directory, not the review directory), with the schema
  expectation set to 14 in `migration-833` and `additional-boundaries`.
  All exit 0 with no FAIL row. Compared field by field with the review's
  own JSONL after removing the four new columns, every row is identical
  except the schema label (13 to 14).
- The two new test files on the reviewed head (a176da7 `worker/src`):
  33 of 36 fail. The 3 that pass are the no-receipt cache control and the
  partial and whole late-original-before-retry cases.
- Mutation checks over `uncertain-send` (32 tests) and `after-reproof-stats`:
  - the stats bump disabled: 3 fail;
  - the pin ignored when reading back: 20 fail;
  - the pin written after the await: 3 fail;
  - no supersession: 15 fail;
  - held removals kept as predecessors: 17 fail;
  - a re-send's refusal clearing the pin: 3 fail;
  - Last.fm always absorbing: 3 fail;
  - ListenBrainz always absorbing: 1 fails.
- `vitest run --maxWorkers=1` over worker/test/node/{outbox,imports,lastfm,
  listenbrainz,write,read,ingest} and worker/test/{storage,write,read,ingest}:
  93 files, 559 tests passed. worker/test/node/http,
  worker/test/node/{migrate-node,features}.test.ts and
  worker/test/{http,harness,composition}: 20 files, 87 tests passed.
- `npm run typecheck`, Biome check on every changed file, `git diff --check`,
  `scripts/validate_contracts.py` and `scripts/validate_case_map.py
  --check-tests` passed.

Operator notes: the release applies migration 14 at startup (four nullable
columns, no backfill). A removal held `removal_send_uncertain` reads one head
and its targets per poll, up to every 300 s, and never spends an attempt. Its
pending overlay keeps its targets hidden. Nothing resolves it on time,
sign-in or unblocking. It resolves when its targets are absent, when they
are verified absent after its fence, or when the owner deletes the listen
(or record) again. That new intent is fenced by the current head and
supersedes the held one once its targets are covered. No flag or timeout
marks a held removal complete.

Remaining limits (documented behavior, not waivers):
- A held removal only partly covered by later intents keeps hiding its
  remaining targets. Each later incarnation of them stays hidden too, until
  those targets are covered, absent or verified absent.
- A whole-container hold is covered only by a later whole-container intent.
- The same-root test treats the owner PDS's head as authoritative. A PDS that
  reports a stale head can only delay its own owner's removal: the re-sent
  request is still one CAS on that root.
- Re-proofs at a newer revision of a record with a succeeded removal receipt
  invalidate statistics conservatively, even when no cutoff is crossed.
- The full Node acceptance gate is reserved for the accepted final head and
  was not run here.
