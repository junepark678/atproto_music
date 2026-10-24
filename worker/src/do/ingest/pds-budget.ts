// Per-PDS-host politeness and the per-slice subrequest budget (ADR 0004 §5.4
// "Budget per alarm", "Errors"; §11 Free-plan limits).
//
// - Host backoff (`host_backoff(host, until_ms)`, durable): a 429, a 5xx or a
//   timeout from a PDS pauses every proof fetch to that host until `until_ms`.
//   The pause honours `Retry-After` (delta-seconds or HTTP-date) and
//   `RateLimit-Reset` (epoch or delta seconds), both already parsed by SafeFetch
//   against the injected clock; the longer of the two wins. Without either
//   header a 429 pauses DEFAULT_RATE_LIMIT_PAUSE_MS and a 5xx / timeout
//   DEFAULT_ERROR_PAUSE_MS. Every pause is capped at MAX_HOST_PAUSE_MS so a
//   hostile header cannot park a host for days. A later pause only extends,
//   never shortens, the stored one. Other hosts are unaffected.
// - Concurrency (`FetchLimiter`, in memory, per IndexDO instance): at most
//   `concurrentFetches` proof fetches at once (4) and `perHostConcurrency` per
//   PDS host (2). Waiters are served FIFO. It holds no durable state, so an
//   eviction simply starts empty.
// - Subrequest budget (`SubrequestMeter`): an alarm slice may start outbound
//   work only while its reserved upper bound fits the plan's
//   `subrequestsPerSlice` (Paid 200, Free 40 — under the Free plan's 50
//   subrequests per invocation). Costs are reserved before the work starts and
//   never refunded, so the slice can never exceed the budget.

import type { SafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import type { Db } from '../db';

export const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000;
export const DEFAULT_ERROR_PAUSE_MS = 5_000;
export const MAX_HOST_PAUSE_MS = 3_600_000;

/**
 * Upper bounds of the subrequests one step may make (each SafeFetch is the
 * request plus, for a host not in the DoH cache, an A and an AAAA lookup):
 * - a proof fetch: getRecord + 2 DoH;
 * - an identity resolution: the DID document (+2 DoH) and handle verification
 *   (DoH TXT, then possibly /.well-known/atproto-did +2 DoH).
 */
export const PROOF_FETCH_COST = 3;
export const IDENTITY_RESOLVE_COST = 7;

/** Lowercased hostname of a PDS origin. */
export function hostOf(pds: string): string {
  return new URL(pds).hostname.toLowerCase();
}

/** When `host` is paused past `now`, the instant it resumes; otherwise null. */
export function hostPausedUntil(db: Db, host: string, now: number): number | null {
  const row = db.one<{ until_ms: number }>('SELECT until_ms FROM host_backoff WHERE host = ?', host);
  return row !== null && row.until_ms > now ? row.until_ms : null;
}

/** The pause a failed fetch asks for, in ms from now; null when it is not a host-level failure. */
export function pauseFor(error: SafeFetchError): number | null {
  const transient =
    error.code === 'timeout' ||
    error.code === 'network_error' ||
    (error.code === 'http_status' && error.status !== null && (error.status === 429 || error.status >= 500));
  if (!transient) return null;
  const hinted = Math.max(error.retryAfterMs ?? -1, error.rateLimitResetMs ?? -1);
  const fallback = error.status === 429 ? DEFAULT_RATE_LIMIT_PAUSE_MS : DEFAULT_ERROR_PAUSE_MS;
  const pause = hinted >= 0 ? hinted : fallback;
  return Math.min(pause, MAX_HOST_PAUSE_MS);
}

/** Pause `host` until `now + pauseMs` (extending, never shortening, a stored pause). Returns `until_ms`. */
export function pauseHost(db: Db, host: string, now: number, pauseMs: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be epoch ms');
  const until = now + Math.max(0, Math.min(Math.floor(pauseMs), MAX_HOST_PAUSE_MS));
  const row = db.one<{ until_ms: number }>(
    `INSERT INTO host_backoff(host, until_ms) VALUES (?, ?)
     ON CONFLICT(host) DO UPDATE SET until_ms = max(host_backoff.until_ms, excluded.until_ms)
     RETURNING until_ms`,
    host,
    until,
  );
  return row?.until_ms ?? until;
}

/** Drop expired pauses (gc, or after a successful fetch). */
export function clearExpiredHostPauses(db: Db, now: number, host?: string): number {
  return host === undefined
    ? db.all('DELETE FROM host_backoff WHERE until_ms <= ? RETURNING host', now).length
    : db.all('DELETE FROM host_backoff WHERE host = ? AND until_ms <= ? RETURNING host', host, now).length;
}

// ---------------------------------------------------------------------------
// In-memory concurrency

export interface FetchLimits {
  concurrentFetches: number;
  perHostConcurrency: number;
}

/** FIFO limiter: a global cap plus a per-host cap on concurrent fetches. */
export class FetchLimiter {
  private active = 0;
  private readonly perHost = new Map<string, number>();
  private readonly waiters: Array<{ host: string; wake: () => void }> = [];
  /** The highest concurrency ever observed, globally and per host (for tests and admin). */
  peak = 0;
  readonly peakPerHost = new Map<string, number>();

  constructor(readonly limits: FetchLimits) {
    if (!(limits.concurrentFetches >= 1) || !(limits.perHostConcurrency >= 1)) {
      throw new RangeError('fetch limits must be at least 1');
    }
  }

  private fits(host: string): boolean {
    return (
      this.active < this.limits.concurrentFetches && (this.perHost.get(host) ?? 0) < this.limits.perHostConcurrency
    );
  }

  private enter(host: string): () => void {
    this.active++;
    const n = (this.perHost.get(host) ?? 0) + 1;
    this.perHost.set(host, n);
    this.peak = Math.max(this.peak, this.active);
    this.peakPerHost.set(host, Math.max(this.peakPerHost.get(host) ?? 0, n));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.perHost.get(host) ?? 1) - 1;
      if (left === 0) this.perHost.delete(host);
      else this.perHost.set(host, left);
      this.pump();
    };
  }

  private pump(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i]!;
      if (this.fits(w.host)) {
        this.waiters.splice(i, 1);
        w.wake();
      } else {
        i++;
      }
    }
  }

  /** Resolves with a release function once a slot for `host` is free. */
  acquire(host: string): Promise<() => void> {
    if (this.fits(host) && this.waiters.length === 0) return Promise.resolve(this.enter(host));
    return new Promise((resolve) => {
      this.waiters.push({ host, wake: () => resolve(this.enter(host)) });
      this.pump();
    });
  }

  get inFlight(): number {
    return this.active;
  }
}

/** The per-slice subrequest budget: reserve before work starts; never refunded. */
export class SubrequestMeter {
  private spent = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('subrequest limit must be an integer >= 0');
  }

  /** Reserve `n`; false (and nothing reserved) when it would exceed the limit. */
  tryReserve(n: number): boolean {
    if (this.spent + n > this.limit) return false;
    this.spent += n;
    return true;
  }

  get reserved(): number {
    return this.spent;
  }

  get remaining(): number {
    return this.limit - this.spent;
  }
}
