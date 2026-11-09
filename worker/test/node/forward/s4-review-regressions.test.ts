// Forwarding to linked ListenBrainz accounts (ADR 0005 §12.2, §12.3, §11.3;
// N3-08): `single` for a live listen, `import` batches of ≤ 100 for a
// backlog, `playing_now` once, recording feedback by MBID, 401 revocation,
// the X-RateLimit-Reset-In wait on 429, 400 as a permanent failure, and the
// 30-day expiry.
//
// The real composition (support/app.ts) with the links feature, the frozen
// clock 2026-01-15T12:00:00Z (stepped, never slept) and seeded randomness.
// ListenBrainz is the fake at listenbrainz.test behind the fixture router; it
// accepts a submission only with a registered `Token`.

import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { nextDeleteWakeAt, runDeleteSlice } from '../../../src/forward/delete-forwarder';
import { type ForwardRuntime, forwardExtension, runForward } from '../../../src/forward/forwarder';
import { saveLink } from '../../../src/forward/links';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz, type LbSubmission } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

interface World {
  app: TestApp;
  clock: FixedClock;
  lb: FakeListenBrainz;
  lastfm: FakeLastfm;
  rt: ForwardRuntime;
  /** Every request to listenbrainz.test: [method, path, clock ms]. */
  seen: Array<[string, string, number]>;
  /** Answers the next ListenBrainz request with this response instead of the fake (which `res` may still call). */
  intercept(res: (req: Request) => Response | Promise<Response>): void;
  link(credential?: string): string;
  scrobbles(n: number, tag?: string): void;
  enqueue(items: ForwardItem[]): number;
  rows(): ForwardOutboxRow[];
  run(): ReturnType<typeof runForward>;
}

async function world(): Promise<World> {
  const clock = fixedClock();
  const lb = new FakeListenBrainz({ clock, rateLimit: 10_000 });
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  lb.addToken('alice_lb', TOKEN);
  const seen: Array<[string, string, number]> = [];
  const intercepts: Array<(req: Request) => Response | Promise<Response>> = [];
  const lbEndpoint = async (req: Request) => {
    const url = new URL(req.url);
    seen.push([req.method, url.pathname, clock.nowMs()]);
    const next = intercepts.shift();
    return next === undefined ? lb.fetch(req) : next(req);
  };
  const app = await startApp({
    clock,
    secrets: parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } }),
    transport: routerTransport({ hosts: { 'listenbrainz.test': lbEndpoint, 'lastfm.test': lastfm } }),
    features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
    env: {
      LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
      LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
      LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
    },
  });
  ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
  const rt = (app.composed.app as unknown as { links: LinksService }).links.forwarding;
  const random = seededRandom(23);
  let seq = 0;
  const w: World = {
    app,
    clock,
    lb,
    lastfm,
    rt,
    seen,
    intercept: (res) => intercepts.push(res),
    link(credential = TOKEN) {
      return saveLink(
        { db: app.db, clock, random: rt.random, box: rt.box },
        { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential },
      ).link.id;
    },
    enqueue: (items) => enqueueForwards(app.db, { did: ALICE, items, now: clock.nowMs(), random }),
    scrobbles(n, tag = 's') {
      const items: ForwardItem[] = [];
      for (let i = 0; i < n; i++) {
        seq += 1;
        items.push({
          kind: 'scrobble',
          listenKey: `${tag}-${seq}`,
          payload: {
            listen: {
              artist: `Artist ${seq}`,
              track: `Track ${seq}`,
              listenedAt: new Date(Date.parse('2026-01-14T00:00:00Z') + seq * MINUTE).toISOString(),
              album: 'Album',
              recordingMbid: MBID,
              durationSeconds: 180,
            },
            origin: 'listenbrainz',
          },
        });
      }
      w.enqueue(items);
    },
    rows: () => app.db.all<ForwardOutboxRow>('SELECT * FROM forward_outbox ORDER BY created_at_ms, rowid'),
    run: () => runForward(rt, clock.nowMs()),
  };
  return w;
}

afterEach(async () => {
  await closeApps();
});

const _listensOf = (s: LbSubmission) =>
  (s.json as { payload: Array<{ track_metadata: { track_name: string } }> }).payload;

function queueDelete(w: World, linkId: string, id: string, listenedAt: number, artist: string, track: string) {
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  const now = w.clock.nowMs();
  w.app.db.run(
    `INSERT INTO listenbrainz_deletes
    (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
    VALUES(?,?,?,1,?,?, ?,?,?,?,?,'api','queued',0,?,?,?,?)`,
    id,
    id,
    linkId,
    ALICE,
    id,
    listenedAt,
    artistKey,
    trackKeyValue,
    artist,
    track,
    now,
    now + 7 * DAY,
    now,
    now,
  );
}

const depsOf = (w: World) => ({
  db: w.app.db,
  clock: w.clock,
  random: w.rt.random,
  box: w.rt.box,
  client: w.rt.listenbrainz,
  pacing: w.rt.pacing,
});
it('review: lookup 429 holds the shared bucket for Reset-In', async () => {
  const w = await world();
  const id = w.link();
  queueDelete(w, id, 'rate', 1768392000, 'A', 'T');
  const now = w.clock.nowMs();
  w.intercept(
    () => new Response('{}', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-in': '600' } }),
  );
  await runDeleteSlice(depsOf(w));
  expect(w.seen).toHaveLength(1);
  expect(w.app.db.one('SELECT attempts FROM listenbrainz_deletes WHERE id=?', 'rate')).toEqual({ attempts: 1 });
  expect(
    w.app.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', 'rate')!.due_at,
  ).toBeGreaterThanOrEqual(now + 600000);
  expect(w.rt.pacing.listenbrainzAvailableAt(`link:${id}:generation:1`)).toBe(now + 600000);
});
it('review: malformed HTTP success still informs pacing and persists its reset hold', async () => {
  const w = await world();
  const id = w.link();
  queueDelete(w, id, 'malformed-rate', 1768392000, 'A', 'T');
  const now = w.clock.nowMs();
  w.intercept(() =>
    Response.json(
      { payload: { listens: [{}] } },
      { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-in': '600' } },
    ),
  );
  expect((await runDeleteSlice(depsOf(w))).state).toBe('lookup_retry');
  expect(w.rt.pacing.listenbrainzAvailableAt(`link:${id}:generation:1`)).toBe(now + 600000);
  expect(
    w.app.db.one<{ due_at: number; last_error: string }>(
      'SELECT due_at,last_error FROM listenbrainz_deletes WHERE id=?',
      'malformed-rate',
    ),
  ).toMatchObject({ last_error: 'malformed_response' });
  expect(
    w.app.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', 'malformed-rate')!.due_at,
  ).toBeGreaterThanOrEqual(now + 600000);
});
it('review: expired rows settle when due_at is after deadline', async () => {
  const w = await world();
  const id = w.link();
  queueDelete(w, id, 'deadline', 1768392000, 'A', 'T');
  const now = w.clock.nowMs();
  w.app.db.run(
    'UPDATE listenbrainz_deletes SET due_at=?,deadline_at=? WHERE id=?',
    now + 60000,
    now + 5000,
    'deadline',
  );
  w.clock.advance(5000);
  await runDeleteSlice(depsOf(w));
  expect(w.seen).toHaveLength(0);
  expect(w.app.db.one('SELECT state FROM listenbrainz_deletes WHERE id=?', 'deadline')).toEqual({ state: 'expired' });
  expect(nextDeleteWakeAt({ db: w.app.db, pacing: w.rt.pacing }, w.clock.nowMs())).toBeNull();
});
it('review: paced first account must not block another due account', async () => {
  const w = await world();
  const first = w.link();
  queueDelete(w, first, 'first', 1768392000, 'A', 'T');
  const bob = 'did:plc:bobbobbobbobbobbobbobbob';
  ensureAccount({ db: w.app.db, clock: w.clock }, { did: bob, verifiedHandle: null });
  const second = saveLink(
    { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
    { did: bob, service: 'listenbrainz', remoteUser: 'bob_lb', credential: TOKEN },
  ).link.id;
  w.clock.advance(1);
  queueDelete(w, second, 'second', 1768392000, 'A', 'T');
  w.rt.pacing.deferListenbrainz(`link:${first}:generation:1`, w.clock.nowMs() + 600000);
  w.intercept(() => Response.json({ payload: { listens: [] } }));
  await runDeleteSlice(depsOf(w));
  expect(w.seen).toHaveLength(1);
  expect(w.seen[0]![1]).toBe('/1/user/bob_lb/listens');
});
it('review: a live forward for one link does not suppress another link delete in the production timer', async () => {
  const w = await world();
  const aliceLink = w.link();
  queueDelete(w, aliceLink, 'alice-delete', 1768392000, 'A', 'T');
  const bob = 'did:plc:bobbobbobbobbobbobbobbob';
  ensureAccount({ db: w.app.db, clock: w.clock }, { did: bob, verifiedHandle: null });
  w.lb.addToken('bob_lb', TOKEN);
  saveLink(
    { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
    { did: bob, service: 'listenbrainz', remoteUser: 'bob_lb', credential: TOKEN },
  );
  enqueueForwards(w.app.db, {
    did: bob,
    now: w.clock.nowMs(),
    random: seededRandom(29),
    items: [
      {
        kind: 'scrobble',
        listenKey: 'bob-live',
        payload: {
          listen: { artist: 'Bob Artist', track: 'Bob Track', listenedAt: '2026-01-15T11:00:00Z' },
          origin: 'web',
        },
      },
    ],
  });
  const extension = forwardExtension(() => w.rt);
  const timer = extension.timers?.forward;
  expect(timer).toBeDefined();
  await timer!(w.clock.nowMs(), { schedule: () => null, deps: {} as never } as never);
  expect(w.seen.map(([, path]) => path)).toContain('/1/submit-listens');
  expect(w.seen.map(([, path]) => path)).toContain('/1/user/alice_lb/listens');
  expect(w.app.db.one('SELECT state FROM listenbrainz_deletes WHERE id=?', 'alice-delete')).toEqual({
    state: 'ignored',
  });
});
it('review: repeated deletion failures update current link health', async () => {
  const w = await world();
  const id = w.link();
  queueDelete(w, id, 'health', 1768392000, 'A', 'T');
  const failureTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    w.intercept(() => new Response('{}', { status: 503 }));
    await runDeleteSlice(depsOf(w));
    failureTimes.push(w.clock.nowMs());
    const row = w.app.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', 'health')!;
    w.clock.advance(row.due_at - w.clock.nowMs());
  }
  expect(w.seen).toHaveLength(3);
  expect(w.app.db.one('SELECT attempts FROM listenbrainz_deletes WHERE id=?', 'health')).toEqual({ attempts: 3 });
  const link = w.app.db.one<{
    last_error: string | null;
    consecutive_failures: number;
    last_failure_ms: number | null;
  }>('SELECT last_error,consecutive_failures,last_failure_ms FROM linked_accounts WHERE id=?', id)!;
  expect(link.consecutive_failures).toBe(3);
  expect(link.last_error).not.toBeNull();
  expect(link.last_failure_ms).toBe(failureTimes[2]);
  const due = w.app.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', 'health')!.due_at;
  w.clock.advance(due - w.clock.nowMs());
  w.intercept(() => Response.json({ payload: { listens: [] } }));
  await runDeleteSlice(depsOf(w));
  const recovered = w.app.db.one<{
    last_error: string | null;
    consecutive_failures: number;
    last_success_ms: number | null;
  }>('SELECT last_error,consecutive_failures,last_success_ms FROM linked_accounts WHERE id=?', id)!;
  expect(recovered).toMatchObject({ last_error: null, consecutive_failures: 0 });
  expect(recovered.last_success_ms).not.toBeNull();
});
