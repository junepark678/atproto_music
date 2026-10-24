// The browser MVP journey and the Static Assets routing rules (W6-03;
// M3.4.1 lifecycle, M7.4.2 browser_journey, M6.1.1 asset_missing_traversal /
// spa_deep_link / asset_cache, M7.1.3 route_deep_links).
//
// Runs against scripts/e2e/start-stack.ts (playwright.config.ts webServer):
// the production Worker and SPA under `wrangler dev`, and @atproto/dev-env
// with alice on pds1.test and bob (one seeded scrobble) on pds2.test. Each
// step asserts what the browser shows, what the Worker's API answers (status
// and the api/openapi.yaml schema) and what the PDS holds.
//
// The stack runs on wall time (the dev-env PDS checks DPoP proofs and token
// lifetimes against it), so record times are derived from the run's start
// instead of the frozen fixture clock, and every wait is a bounded poll on an
// observable state, never a sleep.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type APIRequestContext, type APIResponse, expect, type Locator, type Page, test } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  account,
  authorizeOnDevPds,
  type E2eAccount,
  type E2eNetwork,
  pdsListRecords,
  readNetwork,
} from '../../scripts/e2e/dev-env';

// ---------------------------------------------------------------------------
// API schema (the same AJV setup as worker/test/composition/support.ts)

const openapi = JSON.parse(readFileSync(new URL('../../api/openapi.yaml', import.meta.url), 'utf8')) as {
  components: unknown;
};
const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);
ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
ajv.addSchema({ $id: 'openapi', components: openapi.components });

function schemaErrors(name: string, value: unknown): string {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return (validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors);
}

interface ApiResult<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/** GET a Worker API path; a 200 body must match `schema`, any other status the Error envelope. */
async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  path: string,
  schema: string,
): Promise<ApiResult<T>> {
  const res = await request.get(path);
  const body = (await res.json()) as T;
  expect(schemaErrors(res.status() === 200 ? schema : 'Error', body), `${path} schema`).toBe('valid');
  return { status: res.status(), headers: res.headers(), body };
}

// ---------------------------------------------------------------------------
// Shapes the journey reads

interface Scrobble {
  uri: string;
  cid: string;
  did: string;
  artist: string;
  track: string;
  album?: string;
  listenedAt: string;
}
interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}
interface Profile {
  did: string;
  handle: string | null;
  totalScrobbles: number;
  followerCount: number;
  followingCount: number;
}
interface Statistics {
  window: string;
  totalScrobbles: number;
  distinctArtists: number;
  distinctTracks: number;
  topArtists: Array<{ artist: string; scrobbleCount: number }>;
}
interface RecordStatus {
  uri: string;
  state: string;
  cid?: string;
  indexing: { state: string };
}
interface Follow {
  uri: string;
  subject: string;
}

const enc = encodeURIComponent;

/** The UTC second `ms` falls in, as the scrobble form takes it. */
function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let net: E2eNetwork;
let alice: E2eAccount;
let bob: E2eAccount;
let prefix: string;

test.beforeAll(async ({ request }) => {
  net = readNetwork();
  alice = account(net, 'alice');
  bob = account(net, 'bob');
  prefix = net.prefix;
  // Bob is known to the index before the journey: notify {did}, then his
  // snapshot (one verified scrobble) makes his profile public.
  const notify = await request.post('/api/v1/notify', { data: { did: bob.did } });
  expect(notify.status()).toBe(202);
  expect(schemaErrors('NotifyAccepted', await notify.json())).toBe('valid');
  await expect
    .poll(async () => (await api<Profile>(request, `/api/v1/users/${enc(bob.did)}/profile`, 'Profile')).body, {
      timeout: 60_000,
    })
    .toMatchObject({ did: bob.did, handle: bob.handle, totalScrobbles: 1 });
});

// ---------------------------------------------------------------------------
// Browser helpers

function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary' });
}

function heading(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

/** Fills and submits the scrobble form; returns the submission's list item. */
async function publishScrobble(
  page: Page,
  fields: { artist: string; track: string; album: string; listenedAt: string },
): Promise<Locator> {
  await page.getByLabel('Artist').fill(fields.artist);
  await page.getByLabel('Track').fill(fields.track);
  await page.getByLabel('Album (optional)').fill(fields.album);
  await page.getByLabel('Listened at (UTC)').fill(fields.listenedAt);
  await page.getByRole('button', { name: 'Publish scrobble' }).click();
  return page.locator('li[data-op-id]').filter({ hasText: fields.track });
}

async function uriList(list: Locator): Promise<string[]> {
  return list.locator(':scope > li').evaluateAll((items) => items.map((li) => li.getAttribute('data-uri') ?? ''));
}

/** The SPA's index.html (not merely a text that mentions its mount point, as the bundle does). */
function isSpaHtml(body: string): boolean {
  return /^\s*<!doctype html>/i.test(body) && body.includes('<div id="app"></div>');
}

/**
 * The Worker's JSON 404 envelope (crates/server/tests/assets.rs): status 404,
 * application/json, error code not_found, requestId equal to x-request-id,
 * and never the SPA's index.html.
 */
async function expectNotFoundEnvelope(res: APIResponse, label: string): Promise<void> {
  const body = await res.text();
  expect(isSpaHtml(body), label).toBe(false);
  expect(res.status(), label).toBe(404);
  expect(res.headers()['content-type'] ?? '', label).toContain('application/json');
  const json = JSON.parse(body) as { error?: { code?: string; requestId?: string } };
  expect(schemaErrors('Error', json), label).toBe('valid');
  expect(json.error?.code, label).toBe('not_found');
  expect(json.error?.requestId, label).toBe(res.headers()['x-request-id']);
}

const followRkey = (subject: string) => `f${createHash('sha256').update(subject).digest('hex')}`;

// ---------------------------------------------------------------------------

test('full journey sign-in → scrobble indexed → stats → follow/unfollow → delete → export → disconnect/reconnect → sign-out', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const startMs = Date.now();
  const scrobbleCollection = `${prefix}.scrobble`;
  const followCollection = `${prefix}.follow`;
  const settingsCollection = `${prefix}.settings`;

  // 1. Sign in with the loopback client: our /signin → the PDS's own
  //    password and consent pages → /oauth/callback (the SPA) → /feed.
  await test.step('sign in with the loopback OAuth client', async () => {
    const callback = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/oauth/callback' && r.request().isNavigationRequest(),
    );
    await page.goto('/signin');
    await expect(heading(page)).toHaveText('Sign in');
    await page.getByLabel('Your handle').fill(alice.handle);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await authorizeOnDevPds(page, alice);
    const cb = await callback;
    expect(cb.status()).toBe(200);
    expect(cb.headers()['content-type']).toContain('text/html');
    expect(cb.headers()['x-request-id']).toBeUndefined(); // Static Assets answered, not the Worker
    await page.waitForURL((u) => u.pathname === '/feed');
    expect(new URL(page.url()).search).toBe(''); // code, state and iss are gone
    await expect(nav(page).getByRole('link', { name: 'My profile' })).toHaveAttribute('href', `/u/${alice.did}`);
    await expect(nav(page).getByRole('link', { name: 'Add scrobble' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.locator('.session-identity .did')).toHaveText(alice.did);
    // The callback's notify {did} admitted alice: a snapshot of her empty
    // repository makes her an indexed account with no scrobbles.
    await expect
      .poll(async () => (await api<Profile>(request, `/api/v1/users/${enc(alice.did)}/profile`, 'Profile')).body, {
        timeout: 60_000,
      })
      .toMatchObject({ did: alice.did, handle: alice.handle, totalScrobbles: 0, followingCount: 0 });
    expect(await pdsListRecords(alice, scrobbleCollection)).toEqual([]);
  });

  // 2. Two scrobbles through the form; each is shown as indexed only once
  //    the Worker verified it.
  const joga = { artist: 'Björk', track: 'Jóga', album: 'Homogenic', listenedAt: isoSeconds(startMs - HOUR) };
  const airbag = {
    artist: 'Radiohead',
    track: 'Airbag',
    album: 'OK Computer',
    listenedAt: isoSeconds(startMs - 10 * DAY),
  };
  let jogaUri = '';
  let airbagUri = '';
  await test.step('submit scrobbles and see them indexed', async () => {
    await nav(page).getByRole('link', { name: 'Add scrobble' }).click();
    await expect(heading(page)).toHaveText('Add a scrobble');
    for (const fields of [joga, airbag]) {
      const item = await publishScrobble(page, fields);
      const status = item.locator('.op-status');
      await expect(status).toHaveAttribute('data-op-state', 'indexed', { timeout: 60_000 });
      await expect(status).toHaveText('Indexed: visible in your public history');
    }
    const records = await pdsListRecords(alice, scrobbleCollection);
    expect(records).toHaveLength(2);
    const byTrack = new Map(records.map((r) => [r.value.track, r]));
    const jogaRecord = byTrack.get('Jóga');
    const airbagRecord = byTrack.get('Airbag');
    expect(jogaRecord?.value).toMatchObject({ $type: scrobbleCollection, artist: 'Björk', album: 'Homogenic' });
    expect(airbagRecord?.value).toMatchObject({ $type: scrobbleCollection, artist: 'Radiohead' });
    jogaUri = jogaRecord?.uri ?? '';
    airbagUri = airbagRecord?.uri ?? '';
    for (const record of [jogaRecord, airbagRecord]) {
      const status = await api<RecordStatus>(
        request,
        `/api/v1/records/status?uri=${enc(record?.uri ?? '')}`,
        'RecordStatus',
      );
      expect(status.status).toBe(200);
      expect(status.headers['cache-control']).toBe('no-store');
      expect(status.body).toMatchObject({ uri: record?.uri, state: 'indexed', cid: record?.cid });
    }
    const history = await api<Paged<Scrobble>>(request, `/api/v1/users/${enc(alice.did)}/scrobbles`, 'ScrobblePage');
    expect(history.body.items.map((s) => [s.uri, s.cid, s.track, s.listenedAt.slice(0, 19)])).toEqual([
      [jogaUri, jogaRecord?.cid, 'Jóga', joga.listenedAt.slice(0, 19)],
      [airbagUri, airbagRecord?.cid, 'Airbag', airbag.listenedAt.slice(0, 19)],
    ]);
    expect(history.body.nextCursor).toBeNull();
  });

  // 3. Feed, profile, history and every statistics window.
  await test.step('browse the feed, profile, history and stats windows', async () => {
    await nav(page).getByRole('link', { name: 'Feed' }).click();
    await expect(heading(page)).toHaveText('Feed');
    await expect(page.getByRole('tab', { name: 'Global' })).toHaveAttribute('aria-selected', 'true');
    const recent = page.getByRole('list', { name: 'Recent scrobbles' });
    await expect(recent.locator(`li[data-uri="${jogaUri}"]`)).toContainText('Jóga by Björk from Homogenic');
    // Server order (listenedAt desc): bob's seed (a minute before the stack
    // started), then Jóga (an hour before the run), then Airbag (10 days).
    const globalUris = (await uriList(recent)).filter((u) => [net.seeded.bobScrobble, jogaUri, airbagUri].includes(u));
    expect(globalUris).toEqual([net.seeded.bobScrobble, jogaUri, airbagUri]);
    const globalApi = await api<Paged<Scrobble>>(request, '/api/v1/feed?scope=global&limit=100', 'ScrobblePage');
    expect(globalApi.body.items.map((s) => s.uri).filter((u) => globalUris.includes(u))).toEqual(globalUris);

    await page.getByRole('tab', { name: 'Following' }).click();
    await expect(page.locator('#feed-panel [data-state="empty"]')).toHaveText(
      'No scrobbles from the accounts you follow yet.',
    );

    await nav(page).getByRole('link', { name: 'My profile' }).click();
    await expect(heading(page)).toHaveText(`@${alice.handle}`);
    await expect(page.locator('[data-count="scrobbles"]')).toHaveText('2');
    await expect(page.locator('[data-count="following"]')).toHaveText('0');
    await expect(page.locator('[data-count="followers"]')).toHaveText('0');
    const history = page.getByRole('list', { name: 'Listening history' });
    await expect.poll(() => uriList(history)).toEqual([jogaUri, airbagUri]);

    const expected: Record<string, { label: string; totals: [number, number, number]; top: string }> = {
      all: { label: 'All time', totals: [2, 2, 2], top: 'Björk' },
      '7d': { label: 'Last 7 days', totals: [1, 1, 1], top: 'Björk' },
      '30d': { label: 'Last 30 days', totals: [2, 2, 2], top: 'Björk' },
      '365d': { label: 'Last 365 days', totals: [2, 2, 2], top: 'Björk' },
    };
    for (const [window, want] of Object.entries(expected)) {
      const tab = page.getByRole('tab', { name: want.label });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const body = page.locator(`.stats-body[data-window="${window}"]`);
      await expect(body.locator('[data-total="scrobbles"]')).toHaveText(String(want.totals[0]));
      await expect(body.locator('[data-total="artists"]')).toHaveText(String(want.totals[1]));
      await expect(body.locator('[data-total="tracks"]')).toHaveText(String(want.totals[2]));
      const stats = await api<Statistics>(
        request,
        `/api/v1/users/${enc(alice.did)}/stats?window=${window}`,
        'Statistics',
      );
      expect([stats.body.totalScrobbles, stats.body.distinctArtists, stats.body.distinctTracks]).toEqual(want.totals);
      await expect(body.locator('.top-artists .artist')).toHaveText(stats.body.topArtists.map((a) => a.artist));
      expect(stats.body.topArtists.map((a) => a.artist)).toContain(want.top);
    }
  });

  // 4. Follow and unfollow bob from his profile.
  await test.step('follow and unfollow the second account', async () => {
    const before = (await api<Profile>(request, `/api/v1/users/${enc(bob.did)}/profile`, 'Profile')).body;
    await nav(page).getByRole('link', { name: 'Feed' }).click();
    await page.getByRole('tab', { name: 'Global' }).click();
    await page
      .getByRole('list', { name: 'Recent scrobbles' })
      .locator(`li[data-uri="${net.seeded.bobScrobble}"] a.actor`)
      .click();
    await expect(heading(page)).toHaveText(`@${bob.handle}`);
    const status = page.locator('.follow-status');
    await expect(status).toHaveText('Not following');
    await page.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(status).toHaveText('Following (confirmed)', { timeout: 60_000 });
    await expect(page.locator('[data-count="followers"]')).toHaveText(String(before.followerCount + 1));

    const follows = await pdsListRecords(alice, followCollection);
    expect(follows.map((f) => [f.uri, f.value.subject])).toEqual([
      [`at://${alice.did}/${followCollection}/${followRkey(bob.did)}`, bob.did],
    ]);
    const following = await api<Paged<Follow>>(request, `/api/v1/users/${enc(alice.did)}/following`, 'FollowPage');
    expect(following.body.items.map((f) => [f.uri, f.subject])).toEqual([[follows[0]?.uri, bob.did]]);
    expect((await api<Profile>(request, `/api/v1/users/${enc(bob.did)}/profile`, 'Profile')).body.followerCount).toBe(
      before.followerCount + 1,
    );
    const followingFeed = await api<Paged<Scrobble>>(
      request,
      `/api/v1/feed?scope=following&viewer=${enc(alice.did)}`,
      'ScrobblePage',
    );
    expect(followingFeed.body.items.map((s) => s.uri)).toEqual([net.seeded.bobScrobble]);

    await nav(page).getByRole('link', { name: 'Feed' }).click();
    await page.getByRole('tab', { name: 'Following' }).click();
    const followed = page.getByRole('list', { name: 'Scrobbles from accounts you follow' });
    await expect.poll(() => uriList(followed)).toEqual([net.seeded.bobScrobble]);

    await followed.locator(`li[data-uri="${net.seeded.bobScrobble}"] a.actor`).click();
    await expect(heading(page)).toHaveText(`@${bob.handle}`);
    await expect(status).toHaveText(/^Following( \(confirmed\))?$/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Unfollow' }).click();
    await expect(status).toHaveText('Not following (unfollow confirmed)', { timeout: 60_000 });
    expect(await pdsListRecords(alice, followCollection)).toEqual([]);
    expect(
      (await api<Paged<Follow>>(request, `/api/v1/users/${enc(alice.did)}/following`, 'FollowPage')).body.items,
    ).toEqual([]);
    expect((await api<Profile>(request, `/api/v1/users/${enc(bob.did)}/profile`, 'Profile')).body.followerCount).toBe(
      before.followerCount,
    );
    expect(
      (await api<Paged<Scrobble>>(request, `/api/v1/feed?scope=following&viewer=${enc(alice.did)}`, 'ScrobblePage'))
        .body.items,
    ).toEqual([]);
  });

  // 5. Delete Jóga from the history.
  await test.step('delete the scrobble and see it absent', async () => {
    await nav(page).getByRole('link', { name: 'My profile' }).click();
    await expect(heading(page)).toHaveText(`@${alice.handle}`);
    const history = page.getByRole('list', { name: 'Listening history' });
    await expect.poll(() => uriList(history)).toEqual([jogaUri, airbagUri]);
    await history.getByRole('button', { name: 'Delete “Jóga” by Björk' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    // The owner's view hides it at once (outbox overlay) …
    await expect.poll(() => uriList(history)).toEqual([airbagUri]);
    // … and the index drops it once the signed absence is verified.
    await expect
      .poll(
        async () =>
          (await api<RecordStatus>(request, `/api/v1/records/status?uri=${enc(jogaUri)}`, 'RecordStatus')).body.state,
        { timeout: 60_000 },
      )
      .toBe('absent');
    expect((await pdsListRecords(alice, scrobbleCollection)).map((r) => r.uri)).toEqual([airbagUri]);
    const after = await api<Paged<Scrobble>>(request, `/api/v1/users/${enc(alice.did)}/scrobbles`, 'ScrobblePage');
    expect(after.body.items.map((s) => s.uri)).toEqual([airbagUri]);
    const lookup = await request.get(`/api/v1/scrobbles/${enc(jogaUri)}`);
    expect(lookup.status()).toBe(404);
    await page.reload();
    await expect(page.locator('[data-count="scrobbles"]')).toHaveText('1');
    await expect.poll(() => uriList(page.getByRole('list', { name: 'Listening history' }))).toEqual([airbagUri]);
  });

  // 6. Export from Settings: a download of the public export attachment.
  await test.step('export', async () => {
    await nav(page).getByRole('link', { name: 'Settings' }).click();
    await expect(heading(page)).toHaveText('Settings');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download your data (music-export.json)' }).first().click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('music-export.json');
    const path = await download.path();
    const exported = JSON.parse(readFileSync(path, 'utf8')) as {
      did: string;
      scrobbles: Scrobble[];
      follows: Follow[];
    };
    expect(schemaErrors('Export', exported)).toBe('valid');
    expect(exported.did).toBe(alice.did);
    expect(exported.scrobbles.map((s) => [s.uri, s.track])).toEqual([[airbagUri, 'Airbag']]);
    expect(exported.follows).toEqual([]);
    const res = await request.get(`/api/v1/users/${enc(alice.did)}/export`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  // 7. Disconnect (signed opt-out record), then reconnect.
  const settingsUri = `at://${alice.did}/${settingsCollection}/self`;
  await test.step('disconnect, then reconnect', async () => {
    await expect(page.locator('[data-indexing="enabled"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Disconnect…' }).click();
    const confirm = page.locator('fieldset[data-confirm="disconnect"]');
    await expect(confirm.getByRole('link', { name: 'Download your data (music-export.json)' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm disconnect' }).click();
    const op = page.locator('.settings-op .op-status');
    await expect(page.locator('[data-indexing="disabled"]')).toBeVisible({ timeout: 60_000 });
    await expect(op).toHaveAttribute('data-op-state', 'indexed');
    expect((await pdsListRecords(alice, settingsCollection)).map((r) => [r.uri, r.value.indexing])).toEqual([
      [settingsUri, 'disabled'],
    ]);
    const suppressed = await api<RecordStatus>(
      request,
      `/api/v1/records/status?uri=${enc(settingsUri)}`,
      'RecordStatus',
    );
    expect(suppressed.body.indexing.state).toBe('suppressed');
    expect((await api(request, `/api/v1/users/${enc(alice.did)}/profile`, 'Profile')).status).toBe(404);
    // Only the suppression marker is kept: no history, no export, no feed items.
    const hidden = await api<Paged<Scrobble>>(request, `/api/v1/users/${enc(alice.did)}/scrobbles`, 'ScrobblePage');
    expect([hidden.status, hidden.body.items]).toEqual([200, []]);
    expect((await api(request, `/api/v1/users/${enc(alice.did)}/export`, 'Export')).status).toBe(404);
    const globalFeed = await api<Paged<Scrobble>>(request, '/api/v1/feed?scope=global&limit=100', 'ScrobblePage');
    expect(globalFeed.body.items.filter((s) => s.did === alice.did)).toEqual([]);

    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(page.locator('[data-indexing="enabled"]')).toBeVisible({ timeout: 60_000 });
    await expect(op).toHaveAttribute('data-op-state', 'indexed');
    expect((await pdsListRecords(alice, settingsCollection)).map((r) => [r.uri, r.value.indexing])).toEqual([
      [settingsUri, 'enabled'],
    ]);
    // A fresh verified snapshot brings the account and its one remaining scrobble back.
    await expect
      .poll(async () => (await api<Profile>(request, `/api/v1/users/${enc(alice.did)}/profile`, 'Profile')).body, {
        timeout: 60_000,
      })
      .toMatchObject({ did: alice.did, totalScrobbles: 1 });
    const history = await api<Paged<Scrobble>>(request, `/api/v1/users/${enc(alice.did)}/scrobbles`, 'ScrobblePage');
    expect(history.body.items.map((s) => s.uri)).toEqual([airbagUri]);
  });

  // 8. Sign out: the session and every IndexedDB store are gone, and a reload stays anonymous.
  await test.step('sign out', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('[data-state="signed-out"]')).toBeVisible({ timeout: 30_000 });
    await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'My profile' })).toHaveCount(0);
    const stores = await page.evaluate(async () => {
      const counts: Record<string, number> = {};
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(info.name as string);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        for (const name of Array.from(db.objectStoreNames)) {
          counts[`${info.name}/${name}`] = await new Promise<number>((resolve, reject) => {
            const count = db.transaction(name).objectStore(name).count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => reject(count.error);
          });
        }
        db.close();
      }
      return counts;
    });
    expect(Object.keys(stores).length).toBeGreaterThan(0);
    expect(Object.entries(stores).filter(([, n]) => n !== 0)).toEqual([]);
    await page.reload();
    await expect(heading(page)).toHaveText('Settings');
    await expect(page.locator('[data-state="signin-required"]')).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  });
});

test('OAuth callback navigation is served by SPA (/oauth/callback not intercepted by Worker)', async ({
  page,
  request,
}) => {
  // A Worker response always carries x-request-id; the API proves it.
  const meta = await request.get('/api/v1/meta');
  expect(meta.status()).toBe(200);
  expect(meta.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

  const res = await request.get('/oauth/callback?code=cod-x&state=st-x&iss=https%3A%2F%2Fpds1.test', {
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  expect(res.headers()['x-request-id']).toBeUndefined();
  expect(res.headers()['cache-control']).not.toContain('immutable');
  const html = await res.text();
  expect(html).toContain('<div id="app"></div>');
  expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);

  // The SPA itself handles the route: without a pending sign-in it says so.
  await page.goto('/oauth/callback');
  await expect(heading(page)).toHaveText('Signing in');
  await expect(page.getByText('There is no sign-in in progress.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).last()).toHaveAttribute('href', '/signin');
});

test('GET /u/<did> and /feed serve index.html 200 and POST /feed never returns SPA HTML', async ({ page, request }) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  const indexHtml = await index.text();
  expect(indexHtml).toContain('<div id="app"></div>');

  const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
  // Redirects are never followed here: each status is what the platform sends.
  // The canonical (per-segment percent-encoded) deep links are served directly.
  const canonicalProfile = `/u/${enc(bob.did)}`;
  for (const path of [canonicalProfile, '/feed']) {
    const res = await request.get(path, { headers: navigate, maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toContain('text/html');
    expect(res.headers()['x-request-id'], path).toBeUndefined();
    expect(await res.text(), path).toBe(indexHtml);
  }
  // The raw DID form (`:` unencoded, as the SPA's own links emit it) is served
  // index.html 200 directly as well, with its query string; no redirect
  // (crates/server/tests/assets.rs spa_deep_link, M6.1.1/spa_deep_link,
  // M7.1.3/route_deep_links). No platform amendment to these cases exists.
  for (const search of ['', '?tab=history']) {
    const path = `/u/${bob.did}${search}`;
    const raw = await request.get(path, { headers: navigate, maxRedirects: 0 });
    expect(raw.status(), path).toBe(200);
    expect(raw.headers().location, path).toBeUndefined();
    expect(raw.headers()['content-type'], path).toContain('text/html');
    expect(await raw.text(), path).toBe(indexHtml);
  }

  // The deep links render their screens in the browser, at the URL navigated to.
  for (const path of [canonicalProfile, `/u/${bob.did}`]) {
    await page.goto(path);
    expect(new URL(page.url()).pathname, path).toBe(path);
    await expect(heading(page)).toHaveText(`@${bob.handle}`);
    await expect(page.locator('.profile-did code')).toHaveText(bob.did);
  }
  await page.goto('/feed');
  await expect(heading(page)).toHaveText('Feed');
  await expect(page.getByRole('tab', { name: 'Global' })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/no-such-page');
  await expect(heading(page)).toHaveText('Page not found');

  // A non-GET to an SPA path is the JSON 404 envelope (oracle spa_deep_link:
  // POST /feed → 404 not_found), never a bare 405 and never index.html.
  for (const path of ['/feed', canonicalProfile, `/u/${bob.did}`]) {
    const post = await request.post(path, { data: { x: 1 }, maxRedirects: 0 });
    await expectNotFoundEnvelope(post, `POST ${path}`);
  }
});

test('non-navigation GET /assets/missing.js and encoded ../ traversal return 404, never index.html', async ({
  request,
}) => {
  const subresource = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script', accept: '*/*' };
  // The Rust oracle's traversal inputs (crates/server/tests/assets.rs asset_missing_traversal).
  for (const path of [
    '/assets/missing.js',
    '/%2e%2e/secret',
    '/assets/%2E%2E/secret',
    '/assets%2f..%2fsecret',
    '/assets/%252e%252e/secret',
  ]) {
    const res = await request.get(path, { headers: subresource, maxRedirects: 0 });
    await expectNotFoundEnvelope(res, path);
  }
  // Unknown API paths are the Worker's JSON 404 envelope.
  await expectNotFoundEnvelope(await request.get('/api/unknown'), '/api/unknown');
});

test('hashed /assets/*.js returns 200 with a JavaScript content type and immutable Cache-Control', async ({
  request,
}) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  expect(index.headers()['cache-control']).toBe('no-cache');
  const html = await index.text();
  const scripts = [...html.matchAll(/src="(\/assets\/[\w.-]+-[\w-]{8,}\.js)"/g)].map((m) => m[1] as string);
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    const res = await request.get(src, { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' } });
    expect(res.status(), src).toBe(200);
    expect(res.headers()['content-type'], src).toMatch(/^(text|application)\/javascript\b/);
    expect(res.headers()['cache-control'], src).toBe('public, max-age=31536000, immutable');
    expect(isSpaHtml(await res.text()), src).toBe(false);
  }
  // The SPA fallback is never cached immutably.
  const fallback = await request.get('/feed', { headers: { 'sec-fetch-mode': 'navigate' } });
  expect(fallback.headers()['cache-control']).not.toContain('immutable');
});
