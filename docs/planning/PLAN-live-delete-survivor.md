# LIVE-DELETE-SURVIVOR P1 — test-first checkpoint

Status: separately approved P1, after B2 readiness and before finding 32 code.
This commit is the red-test checkpoint only. It is based exactly on
`9405a832c21547f50eba9231e61aa728df88e400` (B2 production branch
`t3/finding01-b2-love-deferral-luna`). No production implementation, schema
change, dependency, lockfile, configuration, or timeout change belongs here.

## Binding behavior

For an event-caused, non-API-absence unlove, enqueue and dispatch must each use
an indexed point lookup to determine whether another present canonical track
love survives. If one survives, ignore the unlove locally as `local_survivor`.
An explicit API unlove always forwards. Do not add an automatic LOVE UPDATE
producer. Reuse of `loves_owner_track` appears sufficient from the source
review; this slice allocates no migration (and does not consume migration 57).

Source exclusion is scoped only to the imported `importedLoveKey`. Later live
URIs are independent events and inherit no import-operation exclusion.
Multiple queued rows for distinct link IDs do not prove a duplicate per-link
queue bug.

## Red evidence

The preserved reproduction is an ordinary `it`, appended to
`worker/test/node/forward/listenbrainz-forward.test.ts`. It requires a live
same-track survivor to prevent score 0 after the first delete, while retaining
zero-effect controls, the last-copy positive unlove, and source-exclusion
scoped only to the imported key.

Sol's saved real-wire probes on both accepted B1 and current B2 demonstrate the
undesired score 0 while a verified same-track survivor remains:
`/tmp/atproto-followup-sol/pr205-sol-survivor-b1-wire-with-imports.log` and
`/tmp/atproto-followup-sol/pr205-sol-survivor-b2-wire.log`. The earlier B1
probe without `stageLovePage` / `writePullSlice` imports is a setup failure and
is not counted as behavior evidence. These real-wire probes are separate from
the ordinary red regression, which fails on B2 at the target-link survivor queue
assertion. Its focused output is `/tmp/atproto-followup-sol/live-delete-survivor-red-b2.log`.

## Green-phase scope and acceptance

Expected implementation ownership after Sol resumes this slice: `apply-record.ts`,
`live-pending-removals.ts`, and the shared authorized-unlove dispatch guard.
Required coverage includes direct and delayed non-API-absence events, two valid
links, a survivor at enqueue, a survivor appearing after enqueue (ignored at
dispatch with `local_survivor`), last-survivor removal, explicit API-unlove
control, normalized canonical keys and DID isolation, source provenance,
generation/revival, and load-bearing negative cases. No automatic update
producer is included.

The green phase must pass Sol's readiness gate on the exact local tree,
independent Astra review, and hosted checks. This test-first checkpoint does
not claim readiness or defect closure.
