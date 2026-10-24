// Build-time configuration for the SPA's static assets (ADR 0004 §4.2, §5.1,
// §8, A3; W1-09).
//
// Usage:
//   npx tsx scripts/gen-config.ts --env production|staging|free|local
//     [--wrangler worker/wrangler.jsonc] [--out web/public]
//
// Inputs: PUBLIC_ORIGIN and LEXICON_PREFIX from the environment, and the env
// name. For a deployed env (production, staging, free) a value that is not set
// in the environment is taken from that env's `vars` in the wrangler config,
// and a value that is set must equal it: the metadata's client_id has to name
// the origin the Worker is deployed on, and the OAuth scopes have to name the
// collections the Worker indexes.
//
// Outputs (in --out, normally web/public, copied by Vite into web/dist):
// - deployed envs: oauth/client-metadata.json (the browser public client's
//   client_id document) and _headers (CSP, security and cache headers that
//   Workers Static Assets apply to asset responses);
// - local: oauth/loopback-client.json, a hint naming the loopback client_id
//   (http://localhost?redirect_uri=…&scope=…) for the SPA, and nothing else:
//   stale generated oauth/client-metadata.json and _headers in --out are
//   removed (the deployed CSP's connect-src 'self' https: would block the
//   http:// loopback PDS/PLC of a local sign-in).
//
// Refusals (nothing is written): a deployed env with an empty, invalid or
// fixture LEXICON_PREFIX (com.example.atmusic is fixture-only and must never
// be published), a non-https or non-origin PUBLIC_ORIGIN, values that differ
// from the wrangler config, a deployed env with no route or with a route
// (`route` or `routes`, own or inherited from the top level, as wrangler
// resolves them) on another host, or a local origin that is not http loopback.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_WRANGLER_CONFIG = join(REPO_ROOT, 'worker', 'wrangler.jsonc');
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'web', 'public');

/** Fixture-only prefix (ADR §8, §9.1); mirrors FIXTURE_PREFIX in worker/src/config.ts. */
export const FIXTURE_PREFIX = 'com.example.atmusic';
export const CLIENT_NAME = 'AT Protocol Music';
export const METADATA_PATH = '/oauth/client-metadata.json';
export const CALLBACK_PATH = '/oauth/callback';
export const METADATA_FILE = join('oauth', 'client-metadata.json');
export const LOOPBACK_HINT_FILE = join('oauth', 'loopback-client.json');
export const HEADERS_FILE = '_headers';
export const DEFAULT_LOCAL_ORIGIN = 'http://127.0.0.1:8787';

/** The strict CSP of ADR §8, verbatim. */
export const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self' https:; img-src 'self' data:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'";

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';

export type EnvName = 'production' | 'staging' | 'free' | 'local';
export const ENV_NAMES: readonly EnvName[] = ['production', 'staging', 'free', 'local'];

export class GenConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'GenConfigError';
  }
}

function validLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/** Lowercase reverse-domain NSID prefix; the same rule as isValidPrefix in worker/src/config.ts. */
export function isValidPrefix(prefix: string): boolean {
  const labels = prefix.split('.');
  return labels.length >= 2 && prefix.length <= 253 && /^[a-z]/.test(labels[0] ?? '') && labels.every(validLabel);
}

/** `https://host` exactly: no path, explicit port, query, fragment or credentials. */
export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** `http://127.0.0.1:<port>` or `http://[::1]:<port>` (atproto loopback redirect rule). */
export function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && url.origin === value && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

/** The granular scope of ADR §5.1 / Q5; `atproto` alone when the namespace gate is closed. */
export function scopeFor(prefix: string | null): string {
  if (prefix === null) return 'atproto';
  return `atproto repo:${prefix}.scrobble repo:${prefix}.follow repo:${prefix}.settings`;
}

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: [string];
  scope: string;
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
  application_type: 'web';
  dpop_bound_access_tokens: true;
}

export function buildClientMetadata(origin: string, prefix: string): ClientMetadata {
  return {
    client_id: `${origin}${METADATA_PATH}`,
    client_name: CLIENT_NAME,
    client_uri: origin,
    redirect_uris: [`${origin}${CALLBACK_PATH}`],
    scope: scopeFor(prefix),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}

export interface LoopbackHint {
  client_id: string;
  redirect_uri: string;
  scope: string;
}

/** The loopback client_id of ADR §5.1 step 7 (atproto OAuth "localhost" development clients). */
export function buildLoopbackHint(origin: string, prefix: string | null): LoopbackHint {
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  const scope = scopeFor(prefix);
  const query = new URLSearchParams({ redirect_uri: redirectUri, scope });
  return { client_id: `http://localhost?${query.toString()}`, redirect_uri: redirectUri, scope };
}

export interface HeaderRule {
  path: string;
  headers: readonly (readonly [string, string])[];
}

/**
 * The `_headers` rules. Cache-Control is set only on specific paths, never on
 * `/*`: Static Assets join a header that several rules set with a comma, so a
 * site-wide value would corrupt the immutable policy of /assets/*. `/` is
 * listed with `/index.html` because Static Assets serve index.html at `/`
 * (and redirect `/index.html` to `/`).
 */
export function headerRules(): HeaderRule[] {
  return [
    {
      path: '/*',
      headers: [
        ['Content-Security-Policy', CSP],
        ['Referrer-Policy', 'no-referrer'],
        ['X-Content-Type-Options', 'nosniff'],
      ],
    },
    { path: '/assets/*', headers: [['Cache-Control', IMMUTABLE_CACHE]] },
    { path: '/', headers: [['Cache-Control', NO_CACHE]] },
    { path: '/index.html', headers: [['Cache-Control', NO_CACHE]] },
    { path: METADATA_PATH, headers: [['Cache-Control', NO_CACHE]] },
  ];
}

export function buildHeaders(): string {
  const lines = ['# Generated by scripts/gen-config.ts (ADR 0004 §8). Do not edit.'];
  for (const rule of headerRules()) {
    lines.push(rule.path);
    for (const [name, value] of rule.headers) lines.push(`  ${name}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** JSON with comments and trailing commas, as wrangler.jsonc allows. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas, outside strings (strings contain no unescaped `"` here).
  const noTrailing = out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str: string | undefined, close: string) =>
    str !== undefined ? m : close,
  );
  return JSON.parse(noTrailing);
}

export function readJsonc(path: string): unknown {
  return parseJsonc(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface WranglerEnvSection {
  /** Env name in wrangler terms: null for the top-level (production) section. */
  wranglerEnv: string | null;
  vars: Record<string, string>;
  routeHosts: string[];
  main: string | null;
  assetsDirectory: string | null;
  /**
   * The resolved `assets.not_found_handling`: null when the env has no
   * `assets` or leaves the key unset (wrangler's default, "none").
   */
  assetsNotFoundHandling: unknown;
}

/** The host of a route `pattern` (`host/path*`, optionally with a scheme). */
function routePatternHost(pattern: string): string {
  return pattern.replace(/^https?:\/\//, '').split('/')[0] ?? '';
}

/** The host of one `route`/`routes` entry: a pattern string or `{ pattern, ... }`. */
function routeEntryHost(entry: unknown): string {
  const pattern = typeof entry === 'string' ? entry : isRecord(entry) ? entry.pattern : undefined;
  // An entry wrangler would not accept still names no allowed host, so it is
  // reported (as itself) instead of being skipped.
  return typeof pattern === 'string' ? routePatternHost(pattern) : `<invalid route ${JSON.stringify(entry)}>`;
}

/**
 * The hosts every route of the env resolves to, as wrangler resolves them:
 * `route` and `routes` are both inheritable, so a named env that does not set
 * one of them (to anything, including `[]`) takes the top-level value, and the
 * singular `route` deploys like a one-entry `routes`.
 */
function resolvedRouteHosts(
  config: Record<string, unknown>,
  section: Record<string, unknown>,
  named: boolean,
): string[] {
  const pick = (key: 'route' | 'routes'): unknown =>
    section[key] !== undefined || !named ? section[key] : config[key];
  const hosts: string[] = [];
  const route = pick('route');
  if (route !== undefined) hosts.push(routeEntryHost(route));
  const routes = pick('routes');
  if (Array.isArray(routes)) for (const entry of routes) hosts.push(routeEntryHost(entry));
  else if (routes !== undefined) hosts.push(routeEntryHost(routes));
  return hosts;
}

/** The production (top-level) or named env section of a wrangler config. */
export function wranglerEnvSection(config: unknown, env: Exclude<EnvName, 'local'>): WranglerEnvSection {
  if (!isRecord(config)) throw new GenConfigError(['wrangler config is not an object']);
  let section: Record<string, unknown> = config;
  const wranglerEnv = env === 'production' ? null : env;
  if (wranglerEnv !== null) {
    const envs = config.env;
    const named = isRecord(envs) ? envs[wranglerEnv] : undefined;
    if (!isRecord(named)) throw new GenConfigError([`wrangler config has no env.${wranglerEnv}`]);
    section = named;
  }
  const vars: Record<string, string> = {};
  if (isRecord(section.vars)) {
    for (const [k, v] of Object.entries(section.vars)) if (typeof v === 'string') vars[k] = v;
  }
  const routeHosts = resolvedRouteHosts(config, section, wranglerEnv !== null);
  // `main` and `assets` are inheritable; a named env may override them.
  const main = typeof section.main === 'string' ? section.main : typeof config.main === 'string' ? config.main : null;
  const assets = isRecord(section.assets) ? section.assets : isRecord(config.assets) ? config.assets : null;
  const assetsDirectory = assets !== null && typeof assets.directory === 'string' ? assets.directory : null;
  const assetsNotFoundHandling = assets?.not_found_handling ?? null;
  return { wranglerEnv, vars, routeHosts, main, assetsDirectory, assetsNotFoundHandling };
}

/** Problems with a deployed env's origin/prefix pair; empty when it may be published. */
export function deployedValueIssues(origin: string, prefix: string, routeHosts: readonly string[]): string[] {
  const issues: string[] = [];
  if (!isHttpsOrigin(origin)) {
    issues.push('PUBLIC_ORIGIN must be an https origin without path, port, query, fragment or credentials');
  }
  if (prefix === '') {
    issues.push('LEXICON_PREFIX is empty: a deployed client needs an owned NSID prefix for its repo: scopes');
  } else if (prefix === FIXTURE_PREFIX) {
    issues.push(`LEXICON_PREFIX ${FIXTURE_PREFIX} is fixture-only and must never be published`);
  } else if (!isValidPrefix(prefix)) {
    issues.push('LEXICON_PREFIX must be a lowercase reverse-domain NSID prefix');
  }
  if (routeHosts.length === 0) {
    issues.push('no route: a deployed env must route its custom domain, the PUBLIC_ORIGIN host');
  }
  if (isHttpsOrigin(origin)) {
    const host = new URL(origin).host;
    for (const routeHost of routeHosts) {
      if (routeHost !== host) issues.push(`route ${routeHost} is not on PUBLIC_ORIGIN host ${host}`);
    }
  }
  return issues;
}

export interface GenConfigInput {
  env: string;
  /** PUBLIC_ORIGIN from the environment; undefined when unset. */
  publicOrigin?: string | undefined;
  /** LEXICON_PREFIX from the environment; undefined when unset. */
  lexiconPrefix?: string | undefined;
  /** Parsed wrangler config (required for deployed envs). */
  wranglerConfig?: unknown;
}

export interface GeneratedFile {
  /** Path relative to the output directory. */
  path: string;
  content: string;
}

export interface GenConfigPlan {
  env: EnvName;
  origin: string;
  prefix: string | null;
  write: GeneratedFile[];
  /** Stale generated files to delete (relative to the output directory). */
  remove: string[];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Validates the inputs and returns what to write; throws GenConfigError and writes nothing on refusal. */
export function planGenConfig(input: GenConfigInput): GenConfigPlan {
  if (!(ENV_NAMES as readonly string[]).includes(input.env)) {
    throw new GenConfigError([`env must be one of ${ENV_NAMES.join(', ')}`]);
  }
  const env = input.env as EnvName;

  if (env === 'local') {
    const origin = (input.publicOrigin ?? '').trim() || DEFAULT_LOCAL_ORIGIN;
    const rawPrefix = (input.lexiconPrefix ?? '').trim();
    const issues: string[] = [];
    if (!isLoopbackOrigin(origin)) {
      issues.push('PUBLIC_ORIGIN for local must be http://127.0.0.1:<port> or http://[::1]:<port>');
    }
    if (rawPrefix !== '' && !isValidPrefix(rawPrefix)) {
      issues.push('LEXICON_PREFIX must be a lowercase reverse-domain NSID prefix');
    }
    if (issues.length > 0) throw new GenConfigError(issues);
    const prefix = rawPrefix === '' ? null : rawPrefix;
    return {
      env,
      origin,
      prefix,
      write: [{ path: LOOPBACK_HINT_FILE, content: json(buildLoopbackHint(origin, prefix)) }],
      // The deployed _headers would be applied by wrangler dev's Static Assets
      // too, and its connect-src 'self' https: blocks the http:// loopback
      // PDS/PLC a local sign-in talks to; a stale copy is therefore removed.
      remove: [METADATA_FILE, HEADERS_FILE],
    };
  }

  if (input.wranglerConfig === undefined) {
    throw new GenConfigError([`a wrangler config is required for ${env}`]);
  }
  const section = wranglerEnvSection(input.wranglerConfig, env);
  const configuredOrigin = section.vars.PUBLIC_ORIGIN ?? '';
  const configuredPrefix = (section.vars.LEXICON_PREFIX ?? '').trim();
  const origin = input.publicOrigin ?? configuredOrigin;
  const prefix = (input.lexiconPrefix ?? configuredPrefix).trim();
  const where = section.wranglerEnv === null ? 'vars' : `env.${section.wranglerEnv}.vars`;

  const issues = deployedValueIssues(origin, prefix, section.routeHosts);
  if (origin !== configuredOrigin) {
    issues.push(`PUBLIC_ORIGIN differs from wrangler ${where}.PUBLIC_ORIGIN (${configuredOrigin || 'unset'})`);
  }
  if (prefix !== configuredPrefix) {
    issues.push(`LEXICON_PREFIX differs from wrangler ${where}.LEXICON_PREFIX (${configuredPrefix || 'empty'})`);
  }
  if (issues.length > 0) throw new GenConfigError(issues);

  return {
    env,
    origin,
    prefix,
    write: [
      { path: METADATA_FILE, content: json(buildClientMetadata(origin, prefix)) },
      { path: HEADERS_FILE, content: buildHeaders() },
    ],
    remove: [LOOPBACK_HINT_FILE],
  };
}

/** Writes the plan into outDir (each file via a temp file and rename). */
export function applyPlan(plan: GenConfigPlan, outDir: string): void {
  for (const file of plan.write) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, file.content);
    renameSync(tmp, target);
  }
  for (const stale of plan.remove) {
    const target = join(outDir, stale);
    if (existsSync(target)) rmSync(target);
  }
}

interface CliArgs {
  env: string;
  wrangler: string;
  out: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { env: process.env.ATMUSIC_ENV ?? '', wrangler: DEFAULT_WRANGLER_CONFIG, out: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--env' || flag === '--wrangler' || flag === '--out') && value !== undefined) {
      if (flag === '--env') args.env = value;
      else if (flag === '--wrangler') args.wrangler = resolve(value);
      else args.out = resolve(value);
      i++;
    } else {
      throw new GenConfigError([
        `unknown or incomplete argument ${flag}; usage: gen-config.ts --env <${ENV_NAMES.join('|')}> [--wrangler <config>] [--out <dir>]`,
      ]);
    }
  }
  return args;
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  try {
    const args = parseArgs(argv);
    const wranglerConfig = args.env === 'local' ? undefined : readJsonc(args.wrangler);
    const plan = planGenConfig({
      env: args.env,
      publicOrigin: env.PUBLIC_ORIGIN,
      lexiconPrefix: env.LEXICON_PREFIX,
      wranglerConfig,
    });
    applyPlan(plan, args.out);
    console.log(`gen-config: env ${plan.env} origin ${plan.origin} prefix ${plan.prefix ?? '(none)'}`);
    for (const file of plan.write) console.log(`gen-config: wrote ${join(args.out, file.path)}`);
    return 0;
  } catch (err) {
    const issues = err instanceof GenConfigError ? err.issues : [err instanceof Error ? err.message : String(err)];
    for (const issue of issues) console.error(`gen-config: refused: ${issue}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
