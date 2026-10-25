// The /api/v1 import routes (ADR 0005 §11.4, contract v1.2; N3-09).
//
// The whole composed app runs in-process (support/app.ts: the real compose,
// dispatcher and HTTP bridge on 127.0.0.1:0) with the imports feature, real
// cookie sessions and CSRF, and the fake ListenBrainz at listenbrainz.test
// behind the fixture router transport. The `import` timer is run by ticking
// the extension lane. Every answer is checked against api/openapi.yaml.
// Frozen clock 2026-01-15T12:00:00Z; seeded randomness; no network.

import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, type WebSessions } from '../../../src/bff/sessions';
import { createBox } from '../../../src/crypto/box';
import { importsFeature } from '../../../src/http/imports';
import { parseSecrets } from '../../../src/node/secrets';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp, testSecretsDocument } from '../support/app';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

afterEach(async () => {
  await closeApps();
});

const T0 = Date.parse('2026-01-15T12:00:00Z');
const T0S = T0 / 1000;
const ALICE = 'did:plc:alicealicealicealicealic';
const MALLORY = 'did:plc:mallorymallorymallorymal';

/** The JSON answers this suite reads: an ImportJob, an ImportList or an error envelope. */
type Answer = Record<string, unknown> & {
  id: string;
  state: string;
  error: { code: string; message: string };
  items: Array<{ id: string; state: string }>;
};

type Login = { cookie: string; origin: string; 'x-csrf-token': string };

interface Rig {
  app: TestApp;
  lb: FakeListenBrainz;
  login(did: string): Login;
  call(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: BodyInit,
  ): Promise<{ status: number; body: Answer }>;
  tick(times?: number): Promise<void>;
  clock: ReturnType<typeof fixedClock>;
}

async function rig(options: { lastfm?: boolean } = {}): Promise<Rig> {
  const clock = fixedClock();
  const lb = new FakeListenBrainz({ clock });
  let sessions: WebSessions | null = null;
  const lazy = {
    lookupCookieHeader: (h: string | null) => (sessions as WebSessions).lookupCookieHeader(h),
    renew: (s: Parameters<WebSessions['renew']>[0]) => (sessions as WebSessions).renew(s),
  };
  const doc = testSecretsDocument();
  if (options.lastfm !== false) doc.lastfm = { apiKey: 'c'.repeat(32), sharedSecret: 'owner-secret' };
  const app = await startApp({
    clock,
    transport: routerTransport({ hosts: { 'listenbrainz.test': lb } }),
    secrets: parseSecrets(doc),
    env: { LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/', LASTFM_API_ROOT: 'https://lastfm.test/2.0/' },
    features: [importsFeature({ sessions: lazy, diskLow: () => false })],
  });
  const ws = createWebSessions({
    db: app.db,
    clock,
    random: seededRandom(3),
    revocations: new MemoryRevocations(clock),
  });
  sessions = ws;
  const csrfKey = createBox(app.secrets.encryptionKeys, seededRandom(1)).csrfKey();
  return {
    app,
    lb,
    clock,
    login(did) {
      const s = ws.create(did);
      return {
        cookie: `__Host-atmusic_session=${s.token}`,
        origin: TEST_PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken(csrfKey, s.token),
      };
    },
    async call(method, path, headers = {}, body) {
      const res = await app.fetch(path, { method, headers, ...(body === undefined ? {} : { body }) });
      const json = (await res.json()) as Answer;
      // Every answer is a documented status with a body of its schema.
      expect(
        checkResponse(method, path.split('?')[0] as string, { status: res.status, headers: res.headers, body: json }),
      ).toBe('valid');
      expect(res.headers.get('cache-control')).toBe('no-store');
      return { status: res.status, body: json };
    },
    async tick(times = 1) {
      for (let i = 0; i < times; i++) await app.composed.core.tick('extension');
    },
  };
}

function seedCurrentUser(app: TestApp, did: string): void {
  app.db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current', 1)`,
    did,
  );
}

const jsonBody = (value: unknown) => JSON.stringify(value);

describe('/api/v1/imports', () => {
  it('POST /api/v1/imports and upload return 202 ImportJob; GET reports progress and etaSeconds; a second active job is 409 import_active; cancel and resume work', async () => {
    const r = await rig();
    const { app, lb } = r;
    seedCurrentUser(app, ALICE);
    lb.seedListens('alice_lb', [
      { listened_at: T0S - 3_000, track_metadata: { artist_name: 'One', track_name: 'First' } },
      { listened_at: T0S - 2_000, track_metadata: { artist_name: 'Two', track_name: 'Second' } },
      { listened_at: T0S - 1_000, track_metadata: { artist_name: 'Three', track_name: 'Third' } },
    ]);
    const alice = r.login(ALICE);
    const json = { ...alice, 'content-type': 'application/json' };

    // No session: 401; no CSRF token on a POST: 403.
    expect((await r.call('GET', '/api/v1/imports')).status).toBe(401);
    const noCsrf = { cookie: alice.cookie, origin: alice.origin, 'content-type': 'application/json' };
    const forbidden = await r.call(
      'POST',
      '/api/v1/imports',
      noCsrf,
      jsonBody({ source: 'listenbrainz', username: 'alice_lb' }),
    );
    expect(forbidden).toMatchObject({ status: 403, body: { error: { code: 'csrf_failed' } } });
    // Invalid bodies: 400 for malformed JSON, 422 for a wrong field.
    expect((await r.call('POST', '/api/v1/imports', json, '{"source":')).body.error.code).toBe('invalid_json');
    for (const bad of [
      { source: 'spotify', username: 'x' },
      { source: 'lastfm', username: '' },
      { source: 'lastfm', username: 'x', extra: 1 },
    ]) {
      expect(await r.call('POST', '/api/v1/imports', json, jsonBody(bad))).toMatchObject({
        status: 422,
        body: { error: { code: 'validation_failed' } },
      });
    }
    expect(app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 0 });

    // 202 ImportJob.
    const created = await r.call(
      'POST',
      '/api/v1/imports',
      json,
      jsonBody({ source: 'listenbrainz', username: 'alice_lb' }),
    );
    expect(created.status).toBe(202);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      source: 'listenbrainz_api',
      remoteUser: 'alice_lb',
      state: 'waiting_index',
      fetched: 0,
      staged: 0,
      duplicates: 0,
      invalid: 0,
      written: 0,
      failed: 0,
      etaSeconds: null,
      error: null,
      createdAt: '2026-01-15T12:00:00.000000000Z',
      updatedAt: '2026-01-15T12:00:00.000000000Z',
    });
    const id = created.body.id as string;

    // A second active job, by API or upload: 409 import_active, nothing written.
    const second = await r.call('POST', '/api/v1/imports', json, jsonBody({ source: 'lastfm', username: 'rj' }));
    expect(second).toMatchObject({
      status: 409,
      body: { error: { code: 'import_active', message: 'An import job is already active.' } },
    });
    const upload409 = await r.call('POST', '/api/v1/imports/upload?source=lastfm_json', alice, '[]');
    expect(upload409).toMatchObject({ status: 409, body: { error: { code: 'import_active' } } });
    expect(app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 1 });

    // The timer fetches the page and the writer queues three operations.
    await r.tick(4);
    const progress = await r.call('GET', `/api/v1/imports/${id}`, { cookie: alice.cookie });
    expect(progress.status).toBe(200);
    // ETA: 3 items × 3 points ÷ (50 % of 35,000 points a day = 729.17 points an hour) = 44.4 s → 45.
    expect(progress.body).toMatchObject({
      state: 'writing',
      fetched: 3,
      staged: 3,
      written: 0,
      duplicates: 0,
      etaSeconds: 45,
    });
    expect(app.db.one("SELECT count(*) AS n FROM operations WHERE origin = 'import'")).toEqual({ n: 3 });
    // Another DID never sees it.
    const mallory = r.login(MALLORY);
    expect((await r.call('GET', `/api/v1/imports/${id}`, { cookie: mallory.cookie })).status).toBe(404);
    expect((await r.call('POST', `/api/v1/imports/${id}/cancel`, mallory)).status).toBe(404);
    expect((await r.call('GET', '/api/v1/imports', { cookie: mallory.cookie })).body).toEqual({ items: [] });

    // Cancel: no ETA, no new operations.
    const cancelled = await r.call('POST', `/api/v1/imports/${id}/cancel`, alice);
    expect(cancelled).toMatchObject({ status: 200, body: { id, state: 'cancelled', etaSeconds: null } });

    // Upload: 202 ImportJob with no remote user.
    const t = T0S - 50_000;
    const exportBody = JSON.stringify([
      {
        recenttracks: {
          track: [
            { artist: { '#text': 'Up' }, name: 'Loaded', album: { '#text': '' }, mbid: '', date: { uts: String(t) } },
          ],
        },
      },
    ]);
    const uploaded = await r.call('POST', '/api/v1/imports/upload?source=lastfm_json', alice, exportBody);
    expect(uploaded).toMatchObject({
      status: 202,
      body: { source: 'lastfm_json', remoteUser: null, state: 'waiting_index', fetched: 0, etaSeconds: null },
    });
    expect((await r.call('POST', '/api/v1/imports/upload?source=mp3', alice, '[]')).status).toBe(422);
    await r.tick(3);
    expect((await r.call('GET', `/api/v1/imports/${uploaded.body.id}`, { cookie: alice.cookie })).body).toMatchObject({
      state: 'writing',
      fetched: 1,
      staged: 1,
    });
    expect((await r.call('POST', `/api/v1/imports/${uploaded.body.id}/cancel`, alice)).body.state).toBe('cancelled');

    // Resume: an upstream 401 pauses the job; resume continues it.
    lb.seedListens('locked_lb', [
      { listened_at: T0S - 500, track_metadata: { artist_name: 'L', track_name: 'Locked' } },
    ]);
    lb.fail({ status: 401 });
    const locked = await r.call(
      'POST',
      '/api/v1/imports',
      json,
      jsonBody({ source: 'listenbrainz', username: 'locked_lb' }),
    );
    expect(locked.status).toBe(202);
    r.clock.advance(1_000);
    await r.tick();
    const paused = await r.call('GET', `/api/v1/imports/${locked.body.id}`, { cookie: alice.cookie });
    expect(paused.body).toMatchObject({ state: 'paused', error: 'upstream_unauthorized', fetched: 0 });
    const resumed = await r.call('POST', `/api/v1/imports/${locked.body.id}/resume`, alice);
    expect(resumed).toMatchObject({ status: 200, body: { state: 'fetching', error: null } });
    r.clock.advance(1_000);
    await r.tick(3);
    expect((await r.call('GET', `/api/v1/imports/${locked.body.id}`, { cookie: alice.cookie })).body).toMatchObject({
      state: 'writing',
      fetched: 1,
      staged: 1,
    });
    // Resuming a job that is not paused changes nothing.
    expect((await r.call('POST', `/api/v1/imports/${id}/resume`, alice)).body).toMatchObject({ state: 'cancelled' });

    // The list: newest first.
    const list = await r.call('GET', '/api/v1/imports', { cookie: alice.cookie });
    expect(list.status).toBe(200);
    expect((list.body.items as Array<{ id: string; state: string }>).map((j) => [j.id, j.state])).toEqual([
      [locked.body.id, 'writing'],
      [uploaded.body.id, 'cancelled'],
      [id, 'cancelled'],
    ]);
    expect(lb.calls.entries.map((c) => [c.path, c.status])).toEqual([
      ['/1/user/alice_lb/listens', 200],
      ['/1/user/locked_lb/listens', 401],
      ['/1/user/locked_lb/listens', 200],
    ]);

    // Without the owner's Last.fm pair, a Last.fm API import is 503 lastfm_not_configured.
    const bare = await rig({ lastfm: false });
    const b = bare.login(ALICE);
    expect(
      await bare.call(
        'POST',
        '/api/v1/imports',
        { ...b, 'content-type': 'application/json' },
        jsonBody({ source: 'lastfm', username: 'rj' }),
      ),
    ).toMatchObject({
      status: 503,
      body: { error: { code: 'lastfm_not_configured', message: 'Last.fm is not configured on this server.' } },
    });
    expect(bare.app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 0 });
  }, 30_000);
});
