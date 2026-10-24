/// <reference types="vite/client" />
// W1-02: the runtime half of the Unicode pipeline (ADR 0004 §13 item 5). NFKC is
// not vendored; it comes from workerd's ICU, which may be a newer Unicode version
// than the 16.0.0 oracle (workerd's ICU is Unicode 17 and maps the then-unassigned
// U+A7F1 to "s"). normalizeMusic therefore hands ICU only code points assigned in
// Unicode 16.0.0. This suite runs inside workerd and fails loudly if the pipeline
// differs from the Rust oracle for any corpus entry or, exhaustively, for any
// Unicode scalar value in five contexts. It also proves the vendored case-folding,
// White_Space and assigned tables are exactly what scripts/gen-unicode.ts renders.

import {
  albumKey,
  artistKey,
  caseFold,
  musicKeyId,
  nfkcRuntimeSupportsGroupingVersion,
  normalizeMusic,
  trackKey,
} from '@atmusic/core/music-key';
import {
  ASSIGNED_PREFIX_END,
  ASSIGNED_RANGES,
  ASSIGNED_UNICODE_VERSION,
  isAssigned,
} from '@atmusic/core/unicode/assigned-16.0.0';
import { CASE_FOLDING_C_F, CASE_FOLDING_UNICODE_VERSION } from '@atmusic/core/unicode/casefold-16.0.0';
import {
  collapseWhiteSpace,
  isWhiteSpace,
  trimWhiteSpace,
  WHITE_SPACE_RANGES,
  WHITE_SPACE_UNICODE_VERSION,
} from '@atmusic/core/unicode/white-space';
import { expect, it } from 'vitest';
import musicKeysRaw from '../../../tests/goldens/music_keys.json?raw';
import caseFoldingTxt from '../data/CaseFolding-16.0.0.txt?raw';
import derivedAgeTxt from '../data/DerivedAge-16.0.0.txt?raw';
import assignedTs from '../src/unicode/assigned-16.0.0.ts?raw';
import caseFoldTs from '../src/unicode/casefold-16.0.0.ts?raw';
import whiteSpaceTs from '../src/unicode/white-space.ts?raw';

interface GenUnicode {
  CASE_FOLD_OUTPUT_PATH: string;
  WHITE_SPACE_OUTPUT_PATH: string;
  ASSIGNED_OUTPUT_PATH: string;
  renderCaseFold(text: string): string;
  renderWhiteSpace(excerpt?: string): string;
  renderAssigned(text: string): string;
  renderAll(caseFolding: string, derivedAge: string): { path: string; content: string }[];
  parseCaseFolding(text: string): {
    fileName: string;
    rows: { source: number; status: string; mapping: number[] }[];
  };
}

// The generator lives outside this package's tsconfig root, so it is loaded through
// Vite at runtime rather than through a typed static import.
const gen = Object.values(import.meta.glob('../../../scripts/gen-unicode.ts', { eager: true }))[0] as GenUnicode;

/**
 * NFKC alone (before case folding and White_Space handling) of every
 * music_keys.json corpus entry, from the Rust oracle's `unicode-normalization`
 * 0.1.24 crate (Unicode 16.0.0, `input.nfkc()`), cross-checked against Python
 * `unicodedata` 16.0.0. Space-separated hex code points, keyed by entry id.
 */
const NFKC_ORACLE: Readonly<Record<string, string>> = {
  testing_bjork: '0042 006A 00F6 0072 006B',
  testing_bjork_upper_padded: '0020 0020 0042 004A 00D6 0052 004B 0020 0020',
  testing_bjork_decomposed: '0020 0042 004A 00D6 0052 004B 0020',
  testing_bjork_unicode_spaces: '0020 0020 0042 004A 00D6 0052 004B 0020',
  testing_joga: '004A 00F3 0067 0061',
  testing_joga_lower: '006A 00F3 0067 0061',
  testing_joga_decomposed: '0020 006A 00F3 0067 0061 0020',
  testing_homogenic: '0048 006F 006D 006F 0067 0065 006E 0069 0063',
  testing_homogenic_padded_upper: '0020 0048 004F 004D 004F 0047 0045 004E 0049 0043 0020',
  sharp_s: '0053 0074 0072 0061 00DF 0065',
  sharp_s_upper: '0053 0054 0052 0041 0053 0053 0045',
  capital_sharp_s: '1E9E',
  fullwidth_strasse: '0053 0054 0052 0041 0053 0053 0045',
  fullwidth_digits_letters: '0041 0042 0043 0031 0032 0033',
  dotted_capital_i: '0130 0073 0074 0061 006E 0062 0075 006C',
  dotless_small_i: '0131 0073 0074 0061 006E 0062 0075 006C',
  plain_istanbul: '0049 0073 0074 0061 006E 0062 0075 006C',
  fi_ligature: '0066 0069 0073 0068',
  ffl_ligature: '0066 0066 006C',
  kelvin_sign: '004B 0065 006C 0076 0069 006E',
  ascii_kelvin: '004B 0065 006C 0076 0069 006E',
  angstrom_sign: '00C5',
  final_sigma: '03A3 03C2 03C3',
  cherokee_full_fold: 'AB70',
  unicode16_mapping: 'A7CB',
  nel_inside: '004B 0061 0074 0065 0085 0042 0075 0073 0068',
  nel_edges: '0085 004B 0061 0074 0065 0020 0042 0075 0073 0068 0085',
  mixed_whitespace: '004B 0061 0074 0065 0020 0020 0009 000A 0020 2028 0042 0075 0073 0068',
  ascii_kate_bush: '004B 0061 0074 0065 0020 0042 0075 0073 0068',
  bom_leading: 'FEFF 0042 006A 00F6 0072 006B',
  bom_only: 'FEFF',
  zwj_sequence: '1F469 200D 1F3A4',
  zwj_between_letters: '0061 200D 0062',
  zwsp_not_whitespace: '0061 200B 0062',
  mongolian_vowel_separator: '0061 180E 0062',
  unit_separator_not_whitespace: '0061 001F 0062',
  diaeresis_spacing_mark: '0020 0308',
  overline: '0078 0020 0305',
  math_bold_a_astral: '0041',
  deseret_capital_astral: '10400',
  emoji_astral: '1F600',
  first_astral: '10000',
  private_use_e000: 'E000',
  replacement_fffd: 'FFFD',
  noncharacter_ffff: 'FFFF',
  halfwidth_hangul_ffdc: '1175',
  hangul_jamo_extended_d7ff: 'D7FF',
  tuple_separator_ab: '0061 007C 0062',
  tuple_separator_a: '0061',
  prefix_a_space_b: '0061 0020 0062',
  credit_feat:
    '0041 0072 0074 0069 0073 0074 0020 0041 0020 0066 0065 0061 0074 002E 0020 0041 0072 0074 0069 0073 0074 0020 0042',
  credit_plain: '0041 0072 0074 0069 0073 0074 0020 0041',
  whitespace_only: '0020 0009 0020',
  nel_only: '0085',
  nbsp_only: '0020',
  empty: '',
};

/**
 * Exhaustive Rust oracle. For every Unicode scalar value cp (U+0000..U+10FFFF
 * without surrogates) and each context below, Rust `music_key::normalize`
 * (unicode-normalization 0.1.24 + caseless 0.2.2, Unicode 16.0.0) was run on
 * context(cp); every case where the output differs from the input is the line
 * `${CP}\t${output code points}\n` (hex as in hexCodePoints). Lines are grouped by
 * 4096-code-point block (cp >> 12) and each block is recorded as
 * `block:lineCount:first 12 hex digits of SHA-256(lines)`; a block not listed has
 * no such line. The full line set was cross-checked byte-for-byte against Python
 * `unicodedata` 16.0.0 (NFKC, str.casefold, White_Space split/join).
 *
 * The contexts catch single-code-point mappings (bare, cp_cp), canonical
 * reordering across cp (q_acute_cp: ccc(cp) in 1..229 would move it before U+0301;
 * q_cp_acute: ccc(cp) > 230 would move U+0301 before it), and composition with a
 * preceding base or with itself (e_cp, cp_cp). Rust program (crates/core oracle):
 *
 *   for (name, f) in [("bare", |c| c.to_string()), ("q_acute_cp", |c| format!("q\u{301}{c}")),
 *       ("q_cp_acute", |c| format!("q{c}\u{301}")), ("e_cp", |c| format!("e{c}")),
 *       ("cp_cp", |c| format!("{c}{c}"))] {
 *     for c in (0u32..=0x10FFFF).filter_map(char::from_u32) {
 *       let s = f(c); let n = normalize(&s);
 *       if n != s { println!("{name}\t{:04X}\t{}", c as u32, hex(&n)); } } }
 */
const CONTEXTS: readonly [name: string, build: (cp: string) => string][] = [
  ['bare', (c) => c],
  ['q_acute_cp', (c) => `q\u0301${c}`],
  ['q_cp_acute', (c) => `q${c}\u0301`],
  ['e_cp', (c) => `e${c}`],
  ['cp_cp', (c) => c + c],
];
const EXHAUSTIVE_ORACLE: Readonly<Record<string, readonly string[]>> = {
  bare: [
    '0:593:4a14b447338d',
    '1:503:7e3bd2c71082',
    '2:665:774d1e5a108a',
    '3:619:a91c52acebd7',
    'A:220:3812c3ee79ca',
    'F:1539:44c94d5622cc',
    '10:240:c13438631caa',
    '11:32:a4bc225359f4',
    '16:32:ee068f9821e3',
    '1C:36:c565e01f27d0',
    '1D:1009:13a9b526c622',
    '1E:237:99d10ed9d821',
    '1F:146:08847a9e684f',
    '2F:542:c7ee51435988',
  ],
  q_acute_cp: [
    '0:782:85f3aebf2cd1',
    '1:567:4781e3b18a45',
    '2:680:77256f12c832',
    '3:626:7fa9f7b6f9bf',
    'A:232:29b6ab406219',
    'F:1547:fa06abbbfd75',
    '10:259:83ce0447c29f',
    '11:78:9e256a214803',
    '16:40:990cd2094230',
    '1B:1:073a41e29b71',
    '1C:36:c9e8a9e71275',
    '1D:1030:1e3733a52df7',
    '1E:247:4d324a1ded1d',
    '1F:146:0848fe29b0bd',
    '2F:542:0aeab8120f8c',
  ],
  q_cp_acute: [
    '0:646:d10b2a08e0c6',
    '1:519:0691e7711788',
    '2:665:79a9017e2081',
    '3:620:8cc94d299d91',
    'A:220:b9f036b442b4',
    'F:1539:152d63cf1667',
    '10:240:d526bd4b2b17',
    '11:32:a4fb2fb2ed8e',
    '16:32:d56fd8ca545d',
    '1C:36:be7bdee4b412',
    '1D:1009:6c4f0f70ab87',
    '1E:239:6b90f33958a8',
    '1F:146:653a0e6450c5',
    '2F:542:d8e1eecc9caf',
  ],
  e_cp: [
    '0:610:6ca4b286e65d',
    '1:503:c89feaed3f59',
    '2:665:86b0bf5ad10c',
    '3:619:6c1df339a77a',
    'A:220:7483b4f46f22',
    'F:1539:5ecf6f757207',
    '10:240:250b8b17dae8',
    '11:32:4f84054384bb',
    '16:32:e7a4fadabb4e',
    '1C:36:405142f7f24e',
    '1D:1009:cf0ce08814b2',
    '1E:237:28933a191a1a',
    '1F:146:682331edde75',
    '2F:542:88f684274751',
  ],
  cp_cp: [
    '0:593:f03c3c6fe25c',
    '1:503:f983f160f731',
    '2:665:45713e9aa362',
    '3:619:9ab8340f4c9b',
    'A:220:527d47c0e35f',
    'F:1539:a34e8a56bbf7',
    '10:240:309cc6484313',
    '11:33:5854caa5da98',
    '16:34:ae06483ffea9',
    '1C:36:8611bb02916c',
    '1D:1009:2d46f959dc44',
    '1E:237:3f494b90c753',
    '1F:146:1bafe41b8c73',
    '2F:542:04a02bb9674d',
  ],
};
const EXHAUSTIVE_LINE_COUNTS = { bare: 6413, q_acute_cp: 6813, q_cp_acute: 6485, e_cp: 6430, cp_cp: 6416 };

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexCodePoints(s: string): string {
  return Array.from(s, (ch) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
}

const golden = JSON.parse(musicKeysRaw) as {
  unicodeVersion: string;
  entries: { id: string; input: string; normalized: string }[];
};

it('workerd ICU NFKC matches oracle corpus', async () => {
  // This must be the real workerd runtime, not Node's ICU.
  expect(navigator.userAgent).toBe('Cloudflare-Workers');
  expect(golden.unicodeVersion).toBe('16.0.0');
  expect(Object.keys(NFKC_ORACLE)).toEqual(golden.entries.map((e) => e.id));

  const drift: string[] = [];
  for (const entry of golden.entries) {
    const icu = hexCodePoints(entry.input.normalize('NFKC'));
    if (icu !== NFKC_ORACLE[entry.id]) {
      drift.push(`${entry.id}: workerd ICU NFKC [${icu}] != Rust unicode-normalization [${NFKC_ORACLE[entry.id]}]`);
    }
    // The full pipeline on top of ICU must still equal the Rust key.
    if (normalizeMusic(entry.input) !== entry.normalized) {
      drift.push(`${entry.id}: normalizeMusic [${hexCodePoints(normalizeMusic(entry.input))}] != Rust normalize`);
    }
    // NFKC is idempotent; a drifting ICU often breaks this first.
    expect(entry.input.normalize('NFKC').normalize('NFKC')).toBe(entry.input.normalize('NFKC'));
  }
  expect(drift, `ICU drift detected (ADR 0004 §13 item 5):\n${drift.join('\n')}`).toEqual([]);
  expect(golden.entries).toHaveLength(56);

  // Exhaustive: every scalar value in every context equals the Rust oracle.
  expect(Object.keys(EXHAUSTIVE_ORACLE)).toEqual(CONTEXTS.map(([name]) => name));
  const mismatches: string[] = [];
  for (const [name, build] of CONTEXTS) {
    const blocks = new Map<number, string[]>();
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp === 0xd800) cp = 0xe000;
      const input = build(String.fromCodePoint(cp));
      const output = normalizeMusic(input);
      if (output === input) continue;
      const lines = blocks.get(cp >> 12) ?? [];
      lines.push(`${hexCodePoints(String.fromCodePoint(cp))}\t${hexCodePoints(output)}\n`);
      blocks.set(cp >> 12, lines);
    }
    const actual = new Map<number, string>();
    for (const [block, lines] of blocks) {
      actual.set(
        block,
        `${block.toString(16).toUpperCase()}:${lines.length}:${(await sha256Hex(lines.join(''))).slice(0, 12)}`,
      );
    }
    const expected = new Map(
      EXHAUSTIVE_ORACLE[name]!.map((entry) => [Number.parseInt(entry.split(':')[0]!, 16), entry] as const),
    );
    const total = [...blocks.values()].reduce((n, lines) => n + lines.length, 0);
    const expectedTotal = EXHAUSTIVE_LINE_COUNTS[name as keyof typeof EXHAUSTIVE_LINE_COUNTS];
    if (total !== expectedTotal) mismatches.push(`${name}: workerd changes ${total} inputs, Rust ${expectedTotal}`);
    for (const block of new Set([...actual.keys(), ...expected.keys()])) {
      if (actual.get(block) === expected.get(block)) continue;
      // Name the likeliest culprits: changed inputs whose code point Unicode 16.0.0 leaves unassigned.
      const suspects = (blocks.get(block) ?? []).filter((line) => !isAssigned(Number.parseInt(line, 16)));
      mismatches.push(
        `${name} block U+${(block << 12).toString(16).toUpperCase().padStart(4, '0')}: workerd ${actual.get(block) ?? 'none'}, Rust ${expected.get(block) ?? 'none'}; changed unassigned-in-16.0.0 inputs: ${suspects.join('').trimEnd().replaceAll('\n', '; ') || 'none'}`,
      );
    }
  }
  expect(mismatches, `normalizeMusic differs from Rust music_key::normalize:\n${mismatches.join('\n')}`).toEqual([]);
}, 300_000);

it('code points unassigned in Unicode 16.0.0 stay NFKC-inert normalization boundaries', () => {
  // Every expectation below is the Rust oracle's output (music_key::normalize).
  const vectors: [input: string, rust: string][] = [
    ['\u{A7F1}', '\u{A7F1}'],
    ['e\u{A7F1}\u{301}', 'e\u{A7F1}\u{301}'],
    ['S\u{A7F1}s', 's\u{A7F1}s'],
    ['\u{A7F1}\u{301}', '\u{A7F1}\u{301}'],
    ['a\u{301}\u{A7F1}\u{316}', '\u{E1}\u{A7F1}\u{316}'],
    ['a\u{316}\u{A7F1}\u{301}', 'a\u{316}\u{A7F1}\u{301}'],
    ['  \u{A7F1}  BJÖRK ', '\u{A7F1} björk'],
    ['\u{1CCD6}\u{16D63}\u{16D67}', 'a\u{16D69}'],
    ['\u{1CCD6}\u{A7F1}\u{16D63}\u{A7F1}\u{16D67}', 'a\u{A7F1}\u{16D63}\u{A7F1}\u{16D67}'],
    // Combining marks Unicode 16.0.0 leaves unassigned: no canonical reordering.
    ['q\u{301}\u{1ADD}', 'q\u{301}\u{1ADD}'],
    ['Q\u{1AEB}\u{301}', 'q\u{1AEB}\u{301}'],
    ['a\u{301}\u{10EFA}', '\u{E1}\u{10EFA}'],
  ];
  for (const [input, rust] of vectors) expect(hexCodePoints(normalizeMusic(input))).toBe(hexCodePoints(rust));
  // The keys built on it: Rust ArtistKey::new("\u{A7F1}") is "\u{A7F1}", and
  // TrackKey::new("\u{A7F1}", "s") != TrackKey::new("s", "s").
  expect(artistKey('\u{A7F1}')).toBe('\u{A7F1}');
  expect(musicKeyId(trackKey('\u{A7F1}', 's'))).not.toBe(musicKeyId(trackKey('s', 's')));
  expect(albumKey('\u{A7F1}', 'S')).toEqual(['\u{A7F1}', 's']);

  // The guard is what keeps those equal. List every scalar unassigned in 16.0.0
  // for which the runtime's own NFKC already differs from Unicode 16.0.0 (which
  // leaves it alone and never reorders or composes across it): under workerd's
  // Unicode 17 ICU, U+A7F1 maps to "s" and new combining marks such as U+1ADD
  // reorder. normalizeMusic must leave each of them untouched in every context.
  const contexts: [prefix: string, suffix: string][] = [
    ['', ''],
    ['q\u0301', ''],
    ['q', '\u0301'],
  ];
  const runtimeOnly: number[] = [];
  for (let cp = ASSIGNED_PREFIX_END + 1; cp <= 0x10ffff; cp++) {
    if (isAssigned(cp)) continue;
    const ch = String.fromCodePoint(cp);
    let drifts = false;
    for (const [prefix, suffix] of contexts) {
      const input = prefix + ch + suffix;
      if (input.normalize('NFKC') !== input) drifts = true;
      if (normalizeMusic(input) !== input) {
        expect.fail(`normalizeMusic changed U+${cp.toString(16).toUpperCase()} in ${JSON.stringify(input)}`);
      }
    }
    if (drifts) runtimeOnly.push(cp);
  }
  expect(navigator.userAgent).toBe('Cloudflare-Workers');
  console.info(
    `runtime NFKC differs from Unicode 16.0.0 for ${runtimeOnly.length} code points it leaves unassigned: ${runtimeOnly.map((cp) => cp.toString(16).toUpperCase()).join(' ')}`,
  );

  // workerd's ICU is at least Unicode 16.0.0, which the guard needs.
  expect(nfkcRuntimeSupportsGroupingVersion()).toBe(true);
}, 120_000);

it('generated casefold/white-space tables are up to date with data file', async () => {
  // The vendored data is the official Unicode 16.0.0 file, byte-for-byte.
  expect(await sha256Hex(caseFoldingTxt)).toBe('6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb');
  expect(caseFoldingTxt.startsWith('# CaseFolding-16.0.0.txt\n')).toBe(true);

  // Byte-for-byte: what the generator renders now is what is committed.
  expect(gen.CASE_FOLD_OUTPUT_PATH).toBe('packages/core/src/unicode/casefold-16.0.0.ts');
  expect(gen.WHITE_SPACE_OUTPUT_PATH).toBe('packages/core/src/unicode/white-space.ts');
  expect(gen.renderCaseFold(caseFoldingTxt)).toBe(caseFoldTs);
  expect(gen.renderWhiteSpace()).toBe(whiteSpaceTs);
  expect(gen.ASSIGNED_OUTPUT_PATH).toBe('packages/core/src/unicode/assigned-16.0.0.ts');
  expect(gen.renderAssigned(derivedAgeTxt)).toBe(assignedTs);
  expect(gen.renderAll(caseFoldingTxt, derivedAgeTxt).map((f) => f.path)).toEqual([
    gen.CASE_FOLD_OUTPUT_PATH,
    gen.WHITE_SPACE_OUTPUT_PATH,
    gen.ASSIGNED_OUTPUT_PATH,
  ]);

  // DerivedAge-16.0.0.txt is the official file, byte-for-byte, and the assigned set
  // it yields is the one Python unicodedata 16.0.0 reports (General_Category not Cn,
  // plus the 66 noncharacters): 294645 code points in 739 merged ranges.
  expect(await sha256Hex(derivedAgeTxt)).toBe('60caa81b99a4dfb0bc5d38440d323073e3f356f46f9ca7869da848cd0715408b');
  expect(ASSIGNED_UNICODE_VERSION).toBe('16.0.0');
  expect(ASSIGNED_RANGES).toHaveLength(739);
  expect(ASSIGNED_RANGES.reduce((n, [a, b]) => n + b - a + 1, 0)).toBe(294645);
  for (const cp of [0x0000, 0x0377, 0xa7cb, 0xd800, 0xe000, 0xfdd0, 0xffff, 0x1ccd6, 0x16d69, 0x2ebf0, 0x10ffff]) {
    expect(isAssigned(cp), `U+${cp.toString(16)}`).toBe(true);
  }
  for (const cp of [0x0378, 0xa7f1, 0xa7ce, 0x1fbfa, 0x2ee5e, 0xe0000, 0x110000, -1]) {
    expect(isAssigned(cp), `U+${cp.toString(16)}`).toBe(false);
  }
  // A DerivedAge newer than the pinned version, or with a wrong section total, is refused.
  expect(() =>
    gen.renderAssigned(derivedAgeTxt.replace('# DerivedAge-16.0.0.txt', '# DerivedAge-17.0.0.txt')),
  ).toThrow();
  expect(() =>
    gen.renderAssigned(derivedAgeTxt.replace('# Total code points: 5185', '# Total code points: 5186')),
  ).toThrow();
  expect(() => gen.renderAssigned(`${derivedAgeTxt}# Age=V17_0\nA7F1 ; 17.0 # x\n# Total code points: 1\n`)).toThrow();

  // Negative control: a one-mapping edit to the data is detected as drift.
  const tampered = caseFoldingTxt.replace('00DF; F; 0073 0073;', '00DF; F; 0073 0074;');
  expect(tampered).not.toBe(caseFoldingTxt);
  expect(gen.renderCaseFold(tampered)).not.toBe(caseFoldTs);
  expect(() =>
    gen.renderCaseFold(caseFoldingTxt.replace('# CaseFolding-16.0.0.txt', '# CaseFolding-15.1.0.txt')),
  ).toThrow();

  // The loaded table is exactly the C+F rows of the data file, nothing more.
  const parsed = gen.parseCaseFolding(caseFoldingTxt);
  const cf = parsed.rows.filter((r) => r.status === 'C' || r.status === 'F');
  expect(parsed.rows.filter((r) => r.status === 'C')).toHaveLength(1453);
  expect(parsed.rows.filter((r) => r.status === 'F')).toHaveLength(104);
  expect(CASE_FOLDING_C_F.map((row) => [...row])).toEqual(cf.map((r) => [r.source, ...r.mapping]));
  expect(CASE_FOLDING_UNICODE_VERSION).toBe('16.0.0');
  // Full (F), not simple (S), and non-Turkic (no T) folding.
  expect(caseFold('ßẞ')).toBe('ssss');
  expect(caseFold('İ')).toBe('i̇');
  expect(caseFold('I')).toBe('i');
  expect(caseFold('ꭰ\u{10400}Ɤ')).toBe('Ꭰ\u{10428}ɤ');
  expect(caseFold('ﬃ')).toBe('ffi');

  // White_Space: the table equals the runtime's \p{White_Space} over every code point.
  expect(WHITE_SPACE_UNICODE_VERSION).toBe('16.0.0');
  const runtime: number[] = [];
  const prop = /^\p{White_Space}$/u;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (prop.test(String.fromCodePoint(cp))) runtime.push(cp);
  }
  const table = WHITE_SPACE_RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
  expect(table).toEqual(runtime);
  expect(table).toHaveLength(25);
  expect(table.every(isWhiteSpace)).toBe(true);
  // U+FEFF, U+200B and U+180E are not White_Space (JS trim and \s disagree on FEFF/0085).
  for (const cp of [0xfeff, 0x200b, 0x180e, 0x1f, 0x200d]) expect(isWhiteSpace(cp)).toBe(false);
  expect('﻿a﻿'.trim()).toBe('a');
  expect(trimWhiteSpace('﻿a﻿')).toBe('﻿a﻿');
  expect('\u0085a\u0085'.trim()).toBe('\u0085a\u0085');
  expect(trimWhiteSpace('\u0085a\u0085')).toBe('a');
  expect(collapseWhiteSpace('　 a  \t b ')).toBe('a b');
  expect(collapseWhiteSpace(' \t ')).toBe('');
});
