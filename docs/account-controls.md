# Public records, export and local disconnect

Confirmed scrobbles, history, statistics, profiles and music follows are public. The account's external PDS holds its authoritative records. Other services may retain copies. This AppView covers known actors and its configured upstream scope; it does not promise universal discovery or complete historical coverage. Production relay delivery is currently disabled, and global indexing reports recovering with `caughtUp=false`.

`GET /api/v1/account/export` requires the owner's session. It exports indexed public scrobbles and music follows, schemaVersion 1, export time and indexing metadata from one SQLite snapshot. It is an attachment with `Cache-Control: no-store`. It excludes tokens, signing material, OAuth state, sessions, operations and other owners' records. It is a local indexed export, not a complete PDS archive; its indexing metadata describes the available freshness.

`DELETE /api/v1/account/local-data` requires the owner's session, configured Origin and CSRF token. Its transaction removes the local user, indexed owned records, tokens, sessions, operations, outbox, idempotency entries and backfill work. A minimal DID suppression marker remains to prevent automatic reingestion. Other owners' incoming follow records retain their ownership and remain hidden while their subject is suppressed. The service-wide backfill counter contains no account identifiers.

Local disconnect makes no PDS deletion request and does not erase public records or copies held by other services. A write already sent upstream may still complete there. Explicit scrobble deletion is a separate owner operation whose completion requires signed absence; local hiding alone does not prove upstream erasure. See [deletion semantics](deletion.md).

Fresh OAuth authorization explicitly clears suppression, installs newly encrypted credentials and admits a new backfill generation atomically. Public visibility waits for a complete verified snapshot. Stale refresh or account-status completions cannot replace fresh credentials or reuse a deleted job's generation.

The owner/authentication, secret-exclusion, export-snapshot, incoming-follow ownership, suppression, reconnect and stale-status regression cases passed locally. These checks establish application behavior; they do not establish global erasure or external interoperability.
