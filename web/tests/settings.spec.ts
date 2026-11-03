import { account, authorizeOnFixtureAs, type E2eAccount, readNetwork } from '../../scripts/e2e/dev-env';
import { expect, test } from './fixtures';

let carol: E2eAccount;

test.beforeAll(() => {
  carol = account(readNetwork(), 'carol');
});

test('settings routes use the server session, show secrets once, and make Last.fm denial the safe default', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/signin');
  await page.getByLabel('Your handle').fill(carol.handle);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await authorizeOnFixtureAs(page, carol);
  await page.waitForURL((url) => url.pathname === '/feed');

  await page.goto('/settings/links');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connected services');
  await expect(page.getByLabel('ListenBrainz user token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Last.fm' })).toBeVisible();

  await page.goto('/settings/imports');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import listening history');
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Import activity' })).toBeVisible();

  await page.goto('/settings/credentials');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Credentials');
  const label = `e2e-${Date.now()}`;
  await page.getByLabel('Label', { exact: true }).first().fill(label);
  await page.getByRole('button', { name: 'Create app password' }).click();
  await expect(page.getByRole('heading', { name: 'Save this secret now' })).toBeVisible();
  const secret = await page.getByRole('textbox', { name: 'App password' }).inputValue();
  expect(secret.length).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Feed', exact: true }).click();
  await page.goto('/settings/credentials');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Credentials');
  await expect(page.getByRole('heading', { name: 'Save this secret now' })).toHaveCount(0);
  await expect(page.getByText(label)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(label)).toHaveCount(0);

  await page.goto('/lastfm/authorize?api_key=unissued-test-key&cb=https%3A%2F%2Fclient.example%2Fcallback');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Authorize Last.fm application');
  await expect(page.getByText('Unverified application')).toBeVisible();
  await expect(page.locator('dd strong').last()).toHaveText('client.example');
  await expect(page.getByRole('button', { name: 'Deny' })).toBeFocused();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('status')).toHaveText('Authorization denied. This application was not given access.');
});
