// W1-06: bounded Jetstream event parser (ADR 0004 §5.4/§5.5, M4.1.1 as amended
// by A6/A17). Expected values are hardcoded, never computed by the code under
// test. Fixture prefix com.example.atmusic only; frozen clock 2026-01-15T12:00:00Z.
import {
  buildSubscribeUrl,
  type JetstreamParseResult,
  MAX_JETSTREAM_MESSAGE_BYTES,
  parseJetstreamMessage,
} from '@atmusic/atproto/jetstream/events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SCROBBLE = 'com.example.atmusic.scrobble';
const FOLLOW = 'com.example.atmusic.follow';
const SETTINGS = 'com.example.atmusic.settings';
const CONFIGURED = new Set([SCROBBLE, FOLLOW, SETTINGS]);

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const REV = '3lfgpmmyjtk2a';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
/** 2026-01-15T12:00:00Z in unix microseconds. */
const FROZEN_US = 1_768_478_400_000_000;
const V2 = 'network.bsky.jetstream.subscribeEvents';

/** Jetstream v2 (xrpc.v1.json) message frame. */
function v2(payload: Record<string, unknown>): string {
  return JSON.stringify({ $type: 'message', payload });
}

function v2Commit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: `${V2}#commit`,
    did: ALICE,
    seq: 4_242,
    time: '2026-01-15T12:00:00.000000Z',
    operation: 'create',
    collection: SCROBBLE,
    rkey: 'r01',
    rev: REV,
    cid: CID,
    record: { $type: SCROBBLE, artist: 'Björk', track: 'Jóga' },
    ...over,
  };
}

/** Flat Jetstream event shape (`kind` + `time_us`). */
function flat(over: Record<string, unknown> = {}, commitOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    did: ALICE,
    time_us: FROZEN_US,
    kind: 'commit',
    commit: {
      rev: REV,
      operation: 'create',
      collection: SCROBBLE,
      rkey: 'r01',
      cid: CID,
      record: { $type: SCROBBLE, artist: 'Björk', track: 'Jóga' },
      ...commitOver,
    },
    ...over,
  });
}

function parse(text: string, allowed: ReadonlySet<string> | readonly string[] = CONFIGURED): JetstreamParseResult {
  return parseJetstreamMessage(text, allowed);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseJetstreamMessage', () => {
  it('commit create/update/delete for configured collection yields hint with seq and time_us', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // v2 create: exact hint, record body never carried over.
    expect(parse(v2(v2Commit()))).toEqual({
      kind: 'hint',
      did: ALICE,
      collection: SCROBBLE,
      rkey: 'r01',
      operation: 'create',
      rev: REV,
      cid: CID,
      seq: 4_242,
      timeUs: FROZEN_US,
    });

    // v2 update on follow with microsecond time; v2 delete on settings has no cid.
    expect(
      parse(
        v2(
          v2Commit({
            operation: 'update',
            collection: FOLLOW,
            rkey: '3lfgpmmyjtk2b',
            seq: 4_243,
            time: '2026-01-15T12:00:00.123456Z',
          }),
        ),
      ),
    ).toEqual({
      kind: 'hint',
      did: ALICE,
      collection: FOLLOW,
      rkey: '3lfgpmmyjtk2b',
      operation: 'update',
      rev: REV,
      cid: CID,
      seq: 4_243,
      timeUs: 1_768_478_400_123_456,
    });
    const del = v2Commit({ operation: 'delete', collection: SETTINGS, rkey: 'self', seq: 4_244 });
    delete del.cid;
    delete del.record;
    const delHint = parse(v2(del));
    expect(delHint).toEqual({
      kind: 'hint',
      did: ALICE,
      collection: SETTINGS,
      rkey: 'self',
      operation: 'delete',
      rev: REV,
      seq: 4_244,
      timeUs: FROZEN_US,
    });
    expect(Object.hasOwn(delHint, 'cid')).toBe(false);

    // Zone offsets are honoured; nanosecond fractions truncate to µs.
    expect(parse(v2(v2Commit({ time: '2026-01-15T21:00:00.000000999+09:00' })))).toMatchObject({
      kind: 'hint',
      timeUs: FROZEN_US,
    });

    // Flat shape: explicit seq wins; otherwise the cursor is time_us.
    expect(parse(flat({ seq: 77 }))).toEqual({
      kind: 'hint',
      did: ALICE,
      collection: SCROBBLE,
      rkey: 'r01',
      operation: 'create',
      rev: REV,
      cid: CID,
      seq: 77,
      timeUs: FROZEN_US,
    });
    expect(parse(flat({ did: BOB }, { operation: 'update', rkey: 'r10' }))).toEqual({
      kind: 'hint',
      did: BOB,
      collection: SCROBBLE,
      rkey: 'r10',
      operation: 'update',
      rev: REV,
      cid: CID,
      seq: FROZEN_US,
      timeUs: FROZEN_US,
    });
    expect(
      parse(flat({ time_us: FROZEN_US + 5 }, { operation: 'delete', rkey: 'r08', cid: undefined, record: undefined })),
    ).toEqual({
      kind: 'hint',
      did: ALICE,
      collection: SCROBBLE,
      rkey: 'r08',
      operation: 'delete',
      rev: REV,
      seq: FROZEN_US + 5,
      timeUs: FROZEN_US + 5,
    });

    // allowedCollections as a plain array behaves identically.
    expect(parse(v2(v2Commit()), [SCROBBLE])).toMatchObject({ kind: 'hint', collection: SCROBBLE, seq: 4_242 });

    // Exactly 64 KiB is accepted (the bound is "over 64 KiB").
    const baseBytes = new TextEncoder().encode(v2(v2Commit({ pad: '' }))).length;
    const exact = v2(v2Commit({ pad: 'x'.repeat(MAX_JETSTREAM_MESSAGE_BYTES - baseBytes) }));
    expect(new TextEncoder().encode(exact).length).toBe(65_536);
    expect(parse(exact)).toMatchObject({ kind: 'hint', rkey: 'r01', seq: 4_242 });

    // Pure: parsing never touches the network.
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('identity/account/sync kinds and foreign collections are ignored', () => {
    // v2 non-commit kinds: ignored, but still carry the cursor so it advances.
    for (const kind of ['identity', 'account', 'sync']) {
      const frame = v2({
        $type: `${V2}#${kind}`,
        did: ALICE,
        seq: 900,
        time: '2026-01-15T12:00:00Z',
        [kind]: { did: ALICE, seq: 123_456_789, time: '2026-01-15T11:59:59Z', active: false, status: 'deactivated' },
      });
      expect(parse(frame)).toEqual({ kind: 'ignore', seq: 900, timeUs: FROZEN_US });
    }
    // Flat non-commit kinds.
    for (const kind of ['identity', 'account', 'sync']) {
      const event = JSON.stringify({
        did: ALICE,
        time_us: FROZEN_US,
        kind,
        [kind]: { did: ALICE, seq: 1, time: '2026-01-15T12:00:00Z', active: false },
      });
      expect(parse(event)).toEqual({ kind: 'ignore', seq: FROZEN_US, timeUs: FROZEN_US });
    }

    // Foreign collections, including prefix look-alikes, are ignored (not invalid),
    // even when their DID/rkey would fail syntax: they are never keyed.
    for (const collection of [
      'app.bsky.feed.post',
      'com.example.atmusic.scrobblex',
      'com.example.atmusic.scrobble.extra',
      'com.example.atmusic',
      'COM.EXAMPLE.ATMUSIC.SCROBBLE',
    ]) {
      expect(parse(v2(v2Commit({ collection })))).toEqual({ kind: 'ignore', seq: 4_242, timeUs: FROZEN_US });
      expect(parse(flat({}, { collection }))).toEqual({ kind: 'ignore', seq: FROZEN_US, timeUs: FROZEN_US });
    }
    expect(parse(v2(v2Commit({ collection: 'app.bsky.feed.like', did: 'not-a-did', rkey: '..' })))).toEqual({
      kind: 'ignore',
      seq: 4_242,
      timeUs: FROZEN_US,
    });

    // Operations other than create/update/delete are ignored.
    expect(parse(v2(v2Commit({ operation: 'resync' })))).toEqual({ kind: 'ignore', seq: 4_242, timeUs: FROZEN_US });

    // An empty configuration ignores every commit.
    expect(parse(v2(v2Commit()), new Set())).toEqual({ kind: 'ignore', seq: 4_242, timeUs: FROZEN_US });
    expect(parse(flat(), [])).toEqual({ kind: 'ignore', seq: FROZEN_US, timeUs: FROZEN_US });

    // Server advisories are ignored with a notice and never move the cursor.
    expect(parse(v2({ $type: `${V2}#info`, name: 'OutdatedCursor', message: 'clamped to floor' }))).toEqual({
      kind: 'ignore',
      notice: { type: 'info', name: 'OutdatedCursor', message: 'clamped to floor' },
    });
    expect(parse(JSON.stringify({ $type: 'error', error: 'ConsumerTooSlow' }))).toEqual({
      kind: 'ignore',
      notice: { type: 'error', name: 'ConsumerTooSlow' },
    });
  });

  it('oversize, malformed JSON, bad DID, unsafe integer are invalid', () => {
    const invalid = (reason: string) => ({ kind: 'invalid', reason });

    // Oversize: one byte over 64 KiB, by ASCII length and by UTF-8 byte length.
    const baseBytes = new TextEncoder().encode(v2(v2Commit({ pad: '' }))).length;
    const overByOne = v2(v2Commit({ pad: 'x'.repeat(MAX_JETSTREAM_MESSAGE_BYTES - baseBytes + 1) }));
    expect(new TextEncoder().encode(overByOne).length).toBe(65_537);
    expect(parse(overByOne)).toEqual(invalid('oversize'));
    const multibyte = v2(v2Commit({ pad: 'é'.repeat(40_000) })); // 2 bytes each; < 65,536 UTF-16 units
    expect(multibyte.length).toBeLessThan(MAX_JETSTREAM_MESSAGE_BYTES);
    expect(parse(multibyte)).toEqual(invalid('oversize'));
    expect(parse(' '.repeat(10 * MAX_JETSTREAM_MESSAGE_BYTES))).toEqual(invalid('oversize'));

    // Malformed (non-strict) JSON.
    for (const text of ['', '{', '{"kind":"commit",}', "{'kind':'commit'}", '{"time_us":NaN}', `${flat()} trailing`]) {
      expect(parse(text)).toEqual(invalid('malformed_json'));
    }
    // Valid JSON, wrong shape.
    for (const text of [
      'null',
      '42',
      '"commit"',
      '[]',
      JSON.stringify([JSON.parse(flat())]),
      '{}',
      JSON.stringify({ $type: 'message' }),
      JSON.stringify({ $type: 'message', payload: { did: ALICE } }),
      JSON.stringify({ $type: 'message', payload: { $type: 'com.atproto.sync.subscribeRepos#commit' } }),
      JSON.stringify({ $type: 'mystery', payload: v2Commit() }),
      v2(v2Commit({ seq: '4242' })),
      v2(v2Commit({ rkey: 7 })),
      v2(v2Commit({ cid: { $link: CID } })),
      flat({ commit: 'create' }),
      flat({ time_us: '1768478400000000' }),
      flat({ kind: 1 }),
    ]) {
      expect(parse(text)).toEqual(invalid('shape'));
    }
    expect(parseJetstreamMessage(undefined as unknown as string, CONFIGURED)).toEqual(invalid('shape'));

    // Bad DIDs on a configured collection.
    for (const did of [
      'alice.test',
      'did:PLC:aaaaaaaaaaaaaaaaaaaaaaaa',
      'did:plc:',
      'did:plc:aaaa:',
      'did:plc:aa%zz',
      'did:plc:aa%',
      'did:plc:aaa/aaa',
      'did:plc:aaa aaa',
      `did:plc:${'a'.repeat(2_041)}`,
    ]) {
      expect(parse(v2(v2Commit({ did })))).toEqual(invalid('did'));
      expect(parse(flat({ did }))).toEqual(invalid('did'));
    }
    expect(parse(v2(v2Commit({ did: `did:plc:${'a'.repeat(2_040)}` })))).toMatchObject({ kind: 'hint' }); // 2048 ok

    // Bad rkeys, revisions, CIDs and times.
    for (const rkey of ['', '.', '..', 'a/b', 'r 1', 'r#1', 'x'.repeat(513)]) {
      expect(parse(v2(v2Commit({ rkey })))).toEqual(invalid('rkey'));
    }
    for (const rev of ['', '3lfgpmmyjtk2', '3lfgpmmyjtk2aa', 'klfgpmmyjtk2a', '3LFGPMMYJTK2A', '3lfgpmmyjtk1a']) {
      expect(parse(v2(v2Commit({ rev })))).toEqual(invalid('rev'));
    }
    const noCid = v2Commit();
    delete noCid.cid;
    expect(parse(v2(noCid))).toEqual(invalid('cid'));
    expect(parse(v2(v2Commit({ cid: 'short' })))).toEqual(invalid('cid'));
    expect(parse(v2(v2Commit({ operation: 'delete' })))).toEqual(invalid('cid')); // delete carrying a cid
    for (const time of [
      '2026-02-30T12:00:00Z',
      '2026-01-15T24:00:00Z',
      '2026-01-15T12:00:60Z',
      '2026-01-15 12:00:00Z',
      '2026-01-15T12:00:00',
      '2026-01-15T12:00:00-00:00',
      '0099-01-01T00:00:00Z',
      '1969-12-31T23:59:59Z',
    ]) {
      expect(parse(v2(v2Commit({ time })))).toEqual(invalid('time'));
    }

    // Unsafe or out-of-range integers for seq and time_us (2^53 + 1 parses lossy).
    for (const seq of ['9007199254740993', '1e300', '1.5', '-1', '0']) {
      expect(parse(v2(v2Commit()).replace('"seq":4242', `"seq":${seq}`))).toEqual(invalid('unsafe_integer'));
      expect(parse(flat({ seq: 1 }).replace('"seq":1', `"seq":${seq}`))).toEqual(invalid('unsafe_integer'));
    }
    for (const timeUs of ['9007199254740993', '1768478400000000.5', '-1']) {
      expect(parse(flat().replace(`"time_us":${FROZEN_US}`, `"time_us":${timeUs}`))).toEqual(invalid('unsafe_integer'));
    }
    // Unsafe integers invalidate ignorable kinds too: the cursor must never take a lossy value.
    expect(
      parse(
        JSON.stringify({ did: ALICE, time_us: 0, kind: 'identity' }).replace(
          '"time_us":0',
          '"time_us":9007199254740993',
        ),
      ),
    ).toEqual(invalid('unsafe_integer'));
  });
});

describe('buildSubscribeUrl', () => {
  it('buildSubscribeUrl always contains kinds=commit and every collection, never identity/account', () => {
    const collections = [SCROBBLE, FOLLOW, SETTINGS];

    const resumed = buildSubscribeUrl('wss://jetstream.us-east.bsky.network', collections, 4_242);
    expect(resumed).toBe(
      'https://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents' +
        '?kinds=commit&collections=com.example.atmusic.scrobble&collections=com.example.atmusic.follow' +
        '&collections=com.example.atmusic.settings&cursor=4242',
    );

    const cases: Array<[string, readonly string[], number | undefined]> = [
      ['jetstream.us-west.bsky.network', collections, undefined],
      ['https://jetstream.us-west.bsky.network/', collections, FROZEN_US],
      ['jetstream.test:8443', [SCROBBLE], 0],
      ['wss://jetstream.us-east.bsky.network', [SCROBBLE, SCROBBLE, FOLLOW], 1],
    ];
    for (const [host, cols, cursor] of cases) {
      const url = new URL(buildSubscribeUrl(host, cols, cursor));
      expect(url.protocol).toBe('https:');
      expect(url.pathname).toBe('/xrpc/network.bsky.jetstream.subscribeEvents');
      expect(url.searchParams.getAll('kinds')).toEqual(['commit']);
      expect(url.searchParams.getAll('collections')).toEqual([...new Set(cols)]);
      expect(url.searchParams.getAll('cursor')).toEqual(cursor === undefined ? [] : [String(cursor)]);
      expect([...new Set(url.searchParams.keys())].sort()).toEqual(
        cursor === undefined ? ['collections', 'kinds'] : ['collections', 'cursor', 'kinds'],
      );
      for (const forbidden of ['identity', 'account', 'sync', 'wantedDids', 'dids']) {
        expect(url.search).not.toContain(forbidden);
      }
    }
    expect(new URL(buildSubscribeUrl('jetstream.test:8443', [SCROBBLE])).host).toBe('jetstream.test:8443');

    // Refusals: insecure schemes, non-origin hosts, empty/invalid/wildcard collections, bad cursors.
    const refuse: Array<() => string> = [
      () => buildSubscribeUrl('http://jetstream.test', collections),
      () => buildSubscribeUrl('ws://jetstream.test', collections),
      () => buildSubscribeUrl('wss://jetstream.test/subscribe', collections),
      () => buildSubscribeUrl('wss://jetstream.test?kinds=identity', collections),
      () => buildSubscribeUrl('wss://user:pw@jetstream.test', collections),
      () => buildSubscribeUrl('', collections),
      () => buildSubscribeUrl('jetstream.test', []),
      () => buildSubscribeUrl('jetstream.test', ['com.example.atmusic.*']),
      () => buildSubscribeUrl('jetstream.test', ['scrobble']),
      () => buildSubscribeUrl('jetstream.test', [`${SCROBBLE}&kinds=identity`]),
      () =>
        buildSubscribeUrl(
          'jetstream.test',
          Array.from({ length: 101 }, (_, i) => `com.example.atmusic.c${i}`),
        ),
      () => buildSubscribeUrl('jetstream.test', collections, -1),
      () => buildSubscribeUrl('jetstream.test', collections, 1.5),
      () => buildSubscribeUrl('jetstream.test', collections, 2 ** 53),
    ];
    for (const call of refuse) expect(call).toThrow(TypeError);
  });
});
