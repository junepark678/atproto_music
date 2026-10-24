// W4-04: POST /api/v1/notify through the real route handler and the real DO
// module (worker/src/do/ingest/notify.ts) over real DO SQLite (harness DO
// with the production migrations). Proves M6.2.1/body_boundary,
// M6.2.1/rate_boundary and the notify half of M1.3.4/queue_full: every
// response is checked for status, headers and its OpenAPI schema, and every
// refusal for an unchanged database (all tables) and no wasted IndexDO call.
// The clock is the frozen 2026-01-15T12:00:00Z and is only advanced by hand.
// Expectations are hardcoded.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { parseCursorKey } from '../../src/config';
import type { ModuleDeps } from '../../src/do/contracts';
import { type Db, doDb } from '../../src/do/db';
import { admissionWindow, MAX_PENDING_SNAPSHOT_JOBS } from '../../src/do/ingest/admission';
import { enqueueHints, takeDue } from '../../src/do/ingest/hints';
import { NotifyLimits, notify } from '../../src/do/ingest/notify';
import { applyRecordProof } from '../../src/do/write/apply-record';
import type { Env } from '../../src/env';
import { NOTIFY_MAX_BODY_BYTES, routes as notifyRoutes } from '../../src/http/notify';
import type { RequestCtx } from '../../src/http/types';
import type { HarnessDO } from '../harness/harness-do';
import { type LocalIndex, makeLocalIndex } from '../harness/local-index';
import { ALICE, BOB, CAROL, OPTS, putProof, repoFor, SETTINGS, settings } from '../write/support';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addFormat('at-did', /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/);
  ajv.addFormat('at-record-uri', /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/[A-Za-z0-9.-]+\/[A-Za-z0-9._:~-]+$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const schemas = {
  NotifyAccepted: openapiValidator('NotifyAccepted'),
  NotifyInput: openapiValidator('NotifyInput'),
  Error: openapiValidator('Error'),
};

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated with AJV against api/openapi.yaml, then compared with toEqual.
type JsonBody = any;

const REQUEST_ID = '0b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
const ORIGIN = 'https://music.example.test';
const URL_NOTIFY = `${ORIGIN}/api/v1/notify`;
const SCROBBLE = 'com.example.atmusic.scrobble';
const FOLLOW = 'com.example.atmusic.follow';
const T0 = Date.parse('2026-01-15T12:00:00Z');
const T0_STORAGE = '2026-01-15T12:00:00.000000000Z';
const IP_A = '203.0.113.7';
const IP_B = '198.51.100.23';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A distinct, valid did:plc for every n. */
function did(n: number): string {
  let out = '';
  for (let v = n; out.length < 24; v = Math.floor(v / 32)) out = B32[v % 32] + out;
  return `did:plc:${out}`;
}
const DAVE = 'did:plc:dddddddddddddddddddddddd';
const uriOf = (d: string, collection: string, rkey: string) => `at://${d}/${collection}/${rkey}`;

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await deriveCursorKey(parseCursorKey(env));
});

const notifyRoute = (() => {
  const found = notifyRoutes.find((r) => r.method === 'POST' && r.pattern === '/api/v1/notify');
  if (found === undefined) throw new Error('no notify route');
  return found;
})();

interface Harness {
  stub: DurableObjectStub<HarnessDO>;
  clock: ReturnType<typeof fixedClock>;
  index: LocalIndex;
  limits: NotifyLimits;
  inDo<T>(fn: (db: Db, m: ModuleDeps) => T): Promise<T>;
  post(body: BodyInit | null, o?: { ip?: string; headers?: HeadersInit }): Promise<Reply>;
  postJson(value: unknown, ip?: string): Promise<Reply>;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  body: JsonBody;
}

/**
 * The route handler over a local IndexRpc whose `notify` is the real DO module
 * with the request time from the frozen clock. The buckets are one
 * NotifyLimits for the whole test, as the IndexDO instance keeps one.
 */
function harness(name: string): Harness {
  const stub = env.HARNESS.get(env.HARNESS.idFromName(name));
  const clock = fixedClock();
  const limits = new NotifyLimits(clock.nowMs());
  const index = makeLocalIndex(
    { stub, clock },
    { notify: (m, input, ip) => notify(m, input, ip, clock.nowMs(), limits) },
  );
  const inDo = <T>(fn: (db: Db, m: ModuleDeps) => T): Promise<T> =>
    runInDurableObject(stub, (_i: HarnessDO, s: DurableObjectState) => {
      const db = doDb(s.storage);
      return fn(db, { ...index.deps, db });
    });
  const post = async (body: BodyInit | null, o: { ip?: string; headers?: HeadersInit } = {}): Promise<Reply> => {
    const ctx: RequestCtx = {
      env: env as unknown as Env,
      index,
      requestId: REQUEST_ID,
      clock,
      cursorKey,
      clientIp: o.ip ?? IP_A,
    };
    const headers = new Headers(o.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    const res = await notifyRoute.handler(new Request(URL_NOTIFY, { method: 'POST', body, headers }), ctx, {});
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text === '' ? null : JSON.parse(text) };
  };
  return { stub, clock, index, limits, inDo, post, postJson: (value, ip) => post(JSON.stringify(value), { ip }) };
}

/** Every table of the schema in a stable order: "no DB change" means all of them are unchanged. */
function everything(db: Db): Record<string, unknown[]> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));
}

function hintRows(db: Db) {
  return db.all(
    'SELECT uri, did, collection, rkey, source, priority, receipt_time, due_at, attempts FROM hints ORDER BY uri',
  );
}

function expectQueued(r: Reply): void {
  expect(r.status).toBe(202);
  expect(r.headers.get('content-type')).toBe('application/json');
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(schemas.NotifyAccepted(r.body)).toBe('valid');
  expect(r.body).toEqual({ state: 'queued' });
}

function expectError(r: Reply, status: number, code: string, fields?: Record<string, string>): void {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(schemas.Error(r.body)).toBe('valid');
  expect(r.body.error.code).toBe(code);
  expect(r.body.error.requestId).toBe(REQUEST_ID);
  if (fields === undefined) expect(r.body.error.fields).toBeUndefined();
  else expect(r.body.error.fields).toEqual(fields);
}

/** A known, active account row (what admission plus a completed snapshot leave behind). */
function seedKnown(db: Db, d: string, lastSnapshotMs: number | null): void {
  const gen = db.one<{ g: number }>(
    'UPDATE backfill_generation SET last_generation = last_generation + 1 WHERE singleton = 1 RETURNING last_generation AS g',
  )?.g;
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation, last_snapshot_at_ms)
     VALUES (?, ?, 1, 'active', 'current', ?, ?)`,
    d,
    T0_STORAGE,
    gen ?? 1,
    lastSnapshotMs,
  );
}

describe('notify', () => {
  it('valid uri → 202 queued and one hint row; repeat coalesces', async () => {
    const h = harness('notify-uri');
    const r01 = uriOf(ALICE, SCROBBLE, 'r01');
    const f01 = uriOf(BOB, FOLLOW, '3lfollowbbbb2');
    expect(schemas.NotifyInput({ uri: r01 })).toBe('valid');

    // A jetstream hint already queued for f01, due later: notify takes it over.
    await h.inDo((db) =>
      enqueueHints(db, [
        { did: BOB, collection: FOLLOW, rkey: '3lfollowbbbb2', source: 'jetstream', receiptMs: T0, dueAt: T0 + 30_000 },
      ]),
    );

    expectQueued(await h.postJson({ uri: r01 }));
    expect(await h.inDo(hintRows)).toEqual([
      {
        uri: r01,
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'r01',
        source: 'notify',
        priority: 0,
        receipt_time: T0_STORAGE,
        due_at: T0,
        attempts: 0,
      },
      {
        uri: f01,
        did: BOB,
        collection: FOLLOW,
        rkey: '3lfollowbbbb2',
        source: 'jetstream',
        priority: 1,
        receipt_time: T0_STORAGE,
        due_at: T0 + 30_000,
        attempts: 0,
      },
    ]);
    // The hint is durable with its drain timer; nothing is admitted or projected by a hint.
    expect(await h.inDo((db) => db.all('SELECT name, due_at FROM timers ORDER BY name'))).toEqual([
      { name: 'drain', due_at: T0 },
    ]);
    expect(await h.inDo((db) => db.all('SELECT did FROM users'))).toEqual([]);
    expect(await h.inDo((db) => db.all('SELECT did FROM repo_jobs'))).toEqual([]);

    // Repeat 5 s later, and notify the jetstream-hinted URI: still one row per URI.
    h.clock.advance(5_000);
    expectQueued(await h.postJson({ uri: r01 }));
    expectQueued(await h.postJson({ uri: f01 }));
    const later = '2026-01-15T12:00:05.000000000Z';
    expect(await h.inDo(hintRows)).toEqual([
      expect.objectContaining({ uri: r01, source: 'notify', priority: 0, receipt_time: later, due_at: T0 }),
      expect.objectContaining({ uri: f01, source: 'notify', priority: 0, receipt_time: later, due_at: T0 + 5_000 }),
    ]);
    expect(await h.inDo((db) => db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n)).toBe(2);
    // Top priority: the drain takes notify hints first.
    expect((await h.inDo((db) => takeDue(db, T0 + 5_000, 10))).map((r) => r.uri)).toEqual([r01, f01]);
    expect(h.index.calls.map((c) => c.method)).toEqual(['notify', 'notify', 'notify']);
    expect(h.index.calls[0]?.args).toEqual([{ uri: r01 }, IP_A]);
    expect(h.index.networkAttempts).toEqual([]);
  });

  it('suppressed DID: settings hint accepted, other hints ignored with 202', async () => {
    const h = harness('notify-suppressed');
    const repo = await repoFor('carol');
    const optOut = await putProof(repo, SETTINGS, 'self', settings('disabled'));
    await h.inDo((db) => db.tx(() => applyRecordProof(db, optOut, OPTS)));
    expect(await h.inDo((db) => db.all('SELECT did FROM suppression'))).toEqual([{ did: CAROL }]);
    const before = await h.inDo(everything);

    expectQueued(await h.postJson({ uri: uriOf(CAROL, SCROBBLE, 'r10') }));
    expectQueued(await h.postJson({ did: CAROL }));
    expect(await h.inDo(everything)).toEqual(before);

    const settingsUri = uriOf(CAROL, SETTINGS, 'self');
    expectQueued(await h.postJson({ uri: settingsUri }));
    expect((await h.inDo(hintRows)).map((r: JsonBody) => [r.uri, r.source])).toEqual([[settingsUri, 'notify']]);
  });

  it('foreign collection or bad URI → 422; oversize → 413; unknown field → 422', async () => {
    const h = harness('notify-invalid');
    const before = await h.inDo(everything);
    const body422 = { body: 'Expected one string uri or did field and no unknown fields.' };
    const uri422 = { uri: 'Expected a record AT URI in a configured collection.' };
    const did422 = { did: 'Expected a did:plc or did:web DID.' };
    const cases: Array<[string, unknown, Record<string, string>]> = [
      ['foreign collection', { uri: uriOf(ALICE, 'app.bsky.feed.post', '3l2a') }, uri422],
      ['other prefix', { uri: uriOf(ALICE, 'com.example.other.scrobble', 'r01') }, uri422],
      ['collection only', { uri: `at://${ALICE}/${SCROBBLE}` }, uri422],
      ['handle authority', { uri: `at://alice.example.com/${SCROBBLE}/r01` }, uri422],
      ['unsupported DID method', { uri: uriOf('did:example:alice', SCROBBLE, 'r01') }, uri422],
      ['not a URI', { uri: 'https://example.com/r01' }, uri422],
      ['query in URI', { uri: `${uriOf(ALICE, SCROBBLE, 'r01')}?x=1` }, uri422],
      ['non-string uri', { uri: 7 }, uri422],
      ['handle as did', { did: 'alice.example.com' }, did422],
      ['unsupported did', { did: 'did:example:alice' }, did422],
      ['empty did', { did: '' }, did422],
      ['unknown field', { uri: uriOf(ALICE, SCROBBLE, 'r01'), extra: true }, body422],
      ['unknown field only', { handle: 'alice.example.com' }, body422],
      ['both uri and did', { uri: uriOf(ALICE, SCROBBLE, 'r01'), did: ALICE }, body422],
      ['empty object', {}, body422],
      ['array', [{ uri: uriOf(ALICE, SCROBBLE, 'r01') }], body422],
      ['string', 'at://x', body422],
      ['null', null, body422],
    ];
    for (const [label, value, fields] of cases) {
      const r = await h.postJson(value);
      expect([label, r.status]).toEqual([label, 422]);
      expectError(r, 422, 'validation_failed', fields);
      // Nothing of the request is echoed back.
      expect(r.text).not.toContain(JSON.stringify(value));
      expect(r.text).not.toContain('extra');
    }

    // Malformed JSON is 400 invalid_json.
    for (const raw of ['{"uri":', '', '﻿{"did":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"}', "{'did':'x'}"]) {
      expectError(await h.post(raw), 400, 'invalid_json');
    }
    // Oversize: declared and streamed.
    const big = JSON.stringify({ uri: uriOf(ALICE, SCROBBLE, 'r'.repeat(3_000)) });
    expectError(await h.post(big), 413, 'payload_too_large');

    expect(h.index.calls).toEqual([]);
    expect(await h.inDo(everything)).toEqual(before);

    // The worker is still healthy: one valid request after the failures.
    expectQueued(await h.postJson({ uri: uriOf(ALICE, SCROBBLE, 'r01') }));
    expect((await h.inDo(hintRows)).length).toBe(1);
  });

  it('61st request per IP per minute → 429 and no DB change', async () => {
    const h = harness('notify-rate');
    for (let n = 0; n < 60; n++) {
      expectQueued(await h.postJson({ uri: uriOf(did(n), SCROBBLE, `r${n}`) }));
    }
    expect(await h.inDo((db) => db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n)).toBe(60);
    const before = await h.inDo(everything);

    const limited = await h.postJson({ uri: uriOf(did(60), SCROBBLE, 'r60') });
    expectError(limited, 429, 'rate_limited');
    // 60/min refills one token per second.
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await h.inDo(everything)).toEqual(before);
    // A {did} notify from the same IP is limited before admission writes anything.
    expectError(await h.postJson({ did: did(61) }), 429, 'rate_limited');
    expect(await h.inDo(everything)).toEqual(before);

    // Another IP is unaffected.
    expectQueued(await h.postJson({ uri: uriOf(did(62), SCROBBLE, 'r62') }, IP_B));
    // 999 ms later still limited; at 1,000 ms exactly one more request fits.
    h.clock.advance(999);
    expectError(await h.postJson({ uri: uriOf(did(63), SCROBBLE, 'r63') }), 429, 'rate_limited');
    h.clock.advance(1);
    expectQueued(await h.postJson({ uri: uriOf(did(64), SCROBBLE, 'r64') }));
    expectError(await h.postJson({ uri: uriOf(did(65), SCROBBLE, 'r65') }), 429, 'rate_limited');
    expect((await h.inDo(hintRows)).length).toBe(62);
    expect(h.index.calls.length).toBe(66);
  });

  it('600 requests per DID per hour → 429 for the DID from any IP', async () => {
    const h = harness('notify-did-rate');
    const r01 = uriOf(ALICE, SCROBBLE, 'r01');
    // 600 notifies for one DID spread over 10 IPs (60 each, within the IP limit).
    for (let n = 0; n < 600; n++) {
      const ip = `192.0.2.${n % 10}`;
      expectQueued(await h.postJson(n % 2 === 0 ? { uri: r01 } : { uri: uriOf(ALICE, SCROBBLE, `x${n}`) }, ip));
    }
    const before = await h.inDo(everything);
    const limited = await h.postJson({ uri: r01 }, '192.0.2.200');
    expectError(limited, 429, 'rate_limited');
    // 600/h refills one token every 6 s.
    expect(limited.headers.get('retry-after')).toBe('6');
    expectError(await h.postJson({ did: ALICE }, '192.0.2.201'), 429, 'rate_limited');
    expect(await h.inDo(everything)).toEqual(before);
    // Other DIDs are unaffected.
    expectQueued(await h.postJson({ uri: uriOf(BOB, SCROBBLE, 'r01') }, '192.0.2.202'));
    expect(h.limits.sizes).toEqual({ ip: 13, did: 2 });
  });

  it('did notify for unknown DID admits snapshot; busy → 503 queue_full', async () => {
    const h = harness('notify-did');
    expect(schemas.NotifyInput({ did: CAROL })).toBe('valid');
    expectQueued(await h.postJson({ did: CAROL }));
    expect(await h.inDo((db) => db.all('SELECT did, active, account_status, indexing_state FROM users'))).toEqual([
      { did: CAROL, active: 0, account_status: 'unknown', indexing_state: 'recovering' },
    ]);
    expect(
      await h.inDo((db) => db.all('SELECT did, kind, state, reason, due_at FROM repo_jobs ORDER BY did, kind')),
    ).toEqual([{ did: CAROL, kind: 'snapshot', state: 'pending', reason: 'admission', due_at: T0 }]);
    expect(await h.inDo((db) => db.all('SELECT name, label, value FROM counters'))).toEqual([
      { name: 'admitted', label: 'notify', value: 1 },
    ]);
    expect(await h.inDo((db) => db.all('SELECT * FROM admission'))).toEqual([
      { window_start_ms: admissionWindow(T0), admitted: 1 },
    ]);
    // A repeat while the snapshot is open changes nothing.
    const admitted = await h.inDo(everything);
    expectQueued(await h.postJson({ did: CAROL }));
    expect(await h.inDo(everything)).toEqual(admitted);

    // Hourly budget exhausted (50 admitted this window): 503 and nothing written.
    await h.inDo((db) => db.run('UPDATE admission SET admitted = 50'));
    const full = await h.inDo(everything);
    const busy = await h.postJson({ did: DAVE });
    expectError(busy, 503, 'queue_full');
    expect(busy.body.error.message).toBe('New-DID admission is exhausted; retry later.');
    // A record of a new DID is refused too, so the hint queue cannot outgrow admission.
    expectError(await h.postJson({ uri: uriOf(DAVE, SCROBBLE, 'r01') }), 503, 'queue_full');
    expect(await h.inDo(everything)).toEqual(full);
    // The opt-out record of an unknown DID is still accepted (it needs no admission).
    expectQueued(await h.postJson({ uri: uriOf(DAVE, SETTINGS, 'self') }));
    expect((await h.inDo(hintRows)).map((r: JsonBody) => r.uri)).toEqual([uriOf(DAVE, SETTINGS, 'self')]);
    // A known DID's record still queues.
    expectQueued(await h.postJson({ uri: uriOf(CAROL, SCROBBLE, 'r10') }));

    // The next window admits again.
    h.clock.advance(HOUR);
    expectQueued(await h.postJson({ did: DAVE }));
    expect(await h.inDo((db) => db.one('SELECT active, indexing_state FROM users WHERE did = ?', DAVE))).toEqual({
      active: 0,
      indexing_state: 'recovering',
    });

    // 1,024 pending snapshot jobs: busy again, nothing written.
    await h.inDo((db) => {
      for (let n = 0; n < MAX_PENDING_SNAPSHOT_JOBS; n++) {
        db.run(
          `INSERT INTO repo_jobs(did, kind, state, generation, reason, due_at, updated_at_ms)
           VALUES (?, 'snapshot', 'pending', 1, 'seed', ?, ?)`,
          did(1000 + n),
          T0,
          T0,
        );
      }
    });
    const capped = await h.inDo(everything);
    expectError(await h.postJson({ did: did(5) }), 503, 'queue_full');
    expect(await h.inDo(everything)).toEqual(capped);
    expect(h.index.networkAttempts).toEqual([]);
  });

  it('did notify for a known DID schedules at most one refresh snapshot per 24 h', async () => {
    const h = harness('notify-did-known');
    await h.inDo((db) => {
      seedKnown(db, ALICE, T0 - DAY); // snapshot completed exactly 24 h ago
      seedKnown(db, BOB, T0 - DAY - 1); // more than 24 h ago
    });
    const fresh = await h.inDo(everything);
    expectQueued(await h.postJson({ did: ALICE }));
    expect(await h.inDo(everything)).toEqual(fresh);

    expectQueued(await h.postJson({ did: BOB }));
    expect(await h.inDo((db) => db.all('SELECT did, kind, state, reason, due_at FROM repo_jobs'))).toEqual([
      { did: BOB, kind: 'snapshot', state: 'pending', reason: 'notify', due_at: T0 },
    ]);
    expect(await h.inDo((db) => db.all('SELECT name, label, value FROM counters'))).toEqual([
      { name: 'snapshot_scheduled', label: 'notify', value: 1 },
    ]);
    // While it is open, and after it completes without moving last_snapshot_at_ms
    // (e.g. a stale head), more notifies within 24 h schedule nothing.
    const scheduled = await h.inDo(everything);
    expectQueued(await h.postJson({ did: BOB }));
    expect(await h.inDo(everything)).toEqual(scheduled);
    await h.inDo((db) => db.run(`UPDATE repo_jobs SET state = 'complete' WHERE did = ?`, BOB));
    h.clock.advance(DAY);
    const completed = await h.inDo(everything);
    expectQueued(await h.postJson({ did: BOB }));
    expect(await h.inDo(everything)).toEqual(completed);
    // More than 24 h after the job was last touched, one more refresh.
    h.clock.advance(1);
    expectQueued(await h.postJson({ did: BOB }));
    expect(await h.inDo((db) => db.one('SELECT state, reason, due_at FROM repo_jobs WHERE did = ?', BOB))).toEqual({
      state: 'pending',
      reason: 'notify',
      due_at: T0 + DAY + 1,
    });
  });

  it('2,048-byte body reaches the parser and 2,049-byte body → 413 with no DB change', async () => {
    expect(NOTIFY_MAX_BODY_BYTES).toBe(2048);
    const h = harness('notify-body');
    const json = JSON.stringify({ uri: uriOf(ALICE, SCROBBLE, 'r01') });
    // Insignificant whitespace pads a valid body to an exact byte length.
    const padded = (n: number) => `${json.slice(0, -1)}${' '.repeat(n - json.length)}}`;
    const enc = new TextEncoder();
    expect(enc.encode(padded(2048)).byteLength).toBe(2048);
    expect(enc.encode(padded(2049)).byteLength).toBe(2049);
    /** A body with no Content-Length, delivered in 512-byte chunks. */
    const stream = (text: string) => {
      const bytes = enc.encode(text);
      return new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 512) c.enqueue(bytes.slice(i, i + 512));
          c.close();
        },
      });
    };

    const before = await h.inDo(everything);
    // 2,049 bytes: declared, then streamed without a Content-Length.
    expectError(await h.post(padded(2049)), 413, 'payload_too_large');
    expectError(await h.post(stream(padded(2049))), 413, 'payload_too_large');
    expect(h.index.calls).toEqual([]);
    expect(await h.inDo(everything)).toEqual(before);

    // 2,048 bytes reach the JSON parser: invalid JSON there is 400, not 413 ...
    const broken = `{${' '.repeat(2046)}x`;
    expect(enc.encode(broken).byteLength).toBe(2048);
    expectError(await h.post(broken), 400, 'invalid_json');
    // ... an unknown field is 422 ...
    const unknown = `{"x":1${' '.repeat(2048 - 7)}}`;
    expect(enc.encode(unknown).byteLength).toBe(2048);
    expectError(await h.post(stream(unknown)), 422, 'validation_failed', {
      body: 'Expected one string uri or did field and no unknown fields.',
    });
    expect(await h.inDo(everything)).toEqual(before);
    // ... and a valid one is queued, declared and streamed.
    expectQueued(await h.post(padded(2048)));
    expectQueued(await h.post(stream(padded(2048))));
    expect((await h.inDo(hintRows)).map((r: JsonBody) => r.uri)).toEqual([uriOf(ALICE, SCROBBLE, 'r01')]);
    expect(h.index.calls.length).toBe(2);
  });
});
