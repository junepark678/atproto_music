/// <reference types="vite/client" />
// W1-02: the runtime half of the Unicode pipeline (ADR 0004 §13 item 5). NFKC is
// not vendored; it comes from workerd's ICU. This suite runs inside workerd and
// fails loudly, naming the entry and both code-point sequences, if an ICU upgrade
// changes NFKC for any corpus entry. It also proves the vendored case-folding and
// White_Space tables are exactly what scripts/gen-unicode.ts renders from the data.

import { caseFold, normalizeMusic } from '@atmusic/core/music-key';
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
import caseFoldTs from '../src/unicode/casefold-16.0.0.ts?raw';
import whiteSpaceTs from '../src/unicode/white-space.ts?raw';

interface GenUnicode {
  CASE_FOLD_OUTPUT_PATH: string;
  WHITE_SPACE_OUTPUT_PATH: string;
  renderCaseFold(text: string): string;
  renderWhiteSpace(excerpt?: string): string;
  renderAll(text: string): { path: string; content: string }[];
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

function hexCodePoints(s: string): string {
  return Array.from(s, (ch) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
}

const golden = JSON.parse(musicKeysRaw) as {
  unicodeVersion: string;
  entries: { id: string; input: string; normalized: string }[];
};

it('workerd ICU NFKC matches oracle corpus', () => {
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
});

it('generated casefold/white-space tables are up to date with data file', async () => {
  // The vendored data is the official Unicode 16.0.0 file, byte-for-byte.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(caseFoldingTxt)));
  expect(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
    '6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb',
  );
  expect(caseFoldingTxt.startsWith('# CaseFolding-16.0.0.txt\n')).toBe(true);

  // Byte-for-byte: what the generator renders now is what is committed.
  expect(gen.CASE_FOLD_OUTPUT_PATH).toBe('packages/core/src/unicode/casefold-16.0.0.ts');
  expect(gen.WHITE_SPACE_OUTPUT_PATH).toBe('packages/core/src/unicode/white-space.ts');
  expect(gen.renderCaseFold(caseFoldingTxt)).toBe(caseFoldTs);
  expect(gen.renderWhiteSpace()).toBe(whiteSpaceTs);
  expect(gen.renderAll(caseFoldingTxt).map((f) => f.path)).toEqual([
    gen.CASE_FOLD_OUTPUT_PATH,
    gen.WHITE_SPACE_OUTPUT_PATH,
  ]);

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
