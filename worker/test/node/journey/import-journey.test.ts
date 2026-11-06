// The import journey (ADR 0005 §5.8, §11, B14, B18; N4-01): the whole
// production process in-process (journey/world.ts: run() with the production
// features, every fake upstream, the memoryLink Jetstream echoing the fake
// PDS's commits, the frozen clock and manual timers).
//
// A user imports a Last.fm history through the Last.fm API (fake Last.fm,
// paged backwards at the shared 1 rps pace) and then uploads a ListenBrainz
// export ZIP that overlaps it. Every unique listen becomes exactly one PDS
// record: the import writes at import priority inside the account's PDS
// point budget (50 % of the 5,000-point hour), so the job only finishes once
// the clock has moved past the first window. Closing the database and
// recomposing the process mid-journey changes none of that.

import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../../src/outbox/budget';
import { checkResponse } from '../../acceptance/support/openapi';
import type { LastfmListen } from '../support/fake-lastfm';
import { closeWorlds, HOUR_MS, SCROBBLE, type Signed, startWorld, T0, type User, type World } from './world';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

const T0_S = T0 / 1000;
const LASTFM_COUNT = 1050;
const OVERLAP = 100;
const LB_NEW = 50;
const UNIQUE = LASTFM_COUNT + LB_NEW;
/** The import share of the hour window (accounts.import_share_pct default 50 %). */
const IMPORT_HOUR_POINTS = DEFAULT_LIMITS.hour / 2;

/** The Last.fm history: 1,050 distinct listens, newest first, one every 4 minutes. */
function lastfmHistory(): LastfmListen[] {
  return Array.from({ length: LASTFM_COUNT }, (_, i) => ({
    artist: `Artist ${i % 37}`,
    track: `Track ${i}`,
    album: `Album ${i % 11}`,
    uts: T0_S - 3600 - i * 240,
  }));
}

/** A ListenBrainz export: OVERLAP listens equal to Last.fm ones, then LB_NEW new ones (older than all of them). */
function listenbrainzZip(history: readonly LastfmListen[]): Uint8Array {
  const lines: string[] = [];
  for (const l of history.slice(0, OVERLAP)) {
    lines.push(
      JSON.stringify({
        listened_at: l.uts,
        track_metadata: { artist_name: l.artist, track_name: l.track, release_name: l.album },
      }),
    );
  }
  const oldest = (history[history.length - 1] as LastfmListen).uts;
  for (let i = 0; i < LB_NEW; i++) {
    lines.push(
      JSON.stringify({
        listened_at: oldest - 600 - i * 600,
        track_metadata: { artist_name: 'LB Only', track_name: `Old ${i}`, release_name: 'Archive' },
      }),
    );
  }
  const enc = new TextEncoder();
  return zipSync({
    'listens/2025/12.jsonl': enc.encode(`${lines.join('\n')}\n`),
    'user.json': enc.encode('{"user_id": 7, "user_name": "alice_lb"}'),
  });
}

interface Budget {
  maxHourPoints: number;
}

/** Pumps (extension lane) until the job is done, advancing a minute a round; tracks the hour window. */
async function untilDone(
  w: World,
  id: string,
  budget: Budget,
  o: { maxRounds?: number; stopWhen?: () => boolean } = {},
) {
  return w.until(
    () => {
      const hour = w.db.one<{ points: number }>("SELECT points FROM pds_budget WHERE window = 'hour'")?.points ?? 0;
      budget.maxHourPoints = Math.max(budget.maxHourPoints, hour);
      if (o.stopWhen?.() === true) return true;
      return w.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', id)?.state === 'done';
    },
    { core: false, stepMs: 60_000, maxRounds: o.maxRounds ?? 200 },
  );
}

async function startImport(w: World, session: Signed): Promise<string> {
  const res = await w.send('POST', '/api/v1/imports', {
    as: session,
    body: { source: 'lastfm', username: 'alice_fm' },
  });
  expect(res.status).toBe(202);
  expect(checkResponse('POST', '/api/v1/imports', res)).toBe('valid');
  expect(res.body).toMatchObject({ source: 'lastfm_api', remoteUser: 'alice_fm', state: 'waiting_index' });
  return (res.body as { id: string }).id;
}

async function upload(w: World, session: Signed, zip: Uint8Array): Promise<string> {
  const res = await w.send('POST', '/api/v1/imports/upload?source=listenbrainz_zip', {
    as: session,
    body: zip,
    headers: { 'content-type': 'application/zip' },
  });
  expect(res.status, res.text).toBe(202);
  expect(res.body).toMatchObject({ source: 'listenbrainz_zip', state: 'waiting_index' });
  return (res.body as { id: string }).id;
}

/** Exactly one PDS record and one succeeded operation per unique listen, and nothing else. */
async function expectEachListenOnce(w: World, user: User, history: readonly LastfmListen[]): Promise<void> {
  const records = await user.repo.list(SCROBBLE);
  const keys = records.map((r) => {
    const v = r.value as { artist: string; track: string; listenedAt: string };
    return `${v.artist}|${v.track}|${Date.parse(v.listenedAt) / 1000}`;
  });
  expect(new Set(keys).size).toBe(keys.length);
  const expected = new Set(history.map((l) => `${l.artist}|${l.track}|${l.uts}`));
  for (let i = 0; i < LB_NEW; i++) {
    expected.add(`LB Only|Old ${i}|${(history[history.length - 1] as LastfmListen).uts - 600 - i * 600}`);
  }
  expect(keys.length).toBe(UNIQUE);
  expect(new Set(keys)).toEqual(expected);
  expect(w.count('operations', "kind = 'scrobble.create'")).toBe(UNIQUE);
  expect(w.count('operations', "kind = 'scrobble.create' AND state = 'succeeded' AND origin = 'import'")).toBe(UNIQUE);
  expect(w.count('listen_keys', 'did = ?', user.did)).toBe(UNIQUE);
  // The PDS never had to refuse a write: the outbox stayed inside the budget.
  expect(w.pds.calls.count({ status: 429 })).toBe(0);
}

async function bothImports(w: World, alice: User, restartMidway: boolean): Promise<void> {
  const history = lastfmHistory();
  w.lastfm.seedHistory('alice_fm', history);
  const session = await w.signIn(alice);
  const budget: Budget = { maxHourPoints: 0 };

  const lastfmJob = await startImport(w, session);
  if (restartMidway) {
    // Down while fetching: two pages are staged, the rest is still upstream.
    await untilDone(w, lastfmJob, budget, {
      stopWhen: () =>
        (w.db.one<{ fetched: number }>('SELECT fetched FROM import_jobs WHERE id = ?', lastfmJob)?.fetched ?? 0) >= 400,
    });
    const fetching = w.db.one<{ state: string; fetched: number }>(
      'SELECT state, fetched FROM import_jobs WHERE id = ?',
      lastfmJob,
    );
    expect(fetching?.state).toBe('fetching');
    expect(fetching?.fetched).toBeLessThan(LASTFM_COUNT);
    await w.restart();
    // Down while writing: some records are on the PDS, the rest is queued behind the budget.
    await untilDone(w, lastfmJob, budget, {
      stopWhen: () => {
        const n = w.count('operations', "kind = 'scrobble.create' AND state = 'succeeded'");
        return n > 0 && n < LASTFM_COUNT;
      },
    });
    expect(w.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', lastfmJob)?.state).toBe('writing');
    const written = (await alice.repo.list(SCROBBLE)).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(LASTFM_COUNT);
    await w.restart();
  }
  const started = w.clock.nowMs();
  await untilDone(w, lastfmJob, budget);
  // 1,050 creates are 3,150 points, more than the import share of one hour window: done only after it ended.
  expect(w.clock.nowMs() - started).toBeGreaterThanOrEqual(restartMidway ? 0 : HOUR_MS - 120_000);
  const lastfmDto = await w.send('GET', `/api/v1/imports/${lastfmJob}`, { as: session });
  expect(lastfmDto.status).toBe(200);
  expect(checkResponse('GET', `/api/v1/imports/${lastfmJob}`, lastfmDto)).toBe('valid');
  expect(lastfmDto.body).toMatchObject({
    state: 'done',
    fetched: LASTFM_COUNT,
    staged: LASTFM_COUNT,
    written: LASTFM_COUNT,
  });
  // Paged backwards through user.getRecentTracks at 200 a page.
  expect(w.lastfm.calls.count({ nsid: 'user.getRecentTracks', status: 200 })).toBeGreaterThanOrEqual(6);

  const lbJob = await upload(w, session, listenbrainzZip(history));
  if (restartMidway) {
    await untilDone(w, lbJob, budget, {
      stopWhen: () =>
        (w.db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', lbJob)?.state ?? '') === 'writing',
    });
    expect((await alice.repo.list(SCROBBLE)).length).toBe(LASTFM_COUNT);
    await w.restart();
  }
  await untilDone(w, lbJob, budget);
  const lbDto = await w.send('GET', `/api/v1/imports/${lbJob}`, { as: session });
  expect(lbDto.body).toMatchObject({ state: 'done', fetched: OVERLAP + LB_NEW, duplicates: OVERLAP, written: LB_NEW });

  expect(budget.maxHourPoints).toBeGreaterThan(0);
  expect(budget.maxHourPoints).toBeLessThanOrEqual(IMPORT_HOUR_POINTS);
  await expectEachListenOnce(w, alice, history);
}

describe('import journey', () => {
  it('a Last.fm API import of 1,050 listens and an overlapping ListenBrainz ZIP write each unique listen once within the budget and reach done after advancing the clock', async () => {
    const { w, alice } = await startWorld();
    await bothImports(w, alice, false);
  }, 120_000);

  it('closing and reopening the database and recomposing the app mid-journey loses and duplicates nothing', async () => {
    const { w, alice } = await startWorld();
    await bothImports(w, alice, true);
  }, 120_000);

  it('meta.capabilities lists writes, lastfm, listenbrainz, imports and forwarding with the Last.fm key, and omits forwarding without it', async () => {
    const BASE = ['read', 'stats', 'follows', 'notify', 'indexing', 'publication'];
    const withKey = await startWorld();
    const meta = await withKey.w.send('GET', '/api/v1/meta');
    expect(meta.status).toBe(200);
    expect(checkResponse('GET', '/api/v1/meta', meta)).toBe('valid');
    expect(meta.body).toMatchObject({
      stage: 'product',
      capabilities: [...BASE, 'writes', 'lastfm', 'listenbrainz', 'imports', 'forwarding'],
      lexiconPrefix: 'org.example.music',
    });
    const signed = await withKey.w.signIn(withKey.alice);
    const account = await withKey.w.send('GET', '/api/v1/account', { as: signed });
    expect(account.status).toBe(200);
    expect((account.body as { capabilities: string[] }).capabilities).toEqual([
      'writes',
      'lastfm',
      'listenbrainz',
      'imports',
      'forwarding',
    ]);
    await withKey.w.close();

    const without = await startWorld({ lastfmKey: false });
    const bare = await without.w.send('GET', '/api/v1/meta');
    expect(bare.status).toBe(200);
    expect(checkResponse('GET', '/api/v1/meta', bare)).toBe('valid');
    expect(bare.body).toMatchObject({
      stage: 'product',
      capabilities: [...BASE, 'writes', 'lastfm', 'listenbrainz', 'imports'],
    });
    // And what the capability stands for: no Last.fm API import and no Last.fm link without the key.
    const session = await without.w.signIn(without.alice);
    const refused = await without.w.send('POST', '/api/v1/imports', {
      as: session,
      body: { source: 'lastfm', username: 'alice_fm' },
    });
    expect(refused.status).toBe(503);
    expect((refused.body as { error: { code: string } }).error.code).toBe('lastfm_not_configured');
    const link = await without.w.send('POST', '/api/v1/links/lastfm/start', { as: session });
    expect(link.status).toBe(503);
    expect(without.w.count('import_jobs')).toBe(0);
  }, 60_000);
});
