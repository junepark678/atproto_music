// Upstream request pacing for Last.fm and ListenBrainz (ADR 0005 §11.3,
// §12.3; N3-08). One instance per process, shared by forwarding (N3-08) and
// imports (N3-09).
//
// - **Last.fm: one global bucket of 1 request per second** for all Last.fm
//   traffic of the owner's API key, whichever feature sends it. Forwarding
//   goes first: while the forwarder reports due Last.fm work it could not
//   send yet (`setForwardBacklog(true)`), the import lane never takes the
//   token, so an import never delays a live scrobble by more than the one
//   request already in flight.
// - **ListenBrainz: one request per second per key** (the forwarder uses
//   `link:<id>`, imports their own key), and a key whose last answer said
//   `X-RateLimit-Remaining: 0` (or was a 429) waits `X-RateLimit-Reset-In`
//   seconds (`observeListenbrainz`).
//
// The pacer never sleeps: `try*` takes a token when one is free and
// otherwise returns false; `*AvailableAt` says when the caller may try again,
// so a timer can be scheduled for that instant. The pacer reads the injected
// clock itself: a token is taken at the later of the caller's `now` and the
// clock's current time, so a caller holding a stale timestamp (a timer tick
// whose lane awaited other work first) can never send two requests less than
// the interval apart. Tests step the injected clock. State is in memory only:
// after a restart the buckets start full, which at worst sends one request
// early.

import type { Clock } from '@atmusic/core/deps';

/** At most one Last.fm request per this many ms, server-wide (ADR §11.3). */
export const LASTFM_MIN_INTERVAL_MS = 1_000;
/** At most one ListenBrainz request per this many ms per key (ADR §11.3, §12.3). */
export const LISTENBRAINZ_MIN_INTERVAL_MS = 1_000;
/** The longest X-RateLimit-Reset-In honoured (a larger value is clamped): one hour. */
export const MAX_RESET_IN_MS = 3_600_000;

export type LastfmLane = 'forward' | 'import';

/** What a ListenBrainz answer said about the caller's window. */
export interface ListenbrainzRateObservation {
  /** X-RateLimit-Remaining, when the header was a non-negative integer. */
  remaining: number | null;
  /** X-RateLimit-Reset-In in seconds, when the header was a non-negative integer. */
  resetInS: number | null;
}

/** Parses the X-RateLimit-Remaining / -Reset-In headers of a ListenBrainz answer. */
export function listenbrainzRateOf(headers: Headers): ListenbrainzRateObservation {
  const int = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || !/^\s*\d{1,10}\s*$/.test(raw)) return null;
    return Number(raw.trim());
  };
  return { remaining: int('x-ratelimit-remaining'), resetInS: int('x-ratelimit-reset-in') };
}

export class UpstreamPacing {
  private lastfmNextMs = Number.NEGATIVE_INFINITY;
  private forwardBacklog = false;
  private readonly lbNextMs = new Map<string, number>();

  private readonly clock: Clock;

  /** `clock` is the process's injected clock; tokens are never taken before its current time. */
  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** The instant a token is taken at: never earlier than the clock says it is. */
  private instant(now: number): number {
    return Math.max(now, this.clock.nowMs());
  }

  // -- Last.fm ---------------------------------------------------------------

  /** When `lane` may next send a Last.fm request (≤ now: it may send now). */
  lastfmAvailableAt(lane: LastfmLane, now: number): number {
    if (lane === 'import' && this.forwardBacklog) return Math.max(now, this.lastfmNextMs) + LASTFM_MIN_INTERVAL_MS;
    return this.lastfmNextMs;
  }

  /**
   * Takes the global Last.fm token for one request at `now` (or the clock's
   * current time, when later); false when it is not free for `lane`.
   */
  tryLastfm(lane: LastfmLane, now: number): boolean {
    if (lane === 'import' && this.forwardBacklog) return false;
    const at = this.instant(now);
    if (at < this.lastfmNextMs) return false;
    this.lastfmNextMs = at + LASTFM_MIN_INTERVAL_MS;
    return true;
  }

  /** Holds every Last.fm request until `untilMs` (an upstream rate limit). */
  deferLastfm(untilMs: number): void {
    if (untilMs > this.lastfmNextMs) this.lastfmNextMs = untilMs;
  }

  /** The forwarder reports whether it has due Last.fm work left; imports yield while it does. */
  setForwardBacklog(pending: boolean): void {
    this.forwardBacklog = pending;
  }

  get hasForwardBacklog(): boolean {
    return this.forwardBacklog;
  }

  // -- ListenBrainz ----------------------------------------------------------

  /** When `key` may next send a ListenBrainz request. */
  listenbrainzAvailableAt(key: string): number {
    return this.lbNextMs.get(key) ?? Number.NEGATIVE_INFINITY;
  }

  /** Takes `key`'s ListenBrainz token at `now` (or the clock's current time, when later); false when it is not free. */
  tryListenbrainz(key: string, now: number): boolean {
    const at = this.instant(now);
    if (at < this.listenbrainzAvailableAt(key)) return false;
    this.lbNextMs.set(key, at + LISTENBRAINZ_MIN_INTERVAL_MS);
    return true;
  }

  /** Holds `key` until `untilMs`. */
  deferListenbrainz(key: string, untilMs: number): void {
    if (untilMs > this.listenbrainzAvailableAt(key)) this.lbNextMs.set(key, untilMs);
  }

  /**
   * Applies a ListenBrainz answer's rate-limit headers to `key`: with
   * `remaining` 0 (or `exhausted`, for a 429) the key waits Reset-In seconds.
   * Returns the instant the key is held until (or null when not held).
   */
  observeListenbrainz(key: string, now: number, rate: ListenbrainzRateObservation, exhausted = false): number | null {
    if (!exhausted && rate.remaining !== 0) return null;
    const waitMs = Math.min(MAX_RESET_IN_MS, Math.max(LISTENBRAINZ_MIN_INTERVAL_MS, (rate.resetInS ?? 1) * 1000));
    const until = this.instant(now) + waitMs;
    this.deferListenbrainz(key, until);
    return until;
  }

  /** Forgets `key` (a deleted link). */
  forgetListenbrainz(key: string): void {
    this.lbNextMs.delete(key);
  }
}
