// Byte-faithful Navidrome ListenBrainz submit used by the isolated N8 client
// check. The sample metadata and property order come from the committed capture.

export type NavidromeSubmitOutcome =
  | 'acknowledged'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'transport_error'
  | 'invalid_base_url';

const capturedListen = {
  listen_type: 'single',
  payload: [
    {
      listened_at: 1768478160,
      track_metadata: {
        artist_name: 'Daft Punk',
        track_name: 'Harder, Better, Faster, Stronger',
        release_name: 'Discovery',
        additional_info: {
          submission_client: 'Navidrome',
          submission_client_version: '0.58.0 (5d1f3e2)',
          tracknumber: 4,
          artist_names: ['Daft Punk'],
          artist_mbids: ['056e4f3e-d505-4dad-8ec1-d04f521cbb56'],
          recording_mbid: 'c3a1f2d4-5b6e-4f70-8a91-b2c3d4e5f607',
          release_mbid: '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b',
          release_group_mbid: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
          duration_ms: 224000,
        },
      },
    },
  ],
} as const;

function submitUrl(base: string): URL | null {
  try {
    const url = new URL(base);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.endsWith('/1/')
    ) {
      return null;
    }
    return new URL('submit-listens', url);
  } catch {
    return null;
  }
}

/** Submit the captured Navidrome-shaped listen to a configured ListenBrainz /1/ base. */
export async function submitNavidromeListen(baseUrl: string, token: string): Promise<NavidromeSubmitOutcome> {
  const url = submitUrl(baseUrl);
  if (url === null) return 'invalid_base_url';

  const body = JSON.stringify(capturedListen);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body,
      redirect: 'error',
    });

    if (response.status === 401) return 'unauthorized';
    if (response.status === 429) return 'rate_limited';
    if (response.status === 503) return 'unavailable';
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return 'rejected';
    }
    try {
      const result = (await response.json()) as { status?: unknown };
      // This is a protocol acknowledgement, not proof every listen was written:
      // ListenBrainz also answers status=ok when it records an ignored listen.
      return result !== null && typeof result === 'object' && result.status === 'ok' ? 'acknowledged' : 'rejected';
    } catch {
      return 'rejected';
    }
  } catch {
    // Do not expose the URL, request headers, token, or upstream error text.
    return 'transport_error';
  }
}
