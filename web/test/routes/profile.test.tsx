import { describe, expect, it, vi } from 'vitest';
import { DID, mount } from './support';

describe('web/test/routes/profile.test.tsx', () => {
  it('renders the indexed profile and its reads from the Node AppView routes', async () => {
    const app = mount(`/u/${DID}`);
    await vi.waitFor(() => expect(app.root.querySelector('.profile-header')).not.toBeNull());
    expect(app.requests.some((path) => path.endsWith(`/api/v1/users/${DID}/profile`))).toBe(true);
    expect(app.root.querySelector('[data-count="scrobbles"]')).not.toBeNull();
    app.cleanup();
  });
});
