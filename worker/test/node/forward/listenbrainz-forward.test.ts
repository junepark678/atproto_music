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
import { LASTFM_EXPIRY_MS, LISTENBRAINZ_EXPIRY_MS } from '../../../src/forward/forward-outbox';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
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

const listensOf = (s: LbSubmission) =>
  (s.json as { payload: Array<{ track_metadata: { track_name: string } }> }).payload;

describe('ListenBrainz forwarding', () => {
  it('a live listen goes as single, a backlog as import batches of at most 100, now playing as playing_now once', async () => {
    const w = await world();
    w.link();

    // One live listen: `single`, with the original metadata and our Token.
    w.scrobbles(1);
    await w.run();
    expect(w.lb.submissions).toHaveLength(1);
    expect(w.lb.submissions[0]).toMatchObject({
      user: 'alice_lb',
      token: TOKEN,
      scheme: 'Token',
      listenType: 'single',
    });
    expect(w.lb.submissions[0]?.json).toEqual({
      listen_type: 'single',
      payload: [
        {
          listened_at: Date.parse('2026-01-14T00:01:00Z') / 1000,
          track_metadata: {
            artist_name: 'Artist 1',
            track_name: 'Track 1',
            release_name: 'Album',
            additional_info: { recording_mbid: MBID, duration_ms: 180_000 },
          },
        },
      ],
    });

    // A backlog of 250: import batches of 100, 100 and 50, oldest first, one request per second.
    w.scrobbles(250);
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      const report = await w.run();
      expect(report.requests).toBe(1);
    }
    const imports = w.lb.submissions.slice(1);
    expect(imports.map((s) => [s.listenType, listensOf(s).length])).toEqual([
      ['import', 100],
      ['import', 100],
      ['import', 50],
    ]);
    expect(imports.flatMap((s) => listensOf(s).map((l) => l.track_metadata.track_name))).toEqual(
      Array.from({ length: 250 }, (_, i) => `Track ${i + 2}`),
    );
    const times = w.seen.map(([, , t]) => t);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(SECOND);
    expect(w.rows().every((r) => r.state === 'sent')).toBe(true);

    // Now playing: `playing_now` without listened_at, sent once.
    w.clock.advance(SECOND);
    const startedAtMs = w.clock.nowMs();
    const play: ForwardItem = {
      kind: 'nowplaying',
      startedAtMs,
      artist: 'Band',
      track: 'Song',
      payload: { track: { artist: 'Band', track: 'Song', album: 'Record' }, startedAtMs, origin: 'listenbrainz' },
    };
    expect(w.enqueue([play])).toBe(1);
    await w.run();
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const playing = w.lb.submissions.filter((s) => s.listenType === 'playing_now');
    expect(playing.map((s) => s.json)).toEqual([
      {
        listen_type: 'playing_now',
        payload: [{ track_metadata: { artist_name: 'Band', track_name: 'Song', release_name: 'Record' } }],
      },
    ]);
    expect(w.lb.playingNow('alice_lb')).toMatchObject({ artist_name: 'Band', track_name: 'Song' });

    // A now playing that fails (503) is not retried.
    w.clock.advance(SECOND);
    const again = w.clock.nowMs();
    w.enqueue([
      { ...play, startedAtMs: again, payload: { track: { artist: 'Band', track: 'Song' }, startedAtMs: again } },
    ]);
    w.lb.fail({ status: 503, path: '/1/submit-listens' });
    await w.run();
    const failed = w.rows().at(-1);
    expect(failed).toMatchObject({ kind: 'nowplaying', state: 'failed', attempts: 1 });
    expect(failed?.last_error).toMatch(/^http_503: /);
    const count = w.seen.length;
    for (let i = 0; i < 5; i++) {
      w.clock.advance(MINUTE);
      await w.run();
    }
    expect(w.seen.length).toBe(count);
  });

  it('love and unlove go as recording feedback by MBID, and without an MBID they are not forwarded', async () => {
    const w = await world();
    w.link();
    const toggle = (kind: 'love' | 'unlove', operationId: string, recordingMbid?: string): ForwardItem => ({
      kind,
      operationId,
      payload: { artist: 'Band', track: 'Song', ...(recordingMbid ? { recordingMbid } : {}), origin: 'web' },
    });
    w.enqueue([toggle('love', 'op-1', MBID), toggle('love', 'op-2'), toggle('unlove', 'op-3', MBID)]);
    for (let i = 0; i < 4; i++) {
      await w.run();
      w.clock.advance(SECOND);
    }
    expect(w.lb.feedback.map((f) => f.json)).toEqual([
      { recording_mbid: MBID, score: 1 },
      { recording_mbid: MBID, score: 0 },
    ]);
    expect(w.rows().map((r) => [r.dedupe_key, r.state, r.last_error])).toEqual([
      ['op-1', 'sent', null],
      ['op-2', 'ignored', 'no_recording_mbid'],
      ['op-3', 'sent', null],
    ]);
    expect(w.seen.map(([m, p]) => `${m} ${p}`)).toEqual([
      'POST /1/feedback/recording-feedback',
      'POST /1/feedback/recording-feedback',
    ]);
  });

  it('401 revokes the link; 429 waits X-RateLimit-Reset-In; 400 marks the row failed with the upstream error and does not retry', async () => {
    const w = await world();
    const id = w.link();

    // 401: link revoked, every queued row held.
    w.scrobbles(2);
    w.lb.fail({ status: 401 });
    await w.run();
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', id)).toEqual({
      status: 'revoked',
      last_error: 'token_revoked',
    });
    expect(w.rows().map((r) => r.state)).toEqual(['held', 'held']);
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.seen).toHaveLength(1);

    // Relinked: the held rows resume.
    w.lb.addToken('alice_lb', 'new-token');
    w.link('new-token');
    expect(w.rows().map((r) => r.state)).toEqual(['queued', 'queued']);

    // 429: the rows (and the link) wait X-RateLimit-Reset-In seconds, without an attempt counted.
    w.lb.fail({ status: 429, resetIn: 42 });
    const limitedAt = w.clock.nowMs();
    await w.run();
    expect(w.rows().map((r) => [r.state, r.due_at, r.attempts, r.last_error])).toEqual([
      ['queued', limitedAt + 42 * SECOND, 0, 'rate_limited'],
      ['queued', limitedAt + 42 * SECOND, 0, 'rate_limited'],
    ]);
    const seenAfter429 = w.seen.length;
    for (let s = 1; s < 42; s += 10) {
      w.clock.set(new Date(limitedAt + s * SECOND).toISOString());
      await w.run();
    }
    expect(w.seen.length).toBe(seenAfter429);
    w.clock.set(new Date(limitedAt + 42 * SECOND).toISOString());
    await w.run();
    expect(w.seen.length).toBe(seenAfter429 + 1);
    expect(w.lb.submissions.at(-1)).toMatchObject({ token: 'new-token', listenType: 'import' });
    expect(w.rows().map((r) => r.state)).toEqual(['sent', 'sent']);

    // 400 on a single listen: failed with ListenBrainz's error text, never retried.
    const refusal = () =>
      new Response(JSON.stringify({ code: 400, error: 'Value for key listened_at is too low.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    w.clock.advance(SECOND);
    w.scrobbles(1, 'bad');
    w.intercept(refusal);
    await w.run();
    const bad = w.rows().find((r) => r.dedupe_key.startsWith('bad'));
    expect(bad).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error: 'http_400: Value for key listened_at is too low.',
    });
    const seenAfter400 = w.seen.length;
    for (let i = 0; i < 5; i++) {
      w.clock.advance(MINUTE);
      await w.run();
    }
    expect(w.seen.length).toBe(seenAfter400);

    // A 400 on an import: each listen is tried alone, so only the bad one fails.
    w.scrobbles(3, 'batch');
    w.intercept(refusal); // the import
    await w.run();
    w.intercept(refusal); // the first listen alone
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const batch = w.rows().filter((r) => r.dedupe_key.startsWith('batch'));
    expect(batch.map((r) => r.state)).toEqual(['failed', 'sent', 'sent']);
    expect(w.seen.slice(seenAfter400).map(([m, p]) => `${m} ${p}`)).toEqual(Array(4).fill('POST /1/submit-listens'));
    expect(w.lb.submissions.slice(-2).map((s) => s.listenType)).toEqual(['single', 'single']);
  });

  it('a 401 for a request sent before a relink leaves the relinked account active with its rows queued', async () => {
    const w = await world();
    const id = w.link();
    w.scrobbles(2);
    // The import is held in flight until `release`; it then reaches the fake,
    // which answers 401 because the old token was reset in the meantime.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    w.intercept(async (req) => {
      arrived();
      await gate;
      return w.lb.fetch(req);
    });

    const running = w.run();
    await inFlight;
    w.lb.addToken('alice_lb', 'new-token');
    expect(w.link('new-token')).toBe(id);
    w.lb.revokeToken(TOKEN);
    release();
    const report = await running;

    expect(report.requests).toBe(1);
    expect(w.lb.submissions).toHaveLength(0);
    // The refusal was of the old token: the fresh link is not revoked and its rows are not held.
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', id)).toEqual({
      status: 'active',
      last_error: null,
    });
    expect(w.rows().map((r) => r.state)).toEqual(['queued', 'queued']);

    // The next run sends them with the new token.
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.lb.submissions).toHaveLength(1);
    expect(w.lb.submissions[0]).toMatchObject({ token: 'new-token', listenType: 'import' });
    expect(w.rows().map((r) => r.state)).toEqual(['sent', 'sent']);
  });

  it('ListenBrainz rows expire after 30 days, not 13', async () => {
    const w = await world();
    const lbId = w.link();
    const sk = w.lastfm.addSession('alice_fm');
    const fmId = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk },
    ).link.id;
    const t0 = w.clock.nowMs();
    w.scrobbles(1, 'old'); // one row per link
    const byLink = (tag: string) => {
      const rows = w.rows().filter((r) => r.dedupe_key.startsWith(tag));
      return { lb: rows.find((r) => r.link_id === lbId), fm: rows.find((r) => r.link_id === fmId) };
    };

    // 14 days later: the Last.fm row has expired (13 days), the ListenBrainz one is still sent.
    w.clock.set(new Date(t0 + 14 * DAY).toISOString());
    const report = await w.run();
    expect(report.expired?.aged).toBe(1);
    expect(byLink('old').fm).toMatchObject({ state: 'expired', last_error: 'expired' });
    expect(byLink('old').lb).toMatchObject({ state: 'sent' });
    expect(w.lastfm.scrobbles).toHaveLength(0);
    expect(w.lb.submissions).toHaveLength(1);
    expect(14 * DAY).toBeGreaterThan(LASTFM_EXPIRY_MS);

    // A ListenBrainz row that cannot be delivered (the link is revoked and relinked late,
    // or the upstream keeps failing) expires once it is more than 30 days old.
    w.scrobbles(1, 'late');
    const t1 = w.clock.nowMs();
    w.lb.fail({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    w.clock.set(new Date(t1 + 29 * DAY).toISOString());
    await w.run();
    expect(byLink('late').lb).toMatchObject({ state: 'queued', attempts: 1 });
    w.clock.set(new Date(t1 + LISTENBRAINZ_EXPIRY_MS + 1).toISOString());
    const late = await w.run();
    expect(late.expired?.aged).toBe(1);
    expect(late.requests).toBe(0);
    expect(byLink('late').lb).toMatchObject({ state: 'expired', last_error: 'expired', attempts: 1 });
  });
});
