# Live external-PDS OAuth verification

M2.4.3 remains **blocked**. No live account consent, public callback, external
record write, refresh, or revocation was executed in this environment. The
controlled HTTP tests in [the fixture guide](../../tests/fixtures/oauth/README.md)
exercise actual signatures and protocol checks; they do not close this gate.

Run the helper from the repository root:

```sh
python3 scripts/live/oauth_check.py
python3 scripts/live/oauth_check_test.py
```

The first command without configuration exits **2** and lists missing names.
The second checks blocked behavior, private-file handling, evidence redaction,
and cleanup sequencing. Its fixtures are helper regressions only. A configured
helper phase returns 0 when that phase's HTTP observations succeed; it prints
`OBSERVED`, never overall live acceptance. Collect and independently review all
required observations before recording a passed live inventory entry.

## Prerequisites

Use an operator-owned public HTTPS deployment, the exact release binary/source
commit, a dedicated disposable external-PDS identity, an owned production NSID
namespace with recorded ownership, and a relay covering that PDS. The server
needs direct secure egress or an audited injected transport that preserves DNS
validation and address pinning. The current production transport disables
independently resolving proxies; this managed session's proxy does not provide
the application's pinned DNS invariant. Do not bypass TLS or replace public
acceptance with reserved-domain fixtures. Helper HTTP requests retain the
operator's proxy and default CA trust.

Supply configuration through secure operator settings. Do not put credentials,
authorization codes, callback query strings, cookies, tokens, private keys,
encryption keys, or raw HAR files into chat, command arguments, repository files,
issue bodies, logs, or published evidence.

The helper requires these environment names:

| Name | Value |
| --- | --- |
| `ATMUSIC_PUBLIC_ORIGIN` | canonical public default-port HTTPS application origin |
| `ATMUSIC_OAUTH_TEST_HANDLE` | dedicated account's verified handle |
| `ATMUSIC_OAUTH_EXPECTED_DID` | independently verified dedicated DID |
| `ATMUSIC_OAUTH_PDS_ORIGIN` | account's independently verified HTTPS PDS origin |
| `ATMUSIC_LEXICON_PREFIX` | owned production collection prefix |
| `ATMUSIC_NAMESPACE_OWNER_DOMAIN` | namespace owner domain configured in deployment |
| `ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE` | reviewed ownership evidence reference |
| `ATMUSIC_RELAY_URL` | secure relay covering the external PDS |
| `ATMUSIC_OAUTH_RELAY_COVERAGE_REFERENCE` | independently reviewed relay coverage reference |
| `ATMUSIC_OAUTH_ARTIFACT` | local path to the exact packaged deployment binary |
| `ATMUSIC_OAUTH_SOURCE_COMMIT` | its exact 40-character source commit |
| `ATMUSIC_OAUTH_EVIDENCE_DIR` | private directory outside the checkout, mode 0700 |

Record PDS/authorization-server/relay implementations and versions, or explicitly
record unavailable version information and the retrieval date. Verify that the
deployed binary checksum equals the helper's recorded artifact SHA-256. The
helper hashes the supplied artifact; it cannot inspect a remote process binary,
establish namespace ownership, or attest the operator's relay coverage itself.

## `live_round_trip`

1. Run `python3 scripts/live/oauth_check.py --phase preflight`. It checks exact
   client ID/callback, the three collection-specific scopes, public-client/PAR/
   DPoP metadata, and the expected bidirectionally verified DID.
2. Run `python3 scripts/live/oauth_check.py --phase start`. The authorization URL
   is saved only in a mode-0600 `authorization-*.private` file. Open that private
   file locally and navigate the dedicated browser session to its URL. Complete
   the external authorization server's actual account consent. Treat this URL
   as sensitive; the helper neither prints it nor emulates browser consent.
3. Confirm the browser callback returns 303 to the configured `/feed`, with a
   `Secure; HttpOnly; SameSite=Lax; Path=/` application cookie and `no-store`.
   Redact the entire callback query, cookie value, state, and authorization code
   before collecting any trace. Record only status, destination path, cookie
   attributes, UTC date, server versions, and the expected DID result.
4. Transfer only the dedicated `atmusic_session=<value>` cookie pair through a
   secure local editor into an owner-only mode-0600 regular file. Set
   `ATMUSIC_OAUTH_COOKIE_FILE` to that file's path. The helper accepts neither
   cookies on command arguments nor an unprotected file. It retains CSRF only
   in process memory.
5. Run `python3 scripts/live/oauth_check.py --phase session`, then the disposable
   record phase below. The session result must report the expected DID with
   no-store. A successful record demonstrates the scrobble write permission;
   metadata scope display alone does not demonstrate a usable grant.

Keep callback/browser observations as a separately reviewed sanitized artifact.
The helper only observes the resulting session; it does not inspect callback
requests or independently prove that consent occurred in the intended browser.

## `live_disposable_record`

Run `python3 scripts/live/oauth_check.py --phase record` while the dedicated
session is active. This creates exactly one unique schema-valid disposable
scrobble, waits at most 180 seconds for its owner operation, reads the verified
application row, and independently calls the external PDS's public `getRecord`.
It requires identical owner/collection/AT URI/CID and generated artist/track
content. Once the confirmed URI is known, cleanup runs even if that comparison
fails. It then requires owner deletion success, application lookup 404, and a
PDS `RecordNotFound`/`NotFound` response. A failed observation retains only the
safe AT URI and cleanup state for manual recovery; do not assume cleanup after
a timeout or failed command. Inspect and delete the recorded URI with the
dedicated account before retrying.

Independently fetch the signed repository containing the record before deletion
and verify the commit, the exact current-head witness and current DID signing
key (or authenticated historical key evidence), CID and MST membership with a
maintained verifier. Save sanitized verifier/version/
command/result evidence. The helper compares public `getRecord` with the
application's verified projection; it does not itself implement repository
cryptography. No successful create acknowledgement substitutes for this check.

## Refresh and logout observations

To check a real refresh, keep the session active beyond the authorization
server's observed access-token expiry. Record the original UTC expiry from a
privately inspected response, excluding every credential. Set
`ATMUSIC_OAUTH_ACCESS_EXPIRES_AT` to that timezone-qualified timestamp. At least
30 seconds after expiry, repeat the record phase and independently review the
AS/PDS exchange: a refresh grant occurred, the refresh credential rotated, the
old refresh credential was rejected, and the newly authorized write succeeded.
Never publish request/response credential values or proofs.

For `--phase refresh`, supply `ATMUSIC_OAUTH_REFRESH_EVIDENCE` as the path to an
owner-only JSON file containing exactly this sanitized review result:

```json
{
  "refreshGrantConfirmed": true,
  "refreshCredentialRotated": true,
  "oldRefreshRejected": true,
  "evidenceReference": "reviewed-refresh-wire.json"
}
```

The reference is a filename for a separately reviewed redacted artifact. This
is operator-supplied evidence, clearly labeled in the helper output artifact;
the helper cannot inspect encrypted application credentials or prove rotation
from a successful write alone. `--phase refresh` checks elapsed expiry, retains
this reviewed result, and performs another disposable record lifecycle.

Finally run `python3 scripts/live/oauth_check.py --phase logout`. It requires
204, cleared secure cookie attributes, and 401 when the same old cookie is used
again. Independently record whether upstream revocation succeeded or is
unsupported/unavailable. Local logout must still invalidate the session during
an upstream outage. Reauthenticate only when another dedicated run is required.
Remove private authorization URL/cookie files and browser cookies after cleanup.

## Recording acceptance

Review helper `oauth-*.json` observations and separate sanitized callback,
refresh, revocation, and signed repository artifacts. Each accepted live case
must identify source commit, artifact SHA-256, exact command, timezone-qualified
date, expected DID/AT URI/CID, API results, server versions, independently
verified record evidence, observed monotonic lag, and cleanup outcome. Link
these evidence artifacts from [live-evidence.json](live-evidence.json), with
`fixtureOnly:false`, only after the required run actually passes and the source
is merged. The helper never edits the inventory or closes issues.

`live_credentials_missing` is the executed regression for absent prerequisites:
blocked exit 2, missing names listed, no HTTP request, no successful live result.
No accepted live run is recorded here.
