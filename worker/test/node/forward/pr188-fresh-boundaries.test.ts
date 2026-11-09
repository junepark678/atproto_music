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
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { SqlParam } from '../../../src/do/db';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { saveLink } from '../../../src/forward/links';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

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

describe('fresh independent boundary tests', () => {
  it('bounds unlove MBID lookup across unrelated queued love backlog', async () => {
    const counts: number[] = [];
    for (const count of [1000, 10000]) {
      const w = await world();
      w.link();
      enqueueForwards(w.app.db, {
        did: ALICE,
        now: w.clock.nowMs(),
        dueAt: w.clock.nowMs() + 3600000,
        random: seededRandom(93),
        items: Array.from({ length: count }, (_, i) => ({
          kind: 'love' as const,
          operationId: `prior-${i}`,
          payload: { artist: `Band ${i}`, track: `Song ${i}`, recordingMbid: MBID },
        })),
      });
      w.clock.advance(1);
      w.enqueue([
        { kind: 'unlove', operationId: 'independent-unlove', payload: { artist: 'Not prior', track: 'Not prior' } },
      ]);
      const all = w.app.db.all.bind(w.app.db);
      const one = w.app.db.one.bind(w.app.db);
      let fetched = 0;
      w.app.db.all = ((sql: string, ...args: SqlParam[]) => {
        const rows = all(sql, ...args);
        if (sql.includes('SELECT payload_json FROM forward_outbox')) fetched += rows.length;
        return rows;
      }) as typeof all;
      w.app.db.one = ((sql: string, ...args: SqlParam[]) => {
        const row = one(sql, ...args);
        if (sql.includes('SELECT payload_json FROM forward_outbox') && row !== null) fetched += 1;
        return row;
      }) as typeof one;
      try {
        await w.run();
      } finally {
        w.app.db.all = all;
        w.app.db.one = one;
      }
      counts.push(fetched);
    }
    expect(counts[1]).toBeLessThanOrEqual(32);
  });
  it('bounds fetched lane rows when multiple successful picks fit in a run', async () => {
    const w = await world();
    w.link();
    w.enqueue(
      Array.from({ length: 100 }, (_, i) => ({
        kind: 'love' as const,
        operationId: `ready-${i}`,
        payload: { artist: `Artist ${i}`, track: `Song ${i}`, recordingMbid: MBID },
      })),
    );
    for (let i = 0; i < 5; i++)
      w.intercept(async (req) => {
        const r = await w.lb.fetch(req);
        w.clock.advance(1000);
        return r;
      });
    const all = w.app.db.all.bind(w.app.db);
    let fetched = 0;
    w.app.db.all = ((sql: string, ...args: SqlParam[]) => {
      const rows = all(sql, ...args);
      if (sql.includes('SELECT rowid,love_artist_key,love_track_key,priority,due_at,head_created_at_ms'))
        fetched += rows.length;
      return rows;
    }) as typeof all;
    try {
      await w.run();
    } finally {
      w.app.db.all = all;
    }
    expect(fetched).toBeLessThanOrEqual(32);
  });
});

it('orders ready love links by their oldest head, not link id', async () => {
  const w = await world();
  const a = w.link();
  const bob = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb';
  const token = '6d8e4f2b-1a9c-4f2d-8b7e-3c5d1f9a2b6c';
  w.lb.addToken('bob_lb', token);
  ensureAccount({ db: w.app.db, clock: w.clock }, { did: bob, verifiedHandle: null });
  const b = saveLink(
    { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
    { did: bob, service: 'listenbrainz', remoteUser: 'bob_lb', credential: token },
  ).link.id;
  const links = [
    { id: a, did: ALICE, user: 'alice_lb' },
    { id: b, did: bob, user: 'bob_lb' },
  ].sort((a, b) => a.id.localeCompare(b.id));
  for (const [i, l] of links.entries())
    enqueueForwards(w.app.db, {
      did: l.did,
      linkId: l.id,
      now: w.clock.nowMs() - (i === 1 ? 10000 : 0),
      random: seededRandom(38 + i),
      items: [
        { kind: 'love', operationId: `age-${i}`, payload: { artist: `Age ${i}`, track: 'Song', recordingMbid: MBID } },
      ],
    });
  await runForward(w.rt, w.clock.nowMs(), { maxRequests: 1 });
  expect(w.lb.feedback[0]?.user).toBe(links[1]!.user);
});

it('does not starve an older sixth account behind five newer love backlogs', async () => {
  const w = await world();
  const links: Array<{ id: string; did: string; user: string }> = [];
  for (let i = 0; i < 6; i++) {
    const did = `did:plc:${String.fromCharCode(97 + i).repeat(24)}`;
    const user = `user_${i}`;
    const token = `token-${i}`;
    w.lb.addToken(user, token);
    ensureAccount({ db: w.app.db, clock: w.clock }, { did, verifiedHandle: null });
    const id = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did, service: 'listenbrainz', remoteUser: user, credential: token },
    ).link.id;
    links.push({ id, did, user });
  }
  links.sort((a, b) => a.id.localeCompare(b.id));
  for (const [i, l] of links.entries())
    enqueueForwards(w.app.db, {
      did: l.did,
      linkId: l.id,
      now: w.clock.nowMs() - (i === 5 ? 10000 : 0),
      random: seededRandom(48 + i),
      items: Array.from({ length: i === 5 ? 1 : 20 }, (_, j) => ({
        kind: 'love' as const,
        operationId: `account-${i}-${j}`,
        payload: { artist: `Artist ${i}-${j}`, track: 'Song', recordingMbid: MBID },
      })),
    });
  for (let i = 0; i < 10; i++) {
    await w.run();
    w.clock.advance(1000);
  }
  expect(w.lb.feedback.some((f) => f.user === links[5]!.user)).toBe(true);
});
