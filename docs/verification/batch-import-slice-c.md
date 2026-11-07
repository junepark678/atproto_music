# Batched imports, slice C implementation evidence

Base: `a9fcad5` (slice B). The change remains local to the Node outbox and import writer; it does not publish the candidate lexicon or open the production publication gate.

## Implemented in this slice

- The Node import writer packs eligible listens in stable order into durable `scrobble.create` operations using the configured `.scrobbleBatch` collection. Each entry keeps the single record's fields and `createdAt`, with its stable TID stored as the entry id. Packing measures DAG-CBOR and exact UTF-8 createRecord bodies before persistence, with the 200-entry, 64,000-byte CBOR and 100,000-byte body limits.
- Batch operations use `createRecord` and digest reconciliation, and do not enter `applyWrites` grouping. The existing 3-point create accounting therefore applies per container. Import items and listen keys point to their containing operation, so outcome sync counts individual listens.
- Existing queued import singles can be migrated only when they are queued/blocked, have attempts zero, no prior error or durable send marker, no result URI or idempotency key, no dependency on either side, and no indexed scrobble or record-state row. Preparation happens before the transaction; the transaction rechecks exact DID, collection, import job, operation state, every import-item/listen-key membership and affected row counts before cancelling old operations with `rebatched` and repointing all mappings. Selection and packing are bounded to `WRITE_SLICE`; a lone remainder is still a batch create.
- Batch entries have a durable entry-id-to-import-item map. A definite per-record rejection splits into two child containers and transactionally repoints the original items and keys before settling the parent. Schema-level InvalidRequest and recognizable schema/lexicon InvalidRecord messages trip a batch circuit breaker; size-related InvalidRequest, other InvalidRecord, and 413 responses split. Ambiguous and transient responses never split. A retry reads the repository digest first; it resends only after an explicit absence, and a different digest is terminal.
- With batch publication closed, staged listens, never-sent import singles and all batch operations remain dormant without a polling alarm; loves can still be written as single records, and attempted single operations can finish. The same eligibility predicate gates every runner selection and dispatch path. Batch scope is checked from the token before sending; `ScopeMissing` and `InsufficientScope` pause only the batch lane with `batch_scope_required` instead of failing import items.
- Import ETA counts queued operation containers at three points each and staged listens in groups of 200. A 1,000-listen queue is five containers / 15 points; the 201-listen writer regression checks the one-listen remainder. Migration 5 adds the durable send marker and entry mapping table; migrations 1–4 remain unchanged.

## Verification

- `npm run typecheck -- --pretty false` — passed.
- `npx vitest run --config vitest.node.config.ts test/node/imports test/node/outbox --maxWorkers=1` from `worker/` — 15 files, 78 tests passed.
- `npx vitest run --config vitest.config.ts test/write-policy.test.ts` from `packages/core/` — 1 file, 5 tests passed.
- Biome formatting/check on owned TypeScript and Node test files — passed.
- `python3.14 scripts/validate_case_map.py --check-tests --node-wave 10` (or `.venv/bin/python`) — passed with all 258 mapped cases and the new N10-01 targets.
- `docs/planning/node-waves.json` and `docs/verification/ts-case-map.json` parse as JSON.

## Remaining work / limits

- Async preparation races and split/rebatch transaction rollback are fault-injected; shared size tests cover exact UTF-8 sizing including non-ASCII values.
- Individual batch-listen deletion remains owned by the next slice and was not changed here.
