// Byte-faithful Pano Last.fm protocol client used by the N8 acceptance replay.
// The public key/secret are the configured Pano pair; the app password and
// returned session key stay in process and are never printed.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchWithoutLeak, jsonWithoutLeak } from './safe-http';

export const PANO_API_KEY = 'panoScrobbler';
export const PANO_API_SECRET = 'panoScrobbler';

export interface PanoLastfmOptions {
  origin: string;
  username: string;
  appPassword: string;
  listenedAtSeconds: number;
  artist: string;
  track: string;
  durationSeconds: number;
  fetchImpl?: typeof fetch;
}

export interface PanoLastfmResult {
  username: string;
  scrobble: unknown;
  nowPlaying: unknown;
  recentTracks: unknown;
}

/** Last.fm signs decoded parameter values in ascending key order. */
export function panoSignature(params: Readonly<Record<string, string>>, secret = PANO_API_SECRET): string {
  const base = Object.keys(params)
    .filter((key) => key !== 'api_sig' && key !== 'format')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return createHash('md5').update(`${base}${secret}`, 'utf8').digest('hex');
}

function signedForm(params: Record<string, string>): URLSearchParams {
  const signed = { ...params, api_key: PANO_API_KEY };
  const fields = new URLSearchParams(signed);
  fields.set('format', 'json');
  fields.set('api_sig', panoSignature(signed));
  return fields;
}

async function readJson(response: Response, method: string): Promise<unknown> {
  if (!response.ok) throw new Error(`Pano ${method} returned HTTP ${response.status}`);
  const body = await jsonWithoutLeak(response, `Pano Last.fm ${method}`);
  if (body === null || typeof body !== 'object' || 'error' in body) {
    throw new Error(`Pano ${method} returned an invalid or error response`);
  }
  return body;
}

/** Execute Pano's mobile-session, scrobble, now-playing and recent-read flow. */
export async function runPanoLastfm(options: PanoLastfmOptions): Promise<PanoLastfmResult> {
  if (!Number.isSafeInteger(options.listenedAtSeconds) || options.listenedAtSeconds <= 0)
    throw new RangeError('Pano listenedAtSeconds must be a positive integer');
  if (!Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 0)
    throw new RangeError('Pano durationSeconds must be a non-negative integer');
  const endpoint = new URL('/2.0/', options.origin);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new TypeError('Pano origin must be HTTP(S)');
  const send = options.fetchImpl ?? fetch;
  const request = (input: string | URL, init: RequestInit, method: string) =>
    fetchWithoutLeak(send, input, init, `Pano Last.fm ${method}`);

  const authForm = signedForm({
    method: 'auth.getMobileSession',
    username: options.username,
    password: options.appPassword,
  });
  const auth = (await readJson(
    await request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'user-agent': 'Pano Scrobbler/3.6 (Android)',
        },
        body: authForm,
      },
      'auth.getMobileSession',
    ),
    'auth.getMobileSession',
  )) as { session?: { name?: unknown; key?: unknown } };
  const session = auth.session;
  if (typeof session?.name !== 'string' || typeof session.key !== 'string' || session.key.length === 0)
    throw new Error('Pano auth.getMobileSession returned no session');

  const scrobbleForm = signedForm({
    method: 'track.scrobble',
    artist: options.artist,
    track: options.track,
    timestamp: String(options.listenedAtSeconds),
    duration: String(options.durationSeconds),
    sk: session.key,
  });
  const scrobble = await readJson(
    await request(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: scrobbleForm,
      },
      'track.scrobble',
    ),
    'track.scrobble',
  );

  const nowPlayingForm = signedForm({
    method: 'track.updateNowPlaying',
    artist: options.artist,
    track: options.track,
    duration: String(options.durationSeconds),
    sk: session.key,
  });
  const nowPlaying = await readJson(
    await request(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: nowPlayingForm,
      },
      'track.updateNowPlaying',
    ),
    'track.updateNowPlaying',
  );

  // Pano reads are unsigned and carry sk + api_key. This mirrors the captured
  // client request shape and verifies the server resolves the session owner.
  const read = new URLSearchParams({
    method: 'user.getRecentTracks',
    user: session.name,
    sk: session.key,
    api_key: PANO_API_KEY,
    format: 'json',
    limit: '50',
    page: '1',
    extended: '1',
  });
  const recentTracks = await readJson(
    await request(
      `${endpoint}?${read.toString()}`,
      {
        method: 'GET',
        headers: { 'user-agent': 'Pano Scrobbler/3.6 (Android)' },
      },
      'user.getRecentTracks',
    ),
    'user.getRecentTracks',
  );
  return { username: session.name, scrobble, nowPlaying, recentTracks };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.env.ATMUSIC_E2E_ORIGIN;
  const username = process.env.ATMUSIC_E2E_PANO_HANDLE;
  const appPassword = process.env.ATMUSIC_E2E_PANO_APP_PASSWORD;
  if (!origin || !username || !appPassword) {
    console.error('Pano replay requires ATMUSIC_E2E_ORIGIN, ATMUSIC_E2E_PANO_HANDLE and ATMUSIC_E2E_PANO_APP_PASSWORD');
    process.exitCode = 2;
  } else {
    runPanoLastfm({
      origin,
      username,
      appPassword,
      listenedAtSeconds: 1768474800,
      artist: 'Test Artist',
      track: 'Test Track',
      durationSeconds: 215,
    }).catch(() => {
      console.error('Pano Last.fm replay failed');
      process.exitCode = 1;
    });
  }
}
