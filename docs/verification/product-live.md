# M7 Node product-live acceptance

**Status: BLOCKED — no production Node run is recorded.** The repository's
fixture-backed Playwright journeys and accessibility tests are deterministic
evidence only. They do not prove production OAuth, independent PDS writes,
Jetstream coverage, or browser behavior on the deployed origin.

## Required evidence

Run this gate against the exact deployed Node release and record its full
source commit and production bundle SHA-256:

1. A browser signs in through the production origin using a real PDS account.
2. A second identity on an independently operated PDS creates a record under
   the owned scrobble collection. The record is indexed and readable through
   the deployed browser feed.
3. The external record is deleted and its absence is independently verified
   at a newer repository revision.
4. The evidence identifies both PDS operators, records the Jetstream coverage
   reference, and is accepted by the schema-v3 Node live-evidence verifier.

The current Node ingest driver is operator-run and does not contact Last.fm or
ListenBrainz. Its successful result is required for the write/index/delete
observations above. The PDS compatibility result must also establish each
PDS's inclusion and absence-proof capability before ingest evidence can be
paired with it. A missing prerequisite or no-environment refusal remains
blocked; it is not a product pass.

## Operator record

Fill this section only after the production run. Do not commit credentials,
cookies, app passwords, tokens, or private endpoint access details.

| Field | Value |
| --- | --- |
| Result | BLOCKED — not run |
| Recorded at | — |
| Source commit | — |
| Production bundle SHA-256 | — |
| Production origin and owned prefix | — |
| PDS A identity and operator reference | — |
| PDS B identity and independent-operator reference | — |
| Jetstream coverage reference | — |
| `pdsCompat` evidence reference | — |
| `ingest` evidence reference | — |
| Deployed browser-feed observation | — |
| Verifier result | — |

No live product evidence is currently available. M7 remains open until these
fields are backed by a passing, release-bound Node inventory and the deployed
browser-feed observation.
