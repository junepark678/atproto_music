// Deterministic multi-scrobbler protocol replay. The unknown public API key
// models multi-scrobbler's deployed/custom entry; its accepted signatures are
// deliberately fixed 32-hex test values, not credentials for a live service.

import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';

export const MULTI_SCROBBLER_PUBLIC_ORIGIN = 'https://music.214510.xyz';
const API_KEY = '0123456789abcdef0123456789abcdef';
const API_SIG = 'a'.repeat(32);
const CALLBACK = 'http://localhost:9078/librefm/callback?state=x';

export interface MultiScrobblerLastfmOptions {
  cookie: string;
  csrfToken: string;
  /** Test transport override. Headers and URL semantics retain the public origin. */
  transportOrigin?: string;
}

export interface MultiScrobblerLastfmResult {
  redirectPath: string;
  callbackPath: string;
  sessionName: string;
  scrobbleBatchSize: number;
  recentTrackCount: number;
}

function fail(): never {
  // Avoid including response bodies, URLs, callback tokens or session keys.
  throw new Error('multi-scrobbler Last.fm protocol response was invalid');
}

async function request(
  origin: string,
  transportOrigin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(path, transportOrigin);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = new URL(origin).host;
  const body =
    typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method: init.method ?? 'GET', headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        resolve(
          new Response(Buffer.concat(chunks), {
            status: incoming.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(incoming.headers as IncomingHttpHeaders).flatMap(([key, value]) =>
                typeof value === 'string' ? [[key, value]] : [],
              ),
            ),
          }),
        );
      });
    });
    request.once('error', () => reject(new Error('multi-scrobbler loopback transport failed')));
    request.end(body);
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Report only the stable, secret-free protocol error below.
  }
  return fail();
}

function form(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

export async function runMultiScrobblerLastfm(
  options: MultiScrobblerLastfmOptions,
): Promise<MultiScrobblerLastfmResult> {
  const publicOrigin = MULTI_SCROBBLER_PUBLIC_ORIGIN;
  const transportOrigin = options.transportOrigin ?? publicOrigin;

  const redirect = await request(publicOrigin, transportOrigin, `/api/auth?api_key=${API_KEY}&cb=${CALLBACK}`);
  const expectedLocation = `/lastfm/authorize?api_key=${API_KEY}&cb=${CALLBACK}`;
  if (redirect.status !== 302 || redirect.headers.get('location') !== expectedLocation) return fail();

  const approval = await request(publicOrigin, transportOrigin, '/api/v1/lastfm/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: options.cookie,
      origin: publicOrigin,
      'x-csrf-token': options.csrfToken,
    },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  if (approval.status !== 200) return fail();
  const approvalBody = await json(approval);
  const temporaryToken = approvalBody.token;
  if (typeof temporaryToken !== 'string' || !/^[0-9a-f]{32}$/.test(temporaryToken)) return fail();

  // multi-scrobbler appends the temporary token to the cb value verbatim.
  const callbackNavigation = `${CALLBACK}&token=${temporaryToken}`;
  const callbackUrl = new URL(callbackNavigation);
  if (callbackUrl.searchParams.get('state') !== 'x' || callbackUrl.searchParams.get('token') !== temporaryToken)
    return fail();

  const sessionResponse = await lastfmGet(transportOrigin, {
    method: 'auth.getSession',
    api_key: API_KEY,
    token: temporaryToken,
    api_sig: API_SIG,
    format: 'json',
  });
  if (sessionResponse.status !== 200) return fail();
  const sessionBody = await json(sessionResponse);
  const session = sessionBody.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) return fail();
  const sessionName = (session as Record<string, unknown>).name;
  const sessionKey = (session as Record<string, unknown>).key;
  if (typeof sessionName !== 'string' || typeof sessionKey !== 'string' || !/^[0-9a-f]{32}$/.test(sessionKey))
    return fail();

  const batch = [
    { artist: 'Multi Scrobbler Artist', track: 'First Track', timestamp: '1768478280' },
    { artist: 'Multi Scrobbler Artist', track: 'Second Track', timestamp: '1768478340' },
  ];
  const scrobbleParams: Record<string, string> = {
    method: 'track.scrobble',
    api_key: API_KEY,
    sk: sessionKey,
    api_sig: API_SIG,
    format: 'json',
  };
  batch.forEach((item, index) => {
    for (const [key, value] of Object.entries(item)) scrobbleParams[`${key}[${index}]`] = value;
  });
  const scrobbles = await lastfmPost(transportOrigin, scrobbleParams);
  if (scrobbles.status !== 200) return fail();
  const scrobbleBody = await json(scrobbles);
  const scrobbleRoot = scrobbleBody.scrobbles;
  if (!scrobbleRoot || typeof scrobbleRoot !== 'object' || Array.isArray(scrobbleRoot)) return fail();

  const nowPlaying = await lastfmPost(transportOrigin, {
    method: 'track.updateNowPlaying',
    api_key: API_KEY,
    sk: sessionKey,
    artist: 'Multi Scrobbler Artist',
    track: 'Now Playing',
    api_sig: API_SIG,
    format: 'json',
  });
  if (nowPlaying.status !== 200) return fail();
  const nowBody = await json(nowPlaying);
  if (!nowBody.nowplaying || typeof nowBody.nowplaying !== 'object') return fail();

  const recentPath = `/2.0/?${new URLSearchParams({
    method: 'user.getRecentTracks',
    api_key: API_KEY,
    sk: sessionKey,
    format: 'json',
  })}`;
  const recent = await request(publicOrigin, transportOrigin, recentPath);
  if (recent.status !== 200) return fail();
  const recentBody = await json(recent);
  const recentTracks = recentBody.recenttracks;
  if (!recentTracks || typeof recentTracks !== 'object' || Array.isArray(recentTracks)) return fail();
  const trackList = (recentTracks as Record<string, unknown>).track;
  if (!Array.isArray(trackList) || !trackList.every((track) => track && typeof track === 'object')) return fail();

  return {
    redirectPath: '/api/auth',
    callbackPath: '/librefm/callback?state=x',
    sessionName,
    scrobbleBatchSize: batch.length,
    recentTrackCount: trackList.length,
  };

  async function lastfmGet(target: string, params: Record<string, string>): Promise<Response> {
    return request(publicOrigin, target, `/2.0/?${form(params)}`);
  }
  async function lastfmPost(target: string, params: Record<string, string>): Promise<Response> {
    return request(publicOrigin, target, '/2.0/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(params),
    });
  }
}
