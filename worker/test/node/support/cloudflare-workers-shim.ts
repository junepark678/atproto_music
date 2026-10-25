// `cloudflare:workers` for the worker-modules suites on Node (ADR 0005 §15.1,
// N2-02). worker/vitest.modules.config.ts aliases the module id to this file;
// N4-04 to N4-06 remove the imports and N7-01 deletes the shim. TEST-ONLY.
//
// - `env`: the vars and Durable Object bindings of
//   worker/test/harness/wrangler.harness.jsonc, read from that file, so the
//   harness config stays the single source. Each binding is a namespace with
//   `idFromName`, `idFromString`, `get` and `getByName`.
// - `exports.default.fetch(input, init)`: the harness entry's default fetch
//   (worker/test/harness/entry.ts) with this `env`, as workerd's
//   `exports.default` loopback.
// - `DurableObject`: the base class, with `ctx` and `env`.
//
// Durable Objects. One object per (binding, name). Its storage is one SQLite
// file opened by the production adapter through the DO-storage facade
// (do-storage-facade.ts) in this test file's own temporary directory: vitest
// evaluates this module once per test file, so every test file gets a new
// directory and a write in one file is invisible to every other file. The
// directory is removed after the file (workerd-globals.ts, afterAll).
// An object is constructed on first use; `ctx.blockConcurrencyWhile` gates
// every later delivery (fetch, RPC, runInDurableObject) until it settles, and
// a rejected gate resets the object, as workerd does. `evictObject` closes the
// connection and drops the instance; the next delivery reopens the same file
// and constructs a new instance (migrate runs again on the same storage).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AlarmCell, type DoStorageFacade, openDoStorage } from './do-storage-facade';

// ---------------------------------------------------------------------------
// Harness configuration

const HARNESS_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '../../harness/wrangler.harness.jsonc');

/** JSON with comments and trailing commas (wrangler's config format) to JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface HarnessConfig {
  main: string;
  vars: Record<string, string>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
}

export const harnessConfig = parseJsonc(readFileSync(HARNESS_CONFIG, 'utf8')) as HarnessConfig;
if (harnessConfig.main !== './entry.ts') {
  throw new Error(`the shim loads worker/test/harness/entry.ts; wrangler.harness.jsonc names ${harnessConfig.main}`);
}

type EntryModule = typeof import('../../harness/entry');
let entryModule: Promise<EntryModule> | null = null;
/** The harness entry, loaded on first use (it imports this module through the alias). */
function loadEntry(): Promise<EntryModule> {
  entryModule ??= import('../../harness/entry');
  return entryModule;
}

// ---------------------------------------------------------------------------
// DurableObject base class

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// ---------------------------------------------------------------------------
// Object registry (one per test file: one per evaluation of this module)

let storageDir: string | null = null;

/** This test file's temporary storage directory (created on first use). */
export function shimStorageDir(): string {
  storageDir ??= mkdtempSync(join(tmpdir(), 'atmusic-shim-'));
  return storageDir;
}

export class ShimDurableObjectId {
  constructor(
    readonly binding: string,
    private readonly hex: string,
    readonly name?: string,
  ) {}
  toString(): string {
    return this.hex;
  }
  equals(other: { toString(): string }): boolean {
    return other.toString() === this.hex;
  }
}

interface InstanceLike {
  fetch?(request: Request): Promise<Response> | Response;
  alarm?(info?: { retryCount: number; isRetry: boolean }): Promise<void> | void;
  [key: string]: unknown;
}

export interface ShimObject {
  readonly id: ShimDurableObjectId;
  readonly binding: string;
  /** The database file (stable across evictions). */
  readonly path: string;
  readonly alarm: AlarmCell;
  /** The live instance, its state and storage; null while evicted or not yet constructed. */
  live: { instance: InstanceLike; state: DurableObjectState; storage: DoStorageFacade; gate: Promise<void> } | null;
  /** Times the object was constructed (1 + evictions that were followed by a delivery). */
  constructions: number;
  /** True once storage was created on disk. */
  created: boolean;
}

const objects = new Map<string, ShimObject>();

function objectFor(id: ShimDurableObjectId): ShimObject {
  const key = `${id.binding}:${id.toString()}`;
  let entry = objects.get(key);
  if (entry === undefined) {
    entry = {
      id,
      binding: id.binding,
      path: join(shimStorageDir(), `${id.binding}-${id.toString()}.sqlite`),
      alarm: { at: null },
      live: null,
      constructions: 0,
      created: false,
    };
    objects.set(key, entry);
  }
  return entry;
}

function makeState(entry: ShimObject, storage: DoStorageFacade, gates: Array<Promise<unknown>>): DurableObjectState {
  const state = {
    id: entry.id,
    storage,
    blockConcurrencyWhile<T>(fn: () => Promise<T> | T): Promise<T> {
      const p = Promise.resolve().then(fn);
      gates.push(p);
      return p;
    },
    waitUntil(p: Promise<unknown>): void {
      p.catch(() => {});
    },
    acceptWebSocket(): void {
      throw new Error('the shim does not implement hibernatable WebSockets');
    },
    getWebSockets(): WebSocket[] {
      return [];
    },
    abort(reason?: string): void {
      evictObject(entry);
      throw new Error(reason ?? 'Durable Object aborted');
    },
  };
  return state as unknown as DurableObjectState;
}

/** Constructs the object if needed and waits for its blockConcurrencyWhile gates. */
export async function liveObject(id: ShimDurableObjectId): Promise<NonNullable<ShimObject['live']>> {
  const entry = objectFor(id);
  if (entry.live === null) {
    const { default: _handler, ...classes } = await loadEntry();
    const bindingDef = harnessConfig.durable_objects.bindings.find((b) => b.name === entry.binding);
    const Ctor = bindingDef === undefined ? undefined : (classes as Record<string, unknown>)[bindingDef.class_name];
    if (typeof Ctor !== 'function') throw new Error(`no Durable Object class for binding ${entry.binding}`);
    if (entry.live !== null) return awaitGate(entry);
    const storage = openDoStorage(entry.path, { create: !entry.created, alarm: entry.alarm });
    entry.created = true;
    const gates: Array<Promise<unknown>> = [];
    const state = makeState(entry, storage, gates);
    const instance = new (Ctor as new (s: DurableObjectState, e: unknown) => InstanceLike)(state, env);
    entry.constructions++;
    const gate = Promise.all(gates).then(() => undefined);
    entry.live = { instance, state, storage, gate };
  }
  return awaitGate(entry);
}

async function awaitGate(entry: ShimObject): Promise<NonNullable<ShimObject['live']>> {
  const live = entry.live;
  if (live === null) throw new Error('the Durable Object was evicted');
  try {
    await live.gate;
  } catch (error) {
    // A failed blockConcurrencyWhile resets the object (workerd); the error reaches the caller.
    if (entry.live === live) evictObject(entry);
    throw error;
  }
  return live;
}

/** Closes the object's connection and drops its instance; storage and alarm stay. */
export function evictObject(entry: ShimObject): void {
  const live = entry.live;
  entry.live = null;
  live?.storage.close();
}

/** The registry entry for an id (no construction). */
export function shimObject(id: ShimDurableObjectId): ShimObject {
  return objectFor(id);
}

/** Every object of `binding` whose storage exists in this test file, in creation order. */
export function shimObjects(binding?: string): ShimObject[] {
  return [...objects.values()].filter((o) => o.created && (binding === undefined || o.binding === binding));
}

/** Closes every connection and removes this test file's directory (afterAll). */
export function shimTeardown(): void {
  for (const entry of objects.values()) evictObject(entry);
  objects.clear();
  if (storageDir !== null) rmSync(storageDir, { recursive: true, force: true });
  storageDir = null;
}

// ---------------------------------------------------------------------------
// Namespaces and stubs

const STUB_ID = Symbol('shim.stub.id');

/** The id behind a shim stub. */
export function stubId(stub: unknown): ShimDurableObjectId {
  const id = (stub as { [STUB_ID]?: ShimDurableObjectId } | null)?.[STUB_ID];
  if (!(id instanceof ShimDurableObjectId)) throw new TypeError('not a shim Durable Object stub');
  return id;
}

function makeStub(id: ShimDurableObjectId): DurableObjectStub {
  const base = {
    [STUB_ID]: id,
    id,
    name: id.name,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const { instance } = await liveObject(id);
      if (typeof instance.fetch !== 'function') throw new TypeError('the Durable Object has no fetch handler');
      return instance.fetch(new Request(input, init));
    },
  };
  // RPC: any other method name calls the instance's method after the gate.
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const { instance } = await liveObject(id);
        const method = instance[prop];
        if (typeof method !== 'function') throw new TypeError(`the Durable Object has no RPC method ${prop}`);
        return (method as (...a: unknown[]) => unknown).apply(instance, args);
      };
    },
  }) as unknown as DurableObjectStub;
}

export class ShimDurableObjectNamespace {
  constructor(readonly binding: string) {}
  idFromName(name: string): ShimDurableObjectId {
    const hex = createHash('sha256').update(`${this.binding}\0${name}`).digest('hex');
    return new ShimDurableObjectId(this.binding, hex, name);
  }
  idFromString(hex: string): ShimDurableObjectId {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('Invalid Durable Object ID: must be 64 hex digits');
    const known = [...objects.values()].find((o) => o.binding === this.binding && o.id.toString() === hex);
    return known?.id ?? new ShimDurableObjectId(this.binding, hex);
  }
  newUniqueId(): ShimDurableObjectId {
    throw new Error('the shim has no unique ids: use idFromName (deterministic tests)');
  }
  get(id: ShimDurableObjectId): DurableObjectStub {
    if (!(id instanceof ShimDurableObjectId) || id.binding !== this.binding) {
      throw new TypeError(`id does not belong to namespace ${this.binding}`);
    }
    return makeStub(id);
  }
  getByName(name: string): DurableObjectStub {
    return this.get(this.idFromName(name));
  }
}

// ---------------------------------------------------------------------------
// env and exports

const bindings: Record<string, ShimDurableObjectNamespace> = Object.fromEntries(
  harnessConfig.durable_objects.bindings.map((b) => [b.name, new ShimDurableObjectNamespace(b.name)]),
);

export const env = { ...harnessConfig.vars, ...bindings } as unknown as Cloudflare.Env;

function executionContext(): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      p.catch(() => {});
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

export const exports = {
  default: {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const entry = await loadEntry();
      const handler = entry.default as { fetch(r: Request, e: unknown, c: ExecutionContext): Promise<Response> };
      return handler.fetch(new Request(input, init), env, executionContext());
    },
  },
};
