import { describe, expect, it, vi } from 'vitest';
import { mount, SESSION } from './support';

describe('web/test/routes/settings.test.tsx', () => {
  it('shows server session identity and the public export link without a local browser outbox', async () => {
    const app = mount('/settings');
    app.state.session.value = SESSION;
    await vi.waitFor(() => expect(app.root.querySelector('a.export-link')).not.toBeNull());
    expect(app.root.textContent).toContain(SESSION.did);
    expect(app.root.querySelector('a.export-link')?.getAttribute('href')).toContain(
      `/api/v1/users/${SESSION.did}/export`,
    );
    app.cleanup();
  });
});
