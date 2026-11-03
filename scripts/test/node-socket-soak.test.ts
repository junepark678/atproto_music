import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedSocketSender,
  defaultSocketSoakDependencies,
  main,
  POLL_SECONDS,
  runSocketSoak,
  SOAK_HOURS,
  type SocketSoakDependencies,
  spec,
} from '../live/node_socket_soak.ts';
import { NODE_ENV, type NodeGateIO } from '../live/node-live-gate.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const validEnv: Record<string, string> = {
  [NODE_ENV.commit]: '1'.repeat(40),
  [NODE_ENV.bundleSha256]: 'a'.repeat(64),
  [NODE_ENV.origin]: 'https://music.atproto-music.org',
  [NODE_ENV.prefix]: 'org.atproto.music',
};

function capture() {
  let stdout = '';
  let stderr = '';
  let evidence = '';
  const io: NodeGateIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    writeEvidence: (_path, text) => {
      evidence = text;
    },
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  };
  return { io, output: () => ({ stdout, stderr, evidence }) };
}

function fakeDependencies(
  options: {
    send?: SocketSoakDependencies['send'];
    advance?: (ms: number) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  let elapsed = 0;
  const send = options.send ?? vi.fn(async () => ({ status: 200, body: '{}' }));
  return {
    deps: {
      send,
      nowMs: options.now ?? (() => elapsed),
      wallNow: () => new Date(Date.UTC(2026, 9, 1) + elapsed),
      sleep:
        options.sleep ??
        (async (ms: number) => {
          elapsed += ms;
          options.advance?.(ms);
        }),
      uid: () => 501,
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
    send,
  };
}

async function execute(env: Record<string, string | undefined>, deps = fakeDependencies()) {
  const output = capture();
  const exit = await runSocketSoak(env, output.io, deps.deps);
  return { exit, ...output.output(), send: deps.send };
}

describe('Node socket soak configuration and evidence', () => {
  it('declares the socketSoak contract with optional defaulted duration and interval', () => {
    expect(spec.gate).toBe('socketSoak');
    expect(SOAK_HOURS).toBe('ATMUSIC_LIVE_SOAK_HOURS');
    expect(POLL_SECONDS).toBe('ATMUSIC_LIVE_SOAK_POLL_S');
    expect(spec.requirements).toHaveLength(2);
    expect(spec.requirements.every((item) => item.optional)).toBe(true);
  });

  it('exposes usable default clock, sleep, and uid dependencies without sending', async () => {
    expect(Number.isFinite(defaultSocketSoakDependencies.nowMs())).toBe(true);
    expect(defaultSocketSoakDependencies.wallNow()).toBeInstanceOf(Date);
    expect(await defaultSocketSoakDependencies.sleep(0)).toBeUndefined();
    expect(
      defaultSocketSoakDependencies.uid() === null || typeof defaultSocketSoakDependencies.uid() === 'number',
    ).toBe(true);
    expect(typeof defaultSocketSoakDependencies.send).toBe('function');
  });

  it('blocks missing standard identity before invoking socket send', async () => {
    const deps = fakeDependencies();
    const result = await execute({}, deps);
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stdout).result).toBe('blocked');
    expect(result.send).not.toHaveBeenCalled();
  });

  it('records fixed collector failure data when the monotonic clock fails', async () => {
    const deps = fakeDependencies({
      now: () => {
        throw new Error('private clock failure /secret/path');
      },
    });
    const result = await execute(validEnv, deps);
    const evidence = JSON.parse(result.stdout);
    expect(result.exit).toBe(2);
    expect(evidence.result).toBe('blocked');
    expect(evidence.results.collectorFailure).toBe('collector_error');
    expect(result.stdout).not.toContain('private clock failure');
    expect(result.stdout).not.toContain('/secret/path');
    expect(result.send).not.toHaveBeenCalled();
  });

  it.each([
    [SOAK_HOURS, '23'],
    [SOAK_HOURS, '169'],
    [SOAK_HOURS, '24.5'],
    [SOAK_HOURS, 'bad'],
    [SOAK_HOURS, ''],
    [POLL_SECONDS, '9'],
    [POLL_SECONDS, '3601'],
    [POLL_SECONDS, '10.2'],
    [POLL_SECONDS, 'bad'],
    [POLL_SECONDS, ''],
  ])('rejects invalid %s=%j before sending', async (name, value) => {
    const deps = fakeDependencies();
    const result = await execute({ ...validEnv, [name]: value }, deps);
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stdout).result).toBe('blocked');
    expect(result.send).not.toHaveBeenCalled();
  });

  it('accepts absent defaults without contacting a real socket', async () => {
    const deps = fakeDependencies({
      sleep: async () => {
        deps.advance(24 * 60 * 60 * 1000);
      },
    });
    const result = await execute(validEnv, deps);
    const evidence = JSON.parse(result.stdout);
    expect(result.exit).toBe(2);
    expect(evidence.result).toBe('blocked');
    expect(evidence.results.requestedDurationMs).toBe(24 * 60 * 60 * 1000);
    expect(evidence.results.samples).toHaveLength(1);
  });

  it('uses safe default socket resolution and the exact protected GET with a bounded timeout', async () => {
    const sent: unknown[] = [];
    const deps = fakeDependencies({
      send: async (socketPath, request) => {
        sent.push([socketPath, request]);
        return { status: 200, body: '{}' };
      },
    });
    const result = await execute({ ...validEnv, XDG_RUNTIME_DIR: '/run/user/501' }, deps);
    expect(result.exit).toBe(2);
    expect(sent[0]).toEqual([
      '/run/user/501/atmusic/admin.sock',
      { method: 'GET', path: '/admin/status', body: null, timeoutMs: 5000 },
    ]);
    expect(sent.length).toBe(1440);
  });

  it('honors ATMUSIC_ADMIN_SOCKET while keeping the request read-only', async () => {
    const sent: unknown[] = [];
    const deps = fakeDependencies({
      send: async (socketPath, request) => {
        sent.push([socketPath, request]);
        return { status: 200, body: '{}' };
      },
    });
    const result = await execute(
      { ...validEnv, ATMUSIC_ADMIN_SOCKET: '/private/run/admin.sock', [POLL_SECONDS]: '3600' },
      deps,
    );
    expect(result.exit).toBe(2);
    expect(sent[0]).toEqual([
      '/private/run/admin.sock',
      { method: 'GET', path: '/admin/status', body: null, timeoutMs: 5000 },
    ]);
  });

  it('captures the production nested status shape and whitelists sparse metrics only', async () => {
    const secret = 'top-secret-value';
    const payload = {
      ingest: { cursor: 918, lastEventTimeUs: null, connected: true, pendingGap: false, hostIndex: 7, secret },
      indexing: { lagSeconds: 3.5, state: 'healthy', caughtUp: true },
      hints: { total: 4, due: 2 },
      jobs: { snapshot: { pending: 12, running: 1, complete: 5, failed: 0 } },
      counters: [{ label: secret, value: 99 }],
      queues: {
        outbox: { queued: 3, running: 1, succeeded: 4, pending: 80 },
        forward: { queued: 0, sent: 7, held: 1 },
        imports: { waiting_index: 8, writing: 1, failed: 2, other: 90 },
      },
      backup: { path: '/private/path', warning: secret },
      arbitrarySecret: secret,
    };
    const deps = fakeDependencies({ send: async () => ({ status: 200, body: JSON.stringify(payload) }) });
    const result = await execute({ ...validEnv, ATMUSIC_ADMIN_TOKEN: secret }, deps);
    const evidence = JSON.parse(result.stdout);
    expect(result.exit).toBe(2);
    expect(evidence.result).toBe('blocked');
    expect(evidence.results.samples[0].metrics).toEqual({
      cursor: 918,
      lastEventTimeUs: null,
      connected: true,
      pendingGap: false,
      lagSeconds: 3.5,
      hintsTotal: 4,
      hintsDue: 2,
      outboxQueue: { queued: 3, running: 1, succeeded: 4 },
      forwardQueue: { queued: 0, sent: 7, held: 1 },
      importsQueue: { waiting_index: 8, writing: 1, failed: 2 },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('/private/path');
    expect(serialized).not.toContain('counters');
    expect(serialized).not.toContain('other');
  });

  it('simulates a full 24 hours offline and always blocks stdout and evidence artifact', async () => {
    const deps = fakeDependencies();
    const env = { ...validEnv, [NODE_ENV.evidenceOut]: '/evidence.json', [POLL_SECONDS]: '3600' };
    const result = await execute(env, deps);
    const evidence = JSON.parse(result.stdout);
    expect(result.exit).toBe(2);
    expect(evidence.result).toBe('blocked');
    expect(JSON.parse(result.evidence).result).toBe('blocked');
    expect(evidence.results.elapsedMs).toBe(24 * 60 * 60 * 1000);
    expect(evidence.results.sampleCount).toBe(24);
    expect(evidence.results.reconnectCount).toBeNull();
    expect(evidence.results.restartCount).toBeNull();
    expect(evidence.results.limitations).toContain('No live 24-hour gate was executed.');
    expect(result.stderr).not.toContain('PASS');
  });

  it('records oversleep elapsed time, sampling gaps, and availability recovery without reconnect claims', async () => {
    let calls = 0;
    const deps = fakeDependencies({
      send: async () => {
        calls++;
        if (calls === 1) return { status: 503, body: 'private response' };
        return { status: 200, body: JSON.stringify({ ingest: { connected: true } }) };
      },
      sleep: async (ms) => {
        deps.advance(ms * 2 + 500);
      },
    });
    const result = await execute({ ...validEnv, [SOAK_HOURS]: '24', [POLL_SECONDS]: '3600' }, deps);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.results.elapsedMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(evidence.results.samples[0]).toMatchObject({ available: false, gap: 'http_status' });
    expect(
      evidence.results.samples.some(
        (sample: { availabilityTransition?: string }) => sample.availabilityTransition === 'recovered',
      ),
    ).toBe(true);
    expect(evidence.results.reconnectCount).toBeNull();
    expect(evidence.results.samples[1].missedPolls).toBeGreaterThan(0);
    expect(evidence.results.missingSampleCount).toBeGreaterThan(1);
  });

  it('bounds a hung request and stops sampling after its hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => new Promise<{ status: number; body: string }>(() => undefined));
      const deps = fakeDependencies({ send });
      const pending = execute({ ...validEnv, [SOAK_HOURS]: '24' }, deps);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      const evidence = JSON.parse(result.stdout);
      expect(result.exit).toBe(2);
      expect(send).toHaveBeenCalledTimes(1);
      expect(evidence.results.samples).toHaveLength(1);
      expect(evidence.results.samples[0].gap).toBe('request_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ status: 502, body: 'Bearer private-token /private/path' }, 'http_status'],
    [{ status: 200, body: '{invalid secret' }, 'invalid_json'],
    [{ status: 200, body: 'null' }, 'invalid_json'],
    [{ status: 200, body: '[]' }, 'invalid_json'],
    [new Error('secret /private/path'), 'socket_error'],
  ])('redacts non-success response and exception details', async (answer, category) => {
    const deps = fakeDependencies({
      send: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const result = await execute({ ...validEnv, ATMUSIC_LIVE_TOKEN: 'private-token' }, deps);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.results.samples[0].gap).toBe(category);
    expect(result.stdout).not.toContain('secret');
    expect(result.stdout).not.toContain('/private/path');
    expect(result.stdout).not.toContain('private-token');
  });

  it('does not execute the gate when imported in a subprocess', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(new URL('../live/node_socket_soak.ts', import.meta.url).href)})`,
      ],
      {
        cwd: REPO,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ATMUSIC_LIVE_'))),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits 2 from the actual CLI with no configured release and emits only blocked JSON', () => {
    const result = spawnSync(process.execPath, [resolve(REPO, 'scripts/live/node_socket_soak.ts')], {
      cwd: REPO,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ATMUSIC_LIVE_'))),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).result).toBe('blocked');
    expect(JSON.parse(result.stdout).missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining(NODE_ENV.commit),
        expect.stringContaining(NODE_ENV.bundleSha256),
        expect.stringContaining(NODE_ENV.origin),
        expect.stringContaining(NODE_ENV.prefix),
      ]),
    );
    expect(result.stderr).toContain('BLOCKED');
  });

  it('retains absent or invalid metrics as null and never fills absent queue states with zero', async () => {
    const deps = fakeDependencies({
      send: async () => ({
        status: 200,
        body: JSON.stringify({
          ingest: { cursor: -1, lastEventTimeUs: 'secret', connected: 'true' },
          indexing: { lagSeconds: -9 },
          hints: { total: 1.5 },
          queues: { outbox: { queued: 2.5, failed: -1 }, forward: {} },
        }),
      }),
    });
    const result = await execute({ ...validEnv, [POLL_SECONDS]: '3600' }, deps);
    expect(Object.values(JSON.parse(result.stdout).results.samples[0].metrics)).toEqual(Array(10).fill(null));
  });

  it('reports observed connection transitions without treating them as counted reconnects or restarts', async () => {
    let calls = 0;
    const deps = fakeDependencies({
      send: async () => ({
        status: 200,
        body: JSON.stringify({
          ingest: { connected: ++calls % 2 === 0 },
        }),
      }),
    });
    const result = await execute({ ...validEnv, [POLL_SECONDS]: '3600' }, deps);
    const results = JSON.parse(result.stdout).results;
    expect(results.connectedTransitionsObserved).toBe(23);
    expect(results.reconnectCount).toBeNull();
    expect(results.restartCount).toBeNull();
  });

  it.each(['answer', 'deadline', 'error', 'exit'] as const)(
    'destroys the production transport worker on %s and clears its deadline',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
        worker.terminate = vi.fn(async () => 0);
        const factory = vi.fn(() => worker as unknown as Worker);
        const send = createBoundedSocketSender(factory);
        const pending = send('/private/admin.sock', {
          method: 'GET',
          path: '/admin/status',
          body: null,
          timeoutMs: 50,
        });
        const observed = pending.then(
          (answer) => answer,
          () => null,
        );
        expect(factory.mock.calls[0]).toBeDefined();
        if (outcome === 'answer') worker.emit('message', { status: 200, body: '{}' });
        if (outcome === 'deadline') await vi.advanceTimersByTimeAsync(50);
        if (outcome === 'error') worker.emit('error', new Error('/secret/path'));
        if (outcome === 'exit') worker.emit('exit', 1);
        expect(await observed).toEqual(outcome === 'answer' ? { status: 200, body: '{}' } : null);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('runs the transport worker with an injected offline module and no actual socket access', async () => {
    const adminModule = JSON.stringify(new URL('../admin/atmusic-admin.ts', import.meta.url).href);
    const fakeModule = JSON.stringify(
      `data:text/javascript,${encodeURIComponent(
        'export async function sendOverSocket(path, request) { return {status:200,body:JSON.stringify(request)}; }',
      )}`,
    );
    const send = createBoundedSocketSender((source, options) => {
      expect(source).toContain(`import(${adminModule})`);
      expect(options.env).toEqual({});
      // Replace only the transport module; exercise the actual worker lifecycle.
      return new Worker(source.replace(adminModule, fakeModule), options);
    });
    const request = { method: 'GET' as const, path: '/admin/status', body: null, timeoutMs: 1000 };
    expect(await send('/unused.sock', request)).toEqual({ status: 200, body: JSON.stringify(request) });
  });

  it('provides main for test injection without touching the production socket', async () => {
    const io = capture();
    expect(typeof main).toBe('function');
    expect(await main(validEnv, io.io, fakeDependencies().deps)).toBe(2);
    expect(JSON.parse(io.output().stdout).result).toBe('blocked');
  });
});
