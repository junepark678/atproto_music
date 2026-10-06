# ADR 0003: Bounded relay frames and a fail-closed repository verification gate

Status: deterministic repository verification and authenticated current-head trust
implemented; historical key validity, relay activation and live evidence remain
separate requirements.

We use `atrium-repo = 0.1.8` for CAR access and MST membership and
`atrium-crypto = 0.1.3` for P-256/secp256k1 signature verification. Repository
format version 3 is required. The repo package is pinned to upstream source
revision `1762e5bcf00fb2a038fa4a94777acdd9cb6d4b70`; its signed-commit schema cites
AT Protocol revision `c34426fc55e8b9f28d9b1d64eab081985d1b47b5`.
`serde_ipld_dagcbor = 0.6.4`, `ipld-core = 0.4.2`, `ciborium = 0.2.2`,
`unsigned-varint = 0.8.0`, and `sha2 = 0.10.9` are exact direct dependencies.
Application code does not implement ECDSA or disable signature verification.

The pinned subscribeRepos Lexicon is
[38320191e559f8b928c6e951a9b4a6207240bfc1](https://github.com/bluesky-social/atproto/blob/38320191e559f8b928c6e951a9b4a6207240bfc1/lexicons/com/atproto/sync/subscribeRepos.json).
The wire framing follows the [event stream specification](https://atproto.com/specs/event-stream):
two CBOR objects in one binary WebSocket message, header then payload.
Frame and CAR defensive ceilings are 8 MiB, with no more than 10,000 decoded
operations and a CBOR recursion bound of 64. Only configured scrobble/follow
collections become indexing candidates. Candidates do not become public records
until the repository gate succeeds.

Identity and account events dispatch separately. Sync events and legacy
`tooBig=true` or rebase commits request backfill. Current
[sync prose](https://atproto.com/specs/sync) deprecates the tooBig flag and specifies
tighter producer bounds (200 operations and one million bytes of blocks). Our
consumer ceilings preserve the frozen MVP defensive limits; treating legacy
incomplete events as backfill is conservative compatibility behavior. Invalid
framing produces an error requiring the transport caller to reconnect; it never
advances a durable checkpoint.

The maintained library is an access library, not an all-in-one trust boundary.
Two concrete gaps were established by reading the pinned release:

- `CarStore::open` allocates advertised header/block lengths before checking
  remaining input, and skips hash validation for unsupported multihashes.
- `Repository::open` explicitly does not verify signatures; it trusts the caller.

The application wrapper addresses these gaps before invoking either entry point.
It bounds lengths against remaining bytes, rejects truncated sections, requires
CIDv1/DAG-CBOR/SHA-256 with a 32-byte digest, checks every block digest, bounds
CBOR recursion, and uses the strict DAG-CBOR decoder. The CAR's first root must
equal the event commit CID. Commit DID/revision/version must match expected
identity and relay evidence. MST node prefixes and local ordering are checked
before the library proves each exact operation path and record CID. MST nodes are
identified only by signed commit.data and child links; similarly named record
extension fields are not tree structure. Traversal is iterative, rejects repeated
nodes and graph depth above 256, and its visited-node budget is bounded by the
number of CID-checked blocks in the 8 MiB slice. Missing unrelated slices remain
allowed; a missing block on a required operation path requires verified backfill
rather than an assumed membership result.

Commit signatures use the library's default strict low-S verifier. The key comes
from `SigningKeyResolver::resolve_for_commit(did, revision, commit_cid)`, never
from the relay frame or CAR. Its typed `SigningKeyProof` distinguishes
`Historical(TrustedSigningKey)` from `CurrentHead(TrustedHeadSigningKey)`.
Historical keys still require an explicit validity interval covering the commit
revision. The new method defaults to the existing `resolve_for_revision` method,
preserving fixture and other historical-resolver behavior. Every verification
re-resolves its proof, including after key rotation. A current-head proof must
match the exact DID, revision and commit CID in the already CID-checked CAR.

`sync::current_head::CurrentHeadResolver` supplies production current-head
evidence using the existing bounded `SafeClient`. The
[repository specification](https://atproto.com/specs/repository) states: “The most
recent commit should always be verifiable using the current DID document.” It
also requires a new repository commit when the signing key rotates. The
`com.atproto.sync.getLatestCommit` Lexicon returns the current commit CID and
revision for its requested DID. It requires no OAuth token; HTTPS authenticates
the freshly discovered PDS endpoint, while the repository signature remains the
account's content-authentication proof.

For each exact-root request the resolver freshly fetches the expected DID
document, extracts its PDS and repository key, requests `getLatestCommit?did=...`
from that PDS, and fetches the DID document again. The canonical key and PDS must
remain equal across the two lookups. The requested revision and commit CID must
equal the witness. Metadata requires exact HTTP 200 JSON, no redirects, public
destination addresses, pinned DNS connections, the existing body limit and a
ten-second deadline per request. Every CAR, signature and MST check still follows
this lookup; an HTTPS response cannot override an invalid signature.

Key extraction follows the [AT DID parsing rules](https://atproto.com/specs/did):
the first valid `#atproto` method controlled by the expected DID is selected, and
later keys are ignored rather than tried as signature fallbacks. Canonical
compressed `Multikey` representations support both P-256 and secp256k1. The
documented legacy fragment-only 2019 suites are also supported, using their raw
uncompressed SEC1 multibase representation. Maintained `atrium-crypto` routines
parse and validate keys. A length preflight guards a short-input slice in its
pinned multikey parser; malformed keys fail closed rather than panic.
Encoded keys are capped at 128 bytes before multibase decoding, avoiding
metadata-sized base58 work inside an async task. Witness strings must use the
prescribed [Data Model](https://atproto.com/specs/data-model) base32 CID encoding;
the supported 59-character CID form is bounded before parsing and then compared
as a binary CID. This preserves the supported codec/hash policy without accepting
another root representation as a separate identity.

Authenticated head revision changes return `HeadChanged`; a key/PDS change during
the lookup returns `IdentityChanged`; transient DNS, transport, timeout, HTTP 429
or 5xx failures return `HeadUnavailable`. These require fresh bounded retries.
A stable identity with the same revision but a different root returns
`HeadCidMismatch`; malformed witnesses return `InvalidHeadWitness`; missing or
invalid key/identity/destination trust remains `UntrustedIdentity`. These and
invalid signatures remain verification failures with no projected rows or
checkpoint advancement. PDS outbox reconciliation maps the three retryable
conditions to sanitized `current_head_changed` or `current_head_unavailable`
codes, first reconciles signed remote state before another send, and retains the
durable ten-attempt cap. Backfill diagnostics use `repository_changed` and
`repository_head_unavailable` for those races.

This evidence authenticates only the observed current signed tree, which can
contain historical records. It creates no historical key interval and cannot
verify an arbitrary older relay commit. `resolve_for_revision` on this resolver
therefore always returns `UntrustedIdentity`. Current-head evidence also does not
independently prove PDS freshness, relay coverage or catch-up. A PDS can withhold
state; it cannot bypass the required current-key signature. Production relay
activation remains disabled because rejecting an older event must not advance
its checkpoint, and the existing reconnect/recovery path needs an explicit safe
progress policy before a current-head-only relay can run. Fixture resolvers with
controlled historical ranges remain test-only. External live gates stay open.

Executed current-head target: `cargo test --locked -p atmusic-atproto --test current_head`
(11 cases). They use actual port-zero HTTP listeners, genuinely
signed CARs and SQLite projection/checkpoint assertions. Cases cover exact head
binding, old records in a current signed tree, key rotation/new commits, first
valid key order, stale/mismatched revision/CID and malformed witnesses, identity
races, missing/invalid trust, private DNS rejection before a PDS request, invalid
or absent signatures, transient upstream errors, and both modern/legacy curves.
The `current_head_outbox` target separately covers five actual writer-boundary
cases with this production resolver and durable retry/reconciliation behavior.
Passing controlled fixtures supplies no external-PDS or relay live evidence.

Verified application-schema failures produce an explicit `Exclude` mutation
with a field reason; they never create a public listen. An invalid update must
remove an older public projection for that URI. A caller must apply verified
mutations and its checkpoint in one storage transaction. `sync::apply::apply_commit`
does that through the storage repository, only after the gate succeeds. Duplicate
sequences do not reapply records or re-emit exclusion metrics. It leaves indexing
readiness unchanged; receiving one commit does not establish relay catch-up.
Every applied verified commit advances its owner revision atomically, including
follow-only commits, excluded records and commits with no music operations.
The recovery worker described below uses this gate; neither module establishes live
relay coverage from a successful fixture or a single received commit.
Unknown remote Lexicon extensions are ignored in accordance with Lexicon
validation rules. Original artist/track/album display text is preserved, while
separate Unicode grouping keys normalize it. Unknown owner fields never override
the DID bound to the verified signed commit. Local API requests remain closed.

`untrusted_snapshot_metadata` is only CID/CBOR evidence. Its name and type keep
that distinction explicit. `verify_snapshot_record` additionally proves a record
CID (or absence for deletion) against the signed repository and expected owner,
using the same revision-key prerequisite. Ambiguous-write reconciliation must
compare canonical payloads only after this proof succeeds.

Generated fixtures use the real maintained repository builder, canonical
DAG-CBOR, SHA-256 CIDs, and secp256k1 signatures. Fixed private scalars exist only
under `tests/support/signed_repo.rs`. Tests isolate invalid signature, changed
block bytes, owner mismatch, and wrong MST path, plus rotation and schema
exclusion. Passing fixtures do not supply actual namespace ownership, relay
coverage, historical production identity trust, or external-PDS compatibility.

Exact deterministic targets:
`cargo test --locked -p atmusic-atproto --test relay_frames -- --nocapture` and
`cargo test --locked -p atmusic-atproto --test repo_verification -- --nocapture`.

## Durable relay recovery and complete snapshots

`verify_snapshot` enumerates the complete signed MST using the maintained library,
checks global entry order and configured record paths, and passes the resulting
music candidates through the same signature/CID/schema gate. Missing subtrees
fail closed. It accepts at most 8 MiB and 10,000 music records. This separate
`VerifiedSnapshot` type does not present a synthetic relay sequence as a real
checkpoint. The production snapshot source freshly resolves the DID document and
fetches `com.atproto.sync.getRepo` from its PDS through the bounded HTTPS client.
It does not authenticate a snapshot with `listRecords`.

Migration 0003 persists per-DID backfill state, completion, generation, PDS and
failure reason, plus relay connection/gap state. A single SQLite transaction
applies snapshot rows, reconciles missing records with revision tombstones, and
marks completion. Newer live revisions win regardless of receipt order. An older
snapshot may recover unaffected historical rows but cannot resurrect a newer
deletion or declare itself complete. Its durable job remains pending for a fresh
snapshot. Reactivation stays hidden until a complete fresh snapshot commits;
generation checks prevent an in-flight snapshot from undoing a newer account
deactivation. Ordinary recovery rescheduling preserves pending reactivation intent;
only explicit account deactivation clears it. Local suppression prevents admission
and restoration.

`BackfillCoordinator` allows four concurrent jobs and 1,024 durable queued DIDs.
Excess admission returns `backfill_busy` before changing recovery state. Running
jobs remain durable on cancellation/restart. Relay sessions supply the persisted
sequence to `subscribeRepos`, decode bounded binary messages and apply verified
commits atomically. Reconnect uses an injected clock and jitter with one-second
base, exponential growth and a hard 60-second cap. `FutureCursor` and
`OutdatedCursor` preserve the checkpoint, mark an unresolved gap, and schedule
known repositories. Cursor rejection and invalidation of prior snapshot coverage
are atomic; stale pre-error successes cannot authorize a reset after a crash or
queue backpressure. Invalidated prior successes remain unadmitted until capacity
frees, preserving the 1,024 queued-job bound. Fresh completed coverage is retained
when admission resumes. Reconnect is blocked until complete verified snapshots cover
every known DID; only then may an atomic transition record the prior sequence and
start without the invalid cursor. This explicit recovery transition keeps the
gap flag set. A new stream alone cannot prove catch-up or erase missing-history
evidence.

Identity/account relay hints re-resolve the current DID document and query the
verified PDS for current account status. They do not trust a supplied handle,
PDS, signing key or active flag. Snapshot verification re-resolves the trusted key
for its revision after identity changes. Meta/profile indexing readers force
`recovering` and `caughtUp=false` during disconnection, pending gaps or incomplete
backfill. Last sequence/time, lag and pending jobs are available in the internal
status result; the fixed public `Indexing` DTO retains its declared four fields.

`sync::websocket::WebSocketTransport::production()` implements the production
`RelayTransport` boundary using exactly pinned `tokio-tungstenite = 0.30.0` and
Rustls with WebPKI trust roots and hostname verification. Only WSS destinations
without URL credentials or fragments are accepted. The adapter converts the URL
to HTTPS only for `SafeClient::destination` authorization, rejects the complete
DNS answer set if any address is non-public, and connects to those pinned socket
addresses without a second resolution or an HTTP proxy. The original WSS
hostname, subscription path and cursor remain authoritative for TLS and the
WebSocket handshake. Redirects are rejected rather than followed.

Both individual frames and assembled messages are capped at 8 MiB before
receiving their payloads. DNS, TCP, TLS and the upgrade share a ten-second connect
deadline. Each receive loop has a ten-second deadline and permits at most 32
control messages before a binary payload; further controls and text messages
fail the connection. Ping responses and peer close acknowledgments are flushed
within that deadline. Failed receives attempt a close for at most one additional
second and then release the socket. Cancellation drops the worker's owned TCP/TLS
connection; the adapter spawns no background reader, reconnect or socket task.

The `relay_websocket` target ran on 2026-10-05 with 11 passed, zero failed and zero
ignored tests, using an actual maintained WSS server over Rustls. Fixture-only
DNS/dialer injection directs authorized public addresses to an owned port-zero
listener while keeping certificate and hostname validation enabled. A genuine
signed CAR travels as a binary relay frame through decoding and repository
verification. Negative cases cover mixed public/private DNS answers, certificate
trust and hostname mismatches, redirects, plaintext/credential URLs, frame and
fragmented-message limits, excess controls, text, deadlines and cancellation.
The exact commands were:

```sh
cargo test --locked -p atmusic-atproto --test relay_websocket
cargo clippy --locked -p atmusic-atproto --lib --test relay_websocket -- -D warnings
```

The adapter is available. Authenticated current-head trust can support production
outbox and snapshot workers, but main must keep live relay indexing disabled
until its safe replay/progress policy is implemented. Authenticated stream
coverage/catch-up evidence and executed external relay/PDS live acceptance remain
outstanding. Deterministic transport and backend tests do not close live gates.

| Leaf | Named case | Executed target and evidence |
| --- | --- | --- |
| M4.2.1 | `resume` | server `relay_recovery`: signed seq42 persisted, reconnect cursor42, replay has one row |
| M4.2.1 | `expired_cursor` | server `relay_recovery`: both pinned errors preserve checkpoint until verified recovery and audit prior sequence |
| M4.2.1 | `bounded_reconnect` | server `relay_recovery`: injected clock observes 1,2,4,8,16,32,60,60,60 seconds |
| M4.2.2 | `historical_seed` | atproto `backfill_recovery`: genuine old r01/r02 appear and durable completion is true |
| M4.2.2 | `snapshot_live_race` | atproto `backfill_recovery`: newer signed update/delete defeat old snapshot, fresh snapshot converges |
| M4.2.2 | `backfill_limits` | atproto `backfill_recovery`: four real signed jobs held, exactly 1,024 queued, next admission rejected |
| M4.2.3 | `pds_migration` | atproto `backfill_recovery`: controlled DID document A→B fetches verified B and preserves DID URIs/CIDs |
| M4.2.3 | `deactivate_reactivate` | atproto `backfill_recovery`: PDS inactivity hides history/feed; reactivation waits for signed snapshot; local suppression survives |
| M4.2.3 | `status_truth` | server `relay_recovery`: unresolved gap/paused job overrides a stored current flag, exposes lag and sequence |

Commands executed:
`cargo test --locked -p atmusic-atproto --test backfill_recovery -- --nocapture`
(11 tests) and
`cargo test --locked -p atmusic-server --test relay_recovery -- --nocapture`
(9 tests). Additional regressions cover incomplete snapshot proof, transaction
failure before completion, newer deactivation during reactivation, and
unavailable trust leaving projections/checkpoints unchanged. These are generated
signed CAR integration fixtures through real SQLite and controlled transports.
