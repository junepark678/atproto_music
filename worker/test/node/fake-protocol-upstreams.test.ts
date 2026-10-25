// The fake Last.fm and ListenBrainz upstreams (ADR 0005 §15.2, N1-13). Later
// suites (imports N3-*, forwarding, linking, the e2e stacks) mount them at
// lastfm.test and listenbrainz.test through routerTransport's `hosts` option;
// these tests pin the upstream behaviour those suites rely on: signature
// verification, batch limits, scripted faults in order, paging with a fixed
// `to` / `max_ts`, the ListenBrainz auth schemes and rate-limit headers.
//
// Deterministic: frozen clock 2026-01-15T12:00:00Z, no randomness, no network.
// The serving test listens on a unix socket in a temp dir, never on a TCP port
// (ADR 0005 §15.2 "Loopback exceptions").

import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeLastfm,
  LASTFM_HOST,
  type LastfmListen,
  lastfmDateText,
  lastfmSignature,
  md5Hex,
  serveFake,
} from './support/fake-lastfm';
import { FakeListenBrainz, LB_MESSAGES, LISTENBRAINZ_HOST } from './support/fake-listenbrainz';

const NOW_S = Date.parse('2026-01-15T12:00:00Z') / 1000;
const API_KEY = 'a'.repeat(32);
const SECRET = 'fixture-shared-secret';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Sign `params` the way a Last.fm client does and POST them as a form body. */
function signedPost(fake: FakeLastfm, params: Record<string, string>, secret = SECRET): Promise<Response> {
  const all = { api_key: API_KEY, ...params };
  const body = new URLSearchParams({ ...all, api_sig: lastfmSignature(Object.entries(all), secret), format: 'json' });
  return fake.fetch(
    new Request(`https://${fake.host}/2.0/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
}

function scrobbleParams(sk: string, n: number, base = NOW_S - 10_000): Record<string, string> {
  const p: Record<string, string> = { method: 'track.scrobble', sk };
  for (let i = 0; i < n; i++) {
    p[`artist[${i}]`] = `Artist ${i}`;
    p[`track[${i}]`] = `Track ${i}`;
    p[`timestamp[${i}]`] = String(base + i * 200);
    if (i % 2 === 0) p[`album[${i}]`] = `Album ${i}`;
  }
  return p;
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('fake Last.fm', () => {
  it('fake Last.fm rejects a bad api_sig with 13, accepts 50 scrobbles, rejects 51 with 6, and returns scripted 9, 11, 16, 29 and HTTP 503 in order', async () => {
    const clock = fixedClock();
    const fake = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const sk = fake.addSession('alice', 'b'.repeat(32));

    // A signature made with another secret: 13, nothing recorded.
    let res = await signedPost(fake, scrobbleParams(sk, 1), 'wrong-secret');
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: 13, message: 'Invalid method signature supplied' });
    // A signature over different parameters (tampered after signing): 13 too.
    const tampered = new URLSearchParams({
      api_key: API_KEY,
      method: 'track.scrobble',
      sk,
      artist: 'A',
      track: 'T',
      timestamp: String(NOW_S),
      format: 'json',
    });
    tampered.set(
      'api_sig',
      lastfmSignature(
        [...tampered].filter(([k]) => k !== 'artist'),
        SECRET,
      ),
    );
    res = await fake.fetch(new Request('https://lastfm.test/2.0/', { method: 'POST', body: tampered }));
    expect([res.status, (await body(res)).error]).toEqual([403, 13]);
    // An unknown api_key is 10 and an unknown session key is 9, even when correctly signed.
    res = await signedPost(fake, { ...scrobbleParams(sk, 1), api_key: 'c'.repeat(32) });
    expect([res.status, (await body(res)).error]).toEqual([403, 10]);
    res = await signedPost(fake, scrobbleParams('d'.repeat(32), 1));
    expect([res.status, (await body(res)).error]).toEqual([403, 9]);
    // A write method over GET is 3.
    res = await fake.fetch(
      new Request(`https://lastfm.test/2.0/?method=track.scrobble&api_key=${API_KEY}&format=json`),
    );
    expect([res.status, (await body(res)).error]).toEqual([400, 3]);
    expect(fake.scrobbles).toHaveLength(0);

    // 50 indexed entries: accepted, every input recorded as received.
    res = await signedPost(fake, scrobbleParams(sk, 50));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const ok = (await body(res)) as { scrobbles: { scrobble: unknown[]; '@attr': unknown } };
    expect(ok.scrobbles['@attr']).toEqual({ accepted: 50, ignored: 0 });
    expect(ok.scrobbles.scrobble).toHaveLength(50);
    expect(ok.scrobbles.scrobble[1]).toEqual({
      artist: { corrected: '0', '#text': 'Artist 1' },
      album: { corrected: '0', '#text': '' },
      albumArtist: { corrected: '0', '#text': '' },
      track: { corrected: '0', '#text': 'Track 1' },
      timestamp: String(NOW_S - 10_000 + 200),
      ignoredMessage: { code: '0', '#text': '' },
    });
    expect(fake.scrobbles).toHaveLength(1);
    const batch = fake.scrobbles[0]!;
    expect([batch.user, batch.sk, batch.apiKey, batch.indexed]).toEqual(['alice', sk, API_KEY, true]);
    expect(batch.items).toHaveLength(50);
    expect(batch.items[0]).toEqual({
      artist: 'Artist 0',
      track: 'Track 0',
      timestamp: String(NOW_S - 10_000),
      album: 'Album 0',
    });
    expect(batch.items[49]).toEqual({
      artist: 'Artist 49',
      track: 'Track 49',
      timestamp: String(NOW_S - 10_000 + 9800),
    });
    expect(fake.history('alice')).toHaveLength(50);

    // 51 entries: 6, nothing recorded or added to the history.
    res = await signedPost(fake, scrobbleParams(sk, 51));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe(6);
    expect(fake.scrobbles).toHaveLength(1);
    expect(fake.history('alice')).toHaveLength(50);
    // A missing timestamp in any entry is 6 as well.
    const missing = scrobbleParams(sk, 3);
    delete missing['timestamp[1]'];
    res = await signedPost(fake, missing);
    expect([res.status, (await body(res)).error]).toEqual([400, 6]);

    // Scripted faults answer the next track.scrobble requests in order.
    fake.fail({ code: 9 }, { code: 11 }, { code: 16 }, { code: 29, retryAfter: 30 }, { httpStatus: 503 });
    expect(fake.pendingFaults).toBe(5);
    const seen: Array<[number, unknown]> = [];
    for (let i = 0; i < 4; i++) {
      res = await signedPost(fake, scrobbleParams(sk, 2));
      seen.push([res.status, (await body(res)).error]);
      if (i === 3) expect(res.headers.get('retry-after')).toBe('30');
    }
    expect(seen).toEqual([
      [403, 9],
      [503, 11],
      [503, 16],
      [429, 29],
    ]);
    res = await signedPost(fake, scrobbleParams(sk, 2));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('503');
    expect(fake.pendingFaults).toBe(0);
    expect(fake.scrobbles).toHaveLength(1);
    expect(
      fake.calls
        .filter({ nsid: 'track.scrobble' })
        .map((c) => c.fault)
        .slice(-5),
    ).toEqual(['code:9', 'code:11', 'code:16', 'code:29', 'http:503']);

    // Afterwards the same request succeeds; a scripted per-item ignoredMessage 5
    // (daily scrobble limit) still answers status ok, and the item is not stored.
    fake.ignoreItems(0, 5);
    res = await signedPost(fake, scrobbleParams(sk, 2, NOW_S - 100));
    expect(res.status).toBe(200);
    const partial = (await body(res)) as {
      scrobbles: { scrobble: Array<{ ignoredMessage: unknown }>; '@attr': unknown };
    };
    expect(partial.scrobbles['@attr']).toEqual({ accepted: 1, ignored: 1 });
    expect(partial.scrobbles.scrobble.map((s) => s.ignoredMessage)).toEqual([
      { code: '0', '#text': '' },
      { code: '5', '#text': 'Daily scrobble limit exceeded' },
    ]);
    expect(fake.scrobbles).toHaveLength(2);
    expect(fake.scrobbles[1]!.codes).toEqual([0, 5]);
    expect(fake.history('alice')).toHaveLength(51);

    // One unindexed entry: the single-child-object quirk, and XML without format=json.
    const single = {
      api_key: API_KEY,
      method: 'track.scrobble',
      sk,
      artist: 'Björk & Co',
      track: '<Jóga>\u0001',
      timestamp: String(NOW_S),
    };
    res = await fake.fetch(
      new Request('https://lastfm.test/2.0/', {
        method: 'POST',
        body: new URLSearchParams({ ...single, api_sig: lastfmSignature(Object.entries(single), SECRET) }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(await res.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"><scrobbles accepted="1" ignored="0"><scrobble>' +
        '<artist corrected="0">Björk &amp; Co</artist><album corrected="0"></album><albumArtist corrected="0"></albumArtist>' +
        `<track corrected="0">&lt;Jóga&gt;</track><timestamp>${NOW_S}</timestamp><ignoredMessage code="0"></ignoredMessage>` +
        '</scrobble></scrobbles></lfm>',
    );
    expect(fake.scrobbles[2]!.indexed).toBe(false);

    // updateNowPlaying, love and unlove are recorded per session.
    res = await signedPost(fake, {
      method: 'track.updateNowPlaying',
      sk,
      artist: 'Kate Bush',
      track: 'Hounds of Love',
      duration: '183',
    });
    expect(res.status).toBe(200);
    expect(((await body(res)) as { nowplaying: { ignoredMessage: unknown } }).nowplaying.ignoredMessage).toEqual({
      code: '0',
      '#text': '',
    });
    res = await signedPost(fake, { method: 'track.love', sk, artist: 'Kate Bush', track: 'Hounds of Love' });
    expect([res.status, await body(res)]).toEqual([200, {}]);
    expect(fake.loves('alice')).toEqual(['kate bush\u0000hounds of love']);
    res = await signedPost(fake, { method: 'track.unlove', sk, artist: 'Kate Bush', track: 'Hounds of Love' });
    expect([res.status, await body(res)]).toEqual([200, {}]);
    expect(fake.loves('alice')).toEqual([]);
    expect(fake.nowPlayingCalls).toEqual([
      { user: 'alice', sk, artist: 'Kate Bush', track: 'Hounds of Love', duration: '183' },
    ]);
    expect(fake.loveCalls.map((c) => c.method)).toEqual(['track.love', 'track.unlove']);
  });

  it('fake Last.fm pages a 1,050-listen history at limit 200 with a fixed to into 6 pages with a nowplaying row on page 1 only', async () => {
    const clock = fixedClock();
    const fake = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const to = NOW_S - 3600;
    // 1,050 listens before `to`, two minutes apart, seeded oldest first ...
    const history: LastfmListen[] = Array.from({ length: 1050 }, (_, i) => ({
      artist: `Artist ${i % 17}`,
      track: `Track ${i}`,
      uts: to - 1 - (1049 - i) * 120,
      ...(i % 3 === 0 ? { album: `Album ${i % 5}` } : {}),
    }));
    fake.seedHistory('alice', history);
    // ... and four listens at or after `to`, which a fixed `to` must hide.
    fake.seedHistory(
      'alice',
      [to, to + 1, to + 600, NOW_S - 60].map((uts, i) => ({ artist: 'Late', track: `L${i}`, uts })),
    );
    fake.setNowPlaying('alice', { artist: 'Now', track: 'Playing' });

    const page = async (n: number) => {
      const res = await fake.fetch(
        new Request(
          `https://lastfm.test/2.0/?method=user.getRecentTracks&user=alice&api_key=${API_KEY}&limit=200&page=${n}&to=${to}&extended=1&format=json`,
        ),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { recenttracks: { track: Array<Record<string, unknown>>; '@attr': unknown } })
        .recenttracks;
    };

    const seen: number[] = [];
    const sizes: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const p = await page(n);
      expect(p['@attr']).toEqual({ user: 'alice', page: String(n), perPage: '200', totalPages: '6', total: '1050' });
      const nowPlaying = p.track.filter(
        (t) => (t['@attr'] as { nowplaying?: string } | undefined)?.nowplaying === 'true',
      );
      expect(nowPlaying).toHaveLength(n === 1 ? 1 : 0);
      if (n === 1) {
        expect(p.track[0]).toMatchObject({ name: 'Playing', '@attr': { nowplaying: 'true' }, loved: '0' });
        expect(p.track[0]).not.toHaveProperty('date');
      }
      const dated = p.track.filter((t) => t.date !== undefined);
      sizes.push(p.track.length);
      for (const t of dated) seen.push(Number((t.date as { uts: string }).uts));
    }
    expect(sizes).toEqual([201, 200, 200, 200, 200, 50]);
    // Every seeded listen before `to` exactly once, newest first, none at or after `to`.
    expect(seen).toHaveLength(1050);
    expect(seen).toEqual(history.map((l) => l.uts).reverse());
    expect(Math.max(...seen)).toBe(to - 1);

    // Each row's shape (extended=1): artist object, loved flag, date text.
    const first = await page(1);
    expect(first.track[1]).toEqual({
      artist: {
        url: 'https://www.last.fm/music/Artist%2012',
        name: 'Artist 12',
        image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
        mbid: '',
      },
      streamable: '0',
      image: ['small', 'medium', 'large', 'extralarge'].map((size) => ({ size, '#text': '' })),
      mbid: '',
      album: { mbid: '', '#text': '' },
      name: 'Track 1049',
      url: 'https://www.last.fm/music/Artist%2012/_/Track%201049',
      loved: '0',
      date: { uts: String(to - 1), '#text': lastfmDateText(to - 1) },
    });
    expect(lastfmDateText(NOW_S)).toBe('15 Jan 2026, 12:00');

    // Past the last page: an empty list, still with @attr.
    const beyond = await page(7);
    expect(beyond.track).toEqual([]);
    expect(beyond['@attr']).toMatchObject({ total: '1050', totalPages: '6' });

    // Without `to`, the late listens appear (1054); once now-playing expires, page 1 has no such row.
    clock.advance(601_000);
    const res = await fake.fetch(
      new Request(
        `https://lastfm.test/2.0/?method=user.getRecentTracks&user=alice&api_key=${API_KEY}&limit=200&format=json`,
      ),
    );
    const open = ((await res.json()) as { recenttracks: { track: unknown[]; '@attr': { total: string } } })
      .recenttracks;
    expect(open['@attr'].total).toBe('1054');
    expect(open.track).toHaveLength(200);

    // An unknown user is 6.
    const unknown = await fake.fetch(
      new Request(`https://lastfm.test/2.0/?method=user.getRecentTracks&user=nobody&api_key=${API_KEY}&format=json`),
    );
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: 6, message: 'User not found' }]);
    expect(fake.calls.count({ nsid: 'user.getRecentTracks', status: 200 })).toBe(9);
  });

  it('fake Last.fm computes the signature of api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret equal to the hardcoded vector', async () => {
    // The vector N1-08 pins for worker/src/crypto/md5.ts, computed independently
    // (python3 hashlib.md5 and coreutils md5sum agree).
    const VECTOR = '68afb32bee072407a63b6c41f3e1e2b4';
    expect(md5Hex('api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret')).toBe(VECTOR);
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');

    // The same string arises from the parameters in any order; format, callback
    // and api_sig are excluded.
    const params: Array<[string, string]> = [
      ['token', 'xxxxxxx'],
      ['format', 'json'],
      ['method', 'auth.getSession'],
      ['callback', 'cb'],
      ['api_key', 'xxxxxxxx'],
      ['api_sig', 'ignored'],
    ];
    expect(lastfmSignature(params, 'mysecret')).toBe(VECTOR);
    expect(lastfmSignature(params.reverse(), 'mysecret')).toBe(VECTOR);
    // Byte order: artist[10] sorts before artist[1].
    expect(
      lastfmSignature(
        [
          ['artist[1]', 'a'],
          ['artist[10]', 'b'],
        ],
        's',
      ),
    ).toBe(md5Hex('artist[10]bartist[1]as'));

    // The fake verifies exactly that signature on auth.getSession.
    const clock = fixedClock();
    const fake = new FakeLastfm({ clock, apiKey: 'xxxxxxxx', secret: 'mysecret' });
    fake.issueToken('xxxxxxx', 'xxxxxxxx');
    fake.authorizeToken('xxxxxxx', 'alice');
    const get = (sig: string) =>
      fake.fetch(
        new Request(
          `https://lastfm.test/2.0/?method=auth.getSession&api_key=xxxxxxxx&token=xxxxxxx&api_sig=${sig}&format=json`,
        ),
      );
    let res = await get(`${VECTOR.slice(0, 31)}5`);
    expect([res.status, await res.json()]).toEqual([403, { error: 13, message: 'Invalid method signature supplied' }]);
    res = await get(VECTOR.toUpperCase());
    expect(res.status).toBe(200);
    const session = ((await res.json()) as { session: { name: string; key: string; subscriber: number } }).session;
    expect(session.name).toBe('alice');
    expect(session.key).toMatch(/^[0-9a-f]{32}$/);
    expect(session.subscriber).toBe(0);
    // The token is single-use: a second exchange is 4.
    res = await get(VECTOR);
    expect([res.status, ((await res.json()) as { error: number }).error]).toEqual([403, 4]);

    // An unauthorized token is 14 and one older than 60 min is 15.
    fake.issueToken('yyyyyyy', 'xxxxxxxx');
    const sigFor = (token: string) =>
      lastfmSignature(Object.entries({ api_key: 'xxxxxxxx', method: 'auth.getSession', token }), 'mysecret');
    const exchange = (token: string) =>
      fake.fetch(
        new Request(
          `https://lastfm.test/2.0/?method=auth.getSession&api_key=xxxxxxxx&token=${token}&api_sig=${sigFor(token)}&format=json`,
        ),
      );
    res = await exchange('yyyyyyy');
    expect([res.status, ((await res.json()) as { error: number }).error]).toEqual([403, 14]);
    fake.authorizeToken('yyyyyyy', 'alice');
    clock.advance(60 * 60 * 1000);
    res = await exchange('yyyyyyy');
    expect([res.status, ((await res.json()) as { error: number }).error]).toEqual([403, 15]);

    // The issued session key authorises writes until revoked, then 9.
    const ok = await fake.fetch(
      new Request('https://lastfm.test/2.0/', {
        method: 'POST',
        body: new URLSearchParams({
          api_key: 'xxxxxxxx',
          method: 'track.love',
          sk: session.key,
          artist: 'A',
          track: 'T',
          api_sig: lastfmSignature(
            Object.entries({ api_key: 'xxxxxxxx', method: 'track.love', sk: session.key, artist: 'A', track: 'T' }),
            'mysecret',
          ),
        }),
      }),
    );
    expect([ok.status, await ok.text()]).toEqual([200, '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"/>']);
    expect(fake.loves('alice')).toEqual(['a\u0000t']);
  });
});

describe('fake ListenBrainz', () => {
  it('fake ListenBrainz accepts Token and token schemes, records submit-listens bodies, pages by max_ts and emits X-RateLimit-* with scripted 429 and 503', async () => {
    const clock = fixedClock();
    const fake = new FakeListenBrainz({ clock, rateLimit: 5, rateWindowS: 10 });
    const TOKEN = '11111111-2222-4333-8444-555555555555';
    fake.addToken('alice', TOKEN);
    const lb = (path: string, init: RequestInit = {}) =>
      fake.fetch(new Request(`https://listenbrainz.test${path}`, init));

    // validate-token: header with either scheme spelling, or ?token=.
    for (const scheme of ['Token', 'token']) {
      const res = await lb('/1/validate-token', { headers: { authorization: `${scheme} ${TOKEN}` } });
      expect([res.status, await res.json()]).toEqual([
        200,
        { code: 200, message: 'Token valid.', valid: true, user_name: 'alice' },
      ]);
    }
    let res = await lb(`/1/validate-token?token=${TOKEN}`);
    expect(((await res.json()) as { valid: boolean }).valid).toBe(true);
    res = await lb('/1/validate-token?token=nope');
    expect([res.status, await res.json()]).toEqual([200, { code: 200, message: 'Token invalid.', valid: false }]);
    res = await lb('/1/validate-token');
    expect([res.status, await res.json()]).toEqual([400, { code: 400, error: LB_MESSAGES.noToken }]);

    // submit-listens: both scheme spellings accepted, the raw body recorded.
    const single = JSON.stringify({
      listen_type: 'single',
      payload: [{ listened_at: NOW_S - 30, track_metadata: { artist_name: 'Björk', track_name: 'Jóga' } }],
    });
    const imported = JSON.stringify({
      listen_type: 'import',
      payload: [
        { listened_at: NOW_S - 600, track_metadata: { artist_name: 'A', track_name: 'One' } },
        { listened_at: NOW_S - 900, track_metadata: { artist_name: 'A', track_name: 'Two', release_name: 'R' } },
      ],
    });
    clock.advance(10_000); // a fresh rate window for the submissions
    res = await lb('/1/submit-listens', { method: 'POST', headers: { authorization: `Token ${TOKEN}` }, body: single });
    expect([res.status, await res.json()]).toEqual([200, { status: 'ok' }]);
    res = await lb('/1/submit-listens', {
      method: 'POST',
      headers: { authorization: `token ${TOKEN}` },
      body: imported,
    });
    expect([res.status, await res.json()]).toEqual([200, { status: 'ok' }]);
    expect(fake.submissions.map((s) => [s.user, s.scheme, s.listenType, s.body])).toEqual([
      ['alice', 'Token', 'single', single],
      ['alice', 'token', 'import', imported],
    ]);
    // Unauthenticated, malformed and unknown-token submits are 401 and record nothing.
    for (const [headers, message] of [
      [{}, LB_MESSAGES.missingHeader],
      [{ authorization: TOKEN }, LB_MESSAGES.invalidHeader],
      [{ authorization: 'Token not-a-token' }, LB_MESSAGES.invalidToken],
    ] as const) {
      res = await lb('/1/submit-listens', { method: 'POST', headers, body: single });
      expect([res.status, await res.json()]).toEqual([401, { code: 401, error: message }]);
    }
    expect(fake.submissions).toHaveLength(2);
    expect(fake.listens('alice').map((l) => l.track_metadata.track_name)).toEqual(['Jóga', 'One', 'Two']);

    // Rate-limit headers on every response, from a fixed window per token.
    res = await lb('/1/user/alice/listens', { headers: { authorization: `Token ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('2'); // two submits + this read
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(NOW_S + 10 + 10));
    expect(res.headers.get('x-ratelimit-reset-in')).toBe('10');
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Reset-In',
    );
    clock.advance(4_000);
    await lb('/1/user/alice/listens', { headers: { authorization: `Token ${TOKEN}` } });
    await lb('/1/user/alice/listens', { headers: { authorization: `Token ${TOKEN}` } });
    res = await lb('/1/user/alice/listens', { headers: { authorization: `Token ${TOKEN}` } });
    expect([res.status, await res.json()]).toEqual([429, { code: 429, error: LB_MESSAGES.rateLimited }]);
    expect([res.headers.get('x-ratelimit-remaining'), res.headers.get('x-ratelimit-reset-in')]).toEqual(['0', '6']);
    clock.advance(6_000); // the window resets

    // Paging by max_ts over 60 seeded listens, newest first, exclusive bounds.
    fake.seedListens(
      'bob',
      Array.from({ length: 60 }, (_, i) => ({
        listened_at: NOW_S - 100_000 + i * 100,
        track_metadata: { artist_name: 'B', track_name: `T${i}` },
      })),
    );
    const pages: number[][] = [];
    let maxTs: number | null = NOW_S;
    while (maxTs !== null && pages.length < 10) {
      clock.advance(10_000); // one request per window keeps the anonymous bucket fresh
      res = await lb(`/1/user/bob/listens?count=25&max_ts=${maxTs}`);
      expect(res.status).toBe(200);
      const payload = (
        (await res.json()) as {
          payload: {
            count: number;
            listens: Array<{ listened_at: number; user_name: string }>;
            user_id: string;
            latest_listen_ts: number;
            oldest_listen_ts: number;
          };
        }
      ).payload;
      expect(payload.user_id).toBe('bob');
      expect(payload.latest_listen_ts).toBe(NOW_S - 100_000 + 5900);
      expect(payload.oldest_listen_ts).toBe(NOW_S - 100_000);
      expect(payload.count).toBe(payload.listens.length);
      const ts = payload.listens.map((l) => l.listened_at);
      pages.push(ts);
      maxTs = ts.length === 0 ? null : Math.min(...ts);
    }
    expect(pages.map((p) => p.length)).toEqual([25, 25, 10, 0]);
    const flat = pages.flat();
    expect(flat).toEqual(Array.from({ length: 60 }, (_, i) => NOW_S - 100_000 + (59 - i) * 100));
    clock.advance(10_000);
    res = await lb(`/1/user/bob/listens?max_ts=${NOW_S}&min_ts=${NOW_S}`);
    expect([res.status, await res.json()]).toEqual([400, { code: 400, error: LB_MESSAGES.maxMin }]);
    clock.advance(10_000);
    res = await lb('/1/user/nobody/listens');
    expect([res.status, await res.json()]).toEqual([404, { code: 404, error: 'Cannot find user: nobody' }]);

    // Scripted 429 (with its Reset-In), 503 and 401, in order, then normal service.
    clock.advance(10_000);
    fake.fail({ status: 429, resetIn: 42 }, { status: 503 }, { status: 401 });
    const auth = { authorization: `Token ${TOKEN}` };
    res = await lb('/1/submit-listens', { method: 'POST', headers: auth, body: single });
    expect([res.status, await res.json()]).toEqual([429, { code: 429, error: LB_MESSAGES.rateLimited }]);
    expect(res.headers.get('x-ratelimit-reset-in')).toBe('42');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res.headers.get('x-ratelimit-reset')).toBe(String(Math.floor(clock.nowMs() / 1000) + 42));
    res = await lb('/1/submit-listens', { method: 'POST', headers: auth, body: single });
    expect([res.status, await res.json()]).toEqual([503, { code: 503, error: LB_MESSAGES.unavailable }]);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    res = await lb('/1/submit-listens', { method: 'POST', headers: auth, body: single });
    expect([res.status, await res.json()]).toEqual([401, { code: 401, error: LB_MESSAGES.invalidToken }]);
    expect(fake.submissions).toHaveLength(2);
    expect(fake.pendingFaults).toBe(0);
    res = await lb('/1/submit-listens', { method: 'POST', headers: auth, body: single });
    expect(res.status).toBe(200);
    expect(fake.submissions).toHaveLength(3);
    expect(fake.calls.filter({ path: '/1/submit-listens' }).map((c) => c.status)).toEqual([
      200, 200, 401, 401, 401, 429, 503, 401, 200,
    ]);
  });
});

describe('routing and serving', () => {
  it('both fakes answer through routerTransport hosts at lastfm.test and listenbrainz.test, and an unrouted host still fails like a DNS error', async () => {
    const clock = fixedClock();
    const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const listenbrainz = new FakeListenBrainz({ clock });
    lastfm.seedHistory('alice', [{ artist: 'A', track: 'T', uts: NOW_S - 60 }]);
    listenbrainz.addToken('alice', 'tok');
    expect([lastfm.host, listenbrainz.host]).toEqual([LASTFM_HOST, LISTENBRAINZ_HOST]);

    const t = routerTransport({ hosts: { [lastfm.host]: lastfm, [listenbrainz.host]: listenbrainz } });
    expect(t.fixture).toBe(true);
    expect(t.hostnames().sort()).toEqual(['lastfm.test', 'listenbrainz.test']);

    let res = await t(
      new Request(`https://lastfm.test/2.0/?method=user.getRecentTracks&user=alice&api_key=${API_KEY}&format=json`),
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { recenttracks: { track: Array<{ name: string }> } }).recenttracks.track.map(
        (x) => x.name,
      ),
    ).toEqual(['T']);
    res = await t(
      new Request('https://listenbrainz.test/1/validate-token', { headers: { authorization: 'Token tok' } }),
    );
    expect([res.status, ((await res.json()) as { user_name: string }).user_name]).toEqual([200, 'alice']);
    expect(t.calls.filter({ service: 'host' }).map((c) => [c.host, c.status])).toEqual([
      ['lastfm.test', 200],
      ['listenbrainz.test', 200],
    ]);
    expect([lastfm.calls.count(), listenbrainz.calls.count()]).toEqual([1, 1]);

    // The real hosts are not routed: rejected like a failed DNS lookup, before
    // any fake sees the request.
    for (const url of [
      'https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks',
      'https://api.listenbrainz.org/1/validate-token',
      'https://lastfm.test.example/2.0/',
    ]) {
      await expect(t(new Request(url))).rejects.toThrow(TypeError);
    }
    await expect(t(new Request('https://ws.audioscrobbler.com/2.0/'))).rejects.toThrow(
      /^fixture network: no route to host ws\.audioscrobbler\.com$/,
    );
    expect(t.calls.count({ service: 'router', status: 0 })).toBe(4);
    expect([lastfm.calls.count(), listenbrainz.calls.count()]).toEqual([1, 1]);
  });

  it('serveFake bridges HTTP requests to a fake unchanged, here over a unix socket in a temp dir', async () => {
    const clock = fixedClock();
    const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const sk = lastfm.addSession('alice');
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-fakes-'));
    tempDirs.push(dir);
    const served = await serveFake(lastfm, { socketPath: join(dir, 'lastfm.sock') });
    try {
      const params = {
        api_key: API_KEY,
        method: 'track.scrobble',
        sk,
        artist: 'A',
        track: 'T',
        timestamp: String(NOW_S),
      };
      const form = new URLSearchParams({
        ...params,
        api_sig: lastfmSignature(Object.entries(params), SECRET),
        format: 'json',
      }).toString();
      const answer = await new Promise<{ status: number; type: string | undefined; text: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              socketPath: served.socketPath!,
              method: 'POST',
              path: '/2.0/',
              headers: { host: 'lastfm.test', 'content-type': 'application/x-www-form-urlencoded' },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (c: string) => {
                text += c;
              });
              res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], text }));
            },
          );
          req.on('error', reject);
          req.end(form);
        },
      );
      expect(answer.status).toBe(200);
      expect(answer.type).toBe('application/json; charset=utf-8');
      expect(JSON.parse(answer.text)).toMatchObject({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
      expect(lastfm.scrobbles.map((b) => b.items)).toEqual([[{ artist: 'A', track: 'T', timestamp: String(NOW_S) }]]);
      expect(lastfm.calls.filter({ host: 'lastfm.test', method: 'POST', status: 200 })).toHaveLength(1);
    } finally {
      await served.close();
    }
  });
});
