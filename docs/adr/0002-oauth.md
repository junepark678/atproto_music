# AT OAuth profile and maintained cryptographic dependencies

Decision: implement the AT profile over the shared bounded `SafeClient`, using
`oauth2 = 5.0.0` for PKCE S256, `jwt-compact = 0.8.0` with its `std,p256,k256`
features for ES256 JWT signing/verification, `p256 = 0.13.2` for P-256 key
generation/PKCS#8, and operating-system randomness through `rand = 0.8.6`.
No signing algorithm or JWT verification algorithm is implemented here.

Authoritative profile reviewed 2026-10-06:

- <https://atproto.com/specs/oauth>
- <https://atproto.com/specs/permission>
- <https://atproto.com/specs/did>
- <https://atproto.com/specs/handle>

The OAuth text extracted from the retrieved official page has SHA-256
`28cc231a650f4d3ec1073ebe8d81fffd9c052ad2ce0ea577cbdaaf8e739c43ee`.
The permissions text has SHA-256
`3419b7dfcc6a1f5b55b095ddd6010a664f8fb63b10141bda47b43688a575d39d`.
These evolving pages have no dated revision number; retrieval date and content
digest identify the reviewed text.

## Demonstrated compatibility amendment to M2.2.1

Two maintained AT OAuth dependencies were inspected from exact crates.io source:

- `atrium-oauth = 0.1.7`: `OAuthClient::callback` in `src/oauth_client.rs` uses
  `todo!()` on token-exchange failure. Its public `DpopClient` in
  `src/http_client/dpop.rs` accepts responses without the mandatory server nonce,
  and generates `jti` using `SmallRng`. The full flow consumes state through
  separate `get` and `del` calls. These APIs cannot satisfy specified negative
  callback, secure randomness, nonce, and atomic consumption requirements as-is.
- `atproto-oauth = 0.14.5`: `workflow::{oauth_init,oauth_complete,oauth_refresh}`
  takes a concrete `&reqwest::Client` and creates its own request middleware.
  Its workflow cannot use the shared injected transport that enforces pinned DNS
  answers, per-request body bounds, and deterministic fixture isolation.

This amendment selects maintained OAuth/crypto primitives with AT-specific
orchestration. It does not weaken requirements or substitute fixture success for
external-PDS interoperability.

## Dependency security amendment

The actual cargo-audit 0.22.2 scan identified `RUSTSEC-2026-0119` in
`hickory-proto = 0.24.4`, `RUSTSEC-2023-0071` in `rsa = 0.9.10`, and
`RUSTSEC-2026-0097` in `rand = 0.8.5`. Hickory now uses
`hickory-resolver = 0.26.3` (patched protocol versions are at least 0.26.1).
Its supported `TokioResolver::builder_tokio()?.build()?` API retains system DNS
configuration; the existing IP, timeout, redirect and connection-pinning policy
is unchanged. Rand 0.8.6 is the compatible patched 0.8 release.

RSA has no patched release. It entered the dependency graph through
jsonwebtoken 10.1.0's aggregate `rust_crypto` feature even though this application
uses only ES256. Inspection of both jsonwebtoken 10.1.0 and 11.1.0 confirmed that
their built-in RustCrypto provider enables RSA alongside ES256; selecting that
provider cannot omit the vulnerable crate. Enabling individual dependency
features does not provide a supported built-in selective provider. A custom
provider would add security-sensitive application adapters, while the native
AWS-LC provider would add a C toolchain dependency.

The maintained jwt-compact stable release exposes independently feature-gated
`alg::Es256`, backed by the same p256 0.13 primitives already in use.
`AlgorithmExt::token` handles JWT encoding and ES256 signing; its typed validator
handles algorithm whitelisting, signature length and signature verification.
Its `JsonWebKey` conversions enforce P-256 curve, coordinate length and valid
curve points. Production proof generation and the real HTTP fixture verification
use those APIs directly. Fixture claim checks retain issuer, expiry, nonce,
method/URL, JTI, access-token hash and key binding. The `std,p256,k256` features
are enabled, with defaults and optional RSA disabled. This removes the vulnerable RSA
dependency without a custom JWT parser, hand-written signer, advisory ignore,
native backend or verification bypass.

An actual build found a stable-release feature compatibility defect:
`jwt-compact 0.8.0/src/jwk.rs` gates shared JWK helper methods behind asymmetric
features including `k256`, but omits `p256`; enabling only `std,p256` produces
five missing-method errors in its ES256 implementation. The maintained
0.9.0-beta.1 source includes the corrected p256 gate. This implementation keeps
the stable release and enables its supported pure Rust `k256` compatibility
feature to make those shared helpers available. K256 already exists through
the repository crypto dependency. Every production signer and test validator
still explicitly selects `Es256`, so other algorithms remain rejected.

The scan also identified `RUSTSEC-2026-0253` in lru 0.16.4 through
atrium-common 0.1.4's WASM-only dependency. Its target-scope disposition belongs
to the release dependency audit; it is not a JWT/DNS remediation claim.

## Client metadata and scope

The client is a public web client with `token_endpoint_auth_method = none`.
AT OAuth permits public web clients; a confidential-client signing-key lifecycle
is not claimed. Client ID and callback derive exclusively from configured public
HTTPS origin. Request Host headers do not select URLs. Client IDs with explicit
non-default ports are rejected. PAR, PKCE S256, server nonces, ES256 DPoP, issuer
responses, and metadata-document support are required.

Scopes are `atproto`, `repo:<prefix>.scrobble`, and `repo:<prefix>.follow`.
Collection-specific `repo` scope allows create, update, and delete for that
collection. No wildcard, identity-management, account, or `transition:generic`
permission is requested. Without a configured namespace, only identity
authentication is requested. Collection scopes do not establish namespace
ownership; the independent publication gate applies before every PDS write.

## Security and interoperability limits

Production HTTP retains certificate/hostname verification, checks every DNS
answer, pins those addresses, and disables proxies that resolve hosts
independently. Deployment needs direct secure egress or a separately audited
injected transport preserving these invariants. Development proxy limitations
do not authorize DNS/TLS bypass. Live commands retain the environment proxy.

Metadata requires exact 200 JSON without redirects. Identity GETs permit at most
three redirects, revalidating and repinning each destination. Requests have a
ten-second deadline and 1-MiB metadata response limit. A dedicated repository
GET retains these transport protections with an 8-MiB CAR limit shared with the
repository verifier. OAuth/PDS writes never redirect.
State is encrypted, hashed, atomically consumed, and invalid at age 300 seconds.
Nonce challenges permit one fresh-proof retry; a second challenge fails. Token
subjects are bound to the initial DID and their DID/PDS/issuer chain is fetched
again before credentials are persisted.

Deterministic results are separate from live M2.4.3 acceptance. Public HTTPS and
dedicated external accounts remain required for that gate.

## Amended by ADR 0004

[ADR 0004](0004-cloudflare-workers.md) §9.2 (accepted 2026-10-24) amends this
decision for the Cloudflare Workers deployment. The sections above remain the
record of the Rust candidate, which is now a frozen golden-vector oracle
(ADR 0004 §12); their dependency choices are not used on Workers (A4).

**A3: browser public client.** The server-side public client becomes a browser
public client, `@atproto/oauth-client-browser` (pinned in ADR 0004 §4.5), under
owner decision Q1.

- The library performs handle and DID resolution, authorization-server
  discovery, PAR, PKCE S256, DPoP with server nonces and the issuer check. The
  DPoP key is a non-extractable WebCrypto key.
- Sessions live in the browser's IndexedDB, and refresh is serialised across
  tabs with Web Locks. The server holds no tokens, DPoP keys, OAuth state,
  sessions, CSRF secrets or encryption key.
- Sessions follow library and spec limits (at most 14 days for public clients)
  instead of the 7-day application cookie. The SPA shows the expiry and
  re-prompts. Sign-out calls `session.signOut()`, which revokes upstream, and
  clears IndexedDB.
- The callback moves to `/oauth/callback`, an SPA route served through the
  Static Assets fallback; it is not intercepted by the Worker.
- `client-metadata.json` stays at the same path,
  `https://<host>/oauth/client-metadata.json`, as a build-time static asset
  generated by `scripts/gen-config.ts`. It sets `application_type: "web"`,
  `token_endpoint_auth_method: "none"`, `dpop_bound_access_tokens: true` and
  `redirect_uris: ["https://<host>/oauth/callback"]`. Client ID and callback
  still derive only from the configured public HTTPS origin, never from a Host
  header, and the client ID must never change.
- Scopes add the settings collection used for disconnect (A10):
  `atproto repo:<prefix>.scrobble repo:<prefix>.follow repo:<prefix>.settings`.
  No wildcard, identity-management, account or `transition:generic` permission
  is requested; `transition:generic` is possible only behind an explicit
  build-time flag that is off by default (ADR 0004 Q5). Collection scopes still
  do not establish namespace ownership, and the publication gate still applies:
  the SPA hides the write UI unless it was built with an owned prefix.
- Local development uses the loopback `client_id`
  `http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Foauth%2Fcallback&scope=…`.

**A5: SSRF policy.** Workers `fetch` resolves DNS itself, so the pinned-address
client above cannot be built. Outbound requests (identity, PDS sync, relay
discovery, DoH) go through `SafeFetch` (ADR 0004 §8):

- https only, on the default port;
- hostnames only: IP literals (IPv4, IPv6, mapped and decimal forms) and
  `localhost`, `.local`, `.internal`, `.arpa`, `.test` (outside the fixture
  transport) and single-label names are rejected;
- a DoH A/AAAA pre-check against `cloudflare-dns.com` that rejects any private,
  loopback, link-local, CGNAT, ULA, multicast or reserved answer, cached per host
  for min(TTL, 300 s);
- `redirect: "manual"`, and every 3xx is an error;
- a 10 s deadline, and streamed body caps: DID document 64 KiB, JSON 1 MiB,
  `getRecord` 1 MiB, `getBlocks` 8 MiB, `getRepo` fallback 32 MiB;
- no credentials on any outbound request.

The residual risk is a DNS-rebinding race between the pre-check and the
connection. Its impact is low because the Worker has no private network and
holds no user credentials. A live probe (W6-05) records how Workers `fetch`
treats RFC 1918 and loopback targets.

**Unchanged.** PAR, PKCE S256, server nonces, ES256 DPoP, issuer verification
and metadata-document support are still required; they are now enforced by the
browser library. No production flag may skip TLS, signature, CID, MST, DNS or IP
policy, or the issuer check. Deterministic tests remain separate from the live
OAuth gate, which still needs public HTTPS and dedicated accounts on two
independent PDSs (W6-05).
