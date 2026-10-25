// Credential-first rate limits for /1/ (ADR 0005 §8.7, §13; N2-08).
//
// - Per token: 100 requests per 10 s, in a BucketSet in the default `refuse`
//   mode, so a full set never forgets a token's spent budget.
// - Per IP: 30 requests per 10 s, keyed by `rateKeyOf` (an IPv4 address, or
//   the IPv6 /64), in a BucketSet with `onFull: 'evict-lru'` (N1-06), so a
//   flood of fresh addresses evicts the least recently used bucket instead of
//   locking out every new address.
// - `limit(req, token)`: a request whose token check succeeded is charged to
//   its per-token bucket only and never touches the per-IP set, so it is
//   never refused because of the per-IP set or its own address. A request
//   without a usable credential, and a request whose token check failed, is
//   charged to the per-IP bucket (the token check itself is per-IP limited).
//   This is brainzutils' `get_rate_limit_data`: a valid token gets the
//   per-token limit, everything else the per-IP one.
// - Callers answer a refusal with `refusal()` (429, verbatim body,
//   X-RateLimit-*, Retry-After) before the 401 of a failed token check, as
//   ListenBrainz's `@ratelimit` runs before the view; every other answer gets
//   `headers` (the X-RateLimit-* set of the bucket that was charged).
// - The token bucket key is the caller's stable token id (the `lb_tokens` row
//   id or token hash), never the raw token.
// - Buckets live in memory, driven only by the injected Clock; a restart
//   forgets them (fail-open, as ADR 0004 §8 documents for every limiter).

import type { Clock } from '@atmusic/core/deps';
import { BucketSet, MAX_BUCKET_KEYS, type RateDecision, type RateRule } from '../http/limits';
import { rateKeyOf } from '../node/client-ip';
import { lbTooManyRequests } from './errors';
import { bucketWindow, rateLimitHeaders } from './rate-headers';

/** ADR 0005 §8.7: per IP, 30 requests per 10 s. */
export const LB_IP_RATE: Readonly<RateRule> = { capacity: 30, windowMs: 10_000 };
/** ADR 0005 §8.7: per token, 100 requests per 10 s. */
export const LB_TOKEN_RATE: Readonly<RateRule> = { capacity: 100, windowMs: 10_000 };

/** The outcome of the caller's token check for this request. */
export type TokenResult =
  /** No usable credential: no header, a malformed one, or one we never look up. */
  | { status: 'absent' }
  /** The token was looked up and is not a live token. */
  | { status: 'invalid' }
  /** A live token; `tokenId` is its stable id, never the raw token. */
  | { status: 'valid'; tokenId: string };

/** What the limiter reads from a request: the trusted client address (resolveClientIp). */
export interface LimitRequest {
  readonly clientIp: string;
}

export type LimitScope = 'token' | 'ip';

export interface LimitDecision {
  allowed: boolean;
  /** The bucket set that was charged. */
  scope: LimitScope;
  /** The X-RateLimit-* set to send on the answer. */
  headers: Record<string, string>;
  /** Present when refused: seconds until the bucket admits a request again. */
  retryAfterSeconds?: number;
}

export interface LimiterOptions {
  ipRule?: Readonly<RateRule>;
  tokenRule?: Readonly<RateRule>;
  /** Bound on each set's buckets; MAX_BUCKET_KEYS by default. */
  maxKeys?: number;
}

export class ListenBrainzLimiter {
  readonly perIp: BucketSet;
  readonly perToken: BucketSet;
  readonly ipRule: Readonly<RateRule>;
  readonly tokenRule: Readonly<RateRule>;

  constructor(
    private readonly clock: Clock,
    options: LimiterOptions = {},
  ) {
    this.ipRule = options.ipRule ?? LB_IP_RATE;
    this.tokenRule = options.tokenRule ?? LB_TOKEN_RATE;
    const maxKeys = options.maxKeys ?? MAX_BUCKET_KEYS;
    this.perIp = new BucketSet(this.ipRule, clock, { maxKeys, onFull: 'evict-lru' });
    this.perToken = new BucketSet(this.tokenRule, clock, { maxKeys, onFull: 'refuse' });
  }

  /** Charges one request (module comment). */
  limit(req: LimitRequest, token: TokenResult): LimitDecision {
    if (token.status === 'valid') {
      if (token.tokenId === '') throw new RangeError('a valid token needs a non-empty tokenId');
      return this.decide('token', this.tokenRule, this.perToken.take(`token:${token.tokenId}`));
    }
    return this.decide('ip', this.ipRule, this.perIp.take(rateKeyOf(req.clientIp)));
  }

  private decide(scope: LimitScope, rule: Readonly<RateRule>, decision: RateDecision): LimitDecision {
    const headers = rateLimitHeaders(bucketWindow(rule, decision), this.clock.nowMs());
    if (decision.allowed) return { allowed: true, scope, headers };
    return { allowed: false, scope, headers, retryAfterSeconds: decision.retryAfterSeconds };
  }
}

/** The 429 for a refused decision. */
export function refusal(decision: LimitDecision): Response {
  if (decision.allowed || decision.retryAfterSeconds === undefined) {
    throw new Error('refusal() needs a refused decision');
  }
  return lbTooManyRequests(decision.headers, decision.retryAfterSeconds);
}
