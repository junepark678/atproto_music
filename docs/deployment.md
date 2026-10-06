# Run the implemented backend

The executable provides the SQLite-backed backend, embedded migrations and placeholder HTML. Backend modules have deterministic tests as recorded in [validation evidence](VALIDATION.md). This deployment guide does not close the M6 backend acceptance gate: live external-PDS sign-in, publication, independently verified relay ingestion and the full packaged journey remain pending. The Preact product is not packaged yet.

Production `serve` starts outbox delivery and durable complete-repository backfills when an owned publication namespace is configured. The verifier authenticates an exact current revision and commit CID through fresh DID/PDS discovery and `getLatestCommit`, followed by signature/CAR/CID/MST verification. Account status and PDS location are checked around snapshot fetching; races retain retryable durable work. Missing ownership evidence keeps publication disabled (`503 outbox_not_ready`). Historical relay ingestion remains disabled until a covered-event progress/recovery policy is safe. Run this build as a backend candidate until the packaged and external acceptance gates are executed.

## Build and inspect

Use the pinned Rust 1.90.0 toolchain, a C compiler and `musl-tools` on Linux x86_64. The resulting executable needs neither a database service nor a Node runtime. Outbound HTTPS uses rustls with bundled public CA roots and requires working DNS; the reverse proxy manages the inbound HTTPS certificate.

```sh
bash scripts/check.sh
cargo build --locked --release --target x86_64-unknown-linux-musl -p atmusic-server
python3 scripts/smoke.py --static target/x86_64-unknown-linux-musl/release/atmusic
python3 scripts/test_smoke.py
```

CI uploads `atmusic` and `atmusic.sha256`. Verify the checksum from the directory containing both files with `sha256sum -c atmusic.sha256`, then restore executable permissions with `chmod 755 atmusic` after extracting the CI artifact. `smoke.py --static` rejects an ELF interpreter or shared-library dependency, starts its own child from a temporary directory, checks initialized SQLite/HTTP and terminates that child. Its pass establishes packaging and startup; it does not establish live music interoperability.

## Configure storage and origin

Copy [`config/atmusic.env.example`](../config/atmusic.env.example) to a file accessible only to the service operator. The executable reads process environment variables and CLI flags; it does not automatically load `.env`.

| Variable | Meaning |
| --- | --- |
| `ATMUSIC_TRUSTED_PROXY_CIDRS` | Optional comma-separated CIDRs for controlled reverse-proxy peers. Unset ignores all forwarded identity headers. Never trust all Internet addresses. |
| `ATMUSIC_BIND` | Listener address; default `127.0.0.1:3000`. |
| `ATMUSIC_DATABASE_PATH` | Persistent SQLite file; default `data/music.sqlite`. Parent directories are created during initialization. |
| `ATMUSIC_PUBLIC_ORIGIN` | Required HTTPS origin, such as your public hostname, without credentials, path, query or fragment. OAuth callback and Origin checks use this exact origin. |
| `ATMUSIC_TRUSTED_PROXY_CIDRS` | Optional comma-separated explicit IPv4/IPv6 proxy CIDRs. Disabled by default; only those socket peers may provide client forwarding information. |
| `ATMUSIC_ENCRYPTION_KEY` | Required stable 32-byte key encoded as 64 hexadecimal characters; all-zero keys are rejected. Protect it separately from the database backup. |
| `ATMUSIC_LEXICON_PREFIX` | Optional owned production NSID prefix. Keep unset until namespace ownership is recorded; reserved fixture namespaces never authorize real publication. |
| `ATMUSIC_NAMESPACE_OWNER_DOMAIN` / `ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE` | Set both to the controlled reverse-domain and reviewable ownership evidence before production publication. |
| `ATMUSIC_METRICS_BIND` | Separate metrics listener; default `127.0.0.1:0` selects a loopback port. Set `127.0.0.1:9091` for a stable local scrape port. |
| `ATMUSIC_METRICS_TOKEN` | Required 64 hexadecimal characters when metrics binds outside loopback; send as a Bearer credential. Never expose the listener through the public proxy. |
| `ATMUSIC_RELAY_URL` | Optional WSS or HTTPS relay URL without credentials or fragment. |
| `RUST_LOG` | Tracing filter; `info` is suitable for normal startup and request diagnostics. |

Generate the application key once with a secure random generator, for example `python3 -c 'import secrets; print(secrets.token_hex(32))'`, and place the result in the protected environment file. Preserve it when moving or restoring the instance. Replacing it invalidates derived session/CSRF material and prevents decryption of existing OAuth secrets. The database also contains private account/session state, so restrict access to its directory.

Run migrations without opening a listener:

```sh
./atmusic migrate --database-path /var/lib/atmusic/music.sqlite
```

Migrations are embedded in the executable and can be repeated. A database with a newer unsupported schema fails startup. `migrate` needs the database path only; `serve` validates the required origin/key before creating the database or binding HTTP.

For an interactive local run with a prepared `.env`:

```sh
set -a
. ./.env
set +a
./atmusic serve
```

CLI values such as `--bind` and `--database-path` override corresponding environment variables. The public origin remains HTTPS even when a local reverse proxy forwards to the loopback HTTP listener.

## Process supervision and HTTPS

Run one process for each database; the bounded writer serializes SQLite mutations inside that process. A minimal systemd unit, after installing the binary and creating the `atmusic` service user and writable data directory, is:

```ini
[Unit]
Description=AT Protocol music backend
After=network-online.target
Wants=network-online.target

[Service]
User=atmusic
Group=atmusic
WorkingDirectory=/var/lib/atmusic
EnvironmentFile=/etc/atmusic/atmusic.env
ExecStart=/opt/atmusic/atmusic serve --bind 127.0.0.1:3000 --database-path /var/lib/atmusic/music.sqlite
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

Terminate HTTPS at your reverse proxy using a certificate for the configured public origin. For example, the relevant nginx server block is:

```nginx
server {
    listen 443 ssl;
    server_name music.example;
    ssl_certificate /etc/letsencrypt/live/music.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Replace the example hostname and certificate paths with yours. Preserve request cookies, Origin and CSRF headers. Do not place private API responses in a proxy cache. Browser sessions use `Secure`, `HttpOnly`, `SameSite=Lax` cookies, so browser authentication must reach the public HTTPS origin.

Logout invalidates local sessions and stored OAuth tokens even if upstream revocation fails or the issuer offers no revocation endpoint. A DPoP nonce challenge permits one immediate retry; HTTP 500 and unsupported revocation do not schedule background retries or invent another endpoint. Local logout does not establish that the upstream issuer revoked the credential.

`/health/live` reports process liveness. `/health/ready` reports 200 only while local storage/writer initialization is usable; a PDS/relay outage does not itself make local storage unready. `/api/v1/meta` reports the full API shape and begins with `indexing.state=recovering`, `caughtUp=false`; inspect it separately when evaluating federation progress. The root page continues to identify unimplemented music product features.

With a configured relay, startup marks its durable connection as disconnected and its gap unresolved while relay delivery is disabled, preserving the prior sequence and event time. A restored `connected=true` row cannot establish that this process has a live stream. Completed current-head backfills do not make global relay indexing caught up.

SIGINT or SIGTERM stops both API and metrics listeners, cancels owned workers while storage admission remains open for cleanup, then stops writer admission and drains requests/storage. One absolute 30-second deadline covers the complete sequence. An ordinary idle shutdown exits zero. A timeout or worker cleanup failure exits nonzero and reports unfinished writes, servers and workers. Committed outbox rows survive restart; an uncommitted in-memory closure is not a durable acknowledgement. Delivery and live recovery gates must be verified before claiming production backend acceptance.

## Backup and acceptance status

Use the [SQLite snapshot and restore commands](backup.md); preserve the encryption key separately. Back up before every upgrade, stop the service before changing the executable or migrating, and run migrations against the existing database. A failed migration must stop the upgrade: keep the original database and restore the pre-upgrade snapshot into a new directory with the previous executable. Never reset or delete the existing database automatically.

M6 completion also requires dedicated test identities, an owned lexicon namespace, a public HTTPS callback and a configured relay covering independently operated PDS endpoints. Fixture passes and the packaged smoke cannot substitute for those gates. Record artifact checksum, test date, independently fetched record evidence and cleanup outcomes according to [TESTING.md](planning/TESTING.md).

## Fresh install and upgrade

Create a dedicated unprivileged service account. Install the verified executable under `/opt/atmusic/atmusic` with mode 755; create `/var/lib/atmusic` and `/etc/atmusic` owned by that account with mode 700. Copy `config/atmusic.env.example` to `/etc/atmusic/atmusic.env`, fill the required origin and newly generated key, and set mode 600. Keep a protected copy of the key outside the data directory. Run the migration command above as the service account, then start the supervisor and check `/health/ready` plus `/api/v1/meta`.

For an upgrade, preserve the previous executable and run:

```sh
/opt/atmusic/atmusic backup --database-path /var/lib/atmusic/music.sqlite --output /secure-backups/before-upgrade.sqlite
systemctl stop atmusic
# Install the verified candidate executable, retaining the previous executable.
/opt/atmusic/atmusic migrate --database-path /var/lib/atmusic/music.sqlite
# Continue only if migration exits zero.
systemctl start atmusic
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1:3000/api/v1/meta
```

The snapshot output must be new and its parent directory must exist with restricted access. On a migration failure, leave the service stopped and preserve the failed database for diagnosis. Use `restore` to create a separate recovery directory from the snapshot, retain the original key, and point the previous executable at that restored file. A restart with the same data and key preserves persisted history, operation queue and sessions.

The configured public HTTPS origin always controls OAuth URLs, Origin/CSRF checks and secure cookies. Forwarding is disabled by default. To separate anonymous client quotas behind the nginx example, explicitly set `ATMUSIC_TRUSTED_PROXY_CIDRS=127.0.0.1/32` (or `--trusted-proxy-cidrs`); add only the actual proxy addresses, including `::1/128` if it connects over IPv6. The configuration accepts at most 32 IPv4/IPv6 CIDRs and fails before storage/listeners on invalid values.

Only a socket peer in those CIDRs may supply `X-Forwarded-*`. The proxy must replace proto/host and append the actual connecting client to `X-Forwarded-For`. The server requires one `https` proto header and one host matching the configured public origin, then walks at most 16 IP hops from right to left and selects the first untrusted address. This prevents a client-supplied leftmost address from defeating the quota. Invalid, duplicate, oversized or inconsistent headers fall back to the socket peer. RFC `Forwarded` headers do not override this policy. Without trusted CIDRs, anonymous requests through a proxy share its 120-read/minute quota. Authenticated mutations are limited to 60 per user/minute and request bodies to 64 KiB. Do not publish the separate metrics listener in the public nginx location.
