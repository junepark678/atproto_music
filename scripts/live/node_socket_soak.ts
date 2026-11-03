// Node socket soak collector. It records socket sampling evidence but remains
// blocked until Node socketSoak acceptance criteria are approved.
// Usage: npx tsx scripts/live/node_socket_soak.ts
// Standard ATMUSIC_LIVE_* release/origin/prefix inputs are required. Optional
// ATMUSIC_LIVE_SOAK_HOURS defaults to 24 (integer 24..168), and
// ATMUSIC_LIVE_SOAK_POLL_S to 60 (integer 10..3600). Explicit blanks are invalid.

import { writeFileSync } from 'node:fs';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { type AdminAnswer, type AdminRequest, defaultSocketPath } from '../admin/atmusic-admin.ts';
import {
  isNodeGateMain,
  NODE_ENV,
  type NodeGateBodyResult,
  type NodeGateIO,
  type NodeGateSpec,
  runNodeGate,
} from './node-live-gate.ts';

export const SOAK_HOURS = 'ATMUSIC_LIVE_SOAK_HOURS';
export const POLL_SECONDS = 'ATMUSIC_LIVE_SOAK_POLL_S';

const LIMITATIONS = [
  'The Node verifier supports PASS only for ingest and pdsCompat; socketSoak remains blocked.',
  'Node replacement metrics and thresholds require Sol/Opus approval.',
  'Restart and Jetstream reconnect telemetry is not reliable or collected.',
  'Polling can miss short-lived transitions.',
  'Available samples indicate a JSON object response, not complete or healthy ingest telemetry; absent metrics stay null.',
  'No live 24-hour gate was executed.',
  'Admin-socket observations do not independently attest the deployed bundle identity supplied by the operator.',
];
// State names from worker/src/do/schema.ts; arbitrary keys never enter evidence.
const QUEUE_STATES = {
  outbox: ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'],
  forward: ['queued', 'sent', 'ignored', 'failed', 'expired', 'held'],
  imports: ['waiting_index', 'fetching', 'writing', 'paused', 'done', 'failed', 'cancelled'],
} as const;

/**
 * sendOverSocket has an idle timeout, so a trickling response could outlive it.
 * Isolate that existing transport in a short-lived Node worker so its socket is
 * destroyed at the total deadline, including during response-body consumption.
 * The factory is injectable for offline tests; no worker starts on import.
 */
export function createBoundedSocketSender(
  workerFactory: (source: string, options: WorkerOptions) => Worker = (source, options) => new Worker(source, options),
): SocketSoakDependencies['send'] {
  return (socketPath, request) =>
    new Promise((resolve, reject) => {
      const adminModule = new URL('../admin/atmusic-admin.ts', import.meta.url).href;
      const worker = workerFactory(
        `const { parentPort, workerData } = require('node:worker_threads');
         import(${JSON.stringify(adminModule)}).then(({ sendOverSocket }) =>
           sendOverSocket(workerData.socketPath, workerData.request)
         ).then(answer => parentPort.postMessage(answer), () => parentPort.postMessage(null));`,
        { eval: true, execArgv: [], env: {}, workerData: { socketPath, request } },
      );
      let settled = false;
      const finish = (answer: AdminAnswer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().catch(() => undefined);
        if (answer === null) reject(new Error('socket_request_failed'));
        else resolve(answer);
      };
      const timer = setTimeout(() => finish(null), request.timeoutMs);
      worker.once('message', (answer: AdminAnswer | null) => finish(answer));
      worker.once('error', () => finish(null));
      worker.once('exit', () => finish(null));
    });
}

export interface SocketSoakDependencies {
  send: (socketPath: string, request: AdminRequest) => Promise<AdminAnswer>;
  nowMs: () => number;
  wallNow: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  uid: () => number | null;
}

export const defaultSocketSoakDependencies: SocketSoakDependencies = {
  send: createBoundedSocketSender(),
  nowMs: () => performance.now(),
  wallNow: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  uid: () => process.getuid?.() ?? null,
};

const integer =
  (min: number, max: number) =>
  (value: string): string | null =>
    /^(0|[1-9]\d*)$/.test(value) && Number(value) >= min && Number(value) <= max
      ? null
      : `must be an integer from ${min} through ${max}`;

const durationIssue = integer(24, 168);
const pollIssue = integer(10, 3600);
const requirements = [
  { name: SOAK_HOURS, what: 'soak duration', optional: true, check: durationIssue },
  { name: POLL_SECONDS, what: 'poll interval', optional: true, check: pollIssue },
] as const;

function configProblem(env: Readonly<Record<string, string | undefined>>): string[] {
  const issues: string[] = [];
  for (const [name, check] of [
    [SOAK_HOURS, durationIssue],
    [POLL_SECONDS, pollIssue],
  ] as const) {
    const value = env[name];
    if (value !== undefined && check(value)) issues.push(`${name}: invalid — ${check(value)}`);
  }
  return issues;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectMetrics(value: unknown): Record<string, unknown> {
  const root = object(value);
  const ingest = object(root?.ingest);
  const indexing = object(root?.indexing);
  const hints = object(root?.hints);
  const queues = object(root?.queues);
  const metrics: Record<string, unknown> = {
    cursor: count(ingest?.cursor),
    lastEventTimeUs: count(ingest?.lastEventTimeUs),
    connected: typeof ingest?.connected === 'boolean' ? ingest.connected : null,
    pendingGap: typeof ingest?.pendingGap === 'boolean' ? ingest.pendingGap : null,
    lagSeconds: numeric(indexing?.lagSeconds),
    hintsTotal: count(hints?.total),
    hintsDue: count(hints?.due),
  };
  for (const queueName of Object.keys(QUEUE_STATES) as Array<keyof typeof QUEUE_STATES>) {
    const queue = object(queues?.[queueName]);
    const sparse: Record<string, number> = {};
    for (const state of QUEUE_STATES[queueName]) {
      const value = count(queue?.[state]);
      if (value !== null) sparse[state] = value;
    }
    metrics[`${queueName}Queue`] = Object.keys(sparse).length ? sparse : null;
  }
  return metrics;
}

function availabilityFailure(answer: AdminAnswer | null): string {
  if (answer === null) return 'socket_error';
  if (answer.status < 200 || answer.status >= 300) return 'http_status';
  return 'invalid_json';
}

function blockedEvidenceIO(io: NodeGateIO): NodeGateIO {
  const rewrite = (text: string): string => {
    try {
      const evidence = JSON.parse(text) as Record<string, unknown>;
      const wasFailure = evidence.result === 'failed';
      evidence.result = 'blocked';
      const missing = Array.isArray(evidence.missing) ? evidence.missing : [];
      evidence.missing = [
        ...missing,
        'Node socketSoak acceptance contract is not approved; gate is informational only.',
      ];
      const results = object(evidence.results) ?? {};
      const limitations = Array.isArray(results.limitations) ? results.limitations : [];
      evidence.results = {
        ...results,
        ...(wasFailure ? { collectorFailure: 'collector_error' } : {}),
        limitations: [...new Set([...limitations, ...LIMITATIONS])],
      };
      evidence.failures = undefined;
      return `${JSON.stringify(evidence, null, 2)}\n`;
    } catch {
      throw new Error('invalid_collector_evidence');
    }
  };
  return {
    stdout: (text) => io.stdout(rewrite(text)),
    stderr: () => io.stderr('BLOCKED: Node socketSoak collection cannot establish live acceptance.\n'),
    writeEvidence: (path, text) => io.writeEvidence(path, rewrite(text)),
    now: () => io.now(),
  };
}

export function createSocketSoakSpec(deps: SocketSoakDependencies = defaultSocketSoakDependencies): NodeGateSpec {
  return {
    gate: 'socketSoak',
    script: 'scripts/live/node_socket_soak.ts',
    requirements,
    extraChecks: configProblem,
    async run(context): Promise<NodeGateBodyResult> {
      const hours = Number(context.env[SOAK_HOURS] ?? '24');
      const pollMs = Number(context.env[POLL_SECONDS] ?? '60') * 1000;
      const socketPath = defaultSocketPath(context.env, deps.uid());
      const start = deps.nowMs();
      if (!Number.isFinite(start)) throw new Error('invalid_collector_clock');
      const startWall = deps.wallNow().toISOString();
      const deadline = start + hours * 60 * 60 * 1000;
      const samples: Record<string, unknown>[] = [];
      let previousAvailable: boolean | null = null;
      let connectedTransitions = 0;
      let terminalRequestTimeout = false;
      let previousSampleElapsed: number | null = null;
      let missingSamples = 0;

      while (deps.nowMs() < deadline && samples.length < Math.ceil((hours * 3600_000) / pollMs)) {
        const remaining = deadline - deps.nowMs();
        if (remaining <= 0) break;
        const timeoutMs = Math.max(1, Math.floor(Math.min(5000, remaining)));
        const at = deps.wallNow().toISOString();
        let answer: AdminAnswer | null = null;
        let timeout = false;
        let raw: unknown;
        try {
          const request = deps.send(socketPath, { method: 'GET', path: '/admin/status', body: null, timeoutMs });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const outcome = await Promise.race([
              request.then(
                (value) => ({ kind: 'answer' as const, value }),
                () => ({ kind: 'error' as const }),
              ),
              new Promise<{ kind: 'timeout' }>((resolve) => {
                timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
              }),
            ]);
            if (outcome.kind === 'answer') answer = outcome.value;
            else if (outcome.kind === 'timeout') timeout = true;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (!timeout && answer && answer.status >= 200 && answer.status < 300) {
            try {
              raw = JSON.parse(answer.body) as unknown;
            } catch {
              raw = undefined;
            }
          }
        } catch {
          answer = null;
        }
        const available =
          !timeout && answer !== null && answer.status >= 200 && answer.status < 300 && object(raw) !== null;
        const elapsedMs = deps.nowMs() - start;
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('invalid_collector_clock');
        const sample: Record<string, unknown> = { at, elapsedMs, available };
        if (previousSampleElapsed !== null) {
          const intervalMs = elapsedMs - previousSampleElapsed;
          if (intervalMs < 0) throw new Error('invalid_collector_clock');
          sample.intervalMs = intervalMs;
          sample.missedPolls = Math.max(0, Math.floor(intervalMs / pollMs) - 1);
          missingSamples += sample.missedPolls as number;
        }
        previousSampleElapsed = elapsedMs;
        if (available) {
          sample.metrics = collectMetrics(raw);
          const connected = (sample.metrics as Record<string, unknown>).connected;
          const previous = samples.at(-1);
          const previousMetrics =
            previous?.metrics !== null && typeof previous?.metrics === 'object'
              ? (previous.metrics as Record<string, unknown>)
              : null;
          if (typeof connected === 'boolean') {
            if (
              previousMetrics &&
              typeof previousMetrics.connected === 'boolean' &&
              previousMetrics.connected !== connected
            )
              connectedTransitions++;
          }
        } else {
          sample.gap = availabilityFailure(answer);
          if (timeout) {
            sample.gap = 'request_timeout';
            terminalRequestTimeout = true;
          }
        }
        if (previousAvailable !== null && previousAvailable !== available)
          sample.availabilityTransition = available ? 'recovered' : 'unavailable';
        samples.push(sample);
        previousAvailable = available;
        if (terminalRequestTimeout) break;
        const pause = Math.max(0, Math.min(pollMs, deadline - deps.nowMs()));
        if (pause > 0) {
          try {
            await deps.sleep(pause);
          } catch {
            samples.push({ at: deps.wallNow().toISOString(), available: false, gap: 'sleep_error' });
            break;
          }
        }
      }
      const elapsedMs = deps.nowMs() - start;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('invalid_collector_clock');
      return {
        pds: [],
        subjects: [],
        results: {
          requestedDurationMs: hours * 60 * 60 * 1000,
          elapsedMs,
          startedAt: startWall,
          endedAt: deps.wallNow().toISOString(),
          sampleCount: samples.length,
          missingSampleCount: missingSamples + samples.filter((sample) => !sample.available).length,
          collectionWindowElapsed: elapsedMs >= hours * 60 * 60 * 1000,
          samples,
          connectedTransitionsObserved: connectedTransitions,
          reconnectCount: null,
          restartCount: null,
          limitations: LIMITATIONS,
        },
      };
    },
  };
}

export const spec = createSocketSoakSpec();

export async function runSocketSoak(
  env: Readonly<Record<string, string | undefined>> = process.env,
  io?: NodeGateIO,
  deps: SocketSoakDependencies = defaultSocketSoakDependencies,
): Promise<number> {
  try {
    await runNodeGate(
      createSocketSoakSpec(deps),
      env,
      blockedEvidenceIO(
        io ?? {
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
          writeEvidence: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
          now: () => new Date(),
        },
      ),
    );
    return 2;
  } catch {
    const failDoc = `${JSON.stringify(
      {
        schemaVersion: 3,
        runtime: 'node',
        fixtureOnly: false,
        gate: 'socketSoak',
        result: 'blocked',
        commit: null,
        bundleSha256: null,
        recordedAt: new Date().toISOString(),
        testCommand: 'npx tsx scripts/live/node_socket_soak.ts',
        origin: null,
        lexiconPrefix: null,
        pds: [],
        subjects: [],
        results: { failure: 'collector_error', limitations: LIMITATIONS },
        cleanup: 'no changes made',
        missing: ['Collector could not emit complete evidence.'],
      },
      null,
      2,
    )}\n`;
    (io?.stdout ?? ((text: string) => process.stdout.write(text)))(failDoc);
    const evidencePath = env[NODE_ENV.evidenceOut];
    if (io && evidencePath) io.writeEvidence(evidencePath, failDoc);
    else if (evidencePath) writeFileSync(evidencePath, failDoc, { mode: '0600' });
    return 2;
  }
}

export const main = runSocketSoak;

if (isNodeGateMain(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('BLOCKED: Node socketSoak evidence output failed.\n');
      process.exitCode = 2;
    },
  );
}
