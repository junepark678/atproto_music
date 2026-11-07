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
