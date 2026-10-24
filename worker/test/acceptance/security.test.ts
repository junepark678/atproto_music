// W6-01 security acceptance (ADR 0004 §8; TESTING.md "Security and async side
// effects", "Fault injection exists only in test harnesses").
//
// On the seeded real IndexDO:
// - notify abuse limits (N1): malformed JSON 400, over 2 KiB 413, strict
//   shape 422, 61st request per IP per minute and 601st per DID per hour 429
//   with Retry-After, new-DID admission exhausted 503 `queue_full`. Every
//   refusal leaves every DO table unchanged and makes no remote call; a valid
//   request afterwards proves the index is still healthy;
// - SSRF: a fixture DoH answer that puts a PDS host in private address space
//   is refused before any request reaches that host, and a PDS redirect is
//   refused without following it. Both leave the projection byte-identical,
//   and the same record applies once the network is honest again;
// - no test seam is reachable: not over HTTP through the production Worker
//   (SELF, the entry's default export), not over JS RPC (the control method
//   is Symbol-keyed), and the unmodified production IndexDO refuses this very
//   environment (the fixture prefix) while production sources never read the
//   acceptance flag or import test-support.

import { SELF } from 'cloudflare:test';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config';
import type { Env } from '../../src/env';
import { createWorker } from '../../src/router';
import productionWrangler from '../../wrangler.jsonc?raw';
import { ACCEPTANCE, ALLOW_FIXTURE_VAR } from './entry';
import { checkResponse, schema } from './support/openapi';
import {
  ALICE,
  acceptanceEnv,
  allTables,
  BOB,
  GET_RECORD,
  hintCount,
  inSocket,
  projectionTables,
  SCROBBLE,
  seedAcceptance,
  uriOf,
} from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const PRODUCTION_SOURCES = import.meta.glob('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A distinct, valid did:plc for every n (never a fixture account). */
function newDid(n: number): string {
  let out = '';
  for (let v = n; out.length < 24; v = Math.floor(v / 32)) out = B32[v % 32] + out;
  return `did:plc:${out}`;
}

/** A promise's outcome, never an unhandled rejection (JS RPC promises are thenables). */
async function settle(
  fn: () => PromiseLike<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function scrobble(track: string, at: string) {
  return { $type: SCROBBLE, artist: 'Kate Bush', track, listenedAt: at, createdAt: at };
}

describe('security acceptance', () => {
  it('notify abuse limits, SSRF fixture private DoH answer refused, redirect refused, no test seam reachable', async () => {
    const a = await seedAcceptance('security');
    const notify = (body: unknown, ip = '203.0.113.7') => a.postJson('/api/v1/notify', body, ip);

    // ---------------------------------------------------------------- SSRF
    // Six minutes on, every cached DoH answer (at most 300 s) has expired.
    a.kit.clock.advance(6 * 60_000);
    const pdsAlice = a.kit.users.Alice.host;
    a.kit.doh.setPrivate(pdsAlice, ['10.0.0.7', 'fd00::7']);
    const ssrf = await inSocket(a, () =>
      a.kit.externalPut('Alice', SCROBBLE, 's01', scrobble('Babooshka', '2026-01-15T12:01:00Z')),
    );
    const beforeSsrf = await a.inDo(projectionTables);
    a.kit.resetCalls();
    expect(await a.alarm()).toBe(true);
    const ssrfState = await a.inDo((db) => ({
      tables: projectionTables(db),
      hint: db.one<{ attempts: number; last_error: string }>(
        'SELECT attempts, last_error FROM hints WHERE uri = ?',
        uriOf(ALICE, 's01'),
      ),
      counters: db.all("SELECT label, value FROM counters WHERE name = 'proof_fetch_failed'"),
    }));
    expect(JSON.stringify(ssrfState.tables)).toBe(JSON.stringify(beforeSsrf));
    expect(ssrfState.hint?.attempts).toBe(1);
    expect(ssrfState.hint?.last_error).toBe('fetch:blocked_destination');
    expect(ssrfState.counters).toEqual([{ label: 'blocked_destination', value: 1 }]);
    // The DoH pre-check ran for the PDS host; not one request reached it.
    expect(a.kit.doh.calls.filter({}).some((c) => (c.params.name ?? []).includes(pdsAlice))).toBe(true);
    expect(a.kit.pds.Alice.calls.entries).toEqual([]);
    expect(a.kit.transport.calls.count({ host: pdsAlice })).toBe(0);

    // ------------------------------------------------------------ redirect
    a.kit.pds.Bob.redirect(GET_RECORD, 'https://metadata.internal.example.test/latest/credentials');
    await inSocket(a, () => a.kit.externalPut('Bob', SCROBBLE, 's02', scrobble('Wow', '2026-01-15T12:02:00Z')));
    const beforeRedirect = await a.inDo(projectionTables);
    a.kit.resetCalls();
    a.kit.clock.advance(2_000);
    expect(await a.alarm()).toBe(true);
    const redirectState = await a.inDo((db) => ({
      tables: projectionTables(db),
      hint: db.one<{ last_error: string }>('SELECT last_error FROM hints WHERE uri = ?', uriOf(BOB, 's02')),
      counter: db.one(
        "SELECT value FROM counters WHERE name = 'proof_fetch_failed' AND label = 'redirect_refused_302'",
      ),
    }));
    expect(JSON.stringify(redirectState.tables)).toBe(JSON.stringify(beforeRedirect));
    expect(redirectState.hint?.last_error).toBe('fetch:http_302');
    expect(redirectState.counter).toEqual({ value: 1 });
    // One getRecord answered 302; the Location was never requested.
    expect(a.kit.pds.Bob.calls.filter({ nsid: GET_RECORD }).map((c) => c.status)).toEqual([302]);
    expect(a.kit.transport.calls.count({ host: 'metadata.internal.example.test' })).toBe(0);
    expect(a.kit.transport.calls.entries.filter((c) => c.service === 'router')).toEqual([]);

    // Honest network again: both records apply through the same production path.
    a.kit.doh.clear(pdsAlice);
    a.kit.clock.advance(6 * 60_000);
    a.kit.resetCalls();
    await a.alarmsUntil((db) => hintCount(db) === 0, { max: 10 });
    expect(
      await a.inDo((db) =>
        db.all(
          'SELECT uri, cid FROM scrobbles WHERE uri IN (?, ?) ORDER BY uri',
          uriOf(ALICE, 's01'),
          uriOf(BOB, 's02'),
        ),
      ),
    ).toEqual([
      { uri: uriOf(ALICE, 's01'), cid: ssrf.ops[0]?.cid },
      { uri: uriOf(BOB, 's02'), cid: expect.stringMatching(/^bafyrei/) },
    ]);
    expect(a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(1);

    // -------------------------------------------------------- notify abuse
    a.kit.resetCalls();
    let tables = await a.inDo(allTables);
    const refusals: Array<
      [string, () => Promise<{ status: number; body: unknown; headers: Headers }>, number, string, unknown]
    > = [
      [
        'malformed JSON',
        () =>
          a.request('/api/v1/notify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"uri":',
            ip: '203.0.113.7',
          }),
        400,
        'invalid_json',
        undefined,
      ],
      [
        'body over 2 KiB',
        () => notify({ uri: `at://${ALICE}/${SCROBBLE}/${'k'.repeat(2048)}` }),
        413,
        'payload_too_large',
        undefined,
      ],
      [
        'unknown field',
        () => notify({ uri: uriOf(ALICE, 'r01'), extra: 1 }),
        422,
        'validation_failed',
        { body: expect.any(String) },
      ],
      [
        'foreign collection',
        () => notify({ uri: `at://${ALICE}/app.bsky.feed.post/3k` }),
        422,
        'validation_failed',
        { uri: expect.any(String) },
      ],
      [
        'invalid DID',
        () => notify({ did: 'did:example:alice' }),
        422,
        'validation_failed',
        { did: expect.any(String) },
      ],
    ];
    for (const [label, send, status, code, fields] of refusals) {
      const r = await send();
      expect([label, r.status, (r.body as Json).error.code]).toEqual([label, status, code]);
      if (fields !== undefined) expect((r.body as Json).error.fields).toEqual(fields);
      expect([label, JSON.stringify(await a.inDo(allTables))]).toEqual([label, JSON.stringify(tables)]);
    }

    // Per IP: 60 per minute, then 429 with Retry-After and nothing written.
    for (let n = 0; n < 60; n++) {
      const r = await notify({ did: ALICE }, '203.0.113.50');
      expect([n, r.status]).toEqual([n, 202]);
    }
    tables = await a.inDo(allTables);
    const limited = await notify({ uri: uriOf(ALICE, 'r01') }, '203.0.113.50');
    expect(limited.status).toBe(429);
    expect((limited.body as Json).error.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await a.inDo(allTables))).toBe(JSON.stringify(tables));

    // Per DID: 600 per hour from any IP (Alice already used 60 of them).
    for (let n = 0; n < 540; n++) {
      const r = await notify({ did: ALICE }, `198.51.100.${10 + Math.floor(n / 60)}`);
      expect([n, r.status]).toEqual([n, 202]);
    }
    const perDid = await notify({ did: ALICE }, '198.51.100.200');
    expect(perDid.status).toBe(429);
    expect(Number(perDid.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await a.inDo(allTables))).toBe(JSON.stringify(tables));

    // New DIDs only through admission: 50 per hour, then 503 queue_full with nothing written.
    for (let n = 0; n < 50; n++) {
      const r = await notify({ did: newDid(1000 + n) }, `192.0.2.${1 + n}`);
      expect([n, r.status]).toEqual([n, 202]);
    }
    const admitted = await a.inDo(
      (db) => db.one<{ n: number }>("SELECT count(*) AS n FROM users WHERE indexing_state = 'recovering'")?.n,
    );
    expect(admitted).toBe(50);
    tables = await a.inDo(allTables);
    const full = await notify({ did: newDid(2000) }, '192.0.2.200');
    expect(full.status).toBe(503);
    expect((full.body as Json).error.code).toBe('queue_full');
    expect(JSON.stringify(await a.inDo(allTables))).toBe(JSON.stringify(tables));
    // None of the refusals or admissions reached the network.
    expect(a.kit.transport.calls.entries).toEqual([]);

    // Still healthy: a valid record notify from a fresh IP queues exactly one hint.
    const ok = await notify({ uri: uriOf(BOB, 'r09') }, '198.51.100.250');
    expect([ok.status, ok.body]).toEqual([202, { state: 'queued' }]);
    expect(await a.inDo((db) => db.all('SELECT uri, source FROM hints'))).toEqual([
      { uri: uriOf(BOB, 'r09'), source: 'notify' },
    ]);

    // ------------------------------------------------------ no test seam
    // Over HTTP, through the production Worker export: nothing answers but the API.
    for (const [method, path] of [
      ['GET', '/internal/acceptance'],
      ['POST', '/internal/acceptance/control'],
      ['GET', '/internal/test/reset'],
      ['GET', '/api/v1/__acceptance'],
      ['POST', '/api/v1/control'],
      ['GET', '/internal/admin/status'],
      ['POST', '/internal/admin/resnapshot'],
    ] as const) {
      const res = await SELF.fetch(`https://music.example.test${path}`, {
        method,
        headers: { authorization: 'Bearer x' },
      });
      const body = await res.json();
      expect([method, path, res.status, schema('Error', body), (body as Json).error.code]).toEqual([
        method,
        path,
        404,
        'valid',
        'not_found',
      ]);
    }
    // Over JS RPC: the control method has no string name, so a stub cannot reach it.
    const stub = a.stub as unknown as Record<string | symbol, unknown>;
    expect(stub[ACCEPTANCE]).toBeUndefined();
    for (const name of ['atmusic.acceptance-control', 'control', 'resetControl', 'record', 'deps']) {
      const outcome = await settle(() => (stub[name] as () => Promise<unknown>)());
      const refusedByReceiver = !outcome.ok && /does not implement/.test(outcome.error);
      expect([name, outcome.ok, refusedByReceiver]).toEqual([name, false, true]);
    }
    // Inside the isolate the handle works — through runInDurableObject only.
    expect(await a.inDo((_db, h) => h.constructed)).toBe(1);

    // The unmodified production IndexDO refuses this environment: the fixture
    // prefix needs allowFixturePrefix, which only test entries pass; the
    // acceptance flag is not read by worker/src.
    const prodStub = acceptanceEnv.PROD_INDEX.get(acceptanceEnv.PROD_INDEX.idFromName('production-class'));
    const prodReady = await settle(() => prodStub.ready());
    expect(prodReady).toEqual({ ok: false, error: 'NotReadyError: index configuration is invalid (ConfigError)' });
    expect(() => parseConfig(acceptanceEnv)).toThrow(ConfigError);
    expect(() => parseConfig(acceptanceEnv)).toThrow(/com\.example\.atmusic is fixture-only/);
    expect((acceptanceEnv as unknown as Record<string, string>)[ALLOW_FIXTURE_VAR]).toBe('true');
    const prodWorker = createWorker({ clock: a.kit.clock, random: seededRandom(3), indexName: 'production-class' });
    const prodEnv = { ...acceptanceEnv, INDEX: acceptanceEnv.PROD_INDEX } as unknown as Env;
    const prodFetch = async (method: 'GET' | 'POST', path: string, body?: string) => {
      const url = `https://music.example.test${path}`;
      const res = await prodWorker.fetch(
        new Request(url, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body }),
        }),
        prodEnv,
        {} as ExecutionContext,
      );
      const text = await res.text();
      return { url, res, text, json: JSON.parse(text) as Json };
    };
    const notReady = await prodFetch('GET', '/health/ready');
    expect([notReady.res.status, notReady.json.error.code]).toEqual([503, 'not_ready']);
    expect(
      checkResponse('GET', notReady.url, { status: 503, headers: notReady.res.headers, body: notReady.json }),
    ).toBe('valid');
    // Any other route gets the generic error envelope, revealing nothing about why.
    const refusedNotify = await prodFetch('POST', '/api/v1/notify', JSON.stringify({ did: ALICE }));
    expect([refusedNotify.res.status, refusedNotify.json.error.code, schema('Error', refusedNotify.json)]).toEqual([
      500,
      'internal_error',
      'valid',
    ]);
    expect(refusedNotify.text).not.toMatch(/ConfigError|fixture|com\.example|LEXICON_PREFIX/);
    // Production sources: no test-support import, no acceptance flag, no fixture-prefix opt-in.
    const sources = Object.entries(PRODUCTION_SOURCES);
    expect(sources.length).toBeGreaterThan(40);
    for (const [file, text] of sources) {
      // Code only: comments may describe the rule they enforce.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const offending = [
        /from\s+['"][^'"]*test-support/,
        /ACCEPTANCE_ALLOW_FIXTURE_PREFIX/,
        /allowFixturePrefix:\s*true/,
        /\bfixedClock\b/,
        /\bseededRandom\b/,
      ].filter((re) => re.test(code));
      expect([file, offending]).toEqual([file, []]);
    }
    // The scan is not vacuous: the one opt-in point exists and is a parameter.
    expect(PRODUCTION_SOURCES['../../src/config.ts']).toMatch(/allowFixturePrefix\?: boolean/);
    expect(productionWrangler).not.toMatch(/ACCEPTANCE_ALLOW_FIXTURE_PREFIX|TestIndexDO|com\.example\.atmusic/);
  });
});
