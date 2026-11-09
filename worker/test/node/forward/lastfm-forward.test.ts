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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import {
  BACKOFF_BASE_MS,
  holdLinkRows,
  LASTFM_EXPIRY_MS,
  LASTFM_KEY_REJECTED,
  MAX_FORWARD_ATTEMPTS,
  resumeHeldRows,
  rowStates,
} from '../../../src/forward/forward-outbox';
import { type ForwardRuntime, KEY_REJECTED_PROBE_MS, runForward } from '../../../src/forward/forwarder';
import { LASTFM_CAPS, LastfmClient } from '../../../src/forward/lastfm-client';
import { saveLink } from '../../../src/forward/links';
import { admitForwardIdentity } from '../../../src/forward/projection';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import {
  canonicalForwardDedupeKey,
  deleteQueuedForwardIdentity,
  storedForwardDedupeKey,
} from '../../../src/outbox/forward-key';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { stageLovePage } from '../../../src/sync/pull-staging';
import { writePullSlice } from '../../../src/sync/pull-writer';
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
  linkLastfm(did: string, user: string): { id: string; sk: string; generation: number; generation_start_seq: number };
  /** Queues scrobbles for `did` (listen times 1 min apart, oldest first). */
  scrobbles(did: string, n: number, tag?: string): void;
  rows(did?: string): ForwardOutboxRow[];
  run(): ReturnType<typeof runForward>;
}

let enqueueRandom = seededRandom(11);

async function world(
  options: {
    transportWrap?: (fake: FakeLastfm) => (req: Request) => Promise<Response>;
    validateScrobbleTimestamps?: boolean;
  } = {},
): Promise<World> {
  const clock = fixedClock();
  const lastfm = new FakeLastfm({
    clock,
    apiKey: API_KEY,
    secret: SECRET,
    validateScrobbleTimestamps: options.validateScrobbleTimestamps,
  });
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
      return {
        id: saved.link.id,
        sk,
        generation: saved.link.generation,
        generation_start_seq: saved.link.generation_start_seq,
      };
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
  it('delivers a linked ListenBrainz love through the real signed Last.fm fake', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    const m = w.app.composed.core.deps;
    const sourceLinkId = 'linked-pull-love-source';
    w.app.db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,forward_scrobbles,forward_now_playing,status,created_at_ms,updated_at_ms)
       VALUES(?,?,'listenbrainz','remote-user',?,'e1',1,1,'active',?,?)`,
      sourceLinkId,
      ALICE,
      new Uint8Array([9]).buffer,
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    w.app.db.run(
      `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms)
       VALUES(?,1,'listenbrainz','remote-user',0,?)`,
      sourceLinkId,
      w.clock.nowMs(),
    );
    const recordingMbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    stageLovePage(w.app.db, {
      linkId: sourceLinkId,
      generation: 1,
      sourceService: 'listenbrainz',
      sourceAccount: 'remote-user',
      did: ALICE,
      proposedCursor: null,
      proposedBoundaryMs: w.clock.nowMs(),
      proposedBoundaryKey: null,
      nowMs: w.clock.nowMs(),
      items: [
        {
          itemKey: 'remote-love',
          artist: 'Band',
          track: 'Song',
          recordingMbid,
          payload: { artist: 'Band', track: 'Song', recordingMbid },
        },
      ],
    });
    const accepted = await writePullSlice(m, {
      linkId: sourceLinkId,
      generation: 1,
      available: async () => ({ available: true }),
    });
    expect(accepted.accepted).toBe(1);
    expect(w.rows(ALICE)).toHaveLength(1);
    await w.run();
    expect(w.lastfm.loveCalls.map(({ method, artist, track }) => [method, artist, track])).toEqual([
      ['track.love', 'Band', 'Song'],
    ]);
    expect(w.rows(ALICE)[0]).toMatchObject({ kind: 'love', state: 'sent' });
  });

  it('same-remote relink preserves generation and resumes only its held rows', async () => {
    const w = await world();
    const link = w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 1, 'same-remote');
    const old = w.rows(ALICE)[0]!;
    expect(old.generation).toBe(link.generation);
    holdLinkRows(w.app.db, link.id, w.clock.nowMs());

    const saved = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: w.lastfm.addSession('alice_fm') },
    );
    expect(saved).toMatchObject({ created: false, resumed: 1, link: { id: link.id, generation: link.generation } });
    expect(w.rows(ALICE)[0]).toMatchObject({ generation: link.generation, state: 'queued' });
  });

  it('remote replacement rotates generation, expires old work, and permits the same identity in the new generation', async () => {
    const w = await world();
    const oldLink = w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 1, 'generation-replay');
    const old = w.rows(ALICE)[0]!;
    const replacementCredential = w.lastfm.addSession('replacement_fm');
    const saved = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'replacement_fm', credential: replacementCredential },
    );
    expect(saved.link.generation).toBe(oldLink.generation + 1);
    expect(saved.link.generation_start_seq).toBe(
      w.app.db.one<{ boundary: number }>('SELECT coalesce(max(admission_seq),0) AS boundary FROM forward_admissions')!
        .boundary,
    );
    expect(w.rows(ALICE).find((row) => row.id === old.id)).toMatchObject({
      state: 'expired',
      last_error: 'account_changed',
    });
    expect(rowStates(w.app.db, oldLink.id)).toEqual({});

    enqueueForwards(w.app.db, {
      did: ALICE,
      items: [
        {
          kind: 'scrobble',
          listenKey: old.dedupe_key,
          payload: JSON.parse(old.payload_json),
        },
      ],
      now: w.clock.nowMs(),
      random: enqueueRandom,
    });
    expect(
      w.rows(ALICE).filter((row) => canonicalForwardDedupeKey(row.generation, row.dedupe_key) === old.dedupe_key),
    ).toMatchObject([
      { generation: oldLink.generation, state: 'expired' },
      { generation: saved.link.generation, state: 'queued' },
    ]);
    expect(rowStates(w.app.db, oldLink.id)).toEqual({ queued: 1 });
  });

  it.each(['success', 'unauthorized', 'transient'] as const)(
    'a %s response from a replaced remote cannot settle or mutate the new generation',
    async (outcome) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let arrived!: () => void;
      const inFlight = new Promise<void>((resolve) => (arrived = resolve));
      const w = await world({
        transportWrap: (fake) => async (request) => {
          arrived();
          await gate;
          if (outcome === 'transient') return new Response('', { status: 503 });
          return fake.fetch(request);
        },
      });
      const oldLink = w.linkLastfm(ALICE, 'alice_fm');
      w.scrobbles(ALICE, 1, `race-${outcome}`);
      const [oldRow] = w.rows(ALICE);
      const running = w.run();
      await inFlight;

      const replacementCredential = w.lastfm.addSession('replacement_fm');
      saveLink(
        { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
        { did: ALICE, service: 'lastfm', remoteUser: 'replacement_fm', credential: replacementCredential },
      );
      if (outcome === 'unauthorized') w.lastfm.revokeSession(oldLink.sk);
      enqueueForwards(w.app.db, {
        did: ALICE,
        items: [
          {
            kind: 'scrobble',
            listenKey: oldRow!.dedupe_key,
            payload: JSON.parse(oldRow!.payload_json),
          },
        ],
        now: w.clock.nowMs(),
        random: enqueueRandom,
      });
      release();
      await running;

      const rows = w
        .rows(ALICE)
        .filter((row) => canonicalForwardDedupeKey(row.generation, row.dedupe_key) === oldRow!.dedupe_key);
      expect(rows).toMatchObject([
        { generation: oldLink.generation, state: 'expired', attempts: 0 },
        { generation: oldLink.generation + 1, state: 'queued', attempts: 0, last_error: null },
      ]);
      expect(
        w.app.db.one('SELECT remote_user,generation,status,last_error FROM linked_accounts WHERE id=?', oldLink.id),
      ).toEqual({
        remote_user: 'replacement_fm',
        generation: oldLink.generation + 1,
        status: 'active',
        last_error: null,
      });
      expect(
        w.app.db.one(
          'SELECT last_success_ms,last_failure_ms,consecutive_failures FROM linked_accounts WHERE id=?',
          oldLink.id,
        ),
      ).toEqual({ last_success_ms: null, last_failure_ms: null, consecutive_failures: 0 });
    },
  );

  it('same-clock admissions receive durable increasing sequence numbers for generation boundaries', async () => {
    const w = await world();
    const now = w.clock.nowMs();
    admitForwardIdentity(w.app.db, { did: ALICE, identityKey: 'boundary-before-link', path: 'api', now });
    const link = w.linkLastfm(ALICE, 'alice_fm');
    admitForwardIdentity(w.app.db, { did: ALICE, identityKey: 'boundary-after-link', path: 'api', now });
    const replacement = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm-v2', credential: w.lastfm.addSession('alice_fm-v2') },
    ).link;
    const seqs = w.app.db.all<{ identity_key: string; admission_seq: number }>(
      'SELECT identity_key,admission_seq FROM forward_admissions ORDER BY admission_seq',
    );
    expect(seqs.map((row) => row.admission_seq)).toEqual([1, 2]);
    expect(link.generation_start_seq).toBe(1);
    expect(replacement.generation_start_seq).toBe(2);
    expect(replacement.generation).toBe(2);
  });

  it('keeps legacy generation-1 keys and namespaces later generations without ambiguous stripping', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'generation_one');
    const canonicalKey = 'g2:listen-key';
    const item: ForwardItem = {
      kind: 'scrobble',
      listenKey: canonicalKey,
      payload: { listen: { artist: 'Generation Artist', track: 'Generation Track' }, origin: 'lastfm' },
    };
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [item], now: w.clock.nowMs(), random: enqueueRandom })).toBe(
      1,
    );
    expect(w.app.db.one('SELECT generation,dedupe_key FROM forward_outbox')).toEqual({
      generation: 1,
      dedupe_key: canonicalKey,
    });

    const rotated = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      {
        did: ALICE,
        service: 'lastfm',
        remoteUser: 'generation_two',
        credential: w.lastfm.addSession('generation_two'),
      },
    ).link;
    expect(rotated.generation).toBe(2);
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [item], now: w.clock.nowMs(), random: enqueueRandom })).toBe(
      1,
    );
    const rows = w.app.db.all<{ generation: number; dedupe_key: string; state: string }>(
      'SELECT generation,dedupe_key,state FROM forward_outbox ORDER BY generation',
    );
    expect(rows).toEqual([
      { generation: 1, dedupe_key: canonicalKey, state: 'expired' },
      { generation: 2, dedupe_key: 'g2:g2:listen-key', state: 'queued' },
    ]);
    expect(storedForwardDedupeKey(2, canonicalKey)).toBe('g2:g2:listen-key');
    expect(canonicalForwardDedupeKey(1, 'g2:listen-key')).toBe(canonicalKey);
    expect(canonicalForwardDedupeKey(2, 'g2:g2:listen-key')).toBe(canonicalKey);
    expect(canonicalForwardDedupeKey(3, 'g2:g2:listen-key')).toBeNull();

    deleteQueuedForwardIdentity(w.app.db, ALICE, ['scrobble'], canonicalKey);
    expect(w.app.db.all('SELECT generation,dedupe_key,state FROM forward_outbox ORDER BY generation')).toEqual([
      { generation: 1, dedupe_key: canonicalKey, state: 'expired' },
    ]);
  });

  it('keeps love toggle identities independent after sent-ledger reliance is removed', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    w.linkLastfm(BOB, 'bob_fm');
    const item: ForwardItem = {
      kind: 'scrobble',
      listenKey: 'stable-listen-key',
      payload: { listen: { artist: 'Artist', track: 'Track', listenedAt: '2026-01-14T00:00:00Z' }, origin: 'lastfm' },
    };
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [item], now: w.clock.nowMs(), random: enqueueRandom })).toBe(
      1,
    );
    expect(enqueueForwards(w.app.db, { did: BOB, items: [item], now: w.clock.nowMs(), random: enqueueRandom })).toBe(1);
    await w.run();
    w.clock.advance(SECOND);
    await w.run();
    w.app.db.run("DELETE FROM forward_outbox WHERE kind='scrobble'");
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [item], now: w.clock.nowMs(), random: enqueueRandom })).toBe(
      1,
    );

    const loveItems: ForwardItem[] = [
      { kind: 'love', operationId: 'op-love-1', payload: { artist: 'Artist', track: 'Track' } },
      { kind: 'unlove', operationId: 'op-unlove', payload: { artist: 'Artist', track: 'Track' } },
      { kind: 'love', operationId: 'op-love-2', payload: { artist: 'Artist', track: 'Track' } },
    ];
    expect(
      enqueueForwards(w.app.db, { did: ALICE, items: loveItems, now: w.clock.nowMs(), random: enqueueRandom }),
    ).toBe(3);
    expect(
      w
        .rows(ALICE)
        .filter((row) => row.kind === 'love' || row.kind === 'unlove')
        .map((row) => row.kind),
    ).toEqual(['love', 'unlove', 'love']);
  });

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

  it('defers future ListenBrainz forwards until due, preserves receipt timestamps, and relinking cannot release them early', async () => {
    const w = await world({ validateScrobbleTimestamps: true });
    const { id } = w.linkLastfm(ALICE, 'alice_fm');
    const receipt = w.clock.nowMs();
    const dueAt = receipt + 25 * MINUTE;
    const listenedAt = dueAt + 5 * MINUTE;
    const item: ForwardItem = {
      kind: 'scrobble',
      listenKey: 'deferred-listen-key',
      payload: {
        listen: { artist: 'Future Artist', track: 'Future Track', listenedAt: new Date(listenedAt).toISOString() },
        origin: 'listenbrainz',
      },
    };
    enqueueForwards(w.app.db, { did: ALICE, items: [item], now: receipt, dueAt, random: enqueueRandom });
    expect(w.rows(ALICE)).toMatchObject([
      { state: 'queued', due_at: dueAt, created_at_ms: receipt, updated_at_ms: receipt },
    ]);
    enqueueForwards(w.app.db, { did: ALICE, items: [item], now: receipt + 1, dueAt, random: enqueueRandom });
    expect(w.rows(ALICE)).toHaveLength(1);
    expect((await w.run()).requests).toBe(0);
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(0);

    // A revoke/hold/relink cycle must retain the delivery not-before time.
    holdLinkRows(w.app.db, id, receipt + 2);
    resumeHeldRows(w.app.db, id, receipt + 3);
    expect(w.rows(ALICE)[0]).toMatchObject({ state: 'queued', due_at: dueAt, updated_at_ms: receipt + 3 });
    w.clock.set(new Date(dueAt - 1).toISOString());
    expect((await w.run()).requests).toBe(0);
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(0);
    w.clock.set(new Date(dueAt).toISOString());
    expect((await w.run()).requests).toBe(1);
    expect(w.rows(ALICE)[0]).toMatchObject({ state: 'sent', created_at_ms: receipt, due_at: dueAt });
    expect(w.lastfm.scrobbles.at(-1)?.codes).toEqual([0]);
    expect((await w.run()).requests).toBe(0);
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(1);
  });

  it('keeps a deferred forward durable across a composition restart and sends it once at the due boundary', async () => {
    const clock = fixedClock();
    const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET, validateScrobbleTimestamps: true });
    const secrets = parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } });
    const stateDir = mkdtempSync(join(tmpdir(), 'atmusic-forward-restart-'));
    const appOptions = () => ({
      clock,
      secrets,
      transport: routerTransport({ hosts: { 'lastfm.test': lastfm } }),
      features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
      env: { ...UPSTREAM_ENV, STATE_DIRECTORY: stateDir },
    });
    let app = await startApp(appOptions());
    try {
      ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
      const service = (app.composed.app as unknown as { links: LinksService }).links;
      admitForwardIdentity(app.db, {
        did: ALICE,
        identityKey: 'restart-generation-boundary',
        path: 'api',
        now: clock.nowMs(),
      });
      const sk = lastfm.addSession('restart_user');
      const initialLink = saveLink(
        { db: app.db, clock, random: service.forwarding.random, box: service.forwarding.box },
        { did: ALICE, service: 'lastfm', remoteUser: 'restart_user', credential: sk },
      );
      expect(initialLink.link).toMatchObject({ generation: 1, generation_start_seq: 1 });
      const rotatedLink = saveLink(
        { db: app.db, clock, random: service.forwarding.random, box: service.forwarding.box },
        {
          did: ALICE,
          service: 'lastfm',
          remoteUser: 'restart_user_v2',
          credential: lastfm.addSession('restart_user_v2'),
        },
      );
      expect(rotatedLink.link).toMatchObject({ generation: 2, generation_start_seq: 1 });
      const receipt = clock.nowMs();
      const dueAt = receipt + 25 * MINUTE;
      const listenedAt = dueAt + 5 * MINUTE;
      const item: ForwardItem = {
        kind: 'scrobble',
        listenKey: 'restart-deferred-key',
        payload: {
          listen: { artist: 'Restart Artist', track: 'Due Later', listenedAt: new Date(listenedAt).toISOString() },
          origin: 'listenbrainz',
        },
      };
      enqueueForwards(app.db, { did: ALICE, items: [item], now: receipt, dueAt, random: seededRandom(71) });
      expect(app.db.one('SELECT state, due_at, created_at_ms, updated_at_ms FROM forward_outbox')).toEqual({
        state: 'queued',
        due_at: dueAt,
        created_at_ms: receipt,
        updated_at_ms: receipt,
      });
      await app.close();

      clock.set(new Date(dueAt - 1).toISOString());
      app = await startApp(appOptions());
      const restartedService = (app.composed.app as unknown as { links: LinksService }).links;
      expect(app.db.one('SELECT generation,generation_start_seq FROM linked_accounts')).toEqual({
        generation: 2,
        generation_start_seq: 1,
      });
      expect(app.db.one('SELECT next_seq FROM forward_admission_clock')).toEqual({ next_seq: 1 });
      expect(app.db.one('SELECT generation FROM forward_outbox')).toEqual({ generation: 2 });
      expect(app.db.one('SELECT state, due_at, created_at_ms, updated_at_ms FROM forward_outbox')).toEqual({
        state: 'queued',
        due_at: dueAt,
        created_at_ms: receipt,
        updated_at_ms: receipt,
      });
      expect((await runForward(restartedService.forwarding)).requests).toBe(0);
      expect(lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(0);
      clock.set(new Date(dueAt).toISOString());
      expect((await runForward(restartedService.forwarding)).requests).toBe(1);
      expect(app.db.one('SELECT state, due_at, created_at_ms FROM forward_outbox')).toEqual({
        state: 'sent',
        due_at: dueAt,
        created_at_ms: receipt,
      });
      expect(lastfm.scrobbles.at(-1)?.codes).toEqual([0]);
      expect((await runForward(restartedService.forwarding)).requests).toBe(0);
      expect(lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(1);
    } finally {
      await app.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('persists three transient failures across restart and clears link diagnostics on success', async () => {
    const clock = fixedClock();
    const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const secrets = parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } });
    const stateDir = mkdtempSync(join(tmpdir(), 'atmusic-forward-health-'));
    const appOptions = () => ({
      clock,
      secrets,
      transport: routerTransport({ hosts: { 'lastfm.test': lastfm } }),
      features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
      env: { ...UPSTREAM_ENV, STATE_DIRECTORY: stateDir },
    });
    let app = await startApp(appOptions());
    try {
      ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
      const service = (app.composed.app as unknown as { links: LinksService }).links;
      const link = saveLink(
        { db: app.db, clock, random: service.forwarding.random, box: service.forwarding.box },
        { did: ALICE, service: 'lastfm', remoteUser: 'health_user', credential: lastfm.addSession('health_user') },
      ).link;
      const accepted = enqueueForwards(app.db, {
        did: ALICE,
        now: clock.nowMs(),
        random: seededRandom(79),
        items: [
          {
            kind: 'scrobble',
            listenKey: 'persistent-health-key',
            payload: {
              listen: { artist: 'Health Artist', track: 'Health Track', listenedAt: '2026-01-15T11:00:00Z' },
              origin: 'lastfm',
            },
          },
        ],
      });
      expect(accepted).toBe(1);

      let thirdFailureAt = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        lastfm.fail({ httpStatus: 503, method: 'track.scrobble' });
        expect((await runForward(service.forwarding)).requests).toBe(1);
        const row = app.db.one<{ due_at: number; attempts: number; state: string }>(
          'SELECT due_at,attempts,state FROM forward_outbox WHERE dedupe_key=?',
          'persistent-health-key',
        )!;
        expect(row).toMatchObject({ attempts: attempt, state: 'queued' });
        if (attempt === 3) thirdFailureAt = clock.nowMs();
        expect(
          app.db.one(
            'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
            link.id,
          ),
        ).toEqual({
          last_success_ms: null,
          last_failure_ms: clock.nowMs(),
          consecutive_failures: attempt,
          last_error: attempt === 3 ? 'http_503' : null,
        });
        if (attempt < 3) clock.set(new Date(row.due_at).toISOString());
      }

      const dueAt = app.db.one<{ due_at: number }>(
        'SELECT due_at FROM forward_outbox WHERE dedupe_key=?',
        'persistent-health-key',
      )!.due_at;
      await app.close();
      clock.set(new Date(dueAt).toISOString());
      app = await startApp(appOptions());
      const restartedService = (app.composed.app as unknown as { links: LinksService }).links;
      expect(
        app.db.one(
          'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
          link.id,
        ),
      ).toEqual({
        last_success_ms: null,
        last_failure_ms: thirdFailureAt,
        consecutive_failures: 3,
        last_error: 'http_503',
      });

      expect((await runForward(restartedService.forwarding)).requests).toBe(1);
      expect(
        app.db.one(
          'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
          link.id,
        ),
      ).toEqual({
        last_success_ms: clock.nowMs(),
        last_failure_ms: thirdFailureAt,
        consecutive_failures: 0,
        last_error: null,
      });
      expect(
        app.db.one('SELECT state,attempts FROM forward_outbox WHERE dedupe_key=?', 'persistent-health-key'),
      ).toEqual({
        state: 'sent',
        attempts: 4,
      });
    } finally {
      await app.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('persists the transient error threshold across restart and clears it on the next successful response', async () => {
    const clock = fixedClock();
    const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
    const secrets = parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } });
    const stateDir = mkdtempSync(join(tmpdir(), 'atmusic-forward-health-'));
    const appOptions = () => ({
      clock,
      secrets,
      transport: routerTransport({ hosts: { 'lastfm.test': lastfm } }),
      features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
      env: { ...UPSTREAM_ENV, STATE_DIRECTORY: stateDir },
    });
    let app = await startApp(appOptions());
    try {
      ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
      const service = (app.composed.app as unknown as { links: LinksService }).links;
      const link = saveLink(
        { db: app.db, clock, random: service.forwarding.random, box: service.forwarding.box },
        { did: ALICE, service: 'lastfm', remoteUser: 'health_user', credential: lastfm.addSession('health_user') },
      ).link;
      const accepted = enqueueForwards(app.db, {
        did: ALICE,
        now: clock.nowMs(),
        random: seededRandom(79),
        items: [
          {
            kind: 'scrobble',
            listenKey: 'persistent-health-key',
            payload: {
              listen: { artist: 'Health Artist', track: 'Health Track', listenedAt: '2026-01-15T11:00:00Z' },
              origin: 'lastfm',
            },
          },
        ],
      });
      expect(accepted).toBe(1);

      let thirdFailureAt = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        lastfm.fail({ httpStatus: 503, method: 'track.scrobble' });
        expect((await runForward(service.forwarding)).requests).toBe(1);
        const row = app.db.one<{ due_at: number; attempts: number; state: string }>(
          'SELECT due_at,attempts,state FROM forward_outbox WHERE dedupe_key=?',
          'persistent-health-key',
        )!;
        expect(row).toMatchObject({ attempts: attempt, state: 'queued' });
        if (attempt === 3) thirdFailureAt = clock.nowMs();
        expect(
          app.db.one(
            'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
            link.id,
          ),
        ).toEqual({
          last_success_ms: null,
          last_failure_ms: clock.nowMs(),
          consecutive_failures: attempt,
          last_error: attempt === 3 ? 'http_503' : null,
        });
        if (attempt < 3) clock.set(new Date(row.due_at).toISOString());
      }

      const dueAt = app.db.one<{ due_at: number }>(
        'SELECT due_at FROM forward_outbox WHERE dedupe_key=?',
        'persistent-health-key',
      )!.due_at;
      await app.close();
      clock.set(new Date(dueAt).toISOString());
      app = await startApp(appOptions());
      const restartedService = (app.composed.app as unknown as { links: LinksService }).links;
      expect(
        app.db.one(
          'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
          link.id,
        ),
      ).toEqual({
        last_success_ms: null,
        last_failure_ms: thirdFailureAt,
        consecutive_failures: 3,
        last_error: 'http_503',
      });

      expect((await runForward(restartedService.forwarding)).requests).toBe(1);
      expect(
        app.db.one(
          'SELECT last_success_ms,last_failure_ms,consecutive_failures,last_error FROM linked_accounts WHERE id=?',
          link.id,
        ),
      ).toEqual({
        last_success_ms: clock.nowMs(),
        last_failure_ms: thirdFailureAt,
        consecutive_failures: 0,
        last_error: null,
      });
      expect(
        app.db.one('SELECT state,attempts FROM forward_outbox WHERE dedupe_key=?', 'persistent-health-key'),
      ).toEqual({
        state: 'sent',
        attempts: 4,
      });
    } finally {
      await app.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('a run handed a stale now (a tick timestamp seconds old) still keeps Last.fm requests at least 1 s apart, and the shared bucket never trusts a stale caller time', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    w.linkLastfm(BOB, 'bob_fm');
    w.scrobbles(ALICE, 1, 'a');
    w.scrobbles(BOB, 1, 'b');

    // The extension lane's tick: its timestamp is handed to every handler, and the handlers
    // before `forward` awaited PDS writes for 5 s, so `forward` sees a `now` 5 s old.
    let tick = w.clock.nowMs();
    w.clock.advance(5 * SECOND);
    const report = await runForward(w.rt, tick);
    expect(report.requests).toBe(1);
    expect(w.lastfm.scrobbles).toHaveLength(1);
    expect(statesOf(w.rows()).sort()).toEqual(['queued', 'sent']);
    // The next run is scheduled a full second after the request, by the clock.
    expect(report.nextDueMs).toBe(w.clock.nowMs() + SECOND);

    // Another stale caller inside that second is still refused.
    w.clock.advance(SECOND - 1);
    expect((await runForward(w.rt, tick)).requests).toBe(0);
    expect(w.lastfm.scrobbles).toHaveLength(1);

    // Once the second has passed by the clock, a run with a stale `now` sends the other row.
    w.clock.advance(1);
    tick = w.clock.nowMs() - 5 * SECOND;
    expect((await runForward(w.rt, tick)).requests).toBe(1);
    expect(w.lastfm.scrobbles.map((b) => b.user).sort()).toEqual(['alice_fm', 'bob_fm']);
    expect(statesOf(w.rows())).toEqual(['sent', 'sent']);
    const times = w.seen.filter(([host]) => host === 'lastfm.test').map(([, , t]) => t);
    expect(times).toHaveLength(2);
    expect((times[1] as number) - (times[0] as number)).toBe(SECOND);

    // The shared pacer itself (imports use it too): a token taken with a stale time blocks
    // until a second after the clock's current time, not after the stale time.
    const pacing = new UpstreamPacing(w.clock);
    expect(pacing.tryLastfm('import', w.clock.nowMs() - 5 * SECOND)).toBe(true);
    expect(pacing.tryLastfm('forward', w.clock.nowMs())).toBe(false);
    expect(pacing.lastfmAvailableAt('forward', w.clock.nowMs())).toBe(w.clock.nowMs() + SECOND);
    expect(pacing.tryListenbrainz('k', w.clock.nowMs() - 5 * SECOND)).toBe(true);
    expect(pacing.tryListenbrainz('k', w.clock.nowMs())).toBe(false);
    expect(pacing.listenbrainzAvailableAt('k')).toBe(w.clock.nowMs() + SECOND);
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

  it('stops after exactly the configured maximum of attempted retryable requests', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 1, 'retry-cap');
    const row = () => w.rows(ALICE)[0]!;
    for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt++) {
      if (attempt > 1) w.clock.set(new Date(row().due_at).toISOString());
      w.lastfm.fail({ httpStatus: 503, method: 'track.scrobble' });
      expect((await w.run()).requests).toBe(1);
      if (attempt < MAX_FORWARD_ATTEMPTS) expect(row()).toMatchObject({ state: 'queued', attempts: attempt });
    }
    expect(row()).toMatchObject({ state: 'failed', attempts: MAX_FORWARD_ATTEMPTS, last_error: 'retry_exhausted' });
    const calls = w.lastfm.calls.count({ nsid: 'track.scrobble' });
    expect(calls).toBe(MAX_FORWARD_ATTEMPTS);
    expect((await w.run()).requests).toBe(0);
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(calls);
  });

  it('stops after exactly the configured maximum of attempted retryable requests', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 1, 'retry-cap');
    const row = () => w.rows(ALICE)[0]!;
    for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt++) {
      if (attempt > 1) w.clock.set(new Date(row().due_at).toISOString());
      w.lastfm.fail({ httpStatus: 503, method: 'track.scrobble' });
      expect((await w.run()).requests).toBe(1);
      if (attempt < MAX_FORWARD_ATTEMPTS) expect(row()).toMatchObject({ state: 'queued', attempts: attempt });
    }
    expect(row()).toMatchObject({ state: 'failed', attempts: MAX_FORWARD_ATTEMPTS, last_error: 'retry_exhausted' });
    const calls = w.lastfm.calls.count({ nsid: 'track.scrobble' });
    expect(calls).toBe(MAX_FORWARD_ATTEMPTS);
    expect((await w.run()).requests).toBe(0);
    expect(w.lastfm.calls.count({ nsid: 'track.scrobble' })).toBe(calls);
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
    expect(
      w.app.db.one(
        'SELECT last_error,last_failure_ms,consecutive_failures FROM linked_accounts WHERE did=? AND service=?',
        ALICE,
        'lastfm',
      ),
    ).toEqual({ last_error: 'lastfm_key_rejected', last_failure_ms: rejectedAt, consecutive_failures: 1 });

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
    expect(pausedRows.map((r) => [r.did, r.attempts]).sort()).toEqual([
      [ALICE, 1],
      [BOB, 0],
    ]);

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

  it('a code 9 for a request sent before a relink leaves the relinked account active with its rows queued', async () => {
    // The request is held in flight until `release`; it then reaches the fake,
    // which answers 9 because the old sk was revoked in the meantime.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const w = await world({
      transportWrap: (fake) => async (req) => {
        arrived();
        await gate;
        return fake.fetch(req);
      },
    });
    const alice = w.linkLastfm(ALICE, 'alice_fm');
    w.scrobbles(ALICE, 2);

    const running = w.run();
    await inFlight;
    // While the scrobble is in flight the owner relinks with a new sk; the old one stops working.
    const sk2 = w.lastfm.addSession('alice_fm');
    const relinked = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk2 },
    );
    expect(relinked).toMatchObject({ created: false, link: { id: alice.id, status: 'active' } });
    w.lastfm.revokeSession(alice.sk);
    release();
    const report = await running;

    expect(report.requests).toBe(1);
    expect(w.lastfm.calls.filter({ nsid: 'track.scrobble' }).map((c) => c.status)).toEqual([403]);
    // The refusal was of the old sk: the fresh link is not revoked and its rows are not held.
    expect(w.app.db.one('SELECT status, last_error FROM linked_accounts WHERE id = ?', alice.id)).toEqual({
      status: 'active',
      last_error: null,
    });
    expect(statesOf(w.rows(ALICE))).toEqual(['queued', 'queued']);

    // They go with the new sk once the backoff has passed.
    w.clock.advance(10 * MINUTE);
    await w.run();
    expect(w.lastfm.scrobbles.at(-1)).toMatchObject({ sk: sk2 });
    expect(w.lastfm.scrobbles.at(-1)?.items).toHaveLength(2);
    expect(statesOf(w.rows(ALICE))).toEqual(['sent', 'sent']);
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

  it('removes a backed-off love head and immediately exposes the queued unlove behind it', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    const m = w.app.composed.core.deps;
    await enqueueLove(m, { did: ALICE, input: { artist: 'Cancel Artist', track: 'Cancel Track' }, origin: 'lastfm' });
    await enqueueUnlove(m, { did: ALICE, artist: 'Cancel Artist', track: 'Cancel Track', origin: 'lastfm' });
    const head = w.rows(ALICE)[0]!;
    w.lastfm.fail({ httpStatus: 503, method: 'track.love' });
    await w.run();
    expect(w.rows(ALICE)[0]).toMatchObject({ state: 'queued', due_at: expect.any(Number) });
    deleteQueuedForwardIdentity(
      w.app.db,
      ALICE,
      ['love'],
      canonicalForwardDedupeKey(head.generation, head.dedupe_key)!,
    );
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lastfm.loveCalls.map((call) => call.method)).toEqual(['track.unlove']);
    expect(w.rows(ALICE).find((row) => row.kind === 'unlove')?.state).toBe('sent');
  });

  it('expires an aged backoff love head and sends the fresh unlove behind it', async () => {
    const w = await world();
    w.linkLastfm(ALICE, 'alice_fm');
    const m = w.app.composed.core.deps;
    await enqueueLove(m, { did: ALICE, input: { artist: 'Expiry Artist', track: 'Expiry Track' }, origin: 'lastfm' });
    await enqueueUnlove(m, { did: ALICE, artist: 'Expiry Artist', track: 'Expiry Track', origin: 'lastfm' });
    const head = w.rows(ALICE)[0]!;
    w.app.db.run(
      'UPDATE forward_outbox SET created_at_ms=? WHERE id=?',
      w.clock.nowMs() - LASTFM_EXPIRY_MS - 1,
      head.id,
    );
    const report = await w.run();
    expect(report.expired?.aged).toBe(1);
    expect(w.rows(ALICE).find((row) => row.id === head.id)?.state).toBe('expired');
    expect(w.lastfm.loveCalls.map((call) => call.method)).toEqual(['track.unlove']);
    expect(w.rows(ALICE).find((row) => row.kind === 'unlove')?.state).toBe('sent');
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
      expect(row).toMatchObject({ state: 'queued', attempts: 1, last_error: 'network_error' });
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
      pacing: new UpstreamPacing(w.clock),
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
      last_error: 'network_error',
    });
    // The composition never builds such a client: the config refuses the root.
    await expect(
      startApp({ env: { ...UPSTREAM_ENV, LASTFM_API_ROOT: 'https://lastfm.test:8443/2.0/' } }),
    ).rejects.toThrow(/LASTFM_API_ROOT/);
  });
});

it('historical love must precede newer live unlove for the same track', async () => {
  const w = await world();
  w.linkLastfm(ALICE, 'alice');
  enqueueForwards(w.app.db, {
    did: ALICE,
    now: w.clock.nowMs(),
    random: seededRandom(801),
    priority: 1,
    items: [{ kind: 'love', operationId: 'history-love', payload: { artist: 'A', track: 'T' } }],
  });
  w.clock.advance(1);
  enqueueForwards(w.app.db, {
    did: ALICE,
    now: w.clock.nowMs(),
    random: seededRandom(802),
    items: [{ kind: 'unlove', operationId: 'live-unlove', payload: { artist: 'A', track: 'T' } }],
  });
  await w.run();
  w.clock.advance(1000);
  await w.run();
  expect(
    w.lastfm.calls
      .filter({})
      .map((c) => c.params.method?.[0])
      .filter((m) => m === 'track.love' || m === 'track.unlove'),
  ).toEqual(['track.love', 'track.unlove']);
});
