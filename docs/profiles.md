# Public identity and music profiles

`GET /api/v1/resolve?handle=alice.test` explicitly resolves a handle through the
bounded AT Protocol resolver. A successful round trip returns exactly
`{did,handle,verified:true}`. Invalid queries and mismatched aliases return 422
with a sanitized `handle` field; absent identities return 404; unavailable or
unsafe upstream destinations return 502. The endpoint creates no user, OAuth
state, token, operation, or background repository crawl.

Profiles use the DID as their stable key. Only an existing active, unsuppressed
music user can be read. Unknown and inactive profiles return 404 before any
identity HTTP request. A known recordless user returns 200 with zero counts;
unfinished indexing remains `recovering` with `caughtUp:false`. A display handle
is returned only after the DID document and handle lookup agree. Stored aliases
alone do not establish verification, and unavailable or unverified identity data
produces `handle:null` while preserving the known user's music history.

Identity results expire after at most 300 seconds. Profile and resolve HTTP
responses use `Cache-Control: no-store`, so confirmed listens, deletions and
account deactivation are visible on the next read without a 60-second cache
delay. Public profile serialization includes only the documented eight fields;
authentication does not add private fields or change the public payload.

The executable regression targets are:

```sh
cargo test --locked -p atmusic-server --test profile -- --nocapture
cargo test --locked -p atmusic-server --test profile_states -- --nocapture
cargo test --locked -p atmusic-server --test profile_privacy -- --nocapture
cargo test --locked -p atmusic-server --test read_model_acceptance -- --nocapture
cargo test --locked -p atmusic-server --test read_model_restart -- --nocapture
```

The test-only controlled identity fixture serves actual HTTP responses behind
the injected transport. Real signed repository fixtures pass the production
signature/CID/MST verifier before projection mutations. Test clocks cover the
299/300-second identity cache boundary without sleeping or disabling production
network verification. These deterministic tests do not establish the separate
live interoperability completion gates.

The implementation checkpoint executed 4 profile, 3 profile-state, 3 privacy,
3 read-acceptance and 3 host-restart cases successfully. Focused Clippy for these
five targets passed with `-D warnings`. This records working-tree evidence;
merge evidence and the complete workspace check belong to the shared checkpoint.

The read acceptance target compares the hardcoded initial history/feed order,
full record payload arrays, statistics rankings, pagination, profile/resolve,
follow removal/restoration and verified remote mutation consequences. The
restart target runs the packaged host CLI twice against the same temporary
SQLite database, retaining encrypted tokens, sessions, checkpoints and pending
operations. It compares read responses byte for byte and continues a cursor
created before restart; final and pending deletions remain hidden.

On Linux, the restart test compiles a test-only `LD_PRELOAD` clock shim in its
temporary directory. It freezes realtime at the specified fixture instant and
leaves monotonic timers unchanged. It does not add a production clock flag or
alter networking or signature checks. Restart reads cover history, follow
lists, statistics and following feed without asking the production resolver to
contact reserved fixture DIDs. Profile and resolve integration are covered by
the separately injected identity transport. This dynamic host-binary test does
not establish fixed-clock restart evidence for the static musl artifact.
