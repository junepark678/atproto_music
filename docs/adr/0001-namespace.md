# ADR 0001: Schema version 1 and an explicit publication namespace gate

Status: accepted for fixtures; production namespace ownership remains blocked.

The fixture namespace is `com.example.atmusic`. The schema version is 1, with
exactly `<prefix>.scrobble` and `<prefix>.follow` as the application collections.
Configure the prefix through `ATMUSIC_LEXICON_PREFIX`. Namespace syntax validation
does not establish ownership; an AT Protocol handle does not establish control of
the namespace's reverse-domain authority.

No production domain, owner confirmation, or ownership evidence has been supplied.
Therefore public record publication is disabled. `Namespace::new` only validates
syntax and keeps publication disabled, including for non-fixture prefixes.
`Namespace::require_publication` returns `namespace_not_production` before a
remote publication can be queued or sent. The fixture prefix is always rejected.

An eventual owner must supply a controlled domain and a reviewable public
ownership reference, record that evidence here, and wire the reviewed evidence to
`Namespace::with_ownership`. This constructor checks that the namespace sits under
the evidenced reverse-domain authority. The constructor is an explicit assertion
by the owner, not automatic DNS verification. The default server configuration
does not fabricate or infer this assertion. Test-only ownership assertions do not
satisfy the production release prerequisite.

Record these fields before enabling production publication:

| Required evidence | Current value |
| --- | --- |
| Owner-controlled domain | Not supplied |
| Production prefix | Not selected |
| Owner confirmation and reviewable reference | Not supplied |
| Verification date and reviewer | Not supplied |

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
