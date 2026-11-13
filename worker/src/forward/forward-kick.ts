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
 * A kick already scheduled ahead of now covers this one (its pass picks up
 * every row queued by then), so a burst cannot push the due time further out.
 * Returns the due time this kick relies on.
 */
export function kickForwardDebounced(timers: ExtensionContext): number {
  const now = timers.deps.clock.nowMs();
  const last = lastKickDue.get(timers);
  if (last !== undefined && last > now) return last;
  const due = last === undefined || now - last >= FORWARD_KICK_DEBOUNCE_MS ? now : last + FORWARD_KICK_DEBOUNCE_MS;
  lastKickDue.set(timers, due);
  timers.schedule('forward', due);
  return due;
}
