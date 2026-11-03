// Generate the static-asset headers for the Node-hosted SPA (ADR 0005).
// OAuth client metadata is served dynamically by the BFF, never copied into
// the browser bundle. Origin and prefix may be supplied explicitly or read
// from config/atmusic.env.example for reproducible local builds.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLIENT_NAME } from '../packages/core/src/client-name.ts';

export { CLIENT_NAME };

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENV_FILE = join(REPO_ROOT, 'config', 'atmusic.env.example');
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'web', 'public');
export const HEADERS_FILE = '_headers';
// Kept for the Workers retirement wave's legacy release tooling. The Node
// generator never writes this document.
export const DEFAULT_WRANGLER_CONFIG = join(REPO_ROOT, 'worker', 'wrangler.jsonc');
export const METADATA_FILE = join('oauth', 'client-metadata.json');
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';
export const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'";
export type EnvName = 'production' | 'staging' | 'free';

/** Temporary Workers compatibility helpers; N7-01 removes their callers. */
export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}
export function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === value && ['127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
export function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, '$1');
  return JSON.parse(withoutComments.replace(/,\s*([}\]])/g, '$1'));
}
export function readJsonc(path: string): unknown {
  return JSON.parse(
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, '$1')
      .replace(/,\s*([}\]])/g, '$1'),
  );
}
export function wranglerEnvSection(config: unknown, env: EnvName) {
  type Section = {
    vars?: Record<string, string>;
    routes?: Array<{ pattern?: string }>;
    route?: string;
    main?: string;
    assets?: { directory?: string; not_found_handling?: string };
  };
  const root = config as Section & { env?: Record<string, Section> };
  const section = env === 'production' ? root : root.env?.[env];
  const routes =
    section?.routes ??
    (section?.route ? [{ pattern: section.route }] : (root.routes ?? (root.route ? [{ pattern: root.route }] : [])));
  const routeHosts = routes
    .map((route) => {
      try {
        return new URL(route.pattern ?? '').host;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return {
    wranglerEnv: env === 'production' ? null : env,
    vars: section?.vars ?? root.vars ?? {},
    routeHosts,
    main: section?.main ?? root.main ?? null,
    assetsDirectory: section?.assets?.directory ?? root.assets?.directory ?? null,
    assetsNotFoundHandling: section?.assets?.not_found_handling ?? root.assets?.not_found_handling ?? null,
  };
}
export function deployedValueIssues(origin: string, prefix: string, routeHosts: string[]): string[] {
  const issues: string[] = [];
  if (!isHttpsOrigin(origin))
    issues.push('PUBLIC_ORIGIN must be an https origin without path, port, query, fragment or credentials');
  if (!prefix || prefix === 'com.example.atmusic' || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(prefix))
    issues.push('LEXICON_PREFIX must be a lowercase non-fixture reverse-domain NSID prefix');
  if (!routeHosts.length) issues.push('no route: a deployed env must route its custom domain, the PUBLIC_ORIGIN host');
  else if (isHttpsOrigin(origin))
    for (const host of routeHosts)
      if (host !== new URL(origin).host)
        issues.push(`route ${host} is not on PUBLIC_ORIGIN host ${new URL(origin).host}`);
  return issues;
}
export function buildClientMetadata(origin: string, prefix: string) {
  return {
    client_id: `${origin}/oauth/client-metadata.json`,
    client_name: CLIENT_NAME,
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/callback`],
    scope: `atproto repo:${prefix}.scrobble repo:${prefix}.follow repo:${prefix}.settings`,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}

export class GenConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'GenConfigError';
  }
}

export interface GenConfigInput {
  origin: string;
  prefix: string;
}
export interface GeneratedFile {
  path: string;
  content: string;
}
export interface GenConfigPlan {
  origin: string;
  prefix: string;
  write: GeneratedFile[];
  remove: string[];
}

export function buildHeaders(): string {
  return [
    '# Generated by scripts/gen-config.ts (ADR 0005). Do not edit.',
    '/*',
    `  Content-Security-Policy: ${CSP}`,
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '/assets/*',
    `  Cache-Control: ${IMMUTABLE_CACHE}`,
    '/',
    `  Cache-Control: ${NO_CACHE}`,
    '/index.html',
    `  Cache-Control: ${NO_CACHE}`,
    '',
  ].join('\n');
}

export function planGenConfig(input: GenConfigInput): GenConfigPlan {
  const origin = input.origin.trim();
  const prefix = input.prefix.trim();
  const issues: string[] = [];
  try {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      issues.push('origin must be an http(s) origin without path, query, fragment or credentials');
  } catch {
    issues.push('origin must be an http(s) origin');
  }
  if (prefix && !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(prefix))
    issues.push('prefix must be a lowercase reverse-domain NSID prefix');
  if (issues.length) throw new GenConfigError(issues);
  return {
    origin,
    prefix,
    write: [{ path: HEADERS_FILE, content: buildHeaders() }],
    remove: ['oauth/client-metadata.json', 'oauth/loopback-client.json'],
  };
}

export function applyPlan(plan: GenConfigPlan, outDir: string): void {
  for (const file of plan.write) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, file.content);
    renameSync(temporary, target);
  }
  for (const stale of plan.remove) {
    const target = join(outDir, stale);
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

interface CliArgs {
  origin?: string;
  prefix?: string;
  envFile: string;
  out: string;
}
function exampleValues(path: string): { origin: string; prefix: string } {
  const text = readFileSync(path, 'utf8');
  const value = (name: string) => {
    const match = text.match(new RegExp(`^\\s*#?${name}=(.*)$`, 'm'));
    return match?.[1]?.trim() ?? '';
  };
  return { origin: value('ATMUSIC_PUBLIC_ORIGIN'), prefix: value('LEXICON_PREFIX') };
}
function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { envFile: DEFAULT_ENV_FILE, out: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      (flag === '--origin' || flag === '--prefix' || flag === '--env-file' || flag === '--out') &&
      value !== undefined
    ) {
      if (flag === '--origin') args.origin = value;
      else if (flag === '--prefix') args.prefix = value;
      else if (flag === '--env-file') args.envFile = resolve(value);
      else args.out = resolve(value);
      i++;
    } else
      throw new GenConfigError([
        `unknown or incomplete argument ${flag}; usage: gen-config.ts [--origin <origin>] [--prefix <prefix>] [--env-file <path>] [--out <dir>]`,
      ]);
  }
  return args;
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  try {
    const args = parseArgs(argv);
    const fallback = exampleValues(args.envFile);
    const origin = args.origin ?? env.ATMUSIC_PUBLIC_ORIGIN ?? fallback.origin;
    const prefix = args.prefix ?? env.LEXICON_PREFIX ?? fallback.prefix;
    const plan = planGenConfig({ origin, prefix });
    applyPlan(plan, args.out);
    console.log(`gen-config: origin ${plan.origin} prefix ${plan.prefix || '(none)'}`);
    console.log(`gen-config: wrote ${join(args.out, HEADERS_FILE)}`);
    return 0;
  } catch (error) {
    const issues =
      error instanceof GenConfigError ? error.issues : [error instanceof Error ? error.message : String(error)];
    for (const issue of issues) console.error(`gen-config: refused: ${issue}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2), process.env);
