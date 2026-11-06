import {
  formatAtUri,
  isDid,
  isDidPlc,
  isDidWeb,
  isDisallowedHandleTld,
  isHandle,
  isNsid,
  isRecordKey,
  isSupportedDid,
  isTid,
  normalizeHandle,
  parseAtUri,
  parseRecordUri,
  tidTimestampUs,
} from '@atmusic/core/syntax';
import { expect, it } from 'vitest';

// Vectors from the atproto specs' syntax interop files
// (https://github.com/bluesky-social/atproto-interop-tests/tree/main/syntax),
// plus the oracle's DID edge cases (crates/core/src/follow.rs).

function verdicts(fn: (s: string) => boolean, values: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(values.map((v) => [v, fn(v)]));
}
function all(values: readonly string[], verdict: boolean): Record<string, boolean> {
  return Object.fromEntries(values.map((v) => [v, verdict]));
}

const DID_VALID = [
  'did:plc:z72i7hdynmk6r22z27h6tvur',
  'did:web:blueskyweb.xyz',
  'did:method:val:two',
  'did:m:v',
  'did:method::::val',
  'did:method:-:_:.',
  'did:key:zQ3shZc2QzApp2oymGvQbzP8eKheVshBHbU4ZYjeXqwSKEn6N',
  'did:web:localhost%3A1234',
  'did:example:a%2Fb',
  `did:plc:${'a'.repeat(2040)}`, // 2048 chars
];
const DID_INVALID = [
  'did',
  'didmethod:val',
  'did:method:',
  'did:method:val:',
  'did::val',
  'did:method:val/two',
  'did:method:val?two',
  'did:method:val#two',
  'did:method:val two',
  'did:METHOD:val',
  'did:m123:val',
  'DID:method:val',
  'did:method:val%',
  'did:method:val%2',
  'did:method:val%zz',
  'did:plc:ä',
  '',
  `did:plc:${'a'.repeat(2041)}`, // 2049 chars
];

const HANDLE_VALID = [
  'jay.bsky.social',
  '8.cn',
  'name.t--t',
  'XX.LCS.MIT.EDU',
  'a.co',
  'xn--notarealidn.com',
  'xn--fiqa61au8b7zsevnm8ak20mc4a87e.xn--fiqs8s',
  'xn--ls8h.test',
  'example.t',
  'alice.test',
  'jo-hn.test',
  `${'a'.repeat(63)}.test`,
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.e`, // 253
  '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion',
];
const HANDLE_INVALID = [
  'jo@hn.test',
  '💩.test',
  'john..test',
  'xn--bcher-.tld',
  'john.0',
  'cn.8',
  'www.masełkowski.pl.com',
  'org',
  'name.org.',
  '.name.org',
  '-alice.test',
  'alice-.test',
  'alice.test/x',
  'did:plc:z72i7hdynmk6r22z27h6tvur',
  `${'a'.repeat(64)}.test`,
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.e`, // 254
  '',
];

const NSID_VALID = [
  'com.example.fooBar',
  'net.users.bob.ping',
  'a.b.c',
  'm.xn--masekowski-d0b.pl',
  'one.two.three',
  'one.two.three.four-and.FiVe',
  'one.2.three',
  'a-0.b-1.c',
  'a0.b1.cc',
  'cn.8.lex.stuff',
  'test.12345.record',
  'a01.thing.record',
  'a.0.c',
  'xn--fiqs8s.xn--fiqa61au8b7zsevnm8ak20mc4a87e.record.two',
  'com.example.atmusic.scrobble',
  'dev.pythonplayer123.music.settings',
  `com.${'a'.repeat(63)}.${'b'.repeat(63)}`,
];
const NSID_INVALID = [
  'com.exaðmple.thing',
  'com.example',
  'com.example.3',
  'com.example.foo-bar',
  'com.example.foo_bar',
  'com.example.foo*',
  '1.0.0.127.record',
  'a.b..c',
  '.com.example.foo',
  'com.example.foo.',
  'com.-example.foo',
  'com.example-.foo',
  `com.${'a'.repeat(64)}.foo`,
  `com.example.${'a'.repeat(64)}`,
  'com.example.atmusic/scrobble',
  '',
];

const TID_VALID = ['3jzfcijpj2z2a', '7777777777777', '3zzzzzzzzzzzz', '2222222222222', 'jzzzzzzzzzzzz'];
const TID_INVALID = [
  '3jzfcijpj2z21',
  '0000000000000',
  '3jzfcijpj2z2aa',
  '3jzfcijpj2z2',
  '3jzf-cij-pj2z-2a',
  'zzzzzzzzzzzzz',
  'kjzfcijpj2z2a',
  '3JZFCIJPJ2Z2A',
  '',
];

const RKEY_VALID = [
  '3jzfcijpj2z2a',
  'self',
  'example.com',
  '~1.2-3_',
  'dHJ1ZQ',
  'pre:fix',
  '_',
  `f${'0'.repeat(64)}`,
  'a'.repeat(512),
];
const RKEY_INVALID = [
  '',
  '.',
  '..',
  'alpha/beta',
  '#extra',
  '@handle',
  'any space',
  'any+space',
  'number[3]',
  'number(3)',
  '"quote"',
  'dHJ1ZQ==',
  'ünïcode',
  'a'.repeat(513),
];

it('DID/handle/NSID/AT-URI/TID accept and reject spec vectors', () => {
  // DIDs: generic syntax (the follow-subject rule) and the two supported methods.
  expect(verdicts(isDid, DID_VALID)).toEqual(all(DID_VALID, true));
  expect(verdicts(isDid, DID_INVALID)).toEqual(all(DID_INVALID, false));
  const plcValid = ['did:plc:z72i7hdynmk6r22z27h6tvur', 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'];
  const plcInvalid = [
    'did:plc:z72i7hdynmk6r22z27h6tvu', // 23 chars
    'did:plc:z72i7hdynmk6r22z27h6tvurr', // 25 chars
    'did:plc:Z72i7hdynmk6r22z27h6tvur', // uppercase
    'did:plc:z72i7hdynmk6r22z27h6tv18', // 1 and 8 are not base32
    'did:web:z72i7hdynmk6r22z27h6tvur',
  ];
  expect(verdicts(isDidPlc, plcValid)).toEqual(all(plcValid, true));
  expect(verdicts(isDidPlc, plcInvalid)).toEqual(all(plcInvalid, false));
  const webValid = ['did:web:example.com', 'did:web:blueskyweb.xyz', 'did:web:localhost', 'did:web:localhost%3A8080'];
  const webInvalid = [
    'did:web:example.com:path', // path-based did:web is unsupported
    'did:web:example.com%3A443', // ports only for localhost
    'did:web:localhost%3A0',
    'did:web:localhost%3A65536',
    'did:web:-bad.com',
    'did:web:com',
    'did:web:',
    'did:plc:example.com',
  ];
  expect(verdicts(isDidWeb, webValid)).toEqual(all(webValid, true));
  expect(verdicts(isDidWeb, webInvalid)).toEqual(all(webInvalid, false));
  expect(isSupportedDid('did:plc:z72i7hdynmk6r22z27h6tvur')).toBe(true);
  expect(isSupportedDid('did:web:example.com')).toBe(true);
  expect(isSupportedDid('did:key:zQ3shZc2QzApp2oymGvQbzP8eKheVshBHbU4ZYjeXqwSKEn6N')).toBe(false);
  expect(isSupportedDid('did:example:abc')).toBe(false);

  // Handles.
  expect(verdicts(isHandle, HANDLE_VALID)).toEqual(all(HANDLE_VALID, true));
  expect(verdicts(isHandle, HANDLE_INVALID)).toEqual(all(HANDLE_INVALID, false));
  expect(normalizeHandle('XX.LCS.MIT.EDU')).toBe('xx.lcs.mit.edu');
  expect(isDisallowedHandleTld('2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion')).toBe(true);
  expect(isDisallowedHandleTld('host.LOCAL')).toBe(true);
  expect(isDisallowedHandleTld('alice.test')).toBe(false);
  expect(isDisallowedHandleTld('jay.bsky.social')).toBe(false);

  // NSIDs.
  expect(verdicts(isNsid, NSID_VALID)).toEqual(all(NSID_VALID, true));
  expect(verdicts(isNsid, NSID_INVALID)).toEqual(all(NSID_INVALID, false));
  const longAuthority = `${Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')}`; // 254-char authority
  expect(longAuthority.length).toBe(254);
  expect(isNsid(`${longAuthority}.name`)).toBe(false);
  expect(isNsid(`${longAuthority.slice(1)}.name`)).toBe(true);

  // TIDs.
  expect(verdicts(isTid, TID_VALID)).toEqual(all(TID_VALID, true));
  expect(verdicts(isTid, TID_INVALID)).toEqual(all(TID_INVALID, false));
  expect(tidTimestampUs('2222222222222')).toBe(0);
  expect(tidTimestampUs('3jzfcijpj2z2a')).toBe(1_688_137_381_887_007);
  expect(() => tidTimestampUs('nope')).toThrow(RangeError);

  // Record keys.
  expect(verdicts(isRecordKey, RKEY_VALID)).toEqual(all(RKEY_VALID, true));
  expect(verdicts(isRecordKey, RKEY_INVALID)).toEqual(all(RKEY_INVALID, false));

  // AT URIs: parse, restricted form, and format.
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  expect(parseAtUri(`at://${did}/com.example.atmusic.scrobble/3jzfcijpj2z2a`)).toEqual({
    authority: did,
    collection: 'com.example.atmusic.scrobble',
    rkey: '3jzfcijpj2z2a',
  });
  expect(parseAtUri(`at://${did}`)).toEqual({ authority: did, collection: null, rkey: null });
  expect(parseAtUri(`at://${did}/app.bsky.feed.post`)).toEqual({
    authority: did,
    collection: 'app.bsky.feed.post',
    rkey: null,
  });
  expect(parseAtUri('at://alice.test/app.bsky.feed.post/xyz')).toEqual({
    authority: 'alice.test',
    collection: 'app.bsky.feed.post',
    rkey: 'xyz',
  });
  const badUris = [
    `at://${did}/`,
    `at://${did}/com.example.atmusic.scrobble/`,
    `at://${did}/com.example.atmusic.scrobble/r?x=1`,
    `at://${did}/com.example.atmusic.scrobble/r#frag`,
    `at://${did}/notnsid/r`,
    `at://${did}/com.example.atmusic.scrobble/..`,
    `at://${did}/com.example.atmusic.scrobble/r/extra`,
    `at://${did}/com.example.atmusic.scrobble/a%20b`,
    `https://${did}/com.example.atmusic.scrobble/r`,
    'at://',
    'at://not a handle/a.b.c/r',
    `at://${did}/com.example.atmusic.scrobble/${'a'.repeat(8200)}`,
  ];
  expect(Object.fromEntries(badUris.map((u) => [u, parseAtUri(u)]))).toEqual(
    Object.fromEntries(badUris.map((u) => [u, null])),
  );
  expect(parseRecordUri(`at://${did}/com.example.atmusic.follow/fabc`)).toEqual({
    did,
    collection: 'com.example.atmusic.follow',
    rkey: 'fabc',
  });
  expect(parseRecordUri('at://alice.test/com.example.atmusic.follow/fabc')).toBeNull();
  expect(parseRecordUri(`at://${did}`)).toBeNull();

  const formatted = formatAtUri(did, 'com.example.atmusic.scrobble', '3jzfcijpj2z2a');
  expect(formatted).toBe(`at://${did}/com.example.atmusic.scrobble/3jzfcijpj2z2a`);
  expect(parseRecordUri(formatted)).toEqual({
    did,
    collection: 'com.example.atmusic.scrobble',
    rkey: '3jzfcijpj2z2a',
  });
  expect(() => formatAtUri('alice.test', 'com.example.atmusic.scrobble', 'r')).toThrow(RangeError);
  expect(() => formatAtUri(did, 'com.example', 'r')).toThrow(RangeError);
  expect(() => formatAtUri(did, 'com.example.atmusic.scrobble', '..')).toThrow(RangeError);
});
