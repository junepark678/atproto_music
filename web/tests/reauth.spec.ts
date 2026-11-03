import { account, authorizeOnFixtureAs, readNetwork } from '../../scripts/e2e/dev-env';
import { expect, test } from './fixtures';

test('same-account OAuth reauthentication in a popup preserves the scrobble draft across the callback redirect', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const alice = account(readNetwork(), 'alice');
  let refusedWrite = false;
  await page.route('**/api/v1/scrobbles', async (route) => {
    if (!refusedWrite && route.request().method() === 'POST') {
      refusedWrite = true;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'session_expired', message: 'session expired' } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/signin');
  await page.getByLabel('Your handle').fill(alice.handle);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await authorizeOnFixtureAs(page, alice);
  await page.waitForURL((url) => url.pathname === '/feed');

  await page.goto('/scrobble');
  await page.getByLabel('Artist').fill('Draft Artist');
  await page.getByLabel('Track').fill('Draft Track');
  await page.getByLabel('Listened at (UTC)').fill(`${new Date(Date.now() - 60_000).toISOString().slice(0, 19)}Z`);
  await page.getByRole('button', { name: 'Publish scrobble' }).click();
  await expect(page.getByRole('alert')).toContainText('Your session has ended');
  await expect(page.locator('input[name="artist"]')).toHaveCount(0);

  await page.getByRole('link', { name: 'Sign in again' }).click();
  await page.getByLabel('Your handle').fill(alice.handle);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const popup = await popupPromise;
  await expect(page.locator('.session-identity .did')).toHaveText(alice.did, { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Return to your saved scrobble draft' })).toBeVisible();
  await expect.poll(() => popup.isClosed(), { timeout: 30_000 }).toBe(true);
  await page.getByRole('link', { name: 'Return to your saved scrobble draft' }).click();
  await expect(page.locator('input[name="artist"]')).toHaveValue('Draft Artist');
  await expect(page.locator('input[name="track"]')).toHaveValue('Draft Track');
  expect(refusedWrite).toBe(true);
  expect(
    await page.evaluate(() =>
      Array.from({ length: sessionStorage.length }, (_, index) =>
        sessionStorage.getItem(sessionStorage.key(index) ?? ''),
      ).join('\n'),
    ),
  ).not.toContain('Draft Artist');
});
