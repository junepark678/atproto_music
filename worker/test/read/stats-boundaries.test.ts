// W3-02: statistics window bounds (ADR 0004 §5.8, TESTING.md "Boundary test
// lower bounds", M5.1.2 boundary_seconds). The window is
// `[asOf − N·86400 s, asOf]`, both bounds inclusive; a record accepted up to
// receipt + 300 s stays out until asOf reaches it.
//
// Every probe record is a real signed scrobble whose getRecord proof is
// checked by the production verifier and applied by the production apply
// path. Requests go through the real route handler, asserting status, the
// OpenAPI schema, DO table state and zero remote calls. Expected membership is
// hardcoded from TESTING.md (and tests/goldens/windows.json, the Rust oracle's
// own probes), never derived from the query under test.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import windowsGolden from '../../../tests/goldens/windows.json' with { type: 'json' };
import { stats } from '../../src/do/read/stats';
import { applyRecordProof } from '../../src/do/write/apply-record';
import type { Env } from '../../src/env';
import { routes, STATS_PATTERN } from '../../src/http/stats';
import type { RequestCtx } from '../../src/http/types';
import type { HarnessDO } from '../harness/harness-do';
import { makeLocalIndex } from '../harness/local-index';
import { ALICE, OPTS, repoFor, SCROBBLE, scrobble, seedUser, stubFor } from '../write/support';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addFormat('at-did', /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/);
  ajv.addFormat('music-text', /^[\s\S]*\S[\s\S]*$/u);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const statisticsSchema = openapiValidator('Statistics');

const route = routes.find((r) => r.method === 'GET' && r.pattern === STATS_PATTERN)!;
type Stub = DurableObjectStub<HarnessDO>;

let cursorKey: CryptoKey;
beforeAll(async () => {
  cursorKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(5),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
});

/** Publish one probe as a signed commit; its verified proof goes through the production apply path. */
async function publish(stub: Stub, repo: SignedRepo, rkey: string, artist: string, listenedAt: string) {
  await repo.put(SCROBBLE, rkey, scrobble({ artist, track: `${artist} track`, listenedAt, createdAt: listenedAt }));
  const car = await repo.getRecordCar(SCROBBLE, rkey);
  const proof = await verifyRecordProof(car, {
    did: repo.did,
    collection: SCROBBLE,
    rkey,
    signingKey: repo.key.didKey,
  });
  return runInDurableObject(stub, (i: HarnessDO) => i.db.tx(() => applyRecordProof(i.db, proof, OPTS)));
}

async function freshAlice(name: string) {
  const stub = stubFor(name) as Stub;
  await runInDurableObject(stub, (i: HarnessDO) => seedUser(i.db, ALICE));
  return { stub, repo: await repoFor('alice') };
}

interface Window {
  body: Record<string, unknown>;
  members: string[];
}

/** GET stats at clock `iso`; asserts status, schema, one RPC, no network; returns member artists. */
async function window(stub: Stub, win: string, iso = '2026-01-15T12:00:00Z'): Promise<Window> {
  const index = makeLocalIndex({ stub }, { stats });
  const ctx: RequestCtx = {
    env: env as unknown as Env,
    index,
    requestId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    clock: fixedClock(iso),
    cursorKey,
    clientIp: '203.0.113.10',
  };
  const path = `${STATS_PATTERN.replace('{did}', ALICE)}?window=${win}&limit=100`;
  const res = await route.handler(new Request(`https://music.example.test${path}`), ctx, { did: ALICE });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(statisticsSchema(body)).toBe('valid');
  expect(body.window).toBe(win);
  expect(body.asOf).toBe(`${iso.slice(0, 19)}.000000000Z`);
  expect(index.calls.map((c) => c.method)).toEqual(['stats']);
  expect(index.networkAttempts).toEqual([]);
  const artists = body.topArtists as Array<{ artist: string; scrobbleCount: number }>;
  // Every probe is its own artist (count 1) and track, so the ranking lists the members.
  expect(artists.every((a) => a.scrobbleCount === 1)).toBe(true);
  expect(body.totalScrobbles).toBe(artists.length);
  expect(body.distinctTracks).toBe(artists.length);
  return { body, members: artists.map((a) => a.artist).sort() };
}

// Probe records one second before, at and after each lower bound (TESTING.md).
const PROBES: Array<[string, string]> = [
  ['7d -1s', '2026-01-08T11:59:59Z'],
  ['7d 0s', '2026-01-08T12:00:00Z'],
  ['7d +1s', '2026-01-08T12:00:01Z'],
  ['30d -1s', '2025-12-16T11:59:59Z'],
  ['30d 0s', '2025-12-16T12:00:00Z'],
  ['30d +1s', '2025-12-16T12:00:01Z'],
  ['365d -1s', '2025-01-15T11:59:59Z'],
  ['365d 0s', '2025-01-15T12:00:00Z'],
  ['365d +1s', '2025-01-15T12:00:01Z'],
];

it('records at lower bound −1s/0s/+1s for 7d/30d/365d have exact membership', async () => {
  const { stub, repo } = await freshAlice('stats-lower-bounds');
  for (const [i, [artist, at]] of PROBES.entries()) {
    expect((await publish(stub, repo, `b${i}`, artist, at)).outcome).toBe('applied');
  }
  const sorted = (xs: string[]) => [...xs].sort();
  expect((await window(stub, '7d')).members).toEqual(sorted(['7d 0s', '7d +1s']));
  expect((await window(stub, '30d')).members).toEqual(sorted(['7d -1s', '7d 0s', '7d +1s', '30d 0s', '30d +1s']));
  expect((await window(stub, '365d')).members).toEqual(
    sorted(['7d -1s', '7d 0s', '7d +1s', '30d -1s', '30d 0s', '30d +1s', '365d 0s', '365d +1s']),
  );
  expect((await window(stub, 'all')).members).toEqual(sorted(PROBES.map(([a]) => a)));

  // One second later every lower bound has moved past its "0s" probe.
  const later = '2026-01-15T12:00:01Z';
  expect((await window(stub, '7d', later)).members).toEqual(['7d +1s']);
  expect((await window(stub, '30d', later)).members).toEqual(sorted(['7d -1s', '7d 0s', '7d +1s', '30d +1s']));
  expect((await window(stub, '365d', later)).members).toEqual(
    sorted(['7d -1s', '7d 0s', '7d +1s', '30d -1s', '30d 0s', '30d +1s', '365d +1s']),
  );

  // The cache rows carry the exact lower bounds of the last computation.
  const rows = await runInDurableObject(stub, (i: HarnessDO) =>
    i.db.all<{ win: string; as_of: string; lower: string | null }>(
      'SELECT win, as_of, lower FROM stats_cache WHERE did = ? ORDER BY win',
      ALICE,
    ),
  );
  expect(rows).toEqual([
    { win: '30d', as_of: '2026-01-15T12:00:01.000000000Z', lower: '2025-12-16T12:00:01.000000000Z' },
    { win: '365d', as_of: '2026-01-15T12:00:01.000000000Z', lower: '2025-01-15T12:00:01.000000000Z' },
    { win: '7d', as_of: '2026-01-15T12:00:01.000000000Z', lower: '2026-01-08T12:00:01.000000000Z' },
    { win: 'all', as_of: '2026-01-15T12:00:00.000000000Z', lower: null },
  ]);
});

it('record at asOf+300s excluded until asOf passes it', async () => {
  const { stub, repo } = await freshAlice('stats-future');
  // Receipt time is asOf (12:00:00): +300 s is accepted, +301 s is excluded by validation.
  expect((await publish(stub, repo, 'f0', 'at asOf', '2026-01-15T12:00:00Z')).outcome).toBe('applied');
  expect((await publish(stub, repo, 'f1', 'future 300', '2026-01-15T12:05:00Z')).outcome).toBe('applied');
  expect((await publish(stub, repo, 'f2', 'future 301', '2026-01-15T12:05:01Z')).outcome).toBe('excluded');
  const stored = await runInDurableObject(stub, (i: HarnessDO) =>
    i.db.all<{ rkey: string; listened_at: string }>('SELECT rkey, listened_at FROM scrobbles ORDER BY rkey'),
  );
  expect(stored).toEqual([
    { rkey: 'f0', listened_at: '2026-01-15T12:00:00.000000000Z' },
    { rkey: 'f1', listened_at: '2026-01-15T12:05:00.000000000Z' },
  ]);

  for (const win of ['all', '7d']) {
    expect((await window(stub, win)).members).toEqual(['at asOf']);
    expect((await window(stub, win, '2026-01-15T12:04:59Z')).members).toEqual(['at asOf']);
    // asOf has reached it: the upper bound is inclusive.
    expect((await window(stub, win, '2026-01-15T12:05:00Z')).members).toEqual(['at asOf', 'future 300']);
    expect((await window(stub, win, '2026-01-15T12:05:01Z')).members).toEqual(['at asOf', 'future 300']);
  }
});

it('every tests/goldens/windows.json probe has the Rust oracle membership', async () => {
  expect(windowsGolden.asOf).toBe('2026-01-15T12:00:00Z');
  for (const w of windowsGolden.windows) {
    const { stub, repo } = await freshAlice(`stats-golden-${w.window}`);
    const included: string[] = [];
    for (const [i, p] of w.probes.entries()) {
      const name = `probe ${p.listenedAt}`;
      expect((await publish(stub, repo, `g${i}`, name, p.listenedAt)).outcome).toBe('applied');
      if (p.included) included.push(name);
    }
    const got = await window(stub, w.window);
    expect(got.members).toEqual(included.sort());
    const row = await runInDurableObject(stub, (i: HarnessDO) =>
      i.db.one<{ as_of: string; lower: string | null }>('SELECT as_of, lower FROM stats_cache WHERE win = ?', w.window),
    );
    expect(row).toEqual({ as_of: w.upperBound, lower: w.lowerBound });
  }
});
