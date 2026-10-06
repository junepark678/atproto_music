# SQLite backup and restore

Run backups as the service account, into an existing protected directory. The command uses SQLite `VACUUM INTO`, which reads a transaction-consistent snapshot including committed WAL content while the service continues writing. It never copies a live main file separately from its WAL. Restrict the source and backup directories; the database includes private sessions and encrypted OAuth material.

```sh
./atmusic backup --database-path /var/lib/atmusic/music.sqlite --output /secure-backups/music-2026-10-05.sqlite
```

The output must not already exist. The command validates SQLite integrity, foreign keys, schema version, embedded migration checksums and actual table/index definitions before publishing the output atomically. On Unix the backup file is mode 600. Keep the encryption key in a separate protected backup; it is never added to the snapshot or a JSON account export.

Restore while the target instance is offline, into a **new** directory whose parent exists:

```sh
./atmusic restore --backup-path /secure-backups/music-2026-10-05.sqlite --destination /var/lib/atmusic-recovered
./atmusic migrate --database-path /var/lib/atmusic-recovered/music.sqlite
```

The restore command rejects corruption, unsupported newer schemas and mismatched migration history before creating the destination. It checks the restored snapshot again and creates a mode 700 directory containing mode 600 `music.sqlite`. An existing destination is rejected, including an existing symlink. It does not modify the running instance, reset schemas or contact a PDS. Old supported schemas can then be migrated by the chosen executable. Point the supervisor at the restored file and supply the original encryption key before starting.

History, follows, persisted operations/outbox, indexing state, relay checkpoints and encrypted authentication rows are retained. Pending operations can be retried on restart; do not run the old and recovered instance concurrently against upstream accounts. A missing key prevents configured service startup. A wrong key makes OAuth decryption fail explicitly; it does not repair or replace stored token ciphertext. Preserve the original key until recovery is verified.

Before an upgrade, preserve the previous executable, take a new snapshot, stop the service, and run the candidate's `migrate` command. Continue only on exit zero. On failure keep the original database untouched for diagnosis and recover the snapshot into another directory with the previous executable and original key. Follow the [deployment procedure](deployment.md).

The `backup_during_write`, `restore_state`, `wrong_key` and corruption/newer-schema integration tests exercise local recovery. They do not establish live upstream idempotency or close the external acceptance gate.
