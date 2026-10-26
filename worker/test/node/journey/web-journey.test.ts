// The web journey (ADR 0005 §5.5–§5.8, §15.4; N4-01): the whole production
// process in-process (journey/world.ts: run() with the production features,
// every fake upstream, the memoryLink Jetstream echoing the fake PDS's
// commits, the frozen clock and manual timers). A browser signs in through
// the fake AS, scrobbles through the cookie write route, and the record
// travels the real path: outbox → DPoP-authorised PDS write → Jetstream
// event → verified getRecord proof → index → public read. Then the
// expiry-sweep timer deletes exactly what has expired.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRY_SWEEP_INTERVAL_MS } from '../../../src/node/features';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeWorlds, DAY_MS, HOUR_MS, SCROBBLE, startWorld, T0, type World } from './world';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

const LISTEN = { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:58:00Z', album: 'Homogenic' };

const hex = (blob: unknown): string => Buffer.from(blob as ArrayBuffer).toString('hex');

interface Keyed {
  key: string;
  expires: number;
}

/** The rows of the five expiring tables, keyed, with their expiry. */
function expiring(w: World): Record<string, Keyed[]> {
  const rows = (sql: string) =>
    w.db
      .all<{ k: unknown; e: number }>(sql)
      .map((r) => ({ key: typeof r.k === 'string' ? r.k : hex(r.k), expires: r.e }));
  return {
    oauth_states: rows('SELECT key_hash AS k, expires_at_ms AS e FROM oauth_states ORDER BY e, k'),
    link_states: rows('SELECT state_hash AS k, expires_at_ms AS e FROM link_states ORDER BY e, k'),
    lastfm_tokens: rows('SELECT token_hash AS k, expires_at_ms AS e FROM lastfm_tokens ORDER BY e, k'),
    web_sessions: rows('SELECT token_hash AS k, expires_at_ms AS e FROM web_sessions ORDER BY e, k'),
    now_playing: rows('SELECT did AS k, expires_at_ms AS e FROM now_playing ORDER BY e, k'),
  };
}

describe('web journey', () => {
  it('sign-in through the fake AS, POST /api/v1/scrobbles, operation succeeded, record indexed and visible in /api/v1/users/{did}/scrobbles', async () => {
    const { w, alice } = await startWorld();

    // Sign-in: PAR and the code exchange at the fake AS, private_key_jwt against our own JWKS.
    const session = await w.signIn(alice);
    expect(session.did).toBe(alice.did);
    expect(w.as.calls.count({ path: '/oauth/par', status: 201 })).toBe(1);
    expect(w.as.calls.count({ path: '/oauth/token', status: 200 })).toBe(1);
    expect(w.count('oauth_sessions', 'did = ?', alice.did)).toBe(1);
    expect(w.count('users', 'did = ?', alice.did)).toBe(1);

    const posted = await w.send('POST', '/api/v1/scrobbles', {
      as: session,
      body: LISTEN,
      headers: { 'idempotency-key': 'web-journey-1' },
    });
    expect(posted.status).toBe(202);
    expect(checkResponse('POST', '/api/v1/scrobbles', posted)).toBe('valid');
    const queued = (posted.body as { operation: { id: string; state: string; kind: string; origin: string } })
      .operation;
    expect(queued).toMatchObject({ kind: 'scrobble.create', origin: 'web', state: 'queued' });
    // Nothing is indexed before the record exists on the PDS and its proof was checked.
    expect(w.count('scrobbles')).toBe(0);
    expect(await alice.repo.list(SCROBBLE)).toEqual([]);

    await w.until(() => w.count('scrobbles', 'did = ?', alice.did) === 1);

    // The record exists on the PDS (whose account accepts only DPoP-bound tokens) …
    const onPds = await alice.repo.list(SCROBBLE);
    expect(onPds).toHaveLength(1);
    const record = onPds[0] as { rkey: string; cid: string; value: Record<string, unknown> };
    expect(record.value).toMatchObject({ $type: SCROBBLE, artist: 'Björk', track: 'Jóga', album: 'Homogenic' });
    const writes = w.pds.calls.filter({ service: 'pds', status: 200 }).filter((c) => c.method === 'POST');
    expect(writes.map((c) => c.nsid)).toEqual(['com.atproto.repo.createRecord']);
    // … Jetstream echoed its commit, and the index fetched the record's proof before applying it.
    expect(w.jetstream.events.map((e) => (e.kind === 'commit' ? e.commit.rkey : null))).toEqual([record.rkey]);
    expect(w.jetstream.live()).toHaveLength(1);
    expect(w.pds.calls.count({ nsid: 'com.atproto.sync.getRecord', status: 200 })).toBeGreaterThanOrEqual(1);
    const uri = `at://${alice.did}/${SCROBBLE}/${record.rkey}`;
    expect(w.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri = ?', uri)?.cid).toBe(record.cid);

    const status = await w.send('GET', `/api/v1/operations/${queued.id}`, { as: session });
    expect(status.status).toBe(200);
    expect(checkResponse('GET', `/api/v1/operations/${queued.id}`, status)).toBe('valid');
    expect(status.body).toMatchObject({ id: queued.id, state: 'succeeded', uri, cid: record.cid, attempts: 1 });

    const page = await w.send('GET', `/api/v1/users/${alice.did}/scrobbles`);
    expect(page.status).toBe(200);
    expect(checkResponse('GET', `/api/v1/users/${alice.did}/scrobbles`, page)).toBe('valid');
    const items = (page.body as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      uri,
      cid: record.cid,
      did: alice.did,
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      listenedAt: '2026-01-15T11:58:00.000000000Z',
    });
  }, 60_000);

  it('the expiry-sweep timer deletes expired OAuth states, link states, Last.fm tokens, web sessions and now-playing rows and keeps unexpired ones', async () => {
    const { w, alice, bob } = await startWorld();
    expect(w.core.extensionLane.names).toContain('expiry-sweep');

    // T0: Alice's set, everything of which will have expired by the sweep.
    const aliceSession = await w.signIn(alice);
    const pw = await w.send('POST', '/api/v1/account/app-passwords', { as: aliceSession, body: { label: 'pano' } });
    expect(pw.status).toBe(201);
    const password = (pw.body as { password: string }).password;
    const mobile = await w.lastfm2({ method: 'auth.getMobileSession', username: alice.handle, password });
    expect(mobile.status).toBe(200);
    const aliceSk = (mobile.body as { session: { key: string } }).session.key;
    const seed = async (signed: typeof aliceSession, sk: string, track: string) => {
      // An OAuth state that is never completed, a Last.fm link state, a desktop token, a now-playing row.
      const start = await w.send('POST', '/api/v1/auth/start', {
        body: { handle: signed.did === alice.did ? alice.handle : bob.handle },
        headers: { origin: 'https://music.example.test' },
      });
      expect(start.status).toBe(200);
      expect((await w.send('POST', '/api/v1/links/lastfm/start', { as: signed })).status).toBe(200);
      expect((await w.lastfm2({ method: 'auth.getToken' })).status).toBe(200);
      const np = await w.lastfm2({ method: 'track.updateNowPlaying', sk, artist: 'Air', track, duration: '240' });
      expect(np.status).toBe(200);
    };
    await seed(aliceSession, aliceSk, 'La femme d’argent');
    const old = expiring(w);
    expect(Object.fromEntries(Object.entries(old).map(([t, r]) => [t, r.length]))).toEqual({
      oauth_states: 1,
      link_states: 1,
      lastfm_tokens: 1,
      web_sessions: 1,
      now_playing: 1,
    });

    // Thirty days and an hour later Alice's web session has expired too; Bob signs in and seeds his set.
    w.advance(30 * DAY_MS + HOUR_MS);
    const now = w.clock.nowMs();
    for (const rows of Object.values(old)) for (const row of rows) expect(row.expires).toBeLessThanOrEqual(now);
    const bobSession = await w.signIn(bob);
    const bobPw = await w.send('POST', '/api/v1/account/app-passwords', { as: bobSession, body: { label: 'pano' } });
    const bobMobile = await w.lastfm2({
      method: 'auth.getMobileSession',
      username: bob.handle,
      password: (bobPw.body as { password: string }).password,
    });
    const bobSk = (bobMobile.body as { session: { key: string } }).session.key;
    await seed(bobSession, bobSk, 'Kelly Watch the Stars');
    const sweepAt = w.clock.nowMs();
    const before = expiring(w);
    const fresh: Record<string, Keyed[]> = {};
    for (const [table, rows] of Object.entries(before)) {
      const kept = rows.filter((r) => r.expires > sweepAt);
      expect(kept, table).toHaveLength(1);
      fresh[table] = kept;
      // Alice's expired row is still there: nothing but the sweep deletes it.
      expect(rows.filter((r) => r.expires <= now).length, table).toBe(1);
    }

    // The sweep is due (it reschedules every 10 minutes); one extension-lane run deletes the expired rows only.
    const due = w.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'expiry-sweep'")?.due_at;
    expect(due).toBeLessThanOrEqual(sweepAt);
    await w.pump({ core: false });
    expect(expiring(w)).toEqual(fresh);
    expect(w.db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name = 'expiry-sweep'")?.due_at).toBe(
      sweepAt + EXPIRY_SWEEP_INTERVAL_MS,
    );
    const done = w.log.logs.filter((l) => l.event === 'expiry_sweep.done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      oauthStates: 1,
      linkStates: 1,
      lastfmApprovals: 1,
      webSessions: 1,
      nowPlaying: 1,
      signedOut: 0,
      failed: [],
    });
    // Bob's live session still answers; Alice's expired one is gone.
    expect((await w.send('GET', '/api/v1/auth/session', { as: bobSession })).status).toBe(200);
    expect((await w.send('GET', '/api/v1/auth/session', { as: aliceSession })).status).toBe(401);
  }, 60_000);
});
