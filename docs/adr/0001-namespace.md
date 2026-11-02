# ADR 0001: Schema version 1 and an explicit publication namespace gate

> **Current evidence — 2026-10-28:** ADR 0004 selected
> `dev.pythonplayer123.music` and `https://music.214510.xyz`; ADR 0005 retains
> them. Public DNS now supplies reviewable namespace-authority evidence. The
> four expected Lexicon schema records are still absent from the authority
> DID's public PDS. **Schema publication remains a prerequisite; record absence
> is not a DNS ownership failure.** This observation does not enable publication,
> change configuration, or establish live application acceptance.

Status: accepted fixture/schema-v1 policy; production prefix selected and DNS
proof observed; production schema publication and release/live gates outstanding.

## Dated namespace authority and schema-publication evidence

Observed by the documenting assistant on **2026-10-28**, with public GET probes
beginning **12:25:45 UTC**, from a dirty checkout based on
`29453f8e8763083a3e3d7b10d5090285ef2f9d63`. This corrects the earlier
"ownership evidence absent" finding; it does not rewrite historical test receipts.

| Evidence | Observation and limit |
| --- | --- |
| Selected authority / prefix | `music.pythonplayer123.dev` / `dev.pythonplayer123.music`; the application's separate HTTPS origin is `https://music.214510.xyz`. |
| Public DNS-over-HTTPS | GET `https://dns.google/resolve?name=_lexicon.music.pythonplayer123.dev&type=TXT`, accepting `application/dns-json`, returned HTTP 200, DNS Status 0. The TXT payload was `did=did:plc:gsichz64a5qpjvmjktkltkw2`, identifying authority DID `did:plc:gsichz64a5qpjvmjktkltkw2`. This is a dated recursive-resolver observation, not a promise of permanent control or a DNSSEC attestation. |
| Configuration consistency | A restricted, non-shell-sourcing inspection confirmed that `LEXICON_PREFIX` matches the selected prefix, `NAMESPACE_OWNERSHIP_REF` references that DNS name, and `ATMUSIC_SIGNIN_DIDS` includes the resolved authority DID. Only comparisons were emitted; raw configuration values were not printed. The local env comment itself says schema records still need publishing. |
| Public DID document | GET `https://plc.directory/did:plc:gsichz64a5qpjvmjktkltkw2` returned HTTP 200; its `AtprotoPersonalDataServer` service endpoint was `https://enoki.us-east.host.bsky.network`. |
| Public schema lookups | At that endpoint, GET `/xrpc/com.atproto.repo.getRecord` with `repo=did:plc:gsichz64a5qpjvmjktkltkw2`, `collection=com.atproto.lexicon.schema`, and each full schema NSID as `rkey` returned HTTP 400 / `RecordNotFound` for `dev.pythonplayer123.music.scrobble`, `.follow`, `.settings`, and `.love` (all four rkeys use the full prefix). This establishes absence at those queried locations/times, not absence everywhere or failure of domain authority. |

**Prerequisite, not an action performed:** the owner must publish/review the
four approved production Lexicon schemas in the authority repository, with each
full NSID as its `com.atproto.lexicon.schema` rkey, then verify their IDs/content
and public retrieval. Fixture IDs must not be published. No external PDS write,
DNS change, credential decryption, deployment, or GitHub mutation was performed.

### Runtime publication gate

The Node/Workers compatibility configuration now requires both
`NAMESPACE_OWNERSHIP_REF` and `NAMESPACE_PUBLICATION_REF` before it advertises the
`publication` capability or enables app writes. `NAMESPACE_PUBLICATION_REF` is
intended to be `sha256:<64 lowercase hex digits>` for an owner-reviewed manifest
that records the approved schema IDs/content digests and their public retrieval
proof. It is deliberately unset while the four records remain absent. The
runtime validates the reference's shape only; it does **not** fetch the manifest,
verify the digest against an artifact, or independently attest owner review. A
set value is therefore an explicit operator assertion and must not be supplied
until the documented review is complete. DNS ownership alone cannot open the
gate.
The encrypted credentials file was only checked for existence/mode, not read or
decrypted. Namespace proof does not prove a usable OAuth grant, deployed service,
schema contents, or release provenance. The public application readiness GET
returned **HTTP 502** on the same date; no application release/database/listener
was found at the inspected local default paths. See the
[M1–M6 issue matrix](../verification/m1-m6-issue-matrix.md) for the full method,
deployment correction, and remaining blockers, and the scoped
[implementation record](../verification/implementation-agent-13.md) for local tests.

## Original fixture / Rust schema-v1 contract (historical scope)

The following preserves the original Rust gate and two-collection contract.
Current Node v1.2 adds settings/love and API fields under
[ADR 0005](0005-local-node-host-and-compat-apis.md); the published GitHub
contracts still need explicit reconciliation. Do not treat the historical local
API field inventory below as the complete current Node API.

The fixture namespace is `com.example.atmusic`. The schema version is 1, with
exactly `<prefix>.scrobble` and `<prefix>.follow` as the application collections.
Configure the prefix through `ATMUSIC_LEXICON_PREFIX`. Namespace syntax validation
does not establish ownership; an AT Protocol handle does not establish control of
the namespace's reverse-domain authority.

At the original Rust decision, no production domain, owner confirmation, or
ownership evidence had been supplied, so public record publication was disabled.
The dated evidence above supersedes that historical absence claim, not the
fail-closed behavior of an unasserted namespace. `Namespace::new` only validates
syntax and keeps publication disabled, including for non-fixture prefixes.
`Namespace::require_publication` returns `namespace_not_production` before a
remote publication can be queued or sent. The fixture prefix is always rejected.

The original Rust gate requires a controlled domain and a reviewable public
ownership reference, recorded here and wired as reviewed evidence to
`Namespace::with_ownership`. This constructor checks that the namespace sits under
the evidenced reverse-domain authority. The constructor is an explicit assertion
by the owner, not automatic DNS verification. The default server configuration
does not fabricate or infer this assertion. Test-only ownership assertions do not
satisfy the production release prerequisite.

Current namespace evidence (not production-publication acceptance):

| Required evidence | Current value |
| --- | --- |
| Owner-controlled authority | Public TXT delegation at `_lexicon.music.pythonplayer123.dev` observed as above |
| Production prefix | `dev.pythonplayer123.music` (selected by ADR 0004, retained by ADR 0005) |
| Reviewable reference / consistency | Public DoH lookup and DID/PDS lookups above; configured DNS proof reference and sign-in allowlist agree |
| Verification date and reviewer | 2026-10-28, documenting assistant; owner review/publication still required |
| Production schema publication | All four expected schema rkeys returned `RecordNotFound`; prerequisite outstanding; `NAMESPACE_PUBLICATION_REF` must remain unset |

The committed Lexicon IDs are fixture IDs. Production deployment must substitute
the approved prefix consistently for both schema IDs and `$type`; no fixture
record may be published to a real PDS. The Lexicon version marker is `lexicon: 1`;
application schema-v1 records do not add a `schemaVersion` record field. Additional
fields or changed semantics require a reviewed protocol/schema amendment.

The local scrobble API accepts only artist, track, listenedAt, and the optional
album, durationSeconds and recordingMbid. The server derives createdAt and `$type`.
Remote record validation separately requires those record fields and the matching
configured collection. Local input checks raw schema bounds, then trims display
strings before publication.
Remote validation retains authoritative display spelling, checks trimmed nonempty
values, and enforces the raw schema bounds. Both enforce 1–256 Unicode scalar
values and at most 1,024 UTF-8 bytes. Lexicon `maxLength` supplies the byte bound; Unicode scalar count is a
runtime invariant because Lexicon grapheme counts are a different quantity.
Provided empty optional albums are invalid; omitted optional fields stay omitted.
Remote Lexicon objects ignore unknown extension fields, as the
[Lexicon validation rules](https://atproto.com/specs/lexicon#validation) require:
“Unexpected fields in data which otherwise conforms to the Lexicon should be
ignored.” Known fields retain all schema-v1 checks; ignored extensions never
create implicit v2 behavior or supply record ownership. Local API input stays
closed and rejects every unknown field with its field name.

Timestamps use the AT datetime intersection of RFC3339, ISO8601 and WHATWG:
uppercase `T` and `Z`, seconds 00–59, and explicit UTC (`Z` or `+00:00`). `-00:00`
denotes an unknown offset and is rejected. Each timestamp must be at least the
Unix epoch and no later than event receipt time plus 300 seconds, inclusive.
Ingestion must persist and pass event receipt time when replaying records.
Duration 1–86,400 is valid; no playback-duration threshold is added. Recording
MBIDs are syntactically validated UUIDs, remain unverified metadata, and are not
grouping keys. Validation does not deduplicate repeated plays.

A follow is a custom music follow with subject DID and createdAt. Shared
`follow_rkey` returns `f` plus lowercase SHA-256 of the exact subject DID bytes.
Follow DID syntax checks do not replace identity resolution or signature and
repository verification.

Protocol references: [NSID syntax](https://atproto.com/specs/nsid),
[Lexicon schemas](https://atproto.com/specs/lexicon), and
[DID identifiers](https://atproto.com/specs/did). The frozen application contract
is [MVP.md](../planning/MVP.md), with exact tests in
[TESTING.md](../planning/TESTING.md) and [API.md](../planning/API.md).

Deterministic verification target:
`cargo test --locked -p atmusic-core --test contracts -- --nocapture`.
The named namespace, scrobble and follow cases exercise this contract. They do not
claim live domain ownership, PDS publication, or external interoperability.
