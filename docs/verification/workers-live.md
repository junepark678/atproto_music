# Workers live gates and platform soak

This page covers the live gates of the Workers deployment (ADR 0004 §10.4, §13, A6, A19; package W6-05). They are the only evidence for OAuth interoperability, Jetstream ingestion, the external writer, delete reconciliation, per-PDS protocol support, Workers `fetch` behaviour toward private addresses, and the socket-versus-pulse decision. Deterministic suites (`npm test`, `bash scripts/check-ts.sh`) never satisfy these gates.

**Current status: every gate is blocked.** No live run has been recorded. `docs/verification/live-evidence.json` is still the schemaVersion 1 inventory from the Rust/musl candidate, so `python3 scripts/verify_live_evidence.py` exits 2 (BLOCKED) for it.

## Rules

- **Credentials come only from the environment.** Nothing is read from argv or from repository files. Use dedicated test identities, never personal accounts.
- **Secrets are redacted** from everything a gate prints: `ADMIN_TOKEN`, passwords, app passwords and the Cloudflare API token. The OAuth gate reads only the `scope` and `sub` of the token response. Access tokens, refresh tokens and codes never enter the evidence.
- **Missing prerequisites block the gate.** If any is missing or invalid, the gate prints a `blocked` evidence document that lists each name, and exits **2** before it makes a network request or launches a browser. A blocked gate is never a skipped success.
- **Fixture values are rejected as prerequisites.** These include the fixture prefix `com.example.atmusic`, `*.example.*`/`.test`/`.internal` hosts, the reserved fixture DIDs `did:plc:aaaa…`–`eeee…`, and IP literals.
- **Verification is the production verifier.** Records are fetched independently with `com.atproto.sync.getRecord` through SafeFetch (with the DoH pre-check), under a fresh identity resolution and the current `#atproto` key. They are checked with `@atmusic/atproto` `verify/record-proof`: CAR bounds, commit signature and MST inclusion or exclusion. No gate weakens or bypasses it.
- **Every gate cleans up after itself.** Records a gate creates are deleted, and the evidence says what, if anything, was left behind.
- **These scripts never deploy and never change DNS or Cloudflare configuration.** The operator deploys with their own credentials.

Exit codes: **0** passed, **1** failed (a live check ran and did not hold), **2** blocked.

## Common prerequisites

| Variable | Meaning |
|---|---|
| `ATMUSIC_LIVE_ORIGIN` | Deployed Worker origin, public HTTPS. Production is `https://music.214510.xyz`. |
| `ATMUSIC_LIVE_LEXICON_PREFIX` | Owned lexicon prefix the deployment indexes. Production is `dev.pythonplayer123.music`; the NSID authority is `music.pythonplayer123.dev`. The gate checks it against `GET /api/v1/meta` (`lexiconPrefix`, plus the `publication` capability). |
| `ATMUSIC_LIVE_WORKER_VERSION_ID` | The Worker version under test (a UUID from `wrangler versions upload` / `wrangler deployments status`). |
| `ATMUSIC_LIVE_BUNDLE_SHA256` | The bundle SHA-256 that `npx tsx scripts/check-bundle.ts --release` printed for that version (A19). |
| `ATMUSIC_LIVE_COMMIT` | Optional. The source commit of the deployed version; defaults to the checked-out `HEAD`. |
| `ATMUSIC_LIVE_DID_A`, `ATMUSIC_LIVE_PDS_A` | Dedicated identity A and its PDS. The gate checks that the DID document names that PDS. |
| `ATMUSIC_LIVE_DID_B`, `ATMUSIC_LIVE_PDS_B` | Dedicated identity B, on a different PDS host. |
| `ATMUSIC_LIVE_PDS_INDEPENDENCE_REF` | Reference to reviewable evidence that the two PDSs are independently operated. |
| `ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF` | Reference to evidence that the configured Jetstream hosts carry commits from both PDSs (A6). |
| `ATMUSIC_LIVE_ADMIN_TOKEN` | The deployment's `ADMIN_TOKEN` (at least 32 characters), used for `/internal/admin/status`. |
| `ATMUSIC_LIVE_PDS_{A,B}_IMPLEMENTATION` | Optional. The PDS implementation name. The version is read from `/xrpc/_health`. Both are recorded as `unreported` when unknown. |
| `ATMUSIC_LIVE_EVIDENCE_OUT` | Optional. A file path that receives a copy of the evidence document, written with mode 0600. |

## The gates

| Gate (`gates.<name>`) | Command | Extra prerequisites | Passes when |
|---|---|---|---|
| `oauth` | `npx tsx scripts/live/workers_oauth_check.ts` | `ATMUSIC_LIVE_HANDLE_{A,B}`. Also either `ATMUSIC_LIVE_PASSWORD_{A,B}` (automated, headless) or `ATMUSIC_LIVE_OAUTH_INTERACTIVE=1` (a headed browser where the operator signs in by hand). Optionally `ATMUSIC_LIVE_OAUTH_TIMEOUT_S`. Run `npx playwright install chromium` once. | See [OAuth](#oauth). |
| `ingest` | `npx tsx scripts/live/workers_ingest_check.ts` | `ADMIN_TOKEN`, `ATMUSIC_LIVE_HANDLE_{A,B}`, sign-in for A as above, and `ATMUSIC_LIVE_APP_PASSWORD_B`. Optionally `ATMUSIC_LIVE_INGEST_TIMEOUT_S` (default 300). | See [Ingest](#ingest). |
| `pdsCompat` | `npx tsx scripts/live/pds_compat_check.ts` | None. | See [PDS compatibility](#pds-compatibility). |
| `ssrfProbe` | `npx tsx scripts/live/ssrf_probe.ts` | `ADMIN_TOKEN`, `ATMUSIC_LIVE_SSRF_PROBE_URL` and `ATMUSIC_LIVE_SSRF_HOSTS`. | SafeFetch refuses every target. The raw outcomes are recorded. |
| `socketSoak` | `npx tsx scripts/live/workers_socket_soak.ts` | `ADMIN_TOKEN`, `ATMUSIC_LIVE_CF_API_TOKEN` (Account Analytics:Read), `ATMUSIC_LIVE_CF_ACCOUNT_ID` and `ATMUSIC_LIVE_CF_DO_NAMESPACE_ID`. Optionally `ATMUSIC_LIVE_SOAK_HOURS` (at least 24) and `ATMUSIC_LIVE_SOAK_POLL_S`. | The full window ran in `socket` mode and every measurement was obtained. The decision is recorded. |

Every gate first checks `GET /api/v1/meta`. Its `lexiconPrefix` must be the configured prefix, and the `publication` capability must be advertised.

The blocked prerequisites line up with the ADR's list. Owned NSID, deployed origin, two identities on independent PDSs, Jetstream coverage and `ADMIN_TOKEN` are required by the gates that use them. Release provenance (version id and bundle hash) is required by all of them.

### OAuth

The gate first checks that `/oauth/client-metadata.json` is the browser public client document:

- `client_id` is `<origin>/oauth/client-metadata.json`, with redirect `<origin>/oauth/callback`;
- `token_endpoint_auth_method` is `none`, and tokens are DPoP-bound;
- the scope is `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings`.

Then, for each PDS, the sign-in must satisfy all of these:

- the flow `/signin` → authorization server → `/oauth/callback` → `/feed` completes;
- the token response's `sub` is the expected DID;
- every `repo:<p>.*` scope is granted, and no `transition:*` scope is;
- `/signin` shows the DID;
- `/settings` → "Sign out" revokes the session.

### Ingest

1. **Jetstream path.** The app publishes on PDS A. The SPA's notify call is answered with 202 inside the browser, so the Worker learns of the record only through Jetstream. The evidence records the lag from the PDS commit to `indexed`.
2. **External writer.** A record is created directly on PDS B with its app password.
3. **Independent verification.** Both records are verified independently. The indexed CID, the written CID and the verified CID must all be equal, and the verified revision is recorded.
4. **Delete and reconcile.** A's record is deleted through the app. B's is deleted externally. Each must reach `absent`, and absence is verified with an MST exclusion proof.
5. **Admin status.** `/internal/admin/status` is sampled before and after the run (mode, socket, cursor lag).

### PDS compatibility

For each PDS, the gate checks:

- a verified getRecord inclusion proof for an existing record;
- that getRepoStatus is supported.

These are recorded, but neither is required:

- an exclusion proof for a never-written rkey (the fallback is a snapshot);
- getBlocks for the current commit block (the fallback is `getRepo`).

Nothing is written.

### SSRF probe

`ATMUSIC_LIVE_SSRF_PROBE_URL` is the origin of the diagnostic Worker. `ATMUSIC_LIVE_SSRF_HOSTS` holds controlled DNS names as `label=host` pairs, and must include `rfc1918`, `loopback` and `metadata`.

DNS pinning is impossible on Workers (A5). The probe therefore records how Workers `fetch` itself treats private addresses on the real edge, and that SafeFetch refuses them.

It runs in a separate, admin-only diagnostic Worker. It is deliberately not a route of the production Worker, which keeps no raw-fetch surface and no test seam.

1. Emit it: `npx tsx scripts/live/ssrf_probe.ts --emit-worker`. This writes `work/ssrf-probe-worker/{probe-worker.ts,wrangler.jsonc}` and makes no network request. The Worker answers only `POST /probe` with `Authorization: Bearer <PROBE_TOKEN>`; it returns 404 otherwise, including when the secret is unset or shorter than 32 characters.

   For each target it makes one raw `fetch` over http and one over https, with redirects set to manual, a 5 s deadline and no credentials, plus one SafeFetch request. It returns only the outcome, status, error name and message, elapsed time and the number of body bytes seen. Bodies and headers are never returned.
2. The operator deploys it with their own credentials (`npx wrangler deploy --config work/ssrf-probe-worker/wrangler.jsonc`). They then set its `PROBE_TOKEN` secret to the `ADMIN_TOKEN` value.
3. In a zone they control, the operator creates the records `rfc1918.<zone>` A `10.0.0.1`, `loopback.<zone>` A `127.0.0.1` and `metadata.<zone>` A `169.254.169.254`, plus optional extra labels such as an AAAA record for `ula`. They then run the probe.

   Before probing, each name is resolved over DoH. It must answer only addresses of its label's class, so a misconfigured name cannot produce a false pass. The IP literals `10.0.0.1`, `127.0.0.1` and `169.254.169.254` are probed as raw baselines.
4. Delete the diagnostic Worker and the DNS records after the evidence is recorded.

The gate passes when SafeFetch refused every target. The raw outcomes are evidence of platform behaviour and are recorded whatever they are. The DNS-rebinding TOCTOU residual (ADR §8) is not closed by this probe; the probe documents it.

### Socket soak

The soak runs for at least 24 h against a deployment with `INGEST_MODE=socket`, and gathers these measurements:

- **Samples.** It samples `/internal/admin/status` every `ATMUSIC_LIVE_SOAK_POLL_S` seconds (default 60).
- **Reconnects.** A host-index change or a disconnected→connected transition counts as one. Sampling can miss a fast reconnect, so this is a lower bound.
- **Lag.** Lag is now minus `lastEventTimeUs`; the soak reports p50, p95 and max.
- **Cloudflare GraphQL Analytics.** Billed DO requests come from `durableObjectsInvocationsAdaptiveGroups`. DO CPU time and WebSocket message counts come from `durableObjectsPeriodicGroups`. The fields are discovered by introspection, so a field Cloudflare does not expose is reported as missing (the gate then fails) rather than guessed. A measurement the data query does not return is missing as well and fails the gate: no account row, no invocation rows, no periodic rows or no alarm invocations in the window. Missing values are recorded as `null`, never as 0.
- **Alarm invocations** come from the invocations dataset's invocation-type dimension.
- **CPU per alarm** is total DO CPU divided by alarm invocations. This is an upper bound, because it includes socket and RPC work.

The decision is `socket` when every threshold below holds, and `pulse` otherwise. Each threshold can be overridden by environment variable, and the evidence records the values used and which ones failed:

| Threshold | Default | Source |
|---|---|---|
| Reconnects per day (lower bound) | ≤ 96 (4/h) | `ATMUSIC_LIVE_SOAK_MAX_RECONNECTS_PER_DAY` |
| Lag p95 | ≤ 60,000 ms | `ATMUSIC_LIVE_SOAK_MAX_LAG_P95_MS` |
| DO requests projected to 30 days | ≤ 10,000,000 (ADR §11 estimate) | `ATMUSIC_LIVE_SOAK_MAX_MONTHLY_DO_REQUESTS` |
| DO CPU ms per alarm (upper bound) | ≤ 15,000 (half the 30 s `cpu_ms` limit) | `ATMUSIC_LIVE_SOAK_MAX_CPU_MS_PER_ALARM` |

## Evidence schema (schemaVersion 2)

Each gate prints one JSON document. It records:

- `schemaVersion: 2`, `gate`, `result` (`passed` | `failed` | `blocked`), `fixtureOnly: false`, `recordedAt` and `testCommand`;
- the release it ran against: `workerVersionId`, `bundleSha256`, `commit`, `origin` and `lexiconPrefix`;
- `pds` (an array of `{endpoint, implementation, version}`) and `subjects` (an array of `{did, uri}`);
- `results` and `cleanup`;
- `missing` when blocked, or `failures` when failed.

The operator assembles the inventory by placing each document under `gates.<name>`:

```json
{
  "schemaVersion": 2,
  "fixtureOnly": false,
  "release": {"workerVersionId": "<uuid>", "bundleSha256": "<64 hex>", "commit": "<40 hex>"},
  "prerequisites": {
    "ownedLexiconPrefix": "dev.pythonplayer123.music",
    "publicHttpsOrigin": "https://music.214510.xyz",
    "identities": [{"did": "<did A>", "pds": "<PDS A>"}, {"did": "<did B>", "pds": "<PDS B>"}],
    "independentPdsOperatorsVerified": true,
    "jetstreamCoverageVerified": true,
    "adminTokenConfigured": true
  },
  "gates": {"oauth": {}, "ingest": {}, "pdsCompat": {}, "ssrfProbe": {}, "socketSoak": {}}
}
```

`python3 scripts/verify_live_evidence.py [inventory] [--bundle-sha256 H] [--worker-version-id V]` classifies the inventory:

- **PASS** (exit 0): all five gates `passed` for that one version and bundle.
- **FAIL** (exit 1): the inventory is bound to the release under review, and a gate recorded `failed` for that release. Bound means: a valid `release` that matches `--bundle-sha256`/`--worker-version-id`, `fixtureOnly: false`, complete prerequisites, and a gate document with the same version id, bundle hash, commit, origin and prefix.
- **BLOCKED** (exit 2): anything else. This includes:
  - a blocked gate, a gate with no evidence, or fixture-only evidence;
  - a gate document whose version id, bundle hash or commit is missing or differs from `release`;
  - an inventory that is not bound to the release under review (see FAIL), even when it records a failed gate: that failure is listed but says nothing about the bundle under review;
  - per-identity results that do not cover both prerequisite identities and PDS hosts. OAuth needs one sign-in per prerequisite DID, pdsCompat one result per prerequisite PDS host, and ingest needs `localPublish` to be a record of identity A and `externalPublish` a different record of identity B;
  - a soak whose analytics lack billed DO requests (at least 1), alarm invocations (at least 1) or DO CPU time, or that lists a missing field;
  - a "passed" document whose required results are absent. For example, the CIDs differ, absence was not verified, SafeFetch fetched a target, or the soak ran for less than 24 h.

`--gate FILE` classifies a single gate document. The verifier checks recorded fields and their consistency. It cannot establish that the cited external evidence is authentic, so reviewers must inspect it. `python3 scripts/test_live_evidence.py` holds its regression tests. Those tests run every gate script with no prerequisites and with a fetch trap preloaded, so they make no network request.

## Case map

The no-env blocked behaviour of `pds_compat_check.ts` is the mapped target for these live cases:

- M2.4.3 `live_round_trip`, `live_disposable_record` and `live_credentials_missing`;
- M3.4.3 `live_create_read` and `live_delete`;
- M4.4.1 `coverage_failure`;
- M4.4.3 `live_remote_arrival`, `live_remote_mutation` and `live_recovery`;
- M7.4.3 `live_product`.

`scripts/test_live_evidence.py` covers M6.4.1 `checksum` (also), M6.4.3 `live_inventory` and M6.4.3 `blocked_gate`. These targets prove that a missing prerequisite blocks the gate. They do not prove interoperability, which only a recorded live run per Worker version can establish.
