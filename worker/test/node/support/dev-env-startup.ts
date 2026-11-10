import { AsyncLocalStorage } from 'node:async_hooks';
import { rm } from 'node:fs/promises';
import { PDS, TestPds, TestPlc } from '@atproto/dev-env';
import { PlcServer } from '@did-plc/server';

type Kind = 'plc' | 'pds';
type StartupServer = TestPds['server'] | TestPlc['server'];
type FactoryFunction = (...args: unknown[]) => unknown;
type StartFunction = (...args: unknown[]) => Promise<unknown>;

export type DevEnvAttempt =
  | {
      kind: 'plc';
      attempt: number;
      port: number;
      server: TestPlc['server'];
    }
  | {
      kind: 'pds';
      attempt: number;
      port: number;
      server: TestPds['server'];
    };

export interface DevEnvStartupOptions {
  /** Called immediately before the real public start() method. */
  beforeStart?: (attempt: DevEnvAttempt) => void | Promise<void>;
  /** Called after a failed attempt has been fully cleaned and before retry. */
  afterCleanup?: (attempt: DevEnvAttempt, error: unknown) => void | Promise<void>;
  /** False for e2e's explicitly configured endpoint ports. */
  retryCollisions?: boolean;
}

const creationContext = new AsyncLocalStorage<object>();
let creationQueue: Promise<void> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const previous = creationQueue;
  let release!: () => void;
  creationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(run).finally(release);
}

function codeIs(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function portOf(kind: Kind, server: StartupServer): number {
  const port =
    kind === 'plc' ? (server as TestPlc['server']).ctx.port : (server as TestPds['server']).ctx.cfg.service.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dev-env ${kind} server exposed an invalid startup port`);
  }
  return port;
}

function descriptorWithValue(descriptor: PropertyDescriptor, value: unknown): PropertyDescriptor {
  return { ...descriptor, value };
}

function restoreDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function aggregate(message: string, errors: unknown[]): Error {
  return errors.length === 1 ? (errors[0] as Error) : new AggregateError(errors, message);
}

interface CapturedServer {
  server: StartupServer;
  roots: string[];
  attempt: DevEnvAttempt;
  startError?: unknown;
  restoreStart: () => void;
  restoreContext: () => void;
  contextCleanupSucceeded?: boolean;
}

async function cleanupFailedServer(kind: Kind, captured: CapturedServer): Promise<void> {
  const { server } = captured;
  const errors: unknown[] = [];
  if (kind === 'plc') {
    try {
      await server.destroy();
    } catch (error) {
      if (codeIs(error, 'ERR_SERVER_NOT_RUNNING') && server.server?.listening === false) {
        // PlcServer.destroy() terminates before closing ctx.db. A failed bind
        // leaves its terminator non-running, so explicitly close the owned DB.
        try {
          await (server as TestPlc['server']).ctx.db.close();
        } catch (closeError) {
          errors.push(closeError);
        }
      } else {
        errors.push(error);
        // destroy() may have failed before reaching db.close(); make a best
        // effort to release our owned context, but never retry after this path.
        try {
          await (server as TestPlc['server']).ctx.db.close();
        } catch (closeError) {
          errors.push(closeError);
        }
      }
    }
  } else {
    try {
      await server.destroy();
    } catch (error) {
      // PDS.destroy() calls ctx.destroy() in a finally block. Its terminator
      // reports this exact condition when start() failed before listening.
      if (!(codeIs(error, 'ERR_SERVER_NOT_RUNNING') && server.server?.listening === false)) {
        errors.push(error);
      }
      if (!captured.contextCleanupSucceeded) {
        errors.push(new Error('PDS context cleanup did not complete successfully'));
      }
    }
  }
  if (kind === 'pds' && captured.contextCleanupSucceeded) {
    for (const root of captured.roots) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) throw aggregate(`dev-env ${kind} partial startup cleanup failed`, errors);
}

async function createOwned<T extends { close(): Promise<void> }>(
  kind: Kind,
  factory: () => Promise<T>,
  options: DevEnvStartupOptions = {},
): Promise<T> {
  return serialized(async () => {
    const retryCollisions = options.retryCollisions !== false;
    const maxAttempts = retryCollisions ? 3 : 1;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const token = {};
      const captured: CapturedServer[] = [];
      const factoryClass = kind === 'plc' ? PlcServer : PDS;
      const factoryName = kind === 'plc' ? 'create' : 'fromEnv';
      const originalFactoryDescriptor = Object.getOwnPropertyDescriptor(factoryClass, factoryName);
      const originalFactory = originalFactoryDescriptor?.value as FactoryFunction;
      if (typeof originalFactory !== 'function' || !originalFactoryDescriptor) {
        throw new Error(`dev-env public ${kind} factory descriptor is unavailable`);
      }
      const guardedFactory = function (this: unknown, ...args: unknown[]) {
        if (creationContext.getStore() !== token) return Reflect.apply(originalFactory, this, args);
        const capture = (server: StartupServer) => {
          const env = args[0] as
            | { dataDirectory?: unknown; blobstoreDiskLocation?: unknown; blobstoreDiskTmpLocation?: unknown }
            | undefined;
          const roots =
            kind === 'pds'
              ? [env?.dataDirectory, env?.blobstoreDiskLocation, env?.blobstoreDiskTmpLocation].filter(
                  (value): value is string => typeof value === 'string',
                )
              : [];
          const record: CapturedServer = {
            server,
            roots,
            attempt:
              kind === 'plc'
                ? { kind, attempt: attemptNumber, port: portOf(kind, server), server: server as TestPlc['server'] }
                : { kind, attempt: attemptNumber, port: portOf(kind, server), server: server as TestPds['server'] },
            restoreStart: () => {},
            restoreContext: () => {},
          };
          const ownStartDescriptor = Object.getOwnPropertyDescriptor(server, 'start');
          const prototypeStart = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(server), 'start');
          const startDescriptor = ownStartDescriptor ?? prototypeStart;
          const originalStart = startDescriptor?.value as StartFunction;
          if (typeof originalStart !== 'function' || !startDescriptor) {
            throw new Error(`dev-env public ${kind} start descriptor is unavailable`);
          }
          captured.push(record);
          const guardedStart = async function (this: StartupServer, ...startArgs: unknown[]) {
            await options.beforeStart?.(record.attempt);
            try {
              return await Reflect.apply(originalStart, this, startArgs);
            } catch (error) {
              record.startError = error;
              throw error;
            }
          };
          Object.defineProperty(server, 'start', descriptorWithValue(startDescriptor, guardedStart));
          record.restoreStart = () => restoreDescriptor(server, 'start', ownStartDescriptor);
          if (kind === 'pds') {
            const context = (server as TestPds['server']).ctx;
            const destroyDescriptor = Object.getOwnPropertyDescriptor(context, 'destroy');
            const originalDestroy = context.destroy.bind(context);
            Object.defineProperty(context, 'destroy', {
              configurable: true,
              enumerable: destroyDescriptor?.enumerable ?? false,
              writable: true,
              value: async () => {
                try {
                  const result = await originalDestroy();
                  record.contextCleanupSucceeded = true;
                  return result;
                } catch (error) {
                  record.contextCleanupSucceeded = false;
                  throw error;
                }
              },
            });
            const restoreContextDestroy = () => restoreDescriptor(context, 'destroy', destroyDescriptor);
            record.restoreContext = restoreContextDestroy;
          }
          return server;
        };
        const result = Reflect.apply(originalFactory, this, args);
        if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          return Promise.resolve(result).then((server: unknown) => capture(server as StartupServer));
        }
        return capture(result as StartupServer);
      };
      Object.defineProperty(factoryClass, factoryName, descriptorWithValue(originalFactoryDescriptor, guardedFactory));
      let result: T | undefined;
      let failure: unknown;
      try {
        result = await creationContext.run(token, factory);
      } catch (error) {
        failure = error;
      } finally {
        restoreDescriptor(factoryClass, factoryName, originalFactoryDescriptor);
        for (const item of captured) item.restoreStart();
      }

      if (result) {
        for (const item of captured) item.restoreContext();
        if (kind === 'pds' && captured[0]) {
          const record = captured[0];
          const ownCloseDescriptor = Object.getOwnPropertyDescriptor(result, 'close');
          const originalClose = result.close;
          Object.defineProperty(result, 'close', {
            configurable: true,
            enumerable: ownCloseDescriptor?.enumerable ?? false,
            writable: true,
            value: async () => {
              await originalClose.call(result);
              for (const root of record.roots) await rm(root, { recursive: true, force: true });
            },
          });
        }
        return result;
      }

      const partial = captured.at(-1);
      if (!partial) throw failure;
      let cleanupFailure: unknown;
      try {
        await cleanupFailedServer(kind, partial);
      } catch (error) {
        cleanupFailure = error;
      } finally {
        for (const item of captured) item.restoreContext();
      }
      if (cleanupFailure !== undefined) {
        throw new AggregateError([failure, cleanupFailure], `dev-env ${kind} startup and cleanup failed`);
      }
      await options.afterCleanup?.(partial.attempt, failure);
      if (attemptNumber >= maxAttempts || partial.startError !== failure || !codeIs(failure, 'EADDRINUSE')) {
        throw failure;
      }
    }
    throw new Error(`dev-env ${kind} startup exhausted its bounded attempts`);
  });
}

export function createOwnedTestPlc(
  options: Parameters<typeof TestPlc.create>[0],
  startup: DevEnvStartupOptions = {},
): Promise<TestPlc> {
  return createOwned('plc', () => TestPlc.create(options), startup);
}

export function createOwnedTestPds(
  options: Parameters<typeof TestPds.create>[0],
  overrides?: Parameters<typeof TestPds.create>[1],
  startup: DevEnvStartupOptions = {},
): Promise<TestPds> {
  return createOwned('pds', () => TestPds.create(options, overrides), startup);
}
