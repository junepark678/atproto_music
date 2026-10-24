// Relay discovery (ADR 0004 §5.4 hint sources, §5.5 gap recovery, §5.6
// `discovery`, §5.9; amendment A6: relay listings are hints only). Timer
// `discovery`; W5-01 wires `discover` as its runDue handler.
//
// A discovery *pass* pages `GET {RELAY_URL}/xrpc/com.atproto.sync.
// listReposByCollection?collection=<p>.scrobble&limit=…[&cursor=…]` to its
// end, then the same for `<p>.follow`. Each listed DID is a hint naming only a
// DID: it goes to admission (admission.ts `admit`, source `discovery`), which
// creates `users(active=0, recovering)` plus a pending snapshot job, or nothing
// (known, suppressed, or the hourly budget / 1,024 pending-snapshot cap is
// full). Discovery never fetches, verifies or projects a record and never
// touches an existing account: authority comes only from the snapshot at the
// signed head (§5.7). Historical discovery is limited to relay coverage; there
// is no completeness promise (ADR §9.1).
//
// One run (`discover(m, now)`) reads at most DISCOVERY_PAGES_PER_RUN (10)
// pages and stops early when admission is busy: the page holding the first
// refused DID is read again by the next run (DIDs admitted from it before are
// `known` by then), so no listed DID is skipped. The pass position is durable,
// so a pass continues across runs and DO restarts:
//   counters(name = DISCOVERY_STATE_COUNTER, label = JSON {pass, collection,
//   cursor}, value = pages read in this pass)
// One row at most. The schema (W0-01, frozen) has no discovery table; the
// counters row is the one durable store whose key is free text and that no
// other module interprets, and it surfaces in /internal/admin/status as the
// pass progress. A pass ends when a collection's page has no new cursor (no
// cursor, an empty one, or the cursor just used); the row is then deleted.
//
// Cadence:
// - a normal (`daily`) pass: the timer is due again DISCOVERY_INTERVAL_MS (one
//   day) after every run, finished or not, so a normal pass reads at most 10
//   pages a day;
// - a gap-recovery pass (`requestGapDiscovery`, called once when gap recovery
//   starts, ADR §5.5): restarts the pass from the beginning of the scrobble
//   listing, unless a gap pass is already in progress, and makes the timer due
//   now. Until it ends, a run that stopped at the page budget continues
//   DISCOVERY_GAP_CONTINUE_MS later, and one that met a busy admission budget
//   at the start of the next admission window. `gapDiscoveryPending(db)` is
//   true until the gap pass ends (W4-01 / W5-01 keep `pending_gap` set until
//   then, ADR §5.5: pending_gap clears only once all of that work completes);
// - a relay failure (transport, non-2xx, a malformed page) ends the run with
//   the position kept; the next run is due after the larger of
//   DISCOVERY_RETRY_MS and the relay's Retry-After / RateLimit-Reset (capped at
//   one day), or the normal day for a daily pass.
//
// Concurrency (ADR F3: no read-check-write across an await): a run reads the
// position, awaits the relay, then acts on the page. While it awaits, the DO's
// input gate is open, so `requestGapDiscovery` (or another writer) may replace
// the position and schedule the timer. So after every fetch the run re-reads
// the position and, unless it still equals the one it fetched (pass,
// collection, cursor), admits nothing from that page, writes no position and
// stops (`superseded`), leaving the newer position and its timer alone; the
// position write itself re-checks inside its transaction. The run's own
// reschedule replaces only the due time it saw when it started (the row the
// alarm claimed, or none): a `discovery` due time set by someone else during
// the run is kept when it is earlier (`schedule` without force).
//
// Every relay request goes through SafeFetch (`json` kind, 1 MiB cap, 10 s
// deadline, URL / DoH / redirect policy). A page is validated before use: an
// object whose `repos` is an array of `{did: string}` and whose optional
// `cursor` is a string of at most DISCOVERY_MAX_CURSOR_CHARS; a listed DID
// that is not a resolvable did:plc / did:web is skipped (counter
// `discovery_invalid`). No `db.tx` spans an await.

import { isResolvableDid } from '@atmusic/atproto/identity/did-doc';
import { createSafeFetch, isSafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import type { ModuleDeps } from '../contracts';
import type { Db } from '../db';
import { dueAt, schedule } from '../timers';
import { incrementCounter } from '../write/keys';
import { ADMISSION_WINDOW_MS, admissionWindow, admit } from './admission';

export const LIST_REPOS_BY_COLLECTION = 'com.atproto.sync.listReposByCollection';
export const DISCOVERY_PAGES_PER_RUN = 10;
/** Requested page size (the reference relay's default). */
export const DISCOVERY_PAGE_LIMIT = 500;
export const DISCOVERY_INTERVAL_MS = 24 * 3_600_000;
export const DISCOVERY_GAP_CONTINUE_MS = 60_000;
export const DISCOVERY_RETRY_MS = 3_600_000;
export const DISCOVERY_MAX_CURSOR_CHARS = 1024;

export const DISCOVERY_STATE_COUNTER = 'discovery_state';
export const DISCOVERY_PAGES_COUNTER = 'discovery_pages';
export const DISCOVERY_INVALID_COUNTER = 'discovery_invalid';
export const DISCOVERY_FAILED_COUNTER = 'discovery_failed';
export const DISCOVERY_PASSES_COUNTER = 'discovery_passes';

export type DiscoveryPass = 'daily' | 'gap';

export interface DiscoveryState {
  pass: DiscoveryPass;
  /** 0: the scrobble collection, 1: the follow collection. */
  collection: 0 | 1;
  /** The cursor of the page to read next; null for the first page. */
  cursor: string | null;
  /** Pages read in this pass. */
  pages: number;
}

/** The pass in progress, or null. A malformed row reads as no pass. */
export function readDiscoveryState(db: Db): DiscoveryState | null {
  const row = db.one<{ label: string; value: number }>(
    'SELECT label, value FROM counters WHERE name = ? LIMIT 1',
    DISCOVERY_STATE_COUNTER,
  );
  if (row === null) return null;
  try {
    const v = JSON.parse(row.label) as Record<string, unknown>;
    const pass = v.pass === 'gap' ? 'gap' : v.pass === 'daily' ? 'daily' : null;
    const collection = v.collection === 0 || v.collection === 1 ? v.collection : null;
    const cursor = v.cursor === null || typeof v.cursor === 'string' ? v.cursor : undefined;
    if (pass === null || collection === null || cursor === undefined) return null;
    return { pass, collection, cursor, pages: row.value };
  } catch {
    return null;
  }
}

function writeDiscoveryState(db: Db, s: DiscoveryState | null): void {
  db.tx(() => {
    db.run('DELETE FROM counters WHERE name = ?', DISCOVERY_STATE_COUNTER);
    if (s === null) return;
    db.run(
      'INSERT INTO counters(name, label, value) VALUES (?, ?, ?)',
      DISCOVERY_STATE_COUNTER,
      JSON.stringify({ pass: s.pass, collection: s.collection, cursor: s.cursor }),
      s.pages,
    );
  });
}

/** True while a gap-recovery discovery pass has not finished. */
export function gapDiscoveryPending(db: Db): boolean {
  return readDiscoveryState(db)?.pass === 'gap';
}

/**
 * Gap recovery started: one full discovery pass from the beginning (unless a
 * gap pass is already in progress), due now.
 */
export function requestGapDiscovery(db: Db, now: number): void {
  db.tx(() => {
    if (readDiscoveryState(db)?.pass !== 'gap') {
      writeDiscoveryState(db, { pass: 'gap', collection: 0, cursor: null, pages: 0 });
    }
    schedule(db, 'discovery', now);
  });
}

/** Arm the `discovery` timer at `now` when it is not scheduled at all (IndexDO start-up). */
export function ensureDiscoveryTimer(db: Db, now: number): number {
  return db.tx(() => dueAt(db, 'discovery') ?? schedule(db, 'discovery', now));
}

export interface DiscoveryOptions {
  /** Pages per run (default DISCOVERY_PAGES_PER_RUN). */
  pages?: number;
  /** Requested page size (default DISCOVERY_PAGE_LIMIT). */
  pageLimit?: number;
}

export type DiscoveryStop = 'complete' | 'page_budget' | 'admission_busy' | 'relay_error' | 'disabled' | 'superseded';

export interface DiscoveryReport {
  pass: DiscoveryPass | null;
  pages: number;
  admitted: string[];
  known: number;
  suppressed: number;
  invalid: number;
  stop: DiscoveryStop;
  detail?: string;
  /** The `discovery` timer's next due time. */
  nextDueAt: number;
}

interface Page {
  dids: unknown[];
  cursor: string | null;
}

function parsePage(body: Uint8Array): Page | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.repos)) return null;
  const cursor = doc.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return null;
  if (typeof cursor === 'string' && cursor.length > DISCOVERY_MAX_CURSOR_CHARS) return null;
  const dids: unknown[] = [];
  for (const repo of doc.repos) {
    if (typeof repo !== 'object' || repo === null || Array.isArray(repo)) return null;
    dids.push((repo as Record<string, unknown>).did);
  }
  return { dids, cursor: typeof cursor === 'string' && cursor !== '' ? cursor : null };
}

/** The stored position (or the default when none is stored) still equals `s`. */
function samePosition(db: Db, s: DiscoveryState, stored: boolean): boolean {
  const cur = readDiscoveryState(db);
  if (cur === null) return !stored;
  return stored && cur.pass === s.pass && cur.collection === s.collection && cur.cursor === s.cursor;
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${label} must be a positive integer`);
  return v;
}

/** One discovery run (see the header). */
export async function discover(m: ModuleDeps, now: number, o: DiscoveryOptions = {}): Promise<DiscoveryReport> {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`now must be epoch ms, got ${now}`);
  const db = m.db;
  const maxPages = positiveInt(o.pages, DISCOVERY_PAGES_PER_RUN, 'pages');
  const pageLimit = positiveInt(o.pageLimit, DISCOVERY_PAGE_LIMIT, 'pageLimit');
  const report: DiscoveryReport = {
    pass: null,
    pages: 0,
    admitted: [],
    known: 0,
    suppressed: 0,
    invalid: 0,
    stop: 'disabled',
    nextDueAt: now + DISCOVERY_INTERVAL_MS,
  };
  const collections = m.config.collections;
  if (m.config.prefix === null || collections === null) {
    // Namespace gate closed: nothing is ingested; look again tomorrow.
    report.nextDueAt = db.tx(() => schedule(db, 'discovery', now + DISCOVERY_INTERVAL_MS, { force: true }));
    return report;
  }
  const names = [collections.scrobble, collections.follow] as const;
  // The due time this run may replace: the claimed row is renamed by runDue, so
  // inside an alarm this is null unless someone scheduled during the run.
  const dueAtStart = dueAt(db, 'discovery');
  const initial = readDiscoveryState(db);
  let stored = initial !== null;
  let state: DiscoveryState = initial ?? { pass: 'daily', collection: 0, cursor: null, pages: 0 };
  report.pass = state.pass;
  const safeFetch = createSafeFetch({ transport: m.transport, clock: m.clock });
  let retryAfterMs = 0;

  pages: for (;;) {
    if (report.pages >= maxPages) {
      report.stop = 'page_budget';
      break;
    }
    const url = new URL(`/xrpc/${LIST_REPOS_BY_COLLECTION}`, m.config.relayUrl);
    url.searchParams.set('collection', names[state.collection]);
    url.searchParams.set('limit', String(pageLimit));
    if (state.cursor !== null) url.searchParams.set('cursor', state.cursor);

    let page: Page | null;
    try {
      page = parsePage((await safeFetch(url, { kind: 'json' })).body);
    } catch (error) {
      if (!samePosition(db, state, stored)) {
        report.stop = 'superseded';
        break;
      }
      const code = isSafeFetchError(error) ? (error.status === null ? error.code : `http_${error.status}`) : 'error';
      if (isSafeFetchError(error)) {
        retryAfterMs = Math.max(error.retryAfterMs ?? 0, error.rateLimitResetMs ?? 0);
      } else {
        m.log.log('error', 'discovery.fetch_error', { error: String(error) });
      }
      db.tx(() => incrementCounter(db, DISCOVERY_FAILED_COUNTER, code));
      report.stop = 'relay_error';
      report.detail = code;
      break;
    }
    if (!samePosition(db, state, stored)) {
      // The position moved while the relay answered (a gap request): this page
      // belongs to a pass that no longer exists.
      report.stop = 'superseded';
      break;
    }
    report.pages++;
    if (page === null) {
      db.tx(() => {
        incrementCounter(db, DISCOVERY_PAGES_COUNTER, names[state.collection]);
        incrementCounter(db, DISCOVERY_FAILED_COUNTER, 'malformed_page');
      });
      report.stop = 'relay_error';
      report.detail = 'malformed_page';
      break;
    }

    for (const did of page.dids) {
      if (typeof did !== 'string' || !isResolvableDid(did)) {
        report.invalid++;
        db.tx(() => incrementCounter(db, DISCOVERY_INVALID_COUNTER, ''));
        continue;
      }
      const a = admit(db, did, 'discovery', now);
      if (a.status === 'admitted') report.admitted.push(did);
      else if (a.status === 'known') report.known++;
      else if (a.status === 'suppressed') report.suppressed++;
      else {
        // Busy: this page is read again next time; nothing before it is lost.
        db.tx(() => incrementCounter(db, DISCOVERY_PAGES_COUNTER, names[state.collection]));
        report.stop = 'admission_busy';
        report.detail = a.reason;
        break pages;
      }
    }

    // The page is done: advance the durable position in one transaction.
    const next: DiscoveryState | null =
      page.cursor !== null && page.cursor !== state.cursor
        ? { ...state, cursor: page.cursor, pages: state.pages + 1 }
        : state.collection === 0
          ? { ...state, collection: 1, cursor: null, pages: state.pages + 1 }
          : null;
    const collection = names[state.collection];
    const fetched = state;
    const advanced = db.tx((): boolean => {
      if (!samePosition(db, fetched, stored)) return false;
      writeDiscoveryState(db, next);
      incrementCounter(db, DISCOVERY_PAGES_COUNTER, collection);
      if (next === null) incrementCounter(db, DISCOVERY_PASSES_COUNTER, fetched.pass);
      return true;
    });
    if (!advanced) {
      report.stop = 'superseded';
      break;
    }
    if (next === null) {
      report.stop = 'complete';
      break;
    }
    state = next;
    stored = true;
  }

  if (report.admitted.length > 0) {
    // The admitted snapshot jobs are due now (W4-01's snapshot timer runs them).
    db.tx(() => schedule(db, 'snapshot', now));
  }
  report.nextDueAt = db.tx(() => {
    const current = dueAt(db, 'discovery');
    if (report.stop === 'superseded' && current !== null) {
      // The newer position came with its own timer: leave both alone.
      return current;
    }
    const at = report.stop === 'superseded' ? now : nextRun(report, state.pass, now, retryAfterMs);
    // Replace only the due time this run started with; keep an earlier one set since.
    return schedule(db, 'discovery', at, { force: current === dueAtStart });
  });
  return report;
}

function nextRun(r: DiscoveryReport, pass: DiscoveryPass, now: number, retryAfterMs: number): number {
  if (r.stop === 'relay_error') {
    const wait = Math.min(Math.max(DISCOVERY_RETRY_MS, retryAfterMs), DISCOVERY_INTERVAL_MS);
    return pass === 'gap' ? now + wait : now + DISCOVERY_INTERVAL_MS;
  }
  if (pass === 'gap') {
    if (r.stop === 'page_budget') return now + DISCOVERY_GAP_CONTINUE_MS;
    if (r.stop === 'admission_busy') return admissionWindow(now) + ADMISSION_WINDOW_MS;
  }
  return now + DISCOVERY_INTERVAL_MS;
}
