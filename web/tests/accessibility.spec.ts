// Accessibility of the SPA on the e2e stack (W6-03; M7.4.3 a11y_screens and
// keyboard_journey, M7.1.3 keyboard_shell).
//
// - axe-core (@axe-core/playwright) on every route, anonymous and signed in,
//   in the states a user meets (loaded data, empty lists, not-found, form
//   errors, the disconnect confirmation): no serious or critical violation.
// - Keyboard: Tab and Enter reach every navigation destination, and a
//   keyboard-only user signs in, submits a scrobble, switches statistics
//   windows, follows and unfollows, and signs out; every control reached has
//   a visible focus indicator (`:focus-visible` with an outline or shadow, on
//   screen).
//
// The signed-in user is carol (pds2.test, scripts/e2e/dev-env.ts), whom the
// MVP journey never uses; bob (pds2.test, one seeded scrobble) is the
// account she follows. Each test has its own browser context.

import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import {
  account,
  authorizeOnDevPds,
  type E2eAccount,
  type E2eNetwork,
  pdsListRecords,
  readNetwork,
} from '../../scripts/e2e/dev-env';

let net: E2eNetwork;
let bob: E2eAccount;
let carol: E2eAccount;

const enc = encodeURIComponent;

async function profileStatus(request: APIRequestContext, did: string): Promise<number> {
  return (await request.get(`/api/v1/users/${enc(did)}/profile`)).status();
}

test.beforeAll(async ({ request }) => {
  net = readNetwork();
  bob = account(net, 'bob');
  carol = account(net, 'carol');
  const notify = await request.post('/api/v1/notify', { data: { did: bob.did } });
  expect(notify.status()).toBe(202);
  await expect.poll(() => profileStatus(request, bob.did), { timeout: 60_000 }).toBe(200);
});

// ---------------------------------------------------------------------------
// Helpers

function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

/** The screen has rendered: its h1 is shown and no loading state is left. */
async function settled(page: Page, title: string | RegExp): Promise<void> {
  await expect(heading(page)).toHaveText(title);
  await expect(page.locator('[data-state="loading"]')).toHaveCount(0);
}

/** Serious and critical axe violations on the current page (WCAG 2.x A/AA rules). */
async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.passes.length).toBeGreaterThan(0); // axe really ran against the page
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function expectAccessible(page: Page, label: string): Promise<void> {
  expect(await seriousViolations(page), label).toEqual([]);
}

/** Mouse sign-in as `acct` through the dev-env PDS; lands on /feed. */
async function signIn(page: Page, request: APIRequestContext, acct: E2eAccount): Promise<void> {
  await page.goto('/signin');
  await page.getByLabel('Your handle').fill(acct.handle);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await authorizeOnDevPds(page, acct);
  await page.waitForURL((u) => u.pathname === '/feed');
  await expect(nav(page).getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => profileStatus(request, acct.did), { timeout: 60_000 }).toBe(200);
}

interface FocusState {
  tag: string;
  name: string;
  focusVisible: boolean;
  indicator: boolean;
  onScreen: boolean;
}

/** What the focused element looks like (null when nothing but the body has focus). */
async function focusState(page: Page): Promise<FocusState | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null || el === document.body) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
      focusVisible: el.matches(':focus-visible'),
      indicator:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== 'none',
      onScreen:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth,
    };
  });
}

async function expectVisibleFocus(page: Page, label: string): Promise<void> {
  const state = await focusState(page);
  expect(state, `${label}: something has focus`).not.toBeNull();
  expect(
    { focusVisible: state?.focusVisible, indicator: state?.indicator, onScreen: state?.onScreen },
    `${label}: visible focus on <${state?.tag}> "${state?.name}"`,
  ).toEqual({ focusVisible: true, indicator: true, onScreen: true });
}

/** Presses Tab until `target` has focus (at most `max` times), then checks the focus is visible. */
async function tabTo(page: Page, target: Locator, label: string, max = 80): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) {
      await expectVisibleFocus(page, label);
      return;
    }
  }
  throw new Error(`${label}: not reached with ${max} Tab presses`);
}

// ---------------------------------------------------------------------------

test('no serious/critical axe violations on all routes', async ({ page, request }) => {
  test.setTimeout(180_000);
  const unknownDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

  // Anonymous.
  const anonymous: Array<[string, string | RegExp]> = [
    ['/', 'Feed'],
    ['/feed', 'Feed'],
    ['/signin', 'Sign in'],
    ['/oauth/callback', 'Signing in'],
    [`/u/${bob.did}`, `@${bob.handle}`],
    [`/u/${unknownDid}`, 'Profile not found'],
    ['/u/not-a-did', 'Profile not found'],
    ['/scrobble', 'Add a scrobble'],
    ['/settings', 'Settings'],
    ['/no-such-page', 'Page not found'],
  ];
  for (const [path, title] of anonymous) {
    await page.goto(path);
    await settled(page, title);
    await expectAccessible(page, `anonymous ${path}`);
  }
  await page.goto('/feed');
  await page.getByRole('tab', { name: 'Following' }).click();
  await expect(page.locator('#feed-panel [data-state="signin-required"]')).toBeVisible();
  await expectAccessible(page, 'anonymous /feed following');

  // Signed in as carol.
  await signIn(page, request, carol);
  await settled(page, 'Feed');
  await expectAccessible(page, 'signed-in /feed');
  await page.getByRole('tab', { name: 'Following' }).click();
  await expect(page.locator('#feed-panel [data-state="empty"]')).toBeVisible();
  await expectAccessible(page, 'signed-in /feed following');

  await nav(page).getByRole('link', { name: 'My profile' }).click();
  await settled(page, `@${carol.handle}`);
  await expectAccessible(page, 'signed-in own profile');

  await page.goto(`/u/${bob.did}`);
  await settled(page, `@${bob.handle}`);
  await expect(page.locator('.follow-status')).toHaveText('Not following');
  await expectAccessible(page, 'signed-in /u/bob with follow control');
  for (const window of ['Last 7 days', 'Last 30 days', 'Last 365 days']) {
    await page.getByRole('tab', { name: window }).click();
    await expect(page.getByRole('tab', { name: window })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0);
  }
  await expectAccessible(page, 'signed-in /u/bob 365d window');

  await nav(page).getByRole('link', { name: 'Add scrobble' }).click();
  await settled(page, 'Add a scrobble');
  await expectAccessible(page, 'signed-in /scrobble');
  await page.getByLabel('Listened at (UTC)').fill('');
  await page.getByRole('button', { name: 'Publish scrobble' }).click();
  await expect(page.locator('[data-field-error]')).toHaveCount(3); // artist, track, listenedAt
  await expect(page.getByLabel('Artist')).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page, 'signed-in /scrobble with field errors');
  expect(await pdsListRecords(carol, `${net.prefix}.scrobble`)).toEqual([]); // nothing was sent

  await nav(page).getByRole('link', { name: 'Settings' }).click();
  await settled(page, 'Settings');
  await expect(page.locator('[data-indexing="enabled"]')).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'signed-in /settings');
  await page.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(page.locator('fieldset[data-confirm="disconnect"]')).toBeVisible();
  await expectAccessible(page, 'signed-in /settings disconnect confirmation');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/signin');
  await settled(page, 'Sign in');
  await expectAccessible(page, 'signed-in /signin');

  // Negative control: the same check does report a serious violation (a
  // button without an accessible name) when one is present.
  await page.evaluate(() => {
    const control = document.createElement('button');
    control.type = 'button';
    document.getElementById('main')?.append(control);
  });
  expect((await seriousViolations(page)).some((v) => v.startsWith('button-name (critical)'))).toBe(true);
});

test('Tab and Enter reach every navigation destination with visible focus', async ({ page, request }) => {
  test.setTimeout(180_000);
  // Skip link first: Enter moves focus to <main>.
  await page.goto('/feed');
  await settled(page, 'Feed');
  await page.keyboard.press('Tab');
  await expectVisibleFocus(page, 'skip link');
  expect((await focusState(page))?.name).toBe('Skip to main content');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');

  const visit = async (name: string, path: string, title: string | RegExp, state: string) => {
    await page.goto('/feed');
    await settled(page, 'Feed');
    const link = nav(page).getByRole('link', { name, exact: true });
    await tabTo(page, link, `${state} nav "${name}"`);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname === path);
    await settled(page, title);
    await expect(link).toHaveAttribute('aria-current', 'page');
    // After a client-side navigation focus starts at the new screen.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
  };

  // The brand link and the anonymous destinations.
  await page.goto('/signin');
  await settled(page, 'Sign in');
  await tabTo(page, page.getByRole('link', { name: 'atmusic' }), 'brand link');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === '/feed');
  await settled(page, 'Feed');
  await visit('Sign in', '/signin', 'Sign in', 'anonymous');
  await page.goto('/signin');
  await settled(page, 'Sign in');
  const feedLink = nav(page).getByRole('link', { name: 'Feed', exact: true });
  await tabTo(page, feedLink, 'anonymous nav "Feed"');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === '/feed');
  await settled(page, 'Feed');

  // Signed-in destinations.
  await signIn(page, request, carol);
  await visit('My profile', `/u/${carol.did}`, `@${carol.handle}`, 'signed-in');
  await visit('Add scrobble', '/scrobble', 'Add a scrobble', 'signed-in');
  await visit('Settings', '/settings', 'Settings', 'signed-in');
  await page.goto('/settings');
  await settled(page, 'Settings');
  await tabTo(page, nav(page).getByRole('link', { name: 'Feed', exact: true }), 'signed-in nav "Feed"');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === '/feed');
  await settled(page, 'Feed');
});

test('keyboard-only journey reaches sign-in, scrobble submit, window tabs, follow and sign-out with visible focus', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await page.goto('/feed');
  await settled(page, 'Feed');

  // Sign in.
  await tabTo(page, nav(page).getByRole('link', { name: 'Sign in' }), 'nav "Sign in"');
  await page.keyboard.press('Enter');
  await settled(page, 'Sign in');
  await tabTo(page, page.getByLabel('Your handle'), 'handle field');
  await page.keyboard.type(carol.handle);
  await tabTo(page, page.getByRole('button', { name: 'Sign in' }), 'sign-in button');
  await page.keyboard.press('Enter');
  await authorizeOnDevPds(page, carol, { keyboard: true });
  await page.waitForURL((u) => u.pathname === '/feed');
  await expect(nav(page).getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => profileStatus(request, carol.did), { timeout: 60_000 }).toBe(200);

  // Submit a scrobble.
  await tabTo(page, nav(page).getByRole('link', { name: 'Add scrobble' }), 'nav "Add scrobble"');
  await page.keyboard.press('Enter');
  await settled(page, 'Add a scrobble');
  await tabTo(page, page.getByLabel('Artist'), 'artist field');
  await page.keyboard.type('Kate Bush');
  await tabTo(page, page.getByLabel('Track'), 'track field');
  await page.keyboard.type('Cloudbusting');
  await tabTo(page, page.getByLabel('Album (optional)'), 'album field');
  await page.keyboard.type('Hounds of Love');
  await tabTo(page, page.getByRole('button', { name: 'Publish scrobble' }), 'publish button');
  await page.keyboard.press('Enter');
  const submitted = page.locator('li[data-op-id]').filter({ hasText: 'Cloudbusting' }).locator('.op-status');
  await expect(submitted).toHaveAttribute('data-op-state', 'indexed', { timeout: 60_000 });
  const records = await pdsListRecords(carol, `${net.prefix}.scrobble`);
  expect(records.map((r) => r.value.track)).toEqual(['Cloudbusting']);
  const history = await request.get(`/api/v1/users/${enc(carol.did)}/scrobbles`);
  expect(((await history.json()) as { items: Array<{ uri: string }> }).items.map((s) => s.uri)).toEqual([
    records[0]?.uri,
  ]);

  // Statistics windows: Tab into the tab list (roving tabindex), arrows between tabs.
  await tabTo(page, nav(page).getByRole('link', { name: 'My profile' }), 'nav "My profile"');
  await page.keyboard.press('Enter');
  await settled(page, `@${carol.handle}`);
  await tabTo(page, page.getByRole('tab', { name: 'All time' }), 'stats tab "All time"');
  for (const [label, window] of [
    ['Last 7 days', '7d'],
    ['Last 30 days', '30d'],
  ] as const) {
    await page.keyboard.press('ArrowRight');
    const tab = page.getByRole('tab', { name: label });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectVisibleFocus(page, `stats tab "${label}"`);
    await expect(page.locator(`.stats-body[data-window="${window}"] [data-total="scrobbles"]`)).toHaveText('1');
  }

  // Follow (and unfollow) bob, reached from the global feed.
  await tabTo(page, nav(page).getByRole('link', { name: 'Feed', exact: true }), 'nav "Feed"');
  await page.keyboard.press('Enter');
  await settled(page, 'Feed');
  await tabTo(
    page,
    page.getByRole('list', { name: 'Recent scrobbles' }).locator(`li[data-uri="${net.seeded.bobScrobble}"] a.actor`),
    "bob's profile link",
  );
  await page.keyboard.press('Enter');
  await settled(page, `@${bob.handle}`);
  await expect(page.locator('.follow-status')).toHaveText('Not following');
  await tabTo(page, page.getByRole('button', { name: 'Follow', exact: true }), 'follow button');
  await page.keyboard.press('Enter');
  await expect(page.locator('.follow-status')).toHaveText('Following (confirmed)', { timeout: 60_000 });
  const following = await request.get(`/api/v1/users/${enc(carol.did)}/following`);
  expect(((await following.json()) as { items: Array<{ subject: string }> }).items.map((f) => f.subject)).toEqual([
    bob.did,
  ]);
  await tabTo(page, page.getByRole('button', { name: 'Unfollow' }), 'unfollow button');
  await page.keyboard.press('Space');
  await expect(page.locator('.follow-status')).toHaveText('Not following (unfollow confirmed)', { timeout: 60_000 });
  expect(await pdsListRecords(carol, `${net.prefix}.follow`)).toEqual([]);

  // Sign out.
  await tabTo(page, nav(page).getByRole('link', { name: 'Settings' }), 'nav "Settings"');
  await page.keyboard.press('Enter');
  await settled(page, 'Settings');
  await tabTo(page, page.getByRole('button', { name: 'Sign out' }), 'sign-out button');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-state="signed-out"]')).toBeVisible({ timeout: 30_000 });
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Settings' })).toHaveCount(0);
});
