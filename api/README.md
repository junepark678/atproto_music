The OpenAPI 3.1 contract in `openapi.yaml` encodes the frozen routes and payloads in
[`docs/planning/API.md`](../docs/planning/API.md). The file uses JSON syntax, which
is a valid YAML 1.2 subset; ordinary OpenAPI tooling can read it. It specifies
future MVP behavior rather than claiming every route is implemented today.

Run `python3 scripts/validate_contracts.py` from the repository. The checker uses
the exact dependency versions in `api/requirements-contracts.txt`. Install those
once with `python3 -m pip install -r api/requirements-contracts.txt` if needed.
The actual check performs no network access and fails if dependencies are absent
or differ from the lock. It validates the OpenAPI document, every JSON Schema,
the exact route/status/authentication matrices, query defaults and bounds, all
response fixtures, and accepted/rejected request and response boundary fixtures.
Empty 204 and redirect 303 cases verify their headers and absence of a body.

The official structural OpenAPI schema is vendored from
<https://spec.openapis.org/oas/3.1/schema/2022-10-07>, with SHA-256
`da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0`.
Application schemas use JSON Schema Draft 2020-12. The checker additionally
enforces `music-text`, `at-did`, `at-record-uri`, `at-record-cid`, and
`at-utc-datetime` formats and the `x-maxFutureSeconds` and
`x-jsonIntegerRepresentation` keywords. A duration uses a JSON integer
representation, matching the Rust and AT record integer boundary; `1.0` and
booleans are rejected. Music text has a raw `maxLength` of 256 Unicode scalars
and a raw UTF-8 bound of 1,024 bytes, matching the interoperable record bounds.
It must also remain nonempty after trimming Unicode whitespace. Local records
store trimmed text; validated remote records retain original display text.
The clock is frozen to `2026-01-15T12:00:00Z` for request boundary examples;
production validation uses the request/event receipt time.

Datetime validation follows the [AT Lexicon datetime
requirements](https://atproto.com/specs/lexicon#datetime): uppercase `T` and `Z`,
explicit UTC, arbitrary fractional precision, and valid calendar/time fields.
The required intersection with WHATWG time syntax excludes leap seconds.
The DID check enforces generic syntax and does not establish method-specific
identity validity or ownership. Unicode whitespace matches Rust `str::trim`
(`White_Space`), including Unicode spaces, rather than treating unrelated
control characters as whitespace.

The session cookie is `atmusic_session`; session mutations require
`X-CSRF-Token` and the configured allowed `Origin`. Authentication start requires
Origin and creates OAuth state. Callback uses single-use OAuth state and issuer
validation. The `scope=following` feed requires a session; `scope=global` is
public. Operation lookup returns 401 for anonymous callers, 403 for a known
operation belonging to another authenticated DID, and 404 for an absent one.

Fixtures contain reserved domains/identities and `com.example.atmusic`, which
must never be used for production publication. Their CID values are syntactic
schema fixtures, not signature-verified repository evidence. OAuth metadata is
illustrative protocol metadata with explicitly extensible standard fields;
M2.2.1 must still pin and test the actual OAuth profile, libraries and supported
collection scope syntax. No fixture validation substitutes for a live gate.

Pagination describes stable traversal using an upper ordering anchor and the
last tuple. Records are filtered by current state: deletion removes records,
and updates can move a record across a traversal boundary. Cursors do not
provide historical snapshot isolation. Optional record fields are omitted;
nullable indexing/handle/operation fields are explicitly declared as nullable.

Contract amendment for M3.1.1 and M1.1.4: an owner-scoped scrobble idempotency
replay never creates another operation. A pending original operation returns
the same 202 `Accepted`; a succeeded original operation whose record is still
public returns 201 with that current original `Scrobble`. If the original
operation failed, or its succeeded record has since been deleted or otherwise
ceased to be public, replay returns 409 `Error` with code
`idempotency_result_unavailable`. The original operation retains its real
terminal state and remains available through owner-only operation lookup. This
409 response includes `Location: /api/v1/operations/{originalId}`, allowing a
client to recover the owner-only lookup even if its original response was 201.
The key and canonical digest remain retained until local-data disconnect.
Changed canonical input still returns 409 `idempotency_conflict`.

The storage transaction checks the existing owner/key and canonical digest
before allocating identifiers or constructing a new operation. A successful
replay or a conflicting digest therefore performs no record/operation factory
allocation and never enqueues another write.

This explicit clarification resolves a gap in the earlier phrase “currently
valid original operation/result”: neither a failed operation nor a deleted
record fits the frozen pending-only `Accepted` or confirmed `Scrobble` success
schema. Returning 409 preserves the existing status matrix and error envelope
without fabricating pending state, resurrecting content, or enqueueing a retry.
`examples/error-idempotency-result-unavailable.json` encodes the terminal
outcome. This amendment does not claim the affected GitHub issues are closed.

Deletion clarification: local scrobble absence does not establish remote PDS
absence. Owner DELETE returns 202 until a signed absence proof, or 204 for a
verified absence or a guaranteed create cancellation before any attempt.
Repeating a terminal failed scrobble or aggregate follow deletion returns
502 `deletion_failed` and `Location: /api/v1/operations/{originalId}`. The
conditional header and both alternative response examples are validated.
Follow removal completes as one operation only after all persisted duplicate
targets are absent from one complete verified repository; a newly discovered
matching remote edge prevents a false success. See [`docs/follows.md`](../docs/follows.md)
and [`docs/deletion.md`](../docs/deletion.md) for ordering and proof behavior.
