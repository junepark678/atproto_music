// Small, best-effort MusicBrainz HTTP client. Every request is issued through
// the caller's BoundPolicyFetch so production retains its pinned transport.
import type { BoundPolicyFetch } from '../node/policy-fetch';

export const MB_CAPS = Object.freeze({ maxRequestBytes: 0, maxResponseBytes: 1_048_576 });

export type MusicBrainzOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'status'; status: number; retryAfterMs?: number }
  | { kind: 'network' }
  | { kind: 'malformed' };

export interface MusicBrainzClientOptions {
  fetch: BoundPolicyFetch;
  apiRoot: string;
  version: string;
  nowMs?: () => number;
}

export interface RecordingSearch {
  artist: string;
  recording: string;
  release?: string;
  limit?: number;
}

export interface RecordingSearchResponse {
  recordings: unknown[];
  count?: number;
  offset?: number;
}

/** Escape Lucene query syntax before embedding user submitted terms. */
export function escapeLucene(value: string): string {
  return value
    .replace(/([+\-!(){}[\]^"~*?:\\/])/g, '\\$1')
    .replace(/&&/g, '\\&&')
    .replace(/\|\|/g, '\\||');
}

export function createMusicBrainzClient(options: MusicBrainzClientOptions) {
  const root = options.apiRoot.endsWith('/') ? options.apiRoot : `${options.apiRoot}/`;
  const userAgent = `atmusic/${options.version} ( https://github.com/junepark678/atproto_music )`;

  async function get<T>(
    path: string,
    params: URLSearchParams,
    valid: (value: unknown) => value is T,
  ): Promise<MusicBrainzOutcome<T>> {
    params.set('fmt', 'json');
    const url = new URL(path, root);
    url.search = params.toString();
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': userAgent },
      });
    } catch {
      return { kind: 'network' };
    }
    if (response.status === 404) return { kind: 'not_found' };
    if (!response.ok) {
      const raw = response.headers.get('retry-after');
      const seconds = raw !== null && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null;
      const date = raw === null || seconds !== null ? Number.NaN : Date.parse(raw);
      const retryAfterMs =
        seconds !== null
          ? Math.min(seconds * 1000, 86_400_000)
          : Number.isFinite(date)
            ? Math.min(Math.max(0, date - (options.nowMs?.() ?? Date.now())), 86_400_000)
            : undefined;
      return { kind: 'status', status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    }
    try {
      const value: unknown = await response.json();
      return valid(value) ? { kind: 'ok', value } : { kind: 'malformed' };
    } catch {
      return { kind: 'malformed' };
    }
  }

  return {
    lookupRecording(mbid: string): Promise<MusicBrainzOutcome<Record<string, unknown>>> {
      return get(
        `recording/${encodeURIComponent(mbid)}`,
        new URLSearchParams({ inc: 'artists+releases+release-groups+isrcs' }),
        (value): value is Record<string, unknown> =>
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).id === 'string',
      );
    },
    searchRecordings(input: RecordingSearch): Promise<MusicBrainzOutcome<RecordingSearchResponse>> {
      const clauses = [`recording:"${escapeLucene(input.recording)}"`, `artist:"${escapeLucene(input.artist)}"`];
      if (input.release) clauses.push(`release:"${escapeLucene(input.release)}"`);
      return get(
        'recording',
        new URLSearchParams({ query: clauses.join(' AND '), limit: String(input.limit ?? 5) }),
        (value): value is RecordingSearchResponse =>
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Array.isArray((value as Record<string, unknown>).recordings),
      );
    },
  };
}
