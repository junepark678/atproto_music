// History read module (ADR 0004 §5.8 "History", docs/cursors.md). A port of
// crates/storage/src/repositories/public.rs `history` / `scrobble_page`.
//
// `history(m, {did, upper?, last?, limit})` returns the owner's visible
// scrobbles ordered by `(listened_at DESC, uri DESC)` through the
// `scrobbles_owner_time` index:
//
//   SELECT s.* FROM scrobbles s JOIN users u ON u.did = s.did AND <visible u>
//   WHERE s.did = ? [AND (s.listened_at, s.uri) <= (upper)] [AND (s.listened_at, s.uri) < (last)]
//   ORDER BY s.listened_at DESC, s.uri DESC LIMIT limit + 1
//
// - Visibility comes from ./visibility.ts (active, unsuppressed owner). Only
//   verified present rows exist in `scrobbles`; excluded and absent records
//   live in record_state only, so they never appear.
// - The keyset clauses are added only when the cursor carries them, as Rust
//   does (`PageBounds.upper/last` are `None` on a first page). Timestamps are
//   the fixed-width 30-character storage form, so text order is time order;
//   URIs compare with SQLite BINARY collation (UTF-8 bytes = code points).
// - One extra row is read to decide `hasMore`; the rows returned are at most
//   `limit`. The page carries the per-user Indexing truth (W2-05), read in
//   the same synchronous turn as the rows.
//
// Synchronous over `m.db`: no await between the reads, so the rows and the
// indexing state come from one consistent storage state.

import type { HistoryQuery, KeysetQuery, ModuleDeps, RowsResult, ScrobbleRow, TimeKey } from '../contracts';
import type { SqlParam } from '../db';
import { indexing } from '../status';
import { visibleScrobblesFrom } from './visibility';

/** API.md list limit maximum; the HTTP layer rejects anything else with 422 (no clamping). */
export const MAX_PAGE_LIMIT = 100;

const STORAGE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;

function checkKey(name: string, key: TimeKey | undefined): void {
  if (key === undefined) return;
  if (typeof key !== 'object' || key === null || typeof key.t !== 'string' || typeof key.uri !== 'string') {
    throw new RangeError(`${name} must be a {t, uri} tuple`);
  }
  if (!STORAGE_TS.test(key.t)) throw new RangeError(`${name}.t must be a 30-character storage timestamp`);
}

/** Validates the module invariants the HTTP layer already guarantees (fail closed, never clamp). */
export function checkKeyset(q: KeysetQuery): void {
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_PAGE_LIMIT) {
    throw new RangeError(`page limit must be an integer in 1..=${MAX_PAGE_LIMIT}, got ${q.limit}`);
  }
  checkKey('upper', q.upper);
  checkKey('last', q.last);
}

const ASCII = /^[\x20-\x7e]*$/;

/**
 * `a <= b` in SQLite BINARY tuple order, or null when it cannot be decided in
 * JavaScript: for non-ASCII text UTF-16 code-unit order may differ from the
 * UTF-8 byte order SQLite compares. Storage timestamps and AT URIs are ASCII.
 */
function tupleAtMost(a: TimeKey, b: TimeKey): boolean | null {
  if (!ASCII.test(a.t) || !ASCII.test(a.uri) || !ASCII.test(b.t) || !ASCII.test(b.uri)) return null;
  return a.t < b.t || (a.t === b.t && a.uri <= b.uri);
}

/**
 * The keyset predicate for `(timeColumn, uriColumn)` and its parameters:
 * at or below the traversal anchor and strictly below the last returned row.
 * `timeColumn` and `uriColumn` are fixed identifiers chosen by the callers.
 *
 * When `last <= upper` (every cursor the server issues: `last` is a row that
 * was returned at or below the anchor), `< last` implies `<= upper`, so only
 * the `last` clause is emitted. The result is the same row set, but SQLite
 * can use just one of two upper bounds on the same index columns as the
 * range start: with both present it seeks from the anchor and filters every
 * row down to `last`, so a page at depth d read O(d) rows (W6-02 benchmark:
 * 5,023 rows read for a 20-row history page at depth 5,000). With the one
 * clause the seek starts strictly below `last`.
 */
export function keysetWhere(
  q: KeysetQuery,
  timeColumn: string,
  uriColumn: string,
): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const anchorImplied = q.upper !== undefined && q.last !== undefined && tupleAtMost(q.last, q.upper) === true;
  if (q.upper !== undefined && !anchorImplied) {
    clauses.push(`(${timeColumn}, ${uriColumn}) <= (?, ?)`);
    params.push(q.upper.t, q.upper.uri);
  }
  if (q.last !== undefined) {
    clauses.push(`(${timeColumn}, ${uriColumn}) < (?, ?)`);
    params.push(q.last.t, q.last.uri);
  }
  return { sql: clauses.map((c) => ` AND ${c}`).join(''), params };
}

/** Splits the `limit + 1` probe into the page rows and `hasMore`. */
export function splitPage<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export function history(m: ModuleDeps, q: HistoryQuery): RowsResult<ScrobbleRow> {
  if (typeof q.did !== 'string' || q.did === '') throw new RangeError('history needs a DID');
  checkKeyset(q);
  const keyset = keysetWhere(q, 's.listened_at', 's.uri');
  const rows = m.db.all<ScrobbleRow>(
    `SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.did = ?${keyset.sql}
     ORDER BY s.listened_at DESC, s.uri DESC
     LIMIT ?`,
    q.did,
    ...keyset.params,
    q.limit + 1,
  );
  const page = splitPage(rows, q.limit);
  return {
    rows: page.rows,
    hasMore: page.hasMore,
    indexing: indexing(m.db, m.clock.nowMs(), { did: q.did, mode: m.config.ingestMode }),
  };
}
