// Cursor pagination for a `Page<T>` route (feed, history).
//
// - Server order is kept: pages are appended exactly as received and nothing
//   is re-sorted. `nextCursor` is passed back unchanged (it is opaque).
// - Only one request is in flight at a time, so a double click or a retry
//   while loading can never append the same page twice.
// - A failed later page keeps every item already shown; `retry()` asks for
//   that same page again with the same cursor.
// - A change of `key` (another scope, viewer or user) drops the old pages and
//   ignores late answers for the old key.

import type { Indexing, Page } from '@atmusic/core/api-types';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export type PageLoader<T> = (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;

export interface PagedState<T> {
  /** `loading`: the first page is being fetched; `error`: it failed; `ready`: at least one page arrived. */
  phase: 'loading' | 'ready' | 'error';
  items: T[];
  nextCursor: string | null;
  indexing: Indexing | null;
  asOf: string | null;
  /** The first page's failure. */
  error: unknown;
  loadingMore: boolean;
  /** A later page's failure (the items above stay). */
  moreError: unknown;
}

export interface Paged<T> extends PagedState<T> {
  loadMore(): void;
  /** Re-requests whatever failed: the first page, or the next page with the same cursor. */
  retry(): void;
  /** Reloads from the first page. */
  reload(): void;
}

const initial = <T>(): PagedState<T> => ({
  phase: 'loading',
  items: [],
  nextCursor: null,
  indexing: null,
  asOf: null,
  error: null,
  loadingMore: false,
  moreError: null,
});

export function usePaged<T>(key: string | null, load: PageLoader<T>): Paged<T> {
  const [state, setState] = useState<PagedState<T>>(initial);
  const loadRef = useRef(load);
  loadRef.current = load;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Identifies the current key's run; bumped on every key change and reload.
  const run = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const first = useCallback(() => {
    inFlight.current?.abort();
    const mine = ++run.current;
    const abort = new AbortController();
    inFlight.current = abort;
    setState(initial<T>());
    loadRef.current(null, abort.signal).then(
      (page) => {
        if (mine !== run.current) return;
        inFlight.current = null;
        setState({
          ...initial<T>(),
          phase: 'ready',
          items: [...page.items],
          nextCursor: page.nextCursor,
          indexing: page.indexing,
          asOf: page.asOf,
        });
      },
      (error: unknown) => {
        if (mine !== run.current) return;
        inFlight.current = null;
        setState({ ...initial<T>(), phase: 'error', error });
      },
    );
  }, []);

  useEffect(() => {
    if (key === null) {
      inFlight.current?.abort();
      run.current++;
      return;
    }
    first();
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
      run.current++;
    };
  }, [key, first]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (inFlight.current !== null || current.phase !== 'ready' || current.nextCursor === null) return;
    const mine = run.current;
    const cursor = current.nextCursor;
    const abort = new AbortController();
    inFlight.current = abort;
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    loadRef.current(cursor, abort.signal).then(
      (page) => {
        if (mine !== run.current) return;
        inFlight.current = null;
        setState((s) => ({
          ...s,
          items: [...s.items, ...page.items],
          nextCursor: page.nextCursor,
          indexing: page.indexing,
          asOf: page.asOf,
          loadingMore: false,
          moreError: null,
        }));
      },
      (error: unknown) => {
        if (mine !== run.current) return;
        inFlight.current = null;
        setState((s) => ({ ...s, loadingMore: false, moreError: error }));
      },
    );
  }, []);

  const retry = useCallback(() => {
    if (stateRef.current.phase === 'error') first();
    else loadMore();
  }, [first, loadMore]);

  return { ...state, loadMore, retry, reload: first };
}
