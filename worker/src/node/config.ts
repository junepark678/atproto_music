// Node host configuration (ADR 0005 §3.8, §3.6, §5.7, §11.1, §14.1; N1-07).
//
// `parseNodeConfig(env, opts)` reads the non-secret settings of the systemd
// unit (its `Environment=` lines and `~/.config/atmusic/atmusic.env`) into a
// `NodeConfig`. It embeds `parseConfig` from worker/src/config.ts, which still
// owns the namespace gate, Jetstream, relay and slice-budget rules of ADR 0004.
// Secrets are not here: worker/src/node/secrets.ts reads them from the systemd
// credential, and nothing in this object is secret.
//
// No environment variable relaxes a rule. The only relaxation is the test-only
// option `{fixtureOrigins: true}`, which the e2e entry
// (worker/test/e2e/node-entry.ts) passes and worker/src/node/main.ts never
// does; the Node bundle guard (ADR §3.9) fails on that call-site literal in any
// production input. It admits an http loopback ATMUSIC_PUBLIC_ORIGIN, an
// ephemeral listen port and upstream roots on the reserved fixture TLDs
// (`.test`, `.example`), which only a fixture transport can reach.
//
// Workers-era variables (ADR §3.8, §20.4 #27): parseConfig still requires PLAN
// and DO_LOCATION_HINT. Until N7-01 removes them, this module passes
// `PLAN='paid'` and `DO_LOCATION_HINT=''` internally and refuses any value the
// operator sets for either, as it refuses INGEST_MODE=pulse.
//
// Process timings (busy timeout, drain window) are fixed production values,
// not environment variables; tests construct a NodeConfig with smaller ones.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, parseIpv4, parseIpv6 } from '@atmusic/atproto/net/url-policy';
import { isSupportedDid } from '@atmusic/core/syntax';
import { type AppConfig, ConfigError, type ConfigIssue, parseConfig } from '../config';

/** Environment as process.env presents it. */
export type NodeEnv = Readonly<Record<string, string | undefined>>;

export type NodeIngestMode = 'socket' | 'off';
export type ClientIpHeader = 'cf-connecting-ip' | 'x-forwarded-for' | 'x-real-ip' | 'none';
export type SigninPolicy = 'allowlist' | 'open';

export const CLIENT_IP_HEADERS: readonly ClientIpHeader[] = [
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
  'none',
];

/** SQLite busy timeout in production (ADR §3.2); read back from PRAGMA busy_timeout at startup. */
export const PRODUCTION_BUSY_TIMEOUT_MS = 5000;
/** SIGTERM drain window in production (ADR §3.10); below the unit's TimeoutStopSec=30s. */
export const PRODUCTION_DRAIN_MS = 25_000;

export const DEFAULT_LISTEN = '127.2.0.1:8888';
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1';
export const DEFAULT_UPLOAD_MAX_BYTES = 1_073_741_824; // 1 GiB
export const DEFAULT_MIN_FREE_BYTES = 2_147_483_648; // 2 GiB
export const DEFAULT_LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
export const DEFAULT_LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/';
export const DEFAULT_LISTENBRAINZ_API_ROOT = 'https://api.listenbrainz.org/';
export const DEFAULT_LASTFM_KNOWN_CLIENTS = 'panoScrobbler:panoScrobbler:Pano Scrobbler';

/**
 * Variables Node itself (or its bundled undici and OpenSSL) reads, any of which
 * can disable TLS verification, reroute traffic or inject code (ADR §3.8). The
 * unit unsets them all (§14.1); `run()` exits 78 if one still reaches it.
 */
export const FORBIDDEN_RUNTIME_ENV: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NODE_PATH',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * A ConfigError naming the first forbidden runtime variable present (set to
 * any value, even an empty one), or null. The value is never quoted.
 */
export function checkRuntimeEnv(env: NodeEnv): ConfigError | null {
  for (const name of FORBIDDEN_RUNTIME_ENV) {
    if (env[name] !== undefined) {
      return new ConfigError([
        {
          field: name,
          message: 'must not be set in the service environment (ADR 0005 §3.8); unset it in the unit',
        },
      ]);
    }
  }
  return null;
}

export interface ListenAddress {
  /** A loopback address: 127.0.0.0/8 or ::1 (without brackets). */
  host: string;
  port: number;
}

export interface LastfmKnownClient {
  apiKey: string;
  /** The public shared secret embedded in that client (not ours to protect). */
  sharedSecret: string;
  name: string;
}

export interface NodeConfig {
  /** The embedded ADR 0004 configuration (namespace gate, Jetstream, relay, budget). */
  app: AppConfig;
  /** ATMUSIC_PUBLIC_ORIGIN; equals app.publicOrigin. */
  publicOrigin: string;
  listen: ListenAddress;
  /** Absolute path of the SQLite database file. */
  dbPath: string;
  assetsDir: string;
  backupDir: string;
  uploadDir: string;
  adminSocket: string;
  clientIpHeader: ClientIpHeader;
  /** CIDRs whose socket peers may set the client-IP header. */
  trustedProxies: readonly string[];
  signinPolicy: SigninPolicy;
  signinDids: readonly string[];
  uploadMaxBytes: number;
  minFreeBytes: number;
  ingestMode: NodeIngestMode;
  lastfmApiRoot: string;
  lastfmAuthUrl: string;
  listenbrainzApiRoot: string;
  lastfmKnownClients: readonly LastfmKnownClient[];
  oauthTransitionGeneric: boolean;
  /** SQLite busy timeout; production PRODUCTION_BUSY_TIMEOUT_MS. */
  busyTimeoutMs: number;
  /** SIGTERM drain window; production PRODUCTION_DRAIN_MS. */
  drainMs: number;
  /** True only when the test-only fixtureOrigins option was passed. */
  fixtureOrigins: boolean;
}

export interface ParseNodeConfigOptions {
  /**
   * Test-only (the e2e entry). Admits an http loopback ATMUSIC_PUBLIC_ORIGIN, a
   * listen port of 0 and fixture-TLD upstream roots. main.ts never passes it.
   */
  fixtureOrigins?: boolean;
  /** Test entries only: admits the fixture LEXICON_PREFIX (parseConfig). */
  allowFixturePrefix?: boolean;
  /** Release root for the ATMUSIC_ASSETS_DIR default; defaults to this module's ../../.. */
  releaseRoot?: string;
}

/**
 * The release root: worker/src/node/config.ts and the bundled
 * worker/dist/node/main.mjs both sit three directories below it.
 */
function defaultReleaseRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

const POSITIVE_INT = /^[1-9][0-9]*$/;
/** A placeholder https origin handed to parseConfig for an http fixture origin. */
const FIXTURE_ORIGIN_STAND_IN = 'https://fixture-origin.test';
/** Loopback names checkUrl does not already refuse (it refuses localhost and *.localhost). */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function isLoopbackV4(text: string): boolean {
  const octets = parseIpv4(text);
  return octets !== null && octets[0] === 127;
}

function isLoopbackV6(text: string): boolean {
  const groups = parseIpv6(text);
  return groups?.every((g, i) => g === (i === 7 ? 1 : 0)) === true;
}

function parsePort(text: string, allowZero: boolean): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (port > 65_535 || (port === 0 && !allowZero) || (text.length > 1 && text.startsWith('0'))) return null;
  return port;
}

function parseListen(value: string, allowZeroPort: boolean): ListenAddress | null {
  const v6 = /^\[([^\]]+)\]:([0-9]+)$/.exec(value);
  if (v6) {
    const port = parsePort(v6[2] as string, allowZeroPort);
    return port !== null && isLoopbackV6(v6[1] as string) ? { host: v6[1] as string, port } : null;
  }
  const v4 = /^([0-9.]+):([0-9]+)$/.exec(value);
  if (v4) {
    const port = parsePort(v4[2] as string, allowZeroPort);
    return port !== null && isLoopbackV4(v4[1] as string) ? { host: v4[1] as string, port } : null;
  }
  return null;
}

function isCidr(entry: string): boolean {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const bitsText = slash === -1 ? null : entry.slice(slash + 1);
  const v4 = parseIpv4(address) !== null;
  const v6 = !v4 && parseIpv6(address) !== null;
  if (!v4 && !v6) return false;
  if (bitsText === null) return true;
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(bitsText)) return false;
  return Number(bitsText) <= (v4 ? 32 : 128);
}

/** `http://<loopback>:<port>` exactly, the only http origin fixture mode admits. */
function isHttpLoopbackOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.origin !== value) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || isLoopbackV4(host) || isLoopbackV6(host);
}

/** First entry of a systemd directory variable (`STATE_DIRECTORY` may list several, colon-separated). */
function firstDir(value: string | undefined): string | null {
  const first = (value ?? '').split(':')[0] ?? '';
  return first === '' ? null : first;
}

export function parseNodeConfig(env: NodeEnv, opts: ParseNodeConfigOptions = {}): NodeConfig {
  const fixture = opts.fixtureOrigins === true;
  const issues: ConfigIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });

  // --- Workers-era variables and ingest mode (ADR §3.8) --------------------
  for (const name of ['PLAN', 'DO_LOCATION_HINT']) {
    if (env[name] !== undefined) {
      issue(name, 'is a Cloudflare Workers setting and is refused on the Node host (ADR 0005 §3.8); remove it');
    }
  }
  const ingestRaw = env.INGEST_MODE ?? 'socket';
  let ingestMode: NodeIngestMode = 'socket';
  if (ingestRaw === 'socket' || ingestRaw === 'off') ingestMode = ingestRaw;
  else if (ingestRaw === 'pulse') issue('INGEST_MODE', 'pulse is a Workers mode and is refused (ADR 0005 §3.8)');
  else issue('INGEST_MODE', 'must be socket or off');

  // --- Public origin ---------------------------------------------------------
  const publicOrigin = env.ATMUSIC_PUBLIC_ORIGIN ?? '';
  const httpFixtureOrigin = fixture && isHttpLoopbackOrigin(publicOrigin);
  if (publicOrigin === '') issue('ATMUSIC_PUBLIC_ORIGIN', 'is required (an https origin)');

  // The embedded ADR 0004 rules. parseConfig validates the https origin itself;
  // only an http loopback fixture origin is swapped for a stand-in, and the
  // real value is restored below.
  let app: AppConfig | null = null;
  try {
    app = parseConfig(
      {
        PUBLIC_ORIGIN: httpFixtureOrigin ? FIXTURE_ORIGIN_STAND_IN : publicOrigin,
        LEXICON_PREFIX: env.LEXICON_PREFIX ?? '',
        NAMESPACE_OWNERSHIP_REF: env.NAMESPACE_OWNERSHIP_REF ?? '',
        INGEST_MODE: ingestMode,
        JETSTREAM_URLS: env.JETSTREAM_URLS ?? '',
        JETSTREAM_LOOKBACK_HOURS: env.JETSTREAM_LOOKBACK_HOURS ?? '',
        RELAY_URL: env.RELAY_URL ?? '',
        PLAN: 'paid',
        DO_LOCATION_HINT: '',
      },
      { allowFixturePrefix: opts.allowFixturePrefix === true },
    );
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const i of err.issues) {
      if (i.field === 'PUBLIC_ORIGIN') {
        if (publicOrigin !== '') issue('ATMUSIC_PUBLIC_ORIGIN', i.message);
      } else {
        issue(i.field, i.message);
      }
    }
  }

  // --- Listener and paths ----------------------------------------------------
  const listenRaw = env.ATMUSIC_LISTEN ?? DEFAULT_LISTEN;
  const listen = parseListen(listenRaw, fixture);
  if (listen === null) {
    issue('ATMUSIC_LISTEN', 'must be <loopback address>:<port> on 127.0.0.0/8 or [::1]');
  }

  const stateDir = firstDir(env.STATE_DIRECTORY);
  const runtimeDir = firstDir(env.XDG_RUNTIME_DIR);
  const path = (name: string, fallback: string | null, what: string): string => {
    const value = env[name] ?? fallback;
    if (value === null || value === '') {
      issue(name, `is required: set it, or run under systemd so that ${what} is set`);
      return '';
    }
    if (!isAbsolute(value)) {
      issue(name, 'must be an absolute path');
      return '';
    }
    return value;
  };
  const dbPath = path('ATMUSIC_DB', stateDir && join(stateDir, 'atmusic.db'), 'STATE_DIRECTORY');
  const assetsDir = path('ATMUSIC_ASSETS_DIR', join(opts.releaseRoot ?? defaultReleaseRoot(), 'web', 'dist'), '');
  const backupDir = path('ATMUSIC_BACKUP_DIR', stateDir && join(stateDir, 'backups'), 'STATE_DIRECTORY');
  const uploadDir = path('ATMUSIC_UPLOAD_DIR', stateDir && join(stateDir, 'imports'), 'STATE_DIRECTORY');
  const adminSocket = path(
    'ATMUSIC_ADMIN_SOCKET',
    runtimeDir && join(runtimeDir, 'atmusic', 'admin.sock'),
    'XDG_RUNTIME_DIR',
  );

  // --- Client IP (ADR §3.6): no default ---------------------------------------
  const ipHeaderRaw = env.ATMUSIC_CLIENT_IP_HEADER;
  let clientIpHeader: ClientIpHeader = 'none';
  if (ipHeaderRaw === undefined || ipHeaderRaw === '') {
    issue(
      'ATMUSIC_CLIENT_IP_HEADER',
      `is required (no default, ADR 0005 §3.6): one of ${CLIENT_IP_HEADERS.join(', ')}; see docs/deploy/exposure.md`,
    );
  } else if ((CLIENT_IP_HEADERS as readonly string[]).includes(ipHeaderRaw)) {
    clientIpHeader = ipHeaderRaw as ClientIpHeader;
  } else {
    issue('ATMUSIC_CLIENT_IP_HEADER', `must be one of ${CLIENT_IP_HEADERS.join(', ')}`);
  }

  const trustedProxies = (env.ATMUSIC_TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (trustedProxies.length === 0 || !trustedProxies.every(isCidr)) {
    issue('ATMUSIC_TRUSTED_PROXIES', 'must be a comma-separated list of IP addresses or CIDR prefixes');
  }

  // --- Sign-in policy (ADR §5.7) -----------------------------------------------
  const policyRaw = env.ATMUSIC_SIGNIN_POLICY ?? 'allowlist';
  let signinPolicy: SigninPolicy = 'allowlist';
  if (policyRaw === 'allowlist' || policyRaw === 'open') signinPolicy = policyRaw;
  else issue('ATMUSIC_SIGNIN_POLICY', 'must be allowlist or open');
  const signinDids = (env.ATMUSIC_SIGNIN_DIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (signinDids.some((did) => !isSupportedDid(did))) {
    issue('ATMUSIC_SIGNIN_DIDS', 'must be a comma-separated list of did:plc or did:web DIDs');
  } else if (signinPolicy === 'allowlist' && signinDids.length === 0) {
    issue('ATMUSIC_SIGNIN_DIDS', 'must list at least one DID while ATMUSIC_SIGNIN_POLICY is allowlist');
  }

  // --- Storage bounds (ADR §11.1) ----------------------------------------------
  const bytes = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = POSITIVE_INT.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n)) {
      issue(name, 'must be a positive integer number of bytes');
      return fallback;
    }
    return n;
  };
  const uploadMaxBytes = bytes('ATMUSIC_UPLOAD_MAX_BYTES', DEFAULT_UPLOAD_MAX_BYTES);
  const minFreeBytes = bytes('ATMUSIC_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES);

  // --- Upstream roots: https, DNS name, default port --------------------------
  const upstream = (name: string, fallback: string): string => {
    const value = env[name] ?? fallback;
    const check = checkUrl(value, { fixture });
    let reason: string | null = check.ok ? null : check.reason;
    if (check.ok) {
      if (LOOPBACK_NAMES.has(check.host)) reason = 'localhost';
      else if (check.url.search !== '' || value.includes('?')) reason = 'query';
      else if (!check.url.pathname.endsWith('/')) reason = 'path_without_trailing_slash';
    }
    if (reason !== null) {
      issue(name, `must be an https URL on a DNS name with the default port, ending in / (refused: ${reason})`);
    }
    return value;
  };
  const lastfmApiRoot = upstream('LASTFM_API_ROOT', DEFAULT_LASTFM_API_ROOT);
  const lastfmAuthUrl = upstream('LASTFM_AUTH_URL', DEFAULT_LASTFM_AUTH_URL);
  const listenbrainzApiRoot = upstream('LISTENBRAINZ_API_ROOT', DEFAULT_LISTENBRAINZ_API_ROOT);

  // --- Last.fm known public clients (ADR §7.4) --------------------------------
  const lastfmKnownClients: LastfmKnownClient[] = [];
  for (const triple of (env.ATMUSIC_LASTFM_KNOWN_CLIENTS ?? DEFAULT_LASTFM_KNOWN_CLIENTS).split(',')) {
    if (triple.trim() === '') continue;
    const m = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64}):([^:,]{1,64})$/.exec(triple.trim());
    if (m === null) {
      issue('ATMUSIC_LASTFM_KNOWN_CLIENTS', 'must be comma-separated apiKey:sharedSecret:name triples');
      break;
    }
    lastfmKnownClients.push({ apiKey: m[1] as string, sharedSecret: m[2] as string, name: (m[3] as string).trim() });
  }
  if (new Set(lastfmKnownClients.map((c) => c.apiKey)).size !== lastfmKnownClients.length) {
    issue('ATMUSIC_LASTFM_KNOWN_CLIENTS', 'lists an apiKey more than once');
  }

  const genericRaw = env.ATMUSIC_OAUTH_TRANSITION_GENERIC ?? '0';
  if (genericRaw !== '0' && genericRaw !== '1') issue('ATMUSIC_OAUTH_TRANSITION_GENERIC', 'must be 0 or 1');

  if (issues.length > 0 || app === null) throw new ConfigError(issues);

  return {
    app: httpFixtureOrigin ? { ...app, publicOrigin } : app,
    publicOrigin,
    listen: listen as ListenAddress,
    dbPath,
    assetsDir,
    backupDir,
    uploadDir,
    adminSocket,
    clientIpHeader,
    trustedProxies,
    signinPolicy,
    signinDids,
    uploadMaxBytes,
    minFreeBytes,
    ingestMode,
    lastfmApiRoot,
    lastfmAuthUrl,
    listenbrainzApiRoot,
    lastfmKnownClients,
    oauthTransitionGeneric: genericRaw === '1',
    busyTimeoutMs: PRODUCTION_BUSY_TIMEOUT_MS,
    drainMs: PRODUCTION_DRAIN_MS,
    fixtureOrigins: fixture,
  };
}
