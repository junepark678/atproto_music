# Batched imports, slice C implementation evidence

Base: `a9fcad5` (slice B). The change remains local to the Node outbox and import writer; it does not publish the candidate lexicon or open the production publication gate.

## Implemented in this slice

- The Node import writer packs eligible listens in stable order into durable `scrobble.create` operations using the configured `.scrobbleBatch` collection. Each entry keeps the single record's fields and `createdAt`, with its stable TID stored as the entry id. Packing measures DAG-CBOR and exact UTF-8 createRecord bodies before persistence, with the 200-entry, 64,000-byte CBOR and 100,000-byte body limits.
- Batch operations use `createRecord` and digest reconciliation, and do not enter `applyWrites` grouping. The existing 3-point create accounting therefore applies per container. Import items and listen keys point to their containing operation, so outcome sync counts individual listens.
- Existing queued import singles can be migrated only when they are queued/blocked, have attempts zero, no result URI or idempotency key, no dependency on either side, and no indexed scrobble or record-state row. Preparation happens before the transaction; the transaction rechecks operation state and exact import-item/listen-key membership before cancelling old operations with `rebatched` and repointing all mappings.
- With batch publication closed, staged listens and never-sent import singles remain dormant; loves can still be written as single records. The runner omits dormant writes from its due-work/alarm calculation while still reconciling operations that may have been sent. Scope rejection blocks the batch lane with `batch_scope_required` instead of failing import items.
- Import ETA uses queued operation count and estimates staged listen containers in groups of 200. The Node wave record includes the new writer and migration evidence targets.

## Verification

- `npm run typecheck -- --pretty false` — passed.
- `npx vitest run --config vitest.node.config.ts test/node/imports test/node/outbox --maxWorkers=1` from `worker/` — 15 files, 68 tests passed.
- Biome formatting/check on owned TypeScript and Node test files — passed.
- `docs/planning/node-waves.json` parses as JSON. The Python case-map validator could not run in this environment because no Python interpreter is installed.

## Remaining work / limits

- Definite batch-record rejection does not yet bisect into durable child operations; a rejected batch currently settles as a failed operation for its mapped listens. The schema-level circuit breaker is therefore not implemented.
- Scope is handled reactively from the batch write response; the session token scope is not proactively inspected. `InsufficientScope` is covered by the existing classifier; distinct `ScopeMissing` naming needs an additional classification path.
- Dedicated regression coverage for concurrent runner-versus-rebatch races, transactional fault injection, multibyte-heavy exact body-cap boundaries, and the requested 15-point / 1,000-listen fake-PDS scenario remains to be added.
- Individual batch-listen deletion remains owned by the next slice and was not changed here.
