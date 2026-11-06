/// <reference types="vite/client" />
// W1-02: music grouping keys and the code-point comparator against the Rust
// oracle (tests/goldens/music_keys.json, crates/core/src/music_key.rs) and the
// TESTING.md grouping rules. Runs in workerd (packages/core/vitest.config.ts).

import {
  type AlbumKey,
  albumKey,
  artistKey,
  compareCodePoints,
  compareMusicKeys,
  DISPLAY_STRING_MESSAGE,
  GROUPING_UNICODE_VERSION,
  MusicKeyError,
  musicKeyId,
  newestDisplay,
  normalizeMusic,
  type TrackKey,
  trackKey,
} from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import readModelsRaw from '../../../tests/fixtures/read_models.json?raw';
import musicKeysRaw from '../../../tests/goldens/music_keys.json?raw';

interface GoldenError {
  code: string;
  field: string;
  message: string;
}
interface GoldenEntry {
  id: string;
  input: string;
  inputCodePoints: string[];
  normalized: string;
  normalizedCodePoints: string[];
  artistKey: string | null;
  artistKeyError: GoldenError | null;
}
interface GoldenTuple {
  artist: string;
  track: string;
  album: string | null;
  trackKey: [string, string] | null;
  trackKeyError: GoldenError | null;
  albumKey: [string, string] | null;
  albumKeyError: GoldenError | null;
}
interface MusicKeysGolden {
  unicodeVersion: string;
  entries: GoldenEntry[];
  artistKeyOrdering: { sorted: string[]; pairs: { a: string; b: string; cmp: number }[] };
  tuples: GoldenTuple[];
  trackKeyOrdering: { pairs: { a: [string, string]; b: [string, string]; cmp: number }[] };
}

const golden = JSON.parse(musicKeysRaw) as MusicKeysGolden;

// Display-string limit and field-order vectors. music_keys.json only holds short
// inputs, so these pin Rust `validate_display_string` (1–256 scalars, at most 1024
// UTF-8 bytes, measured on the raw input before trimming and before NFKC) and the
// field order of `TrackKey::new` / `AlbumKey::optional`. Every expected outcome
// below was produced by running the inputs through the Rust crate (review round 1).
// `null` = rejected with the named field; a string = the accepted key.
const A256 = 'a'.repeat(256);
const A257 = 'a'.repeat(257);
const B257 = 'b'.repeat(257);
const C257 = 'c'.repeat(257);
const SMILE = '\u{1F600}';
const ARTIST_LIMIT_VECTORS: [id: string, input: string, key: string | null][] = [
  ['256 ASCII scalars', A256, A256],
  ['257 ASCII scalars', A257, null],
  ['256 scalars folded', 'A'.repeat(256), A256],
  ['256 astral scalars = 1024 bytes, 512 code units', SMILE.repeat(256), SMILE.repeat(256)],
  ['257 astral scalars = 1028 bytes', SMILE.repeat(257), null],
  ['257 scalars in 1022 bytes', `${SMILE.repeat(255)}ab`, null],
  ['256 astral scalars folded', '\u{10400}'.repeat(256), '\u{10428}'.repeat(256)],
  ['256 scalars of 3 bytes', `${'\u3000'.repeat(255)}a`, 'a'],
  ['length measured before trimming: 301', `${' '.repeat(300)}a`, null],
  ['length measured before trimming: 256', `${' '.repeat(255)}a`, 'a'],
  ['length measured before trimming: 257', `${' '.repeat(255)}a `, null],
  ['length measured before NFKC: 256 decomposed', 'e\u0301'.repeat(128), '\u00e9'.repeat(128)],
  ['length measured before NFKC: 257 decomposed', `${'e\u0301'.repeat(128)}x`, null],
  ['NFKC expansion past the limit is accepted', '\ufdfa'.repeat(256), '\ufdfa'.repeat(256).normalize('NFKC')],
  ['case-fold expansion past the limit is accepted', '\u00df'.repeat(256), 'ss'.repeat(256)],
  ['only White_Space at 256 scalars', '\u3000'.repeat(256), null],
];
type FieldOutcome = [string, string] | 'artist' | 'track' | 'album' | null;
const FIELD_ORDER_VECTORS: [
  artist: string,
  track: string,
  album: string | null,
  track: FieldOutcome,
  album: FieldOutcome,
][] = [
  ['', '', '', 'track', 'artist'],
  [A257, B257, C257, 'track', 'artist'],
  [A257, 'ok', null, 'artist', 'artist'],
  ['', 'ok', null, 'artist', 'artist'],
  ['ok', B257, C257, 'track', 'album'],
  ['ok', '', '', 'track', 'album'],
  ['ok', 'ok', C257, ['ok', 'ok'], 'album'],
  ['ok', 'ok', null, ['ok', 'ok'], null],
  [A256, 'B'.repeat(256), 'C'.repeat(256), [A256, 'b'.repeat(256)], [A256, 'c'.repeat(256)]],
];

function codePoints(s: string): string[] {
  return Array.from(s, (ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
}

/** Runs `fn` and returns the error it raised as the golden JSON shape, or the value. */
function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: GoldenError } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    expect(error).toBeInstanceOf(MusicKeyError);
    const e = error as MusicKeyError;
    return { ok: false, error: { code: e.code, field: e.field, message: e.message } };
  }
}

it('every music_keys.json vector equals the Rust key', () => {
  expect(golden.unicodeVersion).toBe(GROUPING_UNICODE_VERSION);
  expect(golden.entries).toHaveLength(56);
  expect(golden.tuples).toHaveLength(20);

  let artistOk = 0;
  let artistErr = 0;
  for (const entry of golden.entries) {
    expect(codePoints(entry.input), entry.id).toEqual(entry.inputCodePoints);
    const normalized = normalizeMusic(entry.input);
    expect(normalized, entry.id).toBe(entry.normalized);
    expect(codePoints(normalized), entry.id).toEqual(entry.normalizedCodePoints);

    const got = outcome(() => artistKey(entry.input));
    if (entry.artistKeyError === null) {
      expect(got, entry.id).toEqual({ ok: true, value: entry.artistKey });
      artistOk++;
    } else {
      expect(entry.artistKey).toBeNull();
      expect(got, entry.id).toEqual({ ok: false, error: entry.artistKeyError });
      artistErr++;
    }
  }
  expect([artistOk, artistErr]).toEqual([52, 4]);

  for (const t of golden.tuples) {
    const label = JSON.stringify([t.artist, t.track, t.album]);
    const track = outcome(() => trackKey(t.artist, t.track));
    expect(track, label).toEqual(
      t.trackKeyError === null ? { ok: true, value: t.trackKey } : { ok: false, error: t.trackKeyError },
    );
    const album = outcome(() => albumKey(t.artist, t.album));
    expect(album, label).toEqual(
      t.albumKeyError === null ? { ok: true, value: t.albumKey } : { ok: false, error: t.albumKeyError },
    );
  }
  expect(golden.tuples.filter((t) => t.trackKeyError !== null)).toHaveLength(2);
  expect(golden.tuples.filter((t) => t.albumKeyError !== null)).toHaveLength(3);

  // Rust Ord over every pair of distinct artist keys and track tuples.
  expect(golden.artistKeyOrdering.pairs).toHaveLength(741);
  for (const { a, b, cmp } of golden.artistKeyOrdering.pairs) {
    expect(compareCodePoints(a, b), JSON.stringify([a, b])).toBe(cmp);
    expect(compareCodePoints(b, a), JSON.stringify([b, a])).toBe(-cmp);
  }
  const distinct = [...new Set(golden.artistKeyOrdering.pairs.flatMap((p) => [p.a, p.b]))];
  expect(distinct).toHaveLength(39);
  expect([...distinct].reverse().sort(compareCodePoints)).toEqual(golden.artistKeyOrdering.sorted);

  expect(golden.trackKeyOrdering.pairs).toHaveLength(91); // 14 distinct valid track keys
  for (const { a, b, cmp } of golden.trackKeyOrdering.pairs) {
    expect(compareMusicKeys(a, b), JSON.stringify([a, b])).toBe(cmp);
    expect(compareMusicKeys(b, a), JSON.stringify([b, a])).toBe(-cmp);
  }

  // The error is the Rust ValidationError, byte-for-byte.
  expect(DISPLAY_STRING_MESSAGE).toBe(golden.entries.find((e) => e.id === 'empty')!.artistKeyError!.message);

  // Display-string limits at the boundary, measured on the raw input in scalars.
  const enc = new TextEncoder();
  expect(enc.encode(SMILE.repeat(256))).toHaveLength(1024);
  expect(SMILE.repeat(256)).toHaveLength(512);
  for (const [id, input, key] of ARTIST_LIMIT_VECTORS) {
    expect(
      outcome(() => artistKey(input)),
      id,
    ).toEqual(
      key === null
        ? { ok: false, error: { code: 'invalid_field', field: 'artist', message: DISPLAY_STRING_MESSAGE } }
        : { ok: true, value: key },
    );
  }
  expect(ARTIST_LIMIT_VECTORS.filter(([, , key]) => key === null)).toHaveLength(7);
});

it("Björk / '  BJÖRK  ' / 'jóga' group together; Homogenic/' HOMOGENIC ' group together", () => {
  // TESTING.md r01/r02 plus the composed/decomposed and Unicode-space spellings.
  const spellings = ['Björk', '  BJÖRK  ', ' BJÖRK ', '  BJÖRK　', '\u0085björk '];
  for (const s of spellings) expect(artistKey(s), JSON.stringify(s)).toBe('björk');
  const tracks: TrackKey[] = [trackKey('Björk', 'Jóga'), trackKey('  BJÖRK  ', 'jóga'), trackKey(' BJÖRK', ' jóga ')];
  for (const k of tracks) expect(k).toEqual(['björk', 'jóga']);
  expect(new Set(tracks.map(musicKeyId)).size).toBe(1);
  expect(albumKey('Björk', 'Homogenic')).toEqual(['björk', 'homogenic']);
  expect(albumKey('  BJÖRK  ', ' HOMOGENIC ')).toEqual(['björk', 'homogenic']);
  expect(normalizeMusic('Straße')).toBe(normalizeMusic('STRASSE'));

  // Group Alice's confirmed fixture listens exactly as the stats read model does,
  // and pick each group's display spelling with the newest-then-URI rule.
  const fixture = JSON.parse(readModelsRaw) as {
    expected: { aliceHistory: string[] };
    scrobbles: {
      rkey: string;
      uri: string;
      record: { artist: string; track: string; album?: string; listenedAt: string };
    }[];
  };
  const alice = fixture.expected.aliceHistory.map((rkey) => fixture.scrobbles.find((s) => s.rkey === rkey)!);
  expect(alice.map((s) => s.rkey)).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
  const listens = alice.map((s) => ({
    ...s.record,
    uri: s.uri,
    listenedAtNs: BigInt(Date.parse(s.record.listenedAt)) * 1_000_000n,
  }));
  const groups = new Map<string, typeof listens>();
  for (const l of listens) {
    const id = musicKeyId(trackKey(l.artist, l.track));
    groups.set(id, [...(groups.get(id) ?? []), l]);
  }
  const bjorkJoga = groups.get(musicKeyId(['björk', 'jóga']))!;
  expect(bjorkJoga.map((l) => l.uri.slice(-3))).toEqual(['r01', 'r02']);
  const display = newestDisplay(bjorkJoga)!;
  expect([display.artist, display.track, display.album]).toEqual(['Björk', 'Jóga', 'Homogenic']);
  // Display text is the original spelling, never the normalized key.
  expect(newestDisplay([bjorkJoga[1]!])!.artist).toBe('  BJÖRK  ');
  // TESTING.md all-window: 7 listens, 6 tracks, Björk/Jóga:2 and five singletons.
  expect(groups.size).toBe(6);
  expect([...groups.values()].map((g) => g.length).sort()).toEqual([1, 1, 1, 1, 1, 2]);
  expect(new Set(listens.map((l) => artistKey(l.artist)))).toEqual(new Set(['björk', 'radiohead', 'kate bush']));

  // Equal listenedAt: the code-point-greatest URI wins, regardless of input order.
  const tieA = { listenedAtNs: 5n, uri: 'at://did:plc:a/x/r01', artist: 'A' };
  const tieB = { listenedAtNs: 5n, uri: 'at://did:plc:a/x/r02', artist: 'B' };
  const older = { listenedAtNs: 4n, uri: 'at://did:plc:z/x/r99', artist: 'C' };
  expect(newestDisplay([tieA, tieB, older])!.artist).toBe('B');
  expect(newestDisplay([older, tieB, tieA])!.artist).toBe('B');
  expect(newestDisplay([])).toBeNull();
});

it('compareCodePoints orders astral above U+E000–U+FFFF like Rust', () => {
  const astral = ['\u{10000}', '\u{1F600}', '\u{10400}', '\u{1D400}', '\u{10FFFF}'];
  const highBmp = ['', '�', '￿', 'ￜ', '﻿'];
  for (const a of astral) {
    for (const b of highBmp) {
      expect(compareCodePoints(a, b), `${codePoints(a)} vs ${codePoints(b)}`).toBe(1);
      expect(compareCodePoints(b, a)).toBe(-1);
      // JavaScript's native UTF-16 order is the opposite: why the comparator exists.
      expect(a < b).toBe(true);
    }
  }
  expect(compareCodePoints('퟿', '\u{10000}')).toBe(-1);
  expect(compareCodePoints('a', 'a')).toBe(0);
  expect(compareCodePoints('a', 'ab')).toBe(-1);
  expect(compareCodePoints('ab', 'a')).toBe(1);
  expect(compareCodePoints('', '\u{10000}')).toBe(-1);
  // Low surrogates after an equal lead unit compare as their code points.
  expect(compareCodePoints('\u{1F600}', '\u{1F601}')).toBe(-1);

  // Tuples: same order as the Rust (ArtistKey, String) derive and SQL BINARY.
  expect(compareMusicKeys(['a', ''], ['a', '\u{10000}'])).toBe(-1);
  expect(compareMusicKeys(['\u{10000}', 'a'], ['￿', 'z'])).toBe(1);
  const tuples: TrackKey[] = [
    ['\u{10000}', 'a'],
    ['a', '\u{10000}'],
    ['', 'a'],
    ['a', ''],
    ['a', 'z'],
  ];
  expect([...tuples].sort(compareMusicKeys)).toEqual([
    ['a', 'z'],
    ['a', ''],
    ['a', '\u{10000}'],
    ['', 'a'],
    ['\u{10000}', 'a'],
  ]);
  // The native sort puts U+10000 before U+E000, which would disagree with SQLite.
  expect(['', '\u{10000}'].sort()).toEqual(['\u{10000}', '']);
  expect(['', '\u{10000}'].sort(compareCodePoints)).toEqual(['', '\u{10000}']);

  // Deterministic randomized agreement with UTF-8 byte order (SQLite BINARY).
  const rng = seededRandom(20260115);
  const ranges: [number, number][] = [
    [0x20, 0x7e],
    [0x80, 0x7ff],
    [0x800, 0xd7ff],
    [0xe000, 0xffff],
    [0x10000, 0x10ffff],
  ];
  const randomString = (): string => {
    const n = rng.nextUint32() % 6;
    let s = '';
    for (let i = 0; i < n; i++) {
      const [lo, hi] = ranges[rng.nextUint32() % ranges.length]!;
      s += String.fromCodePoint(lo + (rng.nextUint32() % (hi - lo + 1)));
    }
    return s;
  };
  const enc = new TextEncoder();
  const byteCompare = (a: string, b: string): number => {
    const x = enc.encode(a);
    const y = enc.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return Math.sign(x.length - y.length);
  };
  let disagreesWithNative = 0;
  for (let i = 0; i < 5000; i++) {
    const a = randomString();
    // Share a prefix half the time so later positions are exercised too.
    const b = i % 2 === 0 ? a.slice(0, rng.nextUint32() % (a.length + 1)) + randomString() : randomString();
    expect(compareCodePoints(a, b), JSON.stringify([codePoints(a), codePoints(b)])).toBe(byteCompare(a, b));
    if (Math.sign(compareCodePoints(a, b)) !== (a < b ? -1 : a > b ? 1 : 0)) disagreesWithNative++;
  }
  expect(disagreesWithNative).toBeGreaterThan(0);
});

it('missing album yields null album key', () => {
  expect(albumKey('Björk')).toBeNull();
  expect(albumKey('Björk', undefined)).toBeNull();
  expect(albumKey('Björk', null)).toBeNull();
  expect(albumKey('Björk', 'Homogenic')).toEqual(['björk', 'homogenic']);

  // A supplied but empty or White_Space-only album is rejected, never treated as absent.
  for (const album of ['', ' ', ' 　', '\u0085', ' \t']) {
    const err = outcome(() => albumKey('Björk', album));
    expect(err, JSON.stringify(album)).toEqual({
      ok: false,
      error: { code: 'invalid_field', field: 'album', message: DISPLAY_STRING_MESSAGE },
    });
  }
  // The artist is still validated when the album is omitted, as in Rust.
  expect(outcome(() => albumKey('', undefined))).toEqual({
    ok: false,
    error: { code: 'invalid_field', field: 'artist', message: DISPLAY_STRING_MESSAGE },
  });
  // An over-long album is rejected like an empty one; one at the limit is a key.
  expect(outcome(() => albumKey('Björk', C257))).toEqual({
    ok: false,
    error: { code: 'invalid_field', field: 'album', message: DISPLAY_STRING_MESSAGE },
  });

  // Field order: trackKey checks the track before the artist; albumKey checks the
  // artist before the album. The first invalid field is the one reported.
  const expectField = (got: ReturnType<typeof outcome>, want: FieldOutcome, label: string): void => {
    if (want === null || Array.isArray(want)) {
      expect(got, label).toEqual({ ok: true, value: want });
    } else {
      expect(got, label).toEqual({
        ok: false,
        error: { code: 'invalid_field', field: want, message: DISPLAY_STRING_MESSAGE },
      });
    }
  };
  for (const [artist, track, album, wantTrack, wantAlbum] of FIELD_ORDER_VECTORS) {
    const label = JSON.stringify([artist.slice(0, 8), artist.length, track.slice(0, 8), track.length, album?.length]);
    expectField(
      outcome(() => trackKey(artist, track)),
      wantTrack,
      `track ${label}`,
    );
    expectField(
      outcome(() => albumKey(artist, album)),
      wantAlbum,
      `album ${label}`,
    );
  }

  // Album ranking over Alice's fixture listens: r05 (no album) creates no bucket.
  // TESTING.md all-window albums: Björk/Homogenic:2, Radiohead/OK Computer:2,
  // Kate Bush/Hounds of Love:1, Radiohead/In Rainbows:1.
  const fixture = JSON.parse(readModelsRaw) as {
    expected: { aliceHistory: string[] };
    scrobbles: { rkey: string; record: { artist: string; album?: string } }[];
  };
  const counts = new Map<string, { key: AlbumKey; n: number; rkeys: string[] }>();
  let withoutAlbum: string[] = [];
  for (const rkey of fixture.expected.aliceHistory) {
    const { record } = fixture.scrobbles.find((s) => s.rkey === rkey)!;
    const key = albumKey(record.artist, record.album);
    if (key === null) {
      withoutAlbum = [...withoutAlbum, rkey];
      continue;
    }
    const id = musicKeyId(key);
    const bucket = counts.get(id) ?? { key, n: 0, rkeys: [] };
    bucket.n++;
    bucket.rkeys.push(rkey);
    counts.set(id, bucket);
  }
  expect(withoutAlbum).toEqual(['r05']);
  const ranked = [...counts.values()]
    .sort((a, b) => b.n - a.n || compareMusicKeys(a.key, b.key))
    .map((b) => [...b.key, b.n]);
  expect(ranked).toEqual([
    ['björk', 'homogenic', 2],
    ['radiohead', 'ok computer', 2],
    ['kate bush', 'hounds of love', 1],
    ['radiohead', 'in rainbows', 1],
  ]);
  expect([...counts.values()].some((b) => b.rkeys.includes('r05'))).toBe(false);
});

it('artist a|b with title c and artist a with title b|c yield distinct track keys', () => {
  const left = trackKey('a|b', 'c');
  const right = trackKey('a', 'b|c');
  expect(left).toEqual(['a|b', 'c']);
  expect(right).toEqual(['a', 'b|c']);
  // A naive joined string would collide; the typed tuples do not.
  expect(left.join('|')).toBe(right.join('|'));
  expect(left).not.toEqual(right);
  expect(musicKeyId(left)).not.toBe(musicKeyId(right));
  expect(compareMusicKeys(left, right)).toBe(1);
  expect(compareMusicKeys(right, left)).toBe(-1);

  // Space-joined forms collide as well: ('a b','a') vs ('a','b a').
  expect(trackKey('a b', 'a').join(' ')).toBe(trackKey('a', 'b a').join(' '));
  expect(compareMusicKeys(trackKey('a b', 'a'), trackKey('a', 'b a'))).not.toBe(0);

  // Grouping four listens yields four track groups and four album groups.
  const listens: [string, string, string][] = [
    ['a|b', 'c', 'c'],
    ['a', 'b|c', 'b|c'],
    ['A|B', ' C ', 'C'],
    ['a b', 'a', 'x'],
    ['a', 'b a', 'x'],
  ];
  const trackGroups = new Map<string, number>();
  const albumGroups = new Set<string>();
  for (const [artist, track, album] of listens) {
    const id = musicKeyId(trackKey(artist, track));
    trackGroups.set(id, (trackGroups.get(id) ?? 0) + 1);
    albumGroups.add(musicKeyId(albumKey(artist, album)!));
  }
  expect([...trackGroups.entries()].sort()).toEqual(
    [
      [musicKeyId(['a|b', 'c']), 2],
      [musicKeyId(['a', 'b|c']), 1],
      [musicKeyId(['a b', 'a']), 1],
      [musicKeyId(['a', 'b a']), 1],
    ].sort(),
  );
  expect(albumGroups.size).toBe(4);
  // Matches the Rust golden tuples for the same inputs.
  const g = golden.tuples.filter((t) => t.album === 'c' || t.album === 'b|c');
  expect(g.map((t) => t.trackKey)).toEqual([left, right]);
});
