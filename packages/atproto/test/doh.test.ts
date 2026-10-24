// DoH A/AAAA pre-check (ADR 0004 §8, A5). Also proves the DNS half of
// M2.1.2/redirect_rebinding: a host that resolves privately — at once, or on
// a later lookup after the cache expires — is refused and never contacted.
import { DOH_HOST, resolvePublic } from '@atmusic/atproto/net/doh';
import { createSafeFetch, SafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import type { Transport } from '@atmusic/atproto/transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';

interface Zone {
  A?: string[];
  AAAA?: string[];
  ttl?: number;
  status?: number;
}

/** A fake DoH resolver plus target hosts; records every request (URL and accept header). */
function fakeNet(zones: Record<string, Zone>) {
  const doh: Array<{ name: string; type: number; accept: string | null }> = [];
  const hits: string[] = [];
  const transport: Transport = async (req) => {
    const url = new URL(req.url);
    if (url.hostname === DOH_HOST) {
      const name = url.searchParams.get('name') ?? '';
      const type = Number(url.searchParams.get('type'));
      doh.push({ name, type, accept: req.headers.get('accept') });
      const zone = zones[name];
      if (!zone) return Response.json({ Status: 3 });
      const data = type === 1 ? (zone.A ?? []) : (zone.AAAA ?? []);
      return Response.json({
        Status: zone.status ?? 0,
        Answer: data.map((d) => ({ name, type, TTL: zone.ttl ?? 300, data: d })),
      });
    }
    hits.push(req.url);
    return Response.json({ host: url.hostname });
  };
  return { transport, doh, hits };
}

async function failure(p: Promise<unknown>): Promise<SafeFetchError> {
  const result = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(result).toBeInstanceOf(SafeFetchError);
  return result as SafeFetchError;
}

describe('DoH pre-check', () => {
  it('mixed public+private answer set is rejected', async () => {
    const zones: Record<string, Zone> = {
      'public.example.com': { A: ['93.184.215.14'], AAAA: ['2606:4700::6810:84e5'] },
      'mixed-v4.example.com': { A: ['93.184.215.14', '10.0.0.5'] },
      'mixed-v6.example.com': { A: ['93.184.215.14'], AAAA: ['2606:4700::1', 'fd12:3456::1'] },
      'mapped.example.com': { A: ['93.184.215.14'], AAAA: ['::ffff:127.0.0.1'] },
      'loopback.example.com': { A: ['127.0.0.1'] },
      'v6loop.example.com': { AAAA: ['::1'] },
      'metadata.example.com': { A: ['169.254.169.254'] },
      'linklocal6.example.com': { AAAA: ['fe80::1'] },
      'cgnat.example.com': { A: ['93.184.215.14', '100.64.0.1'] },
      'rfc1918b.example.com': { A: ['172.16.5.4'] },
      'rfc1918c.example.com': { A: ['192.168.1.1'] },
      'zero.example.com': { A: ['0.0.0.0'] },
      'mcast.example.com': { A: ['224.0.0.251'] },
      'mcast6.example.com': { AAAA: ['ff02::fb'] },
      'reserved.example.com': { A: ['240.0.0.1'] },
      'bench.example.com': { A: ['198.18.0.1'] },
      'doc.example.com': { A: ['192.0.2.10'] },
      'doc6.example.com': { AAAA: ['2001:db8::1'] },
      'nat64.example.com': { AAAA: ['64:ff9b::a00:1'] },
      'garbage.example.com': { A: ['93.184.215.14', 'not-an-ip'] },
    };
    const net = fakeNet(zones);
    const clock = fixedClock();

    expect(await resolvePublic('public.example.com', net.transport, clock)).toEqual([
      '93.184.215.14',
      '2606:4700::6810:84e5',
    ]);
    // Both record types are asked for, with the dns-json accept header.
    expect(net.doh).toEqual([
      { name: 'public.example.com', type: 1, accept: 'application/dns-json' },
      { name: 'public.example.com', type: 28, accept: 'application/dns-json' },
    ]);

    for (const host of Object.keys(zones).filter((h) => h !== 'public.example.com')) {
      const error = await failure(resolvePublic(host, net.transport, clock));
      expect({ host, code: error.code, reason: error.reason }).toEqual({
        host,
        code: 'blocked_destination',
        reason: 'private_answer',
      });
    }

    // Through SafeFetch the target is never contacted for a mixed answer set.
    const safeFetch = createSafeFetch({ transport: net.transport, clock });
    const blocked = await failure(safeFetch('https://mixed-v4.example.com/xrpc/x', { kind: 'json' }));
    expect(blocked.code).toBe('blocked_destination');
    expect(net.hits).toEqual([]);

    // Rebinding on a later lookup: public first (and fetched), private after the cache expires.
    const zone: Zone = { A: ['93.184.215.14'], ttl: 30 };
    const rebind = fakeNet({ 'rebind.example.com': zone });
    const rebindFetch = createSafeFetch({ transport: rebind.transport, clock });
    expect((await rebindFetch('https://rebind.example.com/a', { kind: 'json' })).status).toBe(200);
    zone.A = ['93.184.215.14', '127.0.0.1'];
    clock.advance(30_000);
    const second = await failure(rebindFetch('https://rebind.example.com/b', { kind: 'json' }));
    expect(second.code).toBe('blocked_destination');
    expect(rebind.hits).toEqual(['https://rebind.example.com/a']);
    expect(rebind.doh).toHaveLength(4);
  });

  it('empty answer is rejected; TTL cache honors injected clock', async () => {
    const zones: Record<string, Zone> = {
      'empty.example.com': {},
      'short.example.com': { A: ['93.184.215.14'], ttl: 60 },
      'long.example.com': { AAAA: ['2606:4700::1'], ttl: 86_400 },
      'servfail.example.com': { status: 2 },
    };
    const net = fakeNet(zones);
    const clock = fixedClock();

    // NOERROR with no answers, and NXDOMAIN, are both refused (and not cached).
    for (const host of ['empty.example.com', 'missing.example.com']) {
      const error = await failure(resolvePublic(host, net.transport, clock));
      expect({ host, code: error.code, reason: error.reason }).toEqual({
        host,
        code: 'blocked_destination',
        reason: 'no_answers',
      });
    }
    expect(net.doh).toHaveLength(4);
    await failure(resolvePublic('empty.example.com', net.transport, clock));
    expect(net.doh).toHaveLength(6);
    const servfail = await failure(resolvePublic('servfail.example.com', net.transport, clock));
    expect(servfail.code).toBe('dns_failed');
    expect(servfail.reason).toBe('rcode_2');

    // TTL 60 s: reused until 59.999 s, refreshed at 60 s.
    net.doh.length = 0;
    await resolvePublic('short.example.com', net.transport, clock);
    expect(net.doh).toHaveLength(2);
    clock.advance(59_999);
    expect(await resolvePublic('SHORT.example.com', net.transport, clock)).toEqual(['93.184.215.14']);
    expect(net.doh).toHaveLength(2);
    clock.advance(1);
    await resolvePublic('short.example.com', net.transport, clock);
    expect(net.doh).toHaveLength(4);

    // TTL 86400 s is capped at 300 s.
    net.doh.length = 0;
    await resolvePublic('long.example.com', net.transport, clock);
    clock.advance(299_999);
    await resolvePublic('long.example.com', net.transport, clock);
    expect(net.doh).toHaveLength(2);
    clock.advance(1);
    await resolvePublic('long.example.com', net.transport, clock);
    expect(net.doh).toHaveLength(4);

    // Caches are per Transport: a second fixture network does not see the first's answers.
    const other = fakeNet(zones);
    await resolvePublic('long.example.com', other.transport, clock);
    expect(other.doh).toHaveLength(2);

    // The pinned DoH host is exempt: fetching it triggers no pre-check of itself.
    const safeFetch = createSafeFetch({ transport: net.transport, clock });
    net.doh.length = 0;
    const res = await safeFetch(`https://${DOH_HOST}/dns-query?name=short.example.com&type=1`, { kind: 'json' });
    expect(res.status).toBe(200);
    expect(net.doh).toEqual([{ name: 'short.example.com', type: 1, accept: 'application/json' }]);
  });

  it('DoH body reset or oversized body is dns_failed and the target is never contacted', async () => {
    const hits: string[] = [];
    const dohNames: string[] = [];
    const transport: Transport = async (req) => {
      const url = new URL(req.url);
      if (url.hostname !== DOH_HOST) {
        hits.push(req.url);
        return Response.json({ ok: true });
      }
      const name = url.searchParams.get('name') ?? '';
      dohNames.push(name);
      if (name === 'reset.example.com') {
        // 10 bytes of JSON, then the connection resets mid-body.
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"Status":0'));
              else controller.error(new TypeError('connection reset'));
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, { headers: { 'content-type': 'application/dns-json' } });
      }
      if (name === 'huge.example.com') {
        // A syntactically valid dns-json body padded past the 64 KiB DoH cap.
        return Response.json({ Status: 0, Answer: [], pad: 'x'.repeat(70_000) });
      }
      if (name === 'stall.example.com') {
        return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }));
      }
      return Response.json({ Status: 0, Answer: [{ name, type: 1, TTL: 300, data: '93.184.215.14' }] });
    };
    const clock = fixedClock();

    for (const [host, reason] of [
      ['reset.example.com', 'doh_body'],
      ['huge.example.com', 'doh_body_too_large'],
    ] as const) {
      const direct = await failure(resolvePublic(host, transport, clock));
      expect({ host, code: direct.code, reason: direct.reason }).toEqual({ host, code: 'dns_failed', reason });

      // Through SafeFetch the DoH failure is not mistaken for a target-body failure.
      const safeFetch = createSafeFetch({ transport, clock });
      const viaFetch = await failure(safeFetch(`https://${host}/xrpc/x`, { kind: 'json' }));
      expect({ host, code: viaFetch.code, reason: viaFetch.reason, maxBytes: viaFetch.maxBytes }).toEqual({
        host,
        code: 'dns_failed',
        reason,
        maxBytes: null,
      });
    }
    // Failed lookups are not cached: each attempt asked A and AAAA again.
    expect(dohNames).toEqual([
      'reset.example.com',
      'reset.example.com',
      'reset.example.com',
      'reset.example.com',
      'huge.example.com',
      'huge.example.com',
      'huge.example.com',
      'huge.example.com',
    ]);

    // The deadline keeps its own code while the DoH body is being read.
    const deadline = new AbortController();
    const stalled = resolvePublic('stall.example.com', transport, clock, { signal: deadline.signal });
    await new Promise((r) => setTimeout(r, 0));
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    const timeout = await failure(stalled);
    expect({ code: timeout.code, reason: timeout.reason }).toEqual({ code: 'timeout', reason: 'deadline' });

    expect(hits).toEqual([]);
  });
});
