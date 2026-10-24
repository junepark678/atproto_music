// What the screens need besides the app state (web/src/state/store.ts): the
// clock and randomness the outbox builders take, the OAuth session's sign-in /
// sign-out / expiry, the per-DID outbox, and a ticker for re-reading outbox
// rows that another tab's runner may be moving.
//
// Production uses `defaultServices()` (system clock, crypto randomness, the
// page's SessionController, an IndexedDB outbox whose runner is elected with
// Web Locks). Tests provide their own through `ServicesContext`: the frozen
// clock, seeded randomness, a fake PDS session and a manual ticker. Nothing
// here changes what is verified or sent; it only decides which instances the
// screens talk to.

import type { Clock, Random } from '@atmusic/core/deps';
import { cryptoRandom, systemClock } from '@atmusic/core/deps';
import { type ComponentChildren, createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import type { SessionExpiry } from '../oauth/session';
import type { PdsSession } from '../oauth/types';
import { openOutboxStore } from '../outbox/store';
import { createOutboxService, type OutboxService } from './outbox-service';

/** The parts of the SessionController (web/src/oauth/session.ts) the screens use. */
export interface SessionPort {
  /** Starts the redirect sign-in; rejects with a SignInError. */
  signIn(handle: string): Promise<void>;
  /** Revokes (best effort) and clears every IndexedDB store of this origin. */
  signOut(): Promise<unknown>;
  expiry(): Promise<SessionExpiry | null>;
}

/** Repeats `tick` every `ms` until the returned function is called. */
export interface Ticker {
  every(ms: number, tick: () => void): () => void;
}

export interface OutboxRequest {
  session: PdsSession;
  prefix: string;
  api: ApiClient;
}

export interface ScreenServices {
  clock: Clock;
  random: Random;
  ticker: Ticker;
  session(): Promise<SessionPort>;
  /** The outbox of `session.did`, created (and its runner started) on first use. */
  outbox(request: OutboxRequest): Promise<OutboxService>;
  /** Stops the current outbox runner, e.g. before sign-out clears IndexedDB. */
  closeOutbox(): Promise<void>;
}

export const intervalTicker: Ticker = {
  every(ms, tick) {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  },
};

interface CurrentOutbox {
  session: PdsSession;
  prefix: string;
  service: Promise<OutboxService>;
}

/** The page's services: system clock, crypto randomness, the SPA session and an IndexedDB outbox. */
export function createDefaultServices(): ScreenServices {
  let current: CurrentOutbox | null = null;
  const close = async (): Promise<void> => {
    const previous = current;
    current = null;
    if (previous === null) return;
    try {
      const service = await previous.service;
      await service.stop();
      service.store.close();
    } catch {
      // The outbox never opened; nothing to stop.
    }
  };
  return {
    clock: systemClock,
    random: cryptoRandom,
    ticker: intervalTicker,
    session: () => import('../oauth/session').then((m) => m.session()),
    async outbox({ session, prefix, api }) {
      if (current !== null && current.session === session && current.prefix === prefix) return current.service;
      await close();
      const service = openOutboxStore().then((store) =>
        createOutboxService({ store, session, api, clock: systemClock, random: cryptoRandom, prefix }),
      );
      const entry: CurrentOutbox = { session, prefix, service };
      current = entry;
      service.catch(() => {
        if (current === entry) current = null;
      });
      return service;
    },
    closeOutbox: close,
  };
}

let pageServices: ScreenServices | null = null;

export function defaultServices(): ScreenServices {
  pageServices ??= createDefaultServices();
  return pageServices;
}

export const ServicesContext = createContext<ScreenServices | null>(null);

export function ServicesProvider({ value, children }: { value: ScreenServices; children?: ComponentChildren }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

/** The injected services, or the page's defaults. */
export function useServices(): ScreenServices {
  return useContext(ServicesContext) ?? defaultServices();
}
