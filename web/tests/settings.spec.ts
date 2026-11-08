import { account, authorizeOnFixtureAs, type E2eAccount, readNetwork } from '../../scripts/e2e/dev-env';
import { E2E_LISTENBRAINZ_TOKEN, E2E_LISTENBRAINZ_USER } from '../../scripts/e2e/fixture-world';
import { expect, test } from './fixtures';

let carol: E2eAccount;

test.beforeAll(() => {
  carol = account(readNetwork(), 'carol');
});

test('creating an app password, linking ListenBrainz with a fake token, and starting a ListenBrainz import with visible progress', async ({
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
  await page.getByLabel('ListenBrainz user token').fill(E2E_LISTENBRAINZ_TOKEN);
  await page.getByRole('button', { name: 'Connect ListenBrainz' }).click();
  await expect(page.getByRole('status')).toHaveText('ListenBrainz connected.');
  await expect(page.locator('.link-status-pill')).toHaveText('Active');
  await expect(page.getByRole('button', { name: 'Disconnect ListenBrainz' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Send scrobbles and loves' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Send now playing' })).toBeChecked();
  const pullListenBrainz = page.getByRole('checkbox', { name: 'Bring in new scrobbles from ListenBrainz' });
  await expect(pullListenBrainz).toBeChecked();
  await pullListenBrainz.uncheck();
  await expect(pullListenBrainz).not.toBeChecked();

  await page.goto('/settings/imports');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import listening history');
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Import activity' })).toBeVisible();
  await page.getByLabel('Service').selectOption('listenbrainz');
  await page.getByLabel('Username').fill(E2E_LISTENBRAINZ_USER);
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByRole('progressbar', { name: /listenbrainz api import: .* progress/i })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(/waiting_index|Estimated time remaining:/);

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
