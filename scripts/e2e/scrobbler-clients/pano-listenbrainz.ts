// Byte-faithful Pano ListenBrainz protocol client used by the N8 acceptance
// replay. The issued token stays in process and is never printed.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PanoListenBrainzOptions {
  origin: string;
  token: string;
  listenedAtSeconds: number;
  artist: string;
  track: string;
  release?: string;
  durationSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface PanoListenBrainzResult {
  nowPlaying: unknown;
  single: unknown;
}

function endpointFor(origin: string): URL {
  const endpoint = new URL('/1/submit-listens', origin);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new TypeError('Pano ListenBrainz origin must be HTTP(S)');
  return endpoint;
}

function metadata(options: PanoListenBrainzOptions) {
  return {
    artist_name: options.artist,
    track_name: options.track,
    ...(options.release === undefined ? {} : { release_name: options.release }),
    additional_info: {
      submission_client: 'Pano Scrobbler',
      submission_client_version: '3.6',
      ...(options.durationSeconds === undefined ? {} : { duration: options.durationSeconds }),
    },
  };
}

async function submit(
  send: typeof fetch,
  endpoint: URL,
  token: string,
  listenType: 'playing_now' | 'single',
  listen: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(endpoint);
  if (listenType === 'playing_now') url.searchParams.set('return_msid', '1');
  const response = await send(url, {
    method: 'POST',
    headers: {
      authorization: `token ${token}`,
      'content-type': 'application/json',
      'user-agent': 'Pano Scrobbler/3.6 (Android)',
    },
    body: JSON.stringify({ listen_type: listenType, payload: [listen] }),
  });
  if (!response.ok) throw new Error(`Pano ListenBrainz ${listenType} returned HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  if (body === null || typeof body !== 'object' || (body as { status?: unknown }).status !== 'ok')
    throw new Error(`Pano ListenBrainz ${listenType} returned an invalid response`);
  return body;
}

/** Send Pano's now-playing and single-listen submissions with its lowercase token scheme. */
export async function runPanoListenBrainz(options: PanoListenBrainzOptions): Promise<PanoListenBrainzResult> {
  if (!options.token) throw new TypeError('Pano ListenBrainz token must not be empty');
  if (!Number.isSafeInteger(options.listenedAtSeconds) || options.listenedAtSeconds <= 0)
    throw new RangeError('Pano listenedAtSeconds must be a positive integer');
  if (
    options.durationSeconds !== undefined &&
    (!Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 0)
  )
    throw new RangeError('Pano durationSeconds must be a non-negative integer');
  const endpoint = endpointFor(options.origin);
  const send = options.fetchImpl ?? fetch;
  const trackMetadata = metadata(options);
  const nowPlaying = await submit(send, endpoint, options.token, 'playing_now', {
    track_metadata: trackMetadata,
  });
  const single = await submit(send, endpoint, options.token, 'single', {
    listened_at: options.listenedAtSeconds,
    track_metadata: trackMetadata,
  });
  return { nowPlaying, single };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.env.ATMUSIC_E2E_ORIGIN;
  const token = process.env.ATMUSIC_E2E_PANO_LISTENBRAINZ_TOKEN;
  if (!origin || !token) {
    console.error('Pano ListenBrainz replay requires ATMUSIC_E2E_ORIGIN and ATMUSIC_E2E_PANO_LISTENBRAINZ_TOKEN');
    process.exitCode = 2;
  } else {
    runPanoListenBrainz({
      origin,
      token,
      listenedAtSeconds: 1_768_474_800,
      artist: 'Test Artist',
      track: 'Test Track',
      durationSeconds: 215,
    }).catch(() => {
      console.error('Pano ListenBrainz replay failed');
      process.exitCode = 1;
    });
  }
}
