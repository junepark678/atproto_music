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

Remaining limits: a recreation at the same CID with no verified absence
observed in between stays hidden (nothing verified separates the
incarnations). An unverified intermediate container version applied after
settlement but before the post-removal proof can be shown briefly (until that
proof lands). If an earlier request commits after the original-key create and
the chained delete both succeeded, the record reappears at that rkey (same
bytes, still hidden by the receipt's `swap_cid` until a verified absence);
no client-side rule can fence a server that commits that late. Containers
projected before migration 10 report fragment status `unknown` until re-proved.
The full Node acceptance gate was not run here.
