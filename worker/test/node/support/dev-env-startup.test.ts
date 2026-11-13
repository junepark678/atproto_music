import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PDS, TestPds, TestPlc } from '@atproto/dev-env';
import { PlcServer } from '@did-plc/server';
import { describe, expect, it, vi } from 'vitest';
import {
  closeOwnedDevEnv,
  createOwnedTestPds,
  createOwnedTestPlc,
  type DevEnvAttempt,
  type DevEnvStartupOptions,
} from './dev-env-startup';
import { ownTestResources, type TestResourceOwner } from './test-resource-owner';

function ownedStartup(owner: TestResourceOwner, options: DevEnvStartupOptions = {}): DevEnvStartupOptions {
  return {
    ...options,
    onCaptured: (kind, server, roots) => {
      owner.trackCaptured(kind, server, roots);
      options.onCaptured?.(kind, server, roots);
    },
  };
}

async function closeIfListening(server: Server): Promise<void> {
  if (server.listening) await close(server);
}

async function occupy(owner: TestResourceOwner, port: number): Promise<Server> {
  const blocker = createServer();
  owner.track(blocker, closeIfListening);
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  if (owner.closed) {
    await owner.disposeNow(() => closeIfListening(blocker));
    throw new Error('test owner closed while blocker was listening');
  }
  return blocker;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function pdsRoots(attempt: Extract<DevEnvAttempt, { kind: 'pds' }>): string[] {
  const cfg = attempt.server.ctx.cfg;
  const blobstoreRoots = cfg.blobstore.provider === 'disk' ? [cfg.blobstore.location, cfg.blobstore.tempLocation] : [];
  return [dirname(cfg.db.accountDbLoc), ...blobstoreRoots].filter((path): path is string => typeof path === 'string');
}

async function isMissing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

const pdsOptions = (plc: TestPlc): Parameters<typeof createOwnedTestPds>[0] => ({
  didPlcUrl: plc.url,
  hostname: 'dev-env-port-retry.test',
});

describe('owned dev-env startup', () => {
  it('disposes a resource that resolves after its test owner closes', async () => {
    const owner = ownTestResources();
    let resolveResource!: (server: Server) => void;
    const acquisition = owner.acquire(
      () =>
        new Promise<Server>((resolve) => {
          resolveResource = resolve;
        }),
      closeIfListening,
    );
    await owner.close();
    const lateServer = createServer();
    await new Promise<void>((resolve, reject) => {
      lateServer.once('error', reject);
      lateServer.listen(0, '127.0.0.1', resolve);
    });
    resolveResource(lateServer);
    await expect(acquisition).rejects.toThrow('resolved after its owner closed');
    expect(lateServer.listening).toBe(false);
  });

  it('removes confirmed-safe roots when a public PDS return arrives after its owner closed', async () => {
    const owner = ownTestResources();
    const descriptor = Object.getOwnPropertyDescriptor(PDS, 'fromEnv')!;
    const originalFactory = descriptor.value as typeof PDS.fromEnv;
    let release!: () => void;
    const returned = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allocated!: () => void;
    const allocatedPublic = new Promise<void>((resolve) => {
      allocated = resolve;
    });
    let captured: TestPds['server'] | undefined;
    let roots: string[] = [];
    let destroyed = 0;
    Object.defineProperty(PDS, 'fromEnv', {
      ...descriptor,
      value: async function (this: unknown, ...args: Parameters<typeof PDS.fromEnv>) {
        const server = await Reflect.apply(originalFactory, this, args);
        captured = server;
        roots = pdsRoots({ kind: 'pds', attempt: 1, port: server.ctx.cfg.service.port, server });
        const destroy = server.ctx.destroy.bind(server.ctx);
        server.ctx.destroy = async () => {
          await destroy();
          destroyed += 1;
        };
        allocated();
        await returned;
        return server;
      },
    });
    const outcome = owner
      .acquire(
        () =>
          createOwnedTestPds(
            { didPlcUrl: 'http://127.0.0.1:1', hostname: 'late-public.test' },
            undefined,
            ownedStartup(owner),
          ),
        (fixture) => fixture.close(),
      )
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    try {
      await Promise.race([
        allocatedPublic,
        outcome.then((result) => {
          if (result.error) throw result.error;
        }),
      ]);
      await owner.close();
      release();
      const result = await outcome;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('owner is already closed');
      expect(captured?.server?.listening ?? false).toBe(false);
      expect(destroyed).toBe(1);
      // Measure before the independent exact-resource fallback below.
      for (const root of roots) expect(await isMissing(root)).toBe(true);
    } finally {
      release();
      await outcome;
      Object.defineProperty(PDS, 'fromEnv', descriptor);
      if (captured && destroyed === 0) await captured.destroy();
      if (destroyed > 0) for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans a returned PLC server before rejecting a malformed public port', async () => {
    const owner = ownTestResources();
    const factoryDescriptor = Object.getOwnPropertyDescriptor(PlcServer, 'create')!;
    const originalFactory = factoryDescriptor.value as typeof PlcServer.create;
    let dbCloseCalls = 0;
    owner.defer(() => {
      Object.defineProperty(PlcServer, 'create', factoryDescriptor);
    });
    Object.defineProperty(PlcServer, 'create', {
      ...factoryDescriptor,
      value: function (this: unknown, ...args: Parameters<typeof PlcServer.create>) {
        const server = Reflect.apply(originalFactory, this, args);
        const closeDb = server.ctx.db.close.bind(server.ctx.db);
        server.ctx.db.close = async () => {
          dbCloseCalls += 1;
          return closeDb();
        };
        Object.defineProperty(server.ctx, 'port', { configurable: true, value: 'invalid' });
        return server;
      },
    });
    const patchedDescriptor = Object.getOwnPropertyDescriptor(PlcServer, 'create');
    try {
      await expect(createOwnedTestPlc({}, ownedStartup(owner))).rejects.toThrow('invalid startup port');
      expect(dbCloseCalls).toBe(1);
      expect(Object.getOwnPropertyDescriptor(PlcServer, 'create')).toEqual(patchedDescriptor);
    } finally {
      await owner.close();
    }
  });

  it('cleans a returned PLC server when its public start descriptor is missing', async () => {
    const owner = ownTestResources();
    const factoryDescriptor = Object.getOwnPropertyDescriptor(PlcServer, 'create')!;
    const originalFactory = factoryDescriptor.value as typeof PlcServer.create;
    let dbCloseCalls = 0;
    owner.defer(() => {
      Object.defineProperty(PlcServer, 'create', factoryDescriptor);
    });
    Object.defineProperty(PlcServer, 'create', {
      ...factoryDescriptor,
      value: function (this: unknown, ...args: Parameters<typeof PlcServer.create>) {
        const server = Reflect.apply(originalFactory, this, args);
        const closeDb = server.ctx.db.close.bind(server.ctx.db);
        server.ctx.db.close = async () => {
          dbCloseCalls += 1;
          return closeDb();
        };
        Object.defineProperty(server, 'start', { configurable: true, value: undefined });
        return server;
      },
    });
    const patchedDescriptor = Object.getOwnPropertyDescriptor(PlcServer, 'create');
    try {
      await expect(createOwnedTestPlc({}, ownedStartup(owner))).rejects.toThrow('start descriptor is unavailable');
      expect(dbCloseCalls).toBe(1);
      expect(Object.getOwnPropertyDescriptor(PlcServer, 'create')).toEqual(patchedDescriptor);
    } finally {
      await owner.close();
    }
  });

  it('preserves a PDS.fromEnv rejection before any public context handle exists', async () => {
    const owner = ownTestResources();
    const factoryDescriptor = Object.getOwnPropertyDescriptor(PDS, 'fromEnv')!;
    const error = new Error('controlled pre-return PDS factory failure');
    const roots: string[] = [];
    let calls = 0;
    owner.defer(() => {
      Object.defineProperty(PDS, 'fromEnv', factoryDescriptor);
    });
    Object.defineProperty(PDS, 'fromEnv', {
      ...factoryDescriptor,
      value: async function (this: unknown, ...args: Parameters<typeof PDS.fromEnv>) {
        calls += 1;
        const env = args[0];
        for (const root of [env?.dataDirectory, env?.blobstoreDiskLocation, env?.blobstoreDiskTmpLocation]) {
          if (typeof root === 'string') {
            roots.push(root);
            owner.defer(() => rm(root, { recursive: true, force: true }));
          }
        }
        // This controlled public-factory stub rejects before creating a PDS
        // context, so the exact paths above are safe for the test owner to reap.
        throw error;
      },
    });
    const patchedDescriptor = Object.getOwnPropertyDescriptor(PDS, 'fromEnv');
    await expect(
      createOwnedTestPds(
        { didPlcUrl: 'http://127.0.0.1:1', hostname: 'pre-return.test' },
        undefined,
        ownedStartup(owner),
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(roots.length).toBeGreaterThan(0);
    expect(Object.getOwnPropertyDescriptor(PDS, 'fromEnv')).toEqual(patchedDescriptor);
    await owner.close();
    expect(Object.getOwnPropertyDescriptor(PDS, 'fromEnv')).toEqual(factoryDescriptor);
    for (const root of roots) expect(await isMissing(root)).toBe(true);
  });

  it('cleans every PLC captured in the same async creation scope', async () => {
    const owner = ownTestResources();
    const created: Array<{ server: TestPlc['server']; closeCalls: number }> = [];
    let nested = false;
    const expected = new Error('fail after nested server creation');
    await expect(
      createOwnedTestPlc(
        {},
        ownedStartup(owner, {
          beforeStart: async ({ server }) => {
            if (!('db' in server.ctx)) throw new Error('expected PLC context');
            const record = { server: server as TestPlc['server'], closeCalls: 0 };
            created.push(record);
            const closeDb = server.ctx.db.close.bind(server.ctx.db);
            server.ctx.db.close = async () => {
              record.closeCalls += 1;
              return closeDb();
            };
            if (!nested) {
              nested = true;
              await TestPlc.create({});
              throw expected;
            }
          },
        }),
      ),
    ).rejects.toBe(expected);
    expect(created).toHaveLength(2);
    expect(created.map(({ closeCalls }) => closeCalls)).toEqual([1, 1]);
    expect(created.every(({ server }) => !server.server?.listening)).toBe(true);
    await owner.close();
  });

  it('does not capture a foreign PLC created while the public factory guard is installed', async () => {
    const owner = ownTestResources();
    const captured: TestPlc['server'][] = [];
    let signalStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const ownedCreate = createOwnedTestPlc(
      {},
      ownedStartup(owner, {
        onCaptured: (_kind, server) => captured.push(server as TestPlc['server']),
        beforeStart: async () => {
          signalStarted();
          await waiting;
        },
      }),
    );
    await started;
    const foreign = await owner.acquire(
      () => TestPlc.create({}),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    releaseStart();
    const owned = await owner.acquire(
      () => ownedCreate,
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(owned.server);
    expect(foreign.server.server?.listening).toBe(true);
  });

  it('continues cleaning nested captures after one captured cleanup fails', async () => {
    const owner = ownTestResources();
    const created: Array<{ server: TestPlc['server']; closeCalls: number }> = [];
    const primary = new Error('controlled nested startup failure');
    const cleanup = new Error('controlled outer database cleanup failure');
    let nested = false;
    await expect(
      createOwnedTestPlc(
        {},
        ownedStartup(owner, {
          beforeStart: async ({ server }) => {
            const plcServer = server as TestPlc['server'];
            const shouldFailClose = created.length === 0;
            const record = { server: plcServer, closeCalls: 0 };
            created.push(record);
            const database = plcServer.ctx.db;
            const descriptor = Object.getOwnPropertyDescriptor(database, 'close');
            owner.defer(() => {
              if (descriptor) Object.defineProperty(database, 'close', descriptor);
              else Reflect.deleteProperty(database, 'close');
            });
            const originalClose = database.close.bind(database);
            database.close = async () => {
              record.closeCalls += 1;
              await originalClose();
              if (shouldFailClose) throw cleanup;
            };
            if (!nested) {
              nested = true;
              await TestPlc.create({});
              throw primary;
            }
          },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregateError = error as AggregateError;
      expect(aggregateError.errors[0]).toBe(primary);
      expect(aggregateError.errors[1]).toBeInstanceOf(AggregateError);
      expect((aggregateError.errors[1] as AggregateError).errors).toContain(cleanup);
      return true;
    });
    expect(created).toHaveLength(2);
    expect(created.map(({ closeCalls }) => closeCalls)).toEqual([2, 1]);
    expect(created.every(({ server }) => !server.server?.listening)).toBe(true);
    await owner.close();
  });

  it.each(['dataDirectory', 'blobstoreDiskLocation', 'blobstoreDiskTmpLocation'] as const)(
    'rejects caller storage override %s before the dependency allocates resources',
    async (field) => {
      const owner = ownTestResources();
      const root = await owner.acquire(
        () => mkdtemp(join(tmpdir(), 'atmusic-caller-storage-')),
        (path) => rm(path, { recursive: true, force: true }),
      );
      const marker = join(root, 'caller-marker');
      await writeFile(marker, 'caller-owned');
      const factory = vi.spyOn(TestPds, 'create').mockRejectedValue(new Error('dependency factory was reached'));
      owner.defer(() => factory.mockRestore());
      let starts = 0;
      try {
        await expect(
          createOwnedTestPds({ didPlcUrl: 'http://127.0.0.1:1', hostname: 'storage.test', [field]: root }, undefined, {
            beforeStart: () => {
              starts += 1;
              throw new Error('must not start');
            },
          }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(factory).not.toHaveBeenCalled();
        expect(starts).toBe(0);
        expect(await readFile(marker, 'utf8')).toBe('caller-owned');
      } finally {
        await owner.close();
      }
    },
  );

  it('closes a real PLC after an earlier fixture fails and preserves every close error', async () => {
    const owner = ownTestResources();
    const first = new Error('first close failed');
    const last = new Error('last close failed');
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    let lastAttempted = false;
    try {
      await expect(
        closeOwnedDevEnv(
          {
            close: async () => {
              throw first;
            },
          },
          plc,
          {
            close: async () => {
              lastAttempted = true;
              throw last;
            },
          },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([first, last]);
        return true;
      });
      expect(lastAttempted).toBe(true);
      expect(plc.server.server?.listening).toBe(false);
    } finally {
      await owner.close();
    }
  });

  it('cleans a PLC after a real occupied-port bind and retries on a fresh autoport', async () => {
    const owner = ownTestResources();
    const dbCloseCalls: number[] = [];
    const blockers: Server[] = [];
    const attempts: number[] = [];
    const plc = await owner.acquire(
      () =>
        createOwnedTestPlc(
          {},
          ownedStartup(owner, {
            beforeStart: async ({ attempt, port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              attempts.push(port);
              const database = (server as TestPlc['server']).ctx.db;
              const closeDescriptor = Object.getOwnPropertyDescriptor(database, 'close');
              const originalClose = database.close.bind(database);
              owner.defer(() => {
                if (closeDescriptor) Object.defineProperty(database, 'close', closeDescriptor);
                else Reflect.deleteProperty(database, 'close');
              });
              database.close = async () => {
                dbCloseCalls.push(attempt);
                return originalClose();
              };
              if (attempt === 1) {
                blockers.push(await occupy(owner, port));
              }
            },
            afterCleanup: async ({ port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              expect(server.server?.listening).toBe(false);
              expect(dbCloseCalls).toEqual([1]);
              expect(blockers[0]?.listening).toBe(true);
              await close(blockers[0]!);
              expect(port).toBe(attempts[0]);
            },
          }),
        ),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    try {
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).not.toBe(attempts[0]);
      expect(plc.server.server?.listening).toBe(true);
    } finally {
      await owner.close();
      expect(plc.server.server?.listening).toBe(false);
      expect(dbCloseCalls).toEqual([1, 2]);
    }
  });

  it('cleans PDS context and temporary roots before retrying a real occupied port', async () => {
    const owner = ownTestResources();
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    let blocker: Server | undefined;
    const ports: number[] = [];
    let contextDestroyed = false;
    try {
      const pds = await owner.acquire(
        () =>
          createOwnedTestPds(
            pdsOptions(plc),
            undefined,
            ownedStartup(owner, {
              beforeStart: async ({ attempt, port, server }) => {
                if (!('cfg' in server.ctx)) throw new Error('expected PDS context');
                ports.push(port);
                if (attempt === 1) {
                  const destroyDescriptor = Object.getOwnPropertyDescriptor(server.ctx, 'destroy');
                  owner.defer(() => {
                    if (destroyDescriptor) Object.defineProperty(server.ctx, 'destroy', destroyDescriptor);
                    else Reflect.deleteProperty(server.ctx, 'destroy');
                  });
                  const originalDestroy = server.ctx.destroy.bind(server.ctx);
                  server.ctx.destroy = async () => {
                    await originalDestroy();
                    contextDestroyed = true;
                  };
                  blocker = await occupy(owner, port);
                }
              },
              afterCleanup: async (attempt, error) => {
                if (attempt.kind !== 'pds') throw new Error('expected PDS attempt');
                expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
                expect(contextDestroyed).toBe(true);
                expect(attempt.server.server?.listening).toBe(false);
                expect(blocker?.listening).toBe(true);
                for (const root of pdsRoots(attempt)) expect(await isMissing(root)).toBe(true);
                await close(blocker!);
              },
            }),
          ),
        (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
      );
      expect(ports).toHaveLength(2);
      expect(ports[1]).not.toBe(ports[0]);
      expect(pds.server.server?.listening).toBe(true);
      await pds.close();
      expect(pds.server.server?.listening).toBe(false);
      for (const root of pdsRoots({ kind: 'pds', attempt: 2, port: pds.port, server: pds.server })) {
        expect(await isMissing(root)).toBe(true);
      }
    } finally {
      await owner.close();
    }
  });

  it('preserves a non-collision error by identity and invokes the factory only once', async () => {
    const owner = ownTestResources();
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    const error = Object.assign(new Error('setup failed'), { code: 'EACCES' });
    let attempts = 0;
    try {
      await expect(
        createOwnedTestPds(
          pdsOptions(plc),
          undefined,
          ownedStartup(owner, {
            beforeStart: () => {
              attempts += 1;
              throw error;
            },
          }),
        ),
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    } finally {
      await owner.close();
    }
  });

  it('does not retry a string-only collision or a wrapped cleanup error', async () => {
    const owner = ownTestResources();
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    let stringAttempts = 0;
    let cleanupAttempts = 0;
    const noCode = new Error('EADDRINUSE');
    const cleanupFailure = new Error('cleanup failed');
    try {
      await expect(
        createOwnedTestPds(
          pdsOptions(plc),
          undefined,
          ownedStartup(owner, {
            beforeStart: () => {
              stringAttempts += 1;
              throw noCode;
            },
          }),
        ),
      ).rejects.toBe(noCode);
      expect(stringAttempts).toBe(1);

      await expect(
        createOwnedTestPlc(
          {},
          ownedStartup(owner, {
            beforeStart: async ({ attempt, port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              if (attempt === 1) {
                const database = (server as TestPlc['server']).ctx.db;
                const closeDescriptor = Object.getOwnPropertyDescriptor(database, 'close');
                const originalClose = database.close.bind(database);
                owner.defer(() => {
                  if (closeDescriptor) Object.defineProperty(database, 'close', closeDescriptor);
                  else Reflect.deleteProperty(database, 'close');
                });
                database.close = async () => {
                  await originalClose();
                  cleanupAttempts += 1;
                  throw cleanupFailure;
                };
                await occupy(owner, port);
              }
            },
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AggregateError);
        const errors = (error as AggregateError).errors;
        expect(errors[0]).toMatchObject({ code: 'EADDRINUSE' });
        expect((errors[1] as AggregateError).errors).toContain(cleanupFailure);
        return true;
      });
      expect(cleanupAttempts).toBe(1);
    } finally {
      await owner.close();
    }
  });

  it('caps actual collisions at three attempts and preserves explicit-port fail-fast behavior', async () => {
    const owner = ownTestResources();
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    const blockers: Server[] = [];
    const ports: number[] = [];
    try {
      await expect(
        createOwnedTestPds(
          pdsOptions(plc),
          undefined,
          ownedStartup(owner, {
            beforeStart: async ({ port, server }) => {
              if (!('cfg' in server.ctx)) throw new Error('expected PDS context');
              ports.push(port);
              blockers.push(await occupy(owner, port));
            },
            afterCleanup: async (attempt) => {
              if (attempt.kind !== 'pds') throw new Error('expected PDS attempt');
              expect(attempt.server.server?.listening).toBe(false);
              for (const root of pdsRoots(attempt)) expect(await isMissing(root)).toBe(true);
              const blocker = blockers.at(-1)!;
              await close(blocker);
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(ports).toHaveLength(3);
      expect(new Set(ports).size).toBe(3);

      const plcPorts: number[] = [];
      const plcBlockers: Server[] = [];
      const plcDbCloseCalls: number[] = [];
      await expect(
        createOwnedTestPlc(
          {},
          ownedStartup(owner, {
            beforeStart: async ({ attempt, port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              const database = (server as TestPlc['server']).ctx.db;
              const closeDescriptor = Object.getOwnPropertyDescriptor(database, 'close');
              const originalClose = database.close.bind(database);
              owner.defer(() => {
                if (closeDescriptor) Object.defineProperty(database, 'close', closeDescriptor);
                else Reflect.deleteProperty(database, 'close');
              });
              database.close = async () => {
                plcDbCloseCalls.push(attempt);
                return originalClose();
              };
              plcPorts.push(port);
              plcBlockers.push(await occupy(owner, port));
            },
            afterCleanup: async (attempt) => {
              if (attempt.kind !== 'plc') throw new Error('expected PLC attempt');
              expect(attempt.server.server?.listening).toBe(false);
              expect(plcDbCloseCalls).toEqual(Array.from({ length: attempt.attempt }, (_, index) => index + 1));
              await close(plcBlockers.at(-1)!);
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(plcPorts).toHaveLength(3);
      expect(new Set(plcPorts).size).toBe(3);
      expect(plcBlockers.every((blocker) => !blocker.listening)).toBe(true);

      const fixedPortBlocker = owner.track(createServer(), closeIfListening);
      await new Promise<void>((resolve, reject) => {
        fixedPortBlocker.once('error', reject);
        fixedPortBlocker.listen(0, '127.0.0.1', resolve);
      });
      const fixedPort = (fixedPortBlocker.address() as { port: number }).port;
      let fixedAttempts = 0;
      await expect(
        createOwnedTestPlc(
          { port: fixedPort },
          ownedStartup(owner, {
            retryCollisions: false,
            beforeStart: () => {
              fixedAttempts += 1;
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(fixedAttempts).toBe(1);
      expect(fixedPortBlocker.listening).toBe(true);
      await close(fixedPortBlocker);
    } finally {
      await owner.close();
    }
  });

  it('restores public factory descriptors after sequential successes and failures', async () => {
    const owner = ownTestResources();
    const { PDS } = await import('@atproto/dev-env');
    const { PlcServer } = await import('@did-plc/server');
    const pdsFactory = Object.getOwnPropertyDescriptor(PDS, 'fromEnv');
    const plcFactory = Object.getOwnPropertyDescriptor(PlcServer, 'create');
    const plc = await owner.acquire(
      () => createOwnedTestPlc({}, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    const pds = await owner.acquire(
      () => createOwnedTestPds(pdsOptions(plc), undefined, ownedStartup(owner)),
      (fixture) => (fixture.server.server?.listening ? fixture.close() : Promise.resolve()),
    );
    await pds.close();
    await expect(
      createOwnedTestPlc(
        {},
        ownedStartup(owner, {
          beforeStart: () => {
            throw new Error('controlled non-collision');
          },
        }),
      ),
    ).rejects.toThrow('controlled non-collision');
    expect(Object.getOwnPropertyDescriptor(PDS, 'fromEnv')).toEqual(pdsFactory);
    expect(Object.getOwnPropertyDescriptor(PlcServer, 'create')).toEqual(plcFactory);
    await owner.close();
  });

  it('does not alter the externally listening collision blocker during PLC cleanup', async () => {
    const owner = ownTestResources();
    const blocker = owner.track(createServer(), closeIfListening);
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const port = (blocker.address() as { port: number }).port;
    let starts = 0;
    await expect(
      createOwnedTestPlc(
        { port },
        ownedStartup(owner, {
          retryCollisions: false,
          beforeStart: () => {
            starts += 1;
          },
          afterCleanup: (attempt) => {
            if (attempt.kind !== 'plc') throw new Error('expected PLC attempt');
            expect(attempt.port).toBe(port);
            expect(attempt.server.server?.listening).toBe(false);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(starts).toBe(1);
    expect(blocker.listening).toBe(true);
    expect(await new Promise<boolean>((resolve) => blocker.getConnections((error) => resolve(!error)))).toBe(true);
    await close(blocker);
  });
});
