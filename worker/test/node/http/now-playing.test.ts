import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import { upsertNowPlaying } from '../../../src/do/read/now-playing';
import type { WebWritesServices } from '../../../src/http/operations';
import { writesFeature } from '../../../src/http/writes';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN } from '../support/app';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = Date.parse('2026-01-15T12:00:00Z');
afterEach(async () => closeApps());

describe('GET /api/v1/users/{did}/now-playing', () => {
  it('returns shared metadata and ISO times with no-store; owner shared=true, invalid DID is 422', async () => {
    let sessions: WebSessions | null = null;
    const app = await startApp({ clock: fixedClock(), features: [writesFeature({ sessions: (c) => (sessions = createWebSessions({ db: c.deps.db, clock: c.deps.clock, random: c.deps.random, revocations: new MemoryRevocations(c.deps.clock) })) })] });
    app.db.run("INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state) VALUES (?, 'alice.test', '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current')", ALICE);
    ensureAccount({ db: app.db, clock: app.clock }, { did: ALICE, verifiedHandle: 'alice.test' });
    const deps = app.composed.core.deps;
    upsertNowPlaying(deps, { did: ALICE, artist: 'Radiohead', track: 'Reckoner', album: 'In Rainbows', albumArtist: 'Radiohead', trackNumber: 8, durationSeconds: 290, recordingMbid: 'rec', releaseMbid: 'rel', releaseGroupMbid: 'grp', artistMbids: ['artist'], isrc: 'GBAYE', submissionClientVersion: '1.2', musicService: 'listenbrainz', mediaPlayer: 'web', source: 'listenbrainz', client: 'scrobbler' });
    const session = (sessions as unknown as WebSessions).create(ALICE);
    const request = async (path: string, cookie?: string) => app.fetch(path, { headers: cookie ? { cookie } : {} });
    const visitor = await request(`/api/v1/users/${ALICE}/now-playing`);
    expect(visitor.headers.get('cache-control')).toBe('no-store');
    expect(await visitor.json()).toMatchObject({ nowPlaying: { artist: 'Radiohead', track: 'Reckoner', album: 'In Rainbows', albumArtist: 'Radiohead', trackNumber: 8, durationSeconds: 290, recordingMbid: 'rec', releaseMbid: 'rel', releaseGroupMbid: 'grp', artistMbids: ['artist'], isrc: 'GBAYE', client: { name: 'scrobbler', version: '1.2' }, musicService: 'listenbrainz', mediaPlayer: 'web', source: 'listenbrainz' }, serverTime: '2026-01-15T12:00:00.000000000Z' });
    const owner = await request(`/api/v1/users/${ALICE}/now-playing`, `${SESSION_COOKIE}=${session.token}`);
    expect(await owner.json()).toMatchObject({ nowPlaying: { shared: true, startedAt: '2026-01-15T12:00:00.000000000Z', updatedAt: '2026-01-15T12:00:00.000000000Z', expiresAt: '2026-01-15T12:04:50.000000000Z' } });
    expect((await request('/api/v1/users/not-a-did/now-playing')).status).toBe(422);
  });

  it('hides private or expired entries from visitors and allows only the valid owner session to see private current data', async () => {
    let sessions: WebSessions | null = null;
    const clock = fixedClock();
    const app = await startApp({ clock, features: [writesFeature({ sessions: (c) => (sessions = createWebSessions({ db: c.deps.db, clock: c.deps.clock, random: c.deps.random, revocations: new MemoryRevocations(c.deps.clock) })) })] });
    app.db.run("INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state) VALUES (?, 'alice.test', '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current')", ALICE);
    ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: 'alice.test' });
    ensureAccount({ db: app.db, clock }, { did: BOB, verifiedHandle: 'bob.test' });
    app.db.run('UPDATE accounts SET share_now_playing=0 WHERE did=?', ALICE);
    upsertNowPlaying(app.composed.core.deps, { did: ALICE, artist: 'A', track: 'B', source: 'web' });
    const session = (sessions as unknown as WebSessions).create(ALICE);
    const otherSession = (sessions as unknown as WebSessions).create(BOB);
    const path = `/api/v1/users/${ALICE}/now-playing`;
    const read = (cookie?: string) => app.fetch(path, { headers: cookie ? { cookie } : {} });
    expect((await (await read()).json()).nowPlaying).toBeNull();
    expect(await (await read('irrelevant=bad')).json()).toMatchObject({ nowPlaying: null });
    expect(await (await read(`${SESSION_COOKIE}=${otherSession.token}`)).json()).toMatchObject({ nowPlaying: null });
    expect(await (await read(`${SESSION_COOKIE}=${session.token}`)).json()).toMatchObject({ nowPlaying: { artist: 'A', shared: false } });
    clock.advance(601_000);
    expect(await (await read(`${SESSION_COOKIE}=${session.token}`)).json()).toMatchObject({ nowPlaying: null });
  });
});
