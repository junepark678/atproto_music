import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import {
  MULTI_SCROBBLER_PUBLIC_ORIGIN,
  runMultiScrobblerLastfm,
} from '../e2e/scrobbler-clients/multi-scrobbler-lastfm.ts';

const TEMP_TOKEN = '1234567890abcdef1234567890abcdef';
const SESSION_KEY = 'abcdef1234567890abcdef1234567890';
const COOKIE = '__Host-atmusic_session=session-cookie-secret';
const CSRF = 'csrf-secret-value';
const requests: Array<{
  method: string;
  url: string;
  host: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}> = [];
let server: Server | undefined;

function respond(outgoing: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  outgoing.writeHead(status, { 'content-type': 'application/json', ...headers });
  outgoing.end(typeof body === 'string' ? body : JSON.stringify(body));
}

interface ServerBehavior {
  badApproval?: boolean;
  sessionName?: string;
  scrobbleBody?: unknown;
  nowPlayingBody?: unknown;
  recentBody?: unknown;
  sessionStatus?: number;
}

async function startServer(behavior: ServerBehavior = {}): Promise<string> {
  requests.length = 0;
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        host: incoming.headers.host,
        headers: incoming.headers,
        body,
      });
      if (
        incoming.url ===
        '/api/auth?api_key=0123456789abcdef0123456789abcdef&cb=http://localhost:9078/librefm/callback?state=x'
      ) {
        respond(outgoing, 302, '', {
          location:
            '/lastfm/authorize?api_key=0123456789abcdef0123456789abcdef&cb=http://localhost:9078/librefm/callback?state=x',
        });
      } else if (incoming.url === '/api/v1/lastfm/authorize') {
        respond(outgoing, 200, {
          token: behavior.badApproval ? `${TEMP_TOKEN}${SESSION_KEY}` : TEMP_TOKEN,
        });
      } else if (incoming.url?.startsWith('/2.0/?method=auth.getSession&')) {
        if (behavior.sessionStatus === 204) {
          outgoing.writeHead(204);
          outgoing.end();
        } else {
          respond(outgoing, 200, {
            session: {
              name: behavior.sessionName ?? 'alice.bsky.social',
              key: SESSION_KEY,
              subscriber: 0,
            },
          });
        }
      } else if (incoming.url === '/2.0/' && body.includes('method=track.scrobble')) {
        respond(
          outgoing,
          200,
          behavior.scrobbleBody ?? {
            scrobbles: {
              '@attr': { accepted: 2, ignored: 0 },
              scrobble: [
                {
                  artist: { '#text': 'Multi Scrobbler Artist' },
                  track: { '#text': 'First Track' },
                  timestamp: '1768478280',
                  ignoredMessage: { code: '0', '#text': '' },
                },
                {
                  artist: { '#text': 'Multi Scrobbler Artist' },
                  track: { '#text': 'Second Track' },
                  timestamp: '1768478340',
                  ignoredMessage: { code: '0', '#text': '' },
                },
              ],
            },
          },
        );
      } else if (incoming.url === '/2.0/' && body.includes('method=track.updateNowPlaying')) {
        respond(
          outgoing,
          200,
          behavior.nowPlayingBody ?? {
            nowplaying: {
              artist: { '#text': 'Multi Scrobbler Artist' },
              track: { '#text': 'Now Playing' },
              ignoredMessage: { code: '0', '#text': '' },
            },
          },
        );
      } else if (incoming.url?.startsWith('/2.0/?method=user.getRecentTracks&')) {
        respond(
          outgoing,
          200,
          behavior.recentBody ?? {
            recenttracks: {
              track: [
                {
                  name: 'First Track',
                  artist: { '#text': 'Multi Scrobbler Artist' },
                  date: { uts: '1768478280', '#text': '15 Jan 2026, 11:58' },
                },
                {
                  name: 'Second Track',
                  artist: { '#text': 'Multi Scrobbler Artist' },
                  date: { uts: '1768478340', '#text': '15 Jan 2026, 11:59' },
                },
              ],
            },
          },
        );
      } else respond(outgoing, 404, { error: 'unexpected request' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
});

test('multi-scrobbler web auth, session exchange, batch writes and unsigned recent tracks stay on loopback', async () => {
  const transportOrigin = await startServer();
  const result = await runMultiScrobblerLastfm({ cookie: COOKIE, csrfToken: CSRF, transportOrigin });

  expect(result).toEqual({
    redirectPath: '/api/auth',
    callbackPath: '/librefm/callback?state=x',
    sessionEstablished: true,
    scrobbleBatchSize: 2,
    recentTrackCount: 2,
  });
  const authRequest = requests[0]!;
  expect([authRequest.method, authRequest.url, authRequest.host]).toEqual([
    'GET',
    '/api/auth?api_key=0123456789abcdef0123456789abcdef&cb=http://localhost:9078/librefm/callback?state=x',
    'music.214510.xyz',
  ]);
  const approve = requests[1]!;
  expect([approve.method, approve.url, approve.host]).toEqual(['POST', '/api/v1/lastfm/authorize', 'music.214510.xyz']);
  expect(approve.headers.origin).toBe(MULTI_SCROBBLER_PUBLIC_ORIGIN);
  expect(approve.headers.cookie).toBe(COOKIE);
  expect(approve.headers['x-csrf-token']).toBe(CSRF);
  expect(JSON.parse(approve.body)).toEqual({ apiKey: '0123456789abcdef0123456789abcdef' });

  const session = new URLSearchParams(requests[2]!.url.split('?')[1]);
  expect(requests[2]!.method).toBe('GET');
  expect(Object.fromEntries(session)).toEqual({
    method: 'auth.getSession',
    api_key: '0123456789abcdef0123456789abcdef',
    token: TEMP_TOKEN,
    api_sig: 'a'.repeat(32),
    format: 'json',
  });
  const scrobble = new URLSearchParams(requests[3]!.body);
  expect(requests[3]!.method).toBe('POST');
  expect(requests[3]!.headers['content-type']).toContain('application/x-www-form-urlencoded');
  expect(scrobble.get('method')).toBe('track.scrobble');
  expect(scrobble.get('api_sig')).toBe('a'.repeat(32));
  expect(scrobble.get('artist[0]')).toBe('Multi Scrobbler Artist');
  expect(scrobble.get('track[0]')).toBe('First Track');
  expect(scrobble.get('artist[1]')).toBe('Multi Scrobbler Artist');
  expect(scrobble.get('track[1]')).toBe('Second Track');
  const nowPlaying = new URLSearchParams(requests[4]!.body);
  expect([requests[4]!.method, nowPlaying.get('method'), nowPlaying.get('track')]).toEqual([
    'POST',
    'track.updateNowPlaying',
    'Now Playing',
  ]);
  const recent = new URLSearchParams(requests[5]!.url.split('?')[1]);
  expect(requests[5]!.method).toBe('GET');
  expect(Object.fromEntries(recent)).toEqual({
    method: 'user.getRecentTracks',
    api_key: '0123456789abcdef0123456789abcdef',
    sk: SESSION_KEY,
    format: 'json',
  });

  const exposed = JSON.stringify(result);
  expect(exposed).not.toContain(TEMP_TOKEN);
  expect(exposed).not.toContain(SESSION_KEY);
});

test('invalid protocol responses fail with a stable error that never leaks temporary or session secrets', async () => {
  const transportOrigin = await startServer({ badApproval: true });
  // A malformed approval token fails before any Last.fm request and the thrown
  // error is deliberately independent of all response data.
  let caught = '';
  try {
    await runMultiScrobblerLastfm({ cookie: COOKIE, csrfToken: CSRF, transportOrigin });
  } catch (error) {
    caught = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  expect(caught).toBe('Error: multi-scrobbler Last.fm protocol response was invalid');
  expect(caught).not.toContain(TEMP_TOKEN);
  expect(caught).not.toContain(SESSION_KEY);
});

test('a session response cannot echo its key through the session name', async () => {
  const transportOrigin = await startServer({ sessionName: SESSION_KEY });
  await expect(runMultiScrobblerLastfm({ cookie: COOKIE, csrfToken: CSRF, transportOrigin })).rejects.toThrow(
    'multi-scrobbler Last.fm protocol response was invalid',
  );
  expect(requests).toHaveLength(3);
});

test.each([
  ['malformed scrobble acknowledgement', { scrobbleBody: { scrobbles: {} } }],
  [
    'scrobble acknowledgement without echoed track data',
    { scrobbleBody: { scrobbles: { '@attr': { accepted: 2, ignored: 0 }, scrobble: [{}, {}] } } },
  ],
  ['malformed now-playing acknowledgement', { nowPlayingBody: { nowplaying: [] } }],
  [
    'now-playing acknowledgement without track data',
    { nowPlayingBody: { nowplaying: { ignoredMessage: { code: '0', '#text': '' } } } },
  ],
  ['empty recent-track result', { recentBody: { recenttracks: { track: [] } } }],
  [
    'recent track with empty name',
    {
      recentBody: {
        recenttracks: {
          track: [
            { name: '', artist: { '#text': 'Multi Scrobbler Artist' } },
            { name: 'Second Track', artist: { '#text': 'Multi Scrobbler Artist' } },
          ],
        },
      },
    },
  ],
  [
    'recent tracks do not include the submitted listens',
    {
      recentBody: {
        recenttracks: {
          track: [
            { name: 'Other Track', artist: { '#text': 'Multi Scrobbler Artist' } },
            { name: 'Another Track', artist: { '#text': 'Multi Scrobbler Artist' } },
          ],
        },
      },
    },
  ],
  [
    'recent tracks have unrelated artists',
    {
      recentBody: {
        recenttracks: {
          track: [
            {
              name: 'First Track',
              artist: { '#text': 'Unrelated Artist' },
              date: { uts: '1768478280', '#text': '15 Jan 2026, 11:58' },
            },
            {
              name: 'Second Track',
              artist: { '#text': 'Unrelated Artist' },
              date: { uts: '1768478340', '#text': '15 Jan 2026, 11:59' },
            },
          ],
        },
      },
    },
  ],
  [
    'recent tracks have stale timestamps',
    {
      recentBody: {
        recenttracks: {
          track: [
            {
              name: 'First Track',
              artist: { '#text': 'Multi Scrobbler Artist' },
              date: { uts: '1768474680', '#text': '15 Jan 2026, 10:58' },
            },
            {
              name: 'Second Track',
              artist: { '#text': 'Multi Scrobbler Artist' },
              date: { uts: '1768474740', '#text': '15 Jan 2026, 10:59' },
            },
          ],
        },
      },
    },
  ],
  ['bodyless success response', { sessionStatus: 204 }],
])('%s fails instead of reporting successful replay', async (_label, behavior) => {
  const transportOrigin = await startServer(behavior);
  await expect(runMultiScrobblerLastfm({ cookie: COOKIE, csrfToken: CSRF, transportOrigin })).rejects.toThrow(
    'multi-scrobbler Last.fm protocol response was invalid',
  );
});

test('transport requires a loopback HTTP origin and never defaults to public HTTPS through node:http', async () => {
  requests.length = 0;
  await expect(
    runMultiScrobblerLastfm({ cookie: COOKIE, csrfToken: CSRF, transportOrigin: MULTI_SCROBBLER_PUBLIC_ORIGIN }),
  ).rejects.toThrow('multi-scrobbler Last.fm protocol response was invalid');
  expect(requests).toHaveLength(0);
});

test('malformed transport URLs and headers are converted to a stable secret-free error', async () => {
  const secret = 'malformed-url-secret';
  await expect(
    runMultiScrobblerLastfm({
      cookie: COOKIE,
      csrfToken: CSRF,
      transportOrigin: `http://[invalid-${secret}`,
    }),
  ).rejects.toThrow('multi-scrobbler Last.fm protocol response was invalid');
  await expect(
    runMultiScrobblerLastfm({
      cookie: `bad\n${secret}`,
      csrfToken: CSRF,
      transportOrigin: await startServer(),
    }),
  ).rejects.toThrow('multi-scrobbler Last.fm protocol response was invalid');
});
