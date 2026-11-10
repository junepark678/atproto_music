import { access } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import type { TestPlc } from '@atproto/dev-env';
import { describe, expect, it } from 'vitest';
import { createOwnedTestPds, createOwnedTestPlc, type DevEnvAttempt } from './dev-env-startup';

async function occupy(port: number): Promise<Server> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
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
  it('cleans a PLC after a real occupied-port bind and retries on a fresh autoport', async () => {
    const dbCloseCalls: number[] = [];
    const blockers: Server[] = [];
    const attempts: number[] = [];
    const plc = await createOwnedTestPlc(
      {},
      {
        beforeStart: async ({ attempt, port, server }) => {
          if (!('db' in server.ctx)) throw new Error('expected PLC context');
          attempts.push(port);
          const originalClose = server.ctx.db.close.bind(server.ctx.db);
          server.ctx.db.close = async () => {
            dbCloseCalls.push(attempt);
            return originalClose();
          };
          if (attempt === 1) {
            blockers.push(await occupy(port));
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
      },
    );
    try {
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).not.toBe(attempts[0]);
      expect(plc.server.server?.listening).toBe(true);
    } finally {
      await plc.close();
      expect(plc.server.server?.listening).toBe(false);
      expect(dbCloseCalls).toEqual([1, 2]);
      for (const blocker of blockers) if (blocker.listening) await close(blocker);
    }
  });

  it('cleans PDS context and temporary roots before retrying a real occupied port', async () => {
    const plc = await createOwnedTestPlc({});
    let blocker: Server | undefined;
    const ports: number[] = [];
    let contextDestroyed = false;
    try {
      const pds = await createOwnedTestPds(pdsOptions(plc), undefined, {
        beforeStart: async ({ attempt, port, server }) => {
          if (!('cfg' in server.ctx)) throw new Error('expected PDS context');
          ports.push(port);
          if (attempt === 1) {
            const originalDestroy = server.ctx.destroy.bind(server.ctx);
            server.ctx.destroy = async () => {
              await originalDestroy();
              contextDestroyed = true;
            };
            blocker = await occupy(port);
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
      });
      expect(ports).toHaveLength(2);
      expect(ports[1]).not.toBe(ports[0]);
      expect(pds.server.server?.listening).toBe(true);
      await pds.close();
      expect(pds.server.server?.listening).toBe(false);
      for (const root of pdsRoots({ kind: 'pds', attempt: 2, port: pds.port, server: pds.server })) {
        expect(await isMissing(root)).toBe(true);
      }
    } finally {
      if (blocker?.listening) await close(blocker);
      await plc.close();
    }
  });

  it('preserves a non-collision error by identity and invokes the factory only once', async () => {
    const plc = await createOwnedTestPlc({});
    const error = Object.assign(new Error('setup failed'), { code: 'EACCES' });
    let attempts = 0;
    try {
      await expect(
        createOwnedTestPds(pdsOptions(plc), undefined, {
          beforeStart: () => {
            attempts += 1;
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    } finally {
      await plc.close();
    }
  });

  it('does not retry a string-only collision or a wrapped cleanup error', async () => {
    const plc = await createOwnedTestPlc({});
    let stringAttempts = 0;
    let cleanupAttempts = 0;
    const noCode = new Error('EADDRINUSE');
    const cleanupFailure = new Error('cleanup failed');
    let cleanupBlocker: Server | undefined;
    try {
      await expect(
        createOwnedTestPds(pdsOptions(plc), undefined, {
          beforeStart: () => {
            stringAttempts += 1;
            throw noCode;
          },
        }),
      ).rejects.toBe(noCode);
      expect(stringAttempts).toBe(1);

      await expect(
        createOwnedTestPlc(
          {},
          {
            beforeStart: async ({ attempt, port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              if (attempt === 1) {
                const originalClose = server.ctx.db.close.bind(server.ctx.db);
                server.ctx.db.close = async () => {
                  await originalClose();
                  cleanupAttempts += 1;
                  throw cleanupFailure;
                };
                cleanupBlocker = await occupy(port);
              }
            },
          },
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
      if (cleanupBlocker?.listening) await close(cleanupBlocker);
      await plc.close();
    }
  });

  it('caps actual collisions at three attempts and preserves explicit-port fail-fast behavior', async () => {
    const plc = await createOwnedTestPlc({});
    const blockers: Server[] = [];
    const ports: number[] = [];
    try {
      await expect(
        createOwnedTestPds(pdsOptions(plc), undefined, {
          beforeStart: async ({ port, server }) => {
            if (!('cfg' in server.ctx)) throw new Error('expected PDS context');
            ports.push(port);
            blockers.push(await occupy(port));
          },
          afterCleanup: async (attempt) => {
            if (attempt.kind !== 'pds') throw new Error('expected PDS attempt');
            expect(attempt.server.server?.listening).toBe(false);
            for (const root of pdsRoots(attempt)) expect(await isMissing(root)).toBe(true);
            const blocker = blockers.at(-1)!;
            await close(blocker);
          },
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(ports).toHaveLength(3);
      expect(new Set(ports).size).toBe(3);

      const plcPorts: number[] = [];
      const plcBlockers: Server[] = [];
      const plcDbCloseCalls: number[] = [];
      await expect(
        createOwnedTestPlc(
          {},
          {
            beforeStart: async ({ attempt, port, server }) => {
              if (!('db' in server.ctx)) throw new Error('expected PLC context');
              const originalClose = server.ctx.db.close.bind(server.ctx.db);
              server.ctx.db.close = async () => {
                plcDbCloseCalls.push(attempt);
                return originalClose();
              };
              plcPorts.push(port);
              plcBlockers.push(await occupy(port));
            },
            afterCleanup: async (attempt) => {
              if (attempt.kind !== 'plc') throw new Error('expected PLC attempt');
              expect(attempt.server.server?.listening).toBe(false);
              expect(plcDbCloseCalls).toEqual(Array.from({ length: attempt.attempt }, (_, index) => index + 1));
              await close(plcBlockers.at(-1)!);
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(plcPorts).toHaveLength(3);
      expect(new Set(plcPorts).size).toBe(3);
      expect(plcBlockers.every((blocker) => !blocker.listening)).toBe(true);

      const fixedPortBlocker = createServer();
      await new Promise<void>((resolve, reject) => {
        fixedPortBlocker.once('error', reject);
        fixedPortBlocker.listen(0, '127.0.0.1', resolve);
      });
      const fixedPort = (fixedPortBlocker.address() as { port: number }).port;
      let fixedAttempts = 0;
      await expect(
        createOwnedTestPlc(
          { port: fixedPort },
          {
            retryCollisions: false,
            beforeStart: () => {
              fixedAttempts += 1;
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(fixedAttempts).toBe(1);
      expect(fixedPortBlocker.listening).toBe(true);
      await close(fixedPortBlocker);
    } finally {
      for (const blocker of blockers) if (blocker.listening) await close(blocker);
      await plc.close();
    }
  });

  it('restores public factory descriptors after sequential successes and failures', async () => {
    const { PDS } = await import('@atproto/dev-env');
    const { PlcServer } = await import('@did-plc/server');
    const pdsFactory = Object.getOwnPropertyDescriptor(PDS, 'fromEnv');
    const plcFactory = Object.getOwnPropertyDescriptor(PlcServer, 'create');
    const plc = await createOwnedTestPlc({});
    const pds = await createOwnedTestPds(pdsOptions(plc));
    await pds.close();
    await expect(
      createOwnedTestPlc(
        {},
        {
          beforeStart: () => {
            throw new Error('controlled non-collision');
          },
        },
      ),
    ).rejects.toThrow('controlled non-collision');
    expect(Object.getOwnPropertyDescriptor(PDS, 'fromEnv')).toEqual(pdsFactory);
    expect(Object.getOwnPropertyDescriptor(PlcServer, 'create')).toEqual(plcFactory);
    await plc.close();
  });

  it('does not alter the externally listening collision blocker during PLC cleanup', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const port = (blocker.address() as { port: number }).port;
    let starts = 0;
    await expect(
      createOwnedTestPlc(
        { port },
        {
          retryCollisions: false,
          beforeStart: () => {
            starts += 1;
          },
          afterCleanup: (attempt) => {
            if (attempt.kind !== 'plc') throw new Error('expected PLC attempt');
            expect(attempt.port).toBe(port);
            expect(attempt.server.server?.listening).toBe(false);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(starts).toBe(1);
    expect(blocker.listening).toBe(true);
    expect(await new Promise<boolean>((resolve) => blocker.getConnections((error) => resolve(!error)))).toBe(true);
    await close(blocker);
  });
});
