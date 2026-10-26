// Statistics periods for the Last.fm 2.0 and ListenBrainz compatible APIs
// (ADR 0005 §10.1, §8.5; N1-12). Pure functions of the request clock `nowMs`.
//
// - Everything is UTC. Bounds are epoch milliseconds; `lowerMs` is inclusive,
//   `upperMs` is exclusive unless `upperInclusive` says otherwise (the rolling
//   and "this_*" ranges end at `now]`, every other range is half-open `[lower, upper)`).
// - Last.fm rolling periods subtract whole 24 h days from now.
// - Last.fm weekly charts use weeks that start on Sundays at 12:00 UTC, which is
//   what the documented sample timestamp 1108296002 (2005-02-13T12:00:02Z) implies.
// - ListenBrainz calendar ranges are anchored on now, not on the latest listen.
//   ListenBrainz's "if today is Monday, use last week" quirk comes from its daily
//   batch job and is deliberately not reproduced (documented deviation).
// - Listening-activity windows are the range plus the one before it, split into
//   aligned day, month or year buckets labelled with the ListenBrainz strftime
//   patterns. The last bucket of a "this_*" window is the whole bucket that holds
//   now; listens are counted in `bucket ∩ window`, so nothing after now counts.
// - The /api/v1 windows (`all`, `7d`, `30d`, `365d`) are not here: they stay in
//   worker/src/do/read/stats.ts unchanged.

export const SECOND_MS = 1000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** A UTC interval in epoch ms. `lowerMs === null` is unbounded below. */
export interface PeriodBounds {
  /** Inclusive lower bound, or `null` for no lower bound. */
  readonly lowerMs: number | null;
  readonly upperMs: number;
  /** `true` for `[lower, upper]` (ranges ending at now), `false` for `[lower, upper)`. */
  readonly upperInclusive: boolean;
}

/** Whether `tMs` lies inside `bounds`. */
export function inBounds(bounds: PeriodBounds, tMs: number): boolean {
  if (bounds.lowerMs !== null && tMs < bounds.lowerMs) return false;
  return bounds.upperInclusive ? tMs <= bounds.upperMs : tMs < bounds.upperMs;
}

function checkNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs)) throw new RangeError(`now must be integer epoch ms, got ${nowMs}`);
}

// ---------------------------------------------------------------------------
// Last.fm rolling periods (user.getTop*, `period` parameter)
// ---------------------------------------------------------------------------

export const LASTFM_PERIODS = ['overall', '7day', '1month', '3month', '6month', '12month'] as const;
export type LastfmPeriod = (typeof LASTFM_PERIODS)[number];

/** Length of each bounded rolling period in whole days. */
export const LASTFM_PERIOD_DAYS: Readonly<Record<Exclude<LastfmPeriod, 'overall'>, number>> = {
  '7day': 7,
  '1month': 30,
  '3month': 90,
  '6month': 180,
  '12month': 365,
};

/**
 * The `period` parameter: absent means `overall` (Last.fm's default); any other
 * value must be one of `LASTFM_PERIODS` exactly, otherwise `null` (error 6).
 */
export function parseLastfmPeriod(value: string | undefined | null): LastfmPeriod | null {
  if (value === undefined || value === null) return 'overall';
  return (LASTFM_PERIODS as readonly string[]).includes(value) ? (value as LastfmPeriod) : null;
}

/** `overall` is `(−∞, now]`; the others are `[now − n d, now]`. */
export function lastfmPeriodBounds(period: LastfmPeriod, nowMs: number): PeriodBounds {
  checkNow(nowMs);
  if (period === 'overall') return { lowerMs: null, upperMs: nowMs, upperInclusive: true };
  return { lowerMs: nowMs - LASTFM_PERIOD_DAYS[period] * DAY_MS, upperMs: nowMs, upperInclusive: true };
}

// ---------------------------------------------------------------------------
// Last.fm weekly charts (user.getWeeklyChartList and user.getWeekly*Chart)
// ---------------------------------------------------------------------------

export const LASTFM_WEEK_SECONDS = 604_800;
/** 1970-01-04T12:00:00Z, the first Sunday 12:00 UTC after the epoch. */
export const LASTFM_WEEK_ANCHOR_SECONDS = 302_400;

/** A weekly chart window in UNIX seconds, `[from, to)`. */
export interface LastfmChartWeek {
  readonly from: number;
  readonly to: number;
}

function checkSeconds(name: string, s: number): void {
  if (!Number.isSafeInteger(s)) throw new RangeError(`${name} must be integer UNIX seconds, got ${s}`);
}

/** Start (UNIX s) of the Sunday-12:00-UTC week holding `tSeconds`. */
export function lastfmWeekStart(tSeconds: number): number {
  checkSeconds('t', tSeconds);
  const offset = tSeconds - LASTFM_WEEK_ANCHOR_SECONDS;
  return LASTFM_WEEK_ANCHOR_SECONDS + Math.floor(offset / LASTFM_WEEK_SECONDS) * LASTFM_WEEK_SECONDS;
}

/**
 * Every chart week from the one holding the user's first listen to the current
 * one, oldest first. No listens (`null`) gives an empty list. A first listen
 * after now (clock skew within the +300 s record bound) still yields its week.
 */
export function lastfmWeeklyChartList(firstListenSeconds: number | null, nowSeconds: number): LastfmChartWeek[] {
  checkSeconds('now', nowSeconds);
  if (firstListenSeconds === null) return [];
  const last = lastfmWeekStart(Math.max(nowSeconds, firstListenSeconds));
  const weeks: LastfmChartWeek[] = [];
  for (let from = lastfmWeekStart(firstListenSeconds); from <= last; from += LASTFM_WEEK_SECONDS) {
    weeks.push({ from, to: from + LASTFM_WEEK_SECONDS });
  }
  return weeks;
}

/** The last complete chart week before now. */
export function lastfmLastCompleteWeek(nowSeconds: number): LastfmChartWeek {
  const current = lastfmWeekStart(nowSeconds);
  return { from: current - LASTFM_WEEK_SECONDS, to: current };
}

const UNIX_SECONDS = /^[0-9]{1,16}$/;

function parseUnixSeconds(value: string): number | null {
  if (!UNIX_SECONDS.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The `from`/`to` parameters of the weekly chart methods. Both absent selects the
 * last complete week; both present (decimal UNIX seconds) select `[from, to)`.
 * One without the other, or a malformed value, is `null` (error 6). `from ≥ to`
 * is a valid but empty window.
 */
export function lastfmWeeklyChartRange(
  from: string | undefined | null,
  to: string | undefined | null,
  nowSeconds: number,
): { week: LastfmChartWeek; bounds: PeriodBounds } | null {
  checkSeconds('now', nowSeconds);
  const absent = (v: string | undefined | null) => v === undefined || v === null;
  let week: LastfmChartWeek;
  if (absent(from) && absent(to)) {
    week = lastfmLastCompleteWeek(nowSeconds);
  } else {
    if (absent(from) || absent(to)) return null;
    const f = parseUnixSeconds(from!);
    const t = parseUnixSeconds(to!);
    if (f === null || t === null) return null;
    week = { from: f, to: t };
  }
  return { week, bounds: { lowerMs: week.from * SECOND_MS, upperMs: week.to * SECOND_MS, upperInclusive: false } };
}

// ---------------------------------------------------------------------------
// ListenBrainz calendar ranges (`range` parameter of /1/stats/user/*)
// ---------------------------------------------------------------------------

export const LISTENBRAINZ_RANGES = [
  'this_week',
  'this_month',
  'this_year',
  'week',
  'month',
  'quarter',
  'half_yearly',
  'year',
  'all_time',
] as const;
export type ListenBrainzRange = (typeof LISTENBRAINZ_RANGES)[number];

/** 2002-01-01T00:00:00Z, the lower bound of `all_time`. */
export const LISTENBRAINZ_ALL_TIME_START_MS = Date.UTC(2002, 0, 1);

/** Absent means `all_time`; an unknown value is `null` (400 "Invalid range: x"). */
export function parseListenBrainzRange(value: string | undefined | null): ListenBrainzRange | null {
  if (value === undefined || value === null) return 'all_time';
  return (LISTENBRAINZ_RANGES as readonly string[]).includes(value) ? (value as ListenBrainzRange) : null;
}

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'half_year' | 'year';

/** Start of the calendar unit holding `tMs`; weeks start on Monday 00:00 UTC. */
function unitStart(unit: Unit, tMs: number): number {
  const d = new Date(tMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (unit) {
    case 'day':
      return Date.UTC(y, m, d.getUTCDate());
    case 'week':
      // getUTCDay: Sunday 0 … Saturday 6; days since Monday = (day + 6) % 7.
      return Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    case 'month':
      return Date.UTC(y, m, 1);
    case 'quarter':
      return Date.UTC(y, m - (m % 3), 1);
    case 'half_year':
      return Date.UTC(y, m - (m % 6), 1);
    case 'year':
      return Date.UTC(y, 0, 1);
  }
}

/** `startMs` (a unit start) moved by `n` units. */
function addUnits(unit: Unit, startMs: number, n: number): number {
  const d = new Date(startMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (unit) {
    case 'day':
      return Date.UTC(y, m, day + n);
    case 'week':
      return Date.UTC(y, m, day + 7 * n);
    case 'month':
      return Date.UTC(y, m + n, 1);
    case 'quarter':
      return Date.UTC(y, m + 3 * n, 1);
    case 'half_year':
      return Date.UTC(y, m + 6 * n, 1);
    case 'year':
      return Date.UTC(y + n, 0, 1);
  }
}

const RANGE_UNIT: Readonly<Record<Exclude<ListenBrainzRange, 'all_time'>, { unit: Unit; current: boolean }>> = {
  this_week: { unit: 'week', current: true },
  this_month: { unit: 'month', current: true },
  this_year: { unit: 'year', current: true },
  week: { unit: 'week', current: false },
  month: { unit: 'month', current: false },
  quarter: { unit: 'quarter', current: false },
  half_yearly: { unit: 'half_year', current: false },
  year: { unit: 'year', current: false },
};

/**
 * `this_*`: `[start of the current unit, now]`; `week`, `month`, `quarter`,
 * `half_yearly`, `year`: the previous whole unit `[start, end)`; `all_time`:
 * `[2002-01-01, now]`.
 */
export function listenBrainzRangeBounds(range: ListenBrainzRange, nowMs: number): PeriodBounds {
  checkNow(nowMs);
  if (range === 'all_time') return { lowerMs: LISTENBRAINZ_ALL_TIME_START_MS, upperMs: nowMs, upperInclusive: true };
  const { unit, current } = RANGE_UNIT[range];
  const currentStart = unitStart(unit, nowMs);
  if (current) return { lowerMs: currentStart, upperMs: nowMs, upperInclusive: true };
  return { lowerMs: addUnits(unit, currentStart, -1), upperMs: currentStart, upperInclusive: false };
}

// ---------------------------------------------------------------------------
// ListenBrainz listening activity
// ---------------------------------------------------------------------------

export type ActivityBucketUnit = 'day' | 'month' | 'year';
export type ActivityLabelFormat = '%A %d %B %Y' | '%d %B %Y' | '%B %Y' | '%Y';

export interface ActivityBucket {
  /** Inclusive bucket start (UTC). */
  readonly fromMs: number;
  /** Exclusive bucket end: the next bucket's start. */
  readonly toMs: number;
  /** `time_range`, the bucket start formatted with the window's pattern. */
  readonly label: string;
}

export interface ListeningActivityWindow extends PeriodBounds {
  readonly range: ListenBrainzRange;
  readonly lowerMs: number;
  readonly bucket: ActivityBucketUnit;
  readonly format: ActivityLabelFormat;
  /** Oldest first, contiguous, covering the window. */
  readonly buckets: readonly ActivityBucket[];
  /** `all_time` lists only the years that hold listens. */
  readonly omitEmptyBuckets: boolean;
}

const ACTIVITY_SHAPE: Readonly<Record<ListenBrainzRange, { bucket: ActivityBucketUnit; format: ActivityLabelFormat }>> =
  {
    week: { bucket: 'day', format: '%A %d %B %Y' },
    this_week: { bucket: 'day', format: '%A %d %B %Y' },
    month: { bucket: 'day', format: '%d %B %Y' },
    this_month: { bucket: 'day', format: '%d %B %Y' },
    quarter: { bucket: 'day', format: '%d %B %Y' },
    half_yearly: { bucket: 'month', format: '%B %Y' },
    year: { bucket: 'month', format: '%B %Y' },
    this_year: { bucket: 'month', format: '%B %Y' },
    all_time: { bucket: 'year', format: '%Y' },
  };

export const WEEKDAYS_MONDAY_FIRST = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export type Weekday = (typeof WEEKDAYS_MONDAY_FIRST)[number];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Monday 0 … Sunday 6 for an instant (UTC). */
function mondayIndex(tMs: number): number {
  return (new Date(tMs).getUTCDay() + 6) % 7;
}

/** The ListenBrainz `time_range` label of a UTC instant (C locale, zero-padded `%d`). */
export function formatActivityLabel(tMs: number, format: ActivityLabelFormat): string {
  const d = new Date(tMs);
  const year = String(d.getUTCFullYear());
  const month = MONTH_NAMES[d.getUTCMonth()]!;
  const day = String(d.getUTCDate()).padStart(2, '0');
  switch (format) {
    case '%A %d %B %Y':
      return `${WEEKDAYS_MONDAY_FIRST[mondayIndex(tMs)]!} ${day} ${month} ${year}`;
    case '%d %B %Y':
      return `${day} ${month} ${year}`;
    case '%B %Y':
      return `${month} ${year}`;
    case '%Y':
      return year;
  }
}

/**
 * The listening-activity window of a range: the range and the one before it
 * (`all_time`: every year from 2002), with its aligned buckets and labels.
 */
export function listeningActivityWindow(range: ListenBrainzRange, nowMs: number): ListeningActivityWindow {
  checkNow(nowMs);
  const { bucket, format } = ACTIVITY_SHAPE[range];
  let lowerMs: number;
  let upperMs: number;
  let upperInclusive: boolean;
  if (range === 'all_time') {
    lowerMs = LISTENBRAINZ_ALL_TIME_START_MS;
    upperMs = nowMs;
    upperInclusive = true;
  } else {
    const bounds = listenBrainzRangeBounds(range, nowMs);
    lowerMs = addUnits(RANGE_UNIT[range].unit, bounds.lowerMs!, -1);
    upperMs = bounds.upperMs;
    upperInclusive = bounds.upperInclusive;
  }
  const buckets: ActivityBucket[] = [];
  for (let from = unitStart(bucket, lowerMs); upperInclusive ? from <= upperMs : from < upperMs; ) {
    const to = addUnits(bucket, from, 1);
    buckets.push({ fromMs: from, toMs: to, label: formatActivityLabel(from, format) });
    from = to;
  }
  return { range, lowerMs, upperMs, upperInclusive, bucket, format, buckets, omitEmptyBuckets: range === 'all_time' };
}

// ---------------------------------------------------------------------------
// ListenBrainz daily activity
// ---------------------------------------------------------------------------

export interface DailyActivityHour {
  readonly hour: number;
  readonly listen_count: number;
}

/** `{Monday: [{hour: 0..23, listen_count}], …, Sunday: […]}`, keys in Monday-first order. */
export type DailyActivity = Record<Weekday, DailyActivityHour[]>;

/** The (weekday, hour) cell of a UTC instant. */
export function dailyActivityCell(tMs: number): { day: Weekday; hour: number } {
  if (!Number.isFinite(tMs)) throw new RangeError(`instant must be finite epoch ms, got ${tMs}`);
  return { day: WEEKDAYS_MONDAY_FIRST[mondayIndex(tMs)]!, hour: new Date(tMs).getUTCHours() };
}

/**
 * The zero-filled 7 × 24 grid with the given counts added. Cells may repeat (they
 * are summed). An unknown day, an hour outside 0–23 or a count that is not a
 * non-negative safe integer throws.
 */
export function dailyActivityGrid(
  cells: Iterable<{ readonly day: Weekday; readonly hour: number; readonly count: number }> = [],
): DailyActivity {
  const counts = new Map<Weekday, number[]>(WEEKDAYS_MONDAY_FIRST.map((day) => [day, new Array<number>(24).fill(0)]));
  for (const { day, hour, count } of cells) {
    const row = counts.get(day);
    if (row === undefined) throw new RangeError(`unknown weekday ${String(day)}`);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`hour must be 0–23, got ${hour}`);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new RangeError(`count must be a non-negative integer, got ${count}`);
    const total = row[hour]! + count;
    if (!Number.isSafeInteger(total)) throw new RangeError('daily activity count overflow');
    row[hour] = total;
  }
  const grid = {} as DailyActivity;
  for (const day of WEEKDAYS_MONDAY_FIRST) {
    grid[day] = counts.get(day)!.map((listen_count, hour) => ({ hour, listen_count }));
  }
  return grid;
}
