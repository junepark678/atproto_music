// The Node composition (ADR 0005 §2.1, §3.1, §3.3, §3.7, §3.10; N2-01): the
// Host, IndexCore, the feature services, the route table and the request
// handler, over an already-open, migrated database. The process around it —
// run/main, listen, systemd, shutdown, the admin socket, backups — is N3-07's
// (node/run.ts), and the production feature list is N4-01's (node/features.ts).
//
//   const app = await compose(config, secrets, {db, transport, connectJetstream, features});
//   createServer({publicOrigin: config.publicOrigin, listen, handler: app.handler});
//
// What compose does, in order:
//  1. Reads the schema state (never migrates: run() migrates before compose,
//     ADR §3.2): `ready` when the ledger is at this code's latest migration,
//     or newer with `schema_compat.min_compatible_version` at most it;
//     `too_new` otherwise; `pending` for an unmigrated database.
//  2. Derives the cursor HMAC key from `secrets.cursorKey` and loads the OAuth
//     keyset: every signing key is imported into WebCrypto and must sign a
//     probe that its public half verifies, and every announced key must
//     import. A failure is recorded for readiness and logged by kid only.
//  3. Builds the Host — the db, two NodeAlarms (core and extension lane) on
//     one NodeScheduler, the Jetstream connector, the transport, the optional
//     backup port, the logger, the clock and the randomness — and IndexCore
//     with every feature's CoreExtensions. A ready schema is recorded
//     (`markMigrated`); a `too_new` one too, so ready() reports it and
//     nothing runs.
//  4. Builds AppServices: each feature's `services(context)` part is merged
//     into one object (two features may not provide the same service).
//  5. Builds the route table — ROUTES without the Workers TCP admin routes
//     (`/internal/` is the dispatcher's JSON 404, ADR §3.11), `/health/ready`
//     answered by this module's readiness, then every feature's routes — and
//     the dispatcher (node/dispatch.ts) over the static files of
//     `config.assetsDir` (ATMUSIC_ASSETS_DIR, default <release>/web/dist),
//     which are loaded first of all, so a broken dist refuses the composition
//     before anything runs.
//  6. Last, starts IndexCore when the schema is ready (noteRestart, lease
//     reclaim, both lanes armed) and the wake heartbeat and ensureRunning
//     interval. A failure before this stops every timer and rethrows.
//
// Every RequestCtx compose builds carries `deps` (the core's ModuleDeps),
// `app` (the merged AppServices) and `peer` (the socket address, `0.0.0.0`
// when the socket reports none), besides the
// ADR 0004 members: `env` (the two namespace variables, from the parsed
// config), `index` (IndexCore), a request id from the injected Random, the
// clock, the cursor key, and `clientIp` from the client-IP policy (ADR §3.6).
//
// Readiness (`ready()`, served at GET /health/ready; ADR §3.10). Not ready
// unless all of: the schema is current (re-read each time), the config was
// parsed, the secrets are loaded, the OAuth keyset is valid (and no feature
// reports a failure), and the database answers a write probe — a transaction
// that writes one counters row and is always rolled back. Warnings do not
// change the status, so a tunnel keeps routing live scrobbles: `low_disk`
// (free space on the database's filesystem below ATMUSIC_MIN_FREE_BYTES) and
// whatever features report (`oauth_store_degraded`, N2-03). /health/ready
// answers 200 `{status: 'ready'}`, with `warnings` (the contract's v1.2
// optional Ready property) only while one is raised, or 503 `not_ready` with the envelope; the failed probe names are logged,
// never returned.
//
// Fault injection is only through these inputs (a wrapping Db, the secrets,
// the transport, the disk probe, the timers); there is no test switch.

import { dirname } from 'node:path';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import { deriveCursorKey } from '@atmusic/core/cursor';
import { type Clock, cryptoRandom, type Random, systemClock } from '@atmusic/core/deps';
import type { BackupPort, CoreExtension } from '../app/host';
import { createLogger, errorName, IndexCore } from '../app/index-core';
import type { AppServices } from '../app/services';
import type { Logger, ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import type { ConnectJetstream } from '../do/ingest/jetstream-socket';
import type { MigrateResult } from '../do/migrate';
import { MIGRATIONS } from '../do/schema';
import { errorResponse } from '../http/error';
import { json } from '../http/json';
import { createRouteTable, ROUTES, type RouteTable } from '../http/routes';
import type { AppEnv, RequestCtx, RouteDef } from '../http/types';
import { type HostTimers, NodeScheduler } from './alarm';
import { createClientIpPolicy, resolveClientIp, UNKNOWN_PEER } from './client-ip';
import type { NodeConfig } from './config';
import { diskLowProbe } from './disk';
import { createDispatcher, type DispatchInfo } from './dispatch';
import type { BridgeHandler } from './http-bridge';
import type { PrivateEs256Jwk, PublicEs256Jwk, Secrets } from './secrets';
import { loadStaticAssets, type StaticAssets } from './static-assets';

/**
 * The readiness warnings (ADR §3.10): compose raises `low_disk`, the OAuth
 * store feature `oauth_store_degraded` (N2-03). The set is closed because the
 * contract's Ready schema (api/openapi.yaml, v1.2) enumerates it; a new
 * warning needs a contract amendment first.
 */
export const READINESS_WARNINGS = ['low_disk', 'oauth_store_degraded'] as const;
export type ReadinessWarning = (typeof READINESS_WARNINGS)[number];

function isReadinessWarning(value: unknown): value is ReadinessWarning {
  return (READINESS_WARNINGS as readonly unknown[]).includes(value);
}

/** What a feature adds to readiness. */
export interface FeatureReadiness {
  /** Names of failed probes: any one makes /health/ready 503. */
  readonly failures?: readonly string[];
  readonly warnings?: readonly ReadinessWarning[];
}

/** What a feature's `services` hook receives. */
export interface FeatureContext {
  readonly config: NodeConfig;
  readonly secrets: Secrets;
  readonly deps: ModuleDeps;
  readonly core: IndexCore;
  readonly log: Logger;
}

/** One unit of the application (ADR §3.1): routes, extension timers, services and readiness. */
export interface Feature {
  /** For errors and logs. */
  readonly name: string;
  readonly routes?: readonly RouteDef[];
  /** Passed to IndexCore (extension timers and start hooks). */
  readonly extensions?: readonly CoreExtension[];
  /** Runs once, after IndexCore is built and before it starts. */
  services?(context: FeatureContext): Partial<AppServices>;
  /** Called on every readiness check. */
  readiness?(): FeatureReadiness;
}

export interface ComposeOptions {
  /** The open, migrated database (node/sqlite-db.ts, or a wrapper of it). compose never migrates or closes it. */
  db: Db;
  /** The outbound transport: the pinned transport in production (ADR §3.5). */
  transport: Transport;
  connectJetstream: ConnectJetstream;
  features?: readonly Feature[];
  clock?: Clock;
  random?: Random;
  /** Default: the redacting JSON-line logger on the console (journald). */
  log?: Logger;
  /** Timer functions of the scheduler; Node's by default. */
  timers?: HostTimers;
  /** True while free space is below ATMUSIC_MIN_FREE_BYTES; default statfs on the database's directory. */
  diskLow?: () => boolean;
  /** The static files; default `loadStaticAssets(config.assetsDir)`. */
  assets?: StaticAssets;
  /** Online backups (N3-07); absent: adminBackup answers not_supported. */
  backup?: BackupPort;
  /** Default: the identity resolver over identity_cache and the transport. */
  identity?: IdentityResolver;
}

export type SchemaState = { status: 'ready' | 'too_new'; version: number } | { status: 'pending'; version: number };

export interface ReadinessChecks {
  schema: boolean;
  config: boolean;
  secrets: boolean;
  oauthKeyset: boolean;
  dbWrite: boolean;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessChecks;
  /** Failed probe names (the false checks, then feature failures). */
  failures: string[];
  warnings: ReadinessWarning[];
}

export interface ComposedApp {
  /** The bridge handler (node/http-bridge.ts). */
  readonly handler: BridgeHandler;
  readonly core: IndexCore;
  readonly app: AppServices;
  readonly routes: RouteTable;
  readonly scheduler: NodeScheduler;
  /** The schema state compose found. */
  readonly schema: SchemaState;
  ready(): Promise<ReadinessReport>;
  /** Stops every timer and interval. The database stays open: its owner closes it. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Schema state (read-only)

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** The schema state of `db` for this code, read without writing (module comment). */
export function readSchemaState(db: Db): SchemaState {
  const ledger = db.one<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if ((ledger?.n ?? 0) === 0) return { status: 'pending', version: 0 };
  const version = db.one<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
  if (version < LATEST_VERSION) return { status: 'pending', version };
  if (version === LATEST_VERSION) return { status: 'ready', version };
  const compat = db.one<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_compat'",
  );
  if ((compat?.n ?? 0) === 0) return { status: 'too_new', version };
  const min = db.one<{ v: unknown }>('SELECT max(min_compatible_version) AS v FROM schema_compat')?.v;
  const minimum = typeof min === 'number' && Number.isSafeInteger(min) ? min : version;
  return { status: minimum <= LATEST_VERSION ? 'ready' : 'too_new', version };
}

// ---------------------------------------------------------------------------
// Probes

/** The counters row the write probe writes and always rolls back. */
export const WRITE_PROBE_COUNTER = '~ready_probe';

class ProbeRollback extends Error {
  override readonly name = 'ProbeRollback';
}

/** True when a write transaction commits its writes up to the rollback (module comment). */
export function writeProbe(db: Db): boolean {
  try {
    db.tx(() => {
      db.run(
        `INSERT INTO counters(name, label, value) VALUES (?, '', 0)
         ON CONFLICT(name, label) DO UPDATE SET value = value + 1`,
        WRITE_PROBE_COUNTER,
      );
      throw new ProbeRollback('rolled back');
    });
  } catch (error) {
    return error instanceof ProbeRollback;
  }
  return false;
}

const KEYSET_PROBE = new TextEncoder().encode('atmusic/readiness/oauth-keyset/v1');
const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ES256_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Every signing key signs a probe its public half verifies; every announced key imports. */
export async function checkOAuthKeyset(
  signing: readonly PrivateEs256Jwk[],
  announced: readonly PublicEs256Jwk[],
): Promise<{ ok: true } | { ok: false; kid: string | null; error: string }> {
  if (signing.length === 0) return { ok: false, kid: null, error: 'no_signing_key' };
  for (const jwk of signing) {
    try {
      const { kty, crv, d, x, y } = jwk;
      const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, d, x, y }, ES256, false, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y }, ES256, false, ['verify']);
      const signature = await crypto.subtle.sign(ES256_SIGN, privateKey, KEYSET_PROBE);
      if (!(await crypto.subtle.verify(ES256_SIGN, publicKey, signature, KEYSET_PROBE))) {
        return { ok: false, kid: jwk.kid, error: 'key_mismatch' };
      }
    } catch (error) {
      return { ok: false, kid: jwk.kid, error: errorName(error) };
    }
  }
  for (const jwk of announced) {
    try {
      const { kty, crv, x, y } = jwk;
      await crypto.subtle.importKey('jwk', { kty, crv, x, y }, ES256, false, ['verify']);
    } catch (error) {
      return { ok: false, kid: jwk.kid, error: errorName(error) };
    }
  }
  return { ok: true };
}

function secretsLoaded(secrets: Secrets | null | undefined): boolean {
  return (
    secrets !== null &&
    secrets !== undefined &&
    secrets.cursorKey instanceof Uint8Array &&
    secrets.cursorKey.byteLength >= 32 &&
    secrets.encryptionKeys.length > 0 &&
    secrets.oauthSigningKeys.length > 0
  );
}

function configParsed(config: NodeConfig | null | undefined): boolean {
  return (
    config !== null &&
    config !== undefined &&
    typeof config.publicOrigin === 'string' &&
    config.app?.publicOrigin === config.publicOrigin
  );
}

// ---------------------------------------------------------------------------
// Composition

/** ROUTES as the Node host serves them: no TCP admin routes, readiness from compose. */
function baseRoutes(readyHandler: RouteDef['handler']): RouteDef[] {
  return ROUTES.filter((route) => !route.pattern.startsWith('/internal/')).map((route) =>
    route.method === 'GET' && route.pattern === '/health/ready' ? { ...route, handler: readyHandler } : route,
  );
}

function defaultLog(secrets: Secrets): Logger {
  const key = Buffer.from(secrets.cursorKey);
  return createLogger([key.toString('base64'), key.toString('hex')]);
}

export async function compose(config: NodeConfig, secrets: Secrets, options: ComposeOptions): Promise<ComposedApp> {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  const log = options.log ?? defaultLog(secrets);
  const features = options.features ?? [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.name)) throw new TypeError(`feature ${feature.name} is listed twice`);
    seen.add(feature.name);
  }

  // The static files first: a broken dist fails compose before anything starts.
  const assets = options.assets ?? loadStaticAssets(config.assetsDir, { random });

  // 1–2. Schema, cursor key, keyset.
  const schema = readSchemaState(db);
  const cursorKey = await deriveCursorKey(secrets.cursorKey);
  const keyset = await checkOAuthKeyset(secrets.oauthSigningKeys, secrets.oauthAnnouncedKeys);
  if (!keyset.ok) log.log('error', 'oauth.keyset_invalid', { kid: keyset.kid, error: keyset.error });

  // 3. Host and IndexCore.
  const scheduler = new NodeScheduler({
    log,
    clock,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });
  try {
    return composeOver(scheduler);
  } catch (error) {
    scheduler.stop();
    throw error;
  }

  function composeOver(scheduler: NodeScheduler): ComposedApp {
    let core: IndexCore | null = null;
    const alarm = scheduler.alarm({ name: 'core', onAlarm: () => core?.alarm() });
    const extensionAlarm = scheduler.alarm({ name: 'extension', onAlarm: () => core?.extensionAlarm() });
    core = new IndexCore(
      config.app,
      {
        db,
        alarm,
        extensionAlarm,
        connectJetstream: options.connectJetstream,
        transport: options.transport,
        ...(options.backup === undefined ? {} : { backup: options.backup }),
        log,
        clock,
        random,
      },
      features.flatMap((feature) => feature.extensions ?? []),
      options.identity === undefined ? {} : { identity: options.identity },
    );
    const index: IndexCore = core;
    if (schema.status !== 'pending') {
      const result: MigrateResult = { status: schema.status, version: schema.version };
      index.markMigrated(result);
    }

    // 4. AppServices.
    const app = {} as AppServices;
    const context: FeatureContext = { config, secrets, deps: index.deps, core: index, log };
    for (const feature of features) {
      const part = feature.services?.(context);
      if (part === undefined) continue;
      for (const [key, value] of Object.entries(part)) {
        if (Object.hasOwn(app, key)) throw new TypeError(`feature ${feature.name}: service ${key} is already provided`);
        (app as unknown as Record<string, unknown>)[key] = value;
      }
    }
    Object.freeze(app);

    // Readiness.
    const diskLow = options.diskLow ?? diskLowProbe(dirname(config.dbPath), config.minFreeBytes);
    const configOk = configParsed(config);
    const secretsOk = secretsLoaded(secrets);
    const ready = async (): Promise<ReadinessReport> => {
      let schemaOk = false;
      try {
        schemaOk = readSchemaState(db).status === 'ready' && index.isReady;
      } catch {
        schemaOk = false;
      }
      const checks: ReadinessChecks = {
        schema: schemaOk,
        config: configOk,
        secrets: secretsOk,
        oauthKeyset: keyset.ok,
        dbWrite: writeProbe(db),
      };
      const failures: string[] = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      const warnings: ReadinessWarning[] = [];
      try {
        if (diskLow()) warnings.push('low_disk');
      } catch (error) {
        log.log('warn', 'ready.disk_probe_failed', { error: errorName(error) });
      }
      for (const feature of features) {
        let part: FeatureReadiness | undefined;
        try {
          part = feature.readiness?.();
        } catch (error) {
          failures.push(`${feature.name}:readiness`);
          log.log('error', 'ready.feature_failed', { feature: feature.name, error: errorName(error) });
          continue;
        }
        for (const failure of part?.failures ?? []) failures.push(failure);
        for (const warning of part?.warnings ?? []) {
          // A warning outside the contract's enum is logged, never returned.
          if (!isReadinessWarning(warning)) {
            log.log('warn', 'ready.unknown_warning', { feature: feature.name });
            continue;
          }
          if (!warnings.includes(warning)) warnings.push(warning);
        }
      }
      return { ready: failures.length === 0, checks, failures, warnings };
    };

    const readyHandler: RouteDef['handler'] = async (_req, ctx) => {
      const report = await ready();
      if (!report.ready) {
        log.log('warn', 'ready.not_ready', { requestId: ctx.requestId, failures: report.failures });
        return errorResponse('not_ready', 503, ctx.requestId);
      }
      return json(report.warnings.length === 0 ? { status: 'ready' } : { status: 'ready', warnings: report.warnings });
    };

    // Routes and the dispatcher.
    const routes = createRouteTable([
      ...baseRoutes(readyHandler),
      ...features.flatMap((feature) => feature.routes ?? []),
    ]);
    const clientIpPolicy = createClientIpPolicy({
      mode: config.clientIpHeader,
      trustedProxies: config.trustedProxies.join(','),
    });
    const env: AppEnv = {
      LEXICON_PREFIX: config.app.prefix ?? '',
      NAMESPACE_OWNERSHIP_REF: config.app.namespaceOwnershipRef ?? '',
    };
    const buildCtx = (request: Request, info: DispatchInfo, requestId: string): RequestCtx => ({
      env,
      index,
      requestId,
      clock,
      cursorKey,
      clientIp: resolveClientIp(clientIpPolicy, info.peer, request.headers),
      deps: index.deps,
      app,
      peer: info.peer ?? UNKNOWN_PEER,
    });
    const dispatcher = createDispatcher({ routes, assets, context: buildCtx, log, random });

    // 5. Start, last: everything that can refuse the composition has run.
    if (schema.status === 'ready') index.start();
    scheduler.startHeartbeat([alarm, extensionAlarm]);
    scheduler.startEnsureRunning({
      ensureRunning: async () => {
        if (index.isReady) await index.ensureRunning();
      },
    });

    return {
      handler: (request, info) => dispatcher(request, info),
      core: index,
      app,
      routes,
      scheduler,
      schema,
      ready,
      stop: () => scheduler.stop(),
    };
  }
}
