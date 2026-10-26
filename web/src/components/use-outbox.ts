// Hooks that connect a screen to the signed-in DID's outbox.
//
// `useOutbox()` yields the OutboxService once the session is signed in and the
// deployment can publish (meta advertises `publication` with an owned prefix);
// otherwise the write UI stays hidden. `useOutboxOps()` keeps the DID's rows
// current: it re-reads them after every change the local runner reports and,
// while `live(rows)` holds (something is still moving), on a ticker as well,
// because another tab may hold the runner lock. The ticker stops as soon as
// nothing is live, so a terminal state ends all refreshing.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { OutboxOperation } from '../outbox/store';
import { useAppState } from '../state/store';
import type { OutboxService } from './outbox-service';
import { useServices } from './services';

export type OutboxState =
  | { readonly status: 'anonymous' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly outbox: OutboxService }
  | { readonly status: 'error'; readonly error: unknown };

export function useOutbox(): OutboxState {
  const state = useAppState();
  const services = useServices();
  const session = state.session.value;
  const canPublish = state.canPublish.value;
  const prefix = state.meta.value?.lexiconPrefix ?? null;
  const [result, setResult] = useState<OutboxState>({ status: 'loading' });

  useEffect(() => {
    if (session === null || !canPublish || prefix === null) return;
    let live = true;
    setResult({ status: 'loading' });
    services.outbox({ session, prefix, api: state.api }).then(
      (outbox) => {
        if (live) setResult({ status: 'ready', outbox });
      },
      (error: unknown) => {
        if (live) setResult({ status: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [session, canPublish, prefix, services, state]);

  if (session === null) return { status: 'anonymous' };
  if (!canPublish || prefix === null) return { status: 'unavailable' };
  if (result.status === 'ready' && result.outbox.session !== session) return { status: 'loading' };
  return result;
}

/** Re-read interval while an operation is still moving. */
export const OUTBOX_REFRESH_MS = 2_000;

/** True while some row can still change state (not indexed, not failed, not stopped). */
export function anyLive(ops: readonly OutboxOperation[]): boolean {
  return ops.some((op) => op.state !== 'indexed' && op.state !== 'failed' && op.dueAt !== null);
}

/**
 * The outbox rows of the signed-in DID (null until first read, and while no
 * outbox is ready). `live` decides whether the ticker keeps re-reading.
 */
export function useOutboxOps(
  outbox: OutboxService | null,
  live: (ops: readonly OutboxOperation[]) => boolean = anyLive,
): OutboxOperation[] | null {
  const services = useServices();
  const [ops, setOps] = useState<OutboxOperation[] | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    setOps(null);
    if (outbox === null) return;
    let active = true;
    let generation = 0;
    let stopTicker: (() => void) | null = null;
    const syncTicker = (rows: readonly OutboxOperation[]) => {
      const wanted = liveRef.current(rows);
      if (wanted && stopTicker === null) stopTicker = services.ticker.every(OUTBOX_REFRESH_MS, reload);
      if (!wanted && stopTicker !== null) {
        stopTicker();
        stopTicker = null;
      }
    };
    function reload(): void {
      const mine = ++generation;
      outbox?.list().then(
        (rows) => {
          if (!active || mine !== generation) return;
          setOps(rows);
          syncTicker(rows);
        },
        () => undefined,
      );
    }
    const unsubscribe = outbox.subscribe(reload);
    reload();
    return () => {
      active = false;
      unsubscribe();
      stopTicker?.();
      stopTicker = null;
    };
  }, [outbox, services]);

  return ops;
}
