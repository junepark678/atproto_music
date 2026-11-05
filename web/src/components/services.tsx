import { type Clock, cryptoRandom, type Random, systemClock } from '@atmusic/core/deps';
import { type ComponentChildren, createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import type { Session } from '../session/client';
import { sessionClient } from '../session/client';
import { REAUTH_POPUP_MARKER } from '../session/reauth-channel';
import { OutboxService } from './outbox-service';

export interface SessionPort {
  signIn(handle: string): Promise<void>;
  signOut(): Promise<unknown>;
  expiry(): Promise<{ sessionEndsAtMs: number | null } | null>;
}
export interface Ticker {
  every(ms: number, tick: () => void): () => void;
}
export interface OutboxRequest {
  session: Session;
  prefix: string;
  api: ApiClient;
}
export interface ScreenServices {
  clock: Clock;
  random: Random;
  ticker: Ticker;
  session(): Promise<SessionPort>;
  /** Opens the OAuth flow in a separate context so the current app and its draft stay in memory. */
  reauthenticate?(handle: string): Promise<void>;
  outbox(request: OutboxRequest): Promise<OutboxService>;
  closeOutbox(): Promise<void>;
}
export const intervalTicker: Ticker = {
  every(ms, tick) {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  },
};

export function createDefaultServices(): ScreenServices {
  let current: { session: Session; prefix: string; service: OutboxService } | null = null;
  return {
    clock: systemClock,
    random: cryptoRandom,
    ticker: intervalTicker,
    session: async () => ({
      signIn: async (handle) => {
        location.assign(await sessionClient().start(handle));
      },
      signOut: async () => sessionClient().logout(),
      expiry: async () => {
        const s = sessionClient().current();
        return s ? { sessionEndsAtMs: Date.parse(s.expiresAt) } : null;
      },
    }),
    reauthenticate: async (handle) => {
      // Open synchronously during the user's submit gesture, before starting
      // the asynchronous BFF request, so popup blockers can recognize it.
      const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720');
      if (popup === null) throw new Error('Sign-in popup was blocked');
      try {
        try {
          // This marker carries no user data. The draft remains in the parent
          // tab's memory and is never serialized into browser storage.
          popup.sessionStorage.setItem(REAUTH_POPUP_MARKER, '1');
        } catch {
          // BroadcastChannel and the parent focus fallback still work if
          // storage is unavailable; only automatic popup closure is lost.
        }
        popup.location.replace(await sessionClient().start(handle));
      } catch (error) {
        try {
          popup.close();
        } catch {
          // Preserve the sign-in error for the screen's fixed recovery text.
        }
        throw error;
      }
    },
    async outbox({ session, prefix }) {
      if (current?.session === session && current.prefix === prefix) return current.service;
      await this.closeOutbox();
      const service = new OutboxService(session, prefix);
      current = { session, prefix, service };
      return service;
    },
    async closeOutbox() {
      const prior = current;
      current = null;
      await prior?.service.stop();
    },
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
export function useServices(): ScreenServices {
  return useContext(ServicesContext) ?? defaultServices();
}
