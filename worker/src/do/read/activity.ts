// ListenBrainz listening activity and daily activity (ADR 0005 §8.5, §10.1;
// N2-06). Computed on read, anchored on the request clock (`m.clock`).
//
// - Listening activity: the window and buckets of
//   packages/core/src/periods.ts `listeningActivityWindow` (the range and the
//   one before it, `all_time` from 2002). Each bucket counts the owner's visible
//   listens in `bucket ∩ window`, so nothing after now counts in a range that
//   ends at now. `all_time` lists only the years that hold listens.
// - Daily activity: listens in the range (`listenBrainzRangeBounds`) counted by
//   UTC weekday and hour into the zero-filled 7 × 24 grid of
//   `dailyActivityGrid` (Monday first).
// - Buckets are UTC calendar units and the storage timestamp is UTC text, so a
//   listen's day, month and year are prefixes of `listened_at` (10, 7 and 4
//   characters), and its weekday and hour come from that text too: SQLite
//   groups, JavaScript only adds the groups into buckets.
// - An unknown, inactive or suppressed user yields null (404).

import {
  type DailyActivity,
  dailyActivityGrid,
  type ListenBrainzRange,
  type ListeningActivityWindow,
  listenBrainzRangeBounds,
  listeningActivityWindow,
  type PeriodBounds,
  WEEKDAYS_MONDAY_FIRST,
} from '@atmusic/core/periods';
import type { ModuleDeps } from '../contracts';
import type { SqlParam } from '../db';
import { storageRange } from './range-stats';
import { isVisibleUser } from './recent';
import { visibleScrobblesFrom } from './visibility';

export interface ActivityBucketCount {
  fromMs: number;
  toMs: number;
  /** ListenBrainz `time_range`. */
  label: string;
  count: number;
}

export interface ListeningActivity {
  range: ListenBrainzRange;
  window: ListeningActivityWindow;
  /** Oldest first. */
  buckets: ActivityBucketCount[];
}

export interface DailyActivityResult {
  range: ListenBrainzRange;
  bounds: PeriodBounds;
  activity: DailyActivity;
}

const PREFIX_LENGTH = { day: 10, month: 7, year: 4 } as const;

/** The UTC instant at which a `listened_at` prefix (YYYY, YYYY-MM or YYYY-MM-DD) starts. */
function prefixStartMs(prefix: string): number {
  const y = Number(prefix.slice(0, 4));
  const mo = prefix.length >= 7 ? Number(prefix.slice(5, 7)) - 1 : 0;
  const d = prefix.length >= 10 ? Number(prefix.slice(8, 10)) : 1;
  return Date.UTC(y, mo, d);
}

function boundsWhere(bounds: PeriodBounds): { sql: string; params: SqlParam[] } {
  const range = storageRange({ lower: bounds.lowerMs, upper: bounds.upperMs, upperInclusive: bounds.upperInclusive });
  const params: SqlParam[] = [range.upper];
  let sql = ' AND s.listened_at < ?';
  if (range.lower !== null) {
    sql += ' AND s.listened_at >= ?';
    params.push(range.lower);
  }
  return { sql, params };
}

export function listeningActivity(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  q: { did: string; range: ListenBrainzRange },
): ListeningActivity | null {
  if (typeof q.did !== 'string' || q.did === '') throw new RangeError('listening activity needs a DID');
  const window = listeningActivityWindow(q.range, m.clock.nowMs());
  if (!isVisibleUser(m.db, q.did)) return null;
  const len = PREFIX_LENGTH[window.bucket];
  const where = boundsWhere(window);
  const groups = m.db.all<{ p: string; c: number }>(
    `SELECT substr(s.listened_at, 1, ${len}) AS p, count(*) AS c FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.did = ?${where.sql} GROUP BY substr(s.listened_at, 1, ${len})`,
    q.did,
    ...where.params,
  );
  const byStart = new Map<number, number>();
  for (const g of groups) byStart.set(prefixStartMs(g.p), (byStart.get(prefixStartMs(g.p)) ?? 0) + g.c);
  let buckets = window.buckets.map((b) => ({
    fromMs: b.fromMs,
    toMs: b.toMs,
    label: b.label,
    count: byStart.get(b.fromMs) ?? 0,
  }));
  if (window.omitEmptyBuckets) buckets = buckets.filter((b) => b.count > 0);
  return { range: q.range, window, buckets };
}

export function dailyActivity(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  q: { did: string; range: ListenBrainzRange },
): DailyActivityResult | null {
  if (typeof q.did !== 'string' || q.did === '') throw new RangeError('daily activity needs a DID');
  const bounds = listenBrainzRangeBounds(q.range, m.clock.nowMs());
  if (!isVisibleUser(m.db, q.did)) return null;
  const where = boundsWhere(bounds);
  // strftime('%w'): 0 = Sunday … 6 = Saturday, from the UTC date prefix.
  const groups = m.db.all<{ dow: string; hour: string; c: number }>(
    `SELECT strftime('%w', substr(s.listened_at, 1, 10)) AS dow, substr(s.listened_at, 12, 2) AS hour, count(*) AS c
     FROM ${visibleScrobblesFrom('s', 'u')}
     WHERE s.did = ?${where.sql}
     GROUP BY strftime('%w', substr(s.listened_at, 1, 10)), substr(s.listened_at, 12, 2)`,
    q.did,
    ...where.params,
  );
  const activity = dailyActivityGrid(
    groups.map((g) => ({
      day: WEEKDAYS_MONDAY_FIRST[(Number(g.dow) + 6) % 7]!,
      hour: Number(g.hour),
      count: g.c,
    })),
  );
  return { range: q.range, bounds, activity };
}
