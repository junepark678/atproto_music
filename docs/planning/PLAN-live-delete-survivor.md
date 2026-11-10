# LIVE-DELETE-SURVIVOR P1

Status: local implementation and scoped checks pass; Sol owns final full/Astra/
hosted green readiness. This is separate from B2 and precedes finding 32 code.
The worktree started at red checkpoint `f8a7b4c7fbd6c4481bff71f7b35a0c67bae37c71`
and normally merged accepted B2 `85f46f734d02f5cb9392083659b16ceaa4c5ca2c`.
No B2 or finding 32 production source was changed.

## Binding behavior and implementation

An event-caused unlove with the exact immutable repository authorization tuple
is admitted only when no other projected love has the same DID and canonical
artist/track keys. The guard runs centrally inside the enqueue transaction
before deferred intent recording, receipts, or outbox insertion, covering direct,
delayed, and authorized coverage enqueue paths. Explicit API unlove has no live
authorization tuple and continues to forward as user intent. Payload `origin` is
not used to classify provenance.

The shared dispatch guard repeats the lookup before credential opening, pacing,
or transport. A late survivor settles the existing row `ignored` with
`local_survivor`, no attempt, no wire call, and no link-health error. MBID revival
also checks before inserting an authorized event-unlove child; children retain
the parent's generation, authorization, and witness ownership. No automatic
LOVE UPDATE producer was added.

`worker/src/outbox/live-track-survivor.ts` exports the production SQL and helper.
The exact `SELECT 1 ... LIMIT 1` forces the existing migration-created
`loves_owner_track(did,artist_key,track_key)` index. No DDL or migration was
added. Tuple-less historical MBID children remain under their existing R1/R14/
R15/R18 provenance debt; this slice adds no heuristic, history scan, or schema.

## Regression and evidence

The ordinary regression remains in
`worker/test/node/forward/listenbrainz-forward.test.ts`. It was red after the
accepted B2 merge at the target-link queued-unlove assertion. Its source import
exclusion is scoped only to `importedLoveKey`; a valid fake Last.fm credential
now lets unrelated live URI love events reach every eligible link. The test
observes the import and both live love transitions as three score-1 ListenBrainz
calls, no unlove after the first deletion, then one final score-0 and one
`track.unlove` across the two valid services after the last-copy deletion. The
outbox records exactly one sent unlove for each valid link.

- Post-merge red: `/tmp/atproto-followup-sol/live-delete-survivor-red-85f46f7.log`
- Original B1/B2 real-wire receipts: `/tmp/atproto-followup-sol/pr205-sol-survivor-b1-wire-with-imports.log`, `/tmp/atproto-followup-sol/pr205-sol-survivor-b2-wire.log`
- Green focused Node receipt: `/tmp/atproto-followup-sol/live-delete-survivor-green-focused.log` (74 tests)
- Growth/index receipt: `/tmp/atproto-followup-sol/live-delete-survivor-bench.log`
- Enqueue-veto break: `/tmp/atproto-followup-sol/live-delete-survivor-enqueue-veto-broken.log` (red at queued-row assertion)
- Dispatch-veto break: `/tmp/atproto-followup-sol/live-delete-survivor-dispatch-veto-broken.log` (real score 0 observed)

Coverage includes delayed removal with an older same-track survivor; DID/key
isolation and normalized display variants; priority-1 disabled/revoked coverage
enqueue; explicit API-unlove positive control while projection remains; dispatch
late-survivor local settlement; and authorized MBID-revival child suppression
before enqueue and again at dispatch with generation and provenance intact.

The direct-SQL `worker/test/bench/live-track-survivor.bench.test.ts` seeds 1k
then 10k rows. At both sizes it verifies the production SQL selects
`loves_owner_track`, with no table scan or temporary sort, one lookup statement,
and at most one returned row. It makes no elapsed-time claim and does not pin
EXPLAIN opcodes.

## Local checks and remaining gates

Passed locally:

- `npx vitest run --project worker-node worker/test/node/forward/listenbrainz-forward.test.ts worker/test/node/outbox/live-pending-removals.test.ts worker/test/node/musicbrainz-store.test.ts --maxWorkers=1` — 74/74.
- `npx vitest run --project worker-bench worker/test/bench/live-track-survivor.bench.test.ts --maxWorkers=1` — 1/1.
- `npm run typecheck` (project-reference build).
- Scoped Biome and `git diff --check`.

Sol owns the exact-tree full gate, independent Astra acceptance, and hosted
checks. No whole-milestone or production-readiness claim is made here.
