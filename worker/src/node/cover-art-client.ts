import { TransportError } from './pinned-transport';
import type { PolicyFetch } from './policy-fetch';

export const COVER_ART_MAX_BYTES = 512 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function permitted(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    url.port === '' &&
    (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org'))
  );
}

export interface CoverArtClientOptions {
  policyFetch: PolicyFetch;
  root: string;
}

/** Fetch front cover bytes through policyFetch; the returned bytes are never persisted here. */
export function createCoverArtClient({ policyFetch, root }: CoverArtClientOptions) {
  const rootUrl = new URL(root);
  if (
    rootUrl.protocol !== 'https:' ||
    rootUrl.username ||
    rootUrl.password ||
    rootUrl.port ||
    rootUrl.search ||
    rootUrl.hash ||
    !rootUrl.pathname.endsWith('/')
  ) {
    throw new TypeError('invalid Cover Art Archive root');
  }

  async function fetchFront(kind: 'release' | 'release-group', mbid: string): Promise<Uint8Array | null> {
    if (!MBID.test(mbid)) throw new TypeError('invalid MusicBrainz identifier');
    let url = new URL(`${kind}/${mbid}/front-250`, rootUrl);
    for (let redirects = 0; ; redirects++) {
      const response = await policyFetch(
        url,
        { headers: { accept: 'image/jpeg, image/png, image/webp' } },
        {
          caps: { maxRequestBytes: 0, maxResponseBytes: COVER_ART_MAX_BYTES },
          allowManualRedirectResponse: true,
        },
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        response.body?.cancel().catch(() => {});
        if (redirects >= 2 || !location)
          throw new TransportError('redirect', 'Cover Art Archive redirect refused', { reason: 'redirect_limit' });
        const next = new URL(location, url);
        if (!permitted(next))
          throw new TransportError('redirect', 'Cover Art Archive redirect refused', { reason: 'redirect_host' });
        url = next;
        continue;
      }
      if (response.status === 404) {
        response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        return null;
      }
      const type = response.headers.get('content-type')?.trim().toLowerCase();
      if (!type || !IMAGE_TYPES.has(type)) {
        response.body?.cancel().catch(() => {});
        throw new TypeError('unsupported cover art content type');
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > COVER_ART_MAX_BYTES) {
            await reader.cancel('too_large').catch(() => {});
            throw new TransportError('too_large', 'cover art exceeds 512 KiB', {
              reason: 'streamed',
              maxBytes: COVER_ART_MAX_BYTES,
            });
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
  }

  return async (releaseMbid: string, releaseGroupMbid?: string): Promise<Uint8Array | null> => {
    const image = await fetchFront('release', releaseMbid);
    if (image || !releaseGroupMbid) return image;
    return fetchFront('release-group', releaseGroupMbid);
  };
}
