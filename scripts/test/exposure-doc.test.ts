// docs/deploy/exposure.md (ADR 0005 §14.6, §3.6, §20.4 row 17; N4-02). The
// exposure guide is configuration the owner copies, so its load-bearing
// statements are checked: each option names a client-IP mode the server
// accepts, option B is restricted to DNS-only exposure, option C requires
// Authenticated Origin Pulls and a Cloudflare-only firewall and gives the
// trusted_proxies / set_real_ip_from directives, and every range list in the
// examples is exactly the dated Cloudflare snapshot with its source URLs.

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADERS } from '../../worker/src/node/config.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(join(REPO, 'docs', 'deploy', 'exposure.md'), 'utf8');

/** The text of the `## ` section whose heading starts with `prefix`, up to the next `## ` heading. */
function section(prefix: string): string {
  const start = DOC.indexOf(`\n## ${prefix}`);
  expect(start, prefix).toBeGreaterThan(0);
  const next = DOC.indexOf('\n## ', start + 4);
  return DOC.slice(start, next === -1 ? undefined : next);
}

/** The fenced code blocks of `text` with the given info string. */
function blocks(text: string, lang: string): string[] {
  return [...text.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``, 'g'))].map((m) => m[1] as string);
}

function isCidr(text: string): boolean {
  const [ip, len, ...rest] = text.split('/');
  if (ip === undefined || len === undefined || rest.length > 0 || !/^\d{1,3}$/.test(len)) return false;
  const family = isIP(ip);
  return (family === 4 && Number(len) <= 32) || (family === 6 && Number(len) <= 128);
}

function clientIpMode(text: string): string[] {
  return [...text.matchAll(/ATMUSIC_CLIENT_IP_HEADER=([a-z-]+)/g)].map((m) => m[1] as string);
}

describe('docs/deploy/exposure.md', () => {
  it('docs/deploy/exposure.md option C requires Authenticated Origin Pulls and a Cloudflare-only firewall and gives the trusted_proxies and set_real_ip_from directives, and option B states it is for DNS-only exposure', () => {
    const a = section('Option A');
    const b = section('Option B');
    const c = section('Option C');

    // --- The dated snapshot and its source. ---------------------------------
    const snapshot = c.slice(c.indexOf('### Cloudflare IP ranges'));
    expect(snapshot).toMatch(
      /Snapshot of \d{4}-\d{2}-\d{2}, from <https:\/\/www\.cloudflare\.com\/ips-v4> and <https:\/\/www\.cloudflare\.com\/ips-v6>/,
    );
    expect(snapshot).toContain('The application never fetches this list.');
    expect(snapshot).toMatch(/\*\*Refresh it\*\*/);
    const [v4Block, v6Block] = blocks(snapshot, 'text') as [string, string];
    const v4 = v4Block.split('\n');
    const v6 = v6Block.split('\n');
    expect(v4.length).toBeGreaterThanOrEqual(10);
    expect(v6.length).toBeGreaterThanOrEqual(5);
    for (const range of v4) expect(isCidr(range) && isIP(range.split('/')[0] as string) === 4, range).toBe(true);
    for (const range of v6) expect(isCidr(range) && isIP(range.split('/')[0] as string) === 6, range).toBe(true);
    const ranges = [...v4, ...v6];
    expect(new Set(ranges).size).toBe(ranges.length);

    // --- Option C: all three requirements, and the directives. --------------
    expect(c).toMatch(/All three of the following are \*\*required\*\*/);
    expect(c).toMatch(/\*\*Authenticated Origin Pulls\*\* \(mTLS\)/);
    expect(c).toMatch(/\*\*And a host firewall that admits `:443` only from Cloudflare's published IP ranges\*\*/);
    expect(c).toMatch(/\*\*trusting it only from Cloudflare ranges\*\*/);
    expect(clientIpMode(c)).toEqual(['x-forwarded-for', 'x-forwarded-for']);

    const [caddy] = blocks(c, 'caddyfile') as [string];
    const trusted = /trusted_proxies static ([^\n]+)/.exec(caddy);
    expect(trusted, 'trusted_proxies static').not.toBeNull();
    expect(
      String(trusted === null ? '' : trusted[1])
        .trim()
        .split(/\s+/),
    ).toEqual(ranges);
    expect(caddy).toMatch(/\n\t\tclient_ip_headers Cf-Connecting-Ip\n/);
    expect(caddy).toContain('header_up -CF-Connecting-IP');
    expect(caddy).toContain('header_up X-Forwarded-For {client_ip}');
    expect(caddy).not.toContain('{remote_host}');
    expect(caddy).toContain('mode require_and_verify'); // origin-pull client certificate

    const [nginx] = blocks(c, 'nginx') as [string];
    const realIpFrom = [...nginx.matchAll(/^set_real_ip_from ([^;]+);$/gm)].map((m) => m[1]);
    expect(realIpFrom).toEqual(ranges);
    expect(nginx).toMatch(/^real_ip_header CF-Connecting-IP;$/m);
    expect(nginx).toContain('proxy_set_header CF-Connecting-IP "";');
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginx).toContain('ssl_verify_client on;');
    // The realip module must run before X-Forwarded-For is built from $remote_addr.
    expect(nginx.indexOf('real_ip_header')).toBeLessThan(nginx.indexOf('proxy_set_header X-Forwarded-For'));

    const [nft] = blocks(c, 'nft') as [string];
    const elements = [...nft.matchAll(/elements = \{ ([^}]+) \}/g)].map((m) =>
      (m[1] as string).split(/,\s*/).map((s) => s.trim()),
    );
    expect(elements).toEqual([v4, v6]);
    expect(nft).toContain('tcp dport 443 drop');

    // --- Option B: DNS only, with its own directives and the warning. -------
    expect(b).toContain('**These directives are only for DNS-only exposure**');
    expect(b).toMatch(/\*\*DNS only\*\* \(grey cloud, not proxied by Cloudflare\)/);
    expect(b).toMatch(/\*\*Not valid behind the Cloudflare proxy\.\*\*/);
    expect(b).toContain('Use option C instead.');
    expect(clientIpMode(b)).toEqual(['x-forwarded-for']);
    const [bCaddy] = blocks(b, 'caddyfile') as [string];
    expect(bCaddy).toContain('header_up -CF-Connecting-IP');
    expect(bCaddy).toContain('header_up X-Forwarded-For {remote_host}');
    expect(bCaddy).not.toContain('trusted_proxies');
    const [bNginx] = blocks(b, 'nginx') as [string];
    expect(bNginx).toContain('proxy_set_header CF-Connecting-IP "";');
    expect(bNginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(bNginx).not.toContain('set_real_ip_from');

    // --- Option A: the tunnel and the header the edge sets. -----------------
    expect(clientIpMode(a)).toEqual(['cf-connecting-ip']);
    expect(a).toContain('service: http://127.2.0.1:8888');
    expect(a).toContain('service: http_status:404');

    // Every mode the guide names is one the server accepts (worker/src/node/config.ts).
    for (const mode of clientIpMode(DOC)) expect(CLIENT_IP_HEADERS).toContain(mode);
    // The summary table pairs each option with its mode.
    expect(DOC).toMatch(/\| A \| Cloudflare Tunnel[^|]*\| `cf-connecting-ip` \|/);
    expect(DOC).toMatch(/\| B \| DNS only \(grey cloud\)[^|]*\| `x-forwarded-for` \|/);
    expect(DOC).toMatch(/\| C \| Proxied DNS \(orange cloud\)[^|]*\| `x-forwarded-for` \|/);
  });
});
