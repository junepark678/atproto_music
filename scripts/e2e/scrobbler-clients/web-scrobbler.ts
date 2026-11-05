// Byte-faithful Web Scrobbler ListenBrainz replay client for N8. Its token
// remains in the Authorization header and is never included in results.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchWithoutLeak, jsonWithoutLeak } from './safe-http';

export interface WebScrobblerOptions {
  origin: string;
  token: string;
  listenedAtSeconds: number;
  fetchImpl?: typeof fetch;
}

export interface WebScrobblerResult {
  nowPlaying: unknown;
  batch: unknown;
  ignoredArtist: string;
}

interface TrackMetadata {
  artist_name: string;
  track_name: string;
  additional_info: {
    submission_client: 'Web Scrobbler';
    submission_client_version: '3.15.0';
    music_service_name: 'YouTube Music';
    origin_url: string;
    release_artist_name?: string;
    duration_ms: number;
  };
  release_name: string;
}

function metadata(artistName: string, trackName: string): TrackMetadata {
  return {
    artist_name: artistName,
    track_name: trackName,
    additional_info: {
      submission_client: 'Web Scrobbler',
      submission_client_version: '3.15.0',
      music_service_name: 'YouTube Music',
      origin_url: 'https://music.youtube.com/watch?v=abcdefghijk',
      release_artist_name: 'Sigur Rós',
      duration_ms: 268_000,
    },
    release_name: 'Takk...',
  };
}

function nowPlayingMetadata(): TrackMetadata {
  return {
    artist_name: 'Sigur Rós',
    track_name: 'Glósóli',
    additional_info: {
      submission_client: 'Web Scrobbler',
      submission_client_version: '3.15.0',
      music_service_name: 'YouTube Music',
      origin_url: 'https://music.youtube.com/watch?v=lmnopqrstuv',
      duration_ms: 375_000,
    },
    release_name: 'Takk...',
  };
}

async function post(send: typeof fetch, endpoint: URL, token: string, body: string): Promise<unknown> {
  const response = await fetchWithoutLeak(
    send,
    endpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Token ${token}`,
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'Web Scrobbler/3.15.0',
      },
      body,
    },
    'Web Scrobbler ListenBrainz',
  );
  if (!response.ok) throw new Error(`Web Scrobbler ListenBrainz returned HTTP ${response.status}`);
  const result = await jsonWithoutLeak(response, 'Web Scrobbler ListenBrainz');
  if (result === null || typeof result !== 'object' || (result as { status?: unknown }).status !== 'ok')
    throw new Error('Web Scrobbler ListenBrainz returned an invalid response');
  return result;
}

/** Send an actual Web Scrobbler now-playing request and a mixed import batch. */
export async function runWebScrobbler(options: WebScrobblerOptions): Promise<WebScrobblerResult> {
  if (!options.token) throw new TypeError('Web Scrobbler ListenBrainz token must not be empty');
  if (!Number.isSafeInteger(options.listenedAtSeconds) || options.listenedAtSeconds <= 0)
    throw new RangeError('Web Scrobbler listenedAtSeconds must be a positive integer');
  const endpoint = new URL('/1/submit-listens', options.origin);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new TypeError('Web Scrobbler origin must be HTTP(S)');
  const send = options.fetchImpl ?? fetch;
  const nowPlaying = await post(
    send,
    endpoint,
    options.token,
    JSON.stringify({ listen_type: 'playing_now', payload: [{ track_metadata: nowPlayingMetadata() }] }),
  );
  const ignoredArtist = 'A'.repeat(257);
  const batch = await post(
    send,
    endpoint,
    options.token,
    JSON.stringify({
      listen_type: 'import',
      payload: [
        { listened_at: options.listenedAtSeconds, track_metadata: metadata('Sigur Rós', 'Hoppípolla') },
        { listened_at: options.listenedAtSeconds - 30, track_metadata: metadata(ignoredArtist, 'Too Long Artist') },
        { listened_at: options.listenedAtSeconds - 60, track_metadata: metadata('Sigur Rós', 'Starálfur') },
      ],
    }),
  );
  return { nowPlaying, batch, ignoredArtist };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.env.ATMUSIC_E2E_ORIGIN;
  const token = process.env.ATMUSIC_E2E_WEB_SCROBBLER_TOKEN;
  if (!origin || !token) {
    console.error('Web Scrobbler replay requires ATMUSIC_E2E_ORIGIN and ATMUSIC_E2E_WEB_SCROBBLER_TOKEN');
    process.exitCode = 2;
  } else {
    runWebScrobbler({ origin, token, listenedAtSeconds: 1_768_474_800 }).catch(() => {
      console.error('Web Scrobbler replay failed');
      process.exitCode = 1;
    });
  }
}
