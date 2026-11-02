import { describe, expect, it, vi } from 'vitest';
import { example, mount, META } from './support';

describe('web/test/routes/feed.test.tsx', () => {
  it('loads the public feed through the same-origin read client without a browser PDS session', async () => {
    const app = mount('/feed');
    await vi.waitFor(() => expect(app.root.querySelector('ol.scrobble-list')).not.toBeNull());
    expect(app.requests).toContain('/api/v1/feed?scope=global');
    expect(app.root.textContent).toContain('Jóga');
    app.cleanup();
  });

  it('renders items and loads the next page via the opaque nextCursor', async () => {
    const requests: string[] = [];
    const first = example<{ items: Array<Record<string, unknown>>; nextCursor: string | null; asOf: string; indexing: unknown }>('scrobble-page');
    const second = { ...first.items[0]!, uri: 'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/com.example.atmusic.scrobble/r02', track: 'Second Track' };
    const app = mount('/feed', async (input) => {
      const url = new URL(String(input), 'https://music.test'); requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/v1/meta') return Response.json(META);
      if (url.pathname === '/api/v1/feed' && url.searchParams.has('cursor')) return Response.json({ ...first, items: [second], nextCursor: null });
      if (url.pathname === '/api/v1/feed') return Response.json({ ...first, nextCursor: 'opaque-cursor' });
      return undefined;
    });
    await vi.waitFor(() => expect(app.root.querySelector('button.load-more')).not.toBeNull());
    app.root.querySelector<HTMLButtonElement>('button.load-more')!.click();
    await vi.waitFor(() => expect(app.root.textContent).toContain('Second Track'));
    expect(requests.some((request) => request.includes('cursor=opaque-cursor'))).toBe(true);
    app.cleanup();
  });

  it('an anonymous user selecting following sees a sign-in prompt and sends no following request', async () => {
    const app = mount('/feed?scope=following');
    await vi.waitFor(() => expect(app.root.textContent).toContain('Sign in to see scrobbles from the accounts you follow'));
    expect(app.requests.some((request) => request.includes('scope=following'))).toBe(false);
    app.cleanup();
  });

  it('page two 503 keeps page one and retry appends page two once', async () => {
    let pageTwo = 0;
    const first = example<{ items: Array<Record<string, unknown>>; nextCursor: string | null; asOf: string; indexing: unknown }>('scrobble-page');
    const second = { ...first.items[0]!, uri: 'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/com.example.atmusic.scrobble/r02', track: 'Recovered Track' };
    const app = mount('/feed', async (input) => {
      const url = new URL(String(input), 'https://music.test');
      if (url.pathname !== '/api/v1/feed') return undefined;
      if (!url.searchParams.has('cursor')) return Response.json({ ...first, nextCursor: 'retry-cursor' });
      pageTwo++;
      if (pageTwo === 1) return Response.json({ error: { code: 'not_ready', message: 'temporarily unavailable', requestId: '00000000-0000-4000-8000-000000000001' } }, { status: 503 });
      return Response.json({ ...first, items: [second], nextCursor: null });
    });
    await vi.waitFor(() => expect(app.root.querySelector('button.load-more')).not.toBeNull());
    app.root.querySelector<HTMLButtonElement>('button.load-more')!.click();
    await vi.waitFor(() => expect(app.root.textContent).toContain('More scrobbles could not be loaded'));
    expect(app.root.textContent).toContain('Jóga');
    const retry = [...app.root.querySelectorAll('button')].find((button) => button.textContent?.includes('Try again'));
    retry?.click();
    await vi.waitFor(() => expect(app.root.textContent).toContain('Recovered Track'));
    expect(app.root.textContent).toContain('Jóga');
    app.cleanup();
  });
});
