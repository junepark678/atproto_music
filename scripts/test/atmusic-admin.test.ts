// scripts/admin/atmusic-admin.ts, the admin CLI (ADR 0005 §3.11, §14.4;
// N4-02), against the real admin socket of the server (node/admin-socket.ts
// bound in a temporary 0700 directory) serving the real socket routes
// (http/admin.ts socketAdminHandler) over recording fakes of the index, the
// host status and the kid pruning. Every connection the CLI opens is recorded
// at net.Socket.prototype.connect, and the global fetch is a refusing spy, so
// the test sees that each command reaches only the socket path.

import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../worker/src/app/index-core.ts';
import type { AdminStatus, BackupOutcome } from '../../worker/src/do/contracts.ts';
import { type ResnapshotOutcome, socketAdminHandler } from '../../worker/src/http/admin.ts';
import { type AdminSocket, bindAdminSocket } from '../../worker/src/node/admin-socket.ts';
import { main } from '../admin/atmusic-admin.ts';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const UNKNOWN_DID = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';

const dirs: string[] = [];
const sockets: AdminSocket[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONNECT = net.Socket.prototype.connect;
afterEach(async () => {
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  globalThis.fetch = ORIGINAL_FETCH;
  for (const s of sockets.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seq(): { nextInt(max: number): number; bytes(n: number): Uint8Array } {
  let i = 0;
  return {
    nextInt: (max: number) => i++ % max,
    bytes: (n: number) => new Uint8Array(n).map(() => i++ & 0xff),
  };
}

describe('atmusic-admin', () => {
  it('status, backup, resnapshot and prune-kid talk only to the admin socket path and print its JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-admin-'));
    dirs.push(dir);
    const socketPath = join(dir, 'atmusic', 'admin.sock');

    const calls: string[] = [];
    const coreStatus = { schema: { status: 'ready', version: 2 }, hints: { total: 3, due: 1 } };
    const backupOutcome = {
      status: 'ok',
      kind: 'manual',
      path: '/state/backups/atmusic-20260115T1200Z.db',
      bytes: 4096,
      startedAtMs: 1768478400000,
      finishedAtMs: 1768478401000,
    };
    const log = createLogger([], { log: () => {}, warn: () => {}, error: () => {} });
    const socket = await bindAdminSocket({ path: socketPath, log, random: seq() as never });
    sockets.push(socket);
    socket.setHandler(
      socketAdminHandler({
        index: {
          adminStatus: async () => {
            calls.push('adminStatus');
            return coreStatus as unknown as AdminStatus;
          },
          adminBackup: async () => {
            calls.push('adminBackup');
            return backupOutcome as unknown as BackupOutcome;
          },
          adminResnapshot: async (did): Promise<ResnapshotOutcome> => {
            calls.push(`adminResnapshot ${did}`);
            return did === DID ? { status: 'scheduled' } : { status: 'unknown' };
          },
        },
        hostStatus: () => {
          calls.push('hostStatus');
          return { backup: { ageMs: 60000 }, uploadDirBytes: 0 };
        },
        pruneKid: (kid) => {
          calls.push(`pruneKid ${kid}`);
          return { status: 'pruned', kid, sessions: 2 };
        },
        random: seq() as never,
      }),
    );

    // Every connection the process opens from here on, and any fetch.
    const connects: unknown[] = [];
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      // net normalises the arguments to [options, callback]; a `path` makes it a unix-socket connect.
      const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { path?: unknown } | undefined;
      connects.push({ path: typeof options?.path === 'string' ? options.path : null });
      return (ORIGINAL_CONNECT as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error('atmusic-admin must not use fetch');
    }) as typeof fetch;

    const cli = async (args: string[], env: Record<string, string> = { ATMUSIC_ADMIN_SOCKET: socketPath }) => {
      const out: string[] = [];
      const err: string[] = [];
      const before = connects.length;
      const code = await main(args, { env, out: (t) => out.push(t), err: (t) => err.push(t) });
      return { code, stdout: out.join(''), stderr: err.join(''), connects: connects.slice(before) };
    };

    // status: GET /admin/status, the core and host halves merged.
    const status = await cli(['status']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ ...coreStatus, backup: { ageMs: 60000 }, uploadDirBytes: 0 });
    expect(status.stdout).toBe(`${JSON.stringify(JSON.parse(status.stdout), null, 2)}\n`);
    expect(status.stderr).toBe('');
    expect(status.connects).toEqual([{ path: socketPath }]);

    // backup: POST /admin/backup.
    const backup = await cli(['backup']);
    expect([backup.code, JSON.parse(backup.stdout)]).toEqual([0, backupOutcome]);
    expect(backup.connects).toEqual([{ path: socketPath }]);

    // resnapshot: POST /admin/resnapshot {did}, 202.
    const resnapshot = await cli(['resnapshot', DID]);
    expect([resnapshot.code, JSON.parse(resnapshot.stdout)]).toEqual([0, { did: DID, status: 'scheduled' }]);

    // prune-kid, with the socket given by --socket and no environment at all.
    const prune = await cli(['--socket', socketPath, 'prune-kid', 'k0'], {});
    expect([prune.code, JSON.parse(prune.stdout)]).toEqual([0, { kid: 'k0', sessions: 2 }]);
    expect(prune.connects).toEqual([{ path: socketPath }]);

    // A refusal is still the server's JSON, with exit 1.
    const unknown = await cli(['resnapshot', UNKNOWN_DID]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ error: { code: 'not_found' } });
    expect(unknown.stderr).toContain('POST /admin/resnapshot answered 404');

    // The default path is $XDG_RUNTIME_DIR/atmusic/admin.sock.
    const viaRuntime = await cli(['status'], { XDG_RUNTIME_DIR: dir });
    expect(viaRuntime.code).toBe(0);
    expect(viaRuntime.connects).toEqual([{ path: socketPath }]);

    // Usage errors send nothing.
    for (const bad of [['resnapshot', 'not-a-did'], ['prune-kid'], ['frobnicate'], []]) {
      const usage = await cli(bad);
      expect(usage.code, bad.join(' ')).toBe(2);
      expect(usage.connects).toEqual([]);
    }

    // A socket that is not there: exit 1, nothing printed to stdout.
    const missing = await cli(['status'], { ATMUSIC_ADMIN_SOCKET: join(dir, 'nowhere.sock') });
    expect([missing.code, missing.stdout]).toEqual([1, '']);
    expect(missing.stderr).toContain('is atmusic running?');

    // Only unix-socket connections, never TCP, never fetch.
    expect(connects.length).toBe(7);
    expect(connects).toEqual([...Array(6).fill({ path: socketPath }), { path: join(dir, 'nowhere.sock') }]);
    expect(fetches).toBe(0);
    expect(calls).toEqual([
      'adminStatus',
      'hostStatus',
      'adminBackup',
      `adminResnapshot ${DID}`,
      'pruneKid k0',
      `adminResnapshot ${UNKNOWN_DID}`,
      'adminStatus',
      'hostStatus',
    ]);
  });
});
