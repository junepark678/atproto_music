// Credential-first /1/ rate limits (ADR 0005 §8.7, §13; N2-08): a valid token
// is charged only to its own bucket, everything else to the per-IP bucket of
// its rateKeyOf key, and a full per-IP set evicts its least recently used key.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { MAX_BUCKET_KEYS } from '../../../src/http/limits';
import { LB_IP_RATE, LB_TOKEN_RATE, ListenBrainzLimiter, refusal } from '../../../src/listenbrainz/limiter';
import { rateKeyOf } from '../../../src/node/client-ip';

const VALID = { status: 'valid', tokenId: 'tok-1' } as const;

/** The n-th IPv4 address of 10.0.0.0/8. */
function v4(n: number): string {
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

describe('ListenBrainz limiter', () => {
  it('with the per-IP set full of 10,000 other keys, a valid token holder is limited only by its per-token bucket and gets no 429, while an unauthenticated request from a new address is admitted by evicting the least recently used IP bucket', () => {
    const clock = fixedClock();
    const limiter = new ListenBrainzLimiter(clock);
    expect(LB_IP_RATE).toEqual({ capacity: 30, windowMs: 10_000 });
    expect(LB_TOKEN_RATE).toEqual({ capacity: 100, windowMs: 10_000 });

    // Fill the per-IP set with 10,000 other addresses (each one request, so no bucket is full again yet).
    for (let i = 0; i < MAX_BUCKET_KEYS; i++) {
      expect(limiter.limit({ clientIp: v4(i) }, { status: 'absent' }).allowed).toBe(true);
    }
    expect(limiter.perIp.size).toBe(MAX_BUCKET_KEYS);
    expect(limiter.perIp.has(v4(0))).toBe(true);

    // The token holder, from an address that is not in the set: 100 requests pass, counting down.
    const holder = { clientIp: '192.0.2.77' };
    const decisions = Array.from({ length: 100 }, () => limiter.limit(holder, VALID));
    expect(decisions.every((d) => d.allowed && d.scope === 'token')).toBe(true);
    expect(decisions.map((d) => Number(d.headers['X-RateLimit-Remaining']))).toEqual(
      Array.from({ length: 100 }, (_, i) => 99 - i),
    );
    expect(decisions[0]!.headers['X-RateLimit-Limit']).toBe('100');
    // Its own bucket, not the per-IP set, decides the 101st.
    const over = limiter.limit(holder, VALID);
    expect(over.allowed).toBe(false);
    expect(over.scope).toBe('token');
    expect(over.retryAfterSeconds).toBe(1);
    expect(refusal(over).status).toBe(429);
    // The per-IP set is untouched: same size, the holder's address never entered it, the LRU key is still there.
    expect(limiter.perIp.size).toBe(MAX_BUCKET_KEYS);
    expect(limiter.perIp.has('192.0.2.77')).toBe(false);
    expect(limiter.perIp.has(v4(0))).toBe(true);
    // A second token is not affected by the first one's exhaustion.
    expect(limiter.limit(holder, { status: 'valid', tokenId: 'tok-2' }).allowed).toBe(true);

    // An unauthenticated request from a new address is admitted; the least recently used bucket goes.
    const newcomer = limiter.limit({ clientIp: '198.51.100.200' }, { status: 'absent' });
    expect(newcomer.allowed).toBe(true);
    expect(newcomer.scope).toBe('ip');
    expect(newcomer.headers['X-RateLimit-Limit']).toBe('30');
    expect(newcomer.headers['X-RateLimit-Remaining']).toBe('29');
    expect(limiter.perIp.size).toBe(MAX_BUCKET_KEYS);
    expect(limiter.perIp.has('198.51.100.200')).toBe(true);
    expect(limiter.perIp.has(v4(0))).toBe(false);
    expect(limiter.perIp.has(v4(1))).toBe(true);

    // A failed token check is charged per IP like an unauthenticated request (and also evicts the next LRU key).
    const failed = limiter.limit({ clientIp: '198.51.100.201' }, { status: 'invalid' });
    expect(failed).toMatchObject({ allowed: true, scope: 'ip' });
    expect(limiter.perIp.has('198.51.100.201')).toBe(true);
    expect(limiter.perIp.has(v4(1))).toBe(false);

    // After the window the token bucket is full again.
    clock.advance(10_000);
    expect(limiter.limit(holder, VALID).allowed).toBe(true);
  });

  it('requests with a valid token never touch the per-IP bucket, and 31 unauthenticated requests in 10 s from one /64 get 429 with the X-RateLimit headers', async () => {
    const clock = fixedClock();
    const nowS = clock.nowMs() / 1000;
    const limiter = new ListenBrainzLimiter(clock);
    const prefix = '2001:db8:aa:bb';

    // 50 authenticated requests from inside the /64: no per-IP bucket appears.
    for (let i = 0; i < 50; i++) {
      const d = limiter.limit({ clientIp: `${prefix}:${i.toString(16)}::1` }, VALID);
      expect(d).toMatchObject({ allowed: true, scope: 'token' });
    }
    expect(limiter.perIp.size).toBe(0);
    expect(limiter.perToken.size).toBe(1);

    // 31 unauthenticated requests from 31 different addresses of the same /64, all in the same instant.
    const addresses = Array.from(
      { length: 31 },
      (_, i) => `${prefix}:${(i * 7).toString(16)}:${i.toString(16)}:0:${(i + 1).toString(16)}`,
    );
    expect(new Set(addresses.map(rateKeyOf))).toEqual(new Set(['2001:db8:aa:bb::/64']));
    const decisions = addresses.map((clientIp) => limiter.limit({ clientIp }, { status: 'absent' }));
    expect(decisions.slice(0, 30).every((d) => d.allowed && d.scope === 'ip')).toBe(true);
    expect(decisions.slice(0, 30).map((d) => Number(d.headers['X-RateLimit-Remaining']))).toEqual(
      Array.from({ length: 30 }, (_, i) => 29 - i),
    );
    const last = decisions[30]!;
    expect(last.allowed).toBe(false);
    expect(last.scope).toBe('ip');
    expect(limiter.perIp.size).toBe(1);

    const res = refusal(last);
    expect(res.status).toBe(429);
    expect(JSON.parse(await res.text())).toEqual({
      code: 429,
      error:
        'You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit.',
    });
    expect(res.headers.get('x-ratelimit-limit')).toBe('30');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res.headers.get('x-ratelimit-reset-in')).toBe('10');
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(nowS + 10));
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In',
    );
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    // The token holder in the same /64 is still admitted, and the per-IP bucket count stays one.
    expect(limiter.limit({ clientIp: `${prefix}::5` }, VALID).allowed).toBe(true);
    expect(limiter.perIp.size).toBe(1);
    // Another /64 has its own bucket.
    expect(limiter.limit({ clientIp: '2001:db8:aa:bc::1' }, { status: 'absent' }).allowed).toBe(true);
    // One token refills after 10,000 / 30 ms: the /64 gets exactly one more request.
    clock.advance(334);
    expect(limiter.limit({ clientIp: `${prefix}::9` }, { status: 'absent' }).allowed).toBe(true);
    expect(limiter.limit({ clientIp: `${prefix}::9` }, { status: 'absent' }).allowed).toBe(false);
    expect(() => refusal(limiter.limit({ clientIp: '192.0.2.1' }, { status: 'absent' }))).toThrow();
  });
});
