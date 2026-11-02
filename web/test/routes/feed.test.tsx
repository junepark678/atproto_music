import { describe, expect, it, vi } from 'vitest';
import { mount } from './support';

describe('web/test/routes/feed.test.tsx', () => {
  it('loads the public feed through the same-origin read client without a browser PDS session', async () => {
    const app = mount('/feed');
    await vi.waitFor(() => expect(app.root.querySelector('ol.scrobble-list')).not.toBeNull());
    expect(app.requests).toContain('/api/v1/feed?scope=global');
    expect(app.root.textContent).toContain('Jóga');
    app.cleanup();
  });
});
