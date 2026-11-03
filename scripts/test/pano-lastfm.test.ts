import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { panoSignature, runPanoLastfm } from '../e2e/scrobbler-clients/pano-lastfm';

interface Captured {
  method: string;
  path: string;
  body: string;
  contentType: string;
  userAgent: string;
}

interface ServerBehavior {
  scrobbleResponse?: unknown;
  nowPlayingResponse?: unknown;
  recentResponse?: unknown;
}

let server: Server | null = null;

async function listen(
  handler: (request: IncomingMessage, body: string) => void,
  behavior: ServerBehavior = {},
): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      handler(request, body);
      const method =
        new URL(request.url ?? '/', 'http://localhost').searchParams.get('method') ??
        new URLSearchParams(body).get('method');
      const result =
        method === 'auth.getMobileSession'
          ? { session: { name: 'pano-user', key: 'fake-session-key' } }
          : method === 'track.scrobble'
            ? (behavior.scrobbleResponse ?? {
                scrobbles: {
                  '@attr': { accepted: 1, ignored: 0 },
                  scrobble: {
                    track: { corrected: '0', '#text': 'Test Track' },
                    artist: { corrected: '0', '#text': 'Test Artist' },
                    timestamp: '1768474800',
                    ignoredMessage: { code: '0', '#text': '' },
                  },
                },
              })
            : method === 'track.updateNowPlaying'
              ? (behavior.nowPlayingResponse ?? {
                  nowplaying: {
                    track: { corrected: '0', '#text': 'Test Track' },
                    artist: { corrected: '0', '#text': 'Test Artist' },
                    ignoredMessage: { code: '0', '#text': '' },
                  },
                })
              : (behavior.recentResponse ?? {
                  recenttracks: { track: [], '@attr': { user: 'pano-user', totalPages: 0 } },
                });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server !== null) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

describe('Pano Last.fm replay client', () => {
  it('uses the mobile session, signed form writes and unsigned Pano read request shape', async () => {
    const requests: Captured[] = [];
    const origin = await listen((request, body) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body,
        contentType: request.headers['content-type'] ?? '',
        userAgent: request.headers['user-agent'] ?? '',
      });
    });

    const result = await runPanoLastfm({
      origin,
      username: 'pano-user',
      appPassword: 'APP-PASSWORD-SECRET',
      listenedAtSeconds: 1_768_474_800,
      artist: 'Test Artist',
      track: 'Test Track',
      durationSeconds: 215,
    });

    expect(result.username).toBe('pano-user');
    expect(
      requests.map((request) => [
        request.method,
        new URL(request.path, origin).searchParams.get('method') ?? new URLSearchParams(request.body).get('method'),
      ]),
    ).toEqual([
      ['POST', 'auth.getMobileSession'],
      ['POST', 'track.scrobble'],
      ['POST', 'track.updateNowPlaying'],
      ['GET', 'user.getRecentTracks'],
    ]);

    const auth = new URLSearchParams(requests[0]!.body);
    expect(auth.get('password')).toBe('APP-PASSWORD-SECRET');
    expect(auth.get('api_sig')).toBe(
      panoSignature({
        method: 'auth.getMobileSession',
        username: 'pano-user',
        password: 'APP-PASSWORD-SECRET',
        api_key: 'panoScrobbler',
      }),
    );
    const scrobble = new URLSearchParams(requests[1]!.body);
    expect(scrobble.get('api_sig')).toBe(
      panoSignature({
        method: 'track.scrobble',
        artist: 'Test Artist',
        track: 'Test Track',
        timestamp: '1768474800',
        duration: '215',
        sk: 'fake-session-key',
        api_key: 'panoScrobbler',
      }),
    );
    expect(scrobble.get('format')).toBe('json');
    const nowPlaying = new URLSearchParams(requests[2]!.body);
    expect(nowPlaying.get('method')).toBe('track.updateNowPlaying');
    expect(nowPlaying.get('sk')).toBe('fake-session-key');
    expect(Object.fromEntries(new URL(requests[3]!.path, origin).searchParams)).toEqual(
      Object.fromEntries(
        new URLSearchParams({
          method: 'user.getRecentTracks',
          user: 'pano-user',
          sk: 'fake-session-key',
          api_key: 'panoScrobbler',
          format: 'json',
          limit: '50',
          page: '1',
          extended: '1',
        }),
      ),
    );
    expect(requests[3]!.body).toBe('');
    expect(requests[0]!.userAgent).toBe('Pano Scrobbler/3.6 (Android)');
  });

  it.each([
    [
      'scrobble ignored',
      {
        scrobbleResponse: {
          scrobbles: {
            '@attr': { accepted: 0, ignored: 1 },
            scrobble: {
              track: { corrected: '0', '#text': 'Test Track' },
              artist: { corrected: '0', '#text': 'Test Artist' },
              timestamp: '1768474800',
              ignoredMessage: { code: '1', '#text': 'ignored' },
            },
          },
        },
      },
    ],
    ['scrobble acknowledgement missing', { scrobbleResponse: {} }],
    [
      'now-playing ignored',
      {
        nowPlayingResponse: {
          nowplaying: {
            track: { corrected: '0', '#text': 'Test Track' },
            artist: { corrected: '0', '#text': 'Test Artist' },
            ignoredMessage: { code: '1', '#text': 'ignored' },
          },
        },
      },
    ],
    ['now-playing acknowledgement missing', { nowPlayingResponse: {} }],
    ['recent-tracks response malformed', { recentResponse: { recenttracks: {} } }],
  ])('%s is rejected instead of reported as a successful replay', async (_label, behavior) => {
    const origin = await listen(() => {}, behavior);
    await expect(
      runPanoLastfm({
        origin,
        username: 'pano-user',
        appPassword: 'APP-PASSWORD-SECRET',
        listenedAtSeconds: 1_768_474_800,
        artist: 'Test Artist',
        track: 'Test Track',
        durationSeconds: 215,
      }),
    ).rejects.toThrow(/invalid acknowledgement|invalid response/);
  });

  it('does not reflect malformed upstream bodies or transport error text', async () => {
    const secret = 'PANO-RESPONSE-SECRET';
    const options = {
      origin: 'http://127.0.0.1:1',
      username: 'pano-user',
      appPassword: secret,
      listenedAtSeconds: 1_768_478_100,
      artist: 'Radiohead',
      track: 'Paranoid Android',
      durationSeconds: 215,
      fetchImpl: async () => new Response(`not-json ${secret}`, { status: 200 }),
    } as const;
    await expect(runPanoLastfm(options)).rejects.toThrow('Pano Last.fm auth.getMobileSession returned invalid JSON');
    await expect(
      runPanoLastfm({
        ...options,
        fetchImpl: async () => {
          throw new Error(`transport echoed ${secret}`);
        },
      }),
    ).rejects.toThrow('Pano Last.fm auth.getMobileSession transport failed');
    await expect(runPanoLastfm(options)).rejects.not.toThrow(secret);
  });
});
