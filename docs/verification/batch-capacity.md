# scrobbleBatch capacity: verified limits and evidence

Package N12-01 (ADR 0006, "Capacity"). Base: `7792b4b` (`t3/removal-uncertainty-hardening`). Containers stay inline
`scrobbleBatch` records: no archive records, `uploadBlob` or lexicon publication. The batch publication gate stays
closed until the owner publishes and verifies the new candidate (see
[lexicon publication](lexicon-publication/README.md)).

## Verified upstream limits

All sources are primary and pinned to bluesky-social/atproto `fe343a1b90c1de470a45b0469628a9e75e7d883f`. The installed
`@atproto/pds` 0.5.40 (`node_modules/@atproto/pds/dist/…`) has the same values: `jsonLimit: 1_000_000` in
`createRecord.js`, `putRecord.js` and `applyWrites.js`; `writes.length > 200` and `relevantBlocks.byteSize > 2000000`
in `actor-store/repo/transactor.js`.

| Limit | Value | Source |
| --- | --- | --- |
| `com.atproto.repo.createRecord` JSON body | 1,000,000 decimal bytes | [createRecord.ts#L47-L49](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/createRecord.ts#L47-L49) |
| `com.atproto.repo.putRecord` JSON body | 1,000,000 decimal bytes | [putRecord.ts#L56-L58](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/putRecord.ts#L56-L58) |
| `com.atproto.repo.applyWrites` JSON body | 1,000,000 decimal bytes | [applyWrites.ts#L68-L70](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/applyWrites.ts#L68-L70) |
| `applyWrites` writes per call | 200 **operations** (not listens) | [applyWrites.ts#L85-L87](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/applyWrites.ts#L85-L87), again in [transactor.ts#L85-L87](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/actor-store/repo/transactor.ts#L85-L87) |
| One commit's relevant blocks (record, MST nodes, commit) | 2,000,000 bytes | [transactor.ts#L89-L93](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/actor-store/repo/transactor.ts#L89-L93); `#commit.blocks` `maxLength: 2000000` and `ops` `maxLength: 200` in [subscribeRepos.json#L77-L90](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/lexicons/com/atproto/sync/subscribeRepos.json#L77-L90) |
| Write points | create 3; applyWrites sums 3 per create, 2 per update, 1 per delete | [createRecord.ts#L35-L46](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/createRecord.ts#L35-L46), [applyWrites.ts#L20-L36](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/api/com/atproto/repo/applyWrites.ts#L20-L36) |

How the JSON limit is applied:

- xrpc-server passes the route's `jsonLimit` to `bodyParser.json({ limit })`
  ([util.ts#L556-L563](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/xrpc-server/src/util.ts#L556-L563)).
- The atproto lockfile resolves body-parser 1.20.9 and raw-body 2.5.3
  ([pnpm-lock.yaml#L6650](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/pnpm-lock.yaml#L6650),
  [#L9454](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/pnpm-lock.yaml#L9454)).
- body-parser passes a numeric limit through `bytes.parse` unchanged
  ([json.js#L56-L58](https://github.com/expressjs/body-parser/blob/a64f1404e256b3f0e3ce633e081a7593fe482203/lib/types/json.js#L56-L58)).
- raw-body answers 413 only when the declared `Content-Length` or the received byte count is **greater than** the limit
  ([index.js#L162](https://github.com/stream-utils/raw-body/blob/223a87d8fd98025e95a925652260268a1774ea1d/index.js#L162),
  [#L259](https://github.com/stream-utils/raw-body/blob/223a87d8fd98025e95a925652260268a1774ea1d/index.js#L259)).
- So a body of exactly 1,000,000 bytes is accepted. The count is of the (decoded) body bytes; we send no `Content-Encoding`.

No per-record CBOR cap exists:

- [prepare.ts](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/pds/src/repo/prepare.ts)
  has no size or length bound.
- Neither do [repo.ts](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/repo/src/repo.ts),
  [car.ts](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/repo/src/car.ts) or
  [util.ts](https://github.com/bluesky-social/atproto/blob/fe343a1b90c1de470a45b0469628a9e75e7d883f/packages/repo/src/util.ts).
- No "1 MiB per record" limit is assumed. A record is bounded only by the request limit (JSON writes) and the 2,000,000-byte commit block limit.

## Chosen bounds (`packages/core/src/scrobble-batch.ts`)

| Constant | Value | Reason |
| --- | --- | --- |
| `PDS_JSON_BODY_LIMIT_BYTES` | 1,000,000 | The verified `jsonLimit` (inclusive). |
| `WRITE_SAFETY_MARGIN_BYTES` | 10,000 (1 %) | Kept below the limit on every request; assumes no proxy limit. |
| `MAX_WRITE_BODY_BYTES` | 990,000 | Hard ceiling for every scrobbleBatch `createRecord`/`putRecord` body we send (exact UTF-8 of `JSON.stringify(body)`, the bytes `PdsXrpc.procedure` sends). The `applyWrites` body cap (`MAX_BATCH_BYTES`, singles only) uses it too; the 200-write limit is unchanged. |
| `PUT_SWAP_RESERVE_BYTES` | 546 | `,"swapCommit":"<cid>"` + `,"swapRecord":"<cid>"` = 2 × (16 + 257) for the longest CID the removal accepts (`/^b[a-z2-7]{8,256}$/`). |
| `MAX_CREATE_BODY_BYTES` | 989,454 | The packing target. A partial-removal put of our container drops at least one entry and adds at most 546 bytes, so it stays ≤ 990,000. |
| `MAX_CBOR_BYTES` | 990,000 | Exact DAG-CBOR guard. For validated entries DAG-CBOR is always smaller than JSON (property test), so it never binds before the body limit for our containers. It is still checked, also for retained owner bytes a removal puts back, where that need not hold: an array of ≥ 64 KiB strings encodes larger in CBOR. |
| `MAX_INGEST_CBOR_BYTES` | 2,000,000 | Ingest acceptance of a verified container (the commit block limit), replacing the old 64,000/100,000 check that would have excluded our own new containers. |
| `BATCH_MAX_LISTENS` (lexicon `maxLength`) | 10,000 | Resource ceiling. The shortest valid entry is 118 JSON bytes (`MIN_ENTRY_JSON_BYTES`: 13-char TID, 1-byte artist and track, two 20-char datetimes; shorter spellings are rejected, tested), so n entries need ≥ 119n − 1 bytes. A record under 1,000,000 bytes therefore holds ≤ 8,403 valid entries, and ours ≤ 8,314. The count never binds first; 10,000 valid entries validate, 10,001 do not. |

## Algorithm decisions

**Packer** (`packScrobbleBatchEntries`). With an `AdditiveBatchSizer`, sizes are exact sums:

- DAG-CBOR is the record with an empty `listens` array, its one-byte header replaced by the header for n entries, plus each entry's own encoding.
- JSON is the body with `"listens":[]`, plus each entry's JSON and n − 1 commas.

Packing is linear. Each group boundary is verified with the whole-group encoding: the group fits and equals the sum, and the group plus the next entry does not fit. A disagreement throws. This was tested against an independent arithmetic encoder over 1 to 2,500 entries, covering every array-header width.

Without a sizer the generic `measure` callback keeps its old greedy semantics and assumes no monotonicity. That path is quadratic, and the test shows it measures more than 1,000,000 items for 2,000 entries, while the additive path measures at most 2n + groups.

**Writer** (`writeBatchSlice`). With publication open, each slice:

- scans staged items in order, in chunks of 1,000, at most `BATCH_SCAN_LIMIT` = 10,001 items;
- creates at most one container: the longest fitting prefix of the eligible listens;
- leaves the listen that did not fit, and everything after it, staged for the next slice;
- settles invalid items, duplicates (rechecked in the transaction) and loves met before the stop (loves up to the free room).

A container is emitted only when it is full or no staged item is left, so only a job's last container is short. A scan that reached 10,001 items without filling its container must have settled at least one item: 10,001 eligible listens cannot fit one container. Every slice therefore makes progress, with no spin and no early short container.

Unchanged:

- Back-pressure: a slice runs only while fewer than `WRITE_SLICE` (1,000) items are queued. Cancel still stops new operations at once.
- Phase boundaries: writing starts only after fetching ends.
- Sent or unknown-history operations are never rewritten.
- Rebatching of explicitly unsent singles reads 10,001 candidates and keeps a short last group for the next pass.
- Unknown-history singles finish at their original rkey; the 833-written-items regression still passes.
- Entry fields, entry `createdAt`, stable ids and per-listen counters are unchanged.

TIDs now come from the module clock, so they stay strictly increasing across slices.

**ETA.** Containers are estimated from the staged listens' JSON bytes, plus 64 bytes each, divided by 989,454, instead of 200 listens per record.

## Read and verify paths

- **Read-before-retry and removal reads** (`repo.getRecord` over the OAuth writer):
  - Response caps are 1 MiB (`PdsXrpc` `MAX_SUCCESS_BODY_BYTES`, `OAUTH_FETCH_CAPS`).
  - A full container's answer is about 989.4 KB. Any record written through the JSON API answers at most about 1,000,200 bytes.
  - Unchanged. Tested: a lost create answer for a full container is read back, never resent.
- **Record proofs** (`sync.getRecord`, SafeFetch `getRecord` 1 MiB):
  - Measured on a 20,000-record signed repo with an 843-listen container packed to 989,060 body bytes.
  - Record block 972,068 B; whole CAR 976,102 B (commit, MST path and framing 4,034 B).
  - The cap leaves more than 50 KiB beyond any container packed to the target. Unchanged.
- **Snapshots, `getBlocks`** (8 MiB, 100 CIDs):
  - 100 full containers would exceed the cap (64,000-byte containers never did).
  - A batch answered `body_too_large` is now bisected down to single CIDs (at most 2n − 1 requests). One block is ≤ 2,000,000 bytes.
  - Tested: 12 containers of ~0.9 MB went as 12 → 6 + 6.
- **Snapshots, `getRepo` fallback** (32 MiB, 2 MiB sections): a container block fits a section. The 32 MiB repository cap is unchanged; see Risks.
- **Partial removal** (`putRecord` with `swapCommit` and `swapRecord`):
  - The pin gate now measures the exact put body (≤ 990,000) and the record's DAG-CBOR (≤ 990,000).
  - Tested on a full container: the put carried both swaps, stayed under the ceiling, and kept every other entry id in order.
- **Jetstream** (ingest parser drops messages over 64 KiB as `oversize`):
  - A full container's create or update event (about 1 MB of record JSON) is always dropped there. This already held for containers whose JSON passed 64 KiB under the old 100,000-byte body limit.
  - Our own writes do not depend on it: outbox success queues local verify hints (`outbox/runner.ts` `queueHints`).
  - Deletes are small events and still arrive. Other clients' edits of large containers are seen through snapshots.
- **Adjacent containers**: containers always go as their own `createRecord`, never in `applyWrites` (the runner batches only the single scrobble collection). Tested: two full containers sent as two creates, zero `applyWrites`.

## Representative measurements

All measurements go through the actual path: `mapListenBrainzRow` → `stageEntries` → `writeSlice` (see `worker/test/node/imports/batch-capacity.test.ts`). The fixtures are deterministic and labelled; none is measured user data.

The **representative** fixture is a ListenBrainz listen as a typical scrobbler submits it:

- `artist_name` "Radiohead", `track_name` "Weird Fishes/Arpeggi", `release_name` "In Rainbows";
- `recording_mbid`, `release_mbid`, `release_group_mbid`, one `artist_mbids`;
- `duration_ms` 318,000, `tracknumber` 4;
- `submission_client` "Pano Scrobbler" with version "3.9.1", `music_service` "spotify.com".

It builds a 507-byte entry with 14 fields. Its `listenedAt` keeps nanosecond precision, as `buildScrobbleRecord` writes it.

| Fixture | Entry JSON | Listens per container | Container CBOR / body | Body with the next listen |
| --- | --- | --- | --- | --- |
| Representative | 507 B | **1,947** | 889,868 / 989,297 B | 989,805 B (> 989,454) |
| Minimal (1-char artist and title) | 128 B | 7,668 | 835,901 / 989,393 B | 989,522 B |
| Maximal (every field at its longest; 256-scalar emoji/accented/escaped text, 10 artist MBIDs) | 4,224 B | 234 | 642,418 / 988,871 B | 993,096 B |

Points (create = 3):

| Listens | Byte-filled containers | Old 200-entry packing | Single records |
| --- | --- | --- | --- |
| 1,000 standalone | 1 create, 3 points | 5 creates, 15 points | 3,000 points |
| Amortized in a large import, per 1,000 | 3 × 1,000 / 1,947 = 1.54 points | 15 points | 3,000 points |
| 3,000 through the writer | [1,947, 1,053]: 2 creates, 6 points | 15 creates, 45 points | 9,000 points |
| 116,700 | 59 × 1,947 + 1,827: 60 creates, 180 points | 584 creates, 1,752 points | 350,100 points |

## Tests

Focused runs used `nice -n 15 taskset -c 18,19 npx vitest run … --maxWorkers 1`. The full node-backend gate was not run (Sol runs it on the accepted head).

- `packages/core/test/scrobble-batch.test.ts`: limit arithmetic, minimum-entry proof, count-ceiling bounds, additive vs whole-group equivalence, linear-work bound, sizer disagreement, `BatchPrefix`.
- `packages/atproto/test/scrobble-batch-size.test.ts`: independent arithmetic DAG-CBOR/JSON oracle at the exact boundary for ASCII, `"`, `\u0001`, 3-byte and 4-byte text; sizer exactness across header widths; DAG-CBOR < JSON for validated entries; more than 1,000 escape-rich listens per container with the next one rejected.
- `packages/atproto/test/record-proof.test.ts`: full-container proof on a deep MST within 1 MiB.
- `packages/atproto/test/snapshot-walker.test.ts`: getBlocks bisection.
- `worker/test/node/imports/batch-capacity.test.ts`: the measurements above.
- `worker/test/node/imports/writer.test.ts`:
  - budget, back-pressure and cancel with full containers;
  - more than 200 and more than 1,000 per container, with only the tail short;
  - lost answer read back; one create per container; swapped partial-removal put;
  - scan-limit progress; love-, duplicate- and invalid-heavy windows;
  - existing restart, split, rebatch and 833-written regressions.
- `worker/test/write/apply-batch.test.ts`: a 1.5 MB verified container applies; over 2,000,000 bytes is excluded.
- `worker/test/node/journey/import-journey.test.ts`: 1,050 long-name listens in three containers, including the mid-write restart.
- `worker/test/node/outbox/*` batch, removal, uncertain-send and ordering suites: unchanged and passing.

## Migration and gate implications

- **Schema**: no database migration. Existing containers of at most 200 entries (≤ 100,000 bytes) stay valid, sendable, readable and deletable, because every limit only loosened.
- **Pinned removal requests**: those persisted under the old limits still parse.
- **Lexicon**: the unpublished candidate changed (`listens.maxLength` 200 → 10,000, description). Its content digest therefore differs from any earlier review. Publication stays closed until the owner publishes this new candidate and records a new five-schema manifest.
- **Already-written items and the cutover**:
  - Already-written items and receipts are untouched.
  - Staged listens of a running import are packed by bytes after the upgrade.
  - Queued, never-sent containers created before it keep their (smaller) size.

## Risks

- **Margin and proxies.** The 1 % margin assumes no intermediary rewrites or re-encodes bodies. A proxy with a lower body limit than the PDS would reject full containers with 413. That is a definite rejection, so the container is split into halves, as before.
- **`getRepo` fallback (32 MiB).** It cannot hold the repository of a very large import (about 116,700 representative listens are about 53 MB of record blocks). This depends on total listen bytes, not container size, so it also held under the old packing. `getBlocks` (bisected) remains the primary path.
- **Records over 1 MiB.** Containers by other writers between about 1,048,000 and 2,000,000 bytes (only via non-JSON paths such as `importRepo`) cannot be proof-read under the 1 MiB `getRecord` cap. They are projected only through snapshots.
- **Jetstream.** Full-container events are always dropped as oversize (see above).
- **Representative fixture.** It is not a measurement of real users. Longer metadata lowers listens per container, down to 234 at the maximal fixture.
