import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { certificateSerialFromDigest } from '../e2e/dev-env';
import { acquireStackOwnership } from '../e2e/start-stack';

const temporaryDirectories: string[] = [];

function temporaryLockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atmusic-e2e-lock-'));
  temporaryDirectories.push(directory);
  return join(directory, 'stack.lock');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('e2e workspace lock is exclusive and released for a later run', async () => {
  const lockPath = temporaryLockPath();
  const ports = { worker: 0, plc: 0, pds1: 0, pds2: 0, proxy: 0, control: 0 };
  const release = await acquireStackOwnership(ports, lockPath);

  await expect(acquireStackOwnership(ports, lockPath)).rejects.toThrow(/another e2e stack owns this workspace/);
  release();
  release();

  const releaseNextRun = await acquireStackOwnership(ports, lockPath);
  releaseNextRun();
});

test('a lock left by a killed stack process is reclaimed for the next run', async () => {
  const lockPath = temporaryLockPath();
  const sourceUrl = pathToFileURL(resolve('scripts/e2e/start-stack.ts')).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { acquireStackOwnership } from ${JSON.stringify(sourceUrl)}; await acquireStackOwnership({ worker: 0, plc: 0, pds1: 0, pds2: 0, proxy: 0, control: 0 }, ${JSON.stringify(lockPath)}); console.log('LOCK_READY'); setInterval(() => {}, 1000);`,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not acquire lock: ${output}`)), 10_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', () => {
        if (!output.includes('LOCK_READY')) return;
        clearTimeout(timer);
        resolve();
      });
    });

    child.kill('SIGKILL');
    const exit = await childExit;
    expect(exit.signal).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  const release = await acquireStackOwnership({ worker: 0, plc: 0, pds1: 0, pds2: 0, proxy: 0, control: 0 }, lockPath);
  release();
});

test('occupied e2e port releases the ownership lock before rejecting startup', async () => {
  const lockPath = temporaryLockPath();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const ports = { worker: port, plc: 0, pds1: 0, pds2: 0, proxy: 0, control: 0 };

  try {
    await expect(acquireStackOwnership(ports, lockPath)).rejects.toThrow(`port ${port} (worker) is in use`);
    const releaseNextRun = await acquireStackOwnership({ ...ports, worker: 0 }, lockPath);
    releaseNextRun();
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});

test('self-signed certificate serial is a canonical positive DER integer', () => {
  const zeroAfterMask = certificateSerialFromDigest(Buffer.from([0x80, 1, 2, 3, 4, 5, 6, 7]));
  const zeroDigest = certificateSerialFromDigest(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const highBit = certificateSerialFromDigest(Buffer.from([0xff, 1, 2, 3, 4, 5, 6, 7]));

  expect(zeroAfterMask[0]).toBe(1);
  expect(zeroDigest[0]).toBe(1);
  expect(highBit[0]).toBe(0x7f);
  expect(zeroAfterMask).toHaveLength(8);
});
