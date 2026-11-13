import { rm } from 'node:fs/promises';
import type { TestPds, TestPlc } from '@atproto/dev-env';
import { onTestFinished } from 'vitest';

type CapturedServer = TestPds['server'] | TestPlc['server'];
type CapturedKind = 'plc' | 'pds';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Per-test, LIFO cleanup with a fence against resources resolving after timeout. */
export class TestResourceOwner {
  #closed = false;
  #closing: Promise<void> | undefined;
  #entries: Array<() => Promise<void>> = [];
  #states = new WeakMap<object, { databaseClosed: boolean; contextDestroyed: boolean }>();

  get closed(): boolean {
    return this.#closed;
  }

  track<T>(resource: T, dispose: (resource: T) => Promise<void>): T {
    if (this.#closed) throw new Error('test resource owner is already closed');
    this.#entries.push(() => dispose(resource));
    return resource;
  }

  async acquire<T>(acquire: () => Promise<T>, dispose: (resource: T) => Promise<void>): Promise<T> {
    if (this.#closed) throw new Error('test resource owner is already closed');
    const resource = await acquire();
    if (this.#closed) {
      try {
        await dispose(resource);
      } catch (cleanupError) {
        throw new AggregateError([new Error('test resource resolved after its owner closed'), cleanupError]);
      }
      throw new Error('test resource resolved after its owner closed and was disposed');
    }
    this.#entries.push(() => dispose(resource));
    return resource;
  }

  defer(dispose: () => void | Promise<void>): void {
    if (this.#closed) throw new Error('test resource owner is already closed');
    this.#entries.push(async () => {
      await dispose();
    });
  }

  /** Own a public server handle even if its outer TestPds/TestPlc factory later rejects. */
  trackCaptured(kind: CapturedKind, server: CapturedServer, roots: string[]): void {
    if (this.#closed) throw new Error('test resource owner is already closed');
    const state = { databaseClosed: false, contextDestroyed: false };
    this.#states.set(server, state);
    let complete = false;
    const restores: Array<() => void> = [];

    if (kind === 'plc') {
      const plcServer = server as TestPlc['server'];
      const database = plcServer.ctx.db;
      const descriptor = Object.getOwnPropertyDescriptor(database, 'close');
      const original = database.close.bind(database);
      database.close = async () => {
        const result = await original();
        state.databaseClosed = true;
        return result;
      };
      restores.push(() => {
        if (descriptor) Object.defineProperty(database, 'close', descriptor);
        else Reflect.deleteProperty(database, 'close');
      });
    } else {
      const pdsServer = server as TestPds['server'];
      const context = pdsServer.ctx;
      const descriptor = Object.getOwnPropertyDescriptor(context, 'destroy');
      const original = context.destroy.bind(context);
      Object.defineProperty(context, 'destroy', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        writable: true,
        value: async () => {
          const result = await original();
          state.contextDestroyed = true;
          return result;
        },
      });
      restores.push(() => {
        if (descriptor) Object.defineProperty(context, 'destroy', descriptor);
        else Reflect.deleteProperty(context, 'destroy');
      });
    }

    for (const restore of restores) this.defer(restore);
    this.defer(async () => {
      if (complete) return;
      const errors: unknown[] = [];
      if (kind === 'plc') {
        const plcServer = server as TestPlc['server'];
        try {
          await plcServer.destroy();
        } catch (error) {
          if (!(hasCode(error, 'ERR_SERVER_NOT_RUNNING') && plcServer.server?.listening !== true)) errors.push(error);
        }
        if (!state.databaseClosed) {
          try {
            await plcServer.ctx.db.close();
            state.databaseClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
      } else {
        const pdsServer = server as TestPds['server'];
        if (!(state.contextDestroyed && pdsServer.server?.listening !== true)) {
          try {
            await pdsServer.destroy();
          } catch (error) {
            if (!(hasCode(error, 'ERR_SERVER_NOT_RUNNING') && pdsServer.server?.listening !== true)) errors.push(error);
          }
        }
        if (state.contextDestroyed) {
          for (const root of roots) {
            try {
              await rm(root, { recursive: true, force: true });
            } catch (error) {
              errors.push(error);
            }
          }
        } else {
          errors.push(new Error('owned PDS context destruction did not complete'));
        }
      }
      if (errors.length) throw new AggregateError(errors, `test-owned ${kind} cleanup failed`);
      complete = true;
    });
  }

  contextWasDestroyed(server: object): boolean {
    return this.#states.get(server)?.contextDestroyed ?? false;
  }

  databaseWasClosed(server: object): boolean {
    return this.#states.get(server)?.databaseClosed ?? false;
  }

  async disposeNow(dispose: () => Promise<void>): Promise<void> {
    await dispose();
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      const errors: unknown[] = [];
      for (const dispose of this.#entries.reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'test-owned resource cleanup failed');
    })();
    return this.#closing;
  }
}

/** Register the cleanup hook synchronously before the caller's first await. */
export function ownTestResources(): TestResourceOwner {
  const owner = new TestResourceOwner();
  onTestFinished(() => owner.close());
  return owner;
}
