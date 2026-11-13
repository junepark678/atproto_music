// Debounced forward-timer kicks for compatibility now-playing ingress.
//
// track.updateNowPlaying and ListenBrainz playing_now kick the `forward`
// extension timer so a now-playing update does not wait for the idle poll.
// Each kick can start a forwarding pass that enumerates every active link, so
// a client alternating tracks must not force one pass per request. Kicks are
// therefore spaced at least FORWARD_KICK_DEBOUNCE_MS apart per core: a kick
// inside the interval schedules the timer for the end of the interval instead
// (scheduling only ever pulls a timer earlier). Last.fm sends at most one
// request a second anyway, and now playing lives for 60 s.

import type { ExtensionContext } from '../app/host';

export const FORWARD_KICK_DEBOUNCE_MS = 1_000;

/** The due time of the last kick, per core (its frozen extension context). */
const lastKickDue = new WeakMap<ExtensionContext, number>();

/**
 * Makes the forward timer due now, or at the end of the debounce interval.
 * While a kick is pending (its due time is still ahead), this kick re-asserts
 * that same due time instead of a later one, so a burst cannot push the timer
 * further out. Re-asserting matters: a forwarding pass may have consumed the
 * timer and rescheduled it later (its idle poll) in the meantime, and
 * `schedule` only ever pulls a timer earlier, so this restores the pending due
 * time without delaying an earlier one. Returns the due time this kick relies on.
 */
export function kickForwardDebounced(timers: ExtensionContext): number {
  const now = timers.deps.clock.nowMs();
  const last = lastKickDue.get(timers);
  const due =
    last !== undefined && last > now
      ? last
      : last === undefined || now - last >= FORWARD_KICK_DEBOUNCE_MS
        ? now
        : last + FORWARD_KICK_DEBOUNCE_MS;
  lastKickDue.set(timers, due);
  timers.schedule('forward', due);
  return due;
}
