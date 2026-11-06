// ListenBrainz-shaped error bodies, the rate-limit 429 and CORS on /1/
// (ADR 0005 §8.1, §8.7; N2-08).

import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { BucketSet } from '../../../src/http/limits';
import {
  LB_CORS_HEADERS,
  LB_RATE_LIMITED_MESSAGE,
  lbError,
  lbJson,
  lbPreflight,
  lbTooManyRequests,
  withLbCors,
} from '../../../src/listenbrainz/errors';
import { bucketWindow, RATE_LIMIT_EXPOSE_HEADERS, rateLimitHeaders } from '../../../src/listenbrainz/rate-headers';
import { LISTENBRAINZ_CORS_HEADERS } from '../../../src/node/http-bridge';

function expectCors(res: Response): void {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
  expect(res.headers.get('access-control-max-age')).toBe('21600');
  expect(res.headers.has('set-cookie')).toBe(false);
}

describe('ListenBrainz responses', () => {
  it('429 carries the verbatim body, X-RateLimit-Limit/Remaining/Reset/Reset-In and Access-Control-Expose-Headers; OPTIONS answers 200 with the CORS set', async () => {
    const clock = fixedClock();
    const nowS = clock.nowMs() / 1000;
    const rule = { capacity: 30, windowMs: 10_000 };
    const set = new BucketSet(rule, clock, { onFull: 'evict-lru' });
    for (let i = 0; i < 30; i++) expect(set.take('203.0.113.9').allowed).toBe(true);
    const refused = set.take('203.0.113.9');
    if (refused.allowed) throw new Error('expected the 31st request to be refused');
    expect(refused.retryAfterSeconds).toBe(1);

    const window = bucketWindow(rule, refused);
    expect(window).toEqual({ limit: 30, remaining: 0, resetInSeconds: 10 });
    const res = lbTooManyRequests(rateLimitHeaders(window, clock.nowMs()), refused.retryAfterSeconds);

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(await res.text())).toEqual({
      code: 429,
      error:
        'You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit.',
    });
    expect(LB_RATE_LIMITED_MESSAGE).toBe(
      'You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit.',
    );
    expect(res.headers.get('x-ratelimit-limit')).toBe('30');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res.headers.get('x-ratelimit-reset-in')).toBe('10');
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(nowS + 10));
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In',
    );
    expect(RATE_LIMIT_EXPOSE_HEADERS).toBe(res.headers.get('access-control-expose-headers'));
    expectCors(res);

    // An allowed request reports what is left and when the bucket is full again.
    const fresh = new BucketSet(rule, clock);
    const first = fresh.take('198.51.100.1');
    expect(rateLimitHeaders(bucketWindow(rule, first), clock.nowMs())).toEqual({
      'Access-Control-Expose-Headers': 'X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In',
      'X-RateLimit-Remaining': '29',
      'X-RateLimit-Limit': '30',
      'X-RateLimit-Reset': String(nowS + 1),
      'X-RateLimit-Reset-In': '1',
    });
    // After waiting Reset-In seconds the bucket is full again: 30 requests pass.
    clock.advance(1000);
    for (let i = 0; i < 30; i++) expect(fresh.take('198.51.100.1').allowed).toBe(true);

    // OPTIONS: 200, empty body, the CORS set; methods when the route gives them.
    const pre = lbPreflight();
    expect(pre.status).toBe(200);
    expect(await pre.text()).toBe('');
    expectCors(pre);
    const routed = lbPreflight(['post']);
    expect(routed.status).toBe(200);
    expect(routed.headers.get('access-control-allow-methods')).toBe('OPTIONS, POST');
    expect(routed.headers.get('allow')).toBe('OPTIONS, POST');
    expectCors(routed);

    // Errors and successes share the CORS set; the bridge's over-cap answers use the same values.
    expect(LB_CORS_HEADERS).toEqual(LISTENBRAINZ_CORS_HEADERS);
    const bad = lbError(400, 'Invalid JSON document submitted.');
    expect(bad.status).toBe(400);
    expect(JSON.parse(await bad.text())).toEqual({ code: 400, error: 'Invalid JSON document submitted.' });
    expectCors(bad);
    const ok = lbJson({ status: 'ok' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(await ok.text())).toEqual({ status: 'ok' });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expectCors(ok);
    const wrapped = withLbCors(
      new Response('{"payload":{}}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(await wrapped.text()).toBe('{"payload":{}}');
    expectCors(wrapped);
    expect(() => lbError(200, 'x')).toThrow(RangeError);
  });
});
