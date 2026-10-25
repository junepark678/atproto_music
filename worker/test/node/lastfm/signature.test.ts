// Last.fm 2.0 request signatures and their method-scoped policy
// (ADR 0005 §7.3, §7.4, §7.5; N2-07).
//
// Independence of the expected values:
// - base strings and MD5 digests are written out by hand and hashed here with
//   raw node:crypto, never through src/crypto/md5.ts or signature.ts;
// - the lastfm-ts-api requests are produced by the real library
//   (lastfm-ts-api@2.6.2, the root devDependency) running its own sign() and
//   send(). Its `node:https` request is replaced for the duration of a test by
//   an in-process capture (the same mechanism as N8-01's https-to-loopback
//   preload: replace `request` on the module object and call
//   syncBuiltinESMExports so the library's ESM named import sees it). The
//   capture refuses every hostname but music.214510.xyz and never opens a
//   socket, so nothing can reach a network;
// - the Pano-shaped requests are byte-faithful replays of the form bodies and
//   queries Pano Scrobbler builds for a GNU FM account (api_key and secret
//   panoScrobbler, empty values dropped, format=json in the body).

import { createHash } from 'node:crypto';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { LastFMApiRequest, LastFMAuth, LastFMTrack, LastFMUser } from 'lastfm-ts-api';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeError, encodeSuccess, leaf, lfmOk, node } from '../../../src/lastfm/encode';
import { LastfmError } from '../../../src/lastfm/errors';
import { type LastfmParams, parseLastfmParams } from '../../../src/lastfm/params';
import {
  computeSignature,
  enforceSignaturePolicy,
  READ_METHODS,
  requiresSignature,
  SIGNED_METHODS,
  type SignatureCheck,
  type SignaturePolicyDeps,
  signatureBaseString,
  verifySignature,
} from '../../../src/lastfm/signature';

const HOST = 'music.214510.xyz';
const ROOT = `https://${HOST}/2.0/`;
const FORM = 'application/x-www-form-urlencoded';
const PANO = 'panoScrobbler';
const SK = '0123456789abcdef0123456789abcdef';
const ISSUED_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ISSUED_SECRET = 'issued-secret-of-alice';

/** Raw node:crypto MD5 of the UTF-8 bytes, independent of src/crypto/md5.ts. */
function md5(text: string): string {
  return createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');
}

function policyDeps(): SignaturePolicyDeps & { issuedLookups: string[] } {
  const issuedLookups: string[] = [];
  return {
    knownClients: [{ apiKey: PANO, sharedSecret: PANO }],
    issuedLookups,
    issuedSecret(apiKey: string) {
      issuedLookups.push(apiKey);
      return Promise.resolve(apiKey === ISSUED_KEY ? ISSUED_SECRET : null);
    },
  };
}

function methodOf(params: LastfmParams): string {
  return params.get('method') ?? '';
}

async function policyError(promise: Promise<unknown>): Promise<LastfmError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LastfmError);
    return err as LastfmError;
  }
  throw new Error('expected a LastfmError, the policy passed');
}

// ---------------------------------------------------------------------------
// In-process capture of lastfm-ts-api's node:https request
// ---------------------------------------------------------------------------

interface Captured {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body: string;
  params: LastfmParams;
  check: SignatureCheck | LastfmError;
}

type HttpsRequest = typeof https.request;
const originalRequest: HttpsRequest = https.request;

function restoreHttps(): void {
  (https as unknown as { request: HttpsRequest }).request = originalRequest;
  syncBuiltinESMExports();
}

afterEach(restoreHttps);

/**
 * Serves lastfm-ts-api from our own parser, policy and encoder: the request is
 * parsed with parseLastfmParams, checked with enforceSignaturePolicy, and
 * answered with encode.ts (a small success document, or the error envelope).
 */
function captureHttps(deps: SignaturePolicyDeps): Captured[] {
  const seen: Captured[] = [];
  const fake = (
    options: { hostname?: string; path?: string; method?: string; headers?: Record<string, unknown> },
    onResponse: (res: unknown) => void,
  ) => {
    if (options.hostname !== HOST) throw new Error(`no network in tests: refused ${String(options.hostname)}`);
    const chunks: string[] = [];
    const req = new Readable({ read() {} }) as Readable & { write(c: string): boolean; end(): void };
    req.write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    req.end = () => {
      const method = options.method ?? 'GET';
      const path = options.path ?? '/';
      const body = chunks.join('');
      void (async () => {
        const params = parseLastfmParams({
          url: `https://${HOST}${path}`,
          contentType: method === 'POST' ? FORM : null,
          body: method === 'POST' ? body : null,
        });
        let check: SignatureCheck | LastfmError;
        try {
          check = await enforceSignaturePolicy(methodOf(params), params, deps);
        } catch (err) {
          check = err as LastfmError;
        }
        seen.push({ method, path, headers: options.headers ?? {}, body, params, check });
        const encoded =
          check instanceof LastfmError
            ? encodeError(check, 'json')
            : encodeSuccess(lfmOk(node('ok', [leaf('method', methodOf(params))])), 'json');
        const res = Readable.from([encoded.body]) as Readable & { statusCode: number; headers: Record<string, string> };
        res.statusCode = encoded.status;
        res.headers = { ...encoded.headers };
        onResponse(res);
      })();
    };
    return req;
  };
  (https as unknown as { request: unknown }).request = fake;
  syncBuiltinESMExports();
  return seen;
}

// ---------------------------------------------------------------------------

describe('Last.fm signatures', () => {
  it('the signature sorts by byte order (artist[10] before artist[1]), uses UTF-8 values and excludes api_sig, format and callback', () => {
    const pairs: Array<[string, string]> = [
      ['method', 'track.scrobble'],
      ['artist[1]', 'Björk'],
      ['artist[10]', '東京事変'],
      ['artist[2]', 'Sigur Rós'],
      ['api_key', 'K'],
      ['format', 'json'],
      ['callback', 'cb'],
      ['api_sig', 'ffffffffffffffffffffffffffffffff'],
      ['Zed', 'z'],
      ['albumArtist', 'x'],
      ['album', 'y'],
    ];
    const base = 'ZedzalbumyalbumArtistxapi_keyKartist[10]東京事変artist[1]Björkartist[2]Sigur Rósmethodtrack.scrobble';
    expect(signatureBaseString(pairs)).toBe(base);
    expect(computeSignature(pairs, 'secret')).toBe(md5(`${base}secret`));
    // UTF-8, not Latin-1: the digest of the Latin-1 bytes differs.
    expect(computeSignature(pairs, 'secret')).not.toBe(
      createHash('md5')
        .update(Buffer.from(`${base}secret`, 'latin1'))
        .digest('hex'),
    );

    // Byte order, not UTF-16 code-unit order: U+FF61 (EF BD A1) sorts before
    // U+1F600 (F0 9F 98 80), although its UTF-16 unit 0xFF61 is above 0xD83D.
    const halfwidth = `n${String.fromCodePoint(0xff61)}`;
    const emoji = `n${String.fromCodePoint(0x1f600)}`;
    expect([emoji, halfwidth].sort()).toEqual([emoji, halfwidth]);
    expect(
      signatureBaseString([
        [emoji, '2'],
        [halfwidth, '1'],
      ]),
    ).toBe(`${halfwidth}1${emoji}2`);

    // The excluded parameters really are excluded: changing them keeps the signature.
    const changed = pairs.map(([k, v]): [string, string] =>
      ['format', 'callback', 'api_sig'].includes(k) ? [k, `${v}!`] : [k, v],
    );
    expect(computeSignature(changed, 'secret')).toBe(md5(`${base}secret`));
    // ...and every other parameter, method included, takes part.
    const otherMethod = pairs.map(([k, v]): [string, string] => (k === 'method' ? [k, 'track.love'] : [k, v]));
    expect(computeSignature(otherMethod, 'secret')).not.toBe(md5(`${base}secret`));

    // Signed over decoded values: the percent-encoded form body gives the same digest.
    const parsed = parseLastfmParams({
      url: ROOT,
      contentType: FORM,
      body: 'artist%5B10%5D=%E6%9D%B1%E4%BA%AC%E4%BA%8B%E5%A4%89&artist%5B1%5D=Bj%C3%B6rk&method=track.scrobble&format=json',
    });
    expect(signatureBaseString(parsed)).toBe('artist[10]東京事変artist[1]Björkmethodtrack.scrobble');
    expect(computeSignature(parsed, 's')).toBe(md5('artist[10]東京事変artist[1]Björkmethodtrack.scrobbles'));
  });

  it('requests signed by lastfm-ts-api 2.6.2 and a Pano-shaped request (empty params dropped, format in body) verify against panoScrobbler/panoScrobbler', async () => {
    const deps = policyDeps();
    const seen = captureHttps(deps);
    const config = { hostname: HOST, path: '/2.0/' };

    // track.scrobble with one entry, and scrobbleMany with 12 (artist[10], artist[11]).
    const track = new LastFMTrack(PANO, PANO, SK, config);
    await expect(
      track.scrobble({ artist: 'Sigur Rós', track: 'Hoppípolla', timestamp: 1768474800, album: 'Takk...' }),
    ).resolves.toEqual({ ok: { method: 'track.scrobble' } });
    const many = Array.from({ length: 12 }, (_, i) => ({
      artist: `Artist ${i} & co`,
      track: `東京 ${i}`,
      timestamp: 1768474800 + i,
    }));
    await expect(track.scrobbleMany(many)).resolves.toEqual({ ok: { method: 'track.scrobble' } });
    await expect(track.updateNowPlaying({ artist: 'Björk', track: 'Jóga' })).resolves.toEqual({
      ok: { method: 'track.updateNowPlaying' },
    });
    // auth.getMobileSession (POST) and auth.getSession (GET, signed in the query).
    const auth = new LastFMAuth(PANO, PANO, undefined, config);
    await expect(auth.getMobileSession({ username: 'alice', password: 'APPPASSWORDAPPPASSWORDAP' })).resolves.toEqual({
      ok: { method: 'auth.getMobileSession' },
    });
    await expect(auth.getSession({ token: 'fedcba9876543210fedcba9876543210' })).resolves.toEqual({
      ok: { method: 'auth.getSession' },
    });

    expect(seen.map((s) => [s.method, methodOf(s.params)])).toEqual([
      ['POST', 'track.scrobble'],
      ['POST', 'track.scrobble'],
      ['POST', 'track.updateNowPlaying'],
      ['POST', 'auth.getMobileSession'],
      ['GET', 'auth.getSession'],
    ]);
    for (const s of seen) {
      expect(s.check).toEqual({ required: true, keyKind: 'known', verified: true });
      expect(s.params.get('format')).toBe('json');
    }
    expect(seen[1]?.params.get('artist[11]')).toBe('Artist 11 & co');
    expect(seen[1]?.params.get('track[10]')).toBe('東京 10');
    expect(seen[4]?.path.startsWith('/2.0/?')).toBe(true);
    // The known pair is answered from configuration; no issued-key lookup.
    expect(deps.issuedLookups).toEqual([]);

    // Negative control: the same library with another secret is refused with 13.
    const forged = new LastFMTrack(PANO, 'not-the-secret', SK, config);
    await expect(forged.scrobble({ artist: 'A', track: 'T', timestamp: 1768474800 })).rejects.toThrow(
      'lastfm-ts-api: Invalid method signature supplied',
    );
    expect(seen).toHaveLength(6);
    expect((seen[5]!.check as LastfmError).code).toBe(13);

    // Pano: a GNU FM track.scrobble form body; album was empty and is absent,
    // format=json travels in the body, and the signature is computed by hand.
    const panoBase = `api_key${PANO}artistTest Artistduration215methodtrack.scrobblesk${SK}timestamp1768474800trackTest Track`;
    const panoSig = md5(`${panoBase}${PANO}`);
    const panoBody =
      `method=track.scrobble&artist=Test+Artist&track=Test+Track&timestamp=1768474800&duration=215` +
      `&api_key=${PANO}&sk=${SK}&format=json&api_sig=${panoSig}`;
    const pano = parseLastfmParams({ url: ROOT, contentType: `${FORM}; charset=UTF-8`, body: panoBody });
    expect(pano.has('album')).toBe(false);
    expect(signatureBaseString(pano)).toBe(panoBase);
    await expect(enforceSignaturePolicy('track.scrobble', pano, deps)).resolves.toEqual({
      required: true,
      keyKind: 'known',
      verified: true,
    });
    // Had Pano kept the empty album, the signature would differ: we sign exactly what was received.
    const withAlbum = parseLastfmParams({ url: ROOT, contentType: FORM, body: `${panoBody}&album=` });
    expect((await policyError(enforceSignaturePolicy('track.scrobble', withAlbum, deps))).code).toBe(13);
  });

  it('an uppercase hex api_sig verifies; a one-character change fails with 13', async () => {
    const deps = policyDeps();
    const fields = `method=track.love&artist=A&track=T&api_key=${PANO}&sk=${SK}`;
    const sig = md5(`api_key${PANO}artistAmethodtrack.lovesk${SK}trackT${PANO}`);
    const withSig = (s: string, key = PANO, secretless = fields) =>
      parseLastfmParams({
        url: ROOT,
        contentType: FORM,
        body: `${secretless.replace(`api_key=${PANO}`, `api_key=${key}`)}&api_sig=${s}`,
      });

    const upper = sig.toUpperCase();
    expect(upper).not.toBe(sig);
    expect(verifySignature(withSig(upper), PANO, upper)).toBe(true);
    await expect(enforceSignaturePolicy('track.love', withSig(upper), deps)).resolves.toEqual({
      required: true,
      keyKind: 'known',
      verified: true,
    });
    await expect(enforceSignaturePolicy('track.love', withSig(sig), deps)).resolves.toMatchObject({ verified: true });

    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
    for (const i of [0, 17, 31]) {
      const err = await policyError(enforceSignaturePolicy('track.love', withSig(flip(sig, i)), deps));
      expect(err.code).toBe(13);
      expect(err.status).toBe(403);
      expect(err.message).toBe('Invalid method signature supplied');
    }
    // Missing api_sig on a known key.
    const unsigned = parseLastfmParams({ url: ROOT, contentType: FORM, body: fields });
    expect((await policyError(enforceSignaturePolicy('track.love', unsigned, deps))).code).toBe(13);

    // An issued app key verifies against its own secret, uppercase included.
    const issuedSig = md5(`api_key${ISSUED_KEY}artistAmethodtrack.lovesk${SK}trackT${ISSUED_SECRET}`);
    await expect(
      enforceSignaturePolicy('track.love', withSig(issuedSig.toUpperCase(), ISSUED_KEY), deps),
    ).resolves.toEqual({
      required: true,
      keyKind: 'issued',
      verified: true,
    });
    expect(
      (await policyError(enforceSignaturePolicy('track.love', withSig(flip(issuedSig, 5), ISSUED_KEY), deps))).code,
    ).toBe(13);
    expect(deps.issuedLookups).toEqual([ISSUED_KEY, ISSUED_KEY]);

    // An unknown key: any 32-hex api_sig is accepted unverified; anything else is 13.
    const UNKNOWN = 'someclientkey';
    await expect(
      enforceSignaturePolicy('track.love', withSig('ABCDEF0123456789ABCDEF0123456789', UNKNOWN), deps),
    ).resolves.toEqual({
      required: true,
      keyKind: 'unknown',
      verified: false,
    });
    for (const bad of ['ABCDEF0123456789ABCDEF012345678', 'ABCDEF0123456789ABCDEF01234567890', 'g'.repeat(32), '']) {
      expect((await policyError(enforceSignaturePolicy('track.love', withSig(bad, UNKNOWN), deps))).code, bad).toBe(13);
    }
    const unknownUnsigned = parseLastfmParams({ url: ROOT, contentType: FORM, body: fields.replace(PANO, UNKNOWN) });
    expect((await policyError(enforceSignaturePolicy('track.love', unknownUnsigned, deps))).code).toBe(13);
    // A missing api_key on a signed method is 10.
    const noKey = parseLastfmParams({
      url: ROOT,
      contentType: FORM,
      body: `method=track.love&artist=A&track=T&api_sig=${sig}`,
    });
    expect((await policyError(enforceSignaturePolicy('track.love', noKey, deps))).code).toBe(10);
  });

  it('requiresSignature is true for auth.getToken, auth.getSession, auth.getMobileSession and the write methods and false for every read method of ADR §7.5', () => {
    const signed = [
      'auth.getToken',
      'auth.getSession',
      'auth.getMobileSession',
      'track.scrobble',
      'track.updateNowPlaying',
      'track.love',
      'track.unlove',
      'library.removeScrobble',
    ];
    const reads = [
      'user.getTrackScrobbles',
      'user.getRecentTracks',
      'user.getInfo',
      'user.getTopArtists',
      'user.getTopAlbums',
      'user.getTopTracks',
      'user.getLovedTracks',
      'user.getWeeklyChartList',
      'user.getWeeklyArtistChart',
      'user.getWeeklyAlbumChart',
      'user.getWeeklyTrackChart',
      'user.getFriends',
      'library.getArtists',
      'track.getInfo',
      'artist.getInfo',
      'album.getInfo',
      'user.getTopTags',
      'artist.getTopTags',
      'track.getTopTags',
      'album.getTopTags',
    ];
    for (const m of signed) expect(requiresSignature(m), m).toBe(true);
    for (const m of reads) expect(requiresSignature(m), m).toBe(false);
    // The exported tables are exactly the ADR §7.5 rows.
    expect([...SIGNED_METHODS].sort()).toEqual([...signed].sort());
    expect([...READ_METHODS].sort()).toEqual([...reads].sort());
    // A case variant of a signed method can never dodge the signature.
    expect(requiresSignature('TRACK.SCROBBLE')).toBe(true);
    expect(requiresSignature('track.updatenowplaying')).toBe(true);
  });

  it('a Pano-shaped unsigned user.getRecentTracks GET with sk and api_key and a lastfm-ts-api-shaped unsigned user.getInfo pass the policy, and the same requests with a wrong api_sig pass too', async () => {
    const deps = policyDeps();
    const notRequired: SignatureCheck = { required: false };

    // Pano: GET /2.0/?method=user.getRecentTracks&…&api_key=panoScrobbler&sk=…&format=json
    const panoQuery = `?method=user.getRecentTracks&user=alice&limit=50&page=1&extended=1&api_key=${PANO}&sk=${SK}&format=json`;
    const panoRead = parseLastfmParams({ url: `${ROOT}${panoQuery}` });
    await expect(enforceSignaturePolicy(methodOf(panoRead), panoRead, deps)).resolves.toEqual(notRequired);
    const panoWrong = parseLastfmParams({ url: `${ROOT}${panoQuery}&api_sig=${'0'.repeat(32)}` });
    await expect(enforceSignaturePolicy(methodOf(panoWrong), panoWrong, deps)).resolves.toEqual(notRequired);
    // A malformed api_sig and an unknown key do not matter on a read either.
    const garbage = parseLastfmParams({
      url: `${ROOT}?method=user.getRecentTracks&user=alice&api_key=zz&api_sig=nope`,
    });
    await expect(enforceSignaturePolicy(methodOf(garbage), garbage, deps)).resolves.toEqual(notRequired);

    // lastfm-ts-api: an unsigned user.getInfo (its request builder, no sign()),
    // then LastFMUser.getInfo signed with a wrong secret.
    const seen = captureHttps(deps);
    const config = { hostname: HOST, path: '/2.0/' };
    await expect(
      new LastFMApiRequest(config)
        .set({ user: 'alice' })
        .set({ api_key: 'multiscrobbler', method: 'user.getInfo', sk: SK })
        .send(),
    ).resolves.toEqual({ ok: { method: 'user.getInfo' } });
    await expect(new LastFMUser(PANO, 'wrong-secret', SK, config).getInfo({ user: 'alice' })).resolves.toEqual({
      ok: { method: 'user.getInfo' },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.params.has('api_sig')).toBe(false);
    expect(seen[0]?.params.get('sk')).toBe(SK);
    expect(seen[1]?.params.get('api_sig')).toMatch(/^[0-9a-f]{32}$/);
    expect(verifySignature(seen[1]!.params, PANO, seen[1]?.params.get('api_sig'))).toBe(false);
    for (const s of seen) expect(s.check).toEqual(notRequired);
    // Reads never consult issued keys.
    expect(deps.issuedLookups).toEqual([]);

    // The same wrong signature on a write is refused, so the pass above is the read scope.
    const writeWrong = parseLastfmParams({
      url: ROOT,
      contentType: FORM,
      body: `method=track.scrobble&artist=A&track=T&timestamp=1768474800&api_key=${PANO}&sk=${SK}&api_sig=${'0'.repeat(32)}`,
    });
    expect((await policyError(enforceSignaturePolicy('track.scrobble', writeWrong, deps))).code).toBe(13);
  });
});
