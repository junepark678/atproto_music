# Evidence inventory and blocked acceptance

[live-evidence.json](live-evidence.json) records the prerequisites and evidence required by the live backend acceptance inventory. It currently contains no accepted live runs. Run:

```sh
python3 scripts/verify_live_evidence.py
python3 scripts/test_live_evidence.py
```

The first command intentionally exits **2, blocked** and names every missing prerequisite/evidence entry. The second runs four deterministic regression checks proving blocked behavior; those checks do not establish live interoperability. Do not convert the blocked exit into a successful release gate.

Live execution requirements and current blockers are recorded separately for [OAuth](oauth-live.md), [scrobble lifecycle](scrobble-live.md), [two-PDS federation](federation-live.md) and [complete backend acceptance](backend-live.md). Production current-head verification enables owned-namespace writes and snapshots; it does not establish historical relay-event trust or complete subscription coverage.

When genuine live runs become available, record dedicated DIDs, the owned production namespace, the public HTTPS origin, two different PDS endpoints and independently verified operator/relay coverage. Each required entry (`oauth`, `localWrite`, `externalWrite`, `follow`, `stats`, `delete`, `restore`) must include a passed result, the same artifact SHA-256, source commit, timezone-qualified timestamp, exact test command, a reference to independently verified sanitized evidence, cleanup outcome and `fixtureOnly:false`. Keep codes, cookies, tokens, encryption keys and private signing keys out of this file.

Use `python3 scripts/verify_live_evidence.py --artifact <binary>` to bind the recorded checksums to the actual packaged artifact. The verifier checks inventory completeness and checksums. It does not perform sign-in, create records, validate repository signatures or establish that the cited evidence is authentic; inspect the referenced verification artifacts before accepting a live gate. Fixture-only evidence is rejected even when all fields are present. Version/date/result and independent record verification requirements are specified in [TESTING.md](../planning/TESTING.md).
