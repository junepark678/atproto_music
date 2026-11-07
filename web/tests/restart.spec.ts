import { account, authorizeOnFixtureAs, pdsListRecords, readNetwork } from '../../scripts/e2e/dev-env';
import { expect, pauseNodePump, restartNode, test } from './fixtures';

test('a Node process restart mid-journey keeps the browser session cookie and indexed data, and new writes still index', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const network = readNetwork();
  const alice = account(network, 'alice');
  const collection = `${network.prefix}.scrobble`;

  await page.goto('/signin');
  await page.getByLabel('Your handle').fill(alice.handle);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await authorizeOnFixtureAs(page, alice);
  await expect(page).toHaveURL(/\/feed$/);
  await expect(page.locator('.session-identity')).toBeVisible();
  await expect(page.locator('.session-identity')).not.toContainText('did:');

  const sessionCookie = async () => {
    const cookie = (await context.cookies()).find((item) => item.name === '__Host-atmusic_session');
    expect(cookie, 'the server session cookie exists').toBeDefined();
    return cookie;
  };
  const beforeCookie = await sessionCookie();

  const submitScrobble = async (track: string, waitForIndex = true) => {
    await page.getByRole('link', { name: 'Add scrobble' }).click();
    await expect(page.getByRole('heading', { name: 'Add a scrobble' })).toBeVisible();
    const form = page.locator('form');
    await form.getByLabel('Artist').fill('Restart Fixture Artist');
    await form.getByLabel('Track').fill(track);
    await form.getByLabel('Album (optional)').fill('Persistent Session');
    await form
      .getByLabel('Listened at (UTC)')
      .fill(`${new Date(network.fixtureNowMs - 60_000).toISOString().slice(0, 19)}Z`);
    await page.getByRole('button', { name: 'Publish scrobble' }).click();
    const item = page.locator('li[data-op-id]').filter({ hasText: track });
    await expect(item.locator('.op-status')).toHaveAttribute('data-op-state', waitForIndex ? 'indexed' : 'queued', {
      timeout: 60_000,
    });
    return item;
  };

  await pauseNodePump();
  await submitScrobble('Before Restart', false);
  expect((await pdsListRecords(alice, collection)).some((record) => record.value.track === 'Before Restart')).toBe(
    false,
  );
  const restarted = await restartNode('SIGKILL');
  expect(restarted.generation).toBe(1);

  await page.goto('/feed');
  await expect(page.locator('.session-identity')).toBeVisible();
  await expect(page.locator('.session-identity')).not.toContainText('did:');
  const afterCookie = await sessionCookie();
  expect(afterCookie?.value).toBe(beforeCookie?.value);
  expect(afterCookie?.expires).toBe(beforeCookie?.expires);
  await page.goto(`/u/${encodeURIComponent(alice.did)}`);
  await expect
    .poll(async () =>
      (await pdsListRecords(alice, collection)).filter((record) => record.value.track === 'Before Restart'),
    )
    .toHaveLength(1);
  const beforeRecord = (await pdsListRecords(alice, collection)).find(
    (record) => record.value.track === 'Before Restart',
  );
  expect(beforeRecord).toBeDefined();
  await expect
    .poll(async () => {
      const status = await request.get(`/api/v1/records/status?uri=${encodeURIComponent(beforeRecord?.uri ?? '')}`);
      if (!status.ok()) return null;
      return ((await status.json()) as { state?: unknown }).state;
    })
    .toBe('indexed');
  await page.reload();
  await expect(page.locator(`li[data-uri="${beforeRecord?.uri}"]`)).toContainText('Before Restart');
  expect((await pdsListRecords(alice, collection)).some((record) => record.uri === beforeRecord?.uri)).toBe(true);

  await submitScrobble('After Restart');
  const records = await pdsListRecords(alice, collection);
  expect(records.filter((record) => ['Before Restart', 'After Restart'].includes(record.value.track))).toHaveLength(2);
  const status = await request.get(`/api/v1/records/status?uri=${encodeURIComponent(beforeRecord?.uri ?? '')}`);
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ uri: beforeRecord?.uri, state: 'indexed', cid: beforeRecord?.cid });
});
