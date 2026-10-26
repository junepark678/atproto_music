// The v1.2 cookie write and operation routes (ADR 0005 §5.6, §5.7, §5.8;
// N3-02): POST/DELETE /api/v1/scrobbles, PUT/DELETE follows and loves, PUT
// account/indexing, GET /api/v1/operations/{id}, and the unchanged public v1.1
// reads next to them.
//
// Each test runs the real Node composition (support/app.ts) on 127.0.0.1:0
// with writesFeature mounted, over the fixture network (fake PDS, PLC and DoH
// through the router transport; nothing leaves the process), the frozen clock
// 2026-01-15T12:00:00Z and seeded randomness. Sessions are real
// `__Host-atmusic_session` rows (bff/sessions.ts) and every unsafe request
// carries the real Origin and HMAC X-CSRF-Token. The outbox is run by hand
// with PdsWriters over policyFetch to the fake PDS (outbox/support.ts), so a
// test observes what reached the PDS. Every answer is checked by status, the
// api/openapi.yaml schema of that status (AJV), and the database rows.
//
// Publication. The fixture prefix com.example.atmusic never opens the
// publication gate (config.ts), so the 202 paths run with the reserved-domain
// test prefix org.example.music plus test ownership evidence, exactly as
// worker/test/http/health-meta.test.ts opens it; the closed-gate case runs on
// the fixture prefix.

import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { createFixtureKit, type FixtureKit, followRkey } from '@atmusic/atproto/test-support/read-models';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/read_models.json' with { type: 'json' };
import { MemoryRevocations } from '../../../src/app/revocations';
import type { OperationRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Db, SqlParam } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import type { WebWritesServices } from '../../../src/http/operations';
import { writesFeature } from '../../../src/http/writes';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { PDS_WRITER_CAPS } from '../../../src/outbox/pds-writer';
import { runOutbox } from '../../../src/outbox/runner';
import { checkResponse } from '../../acceptance/support/openapi';
import { TestWriters } from '../outbox/support';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

const OWNED = 'org.example.music';
const OWNED_ENV = { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org' };
const SCROBBLE = `${OWNED}.scrobble`;
const FOLLOW = `${OWNED}.follow`;
const LOVE = `${OWNED}.love`;
const SETTINGS = `${OWNED}.settings`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const T0 = Date.parse('2026-01-15T12:00:00Z');

afterEach(async () => {
  await closeApps();
});

// ---------------------------------------------------------------------------
// The world

interface Signed {
  did: string;
  token: string;
  cookie: string;
  csrf: string;
}

interface SendOptions {
  /** The session; omitted: no cookie. */
  as?: Signed;
  /** Default true with a session: Origin plus X-CSRF-Token. */
  csrf?: boolean;
  origin?: string | null;
  body?: unknown;
  /** A raw body (sent as is). */
  raw?: string;
  key?: string;
  headers?: Record<string, string>;
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

interface World {
  app: TestApp;
  kit: FixtureKit;
  writers: TestWriters;
  sessions: WebSessions;
  signIn(did: string, handle?: string | null): Signed;
  send(method: string, path: string, o?: SendOptions): Promise<Answer>;
  /** Runs the outbox until nothing is due now. */
  drain(): Promise<void>;
  ops(where?: string, ...args: SqlParam[]): OperationRow[];
  count(table: string, where?: string, ...args: SqlParam[]): number;
}

async function world(o: { publication?: boolean } = {}): Promise<World> {
  const kit = await createFixtureKit({ clock: fixedClock() });
  let sessions: WebSessions | null = null;
  const app = await startApp({
    transport: kit.transport,
    clock: kit.clock,
    env: o.publication === false ? {} : OWNED_ENV,
    features: [
      writesFeature({
        sessions: (context) => {
          sessions = createWebSessions({
            db: context.deps.db,
            clock: context.deps.clock,
            random: context.deps.random,
            revocations: new MemoryRevocations(context.deps.clock),
          });
          return sessions;
        },
      }),
    ],
  });
  if (sessions === null) throw new Error('writesFeature did not build its sessions');
  const store: WebSessions = sessions;
  const service = (app.composed.app as unknown as WebWritesServices).webWrites;
  const writers = new TestWriters(
    kit,
    bindPolicyFetch(createPolicyFetch({ transport: kit.transport }), PDS_WRITER_CAPS),
  );
  const deps = app.composed.core.deps;
  return {
    app,
    kit,
    writers,
    sessions: store,
    signIn(did, handle = null) {
      ensureAccount({ db: app.db, clock: kit.clock }, { did, verifiedHandle: handle });
      const issued = store.create(did);
      return {
        did,
        token: issued.token,
        cookie: `${SESSION_COOKIE}=${issued.token}`,
        csrf: csrfToken(service.csrfKey, issued.token),
      };
    },
    async send(method, path, s = {}) {
      const headers = new Headers(s.headers);
      if (s.as !== undefined) {
        headers.set('cookie', s.as.cookie);
        if (s.csrf !== false) headers.set('x-csrf-token', s.as.csrf);
      }
      const origin =
        s.origin === undefined ? (s.as !== undefined && s.csrf !== false ? TEST_PUBLIC_ORIGIN : null) : s.origin;
      if (origin !== null) headers.set('origin', origin);
      if (s.key !== undefined) headers.set('idempotency-key', s.key);
      let body: string | undefined;
      if (s.raw !== undefined) body = s.raw;
      else if (s.body !== undefined) body = JSON.stringify(s.body);
      if (body !== undefined) headers.set('content-type', 'application/json');
      const res = await app.fetch(path, { method, headers, ...(body === undefined ? {} : { body }) });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, headers: res.headers, text, body: parsed };
    },
    async drain() {
      for (let i = 0; i < 50; i++) {
        const report = await runOutbox({ ...deps, writers }, kit.clock.nowMs());
        if (report.nextDueMs === null || report.nextDueMs > kit.clock.nowMs()) return;
      }
      throw new Error('outbox still busy');
    },
    ops(where = '1', ...args) {
      return app.db.all<OperationRow>(`SELECT * FROM operations WHERE ${where} ORDER BY rowid`, ...args);
    },
    count(table, where = '1', ...args) {
      return app.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...args)!.n;
    },
  };
}

/** The OpenAPI check of an answer (status declared, JSON body valid). */
function contract(method: string, path: string, a: Answer): string {
  return checkResponse(method, path, { status: a.status, headers: a.headers, body: a.body });
}

function opOf(a: Answer): { id: string; kind: string; origin: string; state: string; attempts: number; uri?: string } {
  return (a.body as { operation: { id: string; kind: string; origin: string; state: string; attempts: number } })
    .operation;
}

function errorCode(a: Answer): string {
  return (a.body as { error: { code: string } }).error.code;
}

function fieldsOf(a: Answer): Record<string, string> {
  return (a.body as { error: { fields?: Record<string, string> } }).error.fields ?? {};
}

const LISTEN = { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:58:00Z', album: 'Homogenic' };

function linkLastfm(db: Db, did: string): void {
  db.run(
    `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
       forward_now_playing, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'lastfm', 'remote-alice', ?, 'e1', 1, 1, 'active', ?, ?)`,
    `link-${did}`,
    did,
    new Uint8Array([1, 2, 3]).buffer,
    T0,
    T0,
  );
}

// ---------------------------------------------------------------------------

describe('POST /api/v1/scrobbles', () => {
  it('POST /api/v1/scrobbles with Idempotency-Key returns 202 Operation; the same key and body returns the same operation; a different body is 409 idempotency_conflict; no key is 400', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    linkLastfm(w.app.db, ALICE);

    const first = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'k-1', body: LISTEN });
    expect(first.status).toBe(202);
    expect(contract('POST', '/api/v1/scrobbles', first)).toBe('valid');
    const op = opOf(first);
    expect(op).toMatchObject({ kind: 'scrobble.create', origin: 'web', state: 'queued', attempts: 0 });
    expect(first.headers.get('cache-control')).toBe('no-store');
    // Durably queued with the key, at live priority, with its listen key and forward row.
    const rows = w.ops();
    expect(rows.map((r) => [r.id, r.did, r.kind, r.origin, r.priority, r.collection, r.idempotency_key])).toEqual([
      [op.id, ALICE, 'scrobble.create', 'web', 0, SCROBBLE, 'k-1'],
    ]);
    expect(JSON.parse(rows[0]!.record_json!)).toMatchObject({ $type: SCROBBLE, artist: 'Björk', track: 'Jóga' });
    expect(w.count('listen_keys', 'did = ? AND operation_id = ?', ALICE, op.id)).toBe(1);
    expect(w.count('forward_outbox', 'did = ? AND kind = ?', ALICE, 'scrobble')).toBe(1);

    // The same listen spelled differently (key order, whitespace, the instant as +00:00) is the same request.
    const respelled = `{ "album":"Homogenic",  "listenedAt":"2026-01-15T11:58:00+00:00", "track":"Jóga", "artist":" Björk " }`;
    const again = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'k-1', raw: respelled });
    expect(again.status).toBe(202);
    expect(contract('POST', '/api/v1/scrobbles', again)).toBe('valid');
    expect(opOf(again).id).toBe(op.id);

    // The same key with another listen.
    const other = await w.send('POST', '/api/v1/scrobbles', {
      as: alice,
      key: 'k-1',
      body: { ...LISTEN, track: 'Hunter' },
    });
    expect(other.status).toBe(409);
    expect(contract('POST', '/api/v1/scrobbles', other)).toBe('valid');
    expect(other.body).toMatchObject({
      error: { code: 'idempotency_conflict', message: 'This Idempotency-Key was used with a different request.' },
    });

    // No key at all.
    const missing = await w.send('POST', '/api/v1/scrobbles', {
      as: alice,
      body: { ...LISTEN, track: 'Bachelorette' },
    });
    expect(missing.status).toBe(400);
    expect(contract('POST', '/api/v1/scrobbles', missing)).toBe('valid');
    expect(errorCode(missing)).toBe('idempotency_key_required');

    expect(w.count('operations')).toBe(1);
    expect(w.count('listen_keys')).toBe(1);
    expect(w.count('forward_outbox')).toBe(1);
    expect(w.kit.pds.Alice.count()).toBe(0);
  });

  it('no cookie is 401, missing CSRF is 403 csrf_failed, invalid fields are 422 with the v1.0 ScrobbleInput field names, a closed publication gate is 503 publication_disabled', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/api/v1/scrobbles', LISTEN],
      ['DELETE', `/api/v1/scrobbles/${encodeURIComponent(`at://${ALICE}/${SCROBBLE}/3mfixture22a2`)}`, undefined],
      ['PUT', `/api/v1/follows/${BOB}`, undefined],
      ['DELETE', `/api/v1/follows/${BOB}`, undefined],
      ['PUT', '/api/v1/loves', { artist: 'Björk', track: 'Jóga' }],
      ['DELETE', '/api/v1/loves?artist=Bj%C3%B6rk&track=J%C3%B3ga', undefined],
      ['PUT', '/api/v1/account/indexing', { indexing: 'disabled' }],
    ];
    for (const [method, path, body] of writes) {
      const anonymous = await w.send(method, path, { body, key: 'k-auth', origin: TEST_PUBLIC_ORIGIN });
      expect([method, path, anonymous.status, errorCode(anonymous)]).toEqual([method, path, 401, 'unauthenticated']);
      expect(contract(method, path, anonymous)).toBe('valid');
      const noCsrf = await w.send(method, path, { as: alice, csrf: false, body, key: 'k-auth' });
      expect([method, path, noCsrf.status, errorCode(noCsrf)]).toEqual([method, path, 403, 'csrf_failed']);
      expect(contract(method, path, noCsrf)).toBe('valid');
      const foreign = await w.send(method, path, { as: alice, origin: 'https://evil.example', body, key: 'k-auth' });
      expect([method, path, foreign.status, errorCode(foreign)]).toEqual([method, path, 403, 'csrf_failed']);
      const wrongToken = await w.send(method, path, {
        as: { ...alice, csrf: 'ab'.repeat(32) },
        body,
        key: 'k-auth',
      });
      expect([method, path, wrongToken.status, errorCode(wrongToken)]).toEqual([method, path, 403, 'csrf_failed']);
    }
    // A refused request queued nothing.
    expect(w.count('operations')).toBe(0);

    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ ...LISTEN, artist: '   ' }, 'artist'],
      [{ artist: 'Björk', listenedAt: LISTEN.listenedAt }, 'track'],
      [{ ...LISTEN, listenedAt: 'yesterday' }, 'listenedAt'],
      [{ ...LISTEN, listenedAt: '2026-01-15T12:06:00Z' }, 'listenedAt'],
      [{ ...LISTEN, album: '' }, 'album'],
      [{ ...LISTEN, durationSeconds: 0 }, 'durationSeconds'],
      [{ ...LISTEN, recordingMbid: 'not-a-uuid' }, 'recordingMbid'],
      [{ ...LISTEN, createdAt: '2026-01-15T12:00:00Z' }, 'createdAt'],
    ];
    for (const [i, [body, field]] of invalid.entries()) {
      const res = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: `k-invalid-${i}`, body });
      expect([field, res.status, errorCode(res), Object.keys(fieldsOf(res))]).toEqual([
        field,
        422,
        'validation_failed',
        [field],
      ]);
      expect(contract('POST', '/api/v1/scrobbles', res)).toBe('valid');
    }
    const notJson = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'k-json', raw: '{"artist":' });
    expect([notJson.status, errorCode(notJson)]).toEqual([400, 'invalid_json']);
    expect(w.count('operations')).toBe(0);
    expect(w.count('listen_keys')).toBe(0);

    // The fixture prefix never opens the gate: every write route is 503, nothing is queued.
    const closed = await world({ publication: false });
    const bob = closed.signIn(BOB, 'bob.test');
    for (const [method, path, body] of writes) {
      const res = await closed.send(method, path, { as: bob, body, key: 'k-closed' });
      expect([method, path, res.status, res.body]).toEqual([
        method,
        path,
        503,
        {
          error: {
            code: 'publication_disabled',
            message: 'Publication is disabled on this server.',
            requestId: (res.body as { error: { requestId: string } }).error.requestId,
          },
        },
      ]);
      expect(contract(method, path, res)).toBe('valid');
    }
    expect(closed.count('operations')).toBe(0);
    expect(closed.kit.pds.Bob.count()).toBe(0);
  });

  it('the same Idempotency-Key from two DIDs creates two operations', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');
    const a = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'shared-key', body: LISTEN });
    const b = await w.send('POST', '/api/v1/scrobbles', { as: bob, key: 'shared-key', body: LISTEN });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(contract('POST', '/api/v1/scrobbles', a)).toBe('valid');
    expect(contract('POST', '/api/v1/scrobbles', b)).toBe('valid');
    expect(opOf(a).id).not.toBe(opOf(b).id);
    expect(w.ops().map((r) => [r.id, r.did, r.idempotency_key])).toEqual([
      [opOf(a).id, ALICE, 'shared-key'],
      [opOf(b).id, BOB, 'shared-key'],
    ]);
    // Alice reusing the key for another listen conflicts with her own row only; Bob's own replay is his row.
    const aliceOther = await w.send('POST', '/api/v1/scrobbles', {
      as: alice,
      key: 'shared-key',
      body: { ...LISTEN, track: 'Unravel' },
    });
    expect([aliceOther.status, errorCode(aliceOther)]).toEqual([409, 'idempotency_conflict']);
    const bobAgain = await w.send('POST', '/api/v1/scrobbles', { as: bob, key: 'shared-key', body: LISTEN });
    expect([bobAgain.status, opOf(bobAgain).id]).toEqual([202, opOf(b).id]);
    expect(w.count('operations')).toBe(2);
    expect(w.count('listen_keys', 'did = ?', ALICE)).toBe(1);
    expect(w.count('listen_keys', 'did = ?', BOB)).toBe(1);
  });

  it('a listen already accepted under one Idempotency-Key and re-sent under another is 422 and leaves the second key unbound', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const L2 = { ...LISTEN, track: 'Hunter' };
    const post = (key: string, body: unknown) => w.send('POST', '/api/v1/scrobbles', { as: alice, key, body });

    // K1/L: the listen is accepted under K1.
    const first = await post('K1', LISTEN);
    expect(first.status).toBe(202);
    const opA = opOf(first).id;

    // K2/L, twice: the listen is already recorded under K1. Not K1's operation (K2 would stay
    // unstored), a stable 422 that writes nothing.
    for (let i = 0; i < 2; i++) {
      const dup = await post('K2', LISTEN);
      expect([dup.status, errorCode(dup), fieldsOf(dup)]).toEqual([
        422,
        'validation_failed',
        { listenedAt: 'This listen is already recorded.' },
      ]);
      expect(contract('POST', '/api/v1/scrobbles', dup)).toBe('valid');
    }
    expect(w.ops().map((r) => [r.id, r.idempotency_key])).toEqual([[opA, 'K1']]);
    expect(w.count('listen_keys', 'did = ?', ALICE)).toBe(1);
    expect(w.count('forward_outbox')).toBe(0);

    // K2/L2: K2 was never answered with an operation, so it binds now to L2.
    const second = await post('K2', L2);
    expect(second.status).toBe(202);
    expect(contract('POST', '/api/v1/scrobbles', second)).toBe('valid');
    const opB = opOf(second).id;
    expect(opB).not.toBe(opA);
    expect(w.ops().map((r) => [r.id, r.idempotency_key])).toEqual([
      [opA, 'K1'],
      [opB, 'K2'],
    ]);

    // From now on K2 means L2: K2/L is 409, a real retry K2/L2 is opB, K1/L is still opA.
    const reused = await post('K2', LISTEN);
    expect([reused.status, errorCode(reused)]).toEqual([409, 'idempotency_conflict']);
    expect(contract('POST', '/api/v1/scrobbles', reused)).toBe('valid');
    const retryB = await post('K2', L2);
    expect([retryB.status, opOf(retryB).id]).toEqual([202, opB]);
    const retryA = await post('K1', LISTEN);
    expect([retryA.status, opOf(retryA).id]).toEqual([202, opA]);

    // Two operations, two listen keys, and after the drain two records on the PDS.
    expect(w.count('operations')).toBe(2);
    expect(w.count('listen_keys', 'did = ?', ALICE)).toBe(2);
    await w.drain();
    expect(w.ops().map((r) => [r.id, r.state])).toEqual([
      [opA, 'succeeded'],
      [opB, 'succeeded'],
    ]);
    expect((await w.kit.repos.Alice.list(SCROBBLE)).map((r) => (r.value as { track: string }).track).sort()).toEqual([
      'Hunter',
      'Jóga',
    ]);
  });

  it('a listen over the daily listen cap is 429 rate_limited with Retry-After until the oldest live listen leaves the 24 h window, writes nothing and leaves the Idempotency-Key unbound', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    linkLastfm(w.app.db, ALICE);
    w.app.db.run('UPDATE accounts SET daily_listen_cap = 2 WHERE did = ?', ALICE);
    // An imported listen older than every live one: imports are not capped, so it is neither
    // counted nor the listen whose exit Retry-After waits for.
    w.app.db.run(
      `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, 'imported-key', NULL, 'import', ?)`,
      ALICE,
      T0 - 3_600_000,
    );
    const post = (key: string, body: unknown) => w.send('POST', '/api/v1/scrobbles', { as: alice, key, body });
    const L2 = { ...LISTEN, track: 'Hunter', listenedAt: '2026-01-15T12:30:00Z' };
    const L3 = { ...LISTEN, track: 'Unravel', listenedAt: '2026-01-15T13:00:00Z' };

    const first = await post('cap-1', LISTEN); // receipt T0
    w.kit.clock.advance(3_600_000);
    const second = await post('cap-2', L2); // receipt T0 + 1 h
    expect([first.status, second.status]).toEqual([202, 202]);
    w.kit.clock.advance(1_800_000); // T0 + 1.5 h: two live listens in the window, the cap is full.

    const before = { ops: w.ops().map((r) => r.id), keys: w.count('listen_keys'), forwards: w.count('forward_outbox') };
    expect(before).toEqual({ ops: [opOf(first).id, opOf(second).id], keys: 3, forwards: 2 });
    // The oldest live listen (receipt T0) leaves the window at T0 + 24 h: 22.5 h from now.
    const expectedRetryAfter = (T0 + 24 * 3_600_000 - w.kit.clock.nowMs()) / 1000;
    expect(expectedRetryAfter).toBe(81_000);

    for (let i = 0; i < 2; i++) {
      const over = await post('cap-3', L3);
      expect([over.status, errorCode(over), over.headers.get('retry-after')]).toEqual([
        429,
        'rate_limited',
        String(expectedRetryAfter),
      ]);
      expect(contract('POST', '/api/v1/scrobbles', over)).toBe('valid');
      expect(over.body).toMatchObject({ error: { message: 'The request rate limit was exceeded.' } });
    }
    // Nothing written: no operation (so cap-3 is bound to nothing), listen key or forward row.
    expect(w.ops().map((r) => r.id)).toEqual(before.ops);
    expect(w.count('operations', 'idempotency_key = ?', 'cap-3')).toBe(0);
    expect(w.count('listen_keys')).toBe(before.keys);
    expect(w.count('forward_outbox')).toBe(before.forwards);
    // cap-3 is unbound: another listen under it is refused by the cap, not 409 idempotency_conflict.
    const otherBody = await post('cap-3', { ...L3, track: 'Bachelorette' });
    expect([otherBody.status, errorCode(otherBody)]).toEqual([429, 'rate_limited']);

    // One millisecond before the window moves the cap still holds, with the shortest wait.
    w.kit.clock.advance(expectedRetryAfter * 1000 - 1);
    const almost = await post('cap-3', L3);
    expect([almost.status, almost.headers.get('retry-after')]).toEqual([429, '1']);

    // At the instant Retry-After named, the receipt-T0 listen has left the window: the same key and
    // body are accepted as a new operation bound to cap-3, with its listen key and forward row.
    w.kit.clock.advance(1);
    const admitted = await post('cap-3', L3);
    expect(admitted.status).toBe(202);
    expect(contract('POST', '/api/v1/scrobbles', admitted)).toBe('valid');
    expect(opOf(admitted)).toMatchObject({ kind: 'scrobble.create', origin: 'web', state: 'queued' });
    expect(w.ops().map((r) => [r.id, r.idempotency_key])).toEqual([
      [opOf(first).id, 'cap-1'],
      [opOf(second).id, 'cap-2'],
      [opOf(admitted).id, 'cap-3'],
    ]);
    expect(w.count('listen_keys', 'did = ? AND operation_id = ?', ALICE, opOf(admitted).id)).toBe(1);
    expect(w.count('forward_outbox')).toBe(before.forwards + 1);
    // Now the window is full again (receipts T0 + 1 h and T0 + 24 h).
    const full = await post('cap-4', { ...L3, track: 'Pagan Poetry' });
    expect([full.status, full.headers.get('retry-after')]).toEqual([429, String(3_600)]);
    expect(w.kit.pds.Alice.count()).toBe(0);
  });

  it('an Idempotency-Key of 129 characters or containing a character outside [A-Za-z0-9._~-] is 400 invalid_idempotency_key', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bad = ['a'.repeat(129), '', 'has space', 'semi;colon', 'slash/key', 'plus+key', 'é', 'tab\tkey', 'a,b'];
    for (const key of bad) {
      const res = await w.send('POST', '/api/v1/scrobbles', { as: alice, key, body: LISTEN });
      expect([JSON.stringify(key), res.status, errorCode(res)]).toEqual([
        JSON.stringify(key),
        400,
        'invalid_idempotency_key',
      ]);
      expect(contract('POST', '/api/v1/scrobbles', res)).toBe('valid');
      expect((res.body as { error: { message: string } }).error.message).toBe(
        'Idempotency-Key must be 1-128 characters from [A-Za-z0-9._~-].',
      );
    }
    // Zero operations, zero listen keys and zero PDS requests.
    expect(w.count('operations')).toBe(0);
    expect(w.count('listen_keys')).toBe(0);
    await w.drain();
    expect(w.kit.pds.Alice.count()).toBe(0);

    // The boundary: 128 characters of the whole alphabet are accepted.
    const edge = `${'Az09._~-'.repeat(16)}`;
    expect(edge).toHaveLength(128);
    const ok = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: edge, body: LISTEN });
    expect([ok.status, w.ops().map((r) => r.idempotency_key)]).toEqual([202, [edge]]);
  });

  it('five identical POSTs with one Idempotency-Key, two of them after the operation succeeded, return one operation and the fake PDS holds one record', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const post = () => w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'retry-key', body: LISTEN });

    const answers: Answer[] = [];
    for (let i = 0; i < 3; i++) answers.push(await post());
    expect(answers.map((a) => [a.status, opOf(a).state])).toEqual(Array(3).fill([202, 'queued']));
    const id = opOf(answers[0]!).id;

    await w.drain();
    const done = w.ops()[0]!;
    expect([done.id, done.state, done.attempts]).toEqual([id, 'succeeded', 1]);

    w.kit.clock.advance(60_000);
    for (let i = 0; i < 2; i++) answers.push(await post());
    for (const a of answers) expect(contract('POST', '/api/v1/scrobbles', a)).toBe('valid');
    expect(answers.map((a) => opOf(a).id)).toEqual(Array(5).fill(id));
    expect(answers.slice(3).map((a) => opOf(a))).toEqual(
      Array(2).fill(
        expect.objectContaining({ state: 'succeeded', attempts: 1, uri: `at://${ALICE}/${SCROBBLE}/${done.rkey}` }),
      ),
    );
    await w.drain();

    // One operation, one rkey, one listen key, one createRecord, one record on the PDS.
    expect(w.count('operations')).toBe(1);
    expect(w.count('listen_keys')).toBe(1);
    expect(w.kit.pds.Alice.count('com.atproto.repo.createRecord')).toBe(1);
    expect(w.kit.pds.Alice.count('com.atproto.repo.applyWrites')).toBe(0);
    const records = await w.kit.repos.Alice.list(SCROBBLE);
    expect(records.map((r) => r.rkey)).toEqual([done.rkey]);
    expect(records[0]!.value).toMatchObject({ $type: SCROBBLE, artist: 'Björk', track: 'Jóga', album: 'Homogenic' });
  });
});

describe('DELETE /api/v1/scrobbles/{id}', () => {
  it("DELETE /api/v1/scrobbles/{id} of another DID's record is 404 and of an own record is 202 scrobble.delete", async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');
    const mine = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'a', body: LISTEN });
    const theirs = await w.send('POST', '/api/v1/scrobbles', { as: bob, key: 'b', body: LISTEN });
    await w.drain();
    const aliceUri = `at://${ALICE}/${SCROBBLE}/${w.ops('id = ?', opOf(mine).id)[0]!.rkey}`;
    const bobUri = `at://${BOB}/${SCROBBLE}/${w.ops('id = ?', opOf(theirs).id)[0]!.rkey}`;
    expect(w.ops().map((r) => r.state)).toEqual(['succeeded', 'succeeded']);
    w.kit.resetCalls();

    const path = (uri: string) => `/api/v1/scrobbles/${encodeURIComponent(uri)}`;
    // Bob's record and another collection of Alice's are not found for Alice.
    for (const uri of [bobUri, `at://${ALICE}/${FOLLOW}/${aliceUri.split('/').pop()}`]) {
      const res = await w.send('DELETE', path(uri), { as: alice });
      expect([uri, res.status, errorCode(res)]).toEqual([uri, 404, 'not_found']);
      expect(contract('DELETE', path(uri), res)).toBe('valid');
    }
    const malformed = await w.send('DELETE', path('not-an-at-uri'), { as: alice });
    expect([malformed.status, errorCode(malformed), Object.keys(fieldsOf(malformed))]).toEqual([
      422,
      'validation_failed',
      ['id'],
    ]);
    expect(w.count('operations', "kind = 'scrobble.delete'")).toBe(0);
    await w.drain();
    expect(w.kit.pds.Bob.count('com.atproto.repo.deleteRecord')).toBe(0);
    expect((await w.kit.repos.Bob.list(SCROBBLE)).length).toBe(1);

    // An own scrobble URI the server has not indexed (no record_state row, no create of ours) is still
    // Alice's to delete: queued, and settled as succeeded when her PDS has nothing at the key.
    const unknownUri = `at://${ALICE}/${SCROBBLE}/3zzzzzzzzzzzz`;
    expect(w.count('record_state', 'uri = ?', unknownUri)).toBe(0);
    const unknown = await w.send('DELETE', path(unknownUri), { as: alice });
    expect(unknown.status).toBe(202);
    expect(contract('DELETE', path(unknownUri), unknown)).toBe('valid');
    expect(opOf(unknown)).toMatchObject({ kind: 'scrobble.delete', origin: 'web', state: 'queued', attempts: 0 });
    await w.drain();
    expect(w.ops('id = ?', opOf(unknown).id).map((r) => [r.state, r.rkey, r.last_error])).toEqual([
      ['succeeded', '3zzzzzzzzzzzz', null],
    ]);
    expect(w.kit.pds.Alice.count('com.atproto.repo.getRecord')).toBe(1);
    expect(w.kit.pds.Alice.count('com.atproto.repo.deleteRecord')).toBe(0);
    expect((await w.kit.repos.Alice.list(SCROBBLE)).length).toBe(1);
    w.kit.resetCalls();

    // Alice's own indexed record.
    const del = await w.send('DELETE', path(aliceUri), { as: alice });
    expect(del.status).toBe(202);
    expect(contract('DELETE', path(aliceUri), del)).toBe('valid');
    expect(opOf(del)).toMatchObject({ kind: 'scrobble.delete', origin: 'web', state: 'queued', attempts: 0 });
    expect(w.ops("kind = 'scrobble.delete'").map((r) => [r.did, r.collection, r.rkey])).toEqual([
      [ALICE, SCROBBLE, '3zzzzzzzzzzzz'],
      [ALICE, SCROBBLE, aliceUri.split('/').pop()],
    ]);
    await w.drain();
    expect(w.ops('id = ?', opOf(del).id)[0]!.state).toBe('succeeded');
    expect(w.kit.pds.Alice.count('com.atproto.repo.deleteRecord')).toBe(1);
    expect(await w.kit.repos.Alice.list(SCROBBLE)).toEqual([]);
    expect((await w.kit.repos.Bob.list(SCROBBLE)).length).toBe(1);
  });
});

describe('follows, loves and indexing', () => {
  it('PUT/DELETE follows, PUT/DELETE loves and PUT account/indexing each return 202 with the matching operation kind', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const cases: Array<[string, string, unknown, string]> = [
      ['PUT', `/api/v1/follows/${BOB}`, undefined, 'follow.put'],
      ['PUT', '/api/v1/loves', { artist: 'Björk', track: 'Jóga', album: 'Homogenic' }, 'love.put'],
      ['PUT', '/api/v1/account/indexing', { indexing: 'disabled' }, 'settings.put'],
    ];
    const ids: string[] = [];
    for (const [method, path, body, kind] of cases) {
      const res = await w.send(method, path, { as: alice, body });
      expect([method, path, res.status, opOf(res).kind, opOf(res).origin]).toEqual([method, path, 202, kind, 'web']);
      expect(contract(method, path, res)).toBe('valid');
      ids.push(opOf(res).id);
    }
    await w.drain();
    expect(w.ops().map((r) => [r.id, r.kind, r.state])).toEqual([
      [ids[0], 'follow.put', 'succeeded'],
      [ids[1], 'love.put', 'succeeded'],
      [ids[2], 'settings.put', 'succeeded'],
    ]);
    const rkey = await followRkey(BOB);
    expect(
      (await w.kit.repos.Alice.list(FOLLOW)).map((r) => [r.rkey, (r.value as { subject: string }).subject]),
    ).toEqual([[rkey, BOB]]);
    expect((await w.kit.repos.Alice.list(LOVE)).map((r) => (r.value as { track: string }).track)).toEqual(['Jóga']);
    expect(
      (await w.kit.repos.Alice.list(SETTINGS)).map((r) => [r.rkey, (r.value as { indexing: string }).indexing]),
    ).toEqual([['self', 'disabled']]);

    const removals: Array<[string, string, string]> = [
      ['DELETE', `/api/v1/follows/${BOB}`, 'follow.delete'],
      ['DELETE', '/api/v1/loves?artist=Bj%C3%B6rk&track=J%C3%B3ga', 'love.delete'],
    ];
    for (const [method, path, kind] of removals) {
      const res = await w.send(method, path, { as: alice });
      expect([method, path, res.status, opOf(res).kind]).toEqual([method, path, 202, kind]);
      expect(contract(method, path, res)).toBe('valid');
    }
    await w.drain();
    expect(w.ops("kind IN ('follow.delete','love.delete')").map((r) => [r.kind, r.state])).toEqual([
      ['follow.delete', 'succeeded'],
      ['love.delete', 'succeeded'],
    ]);
    expect(await w.kit.repos.Alice.list(FOLLOW)).toEqual([]);
    expect(await w.kit.repos.Alice.list(LOVE)).toEqual([]);

    // Invalid inputs are 422 naming the field and queue nothing.
    const before = w.count('operations');
    const refusals: Array<[string, string, unknown, string]> = [
      ['PUT', `/api/v1/follows/${ALICE}`, undefined, 'did'],
      ['PUT', '/api/v1/follows/not-a-did', undefined, 'did'],
      ['PUT', '/api/v1/loves', { artist: 'Björk' }, 'track'],
      ['PUT', '/api/v1/loves', { artist: 'Björk', track: 'Jóga', mood: 'x' }, 'mood'],
      ['DELETE', '/api/v1/loves?artist=Bj%C3%B6rk', undefined, 'track'],
      ['PUT', '/api/v1/account/indexing', { indexing: 'off' }, 'indexing'],
      ['PUT', '/api/v1/account/indexing', { indexing: 'enabled', extra: 1 }, 'extra'],
    ];
    for (const [method, path, body, field] of refusals) {
      const res = await w.send(method, path, { as: alice, body });
      expect([method, path, res.status, errorCode(res), Object.keys(fieldsOf(res))]).toEqual([
        method,
        path,
        422,
        'validation_failed',
        [field],
      ]);
      expect(contract(method, path, res)).toBe('valid');
    }
    expect(w.count('operations')).toBe(before);
  });
});

describe('GET /api/v1/operations/{id}', () => {
  it('GET /api/v1/operations/{id} is 200 for its owner and 404 for any other session', async () => {
    const w = await world();
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');
    const posted = await w.send('POST', '/api/v1/scrobbles', { as: alice, key: 'op-read', body: LISTEN });
    const id = opOf(posted).id;
    const path = `/api/v1/operations/${id}`;

    const own = await w.send('GET', path, { as: alice, csrf: false });
    expect(own.status).toBe(200);
    expect(contract('GET', path, own)).toBe('valid');
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(own.body).toEqual({
      id,
      kind: 'scrobble.create',
      origin: 'web',
      state: 'queued',
      attempts: 0,
      createdAt: '2026-01-15T12:00:00.000000000Z',
      updatedAt: '2026-01-15T12:00:00.000000000Z',
    });

    // Bob's session, with or without CSRF headers, cannot see it; nor an unknown or malformed id.
    for (const [who, target] of [
      [bob, path],
      [{ ...bob, csrf: bob.csrf }, path],
      [alice, '/api/v1/operations/00000000-0000-4000-8000-000000000000'],
      [alice, '/api/v1/operations/bad%20id'],
    ] as const) {
      const res = await w.send('GET', target, { as: who });
      expect([target, res.status, errorCode(res)]).toEqual([target, 404, 'not_found']);
      expect(contract('GET', target, res)).toBe('valid');
    }
    // Bob's own operation is his, and Alice gets 404 for it.
    const bobs = await w.send('PUT', `/api/v1/follows/${CAROL}`, { as: bob });
    const bobPath = `/api/v1/operations/${opOf(bobs).id}`;
    expect((await w.send('GET', bobPath, { as: bob, csrf: false })).status).toBe(200);
    expect((await w.send('GET', bobPath, { as: alice, csrf: false })).status).toBe(404);

    // No cookie, or an unknown cookie, is 401.
    const anonymous = await w.send('GET', path);
    expect([anonymous.status, errorCode(anonymous)]).toEqual([401, 'unauthenticated']);
    expect(contract('GET', path, anonymous)).toBe('valid');
    const forged = await w.send('GET', path, { headers: { cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}` } });
    expect([forged.status, errorCode(forged)]).toEqual([401, 'unauthenticated']);

    // After the outbox ran, the owner sees the published uri and cid.
    await w.drain();
    const later = await w.send('GET', path, { as: alice, csrf: false });
    expect(contract('GET', path, later)).toBe('valid');
    const row = w.ops('id = ?', id)[0]!;
    expect(later.body).toMatchObject({ state: 'succeeded', attempts: 1, uri: row.result_uri, cid: row.result_cid });
  });
});

// ---------------------------------------------------------------------------
// Public reads

async function seedIndexed(db: Db): Promise<void> {
  const prefix = 'com.example.atmusic';
  const nowNs = fromMs(T0);
  const opts = { receiptNs: nowNs, prefix, nowNs };
  const keys = await fixtureKeys();
  const repos: Record<string, SignedRepo> = {
    [ALICE]: new SignedRepo(ALICE, keys.alice, { clock: fixedClock() }),
    [BOB]: new SignedRepo(BOB, keys.bob, { clock: fixedClock() }),
  };
  for (const [did, handle] of [
    [ALICE, 'alice.test'],
    [BOB, 'bob.test'],
  ] as const) {
    const gen = db.one<{ g: number }>(
      'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
    )!.g;
    db.run(
      `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
       VALUES (?, ?, ?, 1, 'active', 'current', ?)`,
      did,
      handle,
      toStorage(nowNs),
      gen,
    );
  }
  const apply = async (repo: SignedRepo, collection: string, rkey: string) => {
    const car = await repo.getRecordCar(collection, rkey);
    const proof = await verifyRecordProof(car, { did: repo.did, collection, rkey, signingKey: repo.key.didKey });
    expect(db.tx(() => applyRecordProof(db, proof, opts)).outcome).toBe('applied');
  };
  for (const s of fixture.scrobbles) {
    const repo = repos[s.owner];
    if (repo === undefined || s.state !== 'confirmed') continue;
    await repo.put(`${prefix}.scrobble`, s.rkey, { ...s.record });
    await apply(repo, `${prefix}.scrobble`, s.rkey);
  }
  const follow = `${prefix}.follow`;
  const rkey = await followRkey(BOB);
  await repos[ALICE]!.put(follow, rkey, { $type: follow, subject: BOB, createdAt: '2025-01-01T00:00:00Z' });
  await apply(repos[ALICE]!, follow, rkey);
}

describe('public reads', () => {
  it("public v1.1 read responses are byte-identical with and without the owner's session cookie", async () => {
    const w = await world({ publication: false });
    await seedIndexed(w.app.db);
    const alice = w.signIn(ALICE, 'alice.test');
    const bob = w.signIn(BOB, 'bob.test');
    const r01 = `at://${ALICE}/com.example.atmusic.scrobble/r01`;
    const reads = [
      `/api/v1/users/${ALICE}/profile`,
      `/api/v1/users/${ALICE}/scrobbles?limit=3`,
      `/api/v1/users/${ALICE}/stats?window=all`,
      `/api/v1/users/${ALICE}/following`,
      `/api/v1/users/${BOB}/followers`,
      `/api/v1/scrobbles/${encodeURIComponent(r01)}`,
      '/api/v1/feed?limit=5',
      '/api/v1/meta',
    ];
    for (const path of reads) {
      const anonymous = await w.send('GET', path);
      expect([path, anonymous.status]).toEqual([path, 200]);
      expect(contract('GET', path, anonymous)).toBe('valid');
      const variants = [
        await w.send('GET', path, { as: alice, csrf: false }),
        await w.send('GET', path, { as: alice }),
        await w.send('GET', path, { as: bob, csrf: false }),
      ];
      for (const v of variants) {
        expect([path, v.status, v.text]).toEqual([path, anonymous.status, anonymous.text]);
        const headersOf = (a: Answer) =>
          [...a.headers.entries()].filter(([name]) => name !== 'x-request-id' && name !== 'date');
        expect(headersOf(v)).toEqual(headersOf(anonymous));
        expect(v.headers.get('set-cookie')).toBeNull();
      }
    }
    // The pages carry the owner's data, so equality is not between empty answers.
    const page = (await w.send('GET', `/api/v1/users/${ALICE}/scrobbles?limit=3`)).body as { items: unknown[] };
    expect(page.items).toHaveLength(3);
    const following = (await w.send('GET', `/api/v1/users/${ALICE}/following`)).body as { items: unknown[] };
    expect(following.items).toHaveLength(1);
    // No read wrote to the session table either (no renewal, no new row).
    expect(w.count('web_sessions')).toBe(2);
  });
});
