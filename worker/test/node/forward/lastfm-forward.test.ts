// Forwarding to linked Last.fm accounts (ADR 0005 §12.2, §12.3, §11.3, §3.5;
// N3-08): signed track.scrobble batches of ≤ 50 under the global 1 request/s
// bucket, per-item ignored codes, retry with backoff, the 13-day expiry,
// revocation and hold, the global key pause, now playing once, love toggles
// in order, and every request through policyFetch.
//
// The real composition (support/app.ts) with the links feature, the frozen
// clock 2026-01-15T12:00:00Z (stepped, never slept) and seeded randomness.
// Last.fm is the signature-verifying fake at lastfm.test behind the fixture
// router: a request whose api_sig does not verify is answered with error 13,
// so every 200 below is a verified signature. Forward rows are queued with
// N2-05's enqueueForwards / enqueueLove, as live ingress queues them.

import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { BACKOFF_BASE_MS, LASTFM_EXPIRY_MS, LASTFM_KEY_REJECTED } from '../../../src/forward/forward-outbox';
import { type ForwardRuntime, KEY_REJECTED_PROBE_MS, runForward } from '../../../src/forward/forwarder';
import { LASTFM_CAPS, LastfmClient } from '../../../src/forward/lastfm-client';
import { saveLink } from '../../../src/forward/links';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const BOB = 'did:plc:bobbobbobbobbobbobbobbobb';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const UPSTREAM_ENV = {
  LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
  LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
  LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
};

interface World {
  app: TestApp;
  clock: FixedClock;
  lastfm: FakeLastfm;
  lb: FakeListenBrainz;
  rt: ForwardRuntime;
  service: LinksService;
  /** Every request the router saw: [host, path, clock ms]. */
  seen: Array<[string, string, number]>;
  /** Links a Last.fm account for `did` with a fresh fake session; returns the link id and the sk. */
  linkLastfm(did: string, user: string): { id: string; sk: string };
  /** Queues scrobbles for `did` (listen times 1 min apart, oldest first). */
  scrobbles(did: string, n: number, tag?: string): void;
  rows(did?: string): ForwardOutboxRow[];
  run(): ReturnType<typeof runForward>;
}

let enqueueRandom = seededRandom(11);

async function world(
  options: { transportWrap?: (fake: FakeLastfm) => (req: Request) => Promise<Response> } = {},
): Promise<World> {
  const clock = fixedClock();
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  const lb = new FakeListenBrainz({ clock });
  const seen: Array<[string, string, number]> = [];
  const record = (endpoint: { fetch(req: Request): Promise<Response> }) => async (req: Request) => {
    const url = new URL(req.url);
    seen.push([url.hostname, url.pathname, clock.nowMs()]);
    return endpoint.fetch(req);
  };
  const lastfmEndpoint = options.transportWrap ? { fetch: options.transportWrap(lastfm) } : lastfm;
  const secrets = parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } });
  const app = await startApp({
    clock,
    secrets,
    transport: routerTransport({ hosts: { 'lastfm.test': record(lastfmEndpoint), 'listenbrainz.test': record(lb) } }),
    features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
    env: UPSTREAM_ENV,
  });
  for (const did of [ALICE, BOB]) ensureAccount({ db: app.db, clock }, { did, verifiedHandle: null });
  const service = (app.composed.app as unknown as { links: LinksService }).links;
  const rt = service.forwarding;
  enqueueRandom = seededRandom(11);
  let listenSeq = 0;
  const w: World = {
    app,
    clock,
    lastfm,
    lb,
    rt,
    service,
    seen,
    linkLastfm(did, user) {
      const sk = lastfm.addSession(user);
      const saved = saveLink(
        { db: app.db, clock, random: rt.random, box: rt.box },
        { did, service: 'lastfm', remoteUser: user, credential: sk },
      );
      return { id: saved.link.id, sk };
    },
    scrobbles(did, n, tag = 's') {
      const items: ForwardItem[] = [];
      for (let i = 0; i < n; i++) {
        listenSeq += 1;
        const listenedAt = new Date(Date.parse('2026-01-14T00:00:00Z') + listenSeq * MINUTE).toISOString();
        items.push({
          kind: 'scrobble',
          listenKey: `${tag}-${listenSeq}`,
          payload: {
            listen: {
              artist: `Artist ${listenSeq}`,
              track: `Track ${listenSeq}`,
              listenedAt,
              album: 'Album',
              durationSeconds: 200,
            },
            origin: 'lastfm',
          },
        });
      }
      enqueueForwards(app.db, { did, items, now: clock.nowMs(), random: enqueueRandom });
    },
    rows(did) {
      return did === undefined
        ? app.db.all<ForwardOutboxRow>('SELECT * FROM forward_outbox ORDER BY created_at_ms, rowid')
        : app.db.all<ForwardOutboxRow>('SELECT * FROM forward_outbox WHERE did = ? ORDER BY created_at_ms, rowid', did);
    },
    run: () => runForward(rt, clock.nowMs()),
  };
  return w;
}

afterEach(async () => {
  await closeApps();
});

const statesOf = (rows: readonly ForwardOutboxRow[]) => rows.map((r) => r.state);

describe('Last.fm forwarding', () => {
  it('queued scrobbles are sent oldest first as signed track.scrobble batches of at most 50, at least 1 s apart, and fake Last.fm verifies the signature', async () => {
    const w = await world();
    const { sk } = w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 120);
    expect(w.rows()).toHaveLength(120);

    // Through the real `forward` extension timer: kick it, run the extension lane.
    const core = w.app.composed.core;
    core.extensionTimers.kick('forward');
    await core.tick('extension');
    expect(w.lastfm.scrobbles.map((b) => b.items.length)).toEqual([50]);

    // The global bucket: nothing more until a second has passed.
    await core.tick('extension');
    await w.run();
    expect(w.lastfm.scrobbles).toHaveLength(1);
    w.clock.advance(999);
    await w.run();
    expect(w.lastfm.scrobbles).toHaveLength(1);

    w.clock.advance(1);
    await core.tick('extension');
    w.clock.advance(SECOND);
    await core.tick('extension');
    expect(w.lastfm.scrobbles.map((b) => b.items.length)).toEqual([50, 50, 20]);

    // Oldest first, as signed, indexed track.scrobble requests of our api_key and the user's sk.
    const sent = w.lastfm.scrobbles.flatMap((b) => b.items.map((i) => i.track));
    expect(sent).toEqual(Array.from({ length: 120 }, (_, i) => `Track ${i + 1}`));
    for (const batch of w.lastfm.scrobbles) {
      expect(batch).toMatchObject({ user: 'alice_fm', sk, apiKey: API_KEY, indexed: true });
      expect(batch.codes.every((c) => c === 0)).toBe(true);
    }
    expect(w.lastfm.scrobbles[0]?.items[0]).toEqual({
      artist: 'Artist 1',
      track: 'Track 1',
      timestamp: String(Date.parse('2026-01-14T00:01:00Z') / 1000),
      album: 'Album',
      duration: '200',
    });
    const calls = w.lastfm.calls.filter({ nsid: 'track.scrobble' });
    expect(calls.map((c) => [c.method, c.status])).toEqual([
      ['POST', 200],
      ['POST', 200],
      ['POST', 200],
    ]);
    expect(calls.every((c) => /^[0-9a-f]{32}$/.test(c.params.api_sig?.[0] ?? ''))).toBe(true);
    const times = w.seen.filter(([host]) => host === 'lastfm.test').map(([, , t]) => t);
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(SECOND);

    expect(statesOf(w.rows()).every((s) => s === 'sent')).toBe(true);
    expect(w.rows().every((r) => r.attempts === 1)).toBe(true);
  });

  it('per-item ignored code 5 is re-queued at the next 00:00 UTC; other ignored codes are recorded and not retried; codes 11, 16, 29, 8 and HTTP 503 retry with 30 s*2^n backoff; rows older than 13 days expire', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    const t0 = w.clock.nowMs();

    // Per-item codes: 5 → next 00:00 UTC (no attempt counted), 1 → ignored for good, 0 → sent.
    w.scrobbles(ALICE, 3);
    w.lastfm.ignoreItems(5, 1, 0);
    await w.run();
    const [daily, filtered, ok] = w.rows();
    expect(daily).toMatchObject({
      state: 'queued',
      due_at: Date.parse('2026-01-16T00:00:00Z'),
      attempts: 0,
      last_error: 'ignored_5',
    });
    expect(filtered).toMatchObject({ state: 'ignored', last_error: 'ignored_1', attempts: 1 });
    expect(ok).toMatchObject({ state: 'sent' });
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.lastfm.scrobbles).toHaveLength(1); // nothing due: the ignored row is never retried

    // Retryable failures: 30 s·2^n + U[0, 25%] for n = 0..4.
    w.scrobbles(ALICE, 1, 'retry');
    const retry = () => w.rows().find((r) => r.dedupe_key.startsWith('retry')) as ForwardOutboxRow;
    const faults = [{ code: 11 }, { code: 16 }, { code: 29 }, { code: 8 }, { httpStatus: 503 }];
    const errors = ['lastfm_error_11', 'lastfm_error_16', 'lastfm_error_29', 'lastfm_error_8', 'http_503'];
    for (const [n, fault] of faults.entries()) {
      w.lastfm.fail({ ...fault, method: 'track.scrobble' });
      const before = w.lastfm.calls.count({ nsid: 'track.scrobble' });
      const report = await w.run();
      expect(report.requests).toBe(1);
      expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(before + 1);
      const row = retry();
      const delay = row.due_at - w.clock.nowMs();
      const base = BACKOFF_BASE_MS * 2 ** n;
      expect(row).toMatchObject({ state: 'queued', attempts: n + 1, last_error: errors[n] });
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
      // Not sent again before its due time.
      w.clock.advance(delay - 1);
      await w.run();
      expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(before + 1);
      w.clock.advance(1);
    }
    expect(w.lastfm.pendingFaults).toBe(0);
    await w.run();
    expect(retry()).toMatchObject({ state: 'sent', attempts: 6 });

    // The 13-day expiry, also for the code-5 row waiting for midnight.
    w.clock.set('2026-01-15T23:00:00Z');
    w.scrobbles(ALICE, 1, 'young');
    const callsBefore = w.lastfm.calls.count({ nsid: 'track.scrobble' });
    w.clock.set(new Date(t0 + LASTFM_EXPIRY_MS + 1).toISOString());
    const report = await w.run();
    expect(report.expired?.aged).toBe(1);
    expect(w.rows()[0]).toMatchObject({ state: 'expired', last_error: 'expired' });
    // The younger row (13 days minus 11 hours old) is still sent.
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(callsBefore + 1);
    expect(w.rows().find((r) => r.dedupe_key.startsWith('young'))).toMatchObject({ state: 'sent' });
    expect(w.lastfm.scrobbles.at(-1)?.items.map((i) => i.track)).toEqual([`Track 5`]);
  });

  it('code 9 marks the link revoked and holds its rows, which resume after relinking; code 26 pauses all Last.fm forwarding and adminStatus reports lastfm_key_rejected', async () => {
    const w = await world();
    const alice = w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 2);
    w.lastfm.revokeSession(alice.sk);

    await w.run();
    expect(w.lastfm.calls.filter({ nsid: 'track.scrobble' }).map((c) => c.status)).toEqual([403]);
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', alice.id)).toEqual({
      status: 'revoked',
      last_error: 'session_revoked',
    });
    expect(statesOf(w.rows(ALICE))).toEqual(['held', 'held']);
    // A revoked link gets no new rows and sends nothing.
    w.scrobbles(ALICE, 1, 'after');
    expect(w.rows(ALICE)).toHaveLength(2);
    w.clock.advance(MINUTE);
    await w.run();
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(1);

    // Relinking (a new sk) resumes the held rows.
    const sk2 = w.lastfm.addSession('alice_fm');
    const relinked = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk2 },
    );
    expect(relinked).toMatchObject({ created: false, resumed: 2 });
    expect(relinked.link).toMatchObject({ id: alice.id, status: 'active', last_error: null });
    await w.run();
    expect(w.lastfm.scrobbles.at(-1)).toMatchObject({ sk: sk2 });
    expect(w.lastfm.scrobbles.at(-1)?.items).toHaveLength(2);
    expect(statesOf(w.rows(ALICE))).toEqual(['sent', 'sent']);

    // Code 26: our key is suspended. Every Last.fm link pauses; ListenBrainz does not.
    w.linkLastfm(BOB, 'bob_fm');
    w.lb.addToken('bob_lb', 'bob-lb-token');
    saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: BOB, service: 'listenbrainz', remoteUser: 'bob_lb', credential: 'bob-lb-token' },
    );
    w.clock.advance(MINUTE);
    w.scrobbles(ALICE, 1, 'paused-a');
    w.scrobbles(BOB, 1, 'paused-b');
    w.lastfm.fail({ code: 26 });
    const rejectedAt = w.clock.nowMs();
    await w.run();
    const status = await w.app.composed.core.adminStatus();
    expect(status.counters).toContainEqual({ name: LASTFM_KEY_REJECTED, label: '', value: rejectedAt });
    expect(w.lb.submissions.map((s) => s.user)).toEqual(['bob_lb']);

    const lastfmCalls = w.lastfm.calls.count();
    for (let i = 0; i < 5; i++) {
      w.clock.advance(10 * MINUTE);
      await w.run();
    }
    expect(w.lastfm.calls.count()).toBe(lastfmCalls);
    const lastfmLinks = new Set(
      w.app.db.all<{ id: string }>("SELECT id FROM linked_accounts WHERE service = 'lastfm'").map((r) => r.id),
    );
    const pausedRows = w.rows().filter((r) => r.dedupe_key.startsWith('paused') && lastfmLinks.has(r.link_id));
    expect(pausedRows.map((r) => r.did).sort()).toEqual([ALICE, BOB].sort());
    expect(statesOf(pausedRows)).toEqual(['queued', 'queued']);
    expect(pausedRows.every((r) => r.attempts === 0)).toBe(true);

    // One probe an hour after the rejection; its success lifts the pause.
    w.clock.set(new Date(rejectedAt + KEY_REJECTED_PROBE_MS).toISOString());
    await w.run();
    expect(w.lastfm.calls.count()).toBe(lastfmCalls + 1);
    expect((await w.app.composed.core.adminStatus()).counters.map((c) => c.name)).not.toContain(LASTFM_KEY_REJECTED);
    w.clock.advance(SECOND);
    await w.run();
    expect(statesOf(pausedRows.map((r) => w.rows().find((x) => x.id === r.id) as ForwardOutboxRow))).toEqual([
      'sent',
      'sent',
    ]);
  });

  it('now playing is forwarded once without retry and skipped when older than 60 s', async () => {
    const w = await world();
    const { sk } = w.linkLastfm(ALICE, 'alice_fm');
    const nowPlaying = (startedAtMs: number, track = 'Song'): ForwardItem => ({
      kind: 'nowplaying',
      startedAtMs,
      artist: 'Band',
      track,
      payload: {
        track: { artist: 'Band', track, album: 'Record', durationSeconds: 240 },
        startedAtMs,
        origin: 'lastfm',
      },
    });

    // A failure is not retried.
    enqueueForwards(w.app.db, {
      did: ALICE,
      items: [nowPlaying(w.clock.nowMs())],
      now: w.clock.nowMs(),
      random: enqueueRandom,
    });
    w.lastfm.fail({ code: 16, method: 'track.updateNowPlaying' });
    await w.run();
    expect(w.rows()[0]).toMatchObject({
      kind: 'nowplaying',
      state: 'failed',
      attempts: 1,
      last_error: 'lastfm_error_16',
    });
    w.clock.advance(30 * MINUTE);
    await w.run();
    expect(w.lastfm.calls.count({ nsid: 'track.updateNowPlaying' })).toBe(1);

    // A success is sent exactly once.
    enqueueForwards(w.app.db, {
      did: ALICE,
      items: [nowPlaying(w.clock.nowMs())],
      now: w.clock.nowMs(),
      random: enqueueRandom,
    });
    await w.run();
    w.clock.advance(SECOND);
    await w.run();
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lastfm.nowPlayingCalls).toEqual([
      { user: 'alice_fm', sk, artist: 'Band', track: 'Song', album: 'Record', duration: '240' },
    ]);
    expect(w.rows()[1]).toMatchObject({ state: 'sent', attempts: 1 });

    // Older than 60 s when the forwarder gets to it: skipped, never sent.
    enqueueForwards(w.app.db, {
      did: ALICE,
      items: [nowPlaying(w.clock.nowMs(), 'Late')],
      now: w.clock.nowMs(),
      random: enqueueRandom,
    });
    w.clock.advance(60 * SECOND + 1);
    const report = await w.run();
    expect(report.expired?.staleNowPlaying).toBe(1);
    expect(report.requests).toBe(0);
    expect(w.rows()[2]).toMatchObject({ state: 'expired', last_error: 'stale', attempts: 0 });
    expect(w.lastfm.calls.count({ nsid: 'track.updateNowPlaying' })).toBe(2);
  });

  it('love, unlove, love for one track forwards track.love, track.unlove, track.love in order, and the same track played as now playing twice 10 minutes apart is forwarded twice', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    const m = w.app.composed.core.deps;
    const input = { artist: 'Band', track: 'Song' };
    expect((await enqueueLove(m, { did: ALICE, input, origin: 'lastfm' })).ok).toBe(true);
    expect((await enqueueUnlove(m, { did: ALICE, artist: 'Band', track: 'Song', origin: 'lastfm' })).ok).toBe(true);
    expect((await enqueueLove(m, { did: ALICE, input, origin: 'lastfm' })).ok).toBe(true);
    expect(w.rows().map((r) => r.kind)).toEqual(['love', 'unlove', 'love']);

    // The first love fails transiently: the unlove behind it must wait, so the order holds.
    w.lastfm.fail({ code: 16, method: 'track.love' });
    await w.run();
    for (let i = 0; i < 20; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    expect(w.lastfm.loveCalls).toEqual([]);
    w.clock.advance(BACKOFF_BASE_MS);
    for (let i = 0; i < 3; i++) {
      await w.run();
      w.clock.advance(SECOND);
    }
    expect(w.lastfm.loveCalls.map((c) => [c.method, c.artist, c.track])).toEqual([
      ['track.love', 'Band', 'Song'],
      ['track.unlove', 'Band', 'Song'],
      ['track.love', 'Band', 'Song'],
    ]);
    expect(w.lastfm.loves('alice_fm')).toEqual(['band\u0000song']);
    expect(statesOf(w.rows())).toEqual(['sent', 'sent', 'sent']);

    // Now playing: a refresh of the same play adds nothing; the same track again 10 minutes later is a new play.
    const play = (startedAtMs: number): ForwardItem => ({
      kind: 'nowplaying',
      startedAtMs,
      artist: 'Band',
      track: 'Song',
      payload: { track: { artist: 'Band', track: 'Song' }, startedAtMs, origin: 'lastfm' },
    });
    const first = w.clock.nowMs();
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [play(first)], now: first, random: enqueueRandom })).toBe(1);
    await w.run();
    w.clock.advance(30 * SECOND);
    expect(
      enqueueForwards(w.app.db, { did: ALICE, items: [play(first)], now: w.clock.nowMs(), random: enqueueRandom }),
    ).toBe(0);
    await w.run();
    w.clock.set(new Date(first + 10 * MINUTE).toISOString());
    const second = w.clock.nowMs();
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [play(second)], now: second, random: enqueueRandom })).toBe(
      1,
    );
    await w.run();
    expect(w.lastfm.nowPlayingCalls.map((c) => [c.artist, c.track])).toEqual([
      ['Band', 'Song'],
      ['Band', 'Song'],
    ]);
    expect(
      w
        .rows()
        .filter((r) => r.kind === 'nowplaying')
        .map((r) => r.state),
    ).toEqual(['sent', 'sent']);
  });

  it('forwarded track.scrobble POSTs pass through policyFetch: a fake Last.fm 302 is a retryable redirect error, not followed, and an upstream root on a non-default port is refused before sending', async () => {
    let redirectOnce = true;
    const w = await world({
      transportWrap: (fake) => async (req) => {
        if (redirectOnce) {
          redirectOnce = false;
          return new Response(null, { status: 302, headers: { location: 'https://lastfm.test/2.0/elsewhere' } });
        }
        return fake.fetch(req);
      },
    });
    w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 2);

    await w.run();
    // One request, the redirect not followed: nothing went to its Location.
    expect(w.seen.map(([host, path]) => `${host}${path}`)).toEqual(['lastfm.test/2.0/']);
    const [a, b] = w.rows();
    for (const row of [a, b]) {
      expect(row).toMatchObject({ state: 'queued', attempts: 1, last_error: 'network_redirect' });
      expect((row?.due_at as number) - w.clock.nowMs()).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
      expect((row?.due_at as number) - w.clock.nowMs()).toBeLessThanOrEqual(BACKOFF_BASE_MS * 1.25);
    }
    // Retried after the backoff, and then accepted.
    w.clock.advance(BACKOFF_BASE_MS * 1.25);
    await w.run();
    expect(w.seen.map(([, path]) => path)).toEqual(['/2.0/', '/2.0/']);
    expect(statesOf(w.rows())).toEqual(['sent', 'sent']);
    expect(w.lastfm.scrobbles[0]?.items).toHaveLength(2);

    // A client whose root is on a non-default port: policyFetch refuses it before any request.
    const transportCalls: string[] = [];
    const spy = Object.assign(
      async (req: Request) => {
        transportCalls.push(req.url);
        return w.lastfm.fetch(req);
      },
      { fixture: true as const },
    );
    const offPort: ForwardRuntime = {
      ...w.rt,
      pacing: new UpstreamPacing(),
      lastfm: new LastfmClient({
        apiRoot: 'https://lastfm.test:8443/2.0/',
        apiKey: API_KEY,
        sharedSecret: SECRET,
        fetch: bindPolicyFetch(createPolicyFetch({ transport: spy }), LASTFM_CAPS),
      }),
    };
    w.scrobbles(ALICE, 1, 'port');
    const report = await runForward(offPort, w.clock.nowMs());
    expect(report.requests).toBe(1);
    expect(transportCalls).toEqual([]);
    expect(w.rows().find((r) => r.dedupe_key.startsWith('port'))).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error: 'network_blocked_address',
    });
    // The composition never builds such a client: the config refuses the root.
    await expect(
      startApp({ env: { ...UPSTREAM_ENV, LASTFM_API_ROOT: 'https://lastfm.test:8443/2.0/' } }),
    ).rejects.toThrow(/LASTFM_API_ROOT/);
  });
});
