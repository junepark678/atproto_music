# Operations

atmusic runs as one Node 26 process, the systemd user service `atmusic.service`, on `127.2.0.1:8888` with one SQLite file ([ADR 0005](adr/0005-local-node-host-and-compat-apis.md) §3, §14). Installing and upgrading it is in [deploy/local-node.md](deploy/local-node.md), public exposure in [deploy/exposure.md](deploy/exposure.md), backups and restore in [backup.md](backup.md). This page is the day-to-day runbook: health, the admin CLI, logs, secrets and key rotation, upgrades, Gentoo notes, sleep, and the security residuals of a same-user service.

## Health

| Check | Meaning |
|---|---|
| `GET /health/live` | the process answers (liveness only) |
| `GET /health/ready` | 200 `{status: "ready"}` when the schema is current, the config parsed, the secrets loaded, the OAuth keyset is valid and the database answers a write probe (a rolled-back transaction); 503 otherwise (`too_new` when the database was written by a newer, incompatible release). The body also carries the warnings `low_disk` (free space below `ATMUSIC_MIN_FREE_BYTES`) and `oauth_store_degraded` (an OAuth session update is held in memory because the write failed); they do not change the status, so a tunnel keeps routing live scrobbles. |
| `GET /api/v1/meta` | `stage`, `capabilities`, `lexiconPrefix` and the global `indexing` state (`recovering`, `current`, `stale`) |
| systemd watchdog | `WATCHDOG=1` every `WatchdogSec/3` (20 s) only while an event-loop lag probe (< 5 s) and `SELECT 1` succeed; a hung process is killed (`WatchdogSignal=SIGKILL`) and restarted |

From this host: `curl -sS -H 'Host: 127.2.0.1:8888' http://127.2.0.1:8888/health/ready` (the server answers 421 to a `Host` that is neither the public host nor the listen address). systemd has no HTTP health check and none is needed. An external probe of `https://music.214510.xyz/health/ready` (any free uptime monitor) is optional and not installed.

A Jetstream or PDS outage makes indexing `stale`; it never makes `/health/ready` fail.

## Admin CLI

Admin routes are served **only** on the unix socket `$XDG_RUNTIME_DIR/atmusic/admin.sock` (a 0700 directory holding a 0600 socket; filesystem permissions are the authentication). `/internal/admin/*` on the TCP listener is always a 404, because a tunnel cannot tell admin traffic from public traffic.

```sh
cd ~/.local/lib/atmusic/current
node scripts/admin/atmusic-admin.ts status              # backup age, Jetstream lag, queue depths, ...
node scripts/admin/atmusic-admin.ts backup              # an online backup now
node scripts/admin/atmusic-admin.ts resnapshot <did>    # re-walk one DID from its signed head
node scripts/admin/atmusic-admin.ts prune-kid <kid>     # drop OAuth sessions bound to a retired signing key
```

A shell alias keeps it short: `alias atmusic-admin='node ~/.local/lib/atmusic/current/scripts/admin/atmusic-admin.ts'`. `--socket PATH` or `ATMUSIC_ADMIN_SOCKET` names another socket. The server's JSON answer is printed as is; the exit status is 0 for a 2xx answer, 1 otherwise, 2 for a usage error. `curl --unix-socket "$XDG_RUNTIME_DIR/atmusic/admin.sock" http://admin.socket/admin/status` works too.

`status` combines the index's view (schema, global indexing, ingest checkpoint, hints, jobs, counters) with the host's: the last backup and its age (pre-migration and pre-restore copies listed), the outbox and forward queue depths by state, import jobs, link failures, OAuth sessions per `client_kid` and status (including `reauth_required`), upload-directory bytes, free space on the state filesystem, and the readiness warnings.

## Logs

`journalctl --user -u atmusic` (add `-f` to follow, `-o cat` for the bare JSON). Every application event is one JSON line `{…fields, "level", "event"}`. Request lines carry method, route pattern, status, duration and request id, and **never a query string or body on any route**: Last.fm and the OAuth callback carry credentials in query strings, so no route is exempt. The only request parameter logged is the Last.fm `method` name, from a fixed allowlist. The logger also drops every field whose name looks like a credential and replaces the configured secret values wherever they occur. Error responses carry a `requestId` that also appears in the matching log line.

Events to watch: `run.config_error` (exit 78), `run.database_locked` (exit 75), `run.migrated`, `run.ready`, `backup.*`, `oauth_store_write_failed` / `oauth_store_write_recovered`, `oauth_session_deleted`, `forward.credential_unreadable`, `alarm.failed`, `jetstream_disconnected`, `verify_failed` counters.

The `counters` table (shown by `status`) holds the monotonic operational counts of the index (admissions, exclusions, `verify_failed` by code, snapshot lifecycle, gap recoveries, `timer_failures` and `timer_failure_streak` per timer, ...). A growing `timer_failure_streak` for one timer, a rising `verify_failed`, or `snapshot_failed` without matching `snapshot_completed` are the signals to read the journal.

## Exit codes and restarts

| Exit | Meaning | systemd |
|---|---|---|
| 0 | stopped by SIGTERM after the drain (≤ 25 s; `TimeoutStopSec=30s`) | — |
| 78 | configuration: a missing or invalid variable, a forbidden runtime variable (`NODE_OPTIONS`, a proxy, `SSL_CERT_*`), unreadable secrets, a missing database without `--init`, or a pre-migration backup refused for lack of space (`ATMUSIC_MIN_FREE_BYTES`). The message names the variable. | never restarted (`RestartPreventExitStatus=78 75`) |
| 75 | another process holds the database (`locking_mode=EXCLUSIVE`, the single-writer lock), whatever admin socket it uses | never restarted |
| 1 | anything else | `Restart=on-failure`, 2 s growing to 2 min, at most 10 starts in 10 min |

After fixing a 78 or 75: `systemctl --user reset-failed atmusic && systemctl --user start atmusic`.

## Secrets

The secrets are one JSON document ([`config/secrets.example.json`](../config/secrets.example.json)): `cursorKey`, `encryptionKeys` (the first seals, every entry opens), `oauthSigningKeys` (private ES256 JWKs; new sessions bind to the first), optional `oauthAnnouncedKeys` (public JWKs only) and optional `lastfm` (the owner's Last.fm API key and shared secret; without it Last.fm linking, forwarding and API imports are off and say so). The server reads it only from `$CREDENTIALS_DIRECTORY/secrets`; it never enters the environment, so neither `systemd-notify` children nor D-Bus see it.

```sh
umask 077
node scripts/admin/gen-secrets.ts --out secrets.json        # local randomness only; add "lastfm" by hand
systemd-creds --user encrypt --name=secrets secrets.json ~/.config/atmusic/secrets.cred && shred -u secrets.json
systemctl --user restart atmusic
```

- The `.cred` file is bound to this machine's TPM2 and host key and to your UID: it is useless on another host. **Keep the plaintext document in a password manager.** It is also what `scripts/admin/restore.ts --secrets` and `scripts/install-local.sh` (`ATMUSIC_SECRETS_FILE`) accept.
- **Simpler fallback:** a 0600 plaintext `~/.config/atmusic/secrets.json` and a drop-in (`systemctl --user edit atmusic`) with `LoadCredentialEncrypted=` (empty, which clears it) and `LoadCredential=secrets:%E/atmusic/secrets.json`.
- To change a value: decrypt (`systemd-creds --user decrypt --name=secrets ~/.config/atmusic/secrets.cred secrets.json`), edit, encrypt again, restart.
- **What losing the secrets costs:** the OAuth signing keys or the encryption key — every user signs in again and relinks their Last.fm and ListenBrainz accounts (sealed values cannot be opened; the sessions become `reauth_required`); the cursor key — outstanding pagination cursors are rejected once (`invalid_cursor`) and clients restart their traversal.
- Neither the keys nor the plaintext are ever in the database or in a backup.

## Key rotation

**OAuth signing keys** (ADR §5.4). The authorization servers re-fetch `/oauth/jwks.json` and cache it for 10 minutes, and each session stays bound to the key it was created with.

1. `node scripts/admin/gen-secrets.ts --oauth-key k2` prints `{"oauthSigningKey", "oauthAnnouncedKey"}`.
2. Add the public `oauthAnnouncedKey` to `oauthAnnouncedKeys`, re-encrypt, restart, and wait at least 10 minutes.
3. Put the private key first in `oauthSigningKeys` (`[k2, k1]`), remove it from `oauthAnnouncedKeys`, re-encrypt, restart. New sessions bind to `k2`.
4. Keep `k1` until `atmusic-admin status` shows no session with `client_kid` `k1` (sessions move to the new key when their users sign in again).
5. Remove `k1`, restart, and run `atmusic-admin prune-kid k1` to drop the sessions still bound to it; those users sign in again (`reauth_required`).

On **compromise**, remove the key at once (steps 5 only): every session bound to it ends and those users sign in again.

**Encryption keys.** Add the new key **first** in `encryptionKeys` (`[{"id": "e2", …}, {"id": "e1", …}]`) and restart: new values are sealed with `e2`, and `e1` still opens the older ones. Keep `e1` as long as any row still names it (OAuth sessions are resealed at each refresh, linked credentials when relinked). An admin reseal command is not built yet (ADR §20.3), so removing `e1` makes the remaining `e1` values unreadable: their users sign in again or relink. `scripts/admin/restore.ts` reports, by key id, every sealed value the configured keys cannot open.

**Cursor key.** Replacing it invalidates outstanding cursors once; nothing else.

**Last.fm API key.** Replace the `lastfm` pair and restart; linked Last.fm sessions were issued to the old API key and must be relinked.

## Upgrades and rollback

Build outside the service with `scripts/install-local.sh` (`npm ci --ignore-scripts`, never inside the sandboxed unit), optionally `atmusic-admin backup`, then `systemctl --user restart atmusic` and check `/health/ready`. A pending migration runs at startup after a pre-migration backup. **Rollback is a link switch and a restart, never a restore**: migrations are additive, so the previous release runs on the migrated database. Details: [deploy/local-node.md](deploy/local-node.md#upgrades-and-rollback).

## Restore is disaster recovery

`scripts/admin/restore.ts` is for a lost or corrupt database only, never for rollback: it stops `atmusic.socket` and `atmusic.service`, keeps every non-derived live row, and takes only the rebuildable index from the backup. See [backup.md](backup.md#restore-is-disaster-recovery-only).

## Gentoo notes

- Node uses the system SQLite (`dev-db/sqlite` 3.54.x) through `node:sqlite`. After `emerge -u` of `net-libs/nodejs` or `dev-db/sqlite`, restart the service (`systemctl --user restart atmusic`); a running process keeps the old libraries mapped.
- Pin versions with `/etc/portage/package.mask` (for example `>=net-libs/nodejs-27`) until a release is tested against them. The build pins its own toolchain expectations (`.nvmrc`, `engines.node >=26.12.0`).
- `ExecStart=` uses `/usr/bin/node`; an eselect'ed or slotted Node elsewhere needs a drop-in with its own `ExecStart=`.

## Machine sleep

If the machine sleeps, the tunnel or reverse proxy drops; scrobbler clients queue and retry. On wake Jetstream resumes from its cursor (or gap recovery runs), and the in-process timers compare wall-clock due times, so overdue work runs at once. Keep PowerDevil's automatic suspend on AC power off. Masking `sleep.target`, `suspend.target`, `hibernate.target` and `hybrid-sleep.target` needs root and is optional.

## Same-UID exposure and the dedicated-user option

atmusic runs as your own user. The unit's sandbox (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, a system-call filter, `UMask=0077`) protects the system from the service, **not the service from other processes of the same user**. Any process running as your UID can:

- read `~/.local/state/atmusic/atmusic.db` and its backups (user credentials inside are AES-256-GCM ciphertext; our own issued credentials are stored only as SHA-256);
- ask `systemd-creds` to decrypt `~/.config/atmusic/secrets.cred`, which is bound to the UID, not to the service, and with it open every sealed value in the database;
- connect to the admin socket (filesystem permissions are its only authentication);
- reach `127.2.0.1:8888` and, from a trusted proxy address, forge the configured client-IP header.

`npm ci` dependency install scripts would run as that UID too, which is why the installer always uses `npm ci --ignore-scripts`.

**For stronger isolation, run atmusic under a dedicated user**: create a separate user without a login shell (for example `useradd --create-home --shell /usr/sbin/nologin atmusic`), give it its own checkout, enable linger for it (`loginctl enable-linger atmusic`, which needs root), and install as that user (for example `sudo -u atmusic -H bash`, with `XDG_RUNTIME_DIR=/run/user/$(id -u atmusic)`, then `scripts/install-local.sh --enable`). Its secrets credential, database and admin socket are then out of reach of your desktop session. A tunnel (`cloudflared`) can run under the same dedicated user.
