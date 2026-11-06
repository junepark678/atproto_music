// Last.fm 2.0 request parameters (ADR 0005 §7.1, §7.7; N2-07): the merged
// query string and form body, duplicate refusal, the indexed arrays of
// track.scrobble and format negotiation. Every expected value is written out
// literally from the ADR text.

import { describe, expect, it } from 'vitest';
import { LastfmError } from '../../../src/lastfm/errors';
import {
  type LastfmParams,
  MAX_BODY_BYTES,
  negotiateFormat,
  parseIndexedEntries,
  parseLastfmParams,
  readLastfmParams,
  wantsRawXml,
} from '../../../src/lastfm/params';

const ROOT = 'https://music.214510.xyz/2.0/';
const FORM = 'application/x-www-form-urlencoded';
const SCROBBLE_FIELDS = ['artist', 'track', 'timestamp', 'album', 'albumArtist', 'duration'] as const;
const REQUIRED = ['artist', 'track', 'timestamp'] as const;

function form(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function post(body: string, query = ''): LastfmParams {
  return parseLastfmParams({ url: `${ROOT}${query}`, contentType: FORM, body });
}

/** The LastfmError a thunk throws (fails the test when it throws nothing or something else). */
function lastfmErrorOf(thunk: () => unknown): LastfmError {
  try {
    thunk();
  } catch (err) {
    expect(err).toBeInstanceOf(LastfmError);
    return err as LastfmError;
  }
  throw new Error('expected a LastfmError, nothing was thrown');
}

function scrobblePairs(indices: readonly number[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ['method', 'track.scrobble'],
    ['api_key', 'k'],
  ];
  for (const i of indices) {
    pairs.push(
      [`artist[${i}]`, `Artist ${i}`],
      [`track[${i}]`, `Track ${i}`],
      [`timestamp[${i}]`, String(1768474800 + i)],
    );
  }
  return pairs;
}

describe('Last.fm parameters', () => {
  it('artist[0..49] parse from a form body; an unindexed single set parses; index 50, 51 entries, mixed forms or a duplicate parameter give error 6', () => {
    // 50 indexed entries, sent out of order, come back ordered by index.
    const fifty = Array.from({ length: 50 }, (_, i) => 49 - i);
    const params = post(form(scrobblePairs(fifty)));
    const entries = parseIndexedEntries(params, SCROBBLE_FIELDS, { required: REQUIRED });
    expect(entries).toHaveLength(50);
    expect(entries[0]).toEqual({ artist: 'Artist 0', track: 'Track 0', timestamp: '1768474800' });
    expect(entries[10]).toEqual({ artist: 'Artist 10', track: 'Track 10', timestamp: '1768474810' });
    expect(entries[49]).toEqual({ artist: 'Artist 49', track: 'Track 49', timestamp: '1768474849' });
    // Non-entry parameters are not part of an entry.
    expect(Object.keys(entries[0] as object)).not.toContain('method');

    // UTF-8 and '+' decoding inside a form body.
    const utf8 = post(
      'artist%5B0%5D=Bj%C3%B6rk&track%5B0%5D=J%C3%B3ga+%28live%29&timestamp%5B0%5D=1768474800&album%5B0%5D=',
    );
    expect(parseIndexedEntries(utf8, SCROBBLE_FIELDS, { required: REQUIRED })).toEqual([
      { artist: 'Björk', track: 'Jóga (live)', timestamp: '1768474800', album: '' },
    ]);

    // The unindexed single set.
    const single = post(
      form([
        ['method', 'track.scrobble'],
        ['artist', 'Solo'],
        ['track', 'One'],
        ['timestamp', '1768474800'],
      ]),
    );
    expect(parseIndexedEntries(single, SCROBBLE_FIELDS, { required: REQUIRED })).toEqual([
      { artist: 'Solo', track: 'One', timestamp: '1768474800' },
    ]);

    // Index 50 alone.
    const at50 = lastfmErrorOf(() => parseIndexedEntries(post(form(scrobblePairs([50]))), SCROBBLE_FIELDS));
    expect(at50.code).toBe(6);
    expect(at50.status).toBe(400);

    // 51 entries (indices 0..50).
    const fiftyOne = Array.from({ length: 51 }, (_, i) => i);
    expect(lastfmErrorOf(() => parseIndexedEntries(post(form(scrobblePairs(fiftyOne))), SCROBBLE_FIELDS)).code).toBe(6);

    // Mixed forms: an indexed entry plus an unindexed field.
    const mixed = post(form([...scrobblePairs([0]), ['album', 'Loose']]));
    expect(lastfmErrorOf(() => parseIndexedEntries(mixed, SCROBBLE_FIELDS)).code).toBe(6);

    // Non-canonical indices.
    for (const bad of ['artist[01]', 'artist[]', 'artist[-1]', 'artist[x]']) {
      const p = post(
        form([
          [bad, 'A'],
          ['track[0]', 'T'],
          ['timestamp[0]', '1'],
        ]),
      );
      expect(lastfmErrorOf(() => parseIndexedEntries(p, SCROBBLE_FIELDS)).code, bad).toBe(6);
    }

    // A missing required field in any entry, and no entry at all.
    const missing = post(form([...scrobblePairs([0, 1]).filter(([k]) => k !== 'timestamp[1]')]));
    expect(lastfmErrorOf(() => parseIndexedEntries(missing, SCROBBLE_FIELDS, { required: REQUIRED })).code).toBe(6);
    const none = post(form([['method', 'track.scrobble']]));
    expect(lastfmErrorOf(() => parseIndexedEntries(none, SCROBBLE_FIELDS, { required: REQUIRED })).code).toBe(6);

    // Duplicates: twice in the body, twice in the query, once in each.
    const twiceBody = lastfmErrorOf(() => post('artist%5B0%5D=a&artist%5B0%5D=b'));
    expect(twiceBody.code).toBe(6);
    expect(twiceBody.message).toContain('duplicate');
    expect(lastfmErrorOf(() => post('', '?method=a&method=a')).code).toBe(6);
    expect(lastfmErrorOf(() => post('api_key=x', '?api_key=y')).code).toBe(6);
    // Encoded and plain spellings of one name are the same name.
    expect(lastfmErrorOf(() => post('artist%5B0%5D=a&artist[0]=b')).code).toBe(6);

    // Names are case-sensitive: these are two parameters.
    const cased = post('Artist=a&artist=b');
    expect(cased.get('Artist')).toBe('a');
    expect(cased.get('artist')).toBe('b');

    // Malformed encodings are refused rather than replaced.
    expect(lastfmErrorOf(() => post('artist=%E2%28')).code).toBe(6);
    expect(lastfmErrorOf(() => post('artist=%zz')).code).toBe(6);
    // A body of another content type is refused; an oversized one too.
    expect(
      lastfmErrorOf(() => parseLastfmParams({ url: ROOT, contentType: 'application/json', body: '{"a":1}' })).code,
    ).toBe(6);
    expect(lastfmErrorOf(() => post(`artist=${'a'.repeat(MAX_BODY_BYTES)}`)).code).toBe(6);
  });

  it('format=json in the query or body, or Accept: application/json, selects JSON; otherwise XML', async () => {
    const query = parseLastfmParams({ url: `${ROOT}?method=user.getInfo&format=json` });
    expect(negotiateFormat(query, null)).toBe('json');

    const body = post('method=user.getInfo&format=json');
    expect(negotiateFormat(body, undefined)).toBe('json');

    const plain = parseLastfmParams({ url: `${ROOT}?method=user.getInfo` });
    expect(negotiateFormat(plain, 'application/json')).toBe('json');
    expect(negotiateFormat(plain, 'text/html, application/json;q=0.9')).toBe('json');
    expect(negotiateFormat(plain, 'Application/JSON')).toBe('json');
    expect(negotiateFormat(plain, null)).toBe('xml');
    expect(negotiateFormat(plain, '*/*')).toBe('xml');
    expect(negotiateFormat(plain, 'application/xml')).toBe('xml');
    // An explicit format=xml is honoured over the Accept header.
    expect(negotiateFormat(parseLastfmParams({ url: `${ROOT}?format=xml` }), 'application/json')).toBe('xml');
    // A callback (JSONP) never changes the format.
    expect(negotiateFormat(parseLastfmParams({ url: `${ROOT}?callback=cb` }), null)).toBe('xml');

    // raw=true is read from the parameters.
    expect(wantsRawXml(parseLastfmParams({ url: `${ROOT}?raw=true` }))).toBe(true);
    expect(wantsRawXml(plain)).toBe(false);

    // Through a Request: the body's format=json reaches negotiation.
    const req = new Request(ROOT, {
      method: 'POST',
      headers: { 'content-type': `${FORM}; charset=UTF-8` },
      body: 'method=track.updateNowPlaying&format=json&artist=A&track=T',
    });
    const fromRequest = await readLastfmParams(req);
    expect(fromRequest.get('artist')).toBe('A');
    expect(negotiateFormat(fromRequest, req.headers.get('accept'))).toBe('json');

    // A streamed body over the cap is refused with 6.
    const big = new Request(ROOT, { method: 'POST', headers: { 'content-type': FORM }, body: `a=${'x'.repeat(64)}` });
    await expect(readLastfmParams(big, 32)).rejects.toMatchObject({ code: 6, status: 400 });
  });
});
