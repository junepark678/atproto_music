// Shared harness for the W6-05 live gates (ADR 0004 §10.4, §13; TESTING.md
// "Live compatibility gates"; docs/verification/workers-live.md).
//
// Every gate script (workers_oauth_check, workers_ingest_check,
// pds_compat_check, ssrf_probe, workers_socket_soak) runs through runGate():
//
// 1. Prerequisites are read from the environment only (never argv, never a
//    file in the repository). Each missing or invalid one is listed by name.
//    If any is missing the gate prints a `blocked` result and exits 2 before
//    it makes a single network request or launches a browser.
// 2. Otherwise the gate body runs against the operator's deployment and real
//    PDSs. A body that completes without failures is `passed` (exit 0); any
//    failure, thrown or recorded, is `failed` (exit 1).
// 3. The result is one JSON evidence document (schemaVersion 2) on stdout,
//    and in ATMUSIC_LIVE_EVIDENCE_OUT when that is set. It carries the Worker
//    version id and bundle SHA-256 (A19), the commit, the date, the PDS
//    implementation and version, the DIDs and AT URIs used, the results and
//    the cleanup outcome. scripts/verify_live_evidence.py checks it.
//
// Secrets (ADMIN_TOKEN, account passwords, the Cloudflare API token) are
// redacted from everything the harness prints. Tokens and OAuth codes are
// never recorded: gates extract only the facts they need (a granted scope,
// a DID, a CID).
//
// Record verification uses the production verifier unchanged
// (@atmusic/atproto verify/record-proof over SafeFetch with the DoH
// pre-check, a fresh identity resolution and the current #atproto key).

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isFixturePrefix, isValidPrefix } from '@atmusic/core/namespace';
import { isSupportedDid } from '@atmusic/core/syntax';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVIDENCE_SCHEMA_VERSION = 2;

export type GateName = 'oauth' | 'ingest' | 'pdsCompat' | 'ssrfProbe' | 'socketSoak';
export type GateOutcome = 'passed' | 'failed' | 'blocked';
export const EXIT_CODES: Readonly<Record<GateOutcome, number>> = { passed: 0, failed: 1, blocked: 2 };

export type EnvMap = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Prerequisite names. Every gate lists the subset it needs.

export const ENV = {
  origin: 'ATMUSIC_LIVE_ORIGIN',
  prefix: 'ATMUSIC_LIVE_LEXICON_PREFIX',
  versionId: 'ATMUSIC_LIVE_WORKER_VERSION_ID',
  bundleSha256: 'ATMUSIC_LIVE_BUNDLE_SHA256',
  commit: 'ATMUSIC_LIVE_COMMIT',
  didA: 'ATMUSIC_LIVE_DID_A',
  pdsA: 'ATMUSIC_LIVE_PDS_A',
  didB: 'ATMUSIC_LIVE_DID_B',
  pdsB: 'ATMUSIC_LIVE_PDS_B',
  pdsIndependenceRef: 'ATMUSIC_LIVE_PDS_INDEPENDENCE_REF',
  jetstreamCoverageRef: 'ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF',
  adminToken: 'ATMUSIC_LIVE_ADMIN_TOKEN',
  evidenceOut: 'ATMUSIC_LIVE_EVIDENCE_OUT',
} as const;

/** Environment names whose values are secrets: redacted from all output. */
export const SECRET_ENV = /(TOKEN|PASSWORD|SECRET)/;

export interface Requirement {
  name: string;
  /** What the operator must supply, printed when it is missing. */
  what: string;
  optional?: boolean;
  /** A reason the supplied value is unusable, or null. */
  check?: (value: string, env: EnvMap) => string | null;
}

const RESERVED_SUFFIXES = ['example', 'invalid', 'test', 'localhost', 'local', 'onion', 'arpa', 'internal'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
/** Fixture DIDs used by tests/fixtures and the test-support kit; never live identities. */
export const FIXTURE_DIDS: ReadonlySet<string> = new Set(
  ['a', 'b', 'c', 'd', 'e'].map((letter) => `did:plc:${letter.repeat(24)}`),
);

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A public, default-port HTTPS URL on a DNS name; `origin` also forbids a path or query. */
export function publicHttpsProblem(value: string, origin: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'must be https';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.port !== '') return 'must use the default port';
  if (url.hash) return 'must not have a fragment';
  if (origin && (url.pathname !== '/' || url.search || !/^https:\/\/[^/]+\/?$/.test(value))) {
    return 'must be an origin (no path or query)';
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || IPV4_LITERAL.test(host)) return 'must be a DNS name, not an IP literal';
  const labels = host.split('.');
  if (labels.length < 2) return 'must be a public DNS name';
  if (RESERVED_SUFFIXES.includes(labels[labels.length - 1]!)) return 'reserved or non-public name';
  if (RESERVED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 'reserved example domain';
  return null;
}

export function normalizedOrigin(value: string): string {
  return new URL(value).origin;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const COMMIT_HEX = /^[0-9a-f]{40}$/;

const reference = (value: string) => (value.trim().length >= 8 ? null : 'must reference reviewable evidence');

function liveDid(value: string): string | null {
  if (!isSupportedDid(value)) return 'must be a did:plc or hostname did:web';
  if (FIXTURE_DIDS.has(value)) return 'reserved fixture DID, not a live identity';
  if (value.startsWith('did:web:localhost')) return 'must be a public identity';
  return null;
}

export const ORIGIN_REQ: Requirement = {
  name: ENV.origin,
  what: 'deployed Worker origin on public HTTPS, e.g. the production custom domain',
  check: (v) => publicHttpsProblem(v, true),
};
export const PREFIX_REQ: Requirement = {
  name: ENV.prefix,
  what: 'owned production lexicon prefix whose NSID authority the operator controls',
  check: (v) => {
    if (!isValidPrefix(v)) return 'not a valid NSID prefix';
    if (isFixturePrefix(v) || /^(com|org|net)\.example\./.test(v)) return 'fixture/example prefix is never live';
    return null;
  },
};
export const VERSION_REQ: Requirement = {
  name: ENV.versionId,
  what: 'Worker version id under test, from wrangler versions upload or deployments status',
  check: (v) => (UUID.test(v) ? null : 'must be a lowercase UUID'),
};
export const BUNDLE_REQ: Requirement = {
  name: ENV.bundleSha256,
  what: 'bundle SHA-256 printed by `npx tsx scripts/check-bundle.ts --release` for that version',
  check: (v) => (SHA256_HEX.test(v) ? null : 'must be 64 lowercase hex digits'),
};
export const COMMIT_REQ: Requirement = {
  name: ENV.commit,
  what: 'source commit of the deployed version, defaulting to the checked-out HEAD',
  optional: true,
  check: (v) => (COMMIT_HEX.test(v) ? null : 'must be a full 40-hex commit'),
};

/** Release provenance and the deployment under test: every gate needs these. */
export const RELEASE_REQS: readonly Requirement[] = [ORIGIN_REQ, PREFIX_REQ, VERSION_REQ, BUNDLE_REQ, COMMIT_REQ];

/** Two dedicated identities on two independently operated PDSs. */
export const IDENTITY_REQS: readonly Requirement[] = [
  { name: ENV.didA, what: 'dedicated test DID on PDS A', check: liveDid },
  { name: ENV.pdsA, what: 'PDS A endpoint on public HTTPS', check: (v) => publicHttpsProblem(v, true) },
  {
    name: ENV.didB,
    what: 'dedicated test DID on PDS B',
    check: (v, env) => liveDid(v) ?? (v === env[ENV.didA] ? 'must differ from DID A' : null),
  },
  {
    name: ENV.pdsB,
    what: 'PDS B endpoint on public HTTPS, a different host from PDS A',
    check: (v, env) => {
      const problem = publicHttpsProblem(v, true);
      if (problem) return problem;
      const a = env[ENV.pdsA];
      try {
        if (a && new URL(a).hostname.toLowerCase() === new URL(v).hostname.toLowerCase()) return 'same host as PDS A';
      } catch {
        // PDS A's own check reports it.
      }
      return null;
    },
  },
  {
    name: ENV.pdsIndependenceRef,
    what: 'reference to evidence that PDS A and PDS B are independently operated',
    check: reference,
  },
];

export const JETSTREAM_REQ: Requirement = {
  name: ENV.jetstreamCoverageRef,
  what: 'reference to evidence that the configured Jetstream hosts carry commits from both PDSs, A6',
  check: reference,
};

export const ADMIN_REQ: Requirement = {
  name: ENV.adminToken,
  what: 'the deployment ADMIN_TOKEN, at least 32 characters, for /internal/admin/*',
  check: (v) => (v.length >= 32 ? null : 'shorter than 32 characters; the Worker never enables admin with it'),
};

/** `NAME: missing — what` for a missing value, `NAME: invalid — reason` for an unusable one. */
export function missingPrerequisites(env: EnvMap, requirements: readonly Requirement[]): string[] {
  const missing: string[] = [];
  for (const req of requirements) {
    const value = env[req.name];
    if (value === undefined || value === '') {
      if (!req.optional) missing.push(`${req.name}: missing — ${req.what}`);
      continue;
    }
    const problem = req.check?.(value, env) ?? null;
    if (problem) missing.push(`${req.name}: invalid — ${problem}`);
  }
  return missing;
}

/**
 * At least one of several alternatives must be usable (e.g. a password or
 * interactive mode). Reported under each alternative's first name, as
 * `NAME: missing — label (or OTHER)`.
 */
export function oneOf(env: EnvMap, alternatives: readonly Requirement[][], label: string): string[] {
  const results = alternatives.map((reqs) => missingPrerequisites(env, reqs));
  if (results.some((problems) => problems.length === 0)) return [];
  const supplied = results.flat().filter((p) => p.includes(': invalid — '));
  const [first, ...rest] = alternatives.map((reqs) => reqs.map((r) => r.name).join(' + '));
  return [`${first}: missing — ${label} (or ${rest.join(' or ')})`, ...supplied];
}

// ---------------------------------------------------------------------------
// Evidence document.

export interface PdsInfo {
  endpoint: string;
  implementation: string;
  version: string;
}

export interface Subject {
  did: string;
  uri: string | null;
}

export interface GateEvidence {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  gate: GateName;
  result: GateOutcome;
  fixtureOnly: false;
  recordedAt: string;
  testCommand: string;
  workerVersionId: string | null;
  bundleSha256: string | null;
  commit: string | null;
  origin: string | null;
  lexiconPrefix: string | null;
  pds: PdsInfo[];
  subjects: Subject[];
  results: Record<string, unknown>;
  cleanup: string;
  missing?: string[];
  failures?: string[];
}

export class GateFailure extends Error {
  override name = 'GateFailure';
}

/** Throw a GateFailure unless `condition`. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GateFailure(message);
}

export interface GateContext {
  env: EnvMap;
  /** A prerequisite value (already validated by runGate). */
  get(name: string): string;
  origin: string;
  prefix: string;
  /** Diagnostics for the operator, on stderr, redacted. */
  log(message: string): void;
  /** Record a non-fatal failure; the gate then ends `failed`. */
  fail(message: string): void;
  /** Append a cleanup note (what was removed, or what is left behind). */
  cleanup(note: string): void;
}

export interface GateBodyResult {
  pds: PdsInfo[];
  subjects: Subject[];
  results: Record<string, unknown>;
}

export interface GateSpec {
  gate: GateName;
  /** The repo-relative script path, used for testCommand. */
  script: string;
  requirements: readonly Requirement[];
  /** Extra cross-field checks (each returns problems). */
  extraChecks?: (env: EnvMap) => string[];
  run(ctx: GateContext): Promise<GateBodyResult>;
}

function secretValues(env: EnvMap): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redact(text: string, env: EnvMap): string {
  let out = text;
  for (const secret of secretValues(env)) out = out.split(secret).join('[redacted]');
  // Bearer tokens and JWTs that reach an error message from elsewhere.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]');
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]');
  return out;
}

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function message(error: unknown): string {
  if (error instanceof Error) return `${error.name === 'GateFailure' ? '' : `${error.name}: `}${error.message}`;
  return String(error);
}

export function emit(evidence: GateEvidence, env: EnvMap): number {
  const text = redact(`${JSON.stringify(evidence, null, 2)}\n`, env);
  process.stdout.write(text);
  const out = env[ENV.evidenceOut];
  if (out) writeFileSync(out, text, { mode: 0o600 });
  const head =
    evidence.result === 'blocked'
      ? `BLOCKED: ${evidence.gate} live gate prerequisites are missing; no live request was made`
      : evidence.result === 'failed'
        ? `FAIL: ${evidence.gate} live gate failed`
        : `PASS: ${evidence.gate} live gate passed for Worker version ${evidence.workerVersionId}`;
  const lines = [
    head,
    ...(evidence.missing ?? []).map((m) => `- ${m}`),
    ...(evidence.failures ?? []).map((f) => `- ${f}`),
  ];
  process.stderr.write(redact(`${lines.join('\n')}\n`, env));
  return EXIT_CODES[evidence.result];
}

export async function runGate(spec: GateSpec, env: EnvMap = process.env): Promise<number> {
  const base = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION as typeof EVIDENCE_SCHEMA_VERSION,
    gate: spec.gate,
    fixtureOnly: false as const,
    testCommand: `npx tsx ${spec.script}`,
  };
  const missing = [...missingPrerequisites(env, spec.requirements), ...(spec.extraChecks?.(env) ?? [])];
  if (missing.length > 0) {
    return emit(
      {
        ...base,
        result: 'blocked',
        recordedAt: new Date().toISOString(),
        workerVersionId: env[ENV.versionId] || null,
        bundleSha256: env[ENV.bundleSha256] || null,
        commit: null,
        origin: null,
        lexiconPrefix: null,
        pds: [],
        subjects: [],
        results: {},
        cleanup: 'nothing to clean up: no live request was made',
        missing,
      },
      env,
    );
  }

  const failures: string[] = [];
  const cleanupNotes: string[] = [];
  const get = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new GateFailure(`${name} is not set`);
    return value;
  };
  const ctx: GateContext = {
    env,
    get,
    origin: normalizedOrigin(get(ENV.origin)),
    prefix: get(ENV.prefix),
    log: (m) => process.stderr.write(`${redact(m, env)}\n`),
    fail: (m) => failures.push(m),
    cleanup: (n) => cleanupNotes.push(n),
  };
  let commit: string | null = env[ENV.commit] || null;
  let body: GateBodyResult = { pds: [], subjects: [], results: {} };
  try {
    commit ??= gitHead();
    body = await spec.run(ctx);
  } catch (error) {
    failures.push(message(error));
    if (error instanceof PartialResult) body = error.partial;
  }
  return emit(
    {
      ...base,
      result: failures.length === 0 ? 'passed' : 'failed',
      recordedAt: new Date().toISOString(),
      workerVersionId: get(ENV.versionId),
      bundleSha256: get(ENV.bundleSha256),
      commit,
      origin: ctx.origin,
      lexiconPrefix: ctx.prefix,
      ...body,
      cleanup: cleanupNotes.length > 0 ? cleanupNotes.join('; ') : 'nothing created',
      ...(failures.length > 0 ? { failures } : {}),
    },
    env,
  );
}

/** A failure that still carries what was observed before it. */
export class PartialResult extends GateFailure {
  constructor(
    message: string,
    readonly partial: GateBodyResult,
  ) {
    super(message);
  }
}

/** True when `metaUrl` is the module node was asked to run. */
export function isMain(metaUrl: string): boolean {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/** Run a gate as the process entry point. */
export function main(spec: GateSpec): void {
  runGate(spec).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`FAIL: ${spec.gate} harness error: ${redact(message(error), process.env)}\n`);
      process.exitCode = EXIT_CODES.failed;
    },
  );
}

// ---------------------------------------------------------------------------
// Network helpers (operator side; only reached after every prerequisite is set).

export const HTTP_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export interface JsonResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

/** A JSON request with a deadline, no redirects and a body cap. */
export async function httpJson(
  url: string | URL,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new GateFailure(`${new URL(url).pathname}: response over 2 MiB`);
  let json: unknown = null;
  if (bytes.byteLength > 0) {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, json };
}

export function xrpcUrl(base: string, nsid: string, params: Record<string, string | string[]> = {}): URL {
  const url = new URL(`/xrpc/${nsid}`, base);
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  return url;
}

export function field<T = unknown>(value: unknown, key: string): T | undefined {
  return value !== null && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as T) : undefined;
}

/** `_health` version of a PDS; the implementation is operator-declared when known. */
export async function pdsInfo(endpoint: string, implementation: string | undefined): Promise<PdsInfo> {
  let version = 'unreported';
  try {
    const health = await httpJson(xrpcUrl(endpoint, '_health'));
    const v = field<string>(health.json, 'version');
    if (health.status === 200 && typeof v === 'string' && v.length > 0 && v.length <= 64) version = v;
  } catch {
    // Recorded as unreported.
  }
  return { endpoint: normalizedOrigin(endpoint), implementation: implementation || 'unreported', version };
}

/** GET /api/v1/meta: the deployment must index and publish exactly the configured prefix. */
export async function checkDeployment(ctx: GateContext): Promise<Record<string, unknown>> {
  const meta = await httpJson(new URL('/api/v1/meta', ctx.origin));
  expect(meta.status === 200, `GET /api/v1/meta returned ${meta.status}`);
  const prefix = field(meta.json, 'lexiconPrefix');
  const capabilities = field<unknown[]>(meta.json, 'capabilities');
  expect(prefix === ctx.prefix, `deployment lexiconPrefix ${JSON.stringify(prefix)} is not ${ctx.prefix}`);
  expect(
    Array.isArray(capabilities) && capabilities.includes('publication'),
    'deployment does not advertise the publication capability (namespace gate closed)',
  );
  return { version: field(meta.json, 'version'), stage: field(meta.json, 'stage'), capabilities };
}

export async function adminStatus(ctx: GateContext): Promise<Record<string, unknown>> {
  const res = await httpJson(new URL('/internal/admin/status', ctx.origin), {
    headers: { authorization: `Bearer ${ctx.get(ENV.adminToken)}` },
  });
  expect(res.status === 200, `GET /internal/admin/status returned ${res.status} (is ADMIN_TOKEN set on the Worker?)`);
  expect(res.json !== null && typeof res.json === 'object', 'admin status is not a JSON object');
  return res.json as Record<string, unknown>;
}

export interface VerifiedRecord {
  state: 'present' | 'absent';
  cid: string | null;
  rev: string;
  commitCid: string;
  pds: string;
}

/**
 * Independently fetch and verify `did/collection/rkey` at the repository's
 * current signed head: fresh identity resolution, SafeFetch getRecord, CAR
 * bounds, commit signature under the current #atproto key, and an MST
 * inclusion or exclusion proof. Throws on anything short of a proof.
 */
export async function verifyRecordAt(did: string, collection: string, rkey: string): Promise<VerifiedRecord> {
  const [{ systemClock }, { createIdentityResolver }, { createSafeFetch }, { verifyRecordProof }] = await Promise.all([
    import('@atmusic/core/deps'),
    import('@atmusic/atproto/identity/resolver'),
    import('@atmusic/atproto/net/safe-fetch'),
    import('@atmusic/atproto/verify/record-proof'),
  ]);
  const identity = await createIdentityResolver({ clock: systemClock }).resolveDid(did, { fresh: true });
  const safeFetch = createSafeFetch({ clock: systemClock });
  const { body } = await safeFetch(xrpcUrl(identity.pds, 'com.atproto.sync.getRecord', { did, collection, rkey }), {
    kind: 'getRecord',
  });
  const proof = await verifyRecordProof(body, { did, collection, rkey, signingKey: identity.signingKey });
  return {
    state: proof.state,
    cid: proof.state === 'present' ? proof.cid : null,
    rev: proof.commit.rev,
    commitCid: proof.commit.cid,
    pds: identity.pds,
  };
}

/** The DID document's PDS must be the endpoint the operator declared. */
export async function checkIdentityPds(did: string, declared: string): Promise<string> {
  const [{ systemClock }, { createIdentityResolver }] = await Promise.all([
    import('@atmusic/core/deps'),
    import('@atmusic/atproto/identity/resolver'),
  ]);
  const identity = await createIdentityResolver({ clock: systemClock }).resolveDid(did, { fresh: true });
  expect(
    normalizedOrigin(identity.pds) === normalizedOrigin(declared),
    `${did} resolves to PDS ${identity.pds}, not the declared ${normalizedOrigin(declared)}`,
  );
  return identity.handle ?? '';
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Poll `probe` every `intervalMs` until it returns a value or `timeoutMs` passes. */
export async function pollUntil<T>(
  probe: () => Promise<T | null>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<{ value: T; elapsedMs: number } | null> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return { value, elapsedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/** A positive integer env value with bounds, or the default. */
export function intEnv(env: EnvMap, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return Number(raw);
}

export function intRequirement(name: string, what: string, min: number, max: number): Requirement {
  return {
    name,
    what,
    optional: true,
    check: (v) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `must be an integer ${min}–${max}`),
  };
}
