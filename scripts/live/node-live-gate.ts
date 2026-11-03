// Schema-v3 Node live gate harness (ADR 0005 §5.10, §15).
//
// This module is deliberately inert on import. A live driver supplies its
// requirements and body, then calls main(spec) only from its process entry
// point. Prerequisites are checked before the body can perform network or
// browser work; incomplete inputs always produce a blocked document and exit 2.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFixturePrefix, isValidPrefix } from '@atmusic/core/namespace';

export const NODE_EVIDENCE_SCHEMA_VERSION = 3 as const;
export const NODE_ENV = {
  origin: 'ATMUSIC_LIVE_ORIGIN',
  prefix: 'ATMUSIC_LIVE_LEXICON_PREFIX',
  commit: 'ATMUSIC_LIVE_COMMIT',
  bundleSha256: 'ATMUSIC_LIVE_BUNDLE_SHA256',
  evidenceOut: 'ATMUSIC_LIVE_EVIDENCE_OUT',
} as const;

export type NodeGateName = 'oauth' | 'ingest' | 'pdsCompat' | 'ssrfProbe' | 'socketSoak';
export type NodeGateResult = 'passed' | 'failed' | 'blocked';
export type NodeGateEnv = Readonly<Record<string, string | undefined>>;

export interface NodeGateRequirement {
  name: string;
  what: string;
  optional?: boolean;
  check?: (value: string, env: NodeGateEnv) => string | null;
}

export interface NodePdsInfo {
  endpoint: string;
  implementation: string;
  version: string;
}

export interface NodeSubject {
  did: string;
  uri: string | null;
  expectedUri?: string | null;
  route?: string;
  unresolved?: boolean;
  operationId?: string;
  deleteOperationId?: string;
  idempotencyKey?: string;
  rkey?: string;
  operationState?: string;
}

export interface NodeGateBodyResult {
  pds: NodePdsInfo[];
  subjects: NodeSubject[];
  results: Record<string, unknown>;
}

export interface NodeGateEvidence {
  schemaVersion: typeof NODE_EVIDENCE_SCHEMA_VERSION;
  runtime: 'node';
  fixtureOnly: false;
  gate: NodeGateName;
  result: NodeGateResult;
  commit: string | null;
  bundleSha256: string | null;
  recordedAt: string;
  testCommand: string;
  origin: string | null;
  lexiconPrefix: string | null;
  pds: NodePdsInfo[];
  subjects: NodeSubject[];
  results: Record<string, unknown>;
  cleanup: string;
  missing?: string[];
  failures?: string[];
}

export interface NodeGateContext {
  env: NodeGateEnv;
  get(name: string): string;
  origin: string;
  lexiconPrefix: string;
  log(message: string): void;
  fail(message: string): void;
  cleanup(message: string): void;
}

export interface NodeGateSpec {
  gate: NodeGateName;
  script: string;
  requirements: readonly NodeGateRequirement[];
  extraChecks?: (env: NodeGateEnv) => string[];
  run(context: NodeGateContext): Promise<NodeGateBodyResult>;
}

export interface NodeGateIO {
  stdout(text: string): void;
  stderr(text: string): void;
  writeEvidence(path: string, text: string): void;
  now(): Date;
}

export const NODE_EXIT_CODES: Readonly<Record<NodeGateResult, number>> = {
  passed: 0,
  failed: 1,
  blocked: 2,
};

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const OWNED_PREFIX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const RESERVED_SUFFIXES = new Set(['example', 'invalid', 'test', 'localhost', 'local', 'onion', 'arpa', 'internal']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const SECRET_NAME = /(TOKEN|PASSWORD|SECRET|PRIVATE_KEY)/i;

function nonzeroHex(value: string, expression: RegExp): boolean {
  return expression.test(value) && /[1-9a-f]/.test(value);
}

function publicOriginProblem(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'must be https';
  if (parsed.username || parsed.password) return 'must not carry credentials';
  if (parsed.port) return 'must use the default port';
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || !/^https:\/\/[^/]+\/?$/.test(value)) {
    return 'must be an origin (no path or query)';
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || IPV4.test(host)) return 'must be a DNS name, not an IP literal';
  const labels = host.split('.');
  if (labels.length < 2) return 'must be a public DNS name';
  if (RESERVED_SUFFIXES.has(labels.at(-1) ?? '')) return 'reserved or non-public name';
  if (RESERVED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return 'reserved example domain';
  }
  return null;
}

const IDENTITY_AND_RELEASE: readonly NodeGateRequirement[] = [
  {
    name: NODE_ENV.commit,
    what: 'full nonzero source commit SHA for the deployed Node release',
    check: (value) => (nonzeroHex(value, COMMIT) ? null : 'must be a nonzero full 40-hex commit'),
  },
  {
    name: NODE_ENV.bundleSha256,
    what: 'SHA-256 of the deployed production worker/dist/node/main.mjs bytes',
    check: (value) => (nonzeroHex(value, SHA256) ? null : 'must be a nonzero 64-hex SHA-256'),
  },
  {
    name: NODE_ENV.origin,
    what: 'deployed public HTTPS origin',
    check: publicOriginProblem,
  },
  {
    name: NODE_ENV.prefix,
    what: 'owned production lexicon prefix',
    check: (value) => {
      if (!isValidPrefix(value) || !OWNED_PREFIX.test(value)) return 'not a valid NSID prefix';
      if (isFixturePrefix(value) || /^(com|org|net)\.example\./.test(value)) {
        return 'fixture/example prefix is never live';
      }
      return null;
    },
  },
];

function missingRequirements(env: NodeGateEnv, requirements: readonly NodeGateRequirement[]): string[] {
  const missing: string[] = [];
  for (const requirement of requirements) {
    const value = env[requirement.name];
    if (value === undefined || value === '') {
      if (!requirement.optional) missing.push(`${requirement.name}: missing — ${requirement.what}`);
      continue;
    }
    const issue = requirement.check?.(value, env);
    if (issue) missing.push(`${requirement.name}: invalid — ${issue}`);
  }
  return missing;
}

function secretValues(env: NodeGateEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

function redactJsonValue(value: unknown, env: NodeGateEnv, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactNodeGateOutput(value, env);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toJSON();
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  let redacted: unknown;
  if (Array.isArray(value)) {
    redacted = value.map((item) => redactJsonValue(item, env, ancestors));
  } else {
    redacted = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactNodeGateOutput(key, env),
        redactJsonValue(item, env, ancestors),
      ]),
    );
  }
  ancestors.delete(value);
  return redacted;
}

export function redactNodeGateOutput(text: string, env: NodeGateEnv): string {
  let redacted = text;
  for (const secret of secretValues(env)) redacted = redacted.split(secret).join('[redacted]');
  redacted = redacted.replace(/https?%3a%2f%2f[^\s"'<>]+/gi, '[redacted-url]');
  redacted = redacted.replace(/https?:\/\/[^\s"'<>\\]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;\]}]+$/)?.[0] ?? '';
    const value = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      const url = new URL(value);
      const hadRootSlash = url.pathname === '/' && !value.endsWith('/');
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      const safe = hadRootSlash ? url.origin : url.href;
      return `${safe}${trailing}`;
    } catch {
      return '[redacted-url]';
    }
  });
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]');
  redacted = redacted.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]');
  return redacted;
}

const processIO: NodeGateIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeEvidence: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  now: () => new Date(),
};

function evidenceBase(spec: NodeGateSpec, io: NodeGateIO) {
  return {
    schemaVersion: NODE_EVIDENCE_SCHEMA_VERSION,
    runtime: 'node' as const,
    fixtureOnly: false as const,
    gate: spec.gate,
    recordedAt: io.now().toISOString(),
    testCommand: `npx tsx ${spec.script}`,
  };
}

function validValue(env: NodeGateEnv, name: string, requirement: NodeGateRequirement): string | null {
  const value = env[name];
  if (value === undefined || value === '' || requirement.check?.(value, env)) return null;
  return value;
}

function emit(evidence: NodeGateEvidence, env: NodeGateEnv, io: NodeGateIO): number {
  const safeEvidence = redactJsonValue(evidence, env);
  const document = redactNodeGateOutput(`${JSON.stringify(safeEvidence, null, 2)}\n`, env);
  io.stdout(document);
  const evidencePath = env[NODE_ENV.evidenceOut];
  if (evidencePath) io.writeEvidence(evidencePath, document);
  const headline =
    evidence.result === 'passed'
      ? `PASS: ${evidence.gate} Node live gate passed for commit ${evidence.commit}`
      : evidence.result === 'failed'
        ? `FAIL: ${evidence.gate} Node live gate failed`
        : `BLOCKED: ${evidence.gate} Node live gate prerequisites are missing; no live request was made`;
  const details = [...(evidence.missing ?? []), ...(evidence.failures ?? [])].map((line) => `- ${line}`);
  io.stderr(redactNodeGateOutput(`${[headline, ...details].join('\n')}\n`, env));
  return NODE_EXIT_CODES[evidence.result];
}

/** Validate all inputs before invoking an injected body, then emit one v3 document. */
export async function runNodeGate(
  spec: NodeGateSpec,
  env: NodeGateEnv = process.env,
  io: NodeGateIO = processIO,
): Promise<number> {
  const base = evidenceBase(spec, io);
  const requirements = [...IDENTITY_AND_RELEASE, ...spec.requirements];
  const missing = [...missingRequirements(env, requirements), ...(spec.extraChecks?.(env) ?? [])];
  if (missing.length > 0) {
    const commit = validValue(env, NODE_ENV.commit, IDENTITY_AND_RELEASE[0]!);
    const bundleSha256 = validValue(env, NODE_ENV.bundleSha256, IDENTITY_AND_RELEASE[1]!);
    const originValue = validValue(env, NODE_ENV.origin, IDENTITY_AND_RELEASE[2]!);
    const prefix = validValue(env, NODE_ENV.prefix, IDENTITY_AND_RELEASE[3]!);
    const evidence: NodeGateEvidence = {
      ...base,
      result: 'blocked',
      commit,
      bundleSha256,
      origin: originValue === null ? null : new URL(originValue).origin,
      lexiconPrefix: prefix,
      pds: [],
      subjects: [],
      results: {},
      cleanup: 'nothing to clean up: no live request was made',
      missing,
    };
    return emit(evidence, env, io);
  }

  const get = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  const failures: string[] = [];
  const cleanupNotes: string[] = [];
  const context: NodeGateContext = {
    env,
    get,
    origin: new URL(get(NODE_ENV.origin)).origin,
    lexiconPrefix: get(NODE_ENV.prefix),
    log: (message) => io.stderr(redactNodeGateOutput(`${message}\n`, env)),
    fail: (message) => failures.push(message),
    cleanup: (message) => cleanupNotes.push(message),
  };

  let body: NodeGateBodyResult = { pds: [], subjects: [], results: {} };
  try {
    body = await spec.run(context);
  } catch (error) {
    failures.push(
      error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error),
    );
  }

  const evidence: NodeGateEvidence = {
    ...base,
    result: failures.length > 0 ? 'failed' : 'passed',
    commit: get(NODE_ENV.commit),
    bundleSha256: get(NODE_ENV.bundleSha256),
    origin: context.origin,
    lexiconPrefix: context.lexiconPrefix,
    pds: body.pds,
    subjects: body.subjects,
    results: body.results,
    cleanup: cleanupNotes.length > 0 ? cleanupNotes.join('; ') : 'nothing created',
    ...(failures.length > 0 ? { failures } : {}),
  };
  return emit(evidence, env, io);
}

/** True when the caller is the process entry point; safe to use at module scope. */
export function isNodeGateMain(metaUrl: string): boolean {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/** CLI adapter; importing the module never invokes this function. */
export function mainNodeGate(spec: NodeGateSpec): void {
  runNodeGate(spec).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      process.stderr.write(redactNodeGateOutput(`FAIL: ${spec.gate} Node harness error: ${detail}\n`, process.env));
      process.exitCode = NODE_EXIT_CODES.failed;
    },
  );
}
