# Running atmusic as a local systemd user service

Production is **one Node 26 process**, a systemd user service on this machine listening on `127.2.0.1:8888`, with one SQLite file on local disk ([ADR 0005](../adr/0005-local-node-host-and-compat-apis.md) §0 D1, §3, §14). There is no other service to run: Jetstream, timers, the outbox, imports, forwarding and backups are all in-process. Cost is $0.

| Piece | Where |
|---|---|
| Release (code, `node_modules`, `web/dist`, `worker/dist/node/main.mjs`) | `~/.local/lib/atmusic/releases/<sha>`, with `~/.local/lib/atmusic/current` → `releases/<sha>` |
| Units | `~/.config/systemd/user/atmusic.service`, optional `atmusic.socket` (from [`config/systemd/`](../../config/systemd/)) |
| Non-secret configuration | `~/.config/atmusic/atmusic.env` (from [`config/atmusic.env.example`](../../config/atmusic.env.example)) |
| Secrets | `~/.config/atmusic/secrets.cred`, an encrypted systemd credential ([operations.md](../operations.md#secrets)) |
| State: database, backups, upload staging, revocation journal | `~/.local/state/atmusic/{atmusic.db, backups/, imports/, revocations.log}` (`StateDirectory=`) |
| Admin socket | `$XDG_RUNTIME_DIR/atmusic/admin.sock` (`RuntimeDirectory=`) |
| Logs | `journalctl --user -u atmusic` (JSON lines) |

Deployment values: the public origin `https://music.214510.xyz` (so the OAuth `client_id` is `https://music.214510.xyz/oauth/client-metadata.json`, which must never change once anyone has signed in) and the lexicon prefix `dev.pythonplayer123.music` are configuration, set in the unit and `atmusic.env`. `com.example.atmusic` is the test fixture prefix and is never deployed.

## Prerequisites

- Gentoo with systemd 261, `net-libs/nodejs` 26.12.x (`/usr/bin/node`; node:sqlite links against the system `dev-db/sqlite` 3.54.x), git and npm.
- `loginctl enable-linger` for your user, so the user manager (and atmusic) starts at boot without a login. It is allowed for yourself without authentication on this host (polkit `set-self-linger`).
- A way for public traffic to reach the port: [exposure.md](exposure.md) (Cloudflare Tunnel recommended).

## First install

1. **Configuration.** `install -d -m 0700 ~/.config/atmusic`, copy `config/atmusic.env.example` to `~/.config/atmusic/atmusic.env`, and set at least `ATMUSIC_CLIENT_IP_HEADER` (per [exposure.md](exposure.md)), `ATMUSIC_SIGNIN_DIDS` (your DID: sign-in is an allowlist by default), `LEXICON_PREFIX`, `JETSTREAM_URLS` and `RELAY_URL`. `ATMUSIC_PUBLIC_ORIGIN` and `ATMUSIC_LISTEN` come from the unit.
2. **Secrets.** Generate and encrypt them ([operations.md](../operations.md#secrets)):

   ```sh
   umask 077
   node scripts/admin/gen-secrets.ts --out secrets.json     # then add "lastfm": {"apiKey", "sharedSecret"} by hand
   systemd-creds --user encrypt --name=secrets secrets.json ~/.config/atmusic/secrets.cred
   ```

   Keep `secrets.json` (in a password manager) until the first install has run; the installer can use it directly through `ATMUSIC_SECRETS_FILE`, or decrypts `secrets.cred` itself. Then `shred -u secrets.json`.
3. **Install** from a checkout of the commit to deploy:

   ```sh
   scripts/install-local.sh                 # or: scripts/install-local.sh --rev <sha>
   ```

   It builds `~/.local/lib/atmusic/releases/<sha>` from a git worktree of that commit with `npm ci --ignore-scripts` (no dependency install script ever runs), `npm run build:web` and `npx tsx scripts/build-server.ts`, checks that `main.mjs --version` prints the sha, installs both units into `~/.config/systemd/user`, creates the database once with `main.mjs --init` (only when it does not exist yet; the server refuses to start on a missing database otherwise, ADR §3.2), and switches `current` to the release atomically by creating a private, uniquely named temporary directory under the release prefix, placing a relative `releases/<sha>` symlink inside it, and renaming that symlink onto `current` with `mv -Tf`; no reusable fixed temporary path is used. `--init` readiness is bounded by `ATMUSIC_INIT_TIMEOUT_SECONDS` (default 300, range 1–900 seconds); shutdown sends SIGTERM and escalates to SIGKILL after `ATMUSIC_INIT_STOP_GRACE_SECONDS` (default 5, range 1–60 seconds) before reaping and cleanup. To avoid silently changing values, the init path accepts only simple unquoted `KEY=value` words from the unit's `Environment=` line and a constrained `atmusic.env` format (`KEY=value` or a simply matching quoted value; no escape processing). Quoted whitespace is preserved; unsupported unit quoting/globs, unquoted whitespace, unmatched quotes, and escapes fail closed. Values are transferred as NUL-delimited bytes into an otherwise empty child environment; they are not re-expanded by the shell. Before installing units it snapshots any existing unit files in a private temporary directory. A command-level failure before the `current` switch attempts to restore those files and remove this invocation's temporary-link directory; if restoration fails, the backup directory is retained and its path is reported. After the switch, activation failures are not rolled back. This trap-based behavior is not crash/power-loss atomic, and operator recovery from retained unit copies is not rehearsed; it is not a candidate-bound or production rollback proof.
4. **Activate.** The installer prints these and runs them only with `--enable`:

   ```sh
   loginctl enable-linger
   systemctl --user daemon-reload
   systemctl --user enable --now atmusic
   ```

   Optionally `systemctl --user enable --now atmusic.socket` as well: it keeps `127.2.0.1:8888` open across restarts, so a tunnel sees queued connections instead of 502s.
5. **Check.** `curl -sS -H 'Host: 127.2.0.1:8888' http://127.2.0.1:8888/health/ready` answers `{"status":"ready"}`; `journalctl --user -u atmusic -n 50` shows `run.ready`; `atmusic-admin status` ([operations.md](../operations.md#admin-cli)) answers over the admin socket.

Startup exits 78 (configuration, never restarted) naming the variable that is wrong, missing or forbidden, and 75 when another process holds the database. Only 78 is in `RestartPreventExitStatus=`; 75 is retried with backoff (bounded by the start limit) so a replacement starts once a stuck predecessor exits. See [operations.md](../operations.md#exit-codes-and-restarts).

## Upgrades and rollback

This is a generic local-host runbook, not deployment authorization. The current [M6 deployment safety plan](../verification/milestones/m6-deployment-plan.md) is **NO-GO**; do not apply these commands to production unless every plan gate is satisfied and the owner/operator explicitly approves the exact target and impact.

```sh
cd <checkout> && git fetch && git checkout <new sha>
atmusic-admin backup                    # optional: the server also takes a pre-migration backup itself
scripts/install-local.sh                # builds releases/<new sha>, switches current
systemctl --user restart atmusic
curl -sS -H 'Host: 127.2.0.1:8888' http://127.2.0.1:8888/health/ready
```

`npm ci` never runs inside the sandboxed unit. A migration, if any, runs at the next start, after a pre-migration backup, while systemd extends the start timeout (`TimeoutStartSec=15min` plus `EXTEND_TIMEOUT_USEC`).

**Conditional rollback (never a routine restore):** a link switch and restart are appropriate only when the exact prior release is retained and independently verified, compatibility of the specific migrated database/schema with that release has been demonstrated, the operator approves, and the restart is followed by the approved health checks. General additive-migration policy does not prove that every previous release can run against every later schema. Only after those checks, create a private temporary directory under `~/.local/lib/atmusic` (for example, `rollback_dir=$(mktemp -d "$HOME/.local/lib/atmusic/.rollback.XXXXXXXX")`), place a relative symlink `releases/<old sha>` at `$rollback_dir/current`, then run `mv -Tf "$rollback_dir/current" "$HOME/.local/lib/atmusic/current"` and remove the now-empty `$rollback_dir`. Follow with `systemctl --user restart atmusic` and health verification. Do not reuse a fixed `current.tmp` pathname. If release identity, schema compatibility, target ownership, or recovery is uncertain, stop and use an owner-approved recovery decision; restoring a backup as routine code rollback could bring back revoked credentials, reuse rotated refresh tokens, or lose acknowledged scrobbles ([backup.md](../backup.md#restore-is-disaster-recovery-only)).

Old releases can be removed with `git -C <checkout> worktree remove ~/.local/lib/atmusic/releases/<sha>` once you no longer want to roll back to them.

## The unit

[`config/systemd/atmusic.service`](../../config/systemd/atmusic.service) is exactly ADR 0005 §14.1 (`scripts/test/systemd-unit.test.ts` checks it byte for byte). Points worth knowing:

- `Type=notify`, `NotifyAccess=all`, `WatchdogSec=60s`: the server sends `READY=1` after it listens, and `WATCHDOG=1` every 20 s only while an event-loop lag probe and `SELECT 1` succeed.
- `UnsetEnvironment=` removes `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_PATH`, the proxy variables in both cases and `SSL_CERT_FILE`/`SSL_CERT_DIR` that the user manager would otherwise pass on; the server exits 78 if one still reaches it. `atmusic.env` cannot set them either.
- Secrets arrive only as the credential `secrets` (`LoadCredentialEncrypted=`), never in the environment.
- Never add `MemoryDenyWriteExecute` (V8's JIT aborts) or `PrivateNetwork` (outbound traffic is required); `IPAddressDeny`/`IPAddressAllow` are not enforced in user units. If `SystemCallFilter=~@resources` ever causes EPERM under load, drop only that line.
- Overrides go into a drop-in (`systemctl --user edit atmusic`), for example `ReadWritePaths=` when `ATMUSIC_DB` points outside the state directory.

Operations, secrets, key rotation, health, sleep and the security notes are in [operations.md](../operations.md); backups and restore in [backup.md](../backup.md).
