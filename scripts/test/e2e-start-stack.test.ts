import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
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
