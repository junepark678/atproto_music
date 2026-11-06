// Code-point (equivalently UTF-8 byte) string order, ADR 0004 §5.8 "Ordering".
//
// SQLite BINARY collation compares UTF-8 bytes, and Rust `str`/`String` `Ord`
// does the same; both equal Unicode code-point order. JavaScript's `<`,
// `localeCompare` and the default `Array.prototype.sort` compare UTF-16 code
// units instead, which puts every astral character (U+10000..) *below*
// U+E000..U+FFFF. Any JavaScript-side sort of keys, URIs or display strings that
// must agree with SQL or the Rust oracle uses these functions.

export type Ordering = -1 | 0 | 1;

/**
 * Compares two strings in code-point order. Defined for every string; for
 * well-formed UTF-16 it equals the order of their UTF-8 encodings.
 *
 * At the first differing code unit, when both units are >= U+D800, surrogates
 * (D800..DFFF, the leading units of astral code points) are moved above
 * E000..FFFF. That one monotone remap turns UTF-16 unit order into code-point
 * order without decoding the strings.
 */
export function compareCodePoints(a: string, b: string): Ordering {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/**
 * Lexicographic order of string tuples by `compareCodePoints`, like Rust's derived
 * `Ord` on `(ArtistKey, String)` and SQL `ORDER BY artist_key, track_key`.
 * A proper prefix sorts first.
 */
export function compareCodePointTuples(a: readonly string[], b: readonly string[]): Ordering {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareCodePoints(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
