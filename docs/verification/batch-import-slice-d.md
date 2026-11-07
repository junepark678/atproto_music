# Batched imports, per-listen removal (slice D)

Slice D is stacked on slice C at `e9144ec`. It adds schema migration 7, a
collection-specific batch delete executor, item suppression in the common
visibility overlay, and compatibility dispatch for Last.fm and ListenBrainz
batch records. It does not publish lexicons or change live environment/PDS
state. See [ADR 0006](../adr/0006-batched-import-records.md) for the durable
contract and rollout/rollback procedure.

## Verification performed

- `npm run typecheck -- --pretty false` — passed after slice D changes.
- `cd worker && npx vitest run --config vitest.node.config.ts test/node/imports/writer.test.ts test/node/outbox/batch.test.ts test/node/migrate-node.test.ts test/node/http/writes.test.ts test/node/lastfm/write-methods.test.ts test/node/lastfm/read-user.test.ts test/node/listenbrainz/validate-token.test.ts test/node/listenbrainz/feedback.test.ts --maxWorkers=1` — 63 tests passed.
- `npx vitest run --config vitest.config.ts worker/test/storage/schema-v2.test.ts worker/test/node/read/delete-visibility-plan.test.ts worker/test/write/apply-batch.test.ts --maxWorkers=1` — 14 tests passed.
- The Last.fm `user.getRecentTracks`, `library.removeScrobble`, ListenBrainz `recording-feedback`, and `/1/delete-listen` route regressions exercise verified reads and indexed/pending batch entries through their protocol handlers.
- The focused batch executor test confirms partial removal preserves siblings
  and unknown envelope fields, and removing the final entry deletes the record.
- Migration tests confirm additive migration 7 and retain the migration-4
  delete-target index behavior. Schema-v2 table/index expectation tests are
  recorded separately in the current Node gate.
- Biome formatting/check and `/usr/bin/python3.14 scripts/validate_case_map.py --check-tests` — passed; all 258 mapped cases resolve, with no `--node-wave` filter.

No full Node acceptance suite or live service/PDS check was run for this slice.
