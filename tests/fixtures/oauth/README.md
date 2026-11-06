# Controlled OAuth/PDS fixture

The executable fixture is `crates/atproto/tests/support/oauth_pds.rs`, shared by
AT Protocol and HTTP security tests. Each instance binds a new loopback port,
generates an independent P-256 issuer key, uses its own account/token/record
state, and stops only its own server task when dropped. Fixtures never contact
reserved test accounts on the public network.

A test-only `WireTransport` maps a logical HTTPS fixture origin and the controlled
DID-directory URL to that instance's owned local listener. The production
`SafeClient` still validates logical destinations, refuses private DNS answers,
and applies deadlines/body bounds. Metadata stays capped at 1 MiB. The dedicated
repository GET accepts up to 8 MiB, matching the signed repository verifier. The production transport contains no TLS,
private-network, signature, or issuer bypass option.

Wire routes cover DID documents, protected-resource/authorization-server
metadata, PAR, authorize, token, refresh, revocation, and create/get/delete record.
The authorize route returns a callback tuple for test automation; this fixture
is not external browser/OAuth interoperability evidence. Record CIDs are computed
from their actual DAG-CBOR bytes. Repository signature/membership acceptance is
covered separately by signed-repository tests; a successful fixture write is not
claimed as a verified public listen.

Every DPoP request verifies an actual ES256 signature, public JWK, method, target,
time bound, unique `jti`, and relevant token binding. PAR requires S256. Code
redemption checks the original verifier, client ID, callback, and DPoP key. PDS
writes require the corresponding collection scope and owner. Tokens signed by
one fixture are rejected by another even with a correctly signed new DPoP proof.

Fault controls are local test state, never operator configuration:

| Control | Observable wire behavior | Executed regression |
| --- | --- | --- |
| nonce Once | first token response 400 `use_dpop_nonce`, retry succeeds with fresh proof | `nonce_retry` |
| nonce Endless | every token attempt 400 challenge; client stops after two | `nonce_retry` |
| nonce Missing | no `DPoP-Nonce`; client rejects | `mandatory_nonce_and_refresh_rotation` |
| wrong issuer | metadata issuer differs from protected-resource issuer | `fault_controls` |
| wrong subject | token subject differs from initiated DID | `issuer_subject`, HTTP `security_matrix` |
| corrupt proof | test transport corrupts actual token-request signature | HTTP `security_matrix` |
| PAR failure | HTTP 400 `invalid_request`; local state removed | `par_failure` |
| stalled PAR | request stalls past production ten-second deadline; state removed | `par_timeout_cleanup` |
| rotating refresh | old refresh credential consumed, new credential persisted once | `mandatory_nonce_and_refresh_rotation`, HTTP `refresh_persistence` |
| invalid grant | token response 400 `invalid_grant`; tokens and sessions invalidated | `mandatory_nonce_and_refresh_rotation` |
| incompatible proof | wrong JWT algorithm, malformed/private JWK, or truncated signature rejected before mutation; healthy ES256 proof still accepted | `es256_backend_policy` |

Commands:

```sh
cargo test --locked -p atmusic-atproto --test identity_discovery -- --nocapture
cargo test --locked -p atmusic-atproto --test oauth_flow -- --nocapture
cargo test --locked -p atmusic-server --test oauth_metadata -- --nocapture
cargo test --locked -p atmusic-server --test oauth_security -- --nocapture
```

On 2026-10-06 these targets executed 14, 12, 3, and 5 tests respectively, all
passing. Results are working-tree evidence until committed/merged; they do not
close the external-PDS live gate.
