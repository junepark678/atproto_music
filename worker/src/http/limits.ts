// Rate buckets for notify (ADR 0004 §8, M6.2.1): 60 requests per minute per
// client IP and 600 per hour per DID. They live in memory in the singleton
// IndexDO, are driven only by the injected Clock, and fail open after a DO
// restart (documented in ADR 0004 §8).
//
// A TokenBucket holds `capacity` tokens and refills continuously at
// capacity/window. Credit is kept in integer units (one token = windowMs
// units, refill = capacity units per ms), so refill is exact: with the
// 60/min rule, exactly one token returns every 1,000 ms.
//
// A BucketSet keys buckets by IP or DID and is bounded like
// crates/server/src/http/limits.rs (MAX_KEYS = 10,000): a bucket that has
// refilled to capacity is indistinguishable from a fresh one, so it is
// evicted; when the set is still at its cap after eviction, a new key is
// refused rather than growing the set.

import type { Clock } from '@atmusic/core/deps';

export interface RateRule {
  /** Tokens available at rest, and the number of requests allowed per window. */
  capacity: number;
  /** Time to refill from empty to capacity, in ms. */
  windowMs: number;
}

/** Per client IP (`CF-Connecting-IP`): 60 per minute. */
export const IP_RATE: Readonly<RateRule> = { capacity: 60, windowMs: 60_000 };
/** Per DID: 600 per hour. */
export const DID_RATE: Readonly<RateRule> = { capacity: 600, windowMs: 3_600_000 };
/** Bound on live buckets per set, as Rust `limits::MAX_KEYS`. */
export const MAX_BUCKET_KEYS = 10_000;

export type RateDecision = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

function checkRule(rule: RateRule): void {
  const { capacity, windowMs } = rule;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(capacity * windowMs)
  ) {
    throw new RangeError(`invalid rate rule: capacity=${capacity} windowMs=${windowMs}`);
  }
}

function toRetrySeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export class TokenBucket {
  private credit: number;
  private lastMs: number;
  private readonly max: number;

  constructor(
    readonly rule: Readonly<RateRule>,
    private readonly clock: Clock,
  ) {
    checkRule(rule);
    this.max = rule.capacity * rule.windowMs;
    this.credit = this.max;
    this.lastMs = clock.nowMs();
  }

  private refill(now: number): void {
    // A clock that steps backwards never mints or removes credit.
    if (now <= this.lastMs) return;
    const elapsed = now - this.lastMs;
    // A whole window refills any bucket; this also keeps the product below in range.
    this.credit =
      elapsed >= this.rule.windowMs ? this.max : Math.min(this.max, this.credit + elapsed * this.rule.capacity);
    this.lastMs = now;
  }

  /** Consumes one token if available. */
  take(): RateDecision {
    this.refill(this.clock.nowMs());
    if (this.credit >= this.rule.windowMs) {
      this.credit -= this.rule.windowMs;
      return { allowed: true, remaining: Math.floor(this.credit / this.rule.windowMs) };
    }
    const waitMs = Math.ceil((this.rule.windowMs - this.credit) / this.rule.capacity);
    return { allowed: false, retryAfterSeconds: toRetrySeconds(waitMs) };
  }

  /** Whole tokens available now. */
  tokens(): number {
    this.refill(this.clock.nowMs());
    return Math.floor(this.credit / this.rule.windowMs);
  }

  /** The first instant at which the bucket is back at capacity. */
  fullAtMs(): number {
    return this.lastMs + Math.ceil((this.max - this.credit) / this.rule.capacity);
  }

  /** True when the bucket has refilled to capacity, i.e. it carries no state. */
  isFull(): boolean {
    return this.clock.nowMs() >= this.fullAtMs();
  }
}

export class BucketSet {
  private readonly buckets = new Map<string, TokenBucket>();
  private lastSweepMs: number;

  constructor(
    readonly rule: Readonly<RateRule>,
    private readonly clock: Clock,
    readonly maxKeys: number = MAX_BUCKET_KEYS,
  ) {
    checkRule(rule);
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError(`invalid maxKeys ${maxKeys}`);
    this.lastSweepMs = clock.nowMs();
  }

  /** Live buckets. */
  get size(): number {
    return this.buckets.size;
  }

  has(key: string): boolean {
    return this.buckets.has(key);
  }

  /** Evicts every bucket that has refilled to capacity; returns how many were evicted. */
  sweep(): number {
    const now = this.clock.nowMs();
    let evicted = 0;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.fullAtMs()) {
        this.buckets.delete(key);
        evicted++;
      }
    }
    this.lastSweepMs = now;
    return evicted;
  }

  /** Consumes one token from `key`'s bucket. */
  take(key: string): RateDecision {
    const now = this.clock.nowMs();
    // Any bucket untouched for a whole window is full, so one sweep per window
    // bounds memory to the keys active in the last window (amortised O(1)).
    if (now - this.lastSweepMs >= this.rule.windowMs) this.sweep();

    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      if (this.buckets.size >= this.maxKeys) {
        let soonest = Number.POSITIVE_INFINITY;
        for (const b of this.buckets.values()) soonest = Math.min(soonest, b.fullAtMs());
        return { allowed: false, retryAfterSeconds: toRetrySeconds(soonest - now) };
      }
      bucket = new TokenBucket(this.rule, this.clock);
      this.buckets.set(key, bucket);
    }
    return bucket.take();
  }
}
