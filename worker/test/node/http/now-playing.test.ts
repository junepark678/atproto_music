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

describe('GET /api/v1/feed/now-playing', () => {
  it('requires a session and returns only followed, shared, unexpired entries capped at 50 with handles', async () => {
    let sessions: WebSessions | null = null;
    const app = await startApp({ clock: fixedClock(), features: [writesFeature({ sessions: (c) => (sessions = createWebSessions({ db: c.deps.db, clock: c.deps.clock, random: c.deps.random, revocations: new MemoryRevocations(c.deps.clock) })) })] });
    app.composed.core.deps.identity.resolveDid = async (did) => ({ did, pds: 'https://pds.example.test', signingKey: 'did:key:z6Mkf', handle: `user${Number.parseInt(did.slice(-24), 10) - 1}.test`, fetchedAtMs: T0 });
    const ensureUser = (did: string, handle: string) => {
      app.db.run("INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current') ON CONFLICT(did) DO UPDATE SET handle=excluded.handle", did, handle);
      ensureAccount({ db: app.db, clock: app.clock }, { did, verifiedHandle: handle });
    };
    ensureUser(ALICE, 'alice.test');
    const viewer = (sessions as unknown as WebSessions).create(ALICE);
    const expected: string[] = [];
    for (let i = 0; i < 52; i++) {
      const did = `did:plc:${String(i + 1).padStart(24, '0')}`;
      ensureUser(did, `user${i}.test`);
      app.db.run('INSERT INTO follows(uri,cid,actor,subject,revision,created_at,indexed_at) VALUES(?,?,?,?,?,?,?)', `at://${ALICE}/app.atmusic.follow/${i}`, 'cid', ALICE, did, '1', '2026-01-15T12:00:00.000000000Z', '2026-01-15T12:00:00.000000000Z');
      if (i < 52) upsertNowPlaying(app.composed.core.deps, { did, artist: `Artist ${i}`, track: 'Track', source: 'web' });
      expected.push(did);
    }
    const privateDid = expected[0]!;
    app.db.run('UPDATE accounts SET share_now_playing=0 WHERE did=?', privateDid);
    const expiredDid = expected[1]!;
    app.db.run('UPDATE now_playing SET expires_at_ms=? WHERE did=?', T0, expiredDid);
    const notFollowed = 'did:plc:999999999999999999999999';
    ensureUser(notFollowed, 'stranger.test');
    upsertNowPlaying(app.composed.core.deps, { did: notFollowed, artist: 'Stranger', track: 'Track', source: 'web' });
    const path = '/api/v1/feed/now-playing';
    expect((await app.fetch(path)).status).toBe(401);
    const res = await app.fetch(path, { headers: { cookie: `${SESSION_COOKIE}=${viewer.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as { items: Array<{ did: string; handle: string | null; nowPlaying: { artist: string } }> };
    expect(body.items).toHaveLength(50);
    expect(body.items.map((item) => item.did)).not.toContain(privateDid);
    expect(body.items.map((item) => item.did)).not.toContain(expiredDid);
    expect(body.items.map((item) => item.did)).not.toContain(notFollowed);
    expect(body.items[0]?.handle).toBe('user2.test');
    expect(body.items[0]?.nowPlaying.artist).toBe('Artist 2');
  });
});
