import { readdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const fsBarriers = vi.hoisted(() => ({
  afterReaddir: null as null | ((names: string[]) => Promise<void>),
  afterStat: null as null | ((path: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (path: Parameters<typeof readdir>[0]) => {
      const names = (await actual.readdir(path as string)) as string[];
      await fsBarriers.afterReaddir?.(names);
      return names;
    },
    stat: async (...args: Parameters<typeof stat>) => {
      const result = await actual.stat(...args);
      await fsBarriers.afterStat?.(String(args[0]));
      return result;
    },
  };
});

const { receiveUpload } = await import('../../../src/imports/uploads');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atmusic-upload-accounting-'));
  try {
    await run(dir);
  } finally {
    fsBarriers.afterReaddir = null;
    fsBarriers.afterStat = null;
    await rm(dir, { recursive: true, force: true });
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
      freeBytes: () => FLOOR + 1_000n,
      declaredLength: 700,
    });
    try {
      await first.pulled;
      const second = await receiveUpload(closedBody(700), {
        dir,
        jobId: 'floor-b',
        dirMaxBytes: 2_000,
        minFreeBytes: Number(FLOOR),
        freeBytes: () => FLOOR + 1_000n,
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
      await first.pulled;
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
      await scanHeld.promise;
      expect(await scanNames.promise).toEqual([]);
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
    fsBarriers.afterStat = async (path) => {
      if (path.endsWith('/sentinel') && ++sentinelStats === 2) {
        statHeld.resolve();
        await releaseStat.promise;
      }
    };
    let secondResult: ReturnType<typeof receiveUpload> | undefined;
    try {
      await firstPulled.promise;
      secondResult = receiveUpload(closedBody(900), {
        dir,
        jobId: 'skip-b',
        dirMaxBytes: 1_000,
        minFreeBytes: 0,
        freeBytes: () => 1_000_000n,
        declaredLength: 900,
      });
      await statHeld.promise;
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
