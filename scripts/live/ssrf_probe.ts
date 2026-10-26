// Live gate: SSRF probe of Workers fetch (ADR 0004 §8 SSRF, A5, §13 item 1;
// W6-05).
//
// Usage:
//   npx tsx scripts/live/ssrf_probe.ts --emit-worker [dir]   (writes the diagnostic Worker; no network)
//   npx tsx scripts/live/ssrf_probe.ts                        (runs the probe)
//
// DNS pinning is impossible on Workers, so SafeFetch rejects private
// destinations by URL/host policy plus a DoH pre-check, leaving a DNS
// rebinding TOCTOU residual. This gate records, on the real edge, how Workers
// `fetch` itself behaves toward RFC 1918, loopback and cloud-metadata
// addresses, and that SafeFetch refuses every one of them.
//
// The probe runs inside an admin-only diagnostic Worker, deliberately not a
// route of the production Worker: the production bundle keeps no raw-fetch
// surface and no test seam (ADR §8 "Test seams"). `--emit-worker` writes its
// source and wrangler config (default work/ssrf-probe-worker, inside the
// repository so it bundles the same @atmusic/atproto SafeFetch). The operator
// deploys it with their own credentials and sets its PROBE_TOKEN secret to the
// ADMIN_TOKEN; this script never deploys anything. The diagnostic Worker:
// - answers only POST /probe with `Authorization: Bearer <PROBE_TOKEN>`
//   (constant-time comparison; 404 otherwise, including without the secret);
// - for each target host, issues a raw `fetch` over http and https
//   (redirect manual, 5 s deadline, no credentials) and a SafeFetch request;
// - returns only outcome, status, error name/message, elapsed time and the
//   number of body bytes seen (capped at 4 KiB). It never returns bodies or
//   headers, so a metadata service's answer cannot leak through it.
//
// Targets: the operator's controlled DNS names (ATMUSIC_LIVE_SSRF_HOSTS,
// `label=host` pairs; the labels rfc1918, loopback and metadata are required)
// plus the matching IP literals. Before probing, each name is resolved here
// over DoH and must answer only addresses of its label's class, so a
// misconfigured name cannot produce a false pass. The gate passes when
// SafeFetch refused every target; the raw fetch outcomes are recorded as the
// platform behaviour, whatever they are.
//
// Without the prerequisites it prints `blocked` with each missing variable
// and exits 2 before any request.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ADMIN_REQ,
  checkDeployment,
  ENV,
  expect,
  field,
  type GateContext,
  type GateSpec,
  httpJson,
  isMain,
  main,
  publicHttpsProblem,
  RELEASE_REQS,
  REPO_ROOT,
  type Requirement,
} from './live-gate.ts';

export const SSRF_ENV = {
  probeUrl: 'ATMUSIC_LIVE_SSRF_PROBE_URL',
  hosts: 'ATMUSIC_LIVE_SSRF_HOSTS',
} as const;

export type AddressClass = 'rfc1918' | 'loopback' | 'metadata' | 'linkLocal' | 'ula' | 'cgnat' | 'public' | 'other';
export const REQUIRED_LABELS = ['rfc1918', 'loopback', 'metadata'] as const;
/** IP-literal baselines probed next to the controlled names (raw fetch; SafeFetch refuses literals by policy). */
export const LITERAL_TARGETS: Readonly<Record<(typeof REQUIRED_LABELS)[number], string>> = {
  rfc1918: '10.0.0.1',
  loopback: '127.0.0.1',
  metadata: '169.254.169.254',
};

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** `label=host,label=host` → map; problems for malformed pairs or missing labels. */
export function parseHosts(value: string): { hosts: Map<string, string>; problems: string[] } {
  const hosts = new Map<string, string>();
  const problems: string[] = [];
  for (const pair of value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [label = '', host = ''] = pair.split('=');
    if (!/^[a-z][a-zA-Z0-9]*$/.test(label) || !HOSTNAME.test(host.toLowerCase())) problems.push(`bad pair ${pair}`);
    else hosts.set(label, host.toLowerCase());
  }
  for (const label of REQUIRED_LABELS) if (!hosts.has(label)) problems.push(`missing label ${label}`);
  return { hosts, problems };
}

export const SSRF_REQS: readonly Requirement[] = [
  ADMIN_REQ,
  {
    name: SSRF_ENV.probeUrl,
    what: 'origin of the operator-deployed diagnostic Worker, from --emit-worker',
    check: (v) => publicHttpsProblem(v, true),
  },
  {
    name: SSRF_ENV.hosts,
    what: 'controlled DNS names as label=host pairs for rfc1918, loopback and metadata',
    check: (v) => {
      const { problems } = parseHosts(v);
      return problems.length > 0 ? problems.join('; ') : null;
    },
  },
];

function ipv4Class(ip: string): AddressClass {
  const [a = -1, b = -1, c = -1, d = -1] = ip.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'rfc1918';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
  if (a === 169 && b === 254) return 'linkLocal';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return a >= 1 && a <= 223 ? 'public' : 'other';
}

export function addressClass(ip: string): AddressClass {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ipv4Class(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::1') return 'loopback';
  if (v6 === 'fd00:ec2::254') return 'metadata';
  if (/^f[cd]/.test(v6)) return 'ula';
  if (/^fe[89ab]/.test(v6)) return 'linkLocal';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Class(mapped[1]!);
  return 'other';
}

/** Resolve A and AAAA over DoH JSON (cloudflare-dns.com, as the Worker's pre-check does). */
async function dohAddresses(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ['A', 'AAAA']) {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', host);
    url.searchParams.set('type', type);
    const res = await httpJson(url, { headers: { accept: 'application/dns-json' } });
    expect(res.status === 200, `DoH ${type} ${host}: HTTP ${res.status}`);
    for (const answer of field<unknown[]>(res.json, 'Answer') ?? []) {
      const data = field<string>(answer, 'data');
      const rrType = field<number>(answer, 'type');
      if (typeof data === 'string' && (rrType === 1 || rrType === 28)) out.push(data);
    }
  }
  return out;
}

export interface ProbeTarget {
  label: string;
  host: string;
  kind: 'controlledName' | 'literal';
}

export interface ProbeOutcome {
  target: ProbeTarget;
  resolved: string[];
  raw: unknown[];
  safeFetch: { outcome: string; code?: string };
}

async function runProbe(ctx: GateContext, targets: ProbeTarget[]): Promise<{ colo: unknown; results: unknown[] }> {
  const res = await httpJson(new URL('/probe', ctx.get(SSRF_ENV.probeUrl)), {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.get(ENV.adminToken)}` },
    body: { targets: targets.map((t) => ({ label: t.label, host: t.host })) },
    timeoutMs: 120_000,
  });
  expect(res.status === 200, `diagnostic Worker /probe returned ${res.status} (deployed? PROBE_TOKEN = ADMIN_TOKEN?)`);
  const results = field<unknown[]>(res.json, 'results');
  expect(
    Array.isArray(results) && results.length === targets.length,
    'diagnostic Worker answered a different target set',
  );
  return { colo: field(res.json, 'colo'), results };
}

export const spec: GateSpec = {
  gate: 'ssrfProbe',
  script: 'scripts/live/ssrf_probe.ts',
  requirements: [...RELEASE_REQS, ...SSRF_REQS],
  async run(ctx) {
    const deployment = await checkDeployment(ctx);
    const { hosts } = parseHosts(ctx.get(SSRF_ENV.hosts));
    const targets: ProbeTarget[] = [];
    const resolved = new Map<string, string[]>();
    for (const [label, host] of hosts) {
      const addresses = await dohAddresses(host);
      resolved.set(host, addresses);
      const classes = new Set(addresses.map(addressClass));
      const wanted = label as AddressClass;
      expect(addresses.length > 0, `${host} (${label}) does not resolve`);
      if ((REQUIRED_LABELS as readonly string[]).includes(label)) {
        expect(classes.size === 1 && classes.has(wanted), `${host} answers ${addresses.join(', ')}, not only ${label}`);
      }
      targets.push({ label, host, kind: 'controlledName' });
    }
    for (const label of REQUIRED_LABELS) targets.push({ label, host: LITERAL_TARGETS[label], kind: 'literal' });

    const probe = await runProbe(ctx, targets);
    const outcomes: ProbeOutcome[] = targets.map((target, i) => {
      const entry = probe.results[i];
      const safe = field<Record<string, unknown>>(entry, 'safeFetch') ?? {};
      return {
        target,
        resolved: resolved.get(target.host) ?? [target.host],
        raw: field<unknown[]>(entry, 'raw') ?? [],
        safeFetch: { outcome: String(field(safe, 'outcome') ?? 'missing'), code: field<string>(safe, 'code') },
      };
    });
    for (const o of outcomes) {
      if (o.safeFetch.outcome !== 'refused') {
        ctx.fail(`SafeFetch did not refuse ${o.target.host} (${o.target.label}): ${o.safeFetch.outcome}`);
      }
    }
    ctx.cleanup('nothing created; undeploy the diagnostic Worker when the evidence is recorded');
    return {
      pds: [],
      subjects: [],
      results: { deployment, probeOrigin: ctx.get(SSRF_ENV.probeUrl), colo: probe.colo, targets: outcomes },
    };
  },
};

// ---------------------------------------------------------------------------
// The diagnostic Worker, emitted for the operator.

export const PROBE_WORKER_SOURCE = `// atmusic SSRF diagnostic Worker (emitted by scripts/live/ssrf_probe.ts; ADR 0004 §8, W6-05).
// Admin-only: POST /probe with Authorization: Bearer <PROBE_TOKEN>. Deploy it
// separately from the production Worker and delete it after the probe.
import { systemClock } from '@atmusic/core/deps';
import { createSafeFetch, isSafeFetchError } from '@atmusic/atproto/net/safe-fetch';

interface Env { PROBE_TOKEN?: string }
const MAX_TARGETS = 16;
const BODY_PEEK = 4096;
const HOST = /^[a-z0-9.-]{1,253}$/;
const enc = new TextEncoder();

async function same(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(da, db);
}

const notFound = () => Response.json({ error: { code: 'not_found' } }, { status: 404 });

async function raw(url: string) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    let bytes = 0;
    const reader = res.body?.getReader();
    while (reader && bytes < BODY_PEEK) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    await reader?.cancel().catch(() => {});
    return { url, outcome: 'response', status: res.status, bodyBytesSeen: Math.min(bytes, BODY_PEEK), elapsedMs: Date.now() - started };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { url, outcome: err.name === 'TimeoutError' ? 'timeout' : 'error', errorName: err.name, errorMessage: err.message.slice(0, 200), elapsedMs: Date.now() - started };
  }
}

async function safe(host: string) {
  try {
    await createSafeFetch({ clock: systemClock })('https://' + host + '/', { kind: 'json', maxBytes: BODY_PEEK });
    return { outcome: 'fetched' };
  } catch (e) {
    if (isSafeFetchError(e)) return { outcome: e.code === 'blocked_destination' ? 'refused' : 'error', code: e.code };
    return { outcome: 'error', code: e instanceof Error ? e.name : 'unknown' };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const token = env.PROBE_TOKEN ?? '';
    if (url.pathname !== '/probe' || request.method !== 'POST' || token.length < 32) return notFound();
    const auth = /^Bearer ([^\\s]+)$/.exec(request.headers.get('authorization') ?? '');
    if (!auth || !(await same(auth[1]!, token))) return notFound();
    const body = (await request.json().catch(() => null)) as { targets?: { label?: unknown; host?: unknown }[] } | null;
    const targets = Array.isArray(body?.targets) ? body.targets.slice(0, MAX_TARGETS) : [];
    const results = [];
    for (const t of targets) {
      const host = typeof t.host === 'string' && HOST.test(t.host) ? t.host : null;
      if (host === null) { results.push({ label: t.label, error: 'bad host' }); continue; }
      results.push({ label: t.label, host, raw: [await raw('http://' + host + '/'), await raw('https://' + host + '/')], safeFetch: await safe(host) });
    }
    const cf = (request as Request & { cf?: { colo?: string } }).cf;
    return Response.json({ colo: cf?.colo ?? null, results }, { headers: { 'cache-control': 'no-store' } });
  },
};
`;

export function probeWranglerConfig(): string {
  return `${JSON.stringify(
    {
      name: 'atmusic-ssrf-probe',
      main: 'probe-worker.ts',
      compatibility_date: '2026-10-01',
      workers_dev: true,
      observability: { enabled: false },
    },
    null,
    2,
  )}\n`;
}

export function emitWorker(dir: string): string[] {
  const out = resolve(dir);
  const rel = relative(REPO_ROOT, out);
  if (rel.startsWith('..')) throw new Error(`emit inside the repository so @atmusic/* resolves: ${out}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'probe-worker.ts'), PROBE_WORKER_SOURCE);
  writeFileSync(join(out, 'wrangler.jsonc'), probeWranglerConfig());
  return [join(out, 'probe-worker.ts'), join(out, 'wrangler.jsonc')];
}

function emitMain(args: string[]): void {
  const dir = args[0] ?? join(REPO_ROOT, 'work', 'ssrf-probe-worker');
  const files = emitWorker(dir);
  process.stdout.write(
    [
      ...files.map((f) => `wrote ${f}`),
      'The operator deploys it with their own Cloudflare credentials (this script never does):',
      `  npx wrangler deploy --config ${relative(process.cwd(), files[1]!)}`,
      `  npx wrangler secret put PROBE_TOKEN --config ${relative(process.cwd(), files[1]!)}   (the ADMIN_TOKEN value)`,
      `then set ${SSRF_ENV.probeUrl} to its origin and run this script without --emit-worker.`,
      '',
    ].join('\n'),
  );
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--emit-worker') emitMain(args.slice(1));
  else main(spec);
}
