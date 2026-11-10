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
const activeScopes = new Set<Scope>();
let activeScope: Scope | null = null;

function receiveUpload(...args: Parameters<typeof productionReceiveUpload>) {
  if (!activeScope) throw new Error('upload requires an accounting test scope');
  const result = productionReceiveUpload(...args);
  activeScope.receives.add(result);
  // Observe from launch; callers still await the original rejection.
  void result.catch(() => undefined);
  return result;
}

async function waitForBarrier<T>(barrier: Promise<T>, ...receives: Promise<UploadResult>[]): Promise<T> {
  const scope = activeScope;
  if (!scope) throw new Error('barrier requires an accounting test scope');
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

afterEach(async () => {
  await Promise.all([...activeScopes].map((scope) => scope.close()));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  activeScope?.releases.add(() => resolve(undefined as T));
  return { promise, resolve };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atmusic-upload-accounting-'));
  let closing: Promise<void> | null = null;
  const scope: Scope = {
    controller: new AbortController(),
    releases: new Set(),
    receives: new Set(),
    close() {
      closing ??= (async () => {
        scope.controller.abort(new Error('accounting test scope closed'));
        for (const release of scope.releases) release();
        // All launched receives must close their handles before hooks or files disappear.
        await Promise.allSettled(scope.receives);
        fsBarriers.afterReaddir = null;
        fsBarriers.afterStat = null;
        fsBarriers.orderNames = null;
        await rm(dir, { recursive: true, force: true });
        activeScopes.delete(scope);
        if (activeScope === scope) activeScope = null;
      })();
      return closing;
    },
  };
  activeScopes.add(scope);
  activeScope = scope;
  try {
    await run(dir);
  } finally {
    await scope.close();
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

it('reserves floor and declared capacity while an upload is held before its first write', async () => {
  await withDir(async (dir) => {
    const first = heldBody(700);
    const firstResult = receiveUpload(first.body, {
      dir,
      jobId: 'floor-a',
      dirMaxBytes: 2_000,
      minFreeBytes: Number(FLOOR),
      freeBytes: asyncFreeBytes(1_000),
      declaredLength: 700,
    });
    try {
      await waitForBarrier(first.pulled, firstResult);
      const second = await receiveUpload(closedBody(700), {
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

  await withDir(async (dir) => {
    const first = heldBody(900);
    const firstResult = receiveUpload(first.body, {
      dir,
      jobId: 'declared-a',
      dirMaxBytes: 1_000,
      minFreeBytes: 0,
      freeBytes: () => 1_000_000n,
      declaredLength: 900,
    });
    try {
      await waitForBarrier(first.pulled, firstResult);
      expect(
        await receiveUpload(closedBody(900), {
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
});

it('uses completed files in fresh floor and directory-cap admissions', async () => {
  await withDir(async (dir) => {
    expect(
      await receiveUpload(closedBody(700), {
        dir,
        jobId: 'floor-done',
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: asyncFreeBytes(1_000),
        declaredLength: 700,
      }),
    ).toMatchObject({ ok: true, bytes: 700 });
    expect(
      await receiveUpload(closedBody(700), {
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

  await withDir(async (dir) => {
    expect(
      await receiveUpload(closedBody(900), {
        dir,
        jobId: 'cap-done',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      }),
    ).toMatchObject({ ok: true, bytes: 900 });
    expect(
      await receiveUpload(closedBody(900), {
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

it('reproduces the former constant free-space fixture after the first upload completes', async () => {
  await withDir(async (dir) => {
    const options = (jobId: string) => ({
      dir,
      jobId,
      dirMaxBytes: 2_000,
      minFreeBytes: Number(FLOOR),
      freeBytes: () => FLOOR + 1_000n,
      declaredLength: 700,
    });
    expect(await receiveUpload(closedBody(700), options('constant-a'))).toMatchObject({ ok: true, bytes: 700 });
    expect(await receiveUpload(closedBody(700), options('constant-b'))).toMatchObject({ ok: true, bytes: 700 });
    expect(await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).toEqual([
      700, 700,
    ]);
  });
});

function asyncFreeBytes(allowance: number): (path: string) => bigint {
  return (path) => {
    const names = readdirSync(path);
    const bytes = names.reduce((sum, name) => sum + statSync(join(path, name)).size, 0);
    return FLOOR + BigInt(allowance - bytes);
  };
}

// Synchronous freeBytes mirrors disk.ts: it reports current available space.

it('charges a completion missed by an empty scan snapshot', async () => {
  await withDir(async (dir) => {
    const scanHeld = deferred();
    const releaseScan = deferred();
    const scanNames = deferred<string[]>();
    let held = false;
    fsBarriers.afterReaddir = async (names) => {
      if (!held) {
        held = true;
        scanNames.resolve(names);
        scanHeld.resolve();
        await releaseScan.promise;
      }
    };
    let secondResult: ReturnType<typeof receiveUpload> | undefined;
    let firstResult: ReturnType<typeof receiveUpload> | undefined;
    try {
      secondResult = receiveUpload(closedBody(900), {
        dir,
        jobId: 'scan-before-a',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      await waitForBarrier(scanHeld.promise, secondResult);
      expect(await waitForBarrier(scanNames.promise, secondResult)).toEqual([]);
      firstResult = receiveUpload(closedBody(900), {
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

it('charges an in-flight file skipped by the scan when it completes during a later stat', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'sentinel'), 'x');
    const firstPulled = deferred();
    const finishFirst = deferred();
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
    const firstResult = receiveUpload(firstBody, {
      dir,
      jobId: 'skip-a',
      dirMaxBytes: 1_000,
      minFreeBytes: 0,
      freeBytes: () => 1_000_000n,
      declaredLength: 900,
    });
    const statHeld = deferred();
    const releaseStat = deferred();
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
    let secondResult: ReturnType<typeof receiveUpload> | undefined;
    try {
      await waitForBarrier(firstPulled.promise, firstResult);
      secondResult = receiveUpload(closedBody(900), {
        dir,
        jobId: 'skip-b',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      await waitForBarrier(statHeld.promise, firstResult, secondResult);
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
});
