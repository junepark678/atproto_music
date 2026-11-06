// M2.1.2/ssrf_destinations (ADR 0004 §8, A5): destinations are refused before
// any connection — neither DoH nor the target is contacted.
import { createSafeFetch, SafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import { checkUrl, classifyAddress } from '@atmusic/atproto/net/url-policy';
import type { Transport } from '@atmusic/atproto/transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';

/** A transport that records every request; DoH answers a public address. */
function recordingTransport(fixture: boolean): Transport & { calls: string[]; fixture?: true } {
  const calls: string[] = [];
  const t = (async (req: Request) => {
    calls.push(req.url);
    const url = new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com') {
      const type = Number(url.searchParams.get('type'));
      const data = type === 1 ? '93.184.215.14' : '2606:4700::6810:84e5';
      return Response.json({ Status: 0, Answer: [{ name: url.searchParams.get('name'), type, TTL: 60, data }] });
    }
    return Response.json({ ok: true });
  }) as Transport & { calls: string[]; fixture?: true };
  t.calls = calls;
  if (fixture) t.fixture = true;
  return t;
}

const REFUSED: ReadonlyArray<[string, string]> = [
  ['http://pds.example.com/xrpc/x', 'not_https'],
  ['ftp://pds.example.com/', 'not_https'],
  ['https://pds.example.com:8443/', 'non_default_port'],
  ['https://pds.example.com:80/', 'non_default_port'],
  ['https://user:pw@pds.example.com/', 'credentials'],
  ['https://user@pds.example.com/', 'credentials'],
  ['https://pds.example.com/#frag', 'fragment'],
  ['https://pds.example.com/#', 'fragment'],
  // IPv4 literals: loopback, 10/8, cloud metadata, public (literals are refused regardless)
  ['https://127.0.0.1/', 'ip_literal'],
  ['https://10.1.2.3/', 'ip_literal'],
  ['https://169.254.169.254/latest/meta-data/', 'ip_literal'],
  ['https://8.8.8.8/', 'ip_literal'],
  // decimal, octal, hex and short IPv4 forms (WHATWG canonicalises them to 127.0.0.1 / 10.0.0.1)
  ['https://2130706433/', 'ip_literal'],
  ['https://0177.0.0.1/', 'ip_literal'],
  ['https://0x7f.0.0.1/', 'ip_literal'],
  ['https://127.1/', 'ip_literal'],
  ['https://012.0.0.1/', 'ip_literal'],
  // IPv6 literals, including IPv4-mapped private and loopback
  ['https://[::1]/', 'ip_literal'],
  ['https://[::ffff:10.0.0.1]/', 'ip_literal'],
  ['https://[::ffff:7f00:1]/', 'ip_literal'],
  ['https://[fd00::1]/', 'ip_literal'],
  ['https://[2606:4700::1]/', 'ip_literal'],
  // local names
  ['https://localhost/', 'localhost'],
  ['https://LOCALHOST/', 'localhost'],
  ['https://api.localhost/', 'localhost'],
  ['https://printer.local/', 'reserved_tld'],
  ['https://metadata.google.internal/', 'reserved_tld'],
  ['https://1.0.0.127.in-addr.arpa/', 'reserved_tld'],
  ['https://alice.test/', 'reserved_tld'],
  ['https://intranet/', 'single_label'],
  ['https://pds.example.com./', 'trailing_dot'],
  ['https://bad_label.example.com/', 'bad_label'],
];

describe('url policy', () => {
  it('rejects http, non-default port, credentials, fragment, IP literals (v4/v6/mapped/decimal), localhost, .internal, single label', async () => {
    for (const [url, reason] of REFUSED) {
      expect({ url, result: checkUrl(url) }).toEqual({ url, result: { ok: false, reason } });
    }
    expect(checkUrl('not a url')).toEqual({ ok: false, reason: 'unparseable' });

    // Through SafeFetch: blocked_destination, and no request of any kind leaves.
    const transport = recordingTransport(false);
    const safeFetch = createSafeFetch({ transport, clock: fixedClock() });
    for (const [url, reason] of REFUSED) {
      const error = await safeFetch(url, { kind: 'json' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SafeFetchError);
      expect({ url, code: (error as SafeFetchError).code, reason: (error as SafeFetchError).reason }).toEqual({
        url,
        code: 'blocked_destination',
        reason,
      });
    }
    expect(transport.calls).toEqual([]);

    // Positive controls: an explicit :443 is the default port; IDNs are punycoded.
    const ok = checkUrl('https://PDS.Example.com:443/xrpc/com.atproto.sync.getRecord?did=x');
    expect(ok.ok && ok.host).toBe('pds.example.com');
    expect(checkUrl('https://bücher.example.com/').ok).toBe(true);
    const res = await safeFetch('https://pds.example.com/xrpc/x', { kind: 'json' });
    expect(res.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({ ok: true });
    expect(transport.calls).toEqual([
      'https://cloudflare-dns.com/dns-query?name=pds.example.com&type=1',
      'https://cloudflare-dns.com/dns-query?name=pds.example.com&type=28',
      'https://pds.example.com/xrpc/x',
    ]);

    // .test / .example are admitted only through a Transport marked fixture:true.
    expect(checkUrl('https://alice.test/', { fixture: true }).ok).toBe(true);
    expect(checkUrl('https://pds.example/', { fixture: true }).ok).toBe(true);
    expect(checkUrl('https://x.internal/', { fixture: true })).toEqual({ ok: false, reason: 'reserved_tld' });
    expect(checkUrl('https://[::1]/', { fixture: true })).toEqual({ ok: false, reason: 'ip_literal' });
    expect(() => createSafeFetch({ transport, clock: fixedClock(), fixture: true })).toThrow(TypeError);
    const fixtureTransport = recordingTransport(true);
    const fixtureFetch = createSafeFetch({ transport: fixtureTransport, clock: fixedClock(), fixture: true });
    expect((await fixtureFetch('https://alice.test/', { kind: 'json' })).status).toBe(200);
    expect(fixtureTransport.calls.at(-1)).toBe('https://alice.test/');

    // Address classification used by the DoH pre-check (plan inputs plus IPv6 equivalents).
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect({ ip, cls: classifyAddress(ip) }).toEqual({ ip, cls: 'blocked' });
    }
  });
});
