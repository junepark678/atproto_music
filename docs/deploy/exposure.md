# Public exposure of 127.2.0.1:8888

atmusic listens only on loopback, `127.2.0.1:8888` ([ADR 0005](../adr/0005-local-node-host-and-compat-apis.md) §3.6, §14.6). How public traffic for `https://music.214510.xyz` reaches that port is the owner's choice: one of the three options below. The application never depends on which one is used, but **each option needs its own `ATMUSIC_CLIENT_IP_HEADER`**, and the proxy in front of the port must be configured so that header can only carry the real client address. That address keys every per-IP rate limit (§13), so a wrong pairing lets one client spoof its way past the limits, or puts every client into the same few buckets.

`ATMUSIC_CLIENT_IP_HEADER` has no default: the server refuses to start (exit 78) until `~/.config/atmusic/atmusic.env` sets it. The header is honoured only when the TCP peer is in `ATMUSIC_TRUSTED_PROXIES` (default `127.0.0.0/8,::1`, the same host), only the named header is read, and in `x-forwarded-for` mode the rightmost untrusted entry is used.

| Option | Path | `ATMUSIC_CLIENT_IP_HEADER` |
|---|---|---|
| A | Cloudflare Tunnel (`cloudflared`) → `127.2.0.1:8888` | `cf-connecting-ip` |
| B | DNS only (grey cloud) → Caddy or nginx on this host → `127.2.0.1:8888` | `x-forwarded-for` |
| C | Proxied DNS (orange cloud) → Caddy or nginx on this host → `127.2.0.1:8888` | `x-forwarded-for` |

Common to all three:

- `/oauth/client-metadata.json` and `/oauth/jwks.json` must stay publicly reachable: the authorization servers fetch them at every sign-in and refresh, and cache them for 10 minutes.
- Some scrobbler apps require HTTPS and a real domain; every option provides both.
- No other process on this host may listen on a trusted proxy address (loopback) and relay public traffic to the port with the configured header taken from the client. A same-host process can always forge the header; that residual is accepted on a single-user host ([operations.md](../operations.md#same-uid-exposure-and-the-dedicated-user-option)).

## Option A: Cloudflare Tunnel (recommended)

`cloudflared` runs as a second systemd user unit and opens an outbound-only connection to the Cloudflare edge (port 7844). No public IP, port forwarding or firewall change is needed.

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel id>
credentials-file: /home/<user>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: music.214510.xyz
    service: http://127.2.0.1:8888
  - service: http_status:404
```

```ini
# ~/.config/atmusic/atmusic.env
ATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip
```

- The Cloudflare edge sets `CF-Connecting-IP` itself, overwriting any value a client sent, and `cloudflared` connects from loopback, which is a trusted proxy address.
- The edge read timeout is 125 s, so long work stays asynchronous (imports and backups already are). The server's `keepAliveTimeout` of 100 s is above cloudflared's 90 s origin idle timeout.
- The optional `atmusic.socket` keeps the port open across restarts, so the tunnel sees queued connections instead of 502s.

## Option B: Caddy or nginx on this host, DNS only

**These directives are only for DNS-only exposure**: the DNS record for `music.214510.xyz` is **DNS only** (grey cloud, not proxied by Cloudflare), or not on Cloudflare at all, so the TCP peer the proxy sees is the real client. The proxy listens on `:443` with an ACME certificate and needs a reachable public IP with port forwarding; CGNAT, dynamic IPs and ISP port blocks are the risks.

```ini
# ~/.config/atmusic/atmusic.env
ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for
```

The proxy must drop any client-supplied `CF-Connecting-IP` and **replace** `X-Forwarded-For` with the peer address (never append to a client's value).

Caddy:

```caddyfile
music.214510.xyz {
	reverse_proxy 127.2.0.1:8888 {
		header_up -CF-Connecting-IP
		header_up X-Forwarded-For {remote_host}
	}
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name music.214510.xyz;
    # ssl_certificate / ssl_certificate_key from your ACME client
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.2.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

**Not valid behind the Cloudflare proxy.** With proxied DNS (orange cloud) the TCP peer is a Cloudflare edge address, so `{remote_host}` and `$remote_addr` would give every client the same few edge IPs, and one abuser would exhaust the per-IP buckets for everyone. Use option C instead.

## Option C: Cloudflare proxied DNS to Caddy or nginx on this host

The record is proxied (orange cloud) and the edge connects to a Caddy or nginx on `:443` of this host. All three of the following are **required**; with any one missing, use option A or B instead.

1. **Authenticated Origin Pulls** (mTLS): enable it for the zone, and make the proxy require Cloudflare's origin-pull client certificate (Caddy `client_auth` with `mode require_and_verify`, nginx `ssl_verify_client on` with the origin-pull CA as `ssl_client_certificate`). **And a host firewall that admits `:443` only from Cloudflare's published IP ranges** (the snapshot below), so nobody can connect to the origin directly and forge `CF-Connecting-IP`.
2. The proxy derives the client IP from `CF-Connecting-IP`, **trusting it only from Cloudflare ranges**, and forwards it as the only `X-Forwarded-For` entry.
3. `ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for`.

```ini
# ~/.config/atmusic/atmusic.env
ATMUSIC_CLIENT_IP_HEADER=x-forwarded-for
```

Caddy (the `servers` block is a global option):

```caddyfile
{
	servers {
		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
		client_ip_headers Cf-Connecting-Ip
	}
}

music.214510.xyz {
	tls {
		client_auth {
			mode require_and_verify
			trust_pool file /etc/caddy/cloudflare-origin-pull-ca.pem
		}
	}
	reverse_proxy 127.2.0.1:8888 {
		header_up -CF-Connecting-IP
		header_up X-Forwarded-For {client_ip}
	}
}
```

nginx (the realip module rewrites `$remote_addr` to the client address, so after it `$remote_addr` is the client):

```nginx
# Cloudflare ranges (snapshot below), one set_real_ip_from per range.
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_header CF-Connecting-IP;

server {
    listen 443 ssl;
    server_name music.214510.xyz;
    # ssl_certificate / ssl_certificate_key: a Cloudflare origin certificate or ACME
    ssl_client_certificate /etc/nginx/cloudflare-origin-pull-ca.pem;
    ssl_verify_client on;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.2.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

The firewall, for example with nftables (both families, the same snapshot):

```nft
table inet atmusic_origin {
  set cloudflare_v4 { type ipv4_addr; flags interval; elements = { 173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22, 141.101.64.0/18, 108.162.192.0/18, 190.93.240.0/20, 188.114.96.0/20, 197.234.240.0/22, 198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13, 104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22 } }
  set cloudflare_v6 { type ipv6_addr; flags interval; elements = { 2400:cb00::/32, 2606:4700::/32, 2803:f800::/32, 2405:b500::/32, 2405:8100::/32, 2a06:98c0::/29, 2c0f:f248::/32 } }
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport 443 ip saddr @cloudflare_v4 accept
    tcp dport 443 ip6 saddr @cloudflare_v6 accept
    tcp dport 443 drop
  }
}
```

The firewall and Authenticated Origin Pulls need root; atmusic itself never does.

### Cloudflare IP ranges (dated snapshot)

Snapshot of 2026-10-26, from <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6> (also listed at <https://www.cloudflare.com/ips/>). The application never fetches this list. **Refresh it** (and the Caddy, nginx and firewall lists above) when Cloudflare announces a change, and at least every few months: a missing range sends real clients to the firewall's drop rule, an extra one widens who may set the client IP.

IPv4:

```text
173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22
```

IPv6:

```text
2400:cb00::/32
2606:4700::/32
2803:f800::/32
2405:b500::/32
2405:8100::/32
2a06:98c0::/29
2c0f:f248::/32
```

## Machine sleep

If the machine sleeps, the tunnel or the proxy drops; scrobbler clients queue and retry. On wake, Jetstream resumes from its cursor (or gap recovery runs) and the in-process timers compare wall-clock due times. Keep PowerDevil's automatic suspend on AC off. Masking the sleep targets (`systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`) needs root and is optional.

## Checking an option

From another network: `curl -sS https://music.214510.xyz/health/ready` answers `{"status":"ready"}`, and `journalctl --user -u atmusic` (on this host) shows the request line (method, route pattern, status; never a query string). A request with a forged `CF-Connecting-IP` sent straight to the origin must fail at the firewall (option C) or have the header dropped (option B).
