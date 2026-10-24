// Validated runtime configuration and the namespace gate (ADR 0004 §4.2, §8,
// §15 Q3). Frozen in Wave 0.
//
// - An empty LEXICON_PREFIX gives `prefix: null`: ingestion and publication are
//   disabled and /api/v1/meta reports `lexiconPrefix: null`.
// - The fixture prefix `com.example.atmusic` is refused unless the caller
//   passes `allowFixturePrefix: true`. Only test entries (worker/test/**) pass
//   it; production code calls `parseConfig(env)` with no options. The fixture
//   prefix never enables publication (crates/core/src/namespace.rs).
// - Publication additionally needs NAMESPACE_OWNERSHIP_REF, mirroring
//   Namespace::require_publication.
//
// Secrets are not part of AppConfig (it reaches every DO module through
// ModuleDeps); `parseCursorKey` reads CURSOR_KEY separately for the Worker.

import type { EnvSecrets, EnvVars } from './env';

export const FIXTURE_PREFIX = 'com.example.atmusic';

export type IngestMode = 'socket' | 'pulse' | 'off';
export type Plan = 'paid' | 'free';

export const LOCATION_HINTS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'] as const;
export type LocationHint = (typeof LOCATION_HINTS)[number];

/** Per-alarm budgets (ADR 0004 §5.4, §5.9, F5). */
export interface SliceBudget {
  /** Hints verified per drain run. */
  drainHints: number;
  /** Outbound subrequests per alarm slice (drain or snapshot). */
  subrequestsPerSlice: number;
  /** Snapshot entries applied per slice. */
  maxEntriesPerSlice: number;
  /** Concurrent proof fetches in a drain. */
  concurrentFetches: number;
  /** Concurrent proof fetches per PDS host. */
  perHostConcurrency: number;
}

export const BUDGETS: Readonly<Record<Plan, SliceBudget>> = {
  paid: {
    drainHints: 200,
    subrequestsPerSlice: 200,
    maxEntriesPerSlice: 2000,
    concurrentFetches: 4,
    perHostConcurrency: 2,
  },
  free: {
    drainHints: 40,
    subrequestsPerSlice: 40,
    maxEntriesPerSlice: 2000,
    concurrentFetches: 4,
    perHostConcurrency: 2,
  },
};

export interface Collections {
  scrobble: string;
  follow: string;
  settings: string;
}

export interface AppConfig {
  publicOrigin: string;
  /** Null when LEXICON_PREFIX is empty (namespace gate closed). */
  prefix: string | null;
  /** True only for the fixture prefix, which test entries alone may enable. */
  fixturePrefix: boolean;
  /** Null when prefix is null. */
  collections: Collections | null;
  namespaceOwnershipRef: string | null;
  /** Owned, non-fixture prefix plus ownership evidence (A20 `publication`). */
  publication: boolean;
  /** The configured INGEST_MODE. */
  configuredIngestMode: IngestMode;
  /** Effective mode: forced to `off` while the namespace gate is closed. */
  ingestMode: IngestMode;
  jetstreamUrls: readonly string[];
  jetstreamLookbackHours: number;
  relayUrl: string;
  plan: Plan;
  budget: SliceBudget;
  doLocationHint: LocationHint | null;
  /** True when ADMIN_TOKEN is set (the token itself is not copied here). */
  adminEnabled: boolean;
}

export interface ConfigIssue {
  field: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`invalid configuration: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigError';
  }
}

export interface ParseConfigOptions {
  /** Test entries only. Never set by worker/src. */
  allowFixturePrefix?: boolean;
}

const MIN_ADMIN_TOKEN_CHARS = 32;
const MAX_LOOKBACK_HOURS = 720;

function validLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/** Lowercase reverse-domain NSID prefix, as Namespace::new accepts. */
export function isValidPrefix(prefix: string): boolean {
  const labels = prefix.split('.');
  return labels.length >= 2 && prefix.length <= 253 && /^[a-z]/.test(labels[0] ?? '') && labels.every(validLabel);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `https://host` exactly: no path, explicit port, query, fragment or credentials. */
function isHttpsOrigin(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && url.protocol === 'https:' && url.origin === value;
}

function isServiceUrl(value: string, protocol: 'https:' | 'wss:'): boolean {
  const url = parseUrl(value);
  return (
    url !== null &&
    url.protocol === protocol &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    // Reject an explicit port, including the default one.
    `${url.protocol}//${url.host}` === value.replace(/\/$/, '')
  );
}

export function parseConfig(
  env: EnvVars & Pick<EnvSecrets, 'ADMIN_TOKEN'>,
  options: ParseConfigOptions = {},
): AppConfig {
  const issues: ConfigIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });

  const publicOrigin = env.PUBLIC_ORIGIN ?? '';
  if (!isHttpsOrigin(publicOrigin)) {
    issue('PUBLIC_ORIGIN', 'must be an https origin without path, port, query, fragment or credentials');
  }

  const rawPrefix = (env.LEXICON_PREFIX ?? '').trim();
  let prefix: string | null = null;
  let fixturePrefix = false;
  if (rawPrefix !== '') {
    if (!isValidPrefix(rawPrefix)) {
      issue('LEXICON_PREFIX', 'must be a lowercase reverse-domain NSID prefix');
    } else if (rawPrefix === FIXTURE_PREFIX && options.allowFixturePrefix !== true) {
      issue('LEXICON_PREFIX', `${FIXTURE_PREFIX} is fixture-only and is refused outside test entries`);
    } else {
      prefix = rawPrefix;
      fixturePrefix = rawPrefix === FIXTURE_PREFIX;
    }
  }

  const rawRef = (env.NAMESPACE_OWNERSHIP_REF ?? '').trim();
  const namespaceOwnershipRef = rawRef === '' ? null : rawRef;
  if (namespaceOwnershipRef !== null && (rawPrefix === '' || rawPrefix === FIXTURE_PREFIX)) {
    issue('NAMESPACE_OWNERSHIP_REF', 'ownership evidence requires an owned, non-fixture LEXICON_PREFIX');
  }

  const mode = env.INGEST_MODE ?? '';
  let configuredIngestMode: IngestMode = 'off';
  if (mode === 'socket' || mode === 'pulse' || mode === 'off') {
    configuredIngestMode = mode;
  } else {
    issue('INGEST_MODE', 'must be socket, pulse or off');
  }

  const jetstreamUrls = (env.JETSTREAM_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== '');
  if (jetstreamUrls.length === 0 && configuredIngestMode !== 'off') {
    issue('JETSTREAM_URLS', 'needs at least one wss:// host unless INGEST_MODE is off');
  }
  for (const url of jetstreamUrls) {
    if (!isServiceUrl(url, 'wss:')) {
      issue('JETSTREAM_URLS', `${url} must be a wss:// host without path, port, query or credentials`);
    }
  }

  const lookbackRaw = env.JETSTREAM_LOOKBACK_HOURS ?? '';
  const jetstreamLookbackHours = /^[0-9]+$/.test(lookbackRaw) ? Number(lookbackRaw) : Number.NaN;
  if (
    !Number.isSafeInteger(jetstreamLookbackHours) ||
    jetstreamLookbackHours < 1 ||
    jetstreamLookbackHours > MAX_LOOKBACK_HOURS
  ) {
    issue('JETSTREAM_LOOKBACK_HOURS', `must be an integer from 1 to ${MAX_LOOKBACK_HOURS}`);
  }

  const relayUrl = env.RELAY_URL ?? '';
  if (!isServiceUrl(relayUrl, 'https:')) {
    issue('RELAY_URL', 'must be an https:// host without path, port, query or credentials');
  }

  const planRaw = env.PLAN ?? '';
  let plan: Plan = 'paid';
  if (planRaw === 'paid' || planRaw === 'free') plan = planRaw;
  else issue('PLAN', 'must be paid or free');

  const hintRaw = (env.DO_LOCATION_HINT ?? '').trim();
  let doLocationHint: LocationHint | null = null;
  if (hintRaw !== '') {
    if ((LOCATION_HINTS as readonly string[]).includes(hintRaw)) doLocationHint = hintRaw as LocationHint;
    else issue('DO_LOCATION_HINT', `must be empty or one of ${LOCATION_HINTS.join(', ')}`);
  }

  const adminToken = env.ADMIN_TOKEN ?? '';
  if (adminToken !== '' && adminToken.length < MIN_ADMIN_TOKEN_CHARS) {
    issue('ADMIN_TOKEN', `must be at least ${MIN_ADMIN_TOKEN_CHARS} characters when set`);
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    publicOrigin,
    prefix,
    fixturePrefix,
    collections:
      prefix === null
        ? null
        : { scrobble: `${prefix}.scrobble`, follow: `${prefix}.follow`, settings: `${prefix}.settings` },
    namespaceOwnershipRef,
    publication: prefix !== null && !fixturePrefix && namespaceOwnershipRef !== null,
    configuredIngestMode,
    ingestMode: prefix === null ? 'off' : configuredIngestMode,
    jetstreamUrls,
    jetstreamLookbackHours,
    relayUrl,
    plan,
    budget: BUDGETS[plan],
    doLocationHint,
    adminEnabled: adminToken !== '',
  };
}

export const MIN_CURSOR_KEY_BYTES = 32;

/**
 * CURSOR_KEY is hex (`openssl rand -hex 32`). It is the application key that
 * the cursor codec derives its HMAC key from, exactly as crates/core/src/cursor.rs.
 */
export function parseCursorKey(env: Pick<EnvSecrets, 'CURSOR_KEY'>): Uint8Array {
  const hex = (env.CURSOR_KEY ?? '').trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex) || hex.length < MIN_CURSOR_KEY_BYTES * 2) {
    throw new ConfigError([
      { field: 'CURSOR_KEY', message: `must be at least ${MIN_CURSOR_KEY_BYTES} hex-encoded bytes` },
    ]);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (bytes.every((b) => b === 0)) {
    throw new ConfigError([{ field: 'CURSOR_KEY', message: 'must not be all zero' }]);
  }
  return bytes;
}
