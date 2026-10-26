// W6-01 security acceptance on the Node host (ported by N4-03; ADR 0004 §8,
// ADR 0005 §3.5, §3.9, §13; TESTING.md "Security and async side effects",
// "Fault injection exists only in test harnesses").
//
// On the seeded production Node composition (entry.ts):
// - notify abuse limits (N1): malformed JSON 400, over 2 KiB 413, strict
//   shape 422, 61st request per IP per minute and 601st per DID per hour 429
//   with Retry-After, new-DID admission exhausted 503 `queue_full`. Every
//   refusal leaves every table unchanged and makes no remote call; a valid
//   request afterwards proves the index is still healthy;
// - SSRF: a fixture DoH answer that puts a PDS host in private address space
//   is refused before any request reaches that host, and a PDS redirect is
//   refused without following it. Both leave the projection byte-identical,
//   and the same record applies once the network is honest again;
// - no test seam is reachable: not over HTTP (the production route table and
//   dispatcher answer nothing but the API), not on IndexCore (it has no
//   control method), and the production entry refuses this very environment
//   (the fixture prefix needs the test-only parseNodeConfig option, which
//   main.ts never passes: run() exits 78) while production sources never
//   import test-support or opt into a fixture option at a call site.

import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { afterEach, describe, expect, it } from 'vitest';
import envExample from '../../../config/atmusic.env.example?raw';
import { IndexCore } from '../../src/app/index-core';
import { ConfigError } from '../../src/config';
import { parseNodeConfig } from '../../src/node/config';
import { type ExitCode, run } from '../../src/node/run';
import { closeHarnesses, control, harness, harnessEnv } from '../composition/support';
import { captureLog, manualTimers, refusingJetstream, testSecretsDocument } from '../node/support/app';
import { checkResponse, schema } from './support/openapi';
import {
  ALICE,
  allTables,
  BOB,
  GET_RECORD,
  hintCount,
  inSocket,
  PUBLIC_ORIGIN,
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

function scrobble(track: string, at: string) {
  return { $type: SCROBBLE, artist: 'Kate Bush', track, listenedAt: at, createdAt: at };
}

describe('security acceptance', () => {
  afterEach(closeHarnesses);

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
      // A member given twice is the strict-body 422, as serde's duplicate-field
      // error in the Rust oracle (JSON.parse alone would keep the last value).
      ...(
        [
          ['duplicate uri', `{"uri":"${uriOf(ALICE, 'r01')}","uri":"${uriOf(BOB, 'r09')}"}`],
          ['duplicate uri, escaped name', `{"uri":"${uriOf(ALICE, 'r01')}", "\\u0075ri" : "${uriOf(ALICE, 'r01')}"}`],
          ['duplicate did', `{"did":"${ALICE}","did":"${ALICE}"}`],
          ['duplicate invalid uri', `{"uri":"not-a-uri","uri":"${uriOf(ALICE, 'r01')}"}`],
        ] as const
      ).map(
        ([label, body]) =>
          [
            label,
            () =>
              a.request('/api/v1/notify', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                ip: '203.0.113.7',
              }),
            422,
            'validation_failed',
            { body: 'Expected one string uri or did field and no unknown fields.' },
          ] as [string, () => Promise<{ status: number; body: unknown; headers: Headers }>, number, string, unknown],
      ),
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
    // Over HTTP, through the production dispatcher and route table: nothing answers but the API.
    const probes = [
      ['GET', '/internal/acceptance'],
      ['POST', '/internal/acceptance/control'],
      ['GET', '/internal/test/reset'],
      ['GET', '/api/v1/__acceptance'],
      ['POST', '/api/v1/control'],
      ['GET', '/internal/admin/status'],
      ['POST', '/internal/admin/resnapshot'],
      ['GET', '/api/test/echo'],
    ] as const;
    tables = await a.inDo(allTables);
    for (const [method, path] of probes) {
      const res = await a.h.request(path, { method, headers: { authorization: 'Bearer x' } });
      expect([method, path, res.status, schema('Error', res.body), (res.body as Json).error.code]).toEqual([
        method,
        path,
        404,
        'valid',
        'not_found',
      ]);
    }
    expect(JSON.stringify(await a.inDo(allTables))).toBe(JSON.stringify(tables));
    // The composed route table is the production one: /api/v1, /health and nothing internal.
    const patterns = a.h.app.routes.routes.map((r) => `${r.method} ${r.pattern}`);
    expect(patterns.length).toBeGreaterThan(10);
    for (const p of patterns) expect(p).toMatch(/^(GET|POST) \/(api\/v1|health)\//);
    for (const [method, path] of probes) {
      expect([method, path, a.h.app.routes.match(method, path).kind]).toEqual([method, path, 'none']);
    }
    // IndexCore has no control method: only its RPC, admin and lifecycle methods exist.
    const methods = Object.getOwnPropertyNames(IndexCore.prototype).filter((n) => n !== 'constructor');
    expect(methods.length).toBeGreaterThan(20);
    for (const name of ['control', 'resetControl', 'record', 'stopRecording', 'acceptance', 'setClock', 'inject']) {
      expect([name, methods.includes(name)]).toEqual([name, false]);
    }
    // The test handle exists only in this process's test code.
    expect(await a.inDo((_db, h) => h.constructed)).toBe(1);

    // The production entry refuses this environment: the fixture prefix needs
    // the test-only `allowFixturePrefix` option, which main.ts never passes.
    const env = { ...harnessEnv(a.h.dir), LEXICON_PREFIX: 'com.example.atmusic' };
    expect(() => parseNodeConfig(env)).toThrow(ConfigError);
    expect(() => parseNodeConfig(env, { fixtureOrigins: true })).toThrow(/com\.example\.atmusic is fixture-only/);
    expect(parseNodeConfig(env, { fixtureOrigins: true, allowFixturePrefix: true }).app.prefix).toBe(
      'com.example.atmusic',
    );
    // run() as main.ts calls it (no configOptions): exit 78 naming LEXICON_PREFIX, nothing opened.
    const prodDir = join(a.h.dir, 'production');
    mkdirSync(join(prodDir, 'web', 'dist'), { recursive: true });
    writeFileSync(join(prodDir, 'web', 'dist', 'index.html'), '<!doctype html><title>t</title>');
    const secretsFile = join(prodDir, 'secrets.json');
    writeFileSync(secretsFile, JSON.stringify(testSecretsDocument()));
    chmodSync(secretsFile, 0o600);
    const prodEnv = {
      ...harnessEnv(prodDir),
      ATMUSIC_ASSETS_DIR: join(prodDir, 'web', 'dist'),
      ATMUSIC_SECRETS_FILE: secretsFile,
    };
    const prodLog = captureLog();
    const stderr: string[] = [];
    const exits: ExitCode[] = [];
    const fetchBefore = globalThis.fetch;
    const code = await run({
      argv: ['node', 'main.mjs', '--init'],
      env: prodEnv,
      exit: (c) => exits.push(c),
      log: prodLog.logger,
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      transport: routerTransport({}) as FixtureTransport,
      connectJetstream: refusingJetstream(),
      timers: manualTimers(),
      signals: new EventEmitter(),
    });
    expect([code, exits]).toEqual([78, [78]]);
    const refusal = prodLog.logs.find((l) => l.event === 'run.config_error') as { fields: string[] } | undefined;
    expect(refusal?.fields).toContain('LEXICON_PREFIX');
    expect(stderr.join('')).toMatch(/LEXICON_PREFIX: .*fixture-only/);
    // It refused before the database, the socket or the fetch stub.
    expect(existsSync(parseNodeConfig(prodEnv, { fixtureOrigins: true, allowFixturePrefix: true }).dbPath)).toBe(false);
    expect(globalThis.fetch).toBe(fetchBefore);

    // Production sources: no test-support import, no acceptance flag, no fixture opt-in at a call site.
    const sources = Object.entries(PRODUCTION_SOURCES);
    expect(sources.length).toBeGreaterThan(60);
    for (const [file, text] of sources) {
      // Code only: comments may describe the rule they enforce.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const offending = [
        /from\s+['"][^'"]*test-support/,
        /ACCEPTANCE_ALLOW_FIXTURE_PREFIX/,
        /allowFixturePrefix:\s*true/,
        /fixtureOrigins:\s*true/,
        /\bfixedClock\b/,
        /\bseededRandom\b/,
        /\brouterTransport\b/,
      ].filter((re) => re.test(code));
      expect([file, offending]).toEqual([file, []]);
    }
    // The scan is not vacuous: the two opt-in points exist and are parameters.
    expect(PRODUCTION_SOURCES['../../src/config.ts']).toMatch(/allowFixturePrefix\?: boolean/);
    expect(PRODUCTION_SOURCES['../../src/node/config.ts']).toMatch(/fixtureOrigins\?: boolean/);
    // The shipped configuration example names the production prefix, never the fixture one.
    expect(envExample).toMatch(/LEXICON_PREFIX=dev\.pythonplayer123\.music/);
    expect(envExample).not.toMatch(/ACCEPTANCE_ALLOW_FIXTURE_PREFIX|com\.example\.atmusic/);
  });

  it('notify returns 503 when IndexDO is unavailable', async () => {
    const a = await seedAcceptance('notify-unavailable');
    const url = `${PUBLIC_ORIGIN}/api/v1/notify`;
    const post = async (target: { request: typeof a.h.request }, body: unknown) => {
      const res = await target.request('/api/v1/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ip: '203.0.113.9',
      });
      const json = res.body as Json;
      return {
        res,
        text: res.text,
        json,
        verdict: checkResponse('POST', url, { status: res.status, headers: res.headers, body: json }),
      };
    };
    const expectUnavailable = (r: Awaited<ReturnType<typeof post>>, label: string) => {
      // The OpenAPI-declared 503 with the Error schema, never an undeclared 500.
      expect([label, r.res.status, r.verdict, schema('Error', r.json)]).toEqual([label, 503, 'valid', 'valid']);
      expect([label, r.json.error.code, r.json.error.message]).toEqual([
        label,
        'not_ready',
        'Index storage is not initialized.',
      ]);
      expect(r.json.error.fields).toBeUndefined();
      expect(r.res.headers.get('cache-control')).toBe('no-store');
      expect(r.json.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(r.res.headers.get('x-request-id')).toBe(r.json.error.requestId);
      // Nothing about the cause leaks.
      expect(r.text).not.toMatch(
        /ConfigError|NotReadyError|IndexError|fixture|com\.example|LEXICON_PREFIX|disk|stack/i,
      );
    };

    const before = await a.inDo(allTables);
    a.kit.resetCalls();

    // 1. A composition whose index storage is not ready (a database file that
    //    was never migrated: compose leaves IndexCore unstarted and every call
    //    rejects with NotReadyError).
    const unready = await harness('notify-unmigrated', { migrate: false });
    expect(unready.app.schema).toEqual({ status: 'pending', version: 0 });
    expect(unready.core.isReady).toBe(false);
    for (const body of [{ did: ALICE }, { uri: uriOf(ALICE, 'r01') }]) {
      expectUnavailable(await post(unready, body), JSON.stringify(body));
    }
    // Admission still runs first: an invalid body is its own 4xx, not a 503.
    const invalid = await post(unready, { uri: uriOf(ALICE, 'r01'), extra: 1 });
    expect([invalid.res.status, invalid.json.error.code, invalid.verdict]).toEqual([422, 'validation_failed', 'valid']);
    const notReady = await unready.request('/health/ready');
    expect([notReady.status, (notReady.body as Json).error.code]).toEqual([503, 'not_ready']);

    // 2. An IndexCore whose storage fails under the call (an injected Db fault,
    //    as a full disk or an I/O error would): the same 503, and the failing
    //    transaction leaves nothing behind.
    control.dbFault = { match: /./, message: 'SQLITE_FULL: database or disk is full', remaining: 1 };
    expectUnavailable(await post(a.h, { did: ALICE }), 'storage failure');
    expect(control.dbFault.remaining).toBe(0);
    control.dbFault = null;

    // Neither outage touched the healthy index or the network ...
    expect(JSON.stringify(await a.inDo(allTables))).toBe(JSON.stringify(before));
    expect(a.kit.transport.calls.entries).toEqual([]);
    // ... and the same request against the healthy composition is queued (202):
    // one hint row, and only the hint, its counters and the drain timer change.
    const ok = await a.postJson('/api/v1/notify', { uri: uriOf(BOB, 'r09') }, '198.51.100.250');
    expect([ok.status, ok.schema, ok.body]).toEqual([202, 'valid', { state: 'queued' }]);
    const afterOk = await a.inDo(allTables);
    expect((afterOk.hints as Array<{ uri: string }>).map((h) => h.uri)).toEqual([uriOf(BOB, 'r09')]);
    expect({ ...afterOk, hints: before.hints, counters: before.counters, timers: before.timers }).toEqual(before);
    // The duplicate-member check has no false positive: one member spelled with
    // an escape and spaced out is still one member (and coalesces with the hint).
    const escaped = await a.request('/api/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ` { "\\u0075ri" : "${uriOf(BOB, 'r09')}" } `,
      ip: '198.51.100.251',
    });
    expect([escaped.status, escaped.body]).toEqual([202, { state: 'queued' }]);
    expect(((await a.inDo(allTables)).hints ?? []).map((h) => (h as { uri: string }).uri)).toEqual([uriOf(BOB, 'r09')]);
    // The unmigrated file stayed unmigrated: nothing the refusals did created a schema.
    expect(unready.db.one<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")?.n).toBe(0);
  });
});
