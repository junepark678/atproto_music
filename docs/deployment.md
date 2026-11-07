# Deploying atmusic

Production is **one Node 26 process on the owner's machine**: the systemd user service `atmusic.service`, listening on `127.2.0.1:8888`, with one SQLite file on local disk, at a cost of $0 ([ADR 0005](adr/0005-local-node-host-and-compat-apis.md) §0 D1, §2, §3, §14). It is a confidential atproto OAuth client (the server holds each user's write session), and it serves `/api/v1` (contract v1.2), a Last.fm 2.0-compatible API at `/2.0/` and a ListenBrainz-compatible API at `/1/`.

| Topic | Guide |
|---|---|
| Install, upgrade, rollback, the unit | [deploy/local-node.md](deploy/local-node.md) |
| How public traffic reaches the port (Cloudflare Tunnel, Caddy/nginx DNS-only, proxied DNS) and the matching `ATMUSIC_CLIENT_IP_HEADER` | [deploy/exposure.md](deploy/exposure.md) |
| Health, admin CLI, logs, secrets and key rotation, Gentoo notes, sleep, same-UID exposure | [operations.md](operations.md) |
| Backups, the revocation journal, restore (disaster recovery only) | [backup.md](backup.md) |
| Artifact-bound rollout gates and rollback plan (currently NO-GO) | [M6 deployment plan](verification/milestones/m6-deployment-plan.md) |

## Deployment values

The owner decided these (ADR 0004 §15 Q3, kept by ADR 0005 §0). They are deploy-time configuration, not code:

| Value | Production | Where |
|---|---|---|
| Public origin | `https://music.214510.xyz` | `ATMUSIC_PUBLIC_ORIGIN` in `config/systemd/atmusic.service` |
| OAuth `client_id` | `https://music.214510.xyz/oauth/client-metadata.json`, served dynamically with `/oauth/jwks.json`; it must never change once anyone has signed in | derived from the origin |
| Lexicon prefix | `dev.pythonplayer123.music` (NSID authority `music.pythonplayer123.dev`) | `LEXICON_PREFIX` in `~/.config/atmusic/atmusic.env` |
| Namespace authority and schema publication | DNS ownership evidence alone does not enable writes. `/api/v1/meta` exposes `publication` only when `NAMESPACE_OWNERSHIP_REF` is set and `NAMESPACE_PUBLICATION_REF` is a `sha256:<64 lowercase hex>` digest of the owner-reviewed manifest proving all four production Lexicons were published and publicly retrieved. Batch imports additionally require the distinct `NAMESPACE_BATCH_PUBLICATION_REF` receipt for all five schemas, including `scrobbleBatch`; see [ADR 0006](adr/0006-batched-import-records.md). Keep the batch reference blank until that separate review is complete. | `NAMESPACE_OWNERSHIP_REF`, `NAMESPACE_PUBLICATION_REF` and `NAMESPACE_BATCH_PUBLICATION_REF` in `atmusic.env` |
| Listen address | `127.2.0.1:8888` (loopback only) | `ATMUSIC_LISTEN` in the unit; `atmusic.socket` |
| Client IP header | depends on the exposure option; no default | `ATMUSIC_CLIENT_IP_HEADER` in `atmusic.env` |
| Sign-in policy | `allowlist` of `ATMUSIC_SIGNIN_DIDS` | `atmusic.env` |

`com.example.atmusic` is the test fixture prefix and is never deployed; the production entry refuses it, and the bundle guard (`scripts/check-node-bundle.ts`) rejects fixture handling in `main.mjs`. Another operator replaces every value above with an origin and an NSID prefix they own.

## Short version

```sh
install -d -m 0700 ~/.config/atmusic
cp config/atmusic.env.example ~/.config/atmusic/atmusic.env          # fill in the required values
umask 077 && node scripts/admin/gen-secrets.ts --out secrets.json    # add "lastfm" by hand
systemd-creds --user encrypt --name=secrets secrets.json ~/.config/atmusic/secrets.cred
ATMUSIC_SECRETS_FILE="$PWD/secrets.json" scripts/install-local.sh    # build, units, --init, switch current
shred -u secrets.json                                                # keep the plaintext in a password manager
loginctl enable-linger && systemctl --user daemon-reload && systemctl --user enable --now atmusic
```

Then choose an exposure option ([deploy/exposure.md](deploy/exposure.md)) and check `https://music.214510.xyz/health/ready`.

## Not a deployment target any more: Cloudflare Workers

ADR 0004 deployed one Worker plus one SQLite Durable Object on Workers Paid. ADR 0005 retires that host: the owner's decision D1 rules out the Paid plan, and the Free plan cannot run the BFF, the resident Jetstream socket, the Last.fm signatures or multi-day imports. N7-01 deleted `scripts/deploy.sh`, `scripts/check-bundle.ts`, `scripts/admin/pitr-restore.ts`, their tests and `.github/workflows/deploy.yml`; `worker/wrangler.jsonc` stays in the repository only for the Workers test entry. **There is no Workers deploy path any more**: never deploy the Worker against the production origin, since the Worker's public OAuth client and the Node host's confidential client cannot share one `client_id`. The previous version of this guide is in git history (`git log -- docs/deployment.md`).
