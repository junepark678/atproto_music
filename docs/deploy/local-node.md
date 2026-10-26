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

   It builds `~/.local/lib/atmusic/releases/<sha>` from a git worktree of that commit with `npm ci --ignore-scripts` (no dependency install script ever runs), `npm run build:web` and `npx tsx scripts/build-server.ts`, checks that `main.mjs --version` prints the sha, installs both units into `~/.config/systemd/user`, creates the database once with `main.mjs --init` (only when it does not exist yet; the server refuses to start on a missing database otherwise, ADR §3.2), and switches `current` to the release atomically (`ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`).
4. **Activate.** The installer prints these and runs them only with `--enable`:

   ```sh
   loginctl enable-linger
   systemctl --user daemon-reload
   systemctl --user enable --now atmusic
   ```

   Optionally `systemctl --user enable --now atmusic.socket` as well: it keeps `127.2.0.1:8888` open across restarts, so a tunnel sees queued connections instead of 502s.
5. **Check.** `curl -sS -H 'Host: 127.2.0.1:8888' http://127.2.0.1:8888/health/ready` answers `{"status":"ready"}`; `journalctl --user -u atmusic -n 50` shows `run.ready`; `atmusic-admin status` ([operations.md](../operations.md#admin-cli)) answers over the admin socket.

Startup exits 78 (configuration, never restarted) naming the variable that is wrong, missing or forbidden, and 75 when another process holds the database; both are in `RestartPreventExitStatus=` so systemd does not loop. See [operations.md](../operations.md#exit-codes-and-restarts).

## Upgrades and rollback

```sh
cd <checkout> && git fetch && git checkout <new sha>
atmusic-admin backup                    # optional: the server also takes a pre-migration backup itself
scripts/install-local.sh                # builds releases/<new sha>, switches current
systemctl --user restart atmusic
curl -sS -H 'Host: 127.2.0.1:8888' http://127.2.0.1:8888/health/ready
```

`npm ci` never runs inside the sandboxed unit. A migration, if any, runs at the next start, after a pre-migration backup, while systemd extends the start timeout (`TimeoutStartSec=15min` plus `EXTEND_TIMEOUT_USEC`).

**Rollback is a link switch, never a restore:** `ln -sfn releases/<old sha> ~/.local/lib/atmusic/current.tmp && mv -T ~/.local/lib/atmusic/current.tmp ~/.local/lib/atmusic/current`, then `systemctl --user restart atmusic`. Migrations are additive and `schema_compat.min_compatible_version` stays at or below the older release's version, so the old code runs on the migrated database and ignores what it does not know. Restoring a backup instead would bring back revoked credentials, refresh tokens the authorization server has already rotated, and lose acknowledged scrobbles ([backup.md](../backup.md#restore-is-disaster-recovery-only)).

Old releases can be removed with `git -C <checkout> worktree remove ~/.local/lib/atmusic/releases/<sha>` once you no longer want to roll back to them.

## The unit

[`config/systemd/atmusic.service`](../../config/systemd/atmusic.service) is exactly ADR 0005 §14.1 (`scripts/test/systemd-unit.test.ts` checks it byte for byte). Points worth knowing:

- `Type=notify`, `NotifyAccess=all`, `WatchdogSec=60s`: the server sends `READY=1` after it listens, and `WATCHDOG=1` every 20 s only while an event-loop lag probe and `SELECT 1` succeed.
- `UnsetEnvironment=` removes `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_PATH`, the proxy variables in both cases and `SSL_CERT_FILE`/`SSL_CERT_DIR` that the user manager would otherwise pass on; the server exits 78 if one still reaches it. `atmusic.env` cannot set them either.
- Secrets arrive only as the credential `secrets` (`LoadCredentialEncrypted=`), never in the environment.
- Never add `MemoryDenyWriteExecute` (V8's JIT aborts) or `PrivateNetwork` (outbound traffic is required); `IPAddressDeny`/`IPAddressAllow` are not enforced in user units. If `SystemCallFilter=~@resources` ever causes EPERM under load, drop only that line.
- Overrides go into a drop-in (`systemctl --user edit atmusic`), for example `ReadWritePaths=` when `ATMUSIC_DB` points outside the state directory.

Operations, secrets, key rotation, health, sleep and the security notes are in [operations.md](../operations.md); backups and restore in [backup.md](../backup.md).
