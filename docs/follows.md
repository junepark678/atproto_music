# Music follows

A music follow is a `<prefix>.follow` record in the follower's own repository, `{subject: <did>, createdAt}`. Bluesky follows play no part. The SPA writes follow records directly to the owner's PDS through its IndexedDB outbox; the server has no follow write routes (`PUT`/`DELETE /api/v1/follows/{did}` are gone, [ADR 0004](adr/0004-cloudflare-workers.md) §5.2 step 6, §9.3) and indexes follows only from verified records, whoever wrote them.

## Follow and unfollow in the browser

- **Follow** creates the record at the deterministic rkey `'f' + hex(sha256(subjectDid))` (`@atmusic/core/record-key`, identical to the Rust oracle). A self-follow is refused before anything is queued. If a record already exists at that rkey (a retry, a crash after the PDS commit, another client) and names the same subject, that is success and the original `createdAt` is kept; a different subject is the terminal failure `remote_record_conflict`, and the existing record is never overwritten.
- **Unfollow** lists the owner's own `<prefix>.follow` records from their PDS with `com.atproto.repo.listRecords` (authoritative for the owner) and deletes every record whose subject matches, each with `swapRecord`, including duplicates other clients wrote at other rkeys. Records with other subjects are kept. No matching record is success with no delete.
- **Ordering.** Alternating follow and unfollow intents for one subject keep separate operation ids and run first-in, first-out after their unsent predecessors, so follow, unfollow, follow ends followed. Each operation is persisted before its first attempt and retried with the outbox's formula (1, 2, 4 … s plus jitter, capped at 300 s, exactly 10 attempts) while a tab is open.
- After each write the SPA sends `POST /api/v1/notify {uri}` and polls `GET /api/v1/records/status` until the edge is indexed (or absent after an unfollow).

## Follow lists and counts

`GET /api/v1/users/{did}/following` and `GET /api/v1/users/{did}/followers` page through **distinct edges**. Duplicate records for one `(actor, subject)` pair collapse into one edge, represented by its smallest visible URI, and lists order by the representative's `(createdAt, uri)` descending. The cursor binds the endpoint and the DID ([cursors.md](cursors.md)).

- An edge is visible only while its actor is an active, unsuppressed user with a complete snapshot and its subject is not hidden (not opted out, not a known inactive user; a subject DID this index has never seen stays visible, as in the Rust oracle). An edge disappears only when no visible record for the pair remains: two Carol→Bob records count once, still once after one is deleted, and zero after both.
- Profile `followerCount` and `followingCount` count the same distinct visible edges, uncapped ([profiles.md](profiles.md)).
- The following feed, `GET /api/v1/feed?scope=following&viewer=<did>`, lists the scrobbles of the subjects of the viewer's visible edges. It is public: follow records are public, so `viewer` names a follow graph rather than authenticating anyone (A8).
- A deactivated, reactivating or opted-out actor's edges vanish from lists, counts and following feeds at once, and return only after a fresh complete verified snapshot. Other users' follows of an opted-out DID stay stored but hidden.

## Tests

`web/test/outbox/follows.test.ts` covers the deterministic rkey, the same-subject and conflict rules, unfollow over duplicates and FIFO ordering; `worker/test/read/follows.test.ts` covers representatives, ordering, distinct counts, duplicate removal and visibility through the shared signed fixture; `packages/core/test/record-key.test.ts` pins the rkey to the Rust goldens. All run with `npm test`.
