// The scrobbler journeys (ADR 0005 §7, §8, §12, §15.4; N4-01): the whole
// production process in-process (journey/world.ts: run() with the production
// features, every fake upstream, the memoryLink Jetstream echoing the fake
// PDS's commits, the frozen clock and manual timers).
//
// A scrobbler app talks only to our /2.0 or /1 endpoints. Its listens travel
// the shared ingress (listen keys, operations, forward rows), then the server
// outbox writes them to the user's PDS with the user's DPoP-bound OAuth
// session, the Jetstream echo and the verified getRecord proof index them,
// and the protocol reads list them. Linked Last.fm and ListenBrainz accounts
// get each listen exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorlds, PDS_HOST, SCROBBLE, type Signed, startWorld, T0, type User, type World } from './world';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

const T0_S = T0 / 1000;
const PDS_WRITES = new Set(['/xrpc/com.atproto.repo.createRecord', '/xrpc/com.atproto.repo.applyWrites']);

/** Sign-in, an app password, and Pano's auth.getMobileSession: the session key. */
async function panoSession(w: World, user: User): Promise<{ session: Signed; sk: string }> {
  const session = await w.signIn(user);
  const created = await w.send('POST', '/api/v1/account/app-passwords', { as: session, body: { label: 'Pano' } });
  expect(created.status).toBe(201);
  const password = (created.body as { password: string }).password;
  const mobile = await w.lastfm2({ method: 'auth.getMobileSession', username: user.handle, password });
  expect(mobile.status).toBe(200);
  const body = mobile.body as { session: { name: string; key: string; subscriber: number } };
  expect(body.session.name).toBe(user.handle);
  expect(body.session.key).toMatch(/^[0-9a-f]{32}$/);
  return { session, sk: body.session.key };
}

/** Pano's batched track.scrobble form (one entry). */
function panoScrobble(sk: string, entry: { artist: string; track: string; album: string; timestamp: number }) {
  return {
    method: 'track.scrobble',
    sk,
    'artist[0]': entry.artist,
    'track[0]': entry.track,
    'album[0]': entry.album,
    'albumArtist[0]': entry.artist,
    'duration[0]': '215',
    'timestamp[0]': String(entry.timestamp),
  };
}

interface RecentTrack {
  name: string;
  artist: { '#text': string };
  album: { '#text': string };
  '@attr'?: { nowplaying?: string };
  date?: { uts: string };
}

async function recentTracks(w: World, user: User): Promise<RecentTrack[]> {
  const res = await w.lastfmRead({ method: 'user.getRecentTracks', user: user.handle });
  expect(res.status).toBe(200);
  return (res.body as { recenttracks: { track: RecentTrack[] } }).recenttracks.track;
}

describe('scrobbler journeys', () => {
  it('Pano-shaped getMobileSession, updateNowPlaying and track.scrobble produce a DPoP-authorised PDS record, which is indexed after its proof and listed by user.getRecentTracks', async () => {
    const { w, alice } = await startWorld();
    const { sk } = await panoSession(w, alice);

    const np = await w.lastfm2({
      method: 'track.updateNowPlaying',
      sk,
      artist: 'Massive Attack',
      track: 'Teardrop',
      album: 'Mezzanine',
      albumArtist: 'Massive Attack',
      duration: '330',
    });
    expect(np.status).toBe(200);
    expect(np.body).toMatchObject({
      nowplaying: { track: { '#text': 'Teardrop' }, artist: { '#text': 'Massive Attack' } },
    });

    const scrobbled = await w.lastfm2(
      panoScrobble(sk, { artist: 'Portishead', track: 'Roads', album: 'Dummy', timestamp: T0_S - 300 }),
    );
    expect(scrobbled.status).toBe(200);
    expect(scrobbled.body).toMatchObject({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
    expect(w.count('operations', "did = ? AND kind = 'scrobble.create' AND origin = 'lastfm'", alice.did)).toBe(1);

    // The outbox (extension lane only): the record is written with Alice's DPoP-bound session …
    const writesBefore = w.outbound.filter((r) => r.host === PDS_HOST && PDS_WRITES.has(r.path)).length;
    expect(writesBefore).toBe(0);
    await w.until(async () => (await alice.repo.list(SCROBBLE)).length === 1, { core: false });
    const writes = w.outbound.filter((r) => r.host === PDS_HOST && PDS_WRITES.has(r.path));
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const write of writes) expect(write).toMatchObject({ method: 'POST', scheme: 'DPoP', dpop: true });
    expect(w.pds.calls.filter({ service: 'pds', status: 200 }).filter((c) => PDS_WRITES.has(c.path))).toHaveLength(1);
    const [record] = await alice.repo.list(SCROBBLE);
    expect(record?.value).toMatchObject({ $type: SCROBBLE, artist: 'Portishead', track: 'Roads', album: 'Dummy' });
    const uri = `at://${alice.did}/${SCROBBLE}/${record?.rkey}`;

    // … but is not indexed, nor listed, before the index has checked its proof.
    expect(w.count('scrobbles', 'uri = ?', uri)).toBe(0);
    const proofsBefore = w.pds.calls.count({ nsid: 'com.atproto.sync.getRecord', status: 200 });
    const early = await recentTracks(w, alice);
    expect(early.map((t) => [t.name, t['@attr']?.nowplaying ?? null])).toEqual([['Teardrop', 'true']]);

    // The core lane: Jetstream's echo of the commit, then the verified getRecord proof, then the index.
    await w.until(() => w.count('scrobbles', 'uri = ?', uri) === 1, { extensions: false });
    expect(w.pds.calls.count({ nsid: 'com.atproto.sync.getRecord', status: 200 })).toBeGreaterThan(proofsBefore);
    expect(w.db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri = ?', uri)?.cid).toBe(record?.cid);
    expect(w.jetstream.events.filter((e) => e.kind === 'commit' && e.commit.rkey === record?.rkey)).toHaveLength(1);

    const listed = await recentTracks(w, alice);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ name: 'Teardrop', '@attr': { nowplaying: 'true' } });
    expect(listed[1]).toMatchObject({
      name: 'Roads',
      artist: { '#text': 'Portishead' },
      album: { '#text': 'Dummy' },
      date: { uts: String(T0_S - 300) },
    });
  }, 60_000);

  it('that scrobble is forwarded exactly once to fake Last.fm and to fake ListenBrainz, and a resend changes nothing', async () => {
    const { w, alice } = await startWorld();
    const { session, sk } = await panoSession(w, alice);

    // Link Last.fm (web auth: our api_key, a single-use state, a signed auth.getSession) …
    const start = await w.send('POST', '/api/v1/links/lastfm/start', { as: session });
    expect(start.status).toBe(200);
    const authorizeUrl = new URL((start.body as { authorizeUrl: string }).authorizeUrl);
    const cb = new URL(authorizeUrl.searchParams.get('cb') as string);
    const lfToken = w.lastfm.issueToken();
    w.lastfm.authorizeToken(lfToken, 'alice_fm');
    const linked = await w.send('GET', `${cb.pathname}${cb.search}&token=${lfToken}`, { as: session });
    expect(linked.status).toBe(303);
    // … and ListenBrainz (a user token checked through validate-token).
    w.lb.addToken('alice_lb', 'alice-listenbrainz-user-token');
    const lbLink = await w.send('POST', '/api/v1/links/listenbrainz', {
      as: session,
      body: { token: 'alice-listenbrainz-user-token' },
    });
    expect(lbLink.status).toBe(201);
    expect(w.db.all('SELECT service, status FROM linked_accounts ORDER BY service')).toEqual([
      { service: 'lastfm', status: 'active' },
      { service: 'listenbrainz', status: 'active' },
    ]);

    const form = panoScrobble(sk, { artist: 'Portishead', track: 'Roads', album: 'Dummy', timestamp: T0_S - 300 });
    const first = await w.lastfm2(form);
    expect(first.body).toMatchObject({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
    expect(w.count('forward_outbox', "kind = 'scrobble'")).toBe(2);

    const lbSingles = () => w.lb.submissions.filter((s) => s.listenType === 'single');
    await w.until(() => w.lastfm.scrobbles.length === 1 && lbSingles().length === 1);
    // Let every timer run again for a while: nothing more is sent.
    for (let i = 0; i < 5; i++) {
      w.advance(60_000);
      await w.pump();
    }
    expect(w.lastfm.scrobbles).toHaveLength(1);
    expect(w.lastfm.scrobbles[0]?.items).toEqual([
      expect.objectContaining({ artist: 'Portishead', track: 'Roads', album: 'Dummy', timestamp: String(T0_S - 300) }),
    ]);
    expect(w.lastfm.history('alice_fm').map((l) => [l.artist, l.track, l.uts])).toEqual([
      ['Portishead', 'Roads', T0_S - 300],
    ]);
    expect(lbSingles()).toHaveLength(1);
    expect(lbSingles()[0]?.user).toBe('alice_lb');
    expect((lbSingles()[0] as { json: { payload: unknown[] } }).json.payload).toEqual([
      expect.objectContaining({
        listened_at: T0_S - 300,
        track_metadata: expect.objectContaining({
          artist_name: 'Portishead',
          track_name: 'Roads',
          release_name: 'Dummy',
        }),
      }),
    ]);
    const forwardRows = w.db.all('SELECT id, link_id, kind, state, attempts FROM forward_outbox ORDER BY id');
    const operations = w.db.all('SELECT id, kind, state FROM operations ORDER BY id');
    const listenKeys = w.count('listen_keys');
    const records = (await alice.repo.list(SCROBBLE)).length;
    expect(records).toBe(1);

    // The resend (a client retrying after a timeout) is the same listen: nothing new anywhere.
    const resent = await w.lastfm2(form);
    expect(resent.status).toBe(200);
    for (let i = 0; i < 5; i++) {
      w.advance(60_000);
      await w.pump();
    }
    expect(w.lastfm.scrobbles).toHaveLength(1);
    expect(lbSingles()).toHaveLength(1);
    expect(w.db.all('SELECT id, link_id, kind, state, attempts FROM forward_outbox ORDER BY id')).toEqual(forwardRows);
    expect(w.db.all('SELECT id, kind, state FROM operations ORDER BY id')).toEqual(operations);
    expect(w.count('listen_keys')).toBe(listenKeys);
    expect((await alice.repo.list(SCROBBLE)).length).toBe(1);
  }, 60_000);

  it('a ListenBrainz client validate-token, playing_now and single listen appear in /1/user/{u}/listens, playing-now and stats', async () => {
    const { w, alice } = await startWorld();
    const session = await w.signIn(alice);
    const created = await w.send('POST', '/api/v1/account/listenbrainz-tokens', {
      as: session,
      body: { label: 'Navidrome' },
    });
    expect(created.status).toBe(201);
    const token = (created.body as { token: string }).token;
    const auth = { authorization: `Token ${token}` };

    const validated = await w.send('GET', '/1/validate-token', { headers: auth });
    expect(validated.status).toBe(200);
    expect(validated.body).toMatchObject({ code: 200, message: 'Token valid.', valid: true });
    const user = (validated.body as { user_name: string }).user_name;
    expect(user).toBe(alice.handle);

    const playing = await w.send('POST', '/1/submit-listens', {
      headers: auth,
      body: {
        listen_type: 'playing_now',
        payload: [
          {
            track_metadata: {
              artist_name: 'Boards of Canada',
              track_name: 'Roygbiv',
              release_name: 'Music Has the Right to Children',
            },
          },
        ],
      },
    });
    expect(playing.status).toBe(200);
    expect(playing.body).toEqual({ status: 'ok' });
    const single = await w.send('POST', '/1/submit-listens', {
      headers: auth,
      body: {
        listen_type: 'single',
        payload: [
          {
            listened_at: T0_S - 600,
            track_metadata: {
              artist_name: 'Aphex Twin',
              track_name: 'Xtal',
              release_name: 'Selected Ambient Works 85-92',
              additional_info: { submission_client: 'Navidrome', duration_ms: 293000 },
            },
          },
        ],
      },
    });
    expect(single.status).toBe(200);
    expect(single.body).toEqual({ status: 'ok' });

    await w.until(() => w.count('scrobbles', 'did = ?', alice.did) === 1);
    const [record] = await alice.repo.list(SCROBBLE);
    expect(record?.value).toMatchObject({ artist: 'Aphex Twin', track: 'Xtal' });

    const listens = await w.send('GET', `/1/user/${user}/listens`);
    expect(listens.status).toBe(200);
    const payload = (
      listens.body as { payload: { count: number; user_id: string; listens: Array<Record<string, unknown>> } }
    ).payload;
    expect(payload.count).toBe(1);
    expect(payload.user_id).toBe(user);
    expect(payload.listens[0]).toMatchObject({
      listened_at: T0_S - 600,
      track_metadata: expect.objectContaining({
        artist_name: 'Aphex Twin',
        track_name: 'Xtal',
        release_name: 'Selected Ambient Works 85-92',
      }),
    });

    const now = await w.send('GET', `/1/user/${user}/playing-now`);
    expect(now.status).toBe(200);
    const nowPayload = (
      now.body as { payload: { count: number; playing_now: boolean; listens: Array<Record<string, unknown>> } }
    ).payload;
    expect(nowPayload).toMatchObject({ count: 1, playing_now: true });
    expect(nowPayload.listens[0]).toMatchObject({
      playing_now: true,
      track_metadata: expect.objectContaining({ artist_name: 'Boards of Canada', track_name: 'Roygbiv' }),
    });

    const stats = await w.send('GET', `/1/stats/user/${user}/artists?range=all_time`);
    expect(stats.status).toBe(200);
    const statsPayload = (
      stats.body as { payload: { artists: Array<Record<string, unknown>>; total_artist_count: number } }
    ).payload;
    expect(statsPayload.total_artist_count).toBe(1);
    expect(statsPayload.artists).toEqual([expect.objectContaining({ artist_name: 'Aphex Twin', listen_count: 1 })]);
    const recordings = await w.send('GET', `/1/stats/user/${user}/recordings?range=all_time`);
    expect(recordings.status).toBe(200);
    expect((recordings.body as { payload: { recordings: Array<Record<string, unknown>> } }).payload.recordings).toEqual(
      [expect.objectContaining({ track_name: 'Xtal', artist_name: 'Aphex Twin', listen_count: 1 })],
    );
  }, 60_000);
});
