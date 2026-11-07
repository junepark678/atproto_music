// Owner rule: a DID is never shown to the user outside of URLs. These routes
// render with fixture DIDs; no visible text or accessible-name attribute may
// contain one (hrefs and other URL attributes are allowed).
import { describe, expect, it, vi } from 'vitest';
import { DID, example, mount, SESSION } from './support';

const NAME_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'alt', 'placeholder', 'value'];

function assertNoDid(root: HTMLElement): void {
  expect(root.textContent ?? '').not.toMatch(/did:(plc|web):/);
  for (const element of root.querySelectorAll('*')) {
    for (const name of NAME_ATTRIBUTES) {
      expect(element.getAttribute(name) ?? '', `${element.tagName}[${name}]`).not.toMatch(/did:(plc|web):/);
    }
  }
}

const notFound = () =>
  Response.json(
    { error: { code: 'not_found', message: 'not found', requestId: '00000000-0000-4000-8000-000000000001' } },
    { status: 404 },
  );

describe('web/test/routes/no-dids.test.tsx', () => {
  it('feed, profile, not-found profile and settings never render a DID as visible text or an accessible name', async () => {
    const feed = mount('/feed');
    feed.state.session.value = SESSION;
    await vi.waitFor(() => expect(feed.root.querySelector('a.actor')).not.toBeNull());
    assertNoDid(feed.root);
    feed.cleanup();

    const profile = example<Record<string, unknown>>('profile');
    const unverified = mount(`/u/${DID}`, async (input) => {
      if (new URL(String(input), 'https://music.test').pathname.endsWith('/profile'))
        return Response.json({ ...profile, handle: null });
      return undefined;
    });
    await vi.waitFor(() => expect(unverified.root.querySelector('.profile-header')).not.toBeNull());
    expect(unverified.root.querySelector('h1')?.textContent).toBe('Unknown account');
    assertNoDid(unverified.root);
    unverified.cleanup();

    for (const signedIn of [false, true]) {
      const missing = mount(`/u/${DID}`, async (input) =>
        new URL(String(input), 'https://music.test').pathname.endsWith('/profile') ? notFound() : undefined,
      );
      if (signedIn) missing.state.session.value = SESSION;
      await vi.waitFor(() => expect(missing.root.textContent).toContain('Profile not found'));
      assertNoDid(missing.root);
      missing.cleanup();
    }

    const settings = mount('/settings');
    settings.state.session.value = SESSION;
    await vi.waitFor(() => expect(settings.root.querySelector('a.export-link')).not.toBeNull());
    assertNoDid(settings.root);
    settings.cleanup();
  });
});
