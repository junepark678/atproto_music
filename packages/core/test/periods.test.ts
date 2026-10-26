// N1-12: Last.fm and ListenBrainz statistics periods (ADR 0005 §10.1, §8.5).
// Expected instants are hardcoded; the frozen clock is 2026-01-15T12:00:00Z
// (a Thursday).

import {
  dailyActivityCell,
  dailyActivityGrid,
  inBounds,
  LASTFM_WEEK_SECONDS,
  lastfmPeriodBounds,
  lastfmWeeklyChartList,
  lastfmWeeklyChartRange,
  lastfmWeekStart,
  listenBrainzRangeBounds,
  listeningActivityWindow,
  type PeriodBounds,
  parseLastfmPeriod,
  parseListenBrainzRange,
  WEEKDAYS_MONDAY_FIRST,
} from '@atmusic/core/periods';
import { FIXTURE_NOW_ISO, fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';

const NOW = fixedClock().nowMs();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);
const show = (b: PeriodBounds) => ({ lower: iso(b.lowerMs), upper: iso(b.upperMs), upperInclusive: b.upperInclusive });

it('at 2026-01-15T12:00:00Z 7day/1month/3month/6month/12month lower bounds are 2026-01-08, 2025-12-16, 2025-10-17, 2025-07-19 and 2025-01-15 at 12:00Z', () => {
  expect(FIXTURE_NOW_ISO).toBe('2026-01-15T12:00:00Z');
  expect(NOW).toBe(1_768_478_400_000);
  const expected: Record<string, string> = {
    '7day': '2026-01-08T12:00:00.000Z',
    '1month': '2025-12-16T12:00:00.000Z',
    '3month': '2025-10-17T12:00:00.000Z',
    '6month': '2025-07-19T12:00:00.000Z',
    '12month': '2025-01-15T12:00:00.000Z',
  };
  for (const [name, lower] of Object.entries(expected)) {
    const period = parseLastfmPeriod(name);
    expect(period).toBe(name);
    const bounds = lastfmPeriodBounds(period!, NOW);
    expect(show(bounds)).toEqual({ lower, upper: '2026-01-15T12:00:00.000Z', upperInclusive: true });
    // [now − n d, now]: both ends included, one ms outside on either side excluded.
    expect(inBounds(bounds, at(lower))).toBe(true);
    expect(inBounds(bounds, at(lower) - 1)).toBe(false);
    expect(inBounds(bounds, NOW)).toBe(true);
    expect(inBounds(bounds, NOW + 1)).toBe(false);
  }
  // overall is (−∞, now]; absent means overall; anything else is error 6 (null).
  expect(parseLastfmPeriod(undefined)).toBe('overall');
  expect(show(lastfmPeriodBounds('overall', NOW))).toEqual({
    lower: null,
    upper: '2026-01-15T12:00:00.000Z',
    upperInclusive: true,
  });
  expect(inBounds(lastfmPeriodBounds('overall', NOW), at('2002-10-01T00:00:00Z'))).toBe(true);
  for (const bad of ['', '7days', '1Month', 'week', '30day', ' 7day']) expect(parseLastfmPeriod(bad)).toBeNull();
});

it('at 2026-01-15T12:00:00Z this_week starts 2026-01-12, week is [2026-01-05, 2026-01-12), month [2025-12-01, 2026-01-01), quarter [2025-10-01, 2026-01-01), half_yearly [2025-07-01, 2026-01-01), year [2025-01-01, 2026-01-01)', () => {
  const nowIso = '2026-01-15T12:00:00.000Z';
  const cases: Record<string, ReturnType<typeof show>> = {
    this_week: { lower: '2026-01-12T00:00:00.000Z', upper: nowIso, upperInclusive: true },
    week: { lower: '2026-01-05T00:00:00.000Z', upper: '2026-01-12T00:00:00.000Z', upperInclusive: false },
    this_month: { lower: '2026-01-01T00:00:00.000Z', upper: nowIso, upperInclusive: true },
    month: { lower: '2025-12-01T00:00:00.000Z', upper: '2026-01-01T00:00:00.000Z', upperInclusive: false },
    quarter: { lower: '2025-10-01T00:00:00.000Z', upper: '2026-01-01T00:00:00.000Z', upperInclusive: false },
    half_yearly: { lower: '2025-07-01T00:00:00.000Z', upper: '2026-01-01T00:00:00.000Z', upperInclusive: false },
    this_year: { lower: '2026-01-01T00:00:00.000Z', upper: nowIso, upperInclusive: true },
    year: { lower: '2025-01-01T00:00:00.000Z', upper: '2026-01-01T00:00:00.000Z', upperInclusive: false },
    all_time: { lower: '2002-01-01T00:00:00.000Z', upper: nowIso, upperInclusive: true },
  };
  for (const [name, expected] of Object.entries(cases)) {
    const range = parseListenBrainzRange(name);
    expect(range).toBe(name);
    expect(show(listenBrainzRangeBounds(range!, NOW))).toEqual(expected);
  }
  // Half-open previous ranges: the upper instant belongs to the next range.
  const week = listenBrainzRangeBounds('week', NOW);
  expect(inBounds(week, at('2026-01-12T00:00:00Z') - 1)).toBe(true);
  expect(inBounds(week, at('2026-01-12T00:00:00Z'))).toBe(false);
  // Anchored on now, not on the latest listen, and no "Monday means last week" quirk.
  const monday = at('2026-01-12T00:00:00Z');
  expect(show(listenBrainzRangeBounds('this_week', monday)).lower).toBe('2026-01-12T00:00:00.000Z');
  expect(show(listenBrainzRangeBounds('week', monday)).lower).toBe('2026-01-05T00:00:00.000Z');
  // Mid-year: the previous half is Jan–Jun and the previous quarter Apr–Jun.
  const august = at('2025-08-20T08:00:00Z');
  expect(show(listenBrainzRangeBounds('half_yearly', august))).toMatchObject({
    lower: '2025-01-01T00:00:00.000Z',
    upper: '2025-07-01T00:00:00.000Z',
  });
  expect(show(listenBrainzRangeBounds('quarter', august))).toMatchObject({
    lower: '2025-04-01T00:00:00.000Z',
    upper: '2025-07-01T00:00:00.000Z',
  });
  // Absent means all_time; an unknown value is the 400 "Invalid range" (null).
  expect(parseListenBrainzRange(undefined)).toBe('all_time');
  for (const bad of ['', 'All_time', 'alltime', 'last_week', 'this-week', 'day']) {
    expect(parseListenBrainzRange(bad)).toBeNull();
  }
});

it("listening-activity for week has 14 day buckets labelled '%A %d %B %Y' and for year 24 month buckets labelled '%B %Y'; daily-activity is 7 x 24 Monday-first", () => {
  const contiguous = (w: ReturnType<typeof listeningActivityWindow>) =>
    w.buckets.every((b, i) => b.fromMs < b.toMs && (i === 0 || w.buckets[i - 1]!.toMs === b.fromMs));

  const week = listeningActivityWindow('week', NOW);
  expect(week.bucket).toBe('day');
  expect(week.format).toBe('%A %d %B %Y');
  expect(week.buckets).toHaveLength(14);
  expect(contiguous(week)).toBe(true);
  expect(iso(week.lowerMs)).toBe('2025-12-29T00:00:00.000Z');
  expect(iso(week.upperMs)).toBe('2026-01-12T00:00:00.000Z');
  expect(week.upperInclusive).toBe(false);
  expect(iso(week.buckets[0]!.fromMs)).toBe('2025-12-29T00:00:00.000Z');
  expect(iso(week.buckets[13]!.toMs)).toBe('2026-01-12T00:00:00.000Z');
  expect(week.buckets.map((b) => b.label)).toEqual([
    'Monday 29 December 2025',
    'Tuesday 30 December 2025',
    'Wednesday 31 December 2025',
    'Thursday 01 January 2026',
    'Friday 02 January 2026',
    'Saturday 03 January 2026',
    'Sunday 04 January 2026',
    'Monday 05 January 2026',
    'Tuesday 06 January 2026',
    'Wednesday 07 January 2026',
    'Thursday 08 January 2026',
    'Friday 09 January 2026',
    'Saturday 10 January 2026',
    'Sunday 11 January 2026',
  ]);
  expect(week.omitEmptyBuckets).toBe(false);

  // this_week: the previous week plus Monday..Thursday up to now.
  const thisWeek = listeningActivityWindow('this_week', NOW);
  expect(thisWeek.buckets).toHaveLength(11);
  expect(thisWeek.buckets.at(-1)!.label).toBe('Thursday 15 January 2026');
  expect(iso(thisWeek.lowerMs)).toBe('2026-01-05T00:00:00.000Z');
  expect(thisWeek.upperInclusive).toBe(true);

  const year = listeningActivityWindow('year', NOW);
  expect(year.bucket).toBe('month');
  expect(year.format).toBe('%B %Y');
  expect(year.buckets).toHaveLength(24);
  expect(contiguous(year)).toBe(true);
  expect(year.buckets[0]!.label).toBe('January 2024');
  expect(year.buckets[11]!.label).toBe('December 2024');
  expect(year.buckets[23]!.label).toBe('December 2025');
  expect(iso(year.buckets[23]!.toMs)).toBe('2026-01-01T00:00:00.000Z');
  // February 2024 is a 29-day leap month.
  expect(year.buckets[1]!.toMs - year.buckets[1]!.fromMs).toBe(29 * 86_400_000);

  const month = listeningActivityWindow('month', NOW);
  expect(month.format).toBe('%d %B %Y');
  expect(month.buckets).toHaveLength(61); // November (30) + December (31)
  expect(month.buckets[0]!.label).toBe('01 November 2025');
  expect(month.buckets[60]!.label).toBe('31 December 2025');
  expect(listeningActivityWindow('quarter', NOW).buckets).toHaveLength(184); // Jul–Dec 2025
  expect(listeningActivityWindow('half_yearly', NOW).buckets.map((b) => b.label)).toEqual(
    [
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
    ].map((m) => `${m} 2025`),
  );
  expect(
    listeningActivityWindow('this_year', NOW)
      .buckets.map((b) => b.label)
      .slice(-2),
  ).toEqual(['December 2025', 'January 2026']);
  const allTime = listeningActivityWindow('all_time', NOW);
  expect(allTime.format).toBe('%Y');
  expect(allTime.omitEmptyBuckets).toBe(true);
  expect(allTime.buckets.map((b) => b.label)).toEqual(Array.from({ length: 25 }, (_, i) => String(2002 + i)));

  // Daily activity: zero-filled 7 x 24, Monday first, UTC cells.
  const empty = dailyActivityGrid();
  expect(Object.keys(empty)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  expect(WEEKDAYS_MONDAY_FIRST).toEqual(Object.keys(empty));
  for (const day of WEEKDAYS_MONDAY_FIRST) {
    expect(empty[day]).toEqual(Array.from({ length: 24 }, (_, hour) => ({ hour, listen_count: 0 })));
  }
  expect(dailyActivityCell(NOW)).toEqual({ day: 'Thursday', hour: 12 });
  expect(dailyActivityCell(at('2026-01-11T23:59:59.999Z'))).toEqual({ day: 'Sunday', hour: 23 });
  expect(dailyActivityCell(at('2026-01-12T00:00:00Z'))).toEqual({ day: 'Monday', hour: 0 });
  const grid = dailyActivityGrid([
    { ...dailyActivityCell(NOW), count: 2 },
    { ...dailyActivityCell(NOW + 1000), count: 3 },
    { day: 'Monday', hour: 0, count: 1 },
  ]);
  expect(grid.Thursday[12]).toEqual({ hour: 12, listen_count: 5 });
  expect(grid.Monday[0]).toEqual({ hour: 0, listen_count: 1 });
  const total = WEEKDAYS_MONDAY_FIRST.flatMap((d) => grid[d]).reduce((n, c) => n + c.listen_count, 0);
  expect(total).toBe(6);
  expect(() => dailyActivityGrid([{ day: 'Monday', hour: 24, count: 1 }])).toThrow(RangeError);
  expect(() => dailyActivityGrid([{ day: 'Monday', hour: 1, count: -1 }])).toThrow(RangeError);
});

it('weekly chart boundaries fall on Sundays 12:00 UTC and 1108296002 lies in the week starting 2005-02-13T12:00:00Z', () => {
  const start = lastfmWeekStart(1_108_296_002);
  expect(start).toBe(1_108_296_000);
  expect(new Date(start * 1000).toISOString()).toBe('2005-02-13T12:00:00.000Z');
  expect(lastfmWeekStart(1_108_296_000)).toBe(1_108_296_000);
  expect(lastfmWeekStart(1_108_295_999)).toBe(1_108_296_000 - LASTFM_WEEK_SECONDS);
  expect(lastfmWeekStart(1_108_296_000 + LASTFM_WEEK_SECONDS - 1)).toBe(1_108_296_000);

  const nowSeconds = NOW / 1000;
  const weeks = lastfmWeeklyChartList(1_108_296_002, nowSeconds);
  expect(weeks[0]).toEqual({ from: 1_108_296_000, to: 1_108_900_800 });
  // The current week, which holds now (Thursday), starts Sunday 2026-01-11 12:00.
  expect(weeks.at(-1)).toEqual({ from: at('2026-01-11T12:00:00Z') / 1000, to: at('2026-01-18T12:00:00Z') / 1000 });
  expect(weeks).toHaveLength((weeks.at(-1)!.from - 1_108_296_000) / LASTFM_WEEK_SECONDS + 1);
  for (const [i, w] of weeks.entries()) {
    for (const edge of [w.from, w.to]) {
      const d = new Date(edge * 1000);
      expect([d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]).toEqual([0, 12, 0, 0]);
    }
    if (i > 0) expect(w.from).toBe(weeks[i - 1]!.to);
  }
  expect(lastfmWeeklyChartList(null, nowSeconds)).toEqual([]);

  // Without from/to: the last complete week [2026-01-04T12:00, 2026-01-11T12:00).
  const defaultRange = lastfmWeeklyChartRange(undefined, undefined, nowSeconds)!;
  expect(defaultRange.week).toEqual({ from: 1_767_528_000, to: 1_768_132_800 });
  expect(show(defaultRange.bounds)).toEqual({
    lower: '2026-01-04T12:00:00.000Z',
    upper: '2026-01-11T12:00:00.000Z',
    upperInclusive: false,
  });
  // Explicit from/to select [from, to); one alone or a malformed value is error 6.
  const explicit = lastfmWeeklyChartRange('1108296000', '1108900800', nowSeconds)!;
  expect(explicit.week).toEqual({ from: 1_108_296_000, to: 1_108_900_800 });
  expect(inBounds(explicit.bounds, 1_108_296_002_000)).toBe(true);
  expect(inBounds(explicit.bounds, 1_108_900_800_000)).toBe(false);
  expect(lastfmWeeklyChartRange('1108296000', undefined, nowSeconds)).toBeNull();
  expect(lastfmWeeklyChartRange(undefined, '1108900800', nowSeconds)).toBeNull();
  expect(lastfmWeeklyChartRange('-1', '1108900800', nowSeconds)).toBeNull();
  expect(lastfmWeeklyChartRange('1108296000.5', '1108900800', nowSeconds)).toBeNull();
});
