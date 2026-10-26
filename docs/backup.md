# Backup and recovery

The database holds two kinds of state ([ADR 0005](adr/0005-local-node-host-and-compat-apis.md) §6.4, §14.5; `TABLE_CLASS` in `worker/src/do/schema.ts` classifies every table):

- **derived**: the index (scrobbles, follows, loves, record states, users), its ingestion queues, Jetstream cursor, caches and timers. Every row is a copy of a signed record in some public repository and can be rebuilt from the network through the verified ingestion path.
- **non-derived**: local state that exists nowhere else: accounts, web sessions, OAuth states and sessions, the outbox (operations, listen keys, PDS budget), Last.fm and ListenBrainz credentials (stored as hashes or sealed), linked accounts, the forward queue, imports, ignored listens, backup history, counters and the schema ledger.

Because a backup holds security state, a restore never simply puts an old file back: it keeps the live non-derived state and takes only the rebuildable index from the backup. This supersedes ADR 0004 A15 ("derived data, no file backup") and the Durable Object PITR it relied on.

Secrets are **never** in a backup: credentials inside are ciphertext under keys that live only in the secrets credential ([operations.md](operations.md#secrets)). Keep the plaintext secrets document in a password manager; a backup without its keys restores the index and the hashes, but every OAuth session and linked credential becomes unreadable (`reauth_required`, relink).

## Backups

The server backs itself up, in-process (`worker/src/node/backup.ts`):

- **Daily at 03:30 UTC**, and **on demand** with `atmusic-admin backup` ([operations.md](operations.md#admin-cli)).
- **Before a migration**, at startup, when the release's schema is newer than the database's: same procedure, before `READY=1`, while systemd's start timeout is extended. If there is not enough free space the server exits 78 naming `ATMUSIC_MIN_FREE_BYTES` rather than migrating without a backup.

One backup run:

0. **Free space:** refused (a failed `backup_runs` row with error `low_disk`, shown by `atmusic-admin status`) unless the backup filesystem has the database size plus `ATMUSIC_MIN_FREE_BYTES` free, so a backup can never fill the disk under the live database.
1. node:sqlite's incremental online `backup()` copies the live database into `backups/atmusic-YYYYMMDDTHHMMZ.db.tmp` (mode 0600), 100 pages per step, yielding to the event loop, so requests, Jetstream and the watchdog continue. The copy is the database as of one commit.
2. `PRAGMA integrity_check` runs on the copy in a worker thread, never on the live file.
3. Rename, fsync the file and the directory, record a `backup_runs` row.
4. **Retention:** the newest backup of each of the last 7 days and of each of the 4 weeks before, counting daily and manual runs only. Pre-migration (`*.pre-migration.db`) and pre-restore copies are kept until you delete them.

Backups live in `~/.local/state/atmusic/backups/` (`ATMUSIC_BACKUP_DIR`). **Offsite copies** are your choice and not built in: `rclone copy` of that directory to an R2 free-tier bucket or another remote, or an external disk; copy only complete `atmusic-*.db` files, never `*.tmp`. Litestream is possible but opt-in only (a second resident process; keep `sync-interval` at 1 minute or more to stay inside R2's free operations).

### The revocation journal

Every revocation or deletion of a credential (logout, logout-all, app password, Last.fm session, ListenBrainz token, issued app, unlink, OAuth session, account disconnect) is also appended to `~/.local/state/atmusic/revocations.log` before the deleting transaction commits: one JSON line per event, hashes and ids only, never a secret, mode 0600, fsync after each append. It lives **outside** the database, so backups do not contain it, and a restore over a lost database replays it. When a backup completes, the journal is truncated to the entries newer than the oldest backup still in the backup directory, so every backup that can be restored has its journal. Back it up with the backups when you copy them offsite.

## Restore is disaster recovery only

Restore is for a lost or corrupt database. **It is never the way to undo an upgrade**: rollback is a link switch to the previous release ([deploy/local-node.md](deploy/local-node.md#upgrades-and-rollback)). Restoring an older file wholesale would bring back credentials and sessions revoked since then, revert `oauth_sessions` to refresh tokens the authorization server has already rotated (refreshes fail with `invalid_grant`), and lose scrobbles, listen keys and forward rows already acknowledged with 200.

```sh
cd ~/.local/lib/atmusic/current
npx tsx scripts/admin/restore.ts ~/.local/state/atmusic/backups/atmusic-20260115T0330Z.db
# options: --accept-loss, --secrets FILE, --db PATH, --state-dir DIR, --listen HOST:PORT, --no-ready-check
```

What it does, in order (`scripts/admin/restore.ts`):

1. **Pre-flight**, while the service still runs: the backup must pass `integrity_check` and `foreign_key_check` and hold a schema this release can migrate; `revocations.log` must parse; the secrets must load (`--secrets FILE`, else `systemd-creds --user decrypt` of `~/.config/atmusic/secrets.cred`, else `~/.config/atmusic/secrets.json`); `atmusic.db.pre-restore` must not exist yet (the previous restore's copy is never overwritten; move it away first).
2. **Stop** `systemctl --user stop atmusic.socket atmusic.service` and require `systemctl --user is-active` to report both stopped. The socket unit is stopped too, because an inbound connection would otherwise start the service while the database is moved aside.
3. **Examine and copy the live database without writing it.** It is opened read-only; the open read transaction is the second barrier (if anything holds the server's single-writer lock, the restore aborts with nothing changed). It is **readable** when its schema and `schema_migrations` read and every non-derived table of `TABLE_CLASS` passes `PRAGMA integrity_check(<table>)` and a full read. Damage confined to derived tables (the index, which comes from the backup anyway) is printed and does not make it unreadable. It is then copied to `atmusic.db.pre-restore`: a consistent `backup()` copy when it is readable, the original files byte for byte (`atmusic.db.pre-restore` and, when present, `atmusic.db.pre-restore-wal` and `-journal`) when it is not. Only after that is it reopened read-write with `locking_mode=EXCLUSIVE`, the server's own single-writer lock, held until the swap. (A read-write open first would checkpoint the WAL into the main file on close, so a refusal would change the files and the raw copy would no longer be the original pair.) A refusal leaves the live main file and WAL byte-identical.
4. **Build `atmusic.db.restore.tmp`** from a copy of the backup, migrated to this release's schema (migrations are additive). A table missing from `TABLE_CLASS` aborts here, before anything is renamed.
   - **Live database readable:** every non-derived table is replaced wholesale by the live rows; only the derived tables keep the backup's rows. Every sign-in, rename, credential, revocation, operation, listen key, forward row and import stays exactly as it is live; the backup contributes only the index, and its Jetstream cursor and timers stay consistent with that index. Index rows written after the backup come back through Jetstream replay or gap recovery. (The schema ledger, `schema_migrations` and `schema_compat`, describes the file itself: from a live database at an older schema version the migrated copy keeps its own.)
   - **Live database unreadable or missing:** restore prints what cannot be carried over (every non-derived change after the backup's time: sign-ins and renames, all web sessions, credentials created since, queued writes, forward rows, import progress) and **refuses unless `--accept-loss`** is given. With it, every `web_sessions` row is deleted (everyone signs in to the web UI again) and `revocations.log` is **replayed**: each journaled revocation deletes its row from the restored copy, so a credential, link or OAuth session revoked after the backup stays revoked.
   - **Key check:** every OAuth session, linked-account credential and issued Last.fm app secret is opened with the configured encryption keys and the result is printed as counts and key ids, never ciphertext or key material. An OAuth session that does not open (its key id is not configured) makes its account `reauth_required` and blocks its queued operations until the user signs in again; the stored ciphertext is left unchanged, so restoring the missing key later still opens it. A linked credential that does not open is held by the forwarder at first use and its user relinks.
   - The copy must pass `integrity_check` and `foreign_key_check`; a per-table summary (rows, and whether they came from `live` or `backup`) is printed.
5. **Swap**, crash-safe at every step: open the copy with `journal_mode=DELETE` and close it, requiring that no `restore.tmp-wal`, `-shm` or `-journal` is left; fsync it; close the live database, delete `atmusic.db-wal`, `-shm` and `-journal` and fsync the directory; rename the copy over `atmusic.db` and fsync the directory again. A crash between any two steps leaves either the old file without a WAL (recoverable from `atmusic.db.pre-restore`) or the complete restored file, never a restored file paired with a stale WAL. The server switches back to `journal_mode=WAL` at its next start.
6. **Start** `systemctl --user start atmusic.socket atmusic.service` and poll `/health/ready` on the listen address until it answers 200 `ready`.

A refusal or failure after step 2 leaves both units stopped and prints the command to start them. Exit status: 0 restored and ready, 1 refused or failed, 2 usage or configuration error (nothing stopped).

After a restore, `atmusic.db.pre-restore` holds the database as it was (with `atmusic.db.pre-restore-wal` beside it when an unreadable database had a WAL: keep the two together, and open them as a pair before moving the copy anywhere); delete it (or move it into the backup directory as `atmusic-<YYYYMMDDTHHMMZ>.pre-restore.db`, where `atmusic-admin status` lists it) once the restored service has run for a while.

## Rebuilding the index from the network

The derived half can always be rebuilt through the production verifier, which trusts nothing not signed by the repository's current DID key at its current head. A database whose index is in doubt keeps its non-derived tables and re-derives the rest:

- With no Jetstream cursor the server is in a gap: it resumes from the live tail, runs relay `listReposByCollection` discovery for the indexed collections, and admits each discovered DID with a complete range snapshot. Signed-in users are re-admitted when they next write.
- One DID at a time: `atmusic-admin resnapshot <did>` (202 `scheduled`/`already`; 404 for an unknown or opted-out DID; `queue_full` when the snapshot queue is full).
- Opt-outs survive: a disconnect is the public, repo-signed `<prefix>.settings/self {indexing: "disabled"}` record ([account-controls.md](account-controls.md)), honoured even for a DID the index has never seen.
- Coverage is discovery-bounded and admission is rate-limited (50 new DIDs per hour, 1,024 pending snapshot jobs), so a large rebuild fills in over hours while global indexing reports `recovering`.

## Tests

`worker/test/node/backup.test.ts` covers the online backup, the integrity check, retention and the journal truncation; `scripts/test/restore.test.ts` covers the restore against a fake systemd and the real server: stopping both units first, refusing an unreadable live database without `--accept-loss`, the merge of live non-derived rows over the backup's index, the journal replay, the key check with the right and a missing key, an unclassified table, and a SIGKILL after each swap step (plan cases M6.3.1/restore_state and M6.3.1/wrong_key).
