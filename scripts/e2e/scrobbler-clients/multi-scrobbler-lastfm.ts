// Deterministic multi-scrobbler protocol replay. The unknown public API key
// models multi-scrobbler's deployed/custom entry; its accepted signatures are
// deliberately fixed 32-hex test values, not credentials for a live service.

import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';

export const MULTI_SCROBBLER_PUBLIC_ORIGIN = 'https://music.214510.xyz';
const API_KEY = '0123456789abcdef0123456789abcdef';
const API_SIG = 'a'.repeat(32);
const CALLBACK = 'http://localhost:9078/librefm/callback?state=x';
const SAFE_PROTOCOL_ERROR = 'multi-scrobbler Last.fm protocol response was invalid';
let currentStage = 'setup';
let stageObserver: ((stage: string) => void) | undefined;

export interface MultiScrobblerLastfmOptions {
  cookie: string;
  csrfToken: string;
  /** Required loopback HTTP listener; request Host remains the public HTTPS host. */
  transportOrigin: string;
  /** Parent-owned Jetstream pump used by the integrated N8 runner before reads. */
  beforeRecentRead?: () => Promise<void>;
  onStage?: (stage: string) => void;
}

export interface MultiScrobblerLastfmResult {
  redirectPath: string;
  callbackPath: string;
  sessionEstablished: true;
  scrobbleBatchSize: number;
  recentTrackCount: number;
}

function fail(): never {
  // Avoid including response bodies, URLs, callback tokens or session keys.
  throw new Error(SAFE_PROTOCOL_ERROR);
}

async function request(
  origin: string,
  transportOrigin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const pathOnly = path.split('?', 1)[0];
  if (pathOnly === '/2.0/' || pathOnly === '/2.0') {
    try {
      const method = new URL(path, 'http://fixture.invalid').searchParams.get('method');
      const methods = new Set(['auth.getSession', 'track.scrobble', 'track.updateNowPlaying', 'user.getRecentTracks']);
      currentStage = method && methods.has(method) ? method : 'lastfm-method';
    } catch {
      currentStage = 'lastfm-method';
    }
  } else
    currentStage =
      pathOnly === '/api/auth'
        ? 'approval-redirect'
        : pathOnly === '/api/v1/lastfm/authorize'
          ? 'app-approval'
          : 'unexpected-path';
  stageObserver?.(currentStage);
  let target: URL;
  let headers: Record<string, string>;
  let body: string | undefined;
  let method: string;
  try {
    const base = new URL(transportOrigin);
    const loopback =
      base.hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(base.hostname) || base.hostname === '[::1]';
    if (
      base.protocol !== 'http:' ||
      !loopback ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      return fail();
    target = new URL(path, base);
    if (target.origin !== base.origin) return fail();
    headers = Object.fromEntries(new Headers(init.headers).entries());
    headers.host = new URL(origin).host;
    body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : undefined;
    method = init.method ?? 'GET';
  } catch {
    return fail();
  }
  return new Promise((resolve, reject) => {
    try {
      const request = httpRequest(target, { method, headers }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        incoming.once('aborted', () => reject(new Error(SAFE_PROTOCOL_ERROR)));
        incoming.once('error', () => reject(new Error(SAFE_PROTOCOL_ERROR)));
        incoming.on('end', () => {
          try {
            const status = incoming.statusCode ?? 502;
            const noBody = status === 204 || status === 205 || status === 304;
            resolve(
              new Response(noBody ? null : Buffer.concat(chunks), {
                status,
                headers: Object.fromEntries(
                  Object.entries(incoming.headers as IncomingHttpHeaders).flatMap(([key, value]) =>
                    typeof value === 'string' ? [[key, value]] : [],
                  ),
                ),
              }),
            );
          } catch {
            reject(new Error(SAFE_PROTOCOL_ERROR));
          }
        });
      });
      request.once('error', () => reject(new Error(SAFE_PROTOCOL_ERROR)));
      request.end(body);
    } catch {
      reject(new Error(SAFE_PROTOCOL_ERROR));
    }
  });
}

function hasText(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>)['#text'] === 'string' &&
      ((value as Record<string, unknown>)['#text'] as string).trim().length > 0,
  );
}

function hasSuccessfulIgnoredMessage(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).code === '0' &&
      typeof (value as Record<string, unknown>)['#text'] === 'string',
  );
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
  const transportOrigin = options.transportOrigin;
  stageObserver = options.onStage;

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
  if (
    typeof sessionName !== 'string' ||
    sessionName.length === 0 ||
    typeof sessionKey !== 'string' ||
    !/^[0-9a-f]{32}$/.test(sessionKey) ||
    sessionName.includes(sessionKey) ||
    sessionName.includes(temporaryToken)
  )
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
  const scrobbleRecord = scrobbleRoot as Record<string, unknown>;
  const attributes = scrobbleRecord['@attr'];
  const scrobbleItems = scrobbleRecord.scrobble;
  if (
    !attributes ||
    typeof attributes !== 'object' ||
    (attributes as Record<string, unknown>).accepted !== batch.length ||
    (attributes as Record<string, unknown>).ignored !== 0 ||
    !Array.isArray(scrobbleItems) ||
    scrobbleItems.length !== batch.length ||
    !scrobbleItems.every((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const ignored = (item as Record<string, unknown>).ignoredMessage;
      return (
        hasText((item as Record<string, unknown>).track) &&
        hasText((item as Record<string, unknown>).artist) &&
        (item as Record<string, unknown>).timestamp === batch[index]?.timestamp &&
        hasSuccessfulIgnoredMessage(ignored)
      );
    })
  )
    return fail();

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
  const nowPlayingResult = nowBody.nowplaying;
  if (
    !nowPlayingResult ||
    typeof nowPlayingResult !== 'object' ||
    Array.isArray(nowPlayingResult) ||
    !hasText((nowPlayingResult as Record<string, unknown>).track) ||
    !hasText((nowPlayingResult as Record<string, unknown>).artist) ||
    !hasSuccessfulIgnoredMessage((nowPlayingResult as Record<string, unknown>).ignoredMessage)
  )
    return fail();

  const recentPath = `/2.0/?${new URLSearchParams({
    method: 'user.getRecentTracks',
    api_key: API_KEY,
    sk: sessionKey,
    format: 'json',
  })}`;
  await options.beforeRecentRead?.();
  const recent = await request(publicOrigin, transportOrigin, recentPath);
  if (recent.status !== 200) return fail();
  const recentBody = await json(recent);
  const recentTracks = recentBody.recenttracks;
  if (!recentTracks || typeof recentTracks !== 'object' || Array.isArray(recentTracks)) return fail();
  const trackList = (recentTracks as Record<string, unknown>).track;
  if (
    !Array.isArray(trackList) ||
    trackList.length === 0 ||
    !trackList.every(
      (track) =>
        track &&
        typeof track === 'object' &&
        !Array.isArray(track) &&
        typeof (track as Record<string, unknown>).name === 'string' &&
        ((track as Record<string, unknown>).name as string).trim().length > 0 &&
        hasText((track as Record<string, unknown>).artist),
    )
  )
    return fail();
  const listens = trackList as Array<Record<string, unknown>>;
  const matchesSubmittedListen = (item: (typeof batch)[number]) =>
    listens.some((track) => {
      if (track.name !== item.track) return false;
      const date = track.date;
      if (!date || typeof date !== 'object' || Array.isArray(date)) return false;
      return (
        hasText(track.artist) &&
        (track.artist as Record<string, unknown>)['#text'] === item.artist &&
        (date as Record<string, unknown>).uts === item.timestamp
      );
    });
  if (batch.some((item) => !matchesSubmittedListen(item))) return fail();

  return {
    redirectPath: '/api/auth',
    callbackPath: '/librefm/callback?state=x',
    sessionEstablished: true,
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
