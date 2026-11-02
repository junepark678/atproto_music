import type { Did } from '@atmusic/core/api-types';
import { render } from 'preact';
import { ApiClient } from '../../src/api/client';
import { App } from '../../src/app';
import type { Session } from '../../src/session/client';
import { createAppState } from '../../src/state/store';

const examples = import.meta.glob<unknown>('../../../api/examples/*.json', { eager: true, import: 'default' });
export function example<T>(name: string): T {
  const value = examples[`../../../api/examples/${name}.json`];
  if (value === undefined) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(value) as T;
}
export const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as Did;
export const SESSION: Session = {
  did: DID,
  handle: 'alice.test',
  username: 'alice',
  csrfToken: 'csrf-token',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00Z',
};
export const META = {
  name: 'atproto_music',
  version: '0.1.0',
  stage: 'product',
  capabilities: ['read', 'stats', 'follows', 'indexing'],
  lexiconPrefix: 'com.example.atmusic',
  indexing: { state: 'current', caughtUp: true, lastIndexedAt: null, lagSeconds: 0 },
};
export function mount(path: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://music.test${path}`);
  const requests: string[] = [];
  const api = new ApiClient({
    fetch: async (input) => {
      const url = new URL(input, 'https://music.test');
      requests.push(`${url.pathname}${url.search}`);
      const p = url.pathname;
      if (p === '/api/v1/meta') return Response.json(META);
      if (p === '/api/v1/feed' || p.endsWith('/scrobbles')) return Response.json(example('scrobble-page'));
      if (p.endsWith('/profile')) return Response.json(example('profile'));
      if (p.endsWith('/stats')) return Response.json(example('stats'));
      if (p.endsWith('/following') || p.endsWith('/followers')) return Response.json(example('follow-page'));
      if (p.endsWith('/export')) return Response.json(example('export'));
      return Response.json({ error: { code: 'not_found', message: 'not found', requestId: 'test' } }, { status: 404 });
    },
  });
  const state = createAppState({ api });
  const root = document.createElement('div');
  document.body.append(root);
  render(<App state={state} />, root);
  return {
    root,
    state,
    requests,
    cleanup: () => {
      render(null, root);
      root.remove();
    },
  };
}
