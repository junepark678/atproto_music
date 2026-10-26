// POST /1/submit-listens over the in-process app (ADR 0005 §8.3, Q11, Q16;
// N3-05). Every test runs the real composition (support/app.ts) on
// 127.0.0.1:0 with the frozen clock 2026-01-15T12:00:00Z and seeded
// randomness; nothing leaves the process. The deferred-listen test runs the
// real outbox runner against the fixture PDS (packages/atproto/test-support).
//
// The client fixtures under ./fixtures are raw request bodies, sent
// byte-for-byte with the headers each client sends. They were reconstructed
// from the clients' source code (no live capture is possible here: no real
// network), with the serialisers' field order and spacing:
// - Web Scrobbler, src/core/scrobbler/listenbrainz/listenbrainz-scrobbler.ts
//   (`JSON.stringify` of `{listen_type, payload: [{listened_at?,
//   track_metadata}]}`, `makeTrackMetadata`: artist_name, track_name,
//   additional_info {submission_client, submission_client_version,
//   music_service_name, origin_url?, release_artist_name?, duration_ms?},
//   release_name?; header `Authorization: Token <token>`). Scrobbles and now
//   playing only (ADR §8.1).
// - Navidrome, core/agents/listenbrainz/client.go (Go `json.Marshal` of
//   listenBrainzRequestBody: listened_at omitempty, an int `tracknumber`,
//   `artist_names`, the MBIDs and `duration_ms`; `Authorization: Token`).
// - Pano Scrobbler, the ListenBrainz scrobbler's kotlinx.serialization data
//   classes (explicitNulls = false; header `Authorization: token <token>`,
//   lowercase, ADR §8.2).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureKit } from '@atmusic/atproto/test-support/read-models';
import type { Random } from '@atmusic/core/deps';
import { recordingMsid } from '@atmusic/core/msid';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { NowPlayingRow, OperationRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { createLbToken, verifyLbToken } from '../../../src/credentials/lb-tokens';
import type { ModuleDeps } from '../../../src/do/contracts';
import type { SqlParam } from '../../../src/do/db';
import { need, type RequestCtx, type RouteDef } from '../../../src/http/types';
import { parseAuthorization } from '../../../src/listenbrainz/auth-header';
import { LB_RATE_LIMITED_MESSAGE } from '../../../src/listenbrainz/errors';
import { refusal } from '../../../src/listenbrainz/limiter';
import { RATE_LIMIT_EXPOSE_HEADERS } from '../../../src/listenbrainz/rate-headers';
import {
  createSubmitRoutes,
  IGNORED_LISTENS_DAILY_LIMIT,
  LB_DAILY_CAP_MESSAGE,
} from '../../../src/listenbrainz/submit';
import {
  createTokenRoutes,
  type LbDispatchAuth,
  type LbModuleRouteDef,
  listenBrainzLimiterFor,
} from '../../../src/listenbrainz/token-routes';
import { type BoundAddress, createServer } from '../../../src/node/http-bridge';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { PDS_WRITER_CAPS } from '../../../src/outbox/pds-writer';
import { type OutboxDeps, runOutbox } from '../../../src/outbox/runner';
import { TestWriters } from '../outbox/support';
import { closeApps, startApp, type TestApp } from '../support/app';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
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

const LB_ROUTES: readonly RouteDef[] = [...createSubmitRoutes(), ...createTokenRoutes()];

afterEach(closeApps);

// ---------------------------------------------------------------------------
// Helpers

interface Rig {
  app: TestApp;
  clock: FixedClock;
  random: Random;
  /** A users row, an account and a ListenBrainz token for `did`; returns the token. */
  user(did: string, handle: string): string;
  count(sql: string, ...params: (string | number)[]): number;
  ops(did: string): OperationRow[];
}

async function rig(o: { env?: Record<string, string | undefined>; clock?: FixedClock; kit?: boolean } = {}) {
  const clock = o.clock ?? fixedClock();
  const kit = o.kit === true ? await createFixtureKit({ clock }) : null;
  const app = await startApp({
    routes: LB_ROUTES,
    clock,
    ...(kit === null ? {} : { transport: kit.transport }),
    env: o.env ?? OPEN_GATE,
  });
  const random = seededRandom(0xb0b);
  const revocations = new MemoryRevocations(clock);
  const r: Rig = {
    app,
    clock,
    random,
    user(did, handle) {
      app.db.run(
        "INSERT INTO users (did, handle, joined_at) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z')",
        did,
        handle,
      );
      const deps = { db: app.db, clock, random, revocations };
      ensureAccount(deps, { did, verifiedHandle: handle });
      return createLbToken(deps, { did, label: 'test' }).token;
    },
    count(sql, ...params) {
      return app.db.one<{ n: number }>(sql, ...params)!.n;
    },
    ops(did) {
      return app.db.all<OperationRow>('SELECT * FROM operations WHERE did = ? ORDER BY rowid', did);
    },
  };
  return { ...r, kit };
}

function submit(
  app: TestApp,
  token: string | null,
  body: string | Uint8Array,
  o: { query?: string; scheme?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
  if (token !== null) headers.authorization = `${o.scheme ?? 'Token'} ${token}`;
  return app.fetch(`/1/submit-listens${o.query ?? ''}`, { method: 'POST', headers, body });
}

/** A ListenBrainz listen `i` (distinct names), listened_at a minute or more before now. */
function listen(i: number, o: { artist?: string; track?: string; at?: number } = {}) {
  return {
    listened_at: o.at ?? NOW_S - 60 - i,
    track_metadata: { artist_name: o.artist ?? `Artist ${i}`, track_name: o.track ?? `Track ${i}` },
  };
}

function body(listenType: string, payload: unknown[]): string {
  return JSON.stringify({ listen_type: listenType, payload });
}

/** listens [from, from + n) as one import. */
function importOf(from: number, n: number): string {
  return body(
    'import',
    Array.from({ length: n }, (_, k) => listen(from + k)),
  );
}

function record(op: OperationRow): Record<string, unknown> {
  return JSON.parse(op.record_json as string) as Record<string, unknown>;
}

function addLink(app: TestApp, did: string, service: 'lastfm' | 'listenbrainz'): string {
  const id = `link-${service}-${did.slice(-6)}`;
  app.db.run(
    `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
       forward_now_playing, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'remote', ?, 'e1', 1, 1, 'active', ?, ?)`,
    id,
    did,
    service,
    new Uint8Array([1, 2, 3]).buffer,
    NOW_MS,
    NOW_MS,
  );
  return id;
}

// ---------------------------------------------------------------------------
// The spy bridge: the composed handler behind a real bridge that records how
// many body bytes each request had read when its answer was ready.

interface SpyBridge {
  address: BoundAddress;
  reads: number[];
  close(): Promise<void>;
}

async function spyBridge(app: TestApp): Promise<SpyBridge> {
  const reads: number[] = [];
  const bridge = createServer({
    publicOrigin: app.config.publicOrigin,
    listen: { host: '127.0.0.1', port: 0 },
    handler: async (request, info) => {
      const response = await app.composed.handler(request, info);
      reads.push(info.bodyBytesRead());
      return response;
    },
    random: seededRandom(9),
  });
  const address = await bridge.start();
  return { address, reads, close: () => bridge.close() };
}

interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** POSTs a `total`-byte body; resolves with the answer even when the server closes before the body is sent. */
function postLarge(address: BoundAddress, headers: Record<string, string>, total: number): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({
      host: address.host,
      port: address.port,
      method: 'POST',
      path: '/1/submit-listens',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': String(total) },
    });
    req.on('response', (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    // The server answers and closes while most of the body is unsent: EPIPE or
    // ECONNRESET on the request side is expected once the answer has arrived.
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = (): void => {
      while (sent < total && !req.destroyed) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!req.write(chunk.subarray(0, n))) {
          req.once('drain', pump);
          return;
        }
      }
      if (!req.destroyed) req.end();
    };
    pump();
  });
}

// ---------------------------------------------------------------------------

describe('POST /1/submit-listens (ADR §8.3)', () => {
  it('a single listen returns 200 {status:ok} and creates one operation and listen key; an import of 1000 creates 1000', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');

    const single = await submit(
      r.app,
      token,
      body('single', [listen(0, { artist: 'Boards of Canada', track: 'Roygbiv' })]),
    );
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual({ status: 'ok' });
    expect(single.headers.get('access-control-allow-origin')).toBe('*');
    expect(single.headers.get('x-ratelimit-limit')).toBe('100');
    expect(single.headers.get('x-ratelimit-remaining')).toBe('99');

    const ops = r.ops(ALICE);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'scrobble.create',
      origin: 'listenbrainz',
      priority: 0,
      state: 'queued',
      due_at: NOW_MS,
      collection: SCROBBLE,
    });
    expect(record(ops[0]!)).toMatchObject({
      $type: SCROBBLE,
      artist: 'Boards of Canada',
      track: 'Roygbiv',
    });
    expect(Date.parse(record(ops[0]!).listenedAt as string)).toBe((NOW_S - 60) * 1000);
    expect(r.count("SELECT count(*) AS n FROM listen_keys WHERE did = ? AND source = 'listenbrainz'", ALICE)).toBe(1);

    const imported = await submit(r.app, token, importOf(1, 1000));
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ status: 'ok' });
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(1001);
    expect(
      r.count(
        "SELECT count(*) AS n FROM operations WHERE did = ? AND kind = 'scrobble.create' AND origin = 'listenbrainz' AND priority = 0",
        ALICE,
      ),
    ).toBe(1001);
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)).toBe(1001);
    // A client import is a live submission, not an import job.
    expect(r.count('SELECT count(*) AS n FROM import_jobs')).toBe(0);
  }, 30_000);

  it('playing_now with return_msid=false (non-empty) returns status ok and recording_msid, stores now playing and creates no operation', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    addLink(r.app, ALICE, 'listenbrainz');
    const res = await submit(
      r.app,
      token,
      body('playing_now', [
        {
          track_metadata: {
            artist_name: '  Aphex Twin ',
            track_name: 'Xtal',
            release_name: 'Selected Ambient Works 85-92',
            additional_info: { duration_ms: 291_500, submission_client: 'Navidrome' },
          },
        },
      ]),
      { query: '?return_msid=false' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', recording_msid: await recordingMsid('Aphex Twin', 'Xtal') });

    const row = r.app.db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', ALICE);
    expect(row).toMatchObject({
      artist: 'Aphex Twin',
      track: 'Xtal',
      album: 'Selected Ambient Works 85-92',
      client: 'Navidrome',
      source: 'listenbrainz',
      started_at_ms: NOW_MS,
      duration_seconds: 292,
      // The TTL is duration_ms / 1000, rounded half up.
      expires_at_ms: NOW_MS + 292_000,
    });
    expect(r.count('SELECT count(*) AS n FROM operations')).toBe(0);
    expect(r.count('SELECT count(*) AS n FROM listen_keys')).toBe(0);
    expect(r.count("SELECT count(*) AS n FROM forward_outbox WHERE did = ? AND kind = 'nowplaying'", ALICE)).toBe(1);

    // An identical current track is ignored but still answers ok; without return_msid there is no msid.
    const again = await submit(
      r.app,
      token,
      body('playing_now', [{ track_metadata: { artist_name: 'Aphex Twin', track_name: 'Xtal' } }]),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'ok' });
    expect(r.app.db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', ALICE)).toEqual(row);
    expect(r.count("SELECT count(*) AS n FROM forward_outbox WHERE did = ? AND kind = 'nowplaying'", ALICE)).toBe(1);
    expect(r.count('SELECT count(*) AS n FROM operations')).toBe(0);
  });

  it('resubmitting identical listens creates no operations; the 3,001st listen of the day is 429 with Retry-After, X-RateLimit-Limit/Remaining/Reset/Reset-In and Access-Control-Expose-Headers; a closed publication gate is 503', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');

    const first = await submit(r.app, token, importOf(0, 1000));
    expect(first.status).toBe(200);
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(1000);
    const resend = await submit(r.app, token, importOf(0, 1000));
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ status: 'ok' });
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(1000);
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)).toBe(1000);

    for (const from of [1000, 2000]) {
      const res = await submit(r.app, token, importOf(from, 1000));
      expect(res.status).toBe(200);
    }
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(3000);

    const over = await submit(r.app, token, body('single', [listen(3000)]));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ code: 429, error: LB_DAILY_CAP_MESSAGE });
    expect(over.headers.get('retry-after')).toBe('86400');
    expect(over.headers.get('x-ratelimit-limit')).toBe('3000');
    expect(over.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(over.headers.get('x-ratelimit-reset')).toBe(String(NOW_S + 86_400));
    expect(over.headers.get('x-ratelimit-reset-in')).toBe('86400');
    expect(over.headers.get('access-control-expose-headers')).toBe(RATE_LIMIT_EXPOSE_HEADERS);
    expect(over.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(3000);
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)).toBe(3000);

    // The window is rolling: a day later the same listen is accepted.
    r.clock.advance(86_400_000);
    const nextDay = await submit(r.app, token, body('single', [listen(3000)]));
    expect(nextDay.status).toBe(200);
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(3001);

    // A closed publication gate is 503 with nothing written: no lexicon
    // prefix at all, and the fixture prefix, which never carries the
    // `publication` capability (ADR §5.7).
    for (const env of [{ LEXICON_PREFIX: '', NAMESPACE_OWNERSHIP_REF: '' }, FIXTURE_GATE]) {
      const closed = await rig({ env });
      expect(closed.app.config.app.publication).toBe(false);
      const bobToken = closed.user(BOB, 'bob.example.com');
      const refused = await submit(closed.app, bobToken, body('single', [listen(0)]));
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({
        code: 503,
        error: 'Cannot submit listens to queue, please try again later.',
      });
      expect(refused.headers.get('access-control-allow-origin')).toBe('*');
      const imported = await submit(closed.app, bobToken, importOf(0, 3));
      expect(imported.status).toBe(503);
      expect(closed.count('SELECT count(*) AS n FROM operations')).toBe(0);
      expect(closed.count('SELECT count(*) AS n FROM listen_keys')).toBe(0);
      expect(closed.count('SELECT count(*) AS n FROM ignored_listens')).toBe(0);
    }
  }, 60_000);

  it('recorded Web Scrobbler (scrobble and now playing), Navidrome (int tracknumber, artist_names) and Pano request bodies are accepted unchanged', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    const fixtures = [
      {
        file: 'web-scrobbler-single.body',
        sha256: 'ad91aef1cc882666e3870904e647591d77b54720969179e9615afb75f2197a8c',
        headers: { authorization: `Token ${token}`, 'content-type': 'application/json; charset=utf-8' },
      },
      {
        file: 'web-scrobbler-playing-now.body',
        sha256: '8d2d70d7da62babc84520bc2e5f8ebd3df71b6473f9af98d9d9b75ea5caa9fdf',
        headers: { authorization: `Token ${token}`, 'content-type': 'application/json; charset=utf-8' },
      },
      {
        file: 'navidrome-single.body',
        sha256: 'cc514be87df03a290879962481e4ed2899a12a37b2ae48fb5e84f67920676dbc',
        headers: { authorization: `Token ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      },
      {
        file: 'pano-single.body',
        sha256: '8a16fb391113f7c9c27477aa2f40b6a6783e1a491f0354b126ae53a530a48a76',
        headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      },
    ];
    for (const f of fixtures) {
      const bytes = readFileSync(join(FIXTURES, f.file));
      // The committed bytes are the recorded ones.
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
      const res = await r.app.fetch('/1/submit-listens', { method: 'POST', headers: f.headers, body: bytes });
      expect(res.status, f.file).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    }

    const ops = r.ops(ALICE);
    expect(ops).toHaveLength(3);
    const [webScrobbler, navidrome, pano] = ops.map(record);
    expect(webScrobbler).toMatchObject({
      artist: 'Sigur Rós',
      track: 'Hoppípolla',
      album: 'Takk...',
      albumArtist: 'Sigur Rós',
      durationSeconds: 268,
      submissionClient: 'Web Scrobbler 3.15.0',
    });
    expect(Date.parse(webScrobbler!.listenedAt as string)).toBe(1_768_478_220_000);
    expect(navidrome).toMatchObject({
      artist: 'Daft Punk',
      track: 'Harder, Better, Faster, Stronger',
      album: 'Discovery',
      trackNumber: 4,
      artistMbids: ['056e4f3e-d505-4dad-8ec1-d04f521cbb56'],
      recordingMbid: 'c3a1f2d4-5b6e-4f70-8a91-b2c3d4e5f607',
      releaseMbid: '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b',
      releaseGroupMbid: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      durationSeconds: 224,
      submissionClient: 'Navidrome 0.58.0 (5d1f3e2)',
    });
    expect(pano).toMatchObject({
      artist: 'Radiohead',
      track: 'Paranoid Android',
      album: 'OK Computer',
      albumArtist: 'Radiohead',
      durationSeconds: 383,
      submissionClient: 'Pano Scrobbler 4.10',
    });
    expect(r.app.db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', ALICE)).toMatchObject({
      artist: 'Sigur Rós',
      track: 'Glósóli',
      album: 'Takk...',
      client: 'Web Scrobbler',
      expires_at_ms: NOW_MS + 375_000,
    });
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)).toBe(3);
  });

  it('return_msid on a single or import submission is ignored and the response is {status:ok}', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    for (const [type, query] of [
      ['single', '?return_msid=true'],
      ['import', '?return_msid=1'],
    ] as const) {
      const res = await submit(r.app, token, body(type, [listen(type === 'single' ? 0 : 1)]), { query });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ status: 'ok' });
      expect(text).not.toContain('recording_msid');
    }
    expect(r.count('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)).toBe(2);
  });

  it('an unauthenticated or token-rate-limited 10 MB submit gets 401 or 429 with zero body bytes read', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    const spy = await spyBridge(r.app);
    try {
      const TEN_MB = 10_000_000;

      const anonymous = await postLarge(spy.address, {}, TEN_MB);
      expect(anonymous.status).toBe(401);
      expect(JSON.parse(anonymous.body)).toEqual({ code: 401, error: 'You need to provide an Authorization header.' });
      expect(spy.reads.at(-1)).toBe(0);

      const unknown = await postLarge(
        spy.address,
        { authorization: 'Token 00000000-0000-4000-8000-000000000000' },
        TEN_MB,
      );
      expect(unknown.status).toBe(401);
      expect(JSON.parse(unknown.body)).toEqual({ code: 401, error: 'Invalid authorization token.' });
      expect(spy.reads.at(-1)).toBe(0);

      // Spend the token's 100 requests per 10 s (frozen clock: nothing refills).
      for (let i = 0; i < 100; i++) {
        const v = await r.app.fetch('/1/validate-token', { headers: { authorization: `Token ${token}` } });
        expect(v.status).toBe(200);
      }
      const limited = await postLarge(spy.address, { authorization: `Token ${token}` }, TEN_MB);
      expect(limited.status).toBe(429);
      expect(JSON.parse(limited.body)).toEqual({ code: 429, error: LB_RATE_LIMITED_MESSAGE });
      expect(limited.headers['x-ratelimit-limit']).toBe('100');
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(spy.reads.at(-1)).toBe(0);
      expect(spy.reads).toEqual([0, 0, 0]);
      expect(r.count('SELECT count(*) AS n FROM operations')).toBe(0);
    } finally {
      await spy.close();
    }
  }, 30_000);

  it('an import of 3 listens whose second has a 300-scalar artist_name answers 200 {status:ok}, creates 2 operations and 2 listen keys, and adds 1 ignored_listens row with reason artist_invalid', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    const longArtist = 'é'.repeat(300);
    const res = await submit(
      r.app,
      token,
      body('import', [listen(0), listen(1, { artist: longArtist, track: 'Long' }), listen(2)]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    const ops = r.ops(ALICE);
    expect(ops.map((op) => record(op).artist)).toEqual(['Artist 0', 'Artist 2']);
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ?', ALICE)).toBe(2);
    const ignored = r.app.db.all<Record<string, unknown>>('SELECT * FROM ignored_listens WHERE did = ?', ALICE);
    expect(ignored).toEqual([
      {
        id: expect.any(Number),
        did: ALICE,
        source: 'listenbrainz',
        reason: 'artist_invalid',
        listened_at: '2026-01-15T11:58:59.000000000Z',
        artist_preview: 'é'.repeat(128),
        track_preview: 'Long',
        created_at_ms: NOW_MS,
      },
    ]);
  });

  it('a single listen 1,000 s in the future answers 200, and its operation is due and dated at listened_at − 300 s and is not sent before then', async () => {
    const clock = fixedClock();
    const r = await rig({ clock, kit: true });
    const kit = r.kit!;
    const did = kit.users.Alice.did;
    const token = r.user(did, kit.users.Alice.handle);
    const listenedAt = NOW_S + 1000;
    const dueMs = (listenedAt - 300) * 1000;

    const res = await submit(r.app, token, body('single', [listen(0, { at: listenedAt })]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    const [op] = r.ops(did);
    expect(op).toMatchObject({ kind: 'scrobble.create', state: 'queued', due_at: dueMs, attempts: 0 });
    expect(Date.parse(record(op!).createdAt as string)).toBe(dueMs);
    expect(Date.parse(record(op!).listenedAt as string)).toBe(listenedAt * 1000);
    // The listen key is immediate.
    expect(r.count('SELECT count(*) AS n FROM listen_keys WHERE did = ? AND created_at_ms = ?', did, NOW_MS)).toBe(1);

    const writers = new TestWriters(
      kit,
      bindPolicyFetch(createPolicyFetch({ transport: kit.transport }), PDS_WRITER_CAPS),
    );
    const m: OutboxDeps = { ...r.app.composed.core.deps, writers };
    const now = await runOutbox(m, clock.nowMs());
    expect(now).toMatchObject({ attempted: 0, nextDueMs: dueMs });
    clock.set(new Date(dueMs - 1000).toISOString());
    const early = await runOutbox(m, clock.nowMs());
    expect(early.attempted).toBe(0);
    expect(writers.sent).toEqual([]);
    expect(r.ops(did)[0]).toMatchObject({ state: 'queued', attempts: 0 });

    clock.set(new Date(dueMs).toISOString());
    const due = await runOutbox(m, clock.nowMs());
    expect(due.attempted).toBe(1);
    expect(writers.sent.length).toBeGreaterThanOrEqual(1);
    const sent = r.ops(did)[0]!;
    expect(sent.state).toBe('succeeded');
    const remote = await kit.repos.Alice.getRecord(SCROBBLE, sent.rkey!);
    expect(remote).not.toBeNull();
    expect(Date.parse((remote!.value as { createdAt: string }).createdAt)).toBe(dueMs);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ignored_listens is idempotent and bounded (ADR §8.3, Q11).

describe('ignored listens on resend (ADR §8.3)', () => {
  const LONG = 'é'.repeat(300);
  const ignoredCount = (r: Rig) => r.count('SELECT count(*) AS n FROM ignored_listens WHERE did = ?', ALICE);

  it('resending the 3-listen batch, a duplicate in one request and a retry after the daily-cap 429 keep one ignored_listens row', async () => {
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    const batch = body('import', [listen(0), listen(1, { artist: LONG, track: 'Long' }), listen(2)]);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await submit(r.app, token, batch);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    }
    expect(r.ops(ALICE).length).toBe(2);
    expect(ignoredCount(r)).toBe(1);

    // The same ignored listen twice in one request is recorded once; a
    // different second or reason is a different listen.
    const twice = await submit(
      r.app,
      token,
      body('import', [
        listen(1, { artist: LONG, track: 'Long' }),
        listen(1, { artist: LONG, track: 'Long' }),
        listen(3, { artist: LONG, track: 'Long' }),
        listen(1, { artist: 'Short', track: LONG }),
      ]),
    );
    expect(twice.status).toBe(200);
    expect(
      r.app.db
        .all<{ reason: string; listened_at: string }>(
          'SELECT reason, listened_at FROM ignored_listens WHERE did = ? ORDER BY id',
          ALICE,
        )
        .map((row) => [row.reason, row.listened_at]),
    ).toEqual([
      ['artist_invalid', '2026-01-15T11:58:59.000000000Z'],
      ['artist_invalid', '2026-01-15T11:58:57.000000000Z'],
      ['track_invalid', '2026-01-15T11:58:59.000000000Z'],
    ]);

    // Over the daily cap: the 429 still records the ignored listen once, and a retry adds nothing.
    r.app.db.run('UPDATE accounts SET daily_listen_cap = 3 WHERE did = ?', ALICE);
    const capped = body('import', [listen(10), listen(11, { artist: LONG, track: 'Capped' }), listen(12)]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await submit(r.app, token, capped);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ code: 429, error: LB_DAILY_CAP_MESSAGE });
    }
    expect(r.ops(ALICE).length).toBe(3);
    expect(ignoredCount(r)).toBe(4);
    expect(
      r.count('SELECT count(*) AS n FROM ignored_listens WHERE did = ? AND track_preview = ?', ALICE, 'Capped'),
    ).toBe(1);
  });

  it('at most IGNORED_LISTENS_DAILY_LIMIT ignored rows are recorded per DID in 24 h; past it the answer is still 200', async () => {
    expect(IGNORED_LISTENS_DAILY_LIMIT).toBe(3000);
    const r = await rig();
    const token = r.user(ALICE, 'alice.example.com');
    const bobToken = r.user(BOB, 'bob.example.com');
    const ignoredBatch = (from: number, n: number) =>
      body(
        'import',
        Array.from({ length: n }, (_, k) => listen(from + k, { artist: `${from + k}-${LONG}`, track: 'Long' })),
      );

    for (const from of [0, 1000, 2000]) {
      expect((await submit(r.app, token, ignoredBatch(from, 1000))).status).toBe(200);
    }
    expect(ignoredCount(r)).toBe(3000);
    const past = await submit(r.app, token, ignoredBatch(3000, 1000));
    expect(past.status).toBe(200);
    expect(await past.json()).toEqual({ status: 'ok' });
    expect(ignoredCount(r)).toBe(3000);
    expect(r.ops(ALICE).length).toBe(0);
    // The bound is per DID.
    expect((await submit(r.app, bobToken, ignoredBatch(0, 2))).status).toBe(200);
    expect(r.count('SELECT count(*) AS n FROM ignored_listens WHERE did = ?', BOB)).toBe(2);

    // The window is rolling.
    r.clock.advance(86_400_000);
    expect((await submit(r.app, token, ignoredBatch(5000, 2))).status).toBe(200);
    expect(ignoredCount(r)).toBe(3002);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Mounted through the /1/ dispatcher (N3-06 routes.ts `registry`): the
// dispatcher verifies and charges once; the routes of this package take its
// outcome and neither look the token up again nor charge a limiter.

describe('the routes under the /1/ dispatcher (ADR §8.7)', () => {
  /** The contract of N3-06's router: authenticate, charge the composition's limiter, answer `auth: required`, run. */
  function dispatcher(
    registry: readonly LbModuleRouteDef[],
    lookups: { n: number },
  ): { routes: RouteDef[]; countingDeps(deps: ModuleDeps): ModuleDeps } {
    const counted = new WeakMap<ModuleDeps, ModuleDeps>();
    /** The composition's deps with a db that counts token lookups (one object per app, so one limiter). */
    const countingDeps = (deps: ModuleDeps): ModuleDeps => {
      let wrapped = counted.get(deps);
      if (wrapped === undefined) {
        const db = deps.db;
        const count = (sql: string) => {
          if (sql.includes('FROM lb_tokens WHERE hash')) lookups.n++;
        };
        wrapped = {
          ...deps,
          db: {
            all<T>(sql: string, ...p: SqlParam[]): T[] {
              count(sql);
              return db.all<T>(sql, ...p);
            },
            one<T>(sql: string, ...p: SqlParam[]): T | null {
              count(sql);
              return db.one<T>(sql, ...p);
            },
            run: (sql, ...p) => db.run(sql, ...p),
            tx: (fn) => db.tx(fn),
          },
        };
        counted.set(deps, wrapped);
      }
      return wrapped;
    };
    const read: LbModuleRouteDef = {
      method: 'GET',
      pattern: '/1/user/{user}/listen-count',
      handler: async (_req, _ctx, _params, lb) =>
        new Response(JSON.stringify({ payload: { count: 0 } }), { headers: lb!.limit.headers }),
    };
    const routes = [...registry, read]
      .filter((route) => route.method !== 'OPTIONS')
      .map((route) => ({
        method: route.method,
        pattern: route.pattern,
        handler: async (req: Request, ctx: RequestCtx, params: Record<string, string>) => {
          const inner: RequestCtx = { ...ctx, deps: countingDeps(need(ctx, 'deps')) };
          const m = need(inner, 'deps');
          const parsed = parseAuthorization(req.headers.get('authorization'));
          const token = parsed.ok ? verifyLbToken(m, parsed.token) : null;
          const auth: LbDispatchAuth = !parsed.ok
            ? { status: 'absent', failure: parsed.failure }
            : token === null
              ? { status: 'invalid' }
              : { status: 'valid', token };
          const limit = listenBrainzLimiterFor(inner).limit(
            { clientIp: inner.clientIp },
            auth.status === 'valid' ? { status: 'valid', tokenId: auth.token.id } : { status: auth.status },
          );
          if (!limit.allowed) return refusal(limit);
          if (route.auth === 'required' && auth.status !== 'valid') {
            return new Response('dispatcher 401', { status: 401, headers: limit.headers });
          }
          return route.handler(req, inner, params, { auth, limit });
        },
      }));
    return { routes, countingDeps };
  }

  it('60 reads then a submit, validate-token, playing-now/delete and delete-listen leave X-RateLimit-Remaining at 100 − (requests so far), with one token lookup per request', async () => {
    const lookups = { n: 0 };
    const registry = [...createSubmitRoutes(), ...createTokenRoutes()];
    expect(registry.filter((route) => route.method !== 'OPTIONS').map((route) => [route.pattern, route.auth])).toEqual([
      ['/1/submit-listens', 'required'],
      ['/1/validate-token', 'optional'],
      ['/1/delete-listen', 'required'],
      ['/1/playing-now/delete', 'required'],
    ]);
    const clock = fixedClock();
    const mounted = dispatcher(registry, lookups);
    const app = await startApp({ routes: mounted.routes, clock, env: OPEN_GATE });
    app.db.run(
      "INSERT INTO users (did, handle, joined_at) VALUES (?, 'alice.example.com', '2026-01-15T12:00:00.000000000Z')",
      ALICE,
    );
    const deps = { db: app.db, clock, random: seededRandom(0xd15), revocations: new MemoryRevocations(clock) };
    ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.example.com' });
    const token = createLbToken(deps, { did: ALICE, label: 'test' }).token;
    const authorization = `Token ${token}`;

    const N = 60;
    for (let i = 1; i <= N; i++) {
      const res = await app.fetch('/1/user/alice/listen-count', { headers: { authorization } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-remaining')).toBe(String(100 - i));
    }
    expect(lookups.n).toBe(N);

    const submitted = await submit(app, token, body('single', [listen(0)]));
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ status: 'ok' });
    expect(submitted.headers.get('x-ratelimit-limit')).toBe('100');
    expect(submitted.headers.get('x-ratelimit-remaining')).toBe(String(100 - (N + 1)));
    expect(lookups.n).toBe(N + 1);
    expect(app.db.one<{ n: number }>('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)!.n).toBe(1);

    const validated = await app.fetch('/1/validate-token', { headers: { authorization } });
    expect(validated.status).toBe(200);
    expect(await validated.json()).toEqual({
      code: 200,
      message: 'Token valid.',
      valid: true,
      user_name: 'alice.example.com',
    });
    expect(validated.headers.get('x-ratelimit-remaining')).toBe(String(100 - (N + 2)));
    expect(lookups.n).toBe(N + 2);

    const cleared = await app.fetch('/1/playing-now/delete', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ status: 'ok', message: 'Playing now already cleared' });
    expect(cleared.headers.get('x-ratelimit-remaining')).toBe(String(100 - (N + 3)));

    const deleted = await app.fetch('/1/delete-listen', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ listened_at: NOW_S - 60, recording_msid: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: 'ok' });
    expect(deleted.headers.get('x-ratelimit-remaining')).toBe(String(100 - (N + 4)));
    expect(lookups.n).toBe(N + 4);

    // A ?token= candidate is not the dispatcher's, so validate-token looks it
    // up itself; the request is still charged once (per IP: no header token).
    const byQuery = await app.fetch(`/1/validate-token?token=${token}`);
    expect(byQuery.status).toBe(200);
    expect(((await byQuery.json()) as { valid: unknown }).valid).toBe(true);
    expect(byQuery.headers.get('x-ratelimit-limit')).toBe('30');
    expect(byQuery.headers.get('x-ratelimit-remaining')).toBe('29');
    expect(lookups.n).toBe(N + 5);

    // The token bucket was charged once per request: the next read sees it.
    const next = await app.fetch('/1/user/alice/listen-count', { headers: { authorization } });
    expect(next.headers.get('x-ratelimit-remaining')).toBe(String(100 - (N + 5)));

    // The dispatcher answers `auth: required` itself; a route reached anyway
    // without a live token answers its 401 from the outcome, with no lookup.
    expect((await submit(app, null, body('single', [listen(1)]))).status).toBe(401);
    const before = lookups.n;
    const [submitRoute] = createSubmitRoutes();
    const directCtx = { deps: mounted.countingDeps(app.composed.core.deps), clientIp: '127.0.0.1' } as RequestCtx;
    const limiter = listenBrainzLimiterFor(directCtx);
    const limit = limiter.limit({ clientIp: '127.0.0.1' }, { status: 'invalid' });
    const direct = await submitRoute!.handler(
      new Request('https://music.example.test/1/submit-listens', {
        method: 'POST',
        headers: { authorization: 'Token 00000000-0000-4000-8000-000000000000' },
        body: body('single', [listen(1)]),
      }),
      directCtx,
      {},
      { auth: { status: 'invalid' }, limit },
    );
    expect(direct.status).toBe(401);
    expect(await direct.json()).toEqual({ code: 401, error: 'Invalid authorization token.' });
    expect(direct.headers.get('x-ratelimit-remaining')).toBe(limit.headers['X-RateLimit-Remaining']);
    expect(lookups.n).toBe(before);
    // Nothing else was charged: the per-IP bucket moved by the one charge above.
    const after = limiter.limit({ clientIp: '127.0.0.1' }, { status: 'invalid' });
    expect(Number(after.headers['X-RateLimit-Remaining'])).toBe(Number(limit.headers['X-RateLimit-Remaining']) - 1);
    expect(app.db.one<{ n: number }>('SELECT count(*) AS n FROM operations WHERE did = ?', ALICE)!.n).toBe(1);
  }, 30_000);
});
