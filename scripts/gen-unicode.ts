// Regenerates the vendored Unicode tables used by @atmusic/core/music-key (W1-02,
// ADR 0004 §5.8 / §9.1 grouping, §13 item 5).
//
//   npx tsx scripts/gen-unicode.ts           rewrite the generated files
//   npx tsx scripts/gen-unicode.ts --check   exit 1 if a generated file is stale
//
// Inputs:
// - packages/core/data/CaseFolding-16.0.0.txt, vendored byte-for-byte from
//   https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt (identical to the
//   CaseFolding.txt shipped in the `caseless` 0.2.2 crate the Rust oracle uses);
// - the White_Space lines of PropList-16.0.0.txt, embedded verbatim below
//   (https://www.unicode.org/Public/16.0.0/ucd/PropList.txt);
// - packages/core/data/DerivedAge-16.0.0.txt, vendored byte-for-byte from
//   https://www.unicode.org/Public/16.0.0/ucd/DerivedAge.txt.
//
// Outputs:
// - packages/core/src/unicode/casefold-16.0.0.ts: the status C and F mappings,
//   that is full default (non-Turkic) case folding; S and T rows are dropped;
// - packages/core/src/unicode/white-space.ts: the White_Space set plus the trim
//   and collapse helpers built on it;
// - packages/core/src/unicode/assigned-16.0.0.ts: the code points assigned in
//   Unicode 16.0.0 (every DerivedAge line, merged). The runtime's NFKC may be a
//   newer Unicode version; music-key passes it only text assigned in 16.0.0, for
//   which normalization stability guarantees the Unicode 16.0.0 result.
//
// The render functions are pure so packages/core/test/unicode-runtime.test.ts can
// call them inside workerd and compare the result with the committed files.

export const CASE_FOLDING_DATA_PATH = 'packages/core/data/CaseFolding-16.0.0.txt';
export const CASE_FOLD_OUTPUT_PATH = 'packages/core/src/unicode/casefold-16.0.0.ts';
export const WHITE_SPACE_OUTPUT_PATH = 'packages/core/src/unicode/white-space.ts';
export const DERIVED_AGE_DATA_PATH = 'packages/core/data/DerivedAge-16.0.0.txt';
export const ASSIGNED_OUTPUT_PATH = 'packages/core/src/unicode/assigned-16.0.0.ts';

export const UNICODE_VERSION = '16.0.0';

/** The White_Space block of PropList-16.0.0.txt, copied verbatim. */
export const PROPLIST_WHITE_SPACE_EXCERPT = `# PropList-16.0.0.txt
# Date: 2024-05-31, 18:09:48 GMT

0009..000D    ; White_Space # Cc   [5] <control-0009>..<control-000D>
0020          ; White_Space # Zs       SPACE
0085          ; White_Space # Cc       <control-0085>
00A0          ; White_Space # Zs       NO-BREAK SPACE
1680          ; White_Space # Zs       OGHAM SPACE MARK
2000..200A    ; White_Space # Zs  [11] EN QUAD..HAIR SPACE
2028          ; White_Space # Zl       LINE SEPARATOR
2029          ; White_Space # Zp       PARAGRAPH SEPARATOR
202F          ; White_Space # Zs       NARROW NO-BREAK SPACE
205F          ; White_Space # Zs       MEDIUM MATHEMATICAL SPACE
3000          ; White_Space # Zs       IDEOGRAPHIC SPACE

# Total code points: 25
`;

export interface CaseFoldingRow {
  readonly source: number;
  readonly status: 'C' | 'F' | 'S' | 'T';
  readonly mapping: readonly number[];
  readonly name: string;
}

export interface ParsedCaseFolding {
  readonly fileName: string;
  readonly date: string;
  readonly rows: readonly CaseFoldingRow[];
}

const HEX = /^[0-9A-F]{4,6}$/;

function parseCodePoint(text: string, line: number): number {
  if (!HEX.test(text)) throw new Error(`line ${line}: bad code point ${JSON.stringify(text)}`);
  const cp = Number.parseInt(text, 16);
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error(`line ${line}: not a scalar value ${text}`);
  return cp;
}

/** Strict parser for the UCD CaseFolding.txt format; refuses anything unexpected. */
export function parseCaseFolding(text: string): ParsedCaseFolding {
  const lines = text.split('\n');
  const fileName = /^# (CaseFolding-\d+\.\d+\.\d+\.txt)$/.exec(lines[0] ?? '')?.[1];
  const date = /^# Date: (.+)$/.exec(lines[1] ?? '')?.[1];
  if (fileName !== `CaseFolding-${UNICODE_VERSION}.txt` || date === undefined) {
    throw new Error(`expected a CaseFolding-${UNICODE_VERSION}.txt header, got ${JSON.stringify(lines[0])}`);
  }
  const rows: CaseFoldingRow[] = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw === '' || raw.startsWith('#')) return;
    const m = /^([0-9A-F]{4,6}); ([CFST]); ([0-9A-F]{4,6}(?: [0-9A-F]{4,6}){0,2}); # (.+)$/.exec(raw);
    if (m === null) throw new Error(`line ${line}: malformed ${JSON.stringify(raw)}`);
    const [, source, status, mapping, name] = m as unknown as [
      string,
      string,
      CaseFoldingRow['status'],
      string,
      string,
    ];
    rows.push({
      source: parseCodePoint(source, line),
      status,
      mapping: mapping.split(' ').map((cp) => parseCodePoint(cp, line)),
      name,
    });
  });
  if (rows.length === 0) throw new Error('no CaseFolding rows');
  return { fileName, date, rows };
}

/** The status C+F rows, in ascending source order, with no duplicate source. */
export function fullCaseFoldingRows(parsed: ParsedCaseFolding): CaseFoldingRow[] {
  const rows = parsed.rows.filter((row) => row.status === 'C' || row.status === 'F');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1]!.source >= rows[i]!.source) {
      throw new Error(`C+F rows not strictly ascending at U+${hex(rows[i]!.source)}`);
    }
  }
  return rows;
}

function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

function lit(cp: number): string {
  return `0x${hex(cp)}`;
}

export function renderCaseFold(caseFoldingText: string): string {
  const parsed = parseCaseFolding(caseFoldingText);
  const rows = fullCaseFoldingRows(parsed);
  const body = rows.map((row) => `  [${[row.source, ...row.mapping].map(lit).join(', ')}],`).join('\n');
  const full = rows.filter((row) => row.status === 'F').length;
  return `// GENERATED by scripts/gen-unicode.ts from ${CASE_FOLDING_DATA_PATH}. Do not edit.
// Regenerate with \`npx tsx scripts/gen-unicode.ts\`; \`--check\` verifies it is current.
//
// Source: ${parsed.fileName} (Date: ${parsed.date}).
// Rows with status C (common, ${rows.length - full}) and F (full, ${full}) only: S and T are excluded,
// which is the full, non-Turkic default case folding (toCasefold) that the Rust
// oracle's \`caseless\` crate applies.

export const CASE_FOLDING_UNICODE_VERSION = '${UNICODE_VERSION}';

/** Each row is [source code point, ...folded code points], strictly ascending by source. */
// biome-ignore format: generated table, one CaseFolding row per line
export const CASE_FOLDING_C_F: readonly (readonly number[])[] = [
${body}
];
`;
}

/** Parses the embedded PropList excerpt into inclusive [first, last] ranges. */
export function whiteSpaceRanges(excerpt: string = PROPLIST_WHITE_SPACE_EXCERPT): [number, number][] {
  const ranges: [number, number][] = [];
  let total = 0;
  for (const raw of excerpt.split('\n')) {
    const m = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s+; White_Space #/.exec(raw);
    if (m === null) continue;
    const first = parseCodePoint(m[1]!, 0);
    const last = m[2] === undefined ? first : parseCodePoint(m[2], 0);
    // The helpers scan UTF-16 code units, which is exact only for BMP members.
    if (last > 0xffff || last < first) throw new Error(`unexpected White_Space range ${raw}`);
    const prev = ranges.at(-1);
    if (prev !== undefined && prev[1] >= first) throw new Error('White_Space ranges not ascending');
    ranges.push([first, last]);
    total += last - first + 1;
  }
  const declared = /# Total code points: (\d+)/.exec(excerpt)?.[1];
  if (declared === undefined || Number(declared) !== total) {
    throw new Error(`White_Space excerpt total ${declared} != parsed ${total}`);
  }
  return ranges;
}

export function renderWhiteSpace(excerpt: string = PROPLIST_WHITE_SPACE_EXCERPT): string {
  const header = /^# (PropList-[\d.]+\.txt)\n# Date: (.+)$/m.exec(excerpt);
  if (header === null || header[1] !== `PropList-${UNICODE_VERSION}.txt`) throw new Error('bad PropList header');
  const ranges = whiteSpaceRanges(excerpt);
  const body = ranges.map(([a, b]) => `  [${lit(a)}, ${lit(b)}],`).join('\n');
  return `// GENERATED by scripts/gen-unicode.ts from the White_Space lines of ${header[1]}
// (Date: ${header[2]}). Do not edit; \`npx tsx scripts/gen-unicode.ts --check\` verifies it.
//
// This is the set Rust's char::is_whitespace, str::trim and str::split_whitespace
// use. Every member is a BMP code point outside the surrogate range, so scanning
// UTF-16 code units is exact. Never use String.prototype.trim or \\s instead: both
// include U+FEFF, which is not White_Space, and omit U+0085, which is.

export const WHITE_SPACE_UNICODE_VERSION = '${UNICODE_VERSION}';

/** Inclusive [first, last] code point ranges with the White_Space property. */
// biome-ignore format: generated table
export const WHITE_SPACE_RANGES: readonly (readonly [number, number])[] = [
${body}
];

const MEMBERS: ReadonlySet<number> = new Set(
  WHITE_SPACE_RANGES.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i)),
);

/** True when the code point (or UTF-16 code unit) has the White_Space property. */
export function isWhiteSpace(cp: number): boolean {
  return MEMBERS.has(cp);
}

/** Removes leading and trailing White_Space, like Rust \`str::trim\`. */
export function trimWhiteSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && MEMBERS.has(s.charCodeAt(start))) start++;
  while (end > start && MEMBERS.has(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/**
 * Trims White_Space and collapses every inner run of it to one U+0020, like Rust
 * \`s.split_whitespace().collect::<Vec<_>>().join(" ")\`.
 */
export function collapseWhiteSpace(s: string): string {
  let out = '';
  let pendingSpace = false;
  let segmentStart = -1;
  for (let i = 0; i < s.length; i++) {
    if (MEMBERS.has(s.charCodeAt(i))) {
      if (segmentStart >= 0) {
        out += s.slice(segmentStart, i);
        segmentStart = -1;
        pendingSpace = true;
      }
    } else if (segmentStart < 0) {
      if (pendingSpace) out += ' ';
      pendingSpace = false;
      segmentStart = i;
    }
  }
  if (segmentStart >= 0) out += s.slice(segmentStart);
  return out;
}
`;
}

export interface ParsedDerivedAge {
  readonly fileName: string;
  readonly date: string;
  /** Inclusive [first, last] ranges of every listed line, in file order. */
  readonly lines: readonly (readonly [number, number])[];
}

/**
 * Strict parser for the UCD DerivedAge.txt format. Every section total must equal
 * the sum of its lines, no age may exceed ${UNICODE_VERSION}, and no code point
 * may be listed twice.
 */
export function parseDerivedAge(text: string): ParsedDerivedAge {
  const lines = text.split('\n');
  const fileName = /^# (DerivedAge-\d+\.\d+\.\d+\.txt)$/.exec(lines[0] ?? '')?.[1];
  const date = /^# Date: (.+)$/.exec(lines[1] ?? '')?.[1];
  if (fileName !== `DerivedAge-${UNICODE_VERSION}.txt` || date === undefined) {
    throw new Error(`expected a DerivedAge-${UNICODE_VERSION}.txt header, got ${JSON.stringify(lines[0])}`);
  }
  const [major, minor] = UNICODE_VERSION.split('.').map(Number) as [number, number];
  const out: [number, number][] = [];
  let sectionAge: string | undefined;
  let sectionTotal = 0;
  let sections = 0;
  lines.forEach((raw, index) => {
    const line = index + 1;
    const age = /^# Age=V(\d+)_(\d+)$/.exec(raw);
    if (age !== null) {
      if (sectionAge !== undefined) throw new Error(`line ${line}: Age section without a total`);
      const [a, b] = [Number(age[1]), Number(age[2])];
      if (a > major || (a === major && b > minor))
        throw new Error(`line ${line}: age ${a}.${b} is newer than ${UNICODE_VERSION}`);
      sectionAge = `${a}.${b}`;
      sectionTotal = 0;
      return;
    }
    const total = /^# Total code points: (\d+)$/.exec(raw);
    if (total !== null) {
      if (sectionAge === undefined || Number(total[1]) !== sectionTotal) {
        throw new Error(`line ${line}: Age ${sectionAge} total ${total[1]} != parsed ${sectionTotal}`);
      }
      sectionAge = undefined;
      sections++;
      return;
    }
    if (raw === '' || raw.startsWith('#')) return;
    const m = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))? *; (\d+\.\d+) +# .+$/.exec(raw);
    if (m === null || sectionAge === undefined || m[3] !== sectionAge) {
      throw new Error(`line ${line}: malformed or out-of-section ${JSON.stringify(raw)}`);
    }
    // Surrogates are listed (Age 2.0); they are code points, not scalar values.
    const first = Number.parseInt(m[1]!, 16);
    const last = m[2] === undefined ? first : Number.parseInt(m[2], 16);
    if (last < first || last > 0x10ffff) throw new Error(`line ${line}: bad range ${raw}`);
    out.push([first, last]);
    sectionTotal += last - first + 1;
  });
  if (sectionAge !== undefined || sections === 0) throw new Error('DerivedAge: unterminated or missing Age section');
  return { fileName, date, lines: out };
}

/** The listed ranges sorted and merged where adjacent; throws on any overlap. */
export function assignedRanges(parsed: ParsedDerivedAge): [number, number][] {
  const sorted = [...parsed.lines].sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [first, last] of sorted) {
    const prev = merged.at(-1);
    if (prev !== undefined && first <= prev[1]) throw new Error(`DerivedAge lists U+${hex(first)} twice`);
    if (prev !== undefined && first === prev[1] + 1) prev[1] = last;
    else merged.push([first, last]);
  }
  return merged;
}

export function renderAssigned(derivedAgeText: string): string {
  const parsed = parseDerivedAge(derivedAgeText);
  const ranges = assignedRanges(parsed);
  const count = ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  const body = ranges.map(([a, b]) => `  [${lit(a)}, ${lit(b)}],`).join('\n');
  return `// GENERATED by scripts/gen-unicode.ts from ${DERIVED_AGE_DATA_PATH}. Do not edit.
// Regenerate with \`npx tsx scripts/gen-unicode.ts\`; \`--check\` verifies it is current.
//
// Source: ${parsed.fileName} (Date: ${parsed.date}).
// The ${count} code points assigned as of Unicode ${UNICODE_VERSION} (graphic, format,
// control, private-use, noncharacter and surrogate), in ${ranges.length} merged ranges.
//
// A code point outside this set is unassigned in Unicode ${UNICODE_VERSION}: it has no
// decomposition, canonical combining class 0 and takes part in no composition, so
// in Unicode ${UNICODE_VERSION} NFKC it is left as is and is a normalization boundary.
// A newer runtime may already assign it (Unicode 17 ICU in workerd maps U+A7F1 to "s"), so
// music-key never hands such a code point to String.prototype.normalize.

export const ASSIGNED_UNICODE_VERSION = '${UNICODE_VERSION}';

/** Inclusive [first, last] ranges of assigned code points, ascending and disjoint. */
// biome-ignore format: generated table
export const ASSIGNED_RANGES: readonly (readonly [number, number])[] = [
${body}
];

/** Every code point at or below this one is assigned (fast path for common text). */
export const ASSIGNED_PREFIX_END = ${lit(ranges[0]![1])};

/** True when the code point is assigned in Unicode ${UNICODE_VERSION}. */
export function isAssigned(cp: number): boolean {
  if (cp <= ASSIGNED_PREFIX_END) return cp >= 0;
  let lo = 1;
  let hi = ASSIGNED_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [first, last] = ASSIGNED_RANGES[mid]!;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return true;
  }
  return false;
}
`;
}

export interface RenderedFile {
  readonly path: string;
  readonly content: string;
}

export function renderAll(caseFoldingText: string, derivedAgeText: string): RenderedFile[] {
  return [
    { path: CASE_FOLD_OUTPUT_PATH, content: renderCaseFold(caseFoldingText) },
    { path: WHITE_SPACE_OUTPUT_PATH, content: renderWhiteSpace() },
    { path: ASSIGNED_OUTPUT_PATH, content: renderAssigned(derivedAgeText) },
  ];
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`usage: npx tsx scripts/gen-unicode.ts [--check] (unknown: ${unknown.join(' ')})`);
    return 2;
  }
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const caseFolding = await readFile(new URL(CASE_FOLDING_DATA_PATH, root), 'utf8');
  const derivedAge = await readFile(new URL(DERIVED_AGE_DATA_PATH, root), 'utf8');
  const stale: string[] = [];
  for (const file of renderAll(caseFolding, derivedAge)) {
    const target = new URL(file.path, root);
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current === file.content) continue;
    stale.push(file.path);
    if (!check) await writeFile(target, file.content);
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`stale generated Unicode tables (run npx tsx scripts/gen-unicode.ts):\n  ${stale.join('\n  ')}`);
      return 1;
    }
    console.log('generated Unicode tables are up to date');
    return 0;
  }
  console.log(stale.length > 0 ? `wrote ${stale.join(', ')}` : 'generated Unicode tables already up to date');
  return 0;
}

// Run only as the tsx entry point; the test imports the pure renderers above.
const entry = typeof process === 'undefined' ? undefined : process.argv?.[1];
if (entry !== undefined && /(?:^|[\\/])gen-unicode\.ts$/.test(entry)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
