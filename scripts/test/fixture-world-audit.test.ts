import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { terminateChild } from '../e2e/scrobbler-e2e';

const entry = fileURLToPath(new URL('../e2e/fixture-world.ts', import.meta.url));

async function child() {
  const proc = spawn(process.execPath, ['--import', 'tsx', entry, '--identity-child', '0', 'identity'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (b: Buffer) => {
    stdout += b.toString();
  });
  proc.stderr!.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  const [ready] = (await once(proc, 'message')) as [{ port: number; accounts: Array<{ name: string; did: string }> }];
  return {
    proc,
    ready,
    output: () => stdout + stderr,
    close: async () => {
      await terminateChild(proc, 100);
    },
  };
}

describe('identity fixture routing audit', () => {
  test('explicit PDS routing, rejects mismatches, and supports direct fallback', async () => {
    const c = await child();
    try {
      const bob = c.ready.accounts.find((a) => a.name === 'bob')!;
      const query = `?repo=${bob.did}&collection=test.atmusic.e2e.scrobble&limit=10`;
      const req = (host?: string) =>
        fetch(`http://127.0.0.1:${c.ready.port}/xrpc/com.atproto.repo.listRecords${query}`, {
          headers: host ? { 'x-fixture-host': host } : {},
        });
      const good = await req('pds2.test');
      expect(good.status).toBe(200);
      expect(((await good.json()) as { records: unknown[] }).records).toHaveLength(1);
      for (const host of ['pds1.test', 'outside.invalid']) {
        const bad = await req(host);
        expect(bad.status).not.toBe(200);
        expect(await bad.text()).not.toContain('Running Up That Hill');
      }
      const direct = await req();
      expect(direct.status).toBe(200);
      expect(((await direct.json()) as { records: unknown[] }).records).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  test('redacts credentials and authorization code from child output on failure', async () => {
    const c = await child();
    try {
      const bob = c.ready.accounts.find((a) => a.name === 'bob')!;
      const secret = 'AUDIT_SENTINEL_CREDENTIAL_7f3d';
      const response = await fetch(
        `http://127.0.0.1:${c.ready.port}/xrpc/com.atproto.repo.listRecords?repo=${bob.did}&collection=test.atmusic.e2e.scrobble&limit=1&code=${secret}`,
        {
          headers: {
            'x-fixture-host': `${secret}:password@outside.invalid`,
            authorization: `Bearer ${secret}`,
            cookie: `code=${secret}`,
          },
        },
      );
      expect(response.status).not.toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(c.output()).toContain('identity fixture request failed');
      expect(c.output()).not.toContain(secret);
      expect(await response.text()).not.toContain(secret);
    } finally {
      await c.close();
    }
  });
});
