# Deterministic federation evidence

This is generated fixture evidence for M4.4.1/M4.4.2. It does not establish public
relay coverage, independently operated production PDS interoperability or the
live federation milestone gate.

`crates/server/tests/support/federation.rs` starts two separate port-zero HTTP PDS
listeners and a port-zero application listener. Alice and Carol repositories use
independent secp256k1 signing keys. Fixture clients publish only through
`com.atproto.repo.createRecord`, `putRecord` and `deleteRecord`; the application
middleware counts `/api/v1/scrobbles` POSTs. Real maintained repository mutations,
CARs, signatures, CIDs and revision-bound fixture trust reach the production
verification gate before a SQLite projection is written. The HTTP fixture source
is confined to this test module; it does not relax production HTTPS/DNS policy.

The expected final state is independently fetched from each fixture PDS through
`com.atproto.sync.getRepo` and verified again. Complete active scrobble/follow URI
and CID sets must match the SQLite projection. Known payload fields are compared
with UTC timestamp spelling normalized consistently; original artist/track/album
display strings remain exact. Public counts and statistics must equal the number
of verified active scrobbles. Signing-key rotation uses explicit test revision
ranges, never an invented validity interval from a current production DID doc.

| Leaf | Case | Asserted observable result |
| --- | --- | --- |
| M4.4.1 | `independent_write` | Carol's direct PDS record URI/CID appears in HTTP feed; both PDS writer request counts are one, application POST count is zero |
| M4.4.1 | `independent_mutation` | Direct PDS update changes exact CID/display; delete removes history and count; application POST count stays zero |
| M4.4.1 | `coverage_failure` | Excluding Carol from the controlled relay leaves her verified remote record absent from feed, indexing remains recovering, and live command returns blocked rather than a federation pass |
| M4.4.2 | `convergence` | Duplicate, disconnect, old snapshot/live update/delete, signing-key rotation/identity hint, expired cursor and complete backfill converge exact record/follow sets and totals |
| M4.4.2 | `signature_failure` | Wrong-key signed event never becomes public; relay gap/rejection recovery is explicit, then verified backfill equals valid remote state |
| M4.4.2 | `worker_restart` | Old HTTP AppView/worker/database are closed; reopened database/new worker/new HTTP AppView resume stored cursor, retain pending outbox operation, and converge to verified repositories |

Executed command:

```sh
cargo test --locked -p atmusic-server --test federation_faults -- --nocapture
```

Result: six passed, zero failed. Focused clippy for `federation_faults`,
`relay_recovery` and `backfill_recovery` also passed with `-D warnings`.

The separate `relay_discovery` target covers an actor that has never authorized
the application. Its independent client makes one actual PDS `putRecord` request;
a matching normal, too-big or rebased commit hint queues an inactive owner without
accepting records or a relay checkpoint. Fresh DID/PDS account checks, a signed
full CAR and exact current-head witness must then activate the verified record.
Seven cases check the exact URI/CID/revision and public counts, nonmusic/bare sync
and malformed hint rejection, duplicate coalescing, suppression, known inactive
actors, invalid signatures and disconnect during fetch. No OAuth tokens, sessions,
operations or outbox entries are created by discovery. Storage's seven `discovery`
cases separately prove bounded atomic admission and ordered OAuth races.

```sh
cargo test --locked -p atmusic-server --test relay_discovery
cargo test --locked -p atmusic-storage --test discovery
```

The production WSS adapter is implemented with exactly pinned
`tokio-tungstenite = 0.30.0` and validated Rustls certificates and hostnames. Its
separate deterministic transport target ran on 2026-10-05:

```sh
cargo test --locked -p atmusic-atproto --test relay_websocket
cargo clippy --locked -p atmusic-atproto --lib --test relay_websocket -- -D warnings
```

Result: 11 passed, zero failed, zero ignored; focused Clippy passed. These tests
use a real WSS/TLS fixture and deliver a genuinely signed CAR through the binary
wire decoder and repository verifier. The production adapter requires WSS,
rejects URL credentials and redirects, validates every DNS address through the
shared public-IP policy, and dials only that pinned address set without using an
HTTP proxy. Frame and assembled-message limits are 8 MiB; connect and receive
deadlines are ten seconds, control messages are limited to 32 per receive, and a
failed receive gets at most one additional second to close. Dropping a cancelled
worker releases the owned socket; there are no background reader tasks. Full
transport details and the remaining trust prerequisite are in
[ADR 0003](../adr/0003-repo-verification.md).

`python3 scripts/live/federation_check.py --fixture` runs the six-case federation
target above. `--live` returns exit code 2 and lists missing prerequisite names.
Current-head trust supports production outbox and snapshot workers. Production
federation activation, the safe progress/recovery policy for older relay events,
and the live acceptance runner remain blocked or unimplemented, so the script cannot
produce live success even when environment variables are present. An owned
namespace, dedicated real identities, public HTTPS callback, two independently
operated PDSs and verified configured relay coverage also remain necessary. These
prerequisites must be implemented or supplied and the live runner executed before
recording successful live evidence. Do not put credentials in fixture files or
command output.
