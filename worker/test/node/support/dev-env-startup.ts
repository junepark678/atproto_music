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
  /** Test-only explicit owner hook, called immediately for each returned public server. */
  onCaptured?: (kind: Kind, server: StartupServer, roots: string[]) => void;
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
  attempt?: DevEnvAttempt;
  startError?: unknown;
  restoreStart: () => void;
  restoreContext: () => void;
  contextCleanupSucceeded?: boolean;
}

/** Attempt every independently owned fixture even when an earlier close fails. */
export async function closeOwnedDevEnv(...fixtures: Array<{ close(): Promise<void> } | undefined>): Promise<void> {
  const errors: unknown[] = [];
  for (const fixture of fixtures) {
    try {
      await fixture?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw aggregate('dev-env fixture cleanup failed', errors);
}

async function cleanupFailedServer(kind: Kind, captured: CapturedServer): Promise<void> {
  const { server } = captured;
  const errors: unknown[] = [];
  if (kind === 'plc') {
    try {
      await server.destroy();
    } catch (error) {
      if (codeIs(error, 'ERR_SERVER_NOT_RUNNING') && server.server?.listening !== true) {
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
      // Public PDS.destroy resolves only after its finally-await of ctx.destroy.
      // The external owner may have thrown before our tracker was installed.
      captured.contextCleanupSucceeded = true;
    } catch (error) {
      // PDS.destroy() calls ctx.destroy() in a finally block. Its terminator
      // reports this exact condition when start() failed before listening.
      if (!(codeIs(error, 'ERR_SERVER_NOT_RUNNING') && server.server?.listening !== true)) {
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
          const record: CapturedServer = {
            server,
            roots: [],
            restoreStart: () => {},
            restoreContext: () => {},
          };
          // Public factories have returned a concrete owned object. Track it
          // before any shape/descriptor checks so malformed test doubles still
          // take the ordinary partial-resource cleanup path.
          captured.push(record);
          const env = args[0] as
            | { dataDirectory?: unknown; blobstoreDiskLocation?: unknown; blobstoreDiskTmpLocation?: unknown }
            | undefined;
          if (kind === 'pds') {
            record.roots.push(
              ...[env?.dataDirectory, env?.blobstoreDiskLocation, env?.blobstoreDiskTmpLocation].filter(
                (value): value is string => typeof value === 'string',
              ),
            );
          }
          // A closed external owner may reject this returned handle. Populate
          // its owned roots first so the internal fallback can still dispose it.
          options.onCaptured?.(kind, server, record.roots);
          const port = portOf(kind, server);
          const attempt: DevEnvAttempt =
            kind === 'plc'
              ? { kind, attempt: attemptNumber, port, server: server as TestPlc['server'] }
              : { kind, attempt: attemptNumber, port, server: server as TestPds['server'] };
          record.attempt = attempt;
          const ownStartDescriptor = Object.getOwnPropertyDescriptor(server, 'start');
          const prototypeStart = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(server), 'start');
          const startDescriptor = ownStartDescriptor ?? prototypeStart;
          const originalStart = startDescriptor?.value as StartFunction;
          if (typeof originalStart !== 'function' || !startDescriptor) {
            throw new Error(`dev-env public ${kind} start descriptor is unavailable`);
          }
          const guardedStart = async function (this: StartupServer, ...startArgs: unknown[]) {
            await options.beforeStart?.(attempt);
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
        // If PDS.fromEnv rejects before returning its public server handle,
        // there is no public context available for safe teardown. Preserve
        // that error and fail once; cleanup of undisclosed dependency state is
        // outside the ownership guarantees of this seam.
        if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          return Promise.resolve(result).then((server: unknown) => capture(server as StartupServer));
        }
        return capture(result as StartupServer);
      };
      Object.defineProperty(factoryClass, factoryName, descriptorWithValue(originalFactoryDescriptor, guardedFactory));
      let result: T | undefined;
      let failure: unknown;
      const restoreErrors: unknown[] = [];
      try {
        result = await creationContext.run(token, factory);
      } catch (error) {
        failure = error;
      } finally {
        try {
          restoreDescriptor(factoryClass, factoryName, originalFactoryDescriptor);
        } catch (error) {
          restoreErrors.push(error);
        }
        for (const item of captured) {
          try {
            item.restoreStart();
          } catch (error) {
            restoreErrors.push(error);
          }
        }
      }

      if (restoreErrors.length > 0) {
        const cleanupErrors: unknown[] = [];
        for (const item of [...captured].reverse()) {
          try {
            await cleanupFailedServer(kind, item);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        for (const item of captured) {
          try {
            item.restoreContext();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        throw new AggregateError(
          [...(failure === undefined ? [] : [failure]), ...restoreErrors, ...cleanupErrors],
          `dev-env ${kind} descriptor restoration failed`,
        );
      }

      if (result) {
        if (kind === 'pds' && captured[0]) {
          const record = captured[0];
          const ownCloseDescriptor = Object.getOwnPropertyDescriptor(result, 'close');
          const originalClose = result.close;
          try {
            Object.defineProperty(result, 'close', {
              configurable: true,
              enumerable: ownCloseDescriptor?.enumerable ?? false,
              writable: true,
              value: async () => {
                const errors: unknown[] = [];
                try {
                  try {
                    await originalClose.call(result);
                  } catch (error) {
                    errors.push(error);
                  }
                  // Never unlink a context's storage until its destructor really completed.
                  if (record.contextCleanupSucceeded) {
                    for (const root of record.roots) {
                      try {
                        await rm(root, { recursive: true, force: true });
                      } catch (error) {
                        errors.push(error);
                      }
                    }
                  }
                } finally {
                  for (const item of captured) {
                    try {
                      item.restoreContext();
                    } catch (error) {
                      errors.push(error);
                    }
                  }
                  try {
                    restoreDescriptor(result, 'close', ownCloseDescriptor);
                  } catch (error) {
                    errors.push(error);
                  }
                }
                if (errors.length > 0) throw aggregate('dev-env PDS cleanup failed', errors);
              },
            });
          } catch (installError) {
            const cleanupErrors: unknown[] = [];
            for (const item of [...captured].reverse()) {
              try {
                await cleanupFailedServer(kind, item);
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            for (const item of captured) {
              try {
                item.restoreContext();
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            throw new AggregateError([installError, ...cleanupErrors], 'dev-env PDS close guard installation failed');
          }
        } else {
          for (const item of captured) item.restoreContext();
        }
        return result;
      }

      const primary = captured.at(-1);
      // PDS.fromEnv can reject before returning its public server handle. The
      // hidden context is unavailable at this seam; preserve the error, fail
      // once, and make no claim to clean dependency-internal state.
      if (!primary) throw failure;
      const cleanupErrors: unknown[] = [];
      try {
        // A callback may create more than one public server in the same ALS
        // scope. Reap every captured object, newest first, even after errors.
        for (const item of [...captured].reverse()) {
          try {
            await cleanupFailedServer(kind, item);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      } finally {
        for (const item of captured) {
          try {
            item.restoreStart();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            item.restoreContext();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([failure, ...cleanupErrors], `dev-env ${kind} startup and cleanup failed`);
      }
      if (!primary.attempt) throw failure;
      await options.afterCleanup?.(primary.attempt, failure);
      if (attemptNumber >= maxAttempts || primary.startError !== failure || !codeIs(failure, 'EADDRINUSE')) {
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

export async function createOwnedTestPds(
  options: Parameters<typeof TestPds.create>[0],
  overrides?: Parameters<typeof TestPds.create>[1],
  startup: DevEnvStartupOptions = {},
): Promise<TestPds> {
  // The dependency allocates its own default temporary roots. Explicit paths
  // belong to the caller, so refuse them before TestPds.create allocates anything.
  if (['dataDirectory', 'blobstoreDiskLocation', 'blobstoreDiskTmpLocation'].some((key) => key in options)) {
    throw new TypeError('owned dev-env PDS does not accept storage directory overrides');
  }
  return createOwned('pds', () => TestPds.create(options, overrides), startup);
}
