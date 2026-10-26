// GET /1/validate-token, POST /1/delete-listen and POST /1/playing-now/delete
// over the in-process app (ADR 0005 §8.2, §8.6; N3-05). The real composition
// (support/app.ts) on 127.0.0.1:0, frozen clock 2026-01-15T12:00:00Z, seeded
// randomness, no network. Indexed scrobbles are seeded with direct SQL, as the
// verified index would hold them.

import type { Random } from '@atmusic/core/deps';
import { recordingMsid } from '@atmusic/core/msid';
import { trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { NowPlayingRow, OperationRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { createLbToken, revokeLbToken } from '../../../src/credentials/lb-tokens';
import { createSubmitRoutes } from '../../../src/listenbrainz/submit';
import { createTokenRoutes } from '../../../src/listenbrainz/token-routes';
import { closeApps, startApp, type TestApp } from '../support/app';

const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW_S = NOW_MS / 1000;
const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
/** An owned test prefix with ownership evidence: the namespace gate allows publication (ADR §5.7). */
const OWNED = 'org.example.music';
const SCROBBLE = `${OWNED}.scrobble`;
const OPEN_GATE = { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org TXT' };
/** The fixture prefix without ownership evidence: no `publication` capability. */
const FIXTURE_GATE = { LEXICON_PREFIX: 'com.example.atmusic', NAMESPACE_OWNERSHIP_REF: '' };

afterEach(closeApps);

interface Rig {
  app: TestApp;
  clock: FixedClock;
  random: Random;
  revocations: MemoryRevocations;
  user(did: string, handle: string): { id: string; token: string };
  ops(did: string): OperationRow[];
  nowPlaying(did: string): NowPlayingRow | null;
}

async function rig(env: Record<string, string> = OPEN_GATE): Promise<Rig> {
  const clock = fixedClock();
  const app = await startApp({ routes: [...createSubmitRoutes(), ...createTokenRoutes()], clock, env });
  const random = seededRandom(0x70c);
  const revocations = new MemoryRevocations(clock);
  return {
    app,
    clock,
    random,
    revocations,
    user(did, handle) {
      app.db.run(
        "INSERT INTO users (did, handle, joined_at, active, account_status, indexing_state) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current')",
        did,
        handle,
      );
      const deps = { db: app.db, clock, random, revocations };
      ensureAccount(deps, { did, verifiedHandle: handle });
      const created = createLbToken(deps, { did, label: 'test' });
      return { id: created.id, token: created.token };
    },
    ops(did) {
      return app.db.all<OperationRow>('SELECT * FROM operations WHERE did = ? ORDER BY rowid', did);
    },
    nowPlaying(did) {
      return app.db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', did);
    },
  };
}

function post(app: TestApp, path: string, token: string | null, payload?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Token ${token}`;
  return app.fetch(path, {
    method: 'POST',
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function playingNow(app: TestApp, token: string, client?: string): Promise<Response> {
  const info = client === undefined ? {} : { additional_info: { submission_client: client } };
  return post(app, '/1/submit-listens', token, {
    listen_type: 'playing_now',
    payload: [{ track_metadata: { artist_name: 'Low', track_name: 'Lullaby', ...info } }],
  });
}

/** An indexed scrobble of `did` at `listenedAtNs` (storage form), as the verified index holds it. */
function seedScrobble(app: TestApp, did: string, rkey: string, listenedAt: string, artist: string, track: string) {
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  app.db.run(
    `INSERT INTO scrobbles(uri, cid, did, rkey, revision, artist, track, listened_at, created_at, indexed_at,
       artist_key, track_key)
     VALUES (?, 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', ?, ?, '3lbq2f7ff2c2a', ?, ?, ?,
       '2026-01-15T11:00:00.000Z', '2026-01-15T11:00:01.000000000Z', ?, ?)`,
    `at://${did}/${SCROBBLE}/${rkey}`,
    did,
    rkey,
    artist,
    track,
    listenedAt,
    artistKey,
    trackKeyValue,
  );
}

describe('ListenBrainz token routes (ADR §8.2, §8.6)', () => {
  it("a valid header or ?token returns {code:200,message:'Token valid.',valid:true,user_name}; invalid returns 200 valid false; none is 400", async () => {
    const r = await rig();
    const alice = r.user(ALICE, 'alice.example.com');
    const expected = { code: 200, message: 'Token valid.', valid: true, user_name: 'alice.example.com' };

    for (const authorization of [`Token ${alice.token}`, `token ${alice.token}`, `TOKEN ${alice.token}`]) {
      const res = await r.app.fetch('/1/validate-token', { headers: { authorization } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const parsed = (await res.json()) as { valid: unknown };
      expect(parsed).toEqual(expected);
      expect(typeof parsed.valid).toBe('boolean');
    }
    const byQuery = await r.app.fetch(`/1/validate-token?token=${alice.token}`);
    expect(byQuery.status).toBe(200);
    expect(await byQuery.json()).toEqual(expected);
    // The user name follows a rename.
    r.app.db.run("UPDATE accounts SET username = 'alice' WHERE did = ?", ALICE);
    expect(await (await r.app.fetch(`/1/validate-token?token=${alice.token}`)).json()).toEqual({
      ...expected,
      user_name: 'alice',
    });

    const invalid = { code: 200, message: 'Token invalid.', valid: false };
    for (const path of [
      '/1/validate-token?token=00000000-0000-4000-8000-000000000000',
      '/1/validate-token?token=meba_0123456789abcdef',
      '/1/validate-token?token=not-a-token',
    ]) {
      const res = await r.app.fetch(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(invalid);
    }
    // A revoked token is invalid at once.
    expect(revokeLbToken({ db: r.app.db, revocations: r.revocations }, ALICE, alice.id)).toBe(true);
    const revoked = await r.app.fetch('/1/validate-token', { headers: { authorization: `Token ${alice.token}` } });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual(invalid);

    // No token anywhere (a Bearer header does not count here, as ListenBrainz reads only `token `): 400.
    for (const init of [{}, { headers: { authorization: 'Bearer abc' } }]) {
      const none = await r.app.fetch('/1/validate-token', init);
      expect(none.status).toBe(400);
      expect(await none.json()).toEqual({ code: 400, error: 'You need to provide an Authorization token.' });
      expect(none.headers.get('access-control-allow-origin')).toBe('*');
    }
    const empty = await r.app.fetch('/1/validate-token?token=');
    expect(empty.status).toBe(400);
  });

  it("delete-listen and playing-now/delete require a token and act only on the token owner's data; a client mismatch is 404", async () => {
    const r = await rig();
    const alice = r.user(ALICE, 'alice.example.com');
    const bob = r.user(BOB, 'bob.example.com');
    const second = NOW_S - 3600;
    const at = (fraction: string) => `${new Date(second * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
    // Alice: two listens of the track in that second (the newer one is the target) and another track.
    seedScrobble(r.app, ALICE, '3lbqaaaaaaa2a', at('100000000'), 'Low', 'Lullaby');
    seedScrobble(r.app, ALICE, '3lbqaaaaaaa3a', at('500000000'), 'Low', 'Lullaby');
    seedScrobble(r.app, ALICE, '3lbqaaaaaaa4a', at('900000000'), 'Low', 'Words');
    // Bob: the same track at the same second.
    seedScrobble(r.app, BOB, '3lbqaaaaaaa5a', at('200000000'), 'Low', 'Lullaby');
    const msid = await recordingMsid('Low', 'Lullaby');

    // No token: 401, nothing queued.
    const anonymous = await post(r.app, '/1/delete-listen', null, { listened_at: second, recording_msid: msid });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ code: 401, error: 'You need to provide an Authorization header.' });
    const wrong = await post(r.app, '/1/delete-listen', '00000000-0000-4000-8000-000000000000', {
      listened_at: second,
      recording_msid: msid,
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: 401, error: 'Invalid authorization token.' });
    expect(r.ops(ALICE)).toEqual([]);
    expect(r.ops(BOB)).toEqual([]);

    // ListenBrainz's own 400s.
    const missing = await post(r.app, '/1/delete-listen', alice.token, { recording_msid: msid });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ code: 400, error: 'Listen timestamp missing.' });
    const badMsid = await post(r.app, '/1/delete-listen', alice.token, { listened_at: second, recording_msid: 'x' });
    expect(badMsid.status).toBe(400);
    expect(await badMsid.json()).toEqual({ code: 400, error: 'x: Recording MSID format invalid.' });

    // Bob deletes "his" listen: only Bob's record gets a delete.
    const bobs = await post(r.app, '/1/delete-listen', bob.token, { listened_at: second, recording_msid: msid });
    expect(bobs.status).toBe(200);
    expect(await bobs.json()).toEqual({ status: 'ok' });
    expect(r.ops(BOB).map((op) => [op.kind, op.origin, op.rkey])).toEqual([
      ['scrobble.delete', 'listenbrainz', '3lbqaaaaaaa5a'],
    ]);
    expect(r.ops(ALICE)).toEqual([]);

    // Alice deletes hers: the newest matching record at that second, not the other track.
    const alices = await post(r.app, '/1/delete-listen', alice.token, {
      listened_at: String(second),
      recording_msid: msid.toUpperCase(),
    });
    expect(alices.status).toBe(200);
    expect(await alices.json()).toEqual({ status: 'ok' });
    expect(r.ops(ALICE).map((op) => [op.kind, op.rkey, op.collection])).toEqual([
      ['scrobble.delete', '3lbqaaaaaaa3a', SCROBBLE],
    ]);

    // An MSID with no listen of the caller at that second: ok, nothing queued.
    const none = await post(r.app, '/1/delete-listen', alice.token, {
      listened_at: second + 1,
      recording_msid: msid,
    });
    expect(none.status).toBe(200);
    expect(r.ops(ALICE)).toHaveLength(1);

    // A not-yet-indexed listen of the caller is removed before it is ever sent.
    const submitted = await post(r.app, '/1/submit-listens', alice.token, {
      listen_type: 'single',
      payload: [{ listened_at: NOW_S - 30, track_metadata: { artist_name: 'Low', track_name: 'Lullaby' } }],
    });
    expect(submitted.status).toBe(200);
    expect(r.ops(ALICE)[1]).toMatchObject({ kind: 'scrobble.create', state: 'queued' });
    const bobTries = await post(r.app, '/1/delete-listen', bob.token, {
      listened_at: NOW_S - 30,
      recording_msid: msid,
    });
    expect(bobTries.status).toBe(200);
    expect(r.ops(ALICE)[1]).toMatchObject({ state: 'queued' });
    expect(r.ops(BOB)).toHaveLength(1);
    const cancel = await post(r.app, '/1/delete-listen', alice.token, {
      listened_at: NOW_S - 30,
      recording_msid: msid,
    });
    expect(cancel.status).toBe(200);
    expect(r.ops(ALICE)[1]).toMatchObject({ kind: 'scrobble.create', state: 'cancelled' });
    expect(r.app.db.one<{ n: number }>('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)?.n).toBe(0);

    // A closed publication gate (no lexicon prefix, or the fixture prefix
    // without NAMESPACE_OWNERSHIP_REF, ADR §5.7): the token is still checked
    // first, then 503 with ListenBrainz's queue-unavailable body and nothing
    // queued, even with a matching indexed scrobble and a valid body.
    for (const env of [{ LEXICON_PREFIX: '', NAMESPACE_OWNERSHIP_REF: '' }, FIXTURE_GATE]) {
      const closed = await rig(env);
      expect(closed.app.config.app.publication).toBe(false);
      const aliceClosed = closed.user(ALICE, 'alice.example.com');
      seedScrobble(closed.app, ALICE, '3lbqaaaaaaa2a', at('100000000'), 'Low', 'Lullaby');
      const noToken = await post(closed.app, '/1/delete-listen', null, { listened_at: second, recording_msid: msid });
      expect(noToken.status).toBe(401);
      for (const payload of [{ listened_at: second, recording_msid: msid }, { recording_msid: msid }]) {
        const refused = await post(closed.app, '/1/delete-listen', aliceClosed.token, payload);
        expect(refused.status).toBe(503);
        expect(await refused.json()).toEqual({
          code: 503,
          error: 'Cannot submit listens to queue, please try again later.',
        });
        expect(refused.headers.get('access-control-allow-origin')).toBe('*');
        expect(refused.headers.get('x-ratelimit-limit')).toBe('100');
      }
      expect(closed.app.db.one<{ n: number }>('SELECT count(*) AS n FROM operations')?.n).toBe(0);
      expect(closed.app.db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')?.n).toBe(1);
    }

    // playing-now/delete: a token is required.
    expect((await playingNow(r.app, alice.token, 'Navidrome')).status).toBe(200);
    expect(r.nowPlaying(ALICE)).toMatchObject({ client: 'Navidrome' });
    const anonymousClear = await post(r.app, '/1/playing-now/delete', null, { client: 'Navidrome' });
    expect(anonymousClear.status).toBe(401);
    expect(r.nowPlaying(ALICE)).not.toBeNull();

    // Bob has nothing playing: already cleared, and Alice's entry stays.
    const bobClear = await post(r.app, '/1/playing-now/delete', bob.token, { client: 'Navidrome' });
    expect(bobClear.status).toBe(200);
    expect(await bobClear.json()).toEqual({ status: 'ok', message: 'Playing now already cleared' });
    expect(r.nowPlaying(ALICE)).not.toBeNull();

    // Alice from another client: 404, the entry stays; from the right client: cleared.
    const mismatch = await post(r.app, '/1/playing-now/delete', alice.token, { client: 'Web Scrobbler' });
    expect(mismatch.status).toBe(404);
    expect(await mismatch.json()).toMatchObject({ code: 404 });
    expect(mismatch.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.nowPlaying(ALICE)).not.toBeNull();
    const cleared = await post(r.app, '/1/playing-now/delete', alice.token, { client: 'Navidrome' });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ status: 'ok', message: 'Playing now cleared successfully' });
    expect(r.nowPlaying(ALICE)).toBeNull();
  });

  it('playing-now/delete with nothing playing answers already cleared; an entry stored without a submission_client is cleared for any client value; an entry with a different stored client is 404', async () => {
    const r = await rig();
    const alice = r.user(ALICE, 'alice.example.com');

    const nothing = await post(r.app, '/1/playing-now/delete', alice.token, {});
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ status: 'ok', message: 'Playing now already cleared' });
    // An empty body is no client at all.
    const emptyBody = await post(r.app, '/1/playing-now/delete', alice.token);
    expect(emptyBody.status).toBe(200);
    expect(await emptyBody.json()).toEqual({ status: 'ok', message: 'Playing now already cleared' });

    // Stored without a client: cleared whatever client the delete names.
    expect((await playingNow(r.app, alice.token)).status).toBe(200);
    expect(r.nowPlaying(ALICE)).toMatchObject({ client: null });
    const anyClient = await post(r.app, '/1/playing-now/delete', alice.token, { client: 'Some Player' });
    expect(anyClient.status).toBe(200);
    expect(await anyClient.json()).toEqual({ status: 'ok', message: 'Playing now cleared successfully' });
    expect(r.nowPlaying(ALICE)).toBeNull();

    // Stored with a client: another client (or none) is 404 and the entry stays.
    expect((await playingNow(r.app, alice.token, 'Pano Scrobbler')).status).toBe(200);
    for (const payload of [{ client: 'Navidrome' }, {}]) {
      const res = await post(r.app, '/1/playing-now/delete', alice.token, payload);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 404 });
      expect(r.nowPlaying(ALICE)).toMatchObject({ client: 'Pano Scrobbler' });
    }
    const same = await post(r.app, '/1/playing-now/delete', alice.token, { client: 'Pano Scrobbler' });
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ status: 'ok', message: 'Playing now cleared successfully' });
    expect(r.nowPlaying(ALICE)).toBeNull();

    // An expired entry is not current: already cleared.
    expect((await playingNow(r.app, alice.token, 'Pano Scrobbler')).status).toBe(200);
    r.clock.advance(601_000);
    const expired = await post(r.app, '/1/playing-now/delete', alice.token, { client: 'Navidrome' });
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ status: 'ok', message: 'Playing now already cleared' });
  });
});
