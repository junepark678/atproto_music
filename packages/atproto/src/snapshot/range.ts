// The snapshot key range (ADR 0004 §5.7 step 3).
//
// Every MST key under a lexicon prefix `p` is `<collection>/<rkey>` with a
// collection `p.<name>`, so all of them fall in the half-open range
// `[p + '.', p + '/')`: `.` is 0x2E and `/` is 0x2F, so nothing sorts between
// them. Look-alike collections (`p-x.…`, `pz.…`) and the bare `p/…` sort
// outside it.
//
// MST keys are restricted to ASCII (the atproto repo-path charset, enforced by
// the walker), so JavaScript's UTF-16 string comparison here coincides with
// the byte order the MST is sorted by.

import { isValidPrefix } from '@atmusic/core/namespace';

/** A half-open key range `[lo, hi)`. A plain tuple, so it serialises as JSON. */
export type KeyRange = readonly [lo: string, hi: string];

/** `[prefix + '.', prefix + '/')`. Throws RangeError for an invalid namespace prefix. */
export function prefixRange(prefix: string): KeyRange {
  if (!isValidPrefix(prefix)) throw new RangeError(`not a valid lexicon prefix: ${JSON.stringify(prefix)}`);
  return [`${prefix}.`, `${prefix}/`];
}

/** `lo <= key < hi`. */
export function inRange(range: KeyRange, key: string): boolean {
  return range[0] <= key && key < range[1];
}

/**
 * Whether a subtree whose keys all lie strictly between `lower` and `upper`
 * (null = unbounded on that side) can hold a key of `range`. Conservative in
 * the safe direction: it never answers false for a subtree that could hold an
 * in-range key, so skipping a subtree on `false` can never drop a record.
 *
 * Keys k of the subtree satisfy lower < k < upper. None is ≥ hi when
 * lower ≥ hi, and none is ≥ lo when upper ≤ lo.
 */
export function overlaps(range: KeyRange, lower: string | null, upper: string | null): boolean {
  return (lower === null || lower < range[1]) && (upper === null || upper > range[0]);
}
