// The trusted client address (ADR 0005 §3.6, §13, §14.6; N1-06), ported from
// the Rust oracle crates/server/src/http/limits.rs:138-191. Plan case
// M6.1.2/trusted_proxy (ADR 0005 §20.2): a client-IP header counts only from a
// configured proxy, only the header the operator named is read, and an
// X-Forwarded-For chain yields its rightmost untrusted hop.

import { request as httpRequest } from 'node:http';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_IP_MODES,
  ClientIpConfigError,
  type ClientIpMode,
  createClientIpPolicy,
  DEFAULT_TRUSTED_PROXIES,
  type HeaderReader,
  rateKeyOf,
  resolveClientIp,
} from '../../src/node/client-ip';
import { type BridgeServer, createServer } from '../../src/node/http-bridge';

const CLIENT = '203.0.113.7';
const FORGED = '198.51.100.66';
const PROXY = '127.0.0.1';
const OUTSIDE_PEER = '192.0.2.10';

/** A header source that records every name read, so "only the named header is read" is observable. */
function recordingHeaders(values: Record<string, string>): HeaderReader & { reads: string[] } {
  const reads: string[] = [];
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    reads,
    get(name: string) {
      reads.push(name);
      return lower[name.toLowerCase()] ?? null;
    },
  };
}

/** Every client-IP header a forger could send, each naming a different address. */
const ALL_FORGED = {
  'cf-connecting-ip': '198.51.100.1',
  'x-forwarded-for': '198.51.100.2',
  'x-real-ip': '198.51.100.3',
  forwarded: 'for=198.51.100.4',
  'true-client-ip': '198.51.100.5',
};

const servers: BridgeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** A bridge on 127.0.0.1:0 whose handler answers the resolved client address. */
async function echoClientIp(mode: ClientIpMode, trustedProxies?: string) {
  const policy = createClientIpPolicy({ mode, trustedProxies });
  const bridge = createServer({
    publicOrigin: 'https://music.example.test',
    listen: { host: '127.0.0.1', port: 0 },
    random: seededRandom(6),
    handler: (request, info) =>
      Response.json({ clientIp: resolveClientIp(policy, info.peer, request.headers), peer: info.peer }),
  });
  servers.push(bridge);
  const address = await bridge.start();
  return (headers: Record<string, string>) =>
    new Promise<{ status: number; body: { clientIp: string; peer: string } }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: address.host,
          port: address.port,
          path: '/api/v1/meta',
          headers: { host: address.authority, ...headers },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
}

describe('client IP', () => {
  it('CF-Connecting-IP is honoured only in cf-connecting-ip mode and only from a peer in ATMUSIC_TRUSTED_PROXIES; otherwise the peer address is used', async () => {
    expect(DEFAULT_TRUSTED_PROXIES).toBe('127.0.0.0/8,::1');
    const cf = createClientIpPolicy({ mode: 'cf-connecting-ip' });

    // From a trusted proxy (loopback, the default list) in cf-connecting-ip mode: the header.
    const fromProxy = recordingHeaders({ 'cf-connecting-ip': CLIENT });
    expect(resolveClientIp(cf, PROXY, fromProxy)).toBe(CLIENT);
    expect(fromProxy.reads).toEqual(['cf-connecting-ip']);
    expect(resolveClientIp(cf, '::1', recordingHeaders({ 'cf-connecting-ip': '2001:DB8::0:1' }))).toBe('2001:db8::1');
    // A dual-stack socket reports an IPv4 loopback peer as ::ffff:127.0.0.1; it is still the proxy.
    expect(resolveClientIp(cf, '::ffff:127.0.0.1', recordingHeaders({ 'cf-connecting-ip': CLIENT }))).toBe(CLIENT);

    // From a peer outside ATMUSIC_TRUSTED_PROXIES: the peer, and no header is even read.
    const direct = recordingHeaders({ 'cf-connecting-ip': FORGED });
    expect(resolveClientIp(cf, OUTSIDE_PEER, direct)).toBe(OUTSIDE_PEER);
    expect(direct.reads).toEqual([]);
    // An operator list that leaves loopback out makes the loopback peer untrusted too.
    const narrow = createClientIpPolicy({ mode: 'cf-connecting-ip', trustedProxies: '10.0.0.0/8' });
    expect(resolveClientIp(narrow, PROXY, recordingHeaders({ 'cf-connecting-ip': FORGED }))).toBe(PROXY);
    expect(resolveClientIp(narrow, '10.1.2.3', recordingHeaders({ 'cf-connecting-ip': CLIENT }))).toBe(CLIENT);

    // In every other mode a trusted proxy's CF-Connecting-IP is never read.
    for (const mode of CLIENT_IP_MODES.filter((m) => m !== 'cf-connecting-ip')) {
      const headers = recordingHeaders({ 'cf-connecting-ip': FORGED });
      expect(resolveClientIp(createClientIpPolicy({ mode }), PROXY, headers), mode).toBe(PROXY);
      expect(headers.reads.includes('cf-connecting-ip'), mode).toBe(false);
    }

    // A malformed or repeated header (Headers joins repeats with ", ") falls back to the peer.
    for (const value of ['not-an-ip', `${CLIENT}, ${FORGED}`, `${CLIENT}:443`, 'fe80::1%eth0', '', '1'.repeat(1025)]) {
      expect(resolveClientIp(cf, PROXY, recordingHeaders({ 'cf-connecting-ip': value })), value).toBe(PROXY);
    }
    // No socket peer at all: the oracle's 0.0.0.0, never a header value.
    expect(resolveClientIp(cf, undefined, recordingHeaders({ 'cf-connecting-ip': CLIENT }))).toBe('0.0.0.0');

    // There is no default mode: unset or unknown is a configuration error naming the variable.
    for (const mode of [undefined, '', 'X-Forwarded-For', 'forwarded']) {
      expect(() => createClientIpPolicy({ mode }), String(mode)).toThrowError(ClientIpConfigError);
      expect(() => createClientIpPolicy({ mode }), String(mode)).toThrowError(/^ATMUSIC_CLIENT_IP_HEADER: /);
    }
    expect(() => createClientIpPolicy({ mode: 'none', trustedProxies: '127.0.0.0/33' })).toThrowError(
      /^ATMUSIC_TRUSTED_PROXIES: invalid CIDR "127.0.0.0\/33"/,
    );

    // Over a real socket through the HTTP bridge: the peer is 127.0.0.1.
    const viaDefault = await echoClientIp('cf-connecting-ip');
    const honoured = await viaDefault({ 'cf-connecting-ip': CLIENT });
    expect(honoured).toEqual({ status: 200, body: { clientIp: CLIENT, peer: PROXY } });
    expect((await viaDefault({})).body.clientIp).toBe(PROXY);
    const viaNarrow = await echoClientIp('cf-connecting-ip', '10.0.0.0/8');
    expect((await viaNarrow({ 'cf-connecting-ip': FORGED })).body).toEqual({ clientIp: PROXY, peer: PROXY });
    // The bridge strips x-atmusic-* before the handler, so the Workers-era header cannot be forged either.
    const viaNone = await echoClientIp('none');
    expect((await viaNone({ 'cf-connecting-ip': FORGED, 'x-atmusic-client-ip': FORGED })).body.clientIp).toBe(PROXY);
  });

  it('x-forwarded-for mode returns the rightmost untrusted entry and ignores a forged leftmost entry', () => {
    const xff = createClientIpPolicy({ mode: 'x-forwarded-for', trustedProxies: '127.0.0.0/8,::1,10.0.0.0/8' });
    const resolve = (chain: string, peer = PROXY) => {
      const headers = recordingHeaders({ 'x-forwarded-for': chain, 'cf-connecting-ip': FORGED, 'x-real-ip': FORGED });
      const ip = resolveClientIp(xff, peer, headers);
      expect(headers.reads, chain).toEqual(['x-forwarded-for']);
      return ip;
    };

    // The client forged the leftmost entry; the proxy appended the address it saw.
    expect(resolve(`${FORGED}, ${CLIENT}`)).toBe(CLIENT);
    // Trusted hops on the right are skipped, and the first untrusted one from the right wins.
    expect(resolve(`${FORGED}, ${CLIENT}, 10.0.0.5, 127.0.0.1`)).toBe(CLIENT);
    expect(resolve(`${FORGED}, 2001:db8::77, 10.0.0.5`)).toBe('2001:db8::77');
    // A single entry, written by the proxy with Caddy `{remote_host}` / nginx `$remote_addr`.
    expect(resolve(CLIENT)).toBe(CLIENT);
    // Every entry a trusted proxy: the first, as the oracle.
    expect(resolve('10.0.0.9, 127.0.0.1')).toBe('10.0.0.9');
    // A malformed entry anywhere, more than 16 entries, or an oversized value: the peer.
    expect(resolve(`${FORGED}, garbage, ${CLIENT}`)).toBe(PROXY);
    expect(resolve(`${FORGED},, ${CLIENT}`)).toBe(PROXY);
    expect(resolve(`${CLIENT}:8080`)).toBe(PROXY);
    const seventeen = Array.from({ length: 17 }, (_, i) => `198.51.100.${i + 1}`).join(', ');
    expect(resolve(seventeen)).toBe(PROXY);
    const sixteen = Array.from({ length: 16 }, (_, i) => `198.51.100.${i + 1}`).join(', ');
    expect(resolve(sixteen)).toBe('198.51.100.16');
    // A peer outside the trusted list: its own address, the chain unread.
    const direct = recordingHeaders({ 'x-forwarded-for': CLIENT });
    expect(resolveClientIp(xff, OUTSIDE_PEER, direct)).toBe(OUTSIDE_PEER);
    expect(direct.reads).toEqual([]);
    // No header from a trusted proxy: the proxy itself.
    expect(resolveClientIp(xff, PROXY, recordingHeaders({}))).toBe(PROXY);
  });

  it('a forged CF-Connecting-IP relayed by a trusted proxy is ignored in x-forwarded-for, x-real-ip and none modes, and is used only when the operator chose cf-connecting-ip', () => {
    // A same-host Caddy or nginx (exposure option B) forwards a client-supplied
    // CF-Connecting-IP unless told to drop it; the peer is the loopback proxy.
    const relayed = { ...ALL_FORGED, 'x-forwarded-for': `${ALL_FORGED['x-forwarded-for']}, ${CLIENT}` };
    const expected: Record<ClientIpMode, string> = {
      'cf-connecting-ip': ALL_FORGED['cf-connecting-ip'],
      'x-forwarded-for': CLIENT,
      'x-real-ip': ALL_FORGED['x-real-ip'],
      none: PROXY,
    };
    const readsByMode: Record<ClientIpMode, string[]> = {
      'cf-connecting-ip': ['cf-connecting-ip'],
      'x-forwarded-for': ['x-forwarded-for'],
      'x-real-ip': ['x-real-ip'],
      none: [],
    };
    for (const mode of CLIENT_IP_MODES) {
      const headers = recordingHeaders(relayed);
      const ip = resolveClientIp(createClientIpPolicy({ mode }), PROXY, headers);
      expect(ip, mode).toBe(expected[mode]);
      expect(headers.reads, mode).toEqual(readsByMode[mode]);
      if (mode !== 'cf-connecting-ip') expect(ip, mode).not.toBe(ALL_FORGED['cf-connecting-ip']);
    }
    // x-real-ip mode without the header: the proxy, never the forged CF-Connecting-IP.
    const realIp = createClientIpPolicy({ mode: 'x-real-ip' });
    expect(resolveClientIp(realIp, PROXY, recordingHeaders({ 'cf-connecting-ip': FORGED }))).toBe(PROXY);
    expect(resolveClientIp(realIp, PROXY, recordingHeaders({ 'x-real-ip': ` ${CLIENT} ` }))).toBe(CLIENT);

    // rateKeyOf keys the resolved address: IPv4 itself, IPv6 its /64.
    expect(rateKeyOf(CLIENT)).toBe(CLIENT);
    expect(rateKeyOf('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(rateKeyOf('2001:DB8:AA:BB::9')).toBe('2001:db8:aa:bb::/64');
    expect(rateKeyOf('::ffff:203.0.113.7')).toBe(CLIENT);
  });
});
