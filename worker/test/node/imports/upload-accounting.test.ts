import { readdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fsBarriers = vi.hoisted(() => ({
  orderNames: null as null | ((path: string, names: string[]) => string[]),
  afterReaddir: null as null | ((names: string[]) => Promise<void>),
  afterStat: null as null | ((path: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (path: Parameters<typeof readdir>[0]) => {
      const names = (await actual.readdir(path as string)) as string[];
      const ordered = fsBarriers.orderNames?.(String(path), names) ?? names;
      await fsBarriers.afterReaddir?.(ordered);
      return ordered;
    },
    stat: async (...args: Parameters<typeof stat>) => {
      const result = await actual.stat(...args);
      await fsBarriers.afterStat?.(String(args[0]));
      return result;
    },
  };
});

const { receiveUpload: productionReceiveUpload } = await import('../../../src/imports/uploads');

type UploadResult = Awaited<ReturnType<typeof productionReceiveUpload>>;
type Scope = {
  controller: AbortController;
  releases: Set<() => void>;
  receives: Set<Promise<UploadResult>>;
  close(): Promise<void>;
};
type Owner = { closed: boolean; scopes: Set<Scope>; closing: Promise<void> | null };
type Helpers = ReturnType<typeof scopeHelpers>;
type DirectoryCase = (dir: string, scope: Helpers) => Promise<void>;
const activeOwners = new Set<Owner>();

async function closeOwner(owner: Owner): Promise<void> {
  owner.closed = true;
  owner.closing ??= Promise.all([...owner.scopes].map((scope) => scope.close())).then(() => {
    activeOwners.delete(owner);
  });
  await owner.closing;
}

afterEach(async () => {
  await Promise.all([...activeOwners].map(closeOwner));
});

function accountingTest(name: string, run: (withDir: (test: DirectoryCase) => Promise<void>) => Promise<void>) {
  it(name, async () => {
    const owner: Owner = { closed: false, scopes: new Set(), closing: null };
    activeOwners.add(owner);
    try {
      await run((test) => withDirectory(owner, test));
    } finally {
      await closeOwner(owner);
    }
  });
}

function scopeHelpers(owner: Owner, scope: Scope) {
  const ensureOpen = () => {
    if (owner.closed) throw new Error('accounting test owner closed');
    scope.controller.signal.throwIfAborted();
  };
  function receiveUpload(...args: Parameters<typeof productionReceiveUpload>) {
    ensureOpen();
    const result = productionReceiveUpload(...args);
    scope.receives.add(result);
    // Observe from launch; callers still await the original rejection.
    void result.catch(() => undefined);
    return result;
  }
  function deferred<T = void>() {
    ensureOpen();
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    scope.releases.add(() => resolve(undefined as T));
    return { promise, resolve };
  }
  async function waitForBarrier<T>(barrier: Promise<T>, ...receives: Promise<UploadResult>[]): Promise<T> {
    ensureOpen();
    const { signal } = scope.controller;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([
        barrier,
        aborted,
        ...receives.map((receive) =>
          receive.then(() => {
            throw new Error('upload settled before its required barrier');
          }),
        ),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  function heldBody(bytes: number) {
    const pulled = deferred();
    const release = deferred();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulled.resolve();
          await release.promise;
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return { body, pulled: pulled.promise, release: () => release.resolve() };
  }
  return { receiveUpload, deferred, waitForBarrier, heldBody };
}

async function withDirectory(owner: Owner, run: DirectoryCase): Promise<void> {
  if (owner.closed) throw new Error('accounting test owner closed');
  // Register synchronously, before directory creation can suspend this test.
  const dirPromise = mkdtemp(join(tmpdir(), 'atmusic-upload-accounting-'));
  let closing: Promise<void> | null = null;
  const scope: Scope = {
    controller: new AbortController(),
    releases: new Set(),
    receives: new Set(),
    close() {
      closing ??= (async () => {
        scope.controller.abort(new Error('accounting test scope closed'));
        for (const release of scope.releases) release();
        await Promise.allSettled(scope.receives);
        fsBarriers.afterReaddir = null;
        fsBarriers.afterStat = null;
        fsBarriers.orderNames = null;
        const dir = await dirPromise.catch(() => null);
        if (dir !== null) await rm(dir, { recursive: true, force: true });
        owner.scopes.delete(scope);
      })();
      return closing;
    },
  };
  owner.scopes.add(scope);
  try {
    const dir = await dirPromise;
    if (owner.closed) throw new Error('accounting test owner closed');
    scope.controller.signal.throwIfAborted();
    await run(dir, scopeHelpers(owner, scope));
    // A raw receive await can resume after timeout cleanup; it cannot finish
    // this scope successfully and open another directory for the expired test.
    if (owner.closed) throw new Error('accounting test owner closed');
    scope.controller.signal.throwIfAborted();
  } finally {
    await scope.close();
  }
}

function closedBody(bytes: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

const NO_SPACE = { ok: false, status: 507, code: 'insufficient_storage' } as const;
const FLOOR = 10_000_000n;

accountingTest(
  'reserves floor and declared capacity while an upload is held before its first write',
  async (withDir) => {
    await withDir(async (dir, scope) => {
      const first = scope.heldBody(700);
      const firstResult = scope.receiveUpload(first.body, {
        dir,
        jobId: 'floor-a',
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: asyncFreeBytes(1_000),
        declaredLength: 700,
      });
      try {
        await scope.waitForBarrier(first.pulled, firstResult);
        const second = await scope.receiveUpload(closedBody(700), {
          dir,
          jobId: 'floor-b',
          dirMaxBytes: 2_000,
          minFreeBytes: Number(FLOOR),
          freeBytes: asyncFreeBytes(1_000),
          declaredLength: 700,
        });
        expect(second).toEqual(NO_SPACE);
        expect(await readdir(dir)).toEqual(['floor-a.upload']);
      } finally {
        first.release();
      }
      expect(await firstResult).toMatchObject({ ok: true, bytes: 700 });
      expect(
        await Promise.all((await readdir(dir)).map(async (name) => [name, (await stat(join(dir, name))).size])),
      ).toEqual([['floor-a.upload', 700]]);
    });

    await withDir(async (dir, scope) => {
      const first = scope.heldBody(900);
      const firstResult = scope.receiveUpload(first.body, {
        dir,
        jobId: 'declared-a',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      try {
        await scope.waitForBarrier(first.pulled, firstResult);
        expect(
          await scope.receiveUpload(closedBody(900), {
            dir,
            jobId: 'declared-b',
            dirMaxBytes: 1_000,
            minFreeBytes: 0,
            freeBytes: () => 1_000_000n,
            declaredLength: 900,
          }),
        ).toEqual(NO_SPACE);
        expect(await readdir(dir)).toEqual(['declared-a.upload']);
      } finally {
        first.release();
      }
      expect(await firstResult).toMatchObject({ ok: true, bytes: 900 });
      expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
        900,
      ]);
    });
  },
);

accountingTest('uses completed files in fresh floor and directory-cap admissions', async (withDir) => {
  await withDir(async (dir, scope) => {
    expect(
      await scope.receiveUpload(closedBody(700), {
        dir,
        jobId: 'floor-done',
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: asyncFreeBytes(1_000),
        declaredLength: 700,
      }),
    ).toMatchObject({ ok: true, bytes: 700 });
    expect(
      await scope.receiveUpload(closedBody(700), {
        dir,
        jobId: 'floor-next',
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: asyncFreeBytes(1_000),
        declaredLength: 700,
      }),
    ).toEqual(NO_SPACE);
    expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
      700,
    ]);
  });

  await withDir(async (dir, scope) => {
    expect(
      await scope.receiveUpload(closedBody(900), {
        dir,
        jobId: 'cap-done',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      }),
    ).toMatchObject({ ok: true, bytes: 900 });
    expect(
      await scope.receiveUpload(closedBody(900), {
        dir,
        jobId: 'cap-next',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      }),
    ).toEqual(NO_SPACE);
    expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
      900,
    ]);
  });
});

accountingTest(
  'reproduces the former constant free-space fixture after the first upload completes',
  async (withDir) => {
    await withDir(async (dir, scope) => {
      const options = (jobId: string) => ({
        dir,
        jobId,
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: () => FLOOR + 1_000n,
        declaredLength: 700,
      });
      expect(await scope.receiveUpload(closedBody(700), options('constant-a'))).toMatchObject({ ok: true, bytes: 700 });
      expect(await scope.receiveUpload(closedBody(700), options('constant-b'))).toMatchObject({ ok: true, bytes: 700 });
      expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
        700, 700,
      ]);
    });
  },
);

function asyncFreeBytes(allowance: number): (path: string) => bigint {
  return (path) => {
    const names = readdirSync(path);
    const bytes = names.reduce((sum, name) => sum + statSync(join(path, name)).size, 0);
    return FLOOR + BigInt(allowance - bytes);
  };
}

// Synchronous freeBytes mirrors disk.ts: it reports current available space.

accountingTest('charges a completion missed by an empty scan snapshot', async (withDir) => {
  await withDir(async (dir, scope) => {
    const scanHeld = scope.deferred();
    const releaseScan = scope.deferred();
    const scanNames = scope.deferred<string[]>();
    let held = false;
    fsBarriers.afterReaddir = async (names) => {
      if (!held) {
        held = true;
        scanNames.resolve(names);
        scanHeld.resolve();
        await releaseScan.promise;
      }
    };
    let secondResult: ReturnType<typeof productionReceiveUpload> | undefined;
    let firstResult: ReturnType<typeof productionReceiveUpload> | undefined;
    try {
      secondResult = scope.receiveUpload(closedBody(900), {
        dir,
        jobId: 'scan-before-a',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      await scope.waitForBarrier(scanHeld.promise, secondResult);
      expect(await scope.waitForBarrier(scanNames.promise, secondResult)).toEqual([]);
      firstResult = scope.receiveUpload(closedBody(900), {
        dir,
        jobId: 'scan-a',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      expect(await firstResult).toMatchObject({ ok: true, bytes: 900 });
    } finally {
      releaseScan.resolve();
    }
    expect(await secondResult!).toEqual(NO_SPACE);
    expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
      900,
    ]);
  });
});

accountingTest(
  'charges an in-flight file skipped by the scan when it completes during a later stat',
  async (withDir) => {
    await withDir(async (dir, scope) => {
      await writeFile(join(dir, 'sentinel'), 'x');
      const firstPulled = scope.deferred();
      const finishFirst = scope.deferred();
      let sentFirstChunk = false;
      const firstBody = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!sentFirstChunk) {
              sentFirstChunk = true;
              controller.enqueue(new Uint8Array(900));
              firstPulled.resolve();
            } else {
              await finishFirst.promise;
              controller.close();
            }
          },
        },
        { highWaterMark: 0 },
      );
      const firstResult = scope.receiveUpload(firstBody, {
        dir,
        jobId: 'skip-a',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      const statHeld = scope.deferred();
      const releaseStat = scope.deferred();
      let sentinelStats = 0;
      let uploadStatsBeforeCompletion = 0;
      let secondScanNames: string[] | null = null;
      fsBarriers.orderNames = (path, names) => {
        if (path !== dir || !names.includes('skip-a.upload')) return names;
        const ordered = [...names].sort((a, b) => {
          if (a === 'skip-a.upload') return -1;
          if (b === 'skip-a.upload') return 1;
          return a.localeCompare(b);
        });
        secondScanNames = ordered;
        return ordered;
      };
      fsBarriers.afterStat = async (path) => {
        if (path.endsWith('/skip-a.upload')) uploadStatsBeforeCompletion++;
        if (path.endsWith('/sentinel') && ++sentinelStats === 2) {
          statHeld.resolve();
          await releaseStat.promise;
        }
      };
      let secondResult: ReturnType<typeof productionReceiveUpload> | undefined;
      try {
        await scope.waitForBarrier(firstPulled.promise, firstResult);
        secondResult = scope.receiveUpload(closedBody(900), {
          dir,
          jobId: 'skip-b',
          dirMaxBytes: 1_000,
          minFreeBytes: 0,
          freeBytes: () => 1_000_000n,
          declaredLength: 900,
        });
        await scope.waitForBarrier(statHeld.promise, firstResult, secondResult);
        expect(secondScanNames).toEqual(['skip-a.upload', 'sentinel']);
        expect(uploadStatsBeforeCompletion).toBe(0);
        finishFirst.resolve();
        expect(await firstResult).toMatchObject({ ok: true, bytes: 900 });
      } finally {
        finishFirst.resolve();
        releaseStat.resolve();
      }
      expect(await secondResult!).toEqual(NO_SPACE);
      expect(
        await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size)).then((sizes) =>
          sizes.sort(),
        ),
      ).toEqual([1, 900]);
    });
  },
);
