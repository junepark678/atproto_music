// Node live gate: SSRF probe of the Node pinned transport (ADR 0005 §8 SSRF;
// N6-02, schema v3).
//
// Usage:
//   npx tsx scripts/live/ssrf_probe.ts --emit-probe [dir]   (writes the Node probe script; no network)
//   npx tsx scripts/live/ssrf_probe.ts                      (evaluates a recorded probe result; no network)
//
// The Node host resolves DNS itself and pins every connection to the checked
// address (worker/src/node/pinned-transport.ts), so there is no Workers-style
// DoH residual. What this gate records is that the production pinned transport,
// running on the host behind the deployed origin, refuses RFC 1918, loopback
// and cloud-metadata destinations by policy, and that a refusal is a policy
// refusal: not a DNS failure, not a timeout, not the unpinned-fetch stub.
//
// The probe is a small Node script the operator runs on that host.
// `--emit-probe` writes it (default work/ssrf-probe-node, inside the
// repository so it imports the same pinned transport the server bundles) and
// prints the command to run; emission touches no network. The emitted probe,
// when the operator explicitly runs it, builds the production transport
// (system lookup, TLS connector, DEFAULT_PINNED_CAPS), requests `https://<host>/`
// for each target through it and writes a result file with one outcome per
// target: `refused` with the policy reason, or `dns`, `timeout`,
// `unpinned_fetch`, `connect`, `fetched` (with the status) and so on. It records
// only outcome, code, message, elapsed time and the resolved addresses; never
// bodies or headers, so a metadata service's answer cannot leak through it.
//
// Targets: the operator's controlled DNS names (ATMUSIC_LIVE_SSRF_HOSTS,
// `label=host` pairs; the labels rfc1918, loopback and metadata are required)
// plus the matching IP literals. Each controlled name must resolve only to
// addresses of its label's class; a name that resolves to a mixed or
// unexpected address set fails the gate, so a misconfigured name cannot
// produce a false pass.
//
// The gate itself (`npx tsx scripts/live/ssrf_probe.ts`) reads the result file
// named by ATMUSIC_LIVE_SSRF_PROBE_RESULT, checks it against the configured
// hosts and origin, and passes only when every target was refused by policy.
// Without the prerequisites it prints `blocked` with each missing variable and
// exits 2 before reading anything. Evidence for this gate stays blocked in the
// verifier until the probe contract is approved (docs/verification/node-live.md).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyIpv4, classifyIpv6, parseIpv4, parseIpv6 } from '@atmusic/atproto/net/url-policy';
import type { Transport } from '@atmusic/atproto/transport';
import { isTransportError, type PinnedLookup, type PinnedTransportCaps } from '@atmusic/worker/node/pinned-transport';
import {
  isNodeGateMain,
  mainNodeGate,
  type NodeGateBodyResult,
  type NodeGateContext,
  type NodeGateRequirement,
  type NodeGateSpec,
} from './node-live-gate.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SSRF_ENV = {
  hosts: 'ATMUSIC_LIVE_SSRF_HOSTS',
  probeResult: 'ATMUSIC_LIVE_SSRF_PROBE_RESULT',
} as const;

export const PROBE_RESULT_SCHEMA_VERSION = 1 as const;
export const PROBE_RESULT_KIND = 'atmusic.ssrfProbe.node' as const;

/** Address classes the probe distinguishes; only the first three are target labels. */
export type AddressClass =
  | 'rfc1918'
  | 'loopback'
  | 'metadata'
  | 'linkLocal'
  | 'cgnat'
  | 'ula'
  | 'public'
  | 'documentation'
  | 'other';

export const REQUIRED_LABELS = ['rfc1918', 'loopback', 'metadata'] as const;
export type RequiredLabel = (typeof REQUIRED_LABELS)[number];

/** IP literals probed beside the controlled names, one per required label. */
export const LITERAL_TARGETS: Readonly<Record<RequiredLabel, string>> = Object.freeze({
  rfc1918: '10.0.0.1',
  loopback: '127.0.0.1',
  metadata: '169.254.169.254',
});

export type ProbeOutcomeKind =
  | 'refused'
  | 'dns'
  | 'timeout'
  | 'unpinned_fetch'
  | 'connect'
  | 'too_large'
  | 'redirect'
  | 'fetched'
  | 'error';

export interface ProbeTarget {
  label: string;
  host: string;
  kind: 'controlledName' | 'literal';
}

export interface ProbeAttempt {
  url: string;
  outcome: ProbeOutcomeKind;
  code: string;
  message: string;
  elapsedMs: number;
}

export interface ProbeResolution {
  addresses: string[];
  classes: AddressClass[];
  error?: string;
}

export interface ProbeOutcome {
  target: ProbeTarget;
  resolved: ProbeResolution;
  raw: ProbeAttempt[];
  /** The pinned transport's verdict; the key name is the verifier's evidence contract. */
  safeFetch: { outcome: ProbeOutcomeKind; code: string };
}

export interface ProbeResult {
  schemaVersion: typeof PROBE_RESULT_SCHEMA_VERSION;
  kind: typeof PROBE_RESULT_KIND;
  recordedAt: string;
  hostname: string;
  origin: string;
  transport: 'pinned';
  caps: PinnedTransportCaps;
  hosts: Record<string, string>;
  targets: ProbeOutcome[];
}

// ---------------------------------------------------------------------------
// Host parsing (strict: one canonical textual form per host, nothing ambiguous)

const LABEL = /^[a-z][a-z0-9]{0,31}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ASCII = /^[\x21-\x7e]*$/;

/** Why `host` is not an acceptable controlled DNS name, or null when it is. */
export function hostnameProblem(host: string): string | null {
  if (host === '') return 'empty host';
  if (!ASCII.test(host)) return 'host must be printable ASCII without whitespace';
  if (host !== host.toLowerCase()) return 'host must be lowercase';
  if (/[%[\]@:/\\?#]/.test(host))
    return 'host must be a bare DNS name (no scheme, port, path, brackets, zone or userinfo)';
  if (host.endsWith('.')) return 'trailing dot';
  if (host.length > 253) return 'host too long';
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) return 'IP literal where a DNS name is required';
  const labels = host.split('.');
  if (labels.length < 2) return 'single-label host';
  if (!labels.every((label) => HOST_LABEL.test(label))) return 'malformed DNS label';
  if (/^\d+$/.test(labels[labels.length - 1] as string)) return 'numeric top-level label';
  if (labels[labels.length - 1] === 'localhost') return 'localhost is not a controlled name';
  return null;
}

/** Parse `label=host,label=host` (the required labels must be present); throws on any defect. */
export function parseHosts(text: string): Record<string, string> {
  const hosts: Record<string, string> = {};
  const seen = new Set<string>();
  const entries = text.split(',');
  for (const entry of entries) {
    if (entry === '') throw new Error('empty entry in host list');
    if (entry !== entry.trim()) throw new Error(`entry ${JSON.stringify(entry)} has surrounding whitespace`);
    const eq = entry.indexOf('=');
    if (eq < 0) throw new Error(`entry ${JSON.stringify(entry)} is not label=host`);
    const label = entry.slice(0, eq);
    const host = entry.slice(eq + 1);
    if (!LABEL.test(label)) throw new Error(`label ${JSON.stringify(label)} must match ${LABEL}`);
    if (label in hosts) throw new Error(`duplicate label ${label}`);
    const problem = hostnameProblem(host);
    if (problem !== null) throw new Error(`host for ${label}: ${problem}`);
    if (seen.has(host)) throw new Error(`host ${host} listed twice`);
    seen.add(host);
    hosts[label] = host;
  }
  for (const label of REQUIRED_LABELS) {
    if (!(label in hosts)) throw new Error(`missing required label ${label}`);
  }
  return hosts;
}

export const SSRF_REQS: readonly NodeGateRequirement[] = [
  {
    name: SSRF_ENV.hosts,
    what: 'controlled DNS names as label=host pairs (labels rfc1918, loopback, metadata required)',
    check: (value) => {
      try {
        parseHosts(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  },
  {
    name: SSRF_ENV.probeResult,
    what: 'absolute path of the result file the emitted Node probe wrote on the origin host',
    check: (value) => {
      if (!isAbsolute(value)) return 'must be an absolute path';
      if (!existsSync(value)) return 'file does not exist';
      if (!statSync(value).isFile()) return 'not a regular file';
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Address classification (strict textual forms only; anything else is `other`)

function bare(ip: string): string {
  return ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
}

function ipv4Class(o: Uint8Array): AddressClass {
  const a = o[0] as number;
  const b = o[1] as number;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return o[2] === 169 && o[3] === 254 ? 'metadata' : 'linkLocal';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'rfc1918';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  const cls = classifyIpv4(o);
  return cls === 'blocked' ? 'other' : cls;
}

/** Classify one textual address. Decimal, octal, hex, short IPv4 forms and zoned IPv6 are `other`. */
export function addressClass(ip: string): AddressClass {
  const text = bare(ip);
  const v4 = parseIpv4(text);
  if (v4) return ipv4Class(v4);
  const v6 = parseIpv6(text);
  if (!v6) return 'other';
  const s0 = v6[0] as number;
  if (v6.every((g, i) => g === (i === 7 ? 1 : 0))) return 'loopback';
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
    const s6 = v6[6] as number;
    const s7 = v6[7] as number;
    return ipv4Class(new Uint8Array([s6 >> 8, s6 & 0xff, s7 >> 8, s7 & 0xff]));
  }
  // fd00:ec2::254 is the EC2 IMDS IPv6 endpoint.
  if (s0 === 0xfd00 && v6[1] === 0x0ec2 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0)
    return v6[7] === 0x254 ? 'metadata' : 'ula';
  if ((s0 & 0xfe00) === 0xfc00) return 'ula';
  if ((s0 & 0xffc0) === 0xfe80) return 'linkLocal';
  const cls = classifyIpv6(v6);
  return cls === 'blocked' ? 'other' : cls;
}

/** The address class a target label demands of every resolved address. */
export function labelClass(label: string): AddressClass | null {
  return (REQUIRED_LABELS as readonly string[]).includes(label) ? (label as AddressClass) : null;
}

export function probeTargetsFor(hosts: Record<string, string>): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  for (const [label, host] of Object.entries(hosts)) targets.push({ label, host, kind: 'controlledName' });
  for (const label of REQUIRED_LABELS) targets.push({ label, host: LITERAL_TARGETS[label], kind: 'literal' });
  return targets;
}

// ---------------------------------------------------------------------------
// Probe runner (shared by the emitted probe and the offline tests)

export interface ProbeOptions {
  transport: Transport;
  /** Records what each controlled name resolves to; omitted → no resolution step. */
  lookup?: PinnedLookup;
  now?: () => number;
}

function targetUrl(host: string): string {
  return `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

async function resolveTarget(target: ProbeTarget, lookup: PinnedLookup | undefined): Promise<ProbeResolution> {
  if (target.kind === 'literal') return { addresses: [target.host], classes: [addressClass(target.host)] };
  if (lookup === undefined) return { addresses: [], classes: [] };
  try {
    const answers = await lookup(target.host);
    const addresses = answers.map((answer) => String(answer.address));
    return { addresses, classes: addresses.map(addressClass) };
  } catch (error) {
    return { addresses: [], classes: [], error: errorCode(error) };
  }
}

async function attempt(url: string, transport: Transport, now: () => number): Promise<ProbeAttempt> {
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  try {
    const response = await transport(new Request(url, { method: 'GET', redirect: 'manual' }));
    await response.body?.cancel().catch(() => undefined);
    return {
      url,
      outcome: 'fetched',
      code: `status_${response.status}`,
      message: `request reached a server (HTTP ${response.status})`,
      elapsedMs: elapsed(),
    };
  } catch (error) {
    if (isTransportError(error)) {
      const code = error.reason ?? error.code;
      const outcome: ProbeOutcomeKind = error.code === 'blocked_address' ? 'refused' : error.code;
      return { url, outcome, code, message: error.message, elapsedMs: elapsed() };
    }
    return {
      url,
      outcome: 'error',
      code: errorCode(error),
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      elapsedMs: elapsed(),
    };
  }
}

/** Request `https://<host>/` for each target through `transport` and record the verdicts. */
export async function probeTargets(targets: readonly ProbeTarget[], options: ProbeOptions): Promise<ProbeOutcome[]> {
  const now = options.now ?? (() => performance.now());
  const outcomes: ProbeOutcome[] = [];
  for (const target of targets) {
    const resolved = await resolveTarget(target, options.lookup);
    const raw = [await attempt(targetUrl(target.host), options.transport, now)];
    const last = raw[raw.length - 1] as ProbeAttempt;
    outcomes.push({ target, resolved, raw, safeFetch: { outcome: last.outcome, code: last.code } });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Result validation (offline; the gate body)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Problems with a recorded probe result against the configured hosts and origin; empty when it is acceptable. */
export function checkProbeResult(result: unknown, hosts: Record<string, string>, origin: string): string[] {
  const problems: string[] = [];
  if (!isRecord(result)) return ['probe result is not a JSON object'];
  if (result.schemaVersion !== PROBE_RESULT_SCHEMA_VERSION)
    problems.push(
      `probe result schemaVersion ${JSON.stringify(result.schemaVersion)} != ${PROBE_RESULT_SCHEMA_VERSION}`,
    );
  if (result.kind !== PROBE_RESULT_KIND)
    problems.push(`probe result kind ${JSON.stringify(result.kind)} != ${PROBE_RESULT_KIND}`);
  if (result.transport !== 'pinned') problems.push(`probe transport ${JSON.stringify(result.transport)} != pinned`);
  if (typeof result.recordedAt !== 'string' || Number.isNaN(Date.parse(result.recordedAt)))
    problems.push('probe result recordedAt is not a timestamp');
  if (typeof result.origin !== 'string' || safeOrigin(result.origin) !== origin)
    problems.push(`probe origin ${JSON.stringify(result.origin)} != ${origin}`);
  if (!isRecord(result.hosts) || JSON.stringify(sorted(result.hosts)) !== JSON.stringify(sorted(hosts)))
    problems.push(`probe hosts ${JSON.stringify(result.hosts)} != ${JSON.stringify(hosts)}`);
  if (problems.length > 0) return problems;

  const expected = probeTargetsFor(hosts);
  const targets = Array.isArray(result.targets) ? result.targets : null;
  if (targets === null) return ['probe result has no targets list'];
  const seen = new Set<string>();
  for (const [index, entry] of targets.entries()) {
    const where = `targets[${index}]`;
    if (!isRecord(entry) || !isRecord(entry.target) || !isRecord(entry.safeFetch) || !isRecord(entry.resolved)) {
      problems.push(`${where}: malformed target entry`);
      continue;
    }
    const { label, host, kind } = entry.target;
    const key = `${kind}:${label}:${host}`;
    if (!expected.some((t) => t.kind === kind && t.label === label && t.host === host)) {
      problems.push(`${where}: ${key} is not a configured target`);
      continue;
    }
    if (seen.has(key)) problems.push(`${where}: ${key} recorded twice`);
    seen.add(key);
    if (!Array.isArray(entry.raw) || entry.raw.length === 0) problems.push(`${where} ${key}: no recorded attempt`);
    const outcome = entry.safeFetch.outcome;
    const code = entry.safeFetch.code;
    if (outcome !== 'refused') {
      problems.push(
        `${where} ${key}: pinned transport outcome ${JSON.stringify(outcome)} (${String(code)}) is not a policy refusal`,
      );
    } else if (code !== (kind === 'literal' ? 'private_literal' : 'private_answer')) {
      problems.push(`${where} ${key}: refused for ${String(code)}, not for its address`);
    }
    const want = labelClass(String(label));
    const classes = Array.isArray(entry.resolved.classes) ? entry.resolved.classes.map(String) : [];
    if (kind === 'controlledName') {
      if (classes.length === 0) problems.push(`${where} ${key}: no resolved addresses recorded`);
      else if (want !== null && classes.some((cls) => cls !== want))
        problems.push(`${where} ${key}: resolves to ${classes.join(',')}; every address must be ${want}`);
    }
  }
  for (const t of expected) {
    const key = `${t.kind}:${t.label}:${t.host}`;
    if (!seen.has(key)) problems.push(`target ${key} is not in the probe result`);
  }
  return problems;
}

function safeOrigin(text: string): string | null {
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

function sorted(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function run(ctx: NodeGateContext): Promise<NodeGateBodyResult> {
  const hosts = parseHosts(ctx.get(SSRF_ENV.hosts));
  const path = ctx.get(SSRF_ENV.probeResult);
  let result: unknown;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    ctx.fail(`probe result ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return { pds: [], subjects: [], results: {} };
  }
  const problems = checkProbeResult(result, hosts, ctx.origin);
  for (const problem of problems) ctx.fail(problem);
  const record = isRecord(result) ? result : {};
  ctx.log(
    `probe result ${path}: ${problems.length === 0 ? 'every target refused by policy' : `${problems.length} problem(s)`}`,
  );
  return {
    pds: [],
    subjects: [],
    results: {
      targets: Array.isArray(record.targets) ? record.targets : [],
      probe: {
        recordedAt: record.recordedAt ?? null,
        hostname: record.hostname ?? null,
        transport: record.transport ?? null,
        caps: record.caps ?? null,
        resultPath: path,
      },
    },
  };
}

export const spec: NodeGateSpec = {
  gate: 'ssrfProbe',
  script: 'scripts/live/ssrf_probe.ts',
  requirements: SSRF_REQS,
  run,
};

// ---------------------------------------------------------------------------
// --emit-probe: the Node probe script the operator runs on the origin host

export const DEFAULT_PROBE_DIR = 'work/ssrf-probe-node';

/** Argument parsing shared with the emitted probe (which has no gate env of its own). */
export function parseProbeArgs(argv: readonly string[]): {
  origin: string;
  hosts: Record<string, string>;
  out: string;
} {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!['--origin', '--hosts', '--out'].includes(name)) throw new Error(`unknown argument ${arg}`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new Error(`${name} needs a value`);
    values[name] = value;
  }
  for (const name of ['--origin', '--hosts', '--out']) if (!(name in values)) throw new Error(`${name} is required`);
  const originText = values['--origin'] as string;
  const origin = safeOrigin(originText);
  if (origin === null || !originText.startsWith('https://')) throw new Error('--origin must be an https URL');
  const out = values['--out'] as string;
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path');
  return { origin, hosts: parseHosts(values['--hosts'] as string), out };
}

function posixRelative(from: string, to: string): string {
  const rel = relative(from, to).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function probeSource(dir: string): string {
  const gateModule = posixRelative(dir, resolve(REPO_ROOT, 'scripts/live/ssrf_probe.ts'));
  return `// SSRF probe of the Node pinned transport. Written by
// \`npx tsx scripts/live/ssrf_probe.ts --emit-probe\`; run it on the host behind
// the deployed origin:
//
//   npx tsx ${posixRelative(REPO_ROOT, resolve(dir, 'probe.ts'))} --origin <origin> --hosts <label=host,...> --out <result.json>
//
// It builds the production pinned transport (system lookup, TLS connector,
// DEFAULT_PINNED_CAPS), requests https://<host>/ for every controlled name and
// IP literal through it, and writes one outcome per target. Only outcome,
// code, message, elapsed time and resolved addresses are recorded.
// This file makes network requests only when run explicitly.

import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  DEFAULT_PINNED_CAPS,
  pinnedTransport,
  systemLookup,
  tlsSocketConnector,
} from '@atmusic/worker/node/pinned-transport';
import {
  parseProbeArgs,
  PROBE_RESULT_KIND,
  PROBE_RESULT_SCHEMA_VERSION,
  type ProbeResult,
  probeTargets,
  probeTargetsFor,
} from '${gateModule}';

const { origin, hosts, out } = parseProbeArgs(process.argv.slice(2));
const transport = pinnedTransport({ caps: DEFAULT_PINNED_CAPS, lookup: systemLookup, connector: tlsSocketConnector });
try {
  const targets = await probeTargets(probeTargetsFor(hosts), { transport, lookup: systemLookup });
  const result: ProbeResult = {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    kind: PROBE_RESULT_KIND,
    recordedAt: new Date().toISOString(),
    hostname: hostname(),
    origin,
    transport: 'pinned',
    caps: { ...DEFAULT_PINNED_CAPS },
    hosts,
    targets,
  };
  writeFileSync(out, \`\${JSON.stringify(result, null, 2)}\\n\`);
  for (const t of targets) {
    console.error(\`\${t.target.kind} \${t.target.label} \${t.target.host}: \${t.safeFetch.outcome} (\${t.safeFetch.code})\`);
  }
  console.log(\`wrote \${out}\`);
  process.exitCode = targets.every((t) => t.safeFetch.outcome === 'refused') ? 0 : 1;
} finally {
  await transport.close();
}
`;
}

/** Write the probe script into `dir` (inside the repository); returns the path written. No network. */
export function emitProbe(dir: string): string {
  const target = resolve(REPO_ROOT, dir);
  const inside = relative(REPO_ROOT, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`probe directory must be inside the repository (${REPO_ROOT}), got ${target}`);
  }
  mkdirSync(target, { recursive: true });
  const path = resolve(target, 'probe.ts');
  writeFileSync(path, probeSource(target));
  return path;
}

export function emitMain(dir: string, stdout: (text: string) => void): void {
  const path = emitProbe(dir);
  stdout(`wrote ${path}\n`);
  stdout(
    [
      '',
      'Copy the repository to the host behind the deployed origin (or run there from a checkout), then:',
      `  npx tsx ${posixRelative(REPO_ROOT, path)} \\`,
      '    --origin https://<deployed origin> \\',
      `    --hosts "$${SSRF_ENV.hosts}" \\`,
      '    --out /abs/path/ssrf-probe-result.json',
      '',
      `Then set ${SSRF_ENV.probeResult} to that file and run: npx tsx scripts/live/ssrf_probe.ts`,
      'The probe makes network requests only when run explicitly; this command made none.',
      '',
    ].join('\n'),
  );
}

if (isNodeGateMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--emit-probe') {
    if (args.length > 2) {
      process.stderr.write('usage: ssrf_probe.ts --emit-probe [dir]\n');
      process.exitCode = 2;
    } else {
      emitMain(args[1] ?? DEFAULT_PROBE_DIR, (text) => process.stdout.write(text));
    }
  } else if (args.length > 0) {
    process.stderr.write(`unknown arguments: ${args.join(' ')}\n`);
    process.exitCode = 2;
  } else {
    mainNodeGate(spec);
  }
}
