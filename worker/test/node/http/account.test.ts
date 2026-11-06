// The v1.2 account routes (ADR 0005 §5.7, §8.3, §9; N3-02): GET and PATCH
// /api/v1/account and GET /api/v1/account/ignored-listens.
//
// The real Node composition (support/app.ts) on 127.0.0.1:0 with
// writesFeature mounted, a migrated temporary database, the frozen clock
// 2026-01-15T12:00:00Z and seeded randomness; no network. Sessions are real
// `__Host-atmusic_session` rows and unsafe requests carry the real Origin and
// X-CSRF-Token. Verified handles are `users.handle` rows, as the identity
// sweeps leave them. Every answer is checked by status, the api/openapi.yaml
// schema of that status (AJV) and the `accounts` / `ignored_listens` rows.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { AccountRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { WebWritesServices } from '../../../src/http/operations';
import { writesFeature } from '../../../src/http/writes';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const T0 = Date.parse('2026-01-15T12:00:00Z');
const DAY = 24 * 3_600_000;

afterEach(async () => {
  await closeApps();
});

interface Signed {
  did: string;
  cookie: string;
  csrf: string;
}

interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
}

interface World {
  app: TestApp;
  signIn(did: string, handle: string | null): Signed;
  send(method: string, path: string, o?: { as?: Signed; csrf?: boolean; body?: unknown }): Promise<Answer>;
  account(did: string): AccountRow;
}

function verifiedHandle(app: TestApp, did: string, handle: string): void {
  app.db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state)
     VALUES (?, ?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current')
     ON CONFLICT(did) DO UPDATE SET handle = excluded.handle`,
    did,
    handle,
  );
}

async function world(): Promise<World> {
  let sessions: WebSessions | null = null;
  const app = await startApp({
    clock: fixedClock(),
    features: [
      writesFeature({
        sessions: (context) => {
          sessions = createWebSessions({
            db: context.deps.db,
            clock: context.deps.clock,
            random: context.deps.random,
            revocations: new MemoryRevocations(context.deps.clock),
          });
          return sessions;
        },
      }),
    ],
  });
  const store = sessions as WebSessions | null;
  if (store === null) throw new Error('writesFeature did not build its sessions');
  const service = (app.composed.app as unknown as WebWritesServices).webWrites;
  return {
    app,
    signIn(did, handle) {
      if (handle !== null) verifiedHandle(app, did, handle);
      ensureAccount({ db: app.db, clock: app.clock }, { did, verifiedHandle: handle });
      const issued = store.create(did);
      return { did, cookie: `${SESSION_COOKIE}=${issued.token}`, csrf: csrfToken(service.csrfKey, issued.token) };
    },
    async send(method, path, o = {}) {
      const headers = new Headers();
      if (o.as !== undefined) {
        headers.set('cookie', o.as.cookie);
        if (o.csrf !== false) {
          headers.set('origin', TEST_PUBLIC_ORIGIN);
          headers.set('x-csrf-token', o.as.csrf);
        }
      }
      let body: string | undefined;
      if (o.body !== undefined) {
        body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
        headers.set('content-type', 'application/json');
      }
      const res = await app.fetch(path, { method, headers, ...(body === undefined ? {} : { body }) });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text === '' ? null : JSON.parse(text) };
    },
    account(did) {
      const row = app.db.one<AccountRow>('SELECT * FROM accounts WHERE did = ?', did);
      if (row === null) throw new Error(`no account ${did}`);
      return row;
    },
  };
}

function contract(method: string, path: string, a: Answer): string {
  return checkResponse(method, path, a);
}

function errorOf(a: Answer): { code: string; fields?: Record<string, string> } {
  return (a.body as { error: { code: string; fields?: Record<string, string> } }).error;
}

describe('PATCH /api/v1/account', () => {
  it('PATCH /api/v1/account validates username, shareNowPlaying and importSharePercent 10..90; a taken username is 409 username_taken', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');

    const got = await w.send('GET', '/api/v1/account', { as: alice, csrf: false });
    expect(got.status).toBe(200);
    expect(contract('GET', '/api/v1/account', got)).toBe('valid');
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.body).toEqual({
      did: ALICE,
      handle: 'alice.test',
      username: 'alice.test',
      oauthStatus: 'active',
      shareNowPlaying: true,
      importSharePercent: 50,
      capabilities: ['lastfm', 'listenbrainz', 'imports'],
    });

    // Every field at once, the username in mixed case (stored lowercase), the share at both bounds.
    const patched = await w.send('PATCH', '/api/v1/account', {
      as: alice,
      body: { username: 'Alice_2', shareNowPlaying: false, importSharePercent: 10 },
    });
    expect(patched.status).toBe(200);
    expect(contract('PATCH', '/api/v1/account', patched)).toBe('valid');
    expect(patched.body).toMatchObject({ username: 'alice_2', shareNowPlaying: false, importSharePercent: 10 });
    expect(w.account(ALICE)).toMatchObject({ username: 'alice_2', share_now_playing: 0, import_share_pct: 10 });
    const upper = await w.send('PATCH', '/api/v1/account', { as: alice, body: { importSharePercent: 90 } });
    expect([upper.status, w.account(ALICE).import_share_pct]).toEqual([200, 90]);

    // Invalid fields: 422 validation_failed naming the field, nothing changed.
    const invalid: Array<[unknown, string]> = [
      [{ importSharePercent: 9 }, 'importSharePercent'],
      [{ importSharePercent: 91 }, 'importSharePercent'],
      [{ importSharePercent: 50.5 }, 'importSharePercent'],
      [{ importSharePercent: '50' }, 'importSharePercent'],
      [{ shareNowPlaying: 'yes' }, 'shareNowPlaying'],
      [{ shareNowPlaying: null }, 'shareNowPlaying'],
      [{ username: 'a' }, 'username'],
      [{ username: 'has space' }, 'username'],
      [{ username: '-dash' }, 'username'],
      [{ username: 'x'.repeat(65) }, 'username'],
      [{ username: 42 }, 'username'],
      [{ handle: 'alice.test' }, 'handle'],
      [{}, 'body'],
      [[], 'body'],
    ];
    for (const [body, field] of invalid) {
      const res = await w.send('PATCH', '/api/v1/account', { as: alice, body });
      expect([JSON.stringify(body), res.status, errorOf(res).code, Object.keys(errorOf(res).fields ?? {})]).toEqual([
        JSON.stringify(body),
        422,
        'validation_failed',
        [field],
      ]);
      expect(contract('PATCH', '/api/v1/account', res)).toBe('valid');
    }
    const malformed = await w.send('PATCH', '/api/v1/account', { as: alice, body: '{"username":' });
    expect([malformed.status, errorOf(malformed).code]).toEqual([400, 'invalid_json']);
    expect(w.account(ALICE)).toMatchObject({ username: 'alice_2', share_now_playing: 0, import_share_pct: 90 });

    // A name Bob holds, in any case, is taken; the other fields of that request do not change either.
    expect((await w.send('PATCH', '/api/v1/account', { as: bob, body: { username: 'bobby' } })).status).toBe(200);
    const taken = await w.send('PATCH', '/api/v1/account', {
      as: alice,
      body: { username: 'BOBBY', importSharePercent: 30, shareNowPlaying: true },
    });
    expect(taken.status).toBe(409);
    expect(contract('PATCH', '/api/v1/account', taken)).toBe('valid');
    expect(taken.body).toMatchObject({ error: { code: 'username_taken', message: 'This username is taken.' } });
    expect(w.account(ALICE)).toMatchObject({ username: 'alice_2', share_now_playing: 0, import_share_pct: 90 });
    expect(w.account(BOB).username).toBe('bobby');

    // Cookie and CSRF rules.
    const anonymous = await w.send('PATCH', '/api/v1/account', { body: { importSharePercent: 20 } });
    expect([anonymous.status, errorOf(anonymous).code]).toEqual([401, 'unauthenticated']);
    expect(contract('PATCH', '/api/v1/account', anonymous)).toBe('valid');
    const noCsrf = await w.send('PATCH', '/api/v1/account', {
      as: alice,
      csrf: false,
      body: { importSharePercent: 20 },
    });
    expect([noCsrf.status, errorOf(noCsrf).code]).toEqual([403, 'csrf_failed']);
    expect(contract('PATCH', '/api/v1/account', noCsrf)).toBe('valid');
    const noSession = await w.send('GET', '/api/v1/account');
    expect([noSession.status, errorOf(noSession).code]).toEqual([401, 'unauthenticated']);
    expect(w.account(ALICE).import_share_pct).toBe(90);

    // GET reflects every accepted change.
    const final = await w.send('GET', '/api/v1/account', { as: alice, csrf: false });
    expect(final.body).toMatchObject({ username: 'alice_2', shareNowPlaying: false, importSharePercent: 90 });
  });

  it("PATCH username to another DID's verified handle, or to a dotted name other than the caller's own verified handle, is 422 username_invalid", async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    w.signIn(BOB, 'bob.test');
    // Carol never signed in: her handle is verified by the index, and she holds no account.
    verifiedHandle(w.app, CAROL, 'carol.test');

    expect((await w.send('PATCH', '/api/v1/account', { as: alice, body: { username: 'alice' } })).status).toBe(200);
    const refused = ['bob.test', 'carol.test', 'Bob.Test', 'dave.test', 'alice.test.evil', 'alice.example'];
    for (const username of refused) {
      const res = await w.send('PATCH', '/api/v1/account', { as: alice, body: { username, importSharePercent: 70 } });
      expect([username, res.status]).toEqual([username, 422]);
      expect(contract('PATCH', '/api/v1/account', res)).toBe('valid');
      expect(res.body).toMatchObject({
        error: {
          code: 'username_invalid',
          message: 'A dotted username must equal your own verified handle.',
          fields: { username: 'Dotted usernames are reserved for your own verified handle.' },
        },
      });
    }
    expect(w.account(ALICE)).toMatchObject({ username: 'alice', import_share_pct: 50 });
    // Nobody took Bob's or Carol's handle as a username.
    expect(w.app.db.all<{ username: string }>('SELECT username FROM accounts ORDER BY did')).toEqual([
      { username: 'alice' },
      { username: 'bob.test' },
    ]);

    // Her own verified handle is allowed, in any case.
    const own = await w.send('PATCH', '/api/v1/account', { as: alice, body: { username: 'Alice.Test' } });
    expect(own.status).toBe(200);
    expect(contract('PATCH', '/api/v1/account', own)).toBe('valid');
    expect(own.body).toMatchObject({ username: 'alice.test', handle: 'alice.test' });

    // Once her verified handle changes, the old dotted name is no longer hers to take back.
    expect((await w.send('PATCH', '/api/v1/account', { as: alice, body: { username: 'alice' } })).status).toBe(200);
    w.app.db.run('UPDATE users SET handle = ? WHERE did = ?', 'alice.example.test', ALICE);
    const stale = await w.send('PATCH', '/api/v1/account', { as: alice, body: { username: 'alice.test' } });
    expect([stale.status, errorOf(stale).code]).toEqual([422, 'username_invalid']);
    expect(w.account(ALICE).username).toBe('alice');
  });
});

describe('GET /api/v1/account/ignored-listens', () => {
  it("GET /api/v1/account/ignored-listens lists only the caller's ignored listens newest first with reason and 128-scalar previews, and is 401 without a session", async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');
    const clef = '\u{1D11E}'; // one scalar, two UTF-16 units
    const longArtist = clef.repeat(128);
    const longTrack = `${'é'.repeat(127)}x`;
    const insert = (
      did: string,
      reason: string,
      artist: string,
      track: string,
      createdAtMs: number,
      listened: string,
    ) =>
      w.app.db.run(
        `INSERT INTO ignored_listens(did, source, reason, listened_at, artist_preview, track_preview, created_at_ms)
         VALUES (?, 'listenbrainz', ?, ?, ?, ?, ?)`,
        did,
        reason,
        listened,
        artist,
        track,
        createdAtMs,
      );
    insert(ALICE, 'artist_invalid', longArtist, 'Jóga', T0 - 3 * 60_000, '2026-01-15T11:30:00.000000000Z');
    insert(ALICE, 'track_invalid', 'Björk', longTrack, T0 - 60_000, '2026-01-15T11:58:00.000000000Z');
    insert(BOB, 'artist_invalid', 'Bob artist', 'Bob track', T0 - 30_000, '2026-01-15T11:59:00.000000000Z');
    insert(ALICE, 'artist_invalid', 'Same instant', 'later id', T0 - 60_000, '2026-01-15T11:57:00.000000000Z');
    // Older than the 30-day retention: never listed.
    insert(ALICE, 'track_invalid', 'Expired', 'Expired', T0 - 31 * DAY, '2025-12-15T11:00:00.000000000Z');
    expect(longArtist.length).toBe(256);
    expect([...longArtist].length).toBe(128);

    const path = '/api/v1/account/ignored-listens';
    const res = await w.send('GET', path, { as: alice, csrf: false });
    expect(res.status).toBe(200);
    expect(contract('GET', path, res)).toBe('valid');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = res.body as { items: Array<Record<string, string>>; nextCursor: string | null };
    expect(page.nextCursor).toBeNull();
    expect(
      page.items.map((i) => [i.reason, i.artistPreview, i.trackPreview, i.listenedAt, i.createdAt, i.source]),
    ).toEqual([
      [
        'artist_invalid',
        'Same instant',
        'later id',
        '2026-01-15T11:57:00.000000000Z',
        '2026-01-15T11:59:00.000000000Z',
        'listenbrainz',
      ],
      [
        'track_invalid',
        'Björk',
        longTrack,
        '2026-01-15T11:58:00.000000000Z',
        '2026-01-15T11:59:00.000000000Z',
        'listenbrainz',
      ],
      [
        'artist_invalid',
        longArtist,
        'Jóga',
        '2026-01-15T11:30:00.000000000Z',
        '2026-01-15T11:57:00.000000000Z',
        'listenbrainz',
      ],
    ]);
    expect(new Set(page.items.map((i) => i.id)).size).toBe(3);

    // Bob sees only his own row.
    const bobs = await w.send('GET', path, { as: bob, csrf: false });
    expect(contract('GET', path, bobs)).toBe('valid');
    expect((bobs.body as { items: Array<{ artistPreview: string }> }).items.map((i) => i.artistPreview)).toEqual([
      'Bob artist',
    ]);

    // Paging: the signed cursor continues newest first, and is bound to its viewer.
    const first = await w.send('GET', `${path}?limit=2`, { as: alice, csrf: false });
    expect(contract('GET', `${path}?limit=2`, first)).toBe('valid');
    const p1 = first.body as { items: Array<{ id: string }>; nextCursor: string };
    expect(p1.items.map((i) => i.id)).toEqual(page.items.slice(0, 2).map((i) => i.id));
    expect(typeof p1.nextCursor).toBe('string');
    const next = `${path}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`;
    const second = await w.send('GET', next, { as: alice, csrf: false });
    expect(contract('GET', next, second)).toBe('valid');
    expect(second.body).toEqual({ items: [page.items[2]], nextCursor: null });
    const stolen = await w.send('GET', next, { as: bob, csrf: false });
    expect([stolen.status, errorOf(stolen).code]).toEqual([400, 'invalid_cursor']);
    expect(contract('GET', next, stolen)).toBe('valid');
    const [payload, mac] = p1.nextCursor.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ c: T0, i: 999 })).toString('base64url');
    for (const cursor of [`${forged}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, 'garbage', `${payload}`]) {
      const bad = await w.send('GET', `${path}?cursor=${encodeURIComponent(cursor)}`, { as: alice, csrf: false });
      expect([cursor, bad.status, errorOf(bad).code]).toEqual([cursor, 400, 'invalid_cursor']);
    }
    for (const limit of ['0', '101', 'x']) {
      const bad = await w.send('GET', `${path}?limit=${limit}`, { as: alice, csrf: false });
      expect([limit, bad.status, Object.keys(errorOf(bad).fields ?? {})]).toEqual([limit, 422, ['limit']]);
      expect(contract('GET', `${path}?limit=${limit}`, bad)).toBe('valid');
    }

    // No session (or a forged cookie) is 401.
    const anonymous = await w.send('GET', path);
    expect([anonymous.status, errorOf(anonymous).code]).toEqual([401, 'unauthenticated']);
    expect(contract('GET', path, anonymous)).toBe('valid');
    const forgedCookie = await w.app.fetch(path, { headers: { cookie: `${SESSION_COOKIE}=${'f'.repeat(64)}` } });
    expect(forgedCookie.status).toBe(401);
    await forgedCookie.body?.cancel();
  });
});
