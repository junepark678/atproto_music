# MVP milestone status

Recorded 2026-10-06 UTC. The implementation is a backend candidate. The fresh workspace run passed 331 Rust tests, 21 Python regressions and three independent fixture validators. The rebuilt Linux musl executable passed static smoke, packaging/checksums and the constrained read benchmark. [VALIDATION.md](VALIDATION.md) records the artifact, scope and remaining gates.

The [MVP plan](planning/MVP.md) requires merged deliverables and executed acceptance, including the applicable live evidence. No milestone or issue is closed by this candidate. Function counts do not prove all 258 named requirements.

| Milestone | Implemented and locally verified | Remaining completion work |
| --- | --- | --- |
| M1: Contracts and foundation | Schema-v1 lexicons/OpenAPI, namespace publication guard, crate boundaries, embedded schema-4 migrations, atomic bounded writer, static executable checks | Record actual owner-controlled namespace evidence; merge reviewed deliverables and obtain repository CI evidence. |
| M2: Identity and OAuth | Public HTTPS/DNS policy, verified identity, PAR/PKCE/state, ES256 DPoP nonce handling, encrypted refresh material, sessions/CSRF/logout | Execute browser and external-PDS OAuth/refresh/revocation checks against dedicated infrastructure. |
| M3: Scrobble publishing | Durable idempotent admission, exact-current-head signed PDS reconciliation, bounded retries, create/delete crash recovery, history/lookup/cursors | Execute the external-PDS lifecycle and interrupted-write recovery on the packaged process. |
| M4: Federation and feeds | Bounded relay decoding and WSS transport, signature/CID/MST verification, atomic application/checkpoints, signed snapshots and account reconciliation, global/following feeds | Implement safe historical-event progress and subscription-first coverage/recovery. Production relay delivery is disabled. Execute two independently operated PDS writers and covered-relay live acceptance. |
| M5: Read models and social | Unicode grouping, exact four-window statistics, 100,000-row production query-plan checks, verified profiles/handles, duplicate follows and following feed, mutation/restart fixtures | Execute the required packaged persistence journey and independent external social/statistics observations. |
| M6: Deployment and operations | Configuration/proxy/body/rate limits, private metrics, embedded assets, coordinated shutdown, verified backup/restore, musl packaging and benchmark | Implement and execute complete `packaged_flow` and `packaged_recovery` using controlled upstream HTTPS infrastructure; execute and independently review the live backend matrix. |
| M7: Preact product | Unstarted | Begin after actual M6 backend acceptance; then implement screens/API client, browser journeys, accessibility and product live checks. |

Current-head evidence authorizes an exact revision and commit CID using the current DID key. It does not invent historical validity intervals. Moving heads retry within existing bounds. Invalid signatures, CIDs and identity evidence fail closed. A snapshot completed before subscription cannot prove that a quiet actor's intervening commit was observed; completed snapshots therefore do not turn global `caughtUp` true.

Required operator inputs remain an owned namespace with ownership evidence, public HTTPS OAuth callback, dedicated identities on two independent PDSs, a supported relay with independently verified coverage, and privately supplied operator credentials. See [OAuth](verification/oauth-live.md), [scrobble](verification/scrobble-live.md), [federation](verification/federation-live.md) and [packaged acceptance](verification/backend.md) requirements. No external acceptance test has run.
