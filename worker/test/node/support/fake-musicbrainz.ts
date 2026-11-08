// In-memory MusicBrainz HTTP endpoint for Node tests. It only serves the
// reserved musicbrainz.test host through routerTransport.
import { CallLog, type Routable } from '@atmusic/atproto/test-support/router-transport';

export const MUSICBRAINZ_HOST = 'musicbrainz.test';

export class FakeMusicBrainz implements Routable {
  readonly calls = new CallLog();
  readonly requests: Array<{ path: string; params: URLSearchParams; headers: Headers }> = [];
  response: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: { recordings: [] } };
  onRequest?: (request: Request) => { status: number; body: unknown; headers?: Record<string, string> };

  fetch(request: Request): Response {
    const response: { status: number; body: unknown; headers?: Record<string, string> } = this.onRequest?.(request) ?? this.response;
    const url = new URL(request.url);
    this.calls.record({
      service: 'host',
      host: url.host,
      method: request.method,
      path: url.pathname,
      nsid: null,
      params: Object.fromEntries([...url.searchParams].map(([k, v]) => [k, [v]])),
      did: null,
      status: response.status,
      fault: null,
    });
    this.requests.push({ path: url.pathname, params: url.searchParams, headers: new Headers(request.headers) });
    const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(body, { status: response.status, headers: { 'content-type': 'application/json', ...response.headers } });
  }
}
