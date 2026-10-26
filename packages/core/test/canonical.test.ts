import { canonicalDigest, canonicalJson, sameCanonicalRecord } from '@atmusic/core/canonical';
import { describe, expect, it } from 'vitest';

// Expected bytes and digests were produced by the Rust oracle's exact
// algorithm, sha256(serde_json::to_vec(&serde_json::from_str(raw)?)) with
// serde_json =1.0.145 (crates/atproto/src/pds/reconcile.rs canonical_digest),
// and independently by Python json.dumps(sort_keys=True, separators=(',', ':'),
// ensure_ascii=False). They are hardcoded, never computed by the code under test.
const SCROBBLE = {
  track: 'Jóga',
  artist: 'Björk',
  listenedAt: '2026-01-15T11:00:00.000Z',
  durationSeconds: 305,
  album: 'Homogenic',
  $type: 'com.example.atmusic.scrobble',
};
const SCROBBLE_JSON =
  '{"$type":"com.example.atmusic.scrobble","album":"Homogenic","artist":"Björk","durationSeconds":305,"listenedAt":"2026-01-15T11:00:00.000Z","track":"Jóga"}';
const SCROBBLE_DIGEST = 'a560257e8273dfb43ff3c9a844e5f439ca6f5611a5f9aa47bf8b0642fcc686f6';

const FOLLOW_DIGEST = '21c9216110e1f3b58803fb4e6d02c323c888c163cf3e0599f225fc9c523a0c8d';

// Code-point key order (U+FFFF before U+1F600, unlike UTF-16 sort), escapes, nesting.
const TRICKY = { b: [1, true, null, { z: '\n\t"\\\u0001\u007f', a: 0 }], '￿': 1, '\u{1f600}': 2, a: ' ' };
const TRICKY_JSON = '{"a":" ","b":[1,true,null,{"a":0,"z":"\\n\\t\\"\\\\\\u0001\u007f"}],"￿":1,"\u{1f600}":2}';
const TRICKY_DIGEST = 'c1bf7ce5533d2e4f72fd55aa7b47b0b68c63ce1d7fd002e52e4573253f21f23c';

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('canonical digest', () => {
  it('key order does not change the digest; any value change does', async () => {
    expect(canonicalJson(SCROBBLE)).toBe(SCROBBLE_JSON);
    expect(await canonicalDigest(SCROBBLE)).toBe(SCROBBLE_DIGEST);
    expect(canonicalJson(TRICKY)).toBe(TRICKY_JSON);
    expect(await canonicalDigest(TRICKY)).toBe(TRICKY_DIGEST);
    expect(
      await canonicalDigest({
        subject: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: '2026-01-15T12:00:00.000Z',
        $type: 'com.example.atmusic.follow',
      }),
    ).toBe(FOLLOW_DIGEST);

    // Every insertion order of the six keys (720 objects) gives the same bytes and digest.
    const entries = Object.entries(SCROBBLE);
    const orders = permutations(entries);
    expect(orders.length).toBe(720);
    for (const order of orders) {
      expect(canonicalJson(Object.fromEntries(order))).toBe(SCROBBLE_JSON);
    }
    expect(await canonicalDigest(Object.fromEntries([...entries].reverse()))).toBe(SCROBBLE_DIGEST);
    // Nested key order and whitespace in the remote JSON text do not matter either.
    const remoteText = `{ "b" : [ 1 , true , null , { "a" : 0 , "z" : "\\n\\t\\"\\\\\\u0001\u007f" } ] ,
      "\\ud83d\\ude00" : 2 , "a" : "\\u2028" , "\\uffff" : 1 }`;
    expect(await canonicalDigest(JSON.parse(remoteText))).toBe(TRICKY_DIGEST);
    // Undefined object properties are dropped, exactly as the JSON sent to the PDS drops them.
    expect(await canonicalDigest({ ...SCROBBLE, mbid: undefined })).toBe(SCROBBLE_DIGEST);
    // The local outbox record matches a getRecord value that came back as JSON.
    expect(await sameCanonicalRecord(SCROBBLE, JSON.parse(JSON.stringify(Object.fromEntries(orders[357]!))))).toBe(
      true,
    );

    // Any single value change, including $type, changes the digest.
    const changed: Array<Record<string, unknown>> = [
      { ...SCROBBLE, track: 'Joga' },
      { ...SCROBBLE, track: 'Jóga ' },
      { ...SCROBBLE, track: 'Jóga' }, // NFD form: canonical JSON never normalises
      { ...SCROBBLE, artist: 'björk' },
      { ...SCROBBLE, durationSeconds: 306 },
      { ...SCROBBLE, durationSeconds: '305' },
      { ...SCROBBLE, listenedAt: '2026-01-15T11:00:00.001Z' },
      { ...SCROBBLE, $type: 'com.example.atmusic.follow' },
      { ...SCROBBLE, album: null },
      { ...SCROBBLE, album: undefined },
      { ...SCROBBLE, mbid: '00000000-0000-4000-8000-000000000000' },
      { ...SCROBBLE, Album: SCROBBLE.album, album: undefined },
    ];
    const digests = new Set([SCROBBLE_DIGEST]);
    for (const variant of changed) {
      const digest = await canonicalDigest(variant);
      expect(digest, JSON.stringify(variant)).not.toBe(SCROBBLE_DIGEST);
      expect(await sameCanonicalRecord(SCROBBLE, variant)).toBe(false);
      digests.add(digest);
    }
    expect(digests.size).toBe(changed.length + 1);
    // Array order is significant; a nested value change propagates.
    expect(await canonicalDigest({ ...TRICKY, b: [true, 1, null, TRICKY.b[3]] })).not.toBe(TRICKY_DIGEST);
    expect(await canonicalDigest({ ...TRICKY, b: [1, true, null, { z: '\n\t"\\\u0001\u007f', a: 1 }] })).not.toBe(
      TRICKY_DIGEST,
    );

    // Values outside the atproto data model are refused, never silently digested.
    for (const bad of [
      { n: 1.5 },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { n: 2 ** 53 },
      { n: 1n },
      { s: '\ud800' },
      { '\udc00': 1 },
      { d: new Date(0) },
      { f: () => 1 },
      { a: [1, undefined] },
      // biome-ignore lint/suspicious/noSparseArray: a hole must be refused
      { a: [1, , 2] },
      { m: new Map() },
      { b: new Uint8Array(1) },
      { [Symbol('k')]: 1 },
      undefined,
    ]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
      await expect(canonicalDigest(bad)).rejects.toThrow(TypeError);
    }
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    // A shared (non-cyclic) sub-object is fine.
    const shared = { x: 1 };
    expect(canonicalJson({ p: shared, q: [shared] })).toBe('{"p":{"x":1},"q":[{"x":1}]}');
    expect(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
    expect(canonicalJson(-0)).toBe('0');
  });
});
