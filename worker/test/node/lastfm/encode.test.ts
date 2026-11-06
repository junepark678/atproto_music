// Last.fm 2.0 response encoding (ADR 0005 §7.1, §7.2, §7.6; N2-07).
//
// The goldens under ./golden/ were written by hand from the Last.fm API
// documentation samples (track.scrobble, track.updateNowPlaying,
// user.getRecentTracks, user.getTopArtists, user.getInfo, auth.getSession and
// the list methods) and from what the clients' parsers decode: Pano
// Scrobbler's LastfmDataClasses (PageEntries<T> reads every list as a JSON
// array with no single-object fallback, `"#text"` is required on attributed
// leaves, @attr carries page/totalPages/total) and the lastfm-ts-api 2.6.2
// response types (string numbers, `scrobbles.@attr.accepted` a number). They
// are not produced by the encoder; each test builds the element tree the
// method builders (N3-03, N3-04) produce and compares the encoder's output with
// the golden: the XML byte for byte, the JSON as parsed values (types
// included, key order not significant).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  encodeError,
  encodeSuccess,
  escapeXmlText,
  images,
  JSON_CONTENT_TYPE,
  type LfmDocument,
  type LfmElement,
  LfmTreeError,
  lastfmDate,
  lastfmResponse,
  leaf,
  lfmOk,
  list,
  node,
  type PageAttr,
  paged,
  toJson,
  toXml,
  XML_CONTENT_TYPE,
} from '../../../src/lastfm/encode';
import { LastfmError, type LastfmErrorCode } from '../../../src/lastfm/errors';
import { negotiateFormat, parseLastfmParams } from '../../../src/lastfm/params';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

function golden(name: string): { xml: string; json: unknown } {
  return {
    xml: readFileSync(join(GOLDEN, `${name}.xml`), 'utf8'),
    json: JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), 'utf8')),
  };
}

function expectGolden(name: string, doc: LfmDocument): void {
  const g = golden(name);
  expect(toXml(doc), `${name}.xml`).toBe(g.xml);
  expect(JSON.parse(toJson(doc)), `${name}.json`).toStrictEqual(g.json);
}

// ---------------------------------------------------------------------------
// Fixture trees (the shapes the method builders produce)
// ---------------------------------------------------------------------------

const URL_TT = 'https://www.last.fm/music/Test+Artist/_/Test+Track';
const URL_TA = 'https://www.last.fm/music/Test+Artist';
const URL_ALB = 'https://www.last.fm/music/Test+Artist/Test+Album';
const MBID = '00000000-0000-4000-8000-000000000001';
const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const LISTENED = 1768474800; // 2026-01-15T11:00:00Z, an hour before the frozen clock

function page(total: number): PageAttr {
  return { user: 'alice', page: 1, perPage: 50, totalPages: total === 0 ? 0 : 1, total };
}

function scrobble(track: string, artist: string, album: string, ts: number, code = 0, msg = ''): LfmElement {
  return node('scrobble', [
    leaf('track', track, { corrected: '0' }),
    leaf('artist', artist, { corrected: '0' }),
    leaf('album', album, { corrected: '0' }),
    leaf('albumArtist', '', { corrected: '0' }),
    leaf('timestamp', ts),
    leaf('ignoredMessage', msg, { code }),
  ]);
}

function scrobbles(accepted: number, ignored: number, items: LfmElement[]): LfmDocument {
  return lfmOk(node('scrobbles', items, { accepted, ignored }));
}

function recentTrack(): LfmElement {
  return node('track', [
    leaf('artist', 'Test Artist', { mbid: '' }),
    leaf('streamable', 0),
    images(),
    leaf('mbid', MBID),
    leaf('album', 'Test Album', { mbid: '' }),
    leaf('name', 'Test Track'),
    leaf('url', URL_TT),
    lastfmDate(LISTENED),
  ]);
}

function nowPlayingTrack(): LfmElement {
  return node(
    'track',
    [
      leaf('artist', 'Now Artist', { mbid: '' }),
      leaf('streamable', '0'),
      images(),
      leaf('mbid', ''),
      leaf('album', 'Now Album', { mbid: '' }),
      leaf('name', 'Now Track'),
      leaf('url', 'https://www.last.fm/music/Now+Artist/_/Now+Track'),
    ],
    { nowplaying: 'true' },
  );
}

function artistRef(): LfmElement {
  return node('artist', [leaf('name', 'Test Artist'), leaf('mbid', ''), leaf('url', URL_TA)]);
}

function topArtist(rank: number, name: string, plays: number, url: string): LfmElement {
  return node(
    'artist',
    [
      leaf('name', name),
      leaf('playcount', plays),
      leaf('mbid', ''),
      leaf('url', url),
      leaf('streamable', '0'),
      images(),
    ],
    { rank },
  );
}

function topTrack(): LfmElement {
  return node(
    'track',
    [
      leaf('name', 'Test Track'),
      leaf('duration', 215),
      leaf('playcount', 3),
      leaf('mbid', ''),
      leaf('url', URL_TT),
      leaf('streamable', '0', { fulltrack: '0' }),
      artistRef(),
      images(),
    ],
    { rank: 1 },
  );
}

function topAlbum(): LfmElement {
  return node(
    'album',
    [leaf('name', 'Test Album'), leaf('playcount', 4), leaf('mbid', ''), leaf('url', URL_ALB), artistRef(), images()],
    { rank: '1' },
  );
}

function lovedTrack(): LfmElement {
  return node('track', [
    leaf('name', 'Test Track'),
    leaf('mbid', ''),
    leaf('url', URL_TT),
    lastfmDate(LISTENED),
    artistRef(),
    images(),
    leaf('streamable', '0', { fulltrack: '0' }),
  ]);
}

function friend(): LfmElement {
  return node('user', [
    leaf('name', 'bob'),
    leaf('realname', ''),
    images(),
    leaf('url', `https://music.214510.xyz/u/${BOB_DID}`),
    leaf('country', 'None'),
    leaf('age', 0),
    leaf('gender', 'n'),
    leaf('subscriber', 0),
    leaf('playcount', 9),
    leaf('playlists', 0),
    leaf('bootstrap', 0),
    // A number here, deliberately: only the root user.registered.#text is a JSON number.
    leaf('registered', 1767225600, { unixtime: 1767225600 }),
    leaf('type', 'user'),
  ]);
}

function libraryArtist(): LfmElement {
  return node('artist', [
    leaf('name', 'Test Artist'),
    leaf('playcount', 12),
    leaf('tagcount', 0),
    leaf('mbid', ''),
    leaf('url', URL_TA),
    leaf('streamable', 0),
    images(),
  ]);
}

function userInfo(): LfmDocument {
  return lfmOk(
    node('user', [
      leaf('name', 'alice'),
      leaf('realname', ''),
      leaf('url', `https://music.214510.xyz/u/${DID}`),
      leaf('country', 'None'),
      leaf('age', '0'),
      leaf('gender', 'n'),
      leaf('subscriber', '0'),
      leaf('playcount', 42),
      leaf('artist_count', 7),
      leaf('track_count', 20),
      leaf('album_count', 9),
      leaf('playlists', '0'),
      leaf('bootstrap', '0'),
      leaf('registered', 1767225600, { unixtime: '1767225600' }),
      leaf('type', 'user'),
      images(),
    ]),
  );
}

function session(): LfmDocument {
  return lfmOk(
    node('session', [leaf('name', 'alice'), leaf('key', '0123456789abcdef0123456789abcdef'), leaf('subscriber', 0)]),
  );
}

const LIST_CASES: ReadonlyArray<{ golden: string; root: string; item: string; build: () => LfmElement }> = [
  { golden: 'user.getRecentTracks', root: 'recenttracks', item: 'track', build: recentTrack },
  { golden: 'user.getTopTracks', root: 'toptracks', item: 'track', build: topTrack },
  {
    golden: 'user.getTopArtists',
    root: 'topartists',
    item: 'artist',
    build: () => topArtist(1, 'Test Artist', 12, URL_TA),
  },
  { golden: 'user.getTopAlbums', root: 'topalbums', item: 'album', build: topAlbum },
  { golden: 'user.getLovedTracks', root: 'lovedtracks', item: 'track', build: lovedTrack },
  { golden: 'user.getFriends', root: 'friends', item: 'user', build: friend },
  { golden: 'user.getTrackScrobbles', root: 'trackscrobbles', item: 'track', build: recentTrack },
  { golden: 'library.getArtists', root: 'artists', item: 'artist', build: libraryArtist },
];

/** Every (path, value) of a parsed JSON document whose value is a JSON number. */
function numberPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v) => numberPaths(v, path));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => numberPaths(v, path === '' ? k : `${path}.${k}`));
  }
  return [];
}

/** Every path of a parsed JSON document at which an object (not an array) sits under a name. */
function objectPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => objectPaths(v, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    const here = path === '' ? [] : [path];
    return here.concat(Object.entries(value).flatMap(([k, v]) => objectPaths(v, path === '' ? k : `${path}.${k}`)));
  }
  return [];
}

// ---------------------------------------------------------------------------

describe('Last.fm encoding', () => {
  it('every error code renders as {"error":N,"message"} and <lfm status="failed"><error code="N"> with the ADR table HTTP status', async () => {
    // ADR 0005 §7.6, transcribed.
    const table: Array<[LastfmErrorCode, string, number]> = [
      [2, 'Invalid service', 400],
      [3, 'Invalid Method', 400],
      [4, 'Authentication Failed', 403],
      [5, 'Invalid format', 400],
      [6, 'Invalid parameters', 400],
      [7, 'Invalid resource specified', 400],
      [8, 'Operation failed', 500],
      [9, 'Invalid session key - Please re-authenticate', 403],
      [10, 'Invalid API key', 403],
      [11, 'Service Offline', 503],
      [13, 'Invalid method signature supplied', 403],
      [14, 'This token has not been authorized', 403],
      [15, 'This token has expired', 403],
      [16, 'There was a temporary error processing your request', 503],
      [26, 'Suspended API key', 403],
      [29, 'Rate Limit Exceeded', 429],
    ];
    for (const [code, message, status] of table) {
      const err = new LastfmError(code);
      const json = encodeError(err, 'json');
      expect(json.status, `json ${code}`).toBe(status);
      expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(json.body)).toStrictEqual({ error: code, message });

      const xml = encodeError(err, 'xml');
      expect(xml.status, `xml ${code}`).toBe(status);
      expect(xml.headers['content-type']).toBe('text/xml; charset=utf-8');
      expect(xml.body).toBe(
        `<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="${code}">${message}</error></lfm>\n`,
      );
      expect(json.headers['retry-after']).toBe(code === 29 ? '60' : undefined);
    }

    // A specific message (ADR §7.6 "Unknown users … use 6 with a specific message") is
    // escaped in XML and carried verbatim in JSON.
    const custom = new LastfmError(6, 'User not found: <a&b>');
    expect(encodeError(custom, 'xml').body).toContain('<error code="6">User not found: &lt;a&amp;b&gt;</error>');
    expect(JSON.parse(encodeError(custom, 'json').body)).toStrictEqual({ error: 6, message: 'User not found: <a&b>' });

    // 29 carries Retry-After; through a Response as well.
    const limited = lastfmResponse(new LastfmError(29, undefined, { retryAfterSeconds: 12.2 }), 'json');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('13');
    expect(await limited.json()).toStrictEqual({ error: 29, message: 'Rate Limit Exceeded' });
  });

  it('scrobbles for 1 and 3 inputs, nowplaying, recenttracks with a nowplaying row, topartists, user.getInfo and session match their XML and JSON goldens', () => {
    expectGolden('track.scrobble-1', scrobbles(1, 0, [scrobble('Test Track', 'Test Artist', '', LISTENED)]));
    expectGolden(
      'track.scrobble-3',
      scrobbles(2, 1, [
        scrobble('First Track', 'First Artist', 'First Album', 1768471200),
        scrobble('Second Track', 'Second Artist', '', LISTENED),
        scrobble('Old Track', 'Old Artist', '', 1000000000, 3, 'Timestamp too old'),
      ]),
    );
    expectGolden(
      'track.updateNowPlaying',
      lfmOk(
        node('nowplaying', [
          leaf('track', 'Test Track', { corrected: '0' }),
          leaf('artist', 'Test Artist', { corrected: '0' }),
          leaf('album', 'Test Album', { corrected: '0' }),
          leaf('albumArtist', '', { corrected: '0' }),
          leaf('ignoredMessage', '', { code: '0' }),
        ]),
      ),
    );
    expectGolden(
      'user.getRecentTracks-nowplaying',
      lfmOk(paged('recenttracks', page(1), 'track', [nowPlayingTrack(), recentTrack()])),
    );
    expectGolden(
      'user.getTopArtists',
      lfmOk(
        paged('topartists', { ...page(2), totalPages: 1 }, 'artist', [
          topArtist(1, 'Test Artist', 12, URL_TA),
          topArtist(2, 'Other Artist', 5, 'https://www.last.fm/music/Other+Artist'),
        ]),
      ),
    );
    expectGolden('user.getInfo', userInfo());
    expectGolden('auth.getSession', session());

    // The Pano-required details, read from the encoder's JSON.
    const np = JSON.parse(toJson(lfmOk(paged('recenttracks', page(1), 'track', [nowPlayingTrack(), recentTrack()]))));
    expect(np.recenttracks.track[0]['@attr']).toStrictEqual({ nowplaying: 'true' });
    expect(np.recenttracks.track[0].date).toBeUndefined();
    expect(np.recenttracks.track[1].date).toStrictEqual({ uts: '1768474800', '#text': '15 Jan 2026, 11:00' });

    // raw=true drops the <lfm> wrapper; the success content type and status.
    expect(toXml(session(), { raw: true })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<session>\n  <name>alice</name>\n  <key>0123456789abcdef0123456789abcdef</key>\n  <subscriber>0</subscriber>\n</session>\n',
    );
    const ok = encodeSuccess(session(), 'xml');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe(XML_CONTENT_TYPE);
    // track.love / track.unlove: an empty document.
    expect(toXml(lfmOk())).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"/>\n');
    expect(toJson(lfmOk())).toBe('{}');
  });

  it('JSON numbers are strings except scrobbles @attr accepted/ignored, registered #text and session.subscriber; empty leaves carry "#text":""', () => {
    const docs: Array<[string, LfmDocument]> = [
      ['scrobble-1', scrobbles(1, 0, [scrobble('T', 'A', '', LISTENED)])],
      [
        'scrobble-3',
        scrobbles(2, 1, [
          scrobble('T', 'A', '', 1),
          scrobble('U', 'B', '', 2),
          scrobble('V', 'C', '', 3, 3, 'Timestamp too old'),
        ]),
      ],
      ['user', userInfo()],
      ['session', session()],
      ['friends', lfmOk(paged('friends', page(1), 'user', [friend()]))],
      ['toptracks', lfmOk(paged('toptracks', page(1), 'track', [topTrack()]))],
      ['library', lfmOk(paged('artists', page(1), 'artist', [libraryArtist()]))],
      ['recent', lfmOk(paged('recenttracks', page(1), 'track', [recentTrack()]))],
    ];
    const found = new Set(docs.flatMap(([, d]) => numberPaths(JSON.parse(toJson(d)))));
    expect([...found].sort()).toEqual([
      'scrobbles.@attr.accepted',
      'scrobbles.@attr.ignored',
      'session.subscriber',
      'user.registered.#text',
    ]);
    // Their values are the numbers, whatever type the builder used.
    const s = JSON.parse(toJson(scrobbles(2, 1, [])));
    expect(s.scrobbles['@attr']).toStrictEqual({ accepted: 2, ignored: 1 });
    expect(JSON.parse(toJson(lfmOk(node('scrobbles', [], { accepted: '4', ignored: '0' }))))).toStrictEqual({
      scrobbles: { '@attr': { accepted: 4, ignored: 0 } },
    });
    expect(JSON.parse(toJson(session())).session.subscriber).toBe(0);
    expect(JSON.parse(toJson(userInfo())).user.registered).toStrictEqual({
      unixtime: '1767225600',
      '#text': 1767225600,
    });
    // Numbers given anywhere else come out as strings.
    const tt = JSON.parse(toJson(lfmOk(paged('toptracks', page(1), 'track', [topTrack()])))).toptracks;
    expect(tt.track[0].playcount).toBe('3');
    expect(tt.track[0].duration).toBe('215');
    expect(tt.track[0]['@attr']).toStrictEqual({ rank: '1' });
    expect(tt['@attr']).toStrictEqual({ user: 'alice', page: '1', perPage: '50', totalPages: '1', total: '1' });
    const fr = JSON.parse(toJson(lfmOk(paged('friends', page(1), 'user', [friend()])))).friends.user[0];
    expect(fr.registered).toStrictEqual({ unixtime: '1767225600', '#text': '1767225600' });
    // A non-integer at a number path is refused.
    expect(() => toJson(lfmOk(node('scrobbles', [], { accepted: 'many', ignored: 0 })))).toThrow(LfmTreeError);

    // Empty leaves: with attributes, "#text":""; without, "".
    const one = JSON.parse(toJson(scrobbles(1, 0, [scrobble('T', 'A', '', LISTENED)]))).scrobbles.scrobble;
    expect(one.album).toStrictEqual({ corrected: '0', '#text': '' });
    expect(one.albumArtist).toStrictEqual({ corrected: '0', '#text': '' });
    expect(one.ignoredMessage).toStrictEqual({ code: '0', '#text': '' });
    const rt = JSON.parse(toJson(lfmOk(paged('recenttracks', page(1), 'track', [nowPlayingTrack()])))).recenttracks
      .track[0];
    expect(rt.mbid).toBe('');
    expect(rt.artist).toStrictEqual({ mbid: '', '#text': 'Now Artist' });
    expect(rt.image).toStrictEqual([
      { size: 'small', '#text': '' },
      { size: 'medium', '#text': '' },
      { size: 'large', '#text': '' },
      { size: 'extralarge', '#text': '' },
    ]);
  });

  it('XML escapes &<>"\' and removes U+0000-U+0008; a callback parameter is ignored and the type stays application/json', async () => {
    const controls = Array.from({ length: 9 }, (_, i) => String.fromCodePoint(i)).join('');
    const nasty = `Tom & Jerry <"live"> 'Rock'${controls}!`;
    const xml = toXml(lfmOk(node('nowplaying', [leaf('track', nasty, { corrected: nasty })])));
    expect(xml).toContain(
      '<track corrected="Tom &amp; Jerry &lt;&quot;live&quot;&gt; &apos;Rock&apos;!">Tom &amp; Jerry &lt;&quot;live&quot;&gt; &apos;Rock&apos;!</track>',
    );
    for (let cp = 0; cp <= 8; cp++) expect(xml.includes(String.fromCodePoint(cp)), `U+000${cp}`).toBe(false);
    // The other characters XML 1.0 forbids go too; TAB, LF, CR and astral characters stay.
    const more = `a${String.fromCodePoint(0x0b)}b${String.fromCodePoint(0x1f)}c${String.fromCharCode(0xd800)}d${String.fromCodePoint(0xfffe)}e${String.fromCodePoint(0x1f3b5)}\tf\ng`;
    expect(escapeXmlText(more)).toBe(`abcde${String.fromCodePoint(0x1f3b5)}\tf\ng`);
    expect(escapeXmlText('a\rb')).toBe('a&#13;b');
    // JSON keeps the text as given (JSON.stringify escapes what it must).
    expect(JSON.parse(toJson(lfmOk(node('nowplaying', [leaf('track', nasty)])))).nowplaying.track).toBe(nasty);

    // callback: parsed, never applied. The body is plain JSON with nosniff.
    const params = parseLastfmParams({
      url: 'https://music.214510.xyz/2.0/?method=auth.getSession&callback=alert&format=json',
    });
    const format = negotiateFormat(params, null);
    expect(format).toBe('json');
    const res = lastfmResponse(session(), format);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body.startsWith('{')).toBe(true);
    expect(body).not.toContain('alert');
    expect(JSON.parse(body)).toStrictEqual(golden('auth.getSession').json);
    // An error answer ignores it too.
    const errRes = lastfmResponse(new LastfmError(10), format);
    expect(errRes.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
    expect(await errRes.text()).toBe('{"error":10,"message":"Invalid API key"}');
  });

  it('recenttracks, toptracks, topartists, topalbums, lovedtracks, friends, trackscrobbles and library artists with 0 and with 1 item match their goldens: track, artist, album and user are [] and a one-element array, and @attr carries user, page, perPage, totalPages and total', () => {
    for (const c of LIST_CASES) {
      const empty = lfmOk(paged(c.root, page(0), c.item, []));
      const single = lfmOk(paged(c.root, page(1), c.item, [c.build()]));
      expectGolden(`${c.golden}-0`, empty);
      expectGolden(`${c.golden}-1`, single);

      const e = JSON.parse(toJson(empty))[c.root];
      expect(e[c.item], `${c.root} empty`).toStrictEqual([]);
      expect(Object.keys(e['@attr']).sort()).toEqual(['page', 'perPage', 'total', 'totalPages', 'user']);
      const s = JSON.parse(toJson(single))[c.root];
      expect(Array.isArray(s[c.item]), `${c.root} single`).toBe(true);
      expect(s[c.item]).toHaveLength(1);
      expect(s['@attr']).toStrictEqual({ user: 'alice', page: '1', perPage: '50', totalPages: '1', total: '1' });
      // The nested image list is an array too.
      expect(Array.isArray(s[c.item][0].image), `${c.root} image`).toBe(true);
    }

    // The guard: a paged container without its list, with a bare item, or without @attr is refused.
    expect(() =>
      toJson(
        lfmOk(
          node('recenttracks', [recentTrack()], { user: 'a', page: '1', perPage: '1', totalPages: '1', total: '1' }),
        ),
      ),
    ).toThrow(LfmTreeError);
    expect(() =>
      toJson(lfmOk(node('topartists', [], { user: 'a', page: '1', perPage: '1', totalPages: '0', total: '0' }))),
    ).toThrow(LfmTreeError);
    expect(() => toXml(lfmOk(node('lovedtracks', [list('track', [])], { user: 'a', page: '1' })))).toThrow(
      LfmTreeError,
    );
    expect(() => toJson(lfmOk(node('artist', [leaf('image', '', { size: 'small' })])))).toThrow(LfmTreeError);
    // The other §7.2 lists (weekly charts, chart list, tags, album tracks, similar) are lists as well.
    const nested = JSON.parse(
      toJson(
        lfmOk(
          node('album', [
            leaf('name', 'Test Album'),
            node('tracks', [list('track', [node('track', [leaf('name', 'Only')])])]),
            node('toptags', [list('tag', [])]),
          ]),
          node('weeklychartlist', [list('chart', [leaf('chart', '', { from: '1', to: '2' })])], { user: 'alice' }),
          node('similar', [list('artist', [])]),
        ),
      ),
    );
    expect(nested.album.tracks.track).toStrictEqual([{ name: 'Only' }]);
    expect(nested.album.toptags.tag).toStrictEqual([]);
    expect(nested.weeklychartlist.chart).toStrictEqual([{ from: '1', to: '2', '#text': '' }]);
    expect(nested.similar.artist).toStrictEqual([]);
    for (const [parent, child] of [
      ['weeklyartistchart', 'artist'],
      ['weeklyalbumchart', 'album'],
      ['weeklytrackchart', 'track'],
      ['tracks', 'track'],
      ['toptags', 'tag'],
      ['similar', 'artist'],
      ['weeklychartlist', 'chart'],
    ] as const) {
      expect(() => toJson(lfmOk(node(parent, [node(child, [leaf('name', 'x')])]))), parent).toThrow(LfmTreeError);
    }
  });

  it('scrobbles.scrobble for one input is an object and for three inputs an array, and no other element uses the single-object form', () => {
    const one = JSON.parse(toJson(scrobbles(1, 0, [scrobble('T', 'A', '', LISTENED)])));
    expect(Array.isArray(one.scrobbles.scrobble)).toBe(false);
    expect(one.scrobbles.scrobble.track).toStrictEqual({ corrected: '0', '#text': 'T' });
    const three = JSON.parse(
      toJson(scrobbles(3, 0, [scrobble('T1', 'A', '', 1), scrobble('T2', 'A', '', 2), scrobble('T3', 'A', '', 3)])),
    );
    expect(Array.isArray(three.scrobbles.scrobble)).toBe(true);
    expect(three.scrobbles.scrobble.map((s: { track: { '#text': string } }) => s.track['#text'])).toEqual([
      'T1',
      'T2',
      'T3',
    ]);

    // Across every golden, single objects sit only where a named single child is
    // expected: under the root, as scrobbles.scrobble, or as a fixed sub-object
    // (artist, album, date, streamable, …) — never where a list is expected.
    const goldens = [
      'track.scrobble-1',
      'track.scrobble-3',
      'track.updateNowPlaying',
      'user.getRecentTracks-nowplaying',
      'user.getTopArtists',
      'user.getInfo',
      'auth.getSession',
      ...LIST_CASES.flatMap((c) => [`${c.golden}-0`, `${c.golden}-1`]),
    ];
    const listPaths = [
      'recenttracks.track',
      'trackscrobbles.track',
      'lovedtracks.track',
      'toptracks.track',
      'topartists.artist',
      'topalbums.album',
      'friends.user',
      'artists.artist',
    ];
    for (const name of goldens) {
      const json = golden(name).json;
      const objects = objectPaths(json);
      for (const p of listPaths) expect(objects.includes(p), `${name}: ${p} is an object`).toBe(false);
      expect(
        objects.some((p) => p.endsWith('.image')),
        `${name}: image is an object`,
      ).toBe(false);
      const singleScrobble = objects.includes('scrobbles.scrobble');
      expect(singleScrobble, name).toBe(name === 'track.scrobble-1');
    }

    // The encoder refuses a repeated child without the list flag anywhere else,
    // and refuses to flag scrobbles.scrobble.
    expect(() => toJson(lfmOk(node('nowplaying', [leaf('track', 'a'), leaf('track', 'b')])))).toThrow(LfmTreeError);
    expect(() => toJson(lfmOk(node('scrobbles', [list('scrobble', [])], { accepted: 0, ignored: 0 })))).toThrow(
      LfmTreeError,
    );
  });
});
