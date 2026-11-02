import { cryptoRandom, systemClock, type Clock, type Random } from '@atmusic/core/deps';
import { type ComponentChildren, createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Session } from '../session/client';
import { sessionClient } from '../session/client';
import type { ApiClient } from '../api/client';
import { OutboxService } from './outbox-service';

export interface SessionPort {
  signIn(handle: string): Promise<void>;
  signOut(): Promise<unknown>;
  expiry(): Promise<{ sessionEndsAtMs: number | null } | null>;
}
export interface Ticker { every(ms: number, tick: () => void): () => void; }
export interface OutboxRequest { session: Session; prefix: string; api: ApiClient; }
export interface ScreenServices {
  clock: Clock; random: Random; ticker: Ticker;
  session(): Promise<SessionPort>;
  outbox(request: OutboxRequest): Promise<OutboxService>;
  closeOutbox(): Promise<void>;
}
export const intervalTicker: Ticker = { every(ms, tick) { const id = setInterval(tick, ms); return () => clearInterval(id); } };

export function createDefaultServices(): ScreenServices {
  let current: { session: Session; prefix: string; service: OutboxService } | null = null;
  return {
    clock: systemClock, random: cryptoRandom, ticker: intervalTicker,
    session: async () => ({
      signIn: async (handle) => { location.assign(await sessionClient().start(handle)); },
      signOut: async () => sessionClient().logout(),
      expiry: async () => { const s = sessionClient().current(); return s ? { sessionEndsAtMs: Date.parse(s.expiresAt) } : null; },
    }),
    async outbox({ session, prefix }) {
      if (current?.session === session && current.prefix === prefix) return current.service;
      await this.closeOutbox();
      const service = new OutboxService(session, prefix); current = { session, prefix, service }; return service;
    },
    async closeOutbox() { const prior = current; current = null; await prior?.service.stop(); },
  };
}
let pageServices: ScreenServices | null = null;
export function defaultServices(): ScreenServices { pageServices ??= createDefaultServices(); return pageServices; }
export const ServicesContext = createContext<ScreenServices | null>(null);
export function ServicesProvider({ value, children }: { value: ScreenServices; children?: ComponentChildren }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}
export function useServices(): ScreenServices { return useContext(ServicesContext) ?? defaultServices(); }
