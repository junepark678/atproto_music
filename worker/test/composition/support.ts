// Shared helpers for the W5-01 composition suites. TEST-ONLY.
//
// Every test drives the production Worker handlers (`createWorker` from
// src/router.ts, with the frozen clock, a seeded Random and a unique IndexDO
// name per test, ADR A18) against the INDEX binding of
// wrangler.composition.jsonc, i.e. the real IndexDO over JS RPC (entry.ts
// TestIndexDO). ASSETS is a recording fake: the composition Worker has no
// static assets, and the tests assert what reaches it.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  createFixtureKit,
  type FixtureKit,
  type SeedResult,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import { seededRandom } from '@atmusic/core/test-support/random';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openapiText from '../../../api/openapi.yaml?raw';
import type { Db } from '../../src/do/db';
import { doDb } from '../../src/do/db';
import type { Env } from '../../src/env';
import { createWorker } from '../../src/router';
import { control, resetControl, type TestIndexDO } from './entry';

export { control, resetControl };

/** The composition bindings (the harness's Cloudflare.Env augmentation does not describe them). */
export const compositionEnv = env as unknown as Env;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
export const CURSOR_KEY_HEX = (env as unknown as Env).CURSOR_KEY;

let counter = 0;
/** A DO name no other test uses. */
export function freshName(label: string): string {
  counter += 1;
  return `${label}-${counter}`;
}

export interface AssetCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export function fakeAssets(): Fetcher & { calls: AssetCall[] } {
  const calls: AssetCall[] = [];
  return {
    calls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(input as RequestInfo, init);
      calls.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers) });
      return new Response(`asset:${new URL(req.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
    connect() {
      throw new Error('not used');
    },
  } as unknown as Fetcher & { calls: AssetCall[] };
}

export interface Harness {
  name: string;
  worker: ReturnType<typeof createWorker>;
  env: Env;
  assets: ReturnType<typeof fakeAssets>;
  stub: DurableObjectStub<TestIndexDO>;
  /** One Worker request; JSON bodies are parsed. */
  request(path: string, init?: RequestInit & { ip?: string }): Promise<HttpResult>;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

export function harness(label: string, envOverrides: Partial<Env> = {}): Harness {
  const name = freshName(label);
  const assets = fakeAssets();
  const workerEnv = { ...compositionEnv, ...envOverrides, ASSETS: assets } as Env;
  const worker = createWorker({ clock: control.clock, random: seededRandom(11), indexName: name });
  const stub = compositionEnv.INDEX.get(
    compositionEnv.INDEX.idFromName(name),
  ) as unknown as DurableObjectStub<TestIndexDO>;
  return {
    name,
    worker,
    env: workerEnv,
    assets,
    stub,
    async request(path, init = {}) {
      const { ip, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (ip !== undefined) headers.set('cf-connecting-ip', ip);
      const res = await worker.fetch(
        new Request(`https://music.example.test${path}`, { ...rest, headers }),
        workerEnv,
        {} as ExecutionContext,
      );
      const text = await res.text();
      let body: unknown = null;
      if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
      return { status: res.status, headers: res.headers, text, body };
    },
  };
}

/** Run `fn` inside the DO with its instance and a Db over its storage. */
export function inDo<R>(
  stub: DurableObjectStub<TestIndexDO>,
  fn: (instance: TestIndexDO, db: Db, state: DurableObjectState) => R | Promise<R>,
) {
  return runInDurableObject(stub, (instance: TestIndexDO, state) => fn(instance, doDb(state.storage), state));
}

export function runAlarm(stub: DurableObjectStub<TestIndexDO>): Promise<boolean> {
  return runDurableObjectAlarm(stub);
}

/** The logical alarm times IndexDO armed for `stub`, in order. */
export function armed(stub: DurableObjectStub<TestIndexDO>): Array<number | null> {
  return control.armed.get(stub.id.toString()) ?? [];
}

export function constructed(stub: DurableObjectStub<TestIndexDO>): number {
  return control.constructed.get(stub.id.toString()) ?? 0;
}

/** Let queued WebSocket events and microtasks run (no clock involved). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A fixture kit on the control's clock, wired as the IndexDO transport. */
export async function kitControl(o: Parameters<typeof resetControl>[0] = {}): Promise<FixtureKit> {
  const kit = await createFixtureKit();
  resetControl({ ...o, clock: kit.clock, transport: kit.transport });
  return kit;
}

// ---------------------------------------------------------------------------
// OpenAPI schemas (AJV against api/openapi.yaml)

const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);
ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
ajv.addSchema({ $id: 'openapi', components: (JSON.parse(openapiText) as { components: unknown }).components });

/** 'valid', or AJV's error text for `value` against components.schemas[name]. */
export function schema(name: string, value: unknown): string {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return (validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors);
}

/** Run alarms (advancing the clock by `stepMs` before each) until `done` holds; returns the runs. */
export async function alarmsUntil(
  h: Pick<Harness, 'stub'>,
  done: () => Promise<boolean>,
  o: { max?: number; stepMs?: number } = {},
): Promise<number> {
  const max = o.max ?? 40;
  for (let n = 0; n < max; n++) {
    if (await done()) return n;
    control.clock.advance(o.stepMs ?? 2_000);
    await runAlarm(h.stub);
    await flush();
  }
  if (await done()) return max;
  throw new Error(`condition not reached after ${max} alarms`);
}

// ---------------------------------------------------------------------------
// The shared fixture through the production ingestion path

export const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const CAROL = 'did:plc:cccccccccccccccccccccccc';
export const SCROBBLE = 'com.example.atmusic.scrobble';
export const FOLLOW = 'com.example.atmusic.follow';
export const uriOf = (did: string, rkey: string) => `at://${did}/${SCROBBLE}/${rkey}`;

/** Users whose complete snapshot made them visible. */
export function activeUsers(db: Db): string[] {
  return db.all<{ did: string }>('SELECT did FROM users WHERE active = 1 ORDER BY did').map((r) => r.did);
}

export function openSnapshotJobs(db: Db): number {
  return (
    db.one<{ n: number }>(
      `SELECT count(*) AS n FROM repo_jobs WHERE kind = 'snapshot' AND state IN ('pending','running','failed')`,
    )?.n ?? 0
  );
}

export function postJson(h: Harness, path: string, body: unknown, init: RequestInit & { ip?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return h.request(path, { ...init, method: 'POST', headers, body: JSON.stringify(body) });
}

/**
 * read_models.json published as real signed commits (seedReadModels), then
 * each account announced through POST /api/v1/notify `{did}` and indexed by
 * the IndexDO alarm (admission → range snapshot → apply).
 */
export async function ingestFixture(h: Harness, kit: FixtureKit): Promise<SeedResult> {
  const seed = await seedReadModels(kit);
  for (const did of [ALICE, BOB, CAROL]) {
    const r = await postJson(h, '/api/v1/notify', { did }, { ip: '198.51.100.1' });
    if (r.status !== 202) throw new Error(`notify ${did}: ${r.status} ${r.text}`);
  }
  await alarmsUntil(h, () => inDo(h.stub, (_i, db) => activeUsers(db).length === 3 && openSnapshotJobs(db) === 0));
  return seed;
}
