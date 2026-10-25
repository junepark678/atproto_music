// `cloudflare:test` for the worker-modules suites on Node (ADR 0005 §15.1,
// N2-02). worker/vitest.modules.config.ts aliases the module id to this file;
// N4-04 to N4-06 replace the calls with the Node harness and N7-01 deletes the
// shim. TEST-ONLY. The objects, their storage and `env` live in
// cloudflare-workers-shim.ts (`cloudflare:workers`).
//
// - `runInDurableObject(stub, fn)` constructs the object if needed, waits for
//   its blockConcurrencyWhile gates and calls `fn(instance, state)`; `state`
//   has `id`, `storage` (the DO-storage facade over node:sqlite,
//   do-storage-facade.ts), `blockConcurrencyWhile` and `waitUntil`.
// - `runDurableObjectAlarm(stub)` runs and removes the object's alarm if one
//   is set: it clears the alarm, then calls the instance's `alarm()`, and
//   resolves true; with no alarm set it resolves false and calls nothing.
// - `evictDurableObject(stub)` closes the object's connection and drops the
//   instance (rejecting, as workerd does, when the object is not running); the
//   next delivery reopens the same database file and constructs a new
//   instance. `evictAllDurableObjects()` evicts every running object.
// - `listDurableObjectIds(namespace)` lists the objects whose storage exists
//   in this test file, in creation order.
// - `createExecutionContext`, `waitOnExecutionContext` and
//   `createScheduledController` are plain in-process stand-ins.

import {
  evictObject,
  liveObject,
  type ShimDurableObjectNamespace,
  shimObject,
  shimObjects,
  stubId,
  env as workersEnv,
  exports as workersExports,
} from './cloudflare-workers-shim';

/** @deprecated as in workerd: use `env` from `cloudflare:workers`. */
export const env = workersEnv;

/** @deprecated as in workerd: use `exports.default.fetch` from `cloudflare:workers`. */
export const SELF = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => workersExports.default.fetch(input, init),
} as unknown as Fetcher;

export async function runInDurableObject<O, R>(
  stub: DurableObjectStub,
  callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
  const { instance, state } = await liveObject(stubId(stub));
  return callback(instance as O, state);
}

export async function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean> {
  const live = await liveObject(stubId(stub));
  const entry = shimObject(stubId(stub));
  if (entry.alarm.at === null) return false;
  entry.alarm.at = null;
  const alarm = live.instance.alarm;
  if (typeof alarm !== 'function') throw new TypeError('the Durable Object has no alarm() handler');
  await alarm.call(live.instance, { retryCount: 0, isRetry: false });
  return true;
}

export async function evictDurableObject(stub: DurableObjectStub): Promise<void> {
  const entry = shimObject(stubId(stub));
  if (entry.live === null) throw new Error('evictDurableObject: the Durable Object is not running');
  evictObject(entry);
}

export async function evictAllDurableObjects(): Promise<void> {
  for (const entry of shimObjects()) if (entry.live !== null) evictObject(entry);
}

export async function abortAllDurableObjects(): Promise<void> {
  await evictAllDurableObjects();
}

export async function listDurableObjectIds(namespace: DurableObjectNamespace): Promise<DurableObjectId[]> {
  const binding = (namespace as unknown as ShimDurableObjectNamespace).binding;
  return shimObjects(binding).map((o) => o.id as unknown as DurableObjectId);
}

const pending = new WeakMap<object, Array<Promise<unknown>>>();

export function createExecutionContext(): ExecutionContext {
  const promises: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
    props: {},
  };
  pending.set(ctx, promises);
  return ctx as unknown as ExecutionContext;
}

export async function waitOnExecutionContext(ctx: ExecutionContext): Promise<void> {
  const promises = pending.get(ctx);
  if (promises === undefined) throw new TypeError('waitOnExecutionContext needs a context from createExecutionContext');
  while (promises.length > 0) await Promise.allSettled(promises.splice(0));
}

export function createScheduledController(
  options: { scheduledTime?: Date | number; cron?: string } = {},
): ScheduledController {
  const at = options.scheduledTime;
  return {
    scheduledTime: at === undefined ? 0 : typeof at === 'number' ? at : at.getTime(),
    cron: options.cron ?? '',
    noRetry() {},
  } as ScheduledController;
}

export async function reset(): Promise<void> {
  for (const entry of shimObjects()) {
    const live = await liveObject(entry.id);
    await live.storage.deleteAll();
    evictObject(entry);
  }
}
