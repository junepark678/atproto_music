// The production feature list of the Node host (ADR 0005 §3.1, §3.5, §3.10,
// §4, B18, B20; N4-01).
//
// `productionFeatures(options)` is what run() (node/run.ts) composes, in this
// order:
//
//   web-sessions     the one cookie-session store every cookie feature shares
//   auth             sign-in, callback, session, logout, disconnect, the client
//                    metadata and JWKS (http/auth.ts, http/oauth-docs.ts); its
//                    OAuth service is built here, so the outbox writers, the
//                    keepalive, the expiry sweep and the startup reconcile use
//                    the very same client
//   web-writes       the v1.2 write, operation and account routes (http/writes.ts)
//   lastfm-auth      /api/auth[/] and POST /api/v1/lastfm/authorize, the
//                    `lastfmAuth` service (http/lastfm-authorize.ts)
//   lastfm           /2.0 and /2.0/ over the read tables and N3-03's auth and
//                    write tables (lastfm/routes.ts), and the reserved 1.2 paths
//                    (lastfm/as12.ts)
//   listenbrainz     every /1/ route (listenbrainz/routes.ts) with N3-05's
//                    submit and token routes in its registry, all charged to one
//                    limiter (`listenBrainzLimiterFor`, AMENDMENTS-node.md "N3-05
//                    registry routes and the /1/ router")
//   links            the link routes and the `forward` timer (http/links.ts)
//   imports          the import routes and the `import` timer (http/imports.ts)
//   credential-settings  the credential routes (http/credentials.ts)
//   outbox           the `outbox` timer, writing through the OAuth sessions
//   oauth-keepalive  the hourly keepalive (bff/keepalive.ts)
//   expiry-sweep     every 10 minutes (EXPIRY_SWEEP_INTERVAL_MS): the sign-in
//                    policy reconcile (bff/reconcile.ts, B20), then the expired
//                    OAuth states, link states, Last.fm desktop tokens, web
//                    sessions and now-playing rows, and ignored_listens past
//                    their 30-day retention
//   meta             the `meta` service: the v1.2 capabilities GET /api/v1/meta
//                    adds (http/meta.ts, B14, B18)
//   backup           the daily backup timer (node/backup.ts), when given
//
// The six extension timers therefore all have a handler, and IndexCore runs
// them in EXTENSION_TIMER_NAMES order (outbox, forward, import,
// oauth-keepalive, expiry-sweep, backup).
//
// **The startup reconcile comes first (ADR §5.5, B20).** compose starts
// IndexCore, and so arms the extension lane (the outbox, forward and import
// starts are due at once), before run() can reconcile the sign-in policy; and
// the reconcile awaits each refused DID's upstream revoke in turn. Every
// extension timer handler of this list therefore waits for `startup()` (the
// one startup reconcile run() calls before listen) to finish before it does
// anything, so no PDS write, forward, import, keepalive refresh or backup runs
// while a refused DID still holds its session, its queued operations or its
// links. A startup reconcile that fails keeps every one of them closed (run()
// then exits 1). Besides, `writerFor` answers null for a DID the policy
// refuses, so the outbox blocks its operations rather than writing them.
//
// **Outbound transports (ADR §3.5 rule 2).** Every outbound consumer gets its
// transport from one `OutboundTransports` source, per wiring point:
//
//   core       SafeFetch (verified reads of every core module: the Host transport)
//   identity   the identity resolver and the handle resolver it builds
//   oauth      the OAuth client (PAR, token, revoke, metadata) and so every
//              PdsWriter, since writes go through the sessions' fetchHandler
//   forward    the Last.fm and ListenBrainz forward and link clients
//   imports    the Last.fm and ListenBrainz import sources
//   jetstream  the Jetstream connector, which dials through the pinned
//              transport's checked lookup (`jetstreamConnector`)
//
// Production hands every wire the same pinned transport (`sharedOutbound`).
// The features test (worker/test/node/features.test.ts) hands a spy and fails
// unless every consumer's traffic went through it. A wire is wired by giving
// the feature a FeatureContext whose `deps.transport` is that wire's
// transport (`onWire`), or by building the consumer here over it; nothing in
// this module ever falls back to the global fetch.

import { isIP, type LookupFunction } from 'node:net';
import { createIdentityResolver } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { DeadlineTimer } from '@atmusic/atproto/net/safe-fetch';
import { isAllowedAddress } from '@atmusic/atproto/net/url-policy';
import type { Transport } from '@atmusic/atproto/transport';
import type { AccountCapability } from '@atmusic/core/api-types';
import type { Clock } from '@atmusic/core/deps';
import WebSocket, { type ClientOptions } from 'ws';
import type { CoreExtension, ExtensionContext, ExtensionTimerHandler } from '../app/host';
import { errorName } from '../app/index-core';
import type { Revocations } from '../app/revocations';
import { clientMetadataFor } from '../bff/client-metadata';
import { KEEPALIVE_INTERVAL_MS, oauthKeepaliveTimer } from '../bff/keepalive';
import { createOAuthService, type OAuthService } from '../bff/oauth-client';
import { type ReconcileReport, reconcileSignInPolicy, signInAllowed } from '../bff/reconcile';
import { createWebSessions, sweepExpiredWebSessions, type WebSessions } from '../bff/sessions';
import { sweepLastfmTokens } from '../credentials/lastfm-auth';
import { createBox } from '../crypto/box';
import type { Db } from '../do/db';
import { identityCache } from '../do/ingest/identity-cache';
import { type ConnectJetstream, JetstreamConnectError } from '../do/ingest/jetstream-socket';
import { deleteExpiredNowPlaying } from '../do/read/now-playing';
import { sweepExpiredLinkStates } from '../forward/links';
import { UpstreamPacing } from '../forward/upstream-pacing';
import { IGNORED_LISTEN_RETENTION_MS } from '../http/account';
import { authFeature } from '../http/auth';
import { credentialsFeature } from '../http/credentials';
import { importsFeature } from '../http/imports';
import { lastfmAuthFeature } from '../http/lastfm-authorize';
import { linksFeature } from '../http/links';
import type { MetaService } from '../http/meta';
import { defaultAccountCapabilities, writesFeature } from '../http/writes';
import { intervalPacer, type Pacer } from '../imports/jobs';
import { routes as as12Routes } from '../lastfm/as12';
import { authMethods, handleLastfmMethod } from '../lastfm/auth-methods';
import { lastfmRoutes } from '../lastfm/routes';
import { writeMethods } from '../lastfm/write-methods';
import { listenBrainzRoutes } from '../listenbrainz/routes';
import { createSubmitRoutes } from '../listenbrainz/submit';
import { createTokenRoutes, listenBrainzLimiterFor } from '../listenbrainz/token-routes';
import { type PdsWriter, type PdsWriterSource, ReauthRequiredError, sessionWriter } from '../outbox/pds-writer';
import { outboxExtension } from '../outbox/runner';
import { backupExtension } from './backup';
import type { Feature, FeatureContext } from './compose';
import type { NodeConfig } from './config';
import { createJetstreamWsConnector, jetstreamWsTarget, type WsClientCtor } from './jetstream-ws';
import { type PinnedLookup, TransportError } from './pinned-transport';
import { createPolicyFetch } from './policy-fetch';
import type { Secrets } from './secrets';

// ---------------------------------------------------------------------------
// Outbound wiring

/** Every outbound consumer of the production composition (ADR §3.5 rule 2). */
export const OUTBOUND_CONSUMERS = [
  'identity-resolver',
  'handle-resolver',
  'safe-fetch',
  'oauth-client',
  'pds-writer',
  'lastfm-forward',
  'listenbrainz-forward',
  'lastfm-import',
  'listenbrainz-import',
  'jetstream',
] as const;
export type OutboundConsumer = (typeof OUTBOUND_CONSUMERS)[number];

/** The wiring points and the consumers each one serves (module comment). */
export const OUTBOUND_WIRES = Object.freeze({
  core: ['safe-fetch'],
  identity: ['identity-resolver', 'handle-resolver'],
  oauth: ['oauth-client', 'pds-writer'],
  forward: ['lastfm-forward', 'listenbrainz-forward'],
  imports: ['lastfm-import', 'listenbrainz-import'],
  jetstream: ['jetstream'],
} as const satisfies Record<string, readonly OutboundConsumer[]>);
export type OutboundWire = keyof typeof OUTBOUND_WIRES;

/** Where each wiring point takes its transport from. */
export interface OutboundTransports {
  transportFor(wire: OutboundWire): Transport;
}

/** Production: every wire gets the same (pinned) transport. */
export function sharedOutbound(transport: Transport): OutboundTransports {
  return { transportFor: () => transport };
}

/** The identity resolver of the `identity` wire, over identity_cache (compose's `identity` option). */
export function outboundIdentity(
  db: Db,
  outbound: OutboundTransports,
  clock: Clock,
  timer?: DeadlineTimer,
): IdentityResolver {
  // cachedIdentityResolver, spelled out so the transport property is visible at the call site.
  return createCachedResolver(db, outbound.transportFor('identity'), clock, timer);
}

function createCachedResolver(db: Db, transport: Transport, clock: Clock, timer?: DeadlineTimer): IdentityResolver {
  return createIdentityResolver({
    transport,
    clock,
    cache: identityCache(db, clock),
    ...(timer === undefined ? {} : { timer }),
  });
}

/** `feature` with a FeatureContext whose module deps carry `transport` (the wire's). */
function onWire(feature: Feature, transport: Transport): Feature {
  const services = feature.services;
  if (services === undefined) return feature;
  return {
    ...feature,
    services: (context: FeatureContext) => services.call(feature, { ...context, deps: { ...context.deps, transport } }),
  };
}

// ---------------------------------------------------------------------------
// Jetstream through the pinned lookup

/** A transport that exposes its connect options (node/pinned-transport.ts PinnedTransport). */
type WithLookup = Transport & { readonly connectOptions?: { readonly lookup?: PinnedLookup } };

/**
 * A Node `lookup` that answers only after every address `lookup` returns for
 * the host passed isAllowedAddress (the pinned transport's rule, ADR §3.5).
 */
export function checkedLookup(lookup: PinnedLookup): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number } | number, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === 'object' && options !== null && options.all === true;
    lookup(hostname).then(
      (answers) => {
        if (!Array.isArray(answers) || answers.length === 0) {
          cb(new TransportError('dns', `${hostname} has no addresses`, { reason: 'no_answers' }));
          return;
        }
        const checked: { address: string; family: 4 | 6 }[] = [];
        for (const answer of answers) {
          const address = typeof answer?.address === 'string' ? answer.address : '';
          if (!isAllowedAddress(address)) {
            cb(
              new TransportError('blocked_address', `${hostname} resolves to a non-public address`, {
                reason: 'private_answer',
                address,
              }),
            );
            return;
          }
          checked.push({ address, family: isIP(address) === 6 ? 6 : 4 });
        }
        const first = checked[0] as { address: string; family: 4 | 6 };
        if (all) cb(null, checked);
        else cb(null, first.address, first.family);
      },
      (error: unknown) => cb(error instanceof Error ? error : new TransportError('dns', String(error))),
    );
  }) as LookupFunction;
}

/**
 * The `ws` client constructor dialling only addresses `lookup` returned and
 * isAllowedAddress accepted; an IP-literal host is checked itself.
 */
export function pinnedWebSocket(lookup: PinnedLookup): WsClientCtor {
  const pinned = checkedLookup(lookup);
  return class PinnedWebSocket extends WebSocket {
    constructor(address: string, options: ClientOptions) {
      const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && !isAllowedAddress(host)) {
        throw new TransportError('blocked_address', `${host} is not a public address`, {
          reason: 'private_literal',
          address: host,
        });
      }
      super(address, { ...options, rejectUnauthorized: true, lookup: pinned } as ClientOptions);
    }
  } as unknown as WsClientCtor;
}

/**
 * The production Jetstream connector of the `jetstream` wire: the ws
 * connector (node/jetstream-ws.ts, JETSTREAM_URLS only) over the wire's
 * pinned lookup. A transport without one cannot pin, so every connect is
 * refused (fail closed) before any socket exists.
 */
export function jetstreamConnector(jetstreamUrls: readonly string[], transport: Transport): ConnectJetstream {
  const lookup = (transport as WithLookup).connectOptions?.lookup;
  if (typeof lookup !== 'function') {
    return async (url) => {
      const target = jetstreamWsTarget(url, jetstreamUrls);
      const host = target.ok ? target.url.host : '?';
      throw new JetstreamConnectError(null, null, `jetstream connect refused: ${host}: no pinned lookup`);
    };
  }
  return createJetstreamWsConnector({ jetstreamUrls, WebSocket: pinnedWebSocket(lookup) });
}

// ---------------------------------------------------------------------------
// The features

/** The expiry sweep runs every 10 minutes (B20: the sign-in policy is reconciled that often). */
export const EXPIRY_SWEEP_INTERVAL_MS = 600_000;
/** Rows one sweep step deletes at most. */
export const EXPIRY_SWEEP_LIMIT = 1000;

export interface ProductionFeatureOptions {
  config: NodeConfig;
  secrets: Secrets;
  /** The process clock (the shared upstream pacer runs on it). */
  clock: Clock;
  /** The revocation journal (production: the file journal under $STATE_DIRECTORY, N1-08). */
  revocations: Revocations;
  outbound: OutboundTransports;
  /** Free space below ATMUSIC_MIN_FREE_BYTES (node/disk.ts). */
  diskLow: () => boolean;
  /** Online backups: the daily `backup` timer is registered when given. */
  backups?: Parameters<typeof backupExtension>[0];
  /** policyFetch's deadline source for the OAuth client; AbortSignal.timeout by default. */
  timer?: DeadlineTimer;
}

export interface ExpirySweepReport {
  signedOut: number;
  oauthStates: number;
  linkStates: number;
  lastfmTokens: number;
  webSessions: number;
  nowPlaying: number;
  ignoredListens: number;
  /** Steps that threw (logged by error name); the others still ran. */
  failed: string[];
}

export interface ProductionFeatures {
  readonly features: readonly Feature[];
  /** The composition's OAuth service; null until composed. */
  oauth(): OAuthService | null;
  /** reconcileSignInPolicy over the composed services (what each expiry sweep runs first). */
  reconcile(): Promise<ReconcileReport>;
  /**
   * The startup reconcile: `reconcile()`, then the extension timers of this
   * list may run (module comment). run() calls it once, after compose and
   * before listen; until it resolves every extension timer handler waits, and
   * after it rejects every one fails. A second call throws.
   */
  startup(): Promise<ReconcileReport>;
  /** One expiry-sweep run at `now` (what the `expiry-sweep` timer runs). */
  sweep(now: number): Promise<ExpirySweepReport>;
}

/** The Last.fm import lane of the process's one Last.fm pacer (ADR §11.3, shared with forwarding). */
export function lastfmImportPacer(pacing: UpstreamPacing): Pacer {
  return {
    take(nowMs) {
      if (pacing.tryLastfm('import', nowMs)) return null;
      return Math.max(pacing.lastfmAvailableAt('import', nowMs), nowMs + 1);
    },
    holdUntil(untilMs) {
      pacing.deferLastfm(untilMs);
    },
  };
}

/** The gate the extension timers wait on until the startup reconcile has run. */
interface StartupGate {
  readonly done: Promise<void>;
  open(): void;
  fail(error: unknown): void;
}

function startupGate(): StartupGate {
  let open!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Rejection is observed by every waiting handler; this keeps it from being an unhandled one.
  done.catch(() => undefined);
  return { done, open, fail };
}

/** `extension` with every timer handler waiting for `gate` first. */
function afterStartup(extension: CoreExtension, gate: StartupGate): CoreExtension {
  const timers = extension.timers;
  if (timers === undefined) return extension;
  const gated: Partial<Record<keyof typeof timers, ExtensionTimerHandler>> = {};
  for (const [name, handler] of Object.entries(timers) as Array<[keyof typeof timers, ExtensionTimerHandler]>) {
    gated[name] = async (now, ctx) => {
      await gate.done;
      return handler(now, ctx);
    };
  }
  return { ...extension, timers: gated };
}

class NotComposedError extends Error {
  constructor(what: string) {
    super(`${what} is used before the composition built it`);
    this.name = 'NotComposedError';
  }
}

const REAUTH_ERRORS = new Set(['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError', 'ReauthRequiredError']);

export async function productionFeatures(options: ProductionFeatureOptions): Promise<ProductionFeatures> {
  const { config, secrets, revocations, outbound } = options;
  const pacing = new UpstreamPacing(options.clock);

  let context: FeatureContext | null = null;
  let sessions: WebSessions | null = null;
  let oauth: OAuthService | null = null;
  const composed = (): FeatureContext => {
    if (context === null) throw new NotComposedError('the production features');
    return context;
  };
  const webSessions = (): WebSessions => {
    if (sessions === null) throw new NotComposedError('the web sessions');
    return sessions;
  };
  const oauthService = (): OAuthService => {
    if (oauth === null) throw new NotComposedError('the OAuth service');
    return oauth;
  };
  /** The shared store, for features that take it before the composition exists. */
  const sharedSessions: Pick<WebSessions, 'lookupCookieHeader' | 'renew'> = {
    lookupCookieHeader: (header) => webSessions().lookupCookieHeader(header),
    renew: (session) => webSessions().renew(session),
  };
  const kickOutbox = (): void => {
    context?.core.extensionTimers.kick('outbox');
  };

  const sessionsFeature: Feature = {
    name: 'web-sessions',
    services(ctx) {
      context = ctx;
      sessions = createWebSessions({ db: ctx.deps.db, clock: ctx.deps.clock, random: ctx.deps.random, revocations });
      return {};
    },
  };

  const auth = await authFeature(secrets, {
    revocations,
    oauth: (ctx, { keyset }) => {
      const { deps } = ctx;
      oauth = createOAuthService({
        db: deps.db,
        clock: deps.clock,
        random: deps.random,
        log: deps.log,
        identity: deps.identity,
        policyFetch: createPolicyFetch({
          transport: outbound.transportFor('oauth'),
          ...(options.timer === undefined ? {} : { timer: options.timer }),
        }),
        box: createBox(secrets.encryptionKeys, deps.random),
        keyset,
        clientMetadata: clientMetadataFor(ctx.config),
        revocations,
        onAccountActive: () => kickOutbox(),
      });
      return oauth;
    },
  });

  const capabilities = (ctx: FeatureContext): readonly AccountCapability[] => defaultAccountCapabilities(ctx);

  const writes = writesFeature({ sessions: () => webSessions(), capabilities });

  const lastfm: Feature = {
    name: 'lastfm',
    routes: [
      ...lastfmRoutes({ delegated: { tables: [authMethods, writeMethods], run: handleLastfmMethod } }),
      ...as12Routes,
    ],
  };

  const listenbrainz: Feature = {
    name: 'listenbrainz',
    routes: listenBrainzRoutes({
      registry: [
        ...createSubmitRoutes({ limiter: listenBrainzLimiterFor }),
        ...createTokenRoutes({ limiter: listenBrainzLimiterFor }),
      ],
      limiter: listenBrainzLimiterFor,
      kick: kickOutbox,
    }),
  };

  const links = onWire(
    linksFeature({ revocations, pacing, sessions: sharedSessions }),
    outbound.transportFor('forward'),
  );

  const imports = onWire(
    importsFeature({
      sessions: sharedSessions,
      pacers: { lastfm: lastfmImportPacer(pacing), listenbrainz: intervalPacer() },
      diskLow: options.diskLow,
    }),
    outbound.transportFor('imports'),
  );

  const credentials = credentialsFeature({ revocations, sessions: sharedSessions });

  const writers: PdsWriterSource = {
    async writerFor(did: string): Promise<PdsWriter | null> {
      const service = oauthService();
      // A DID the policy refuses never writes, even before a reconcile has signed it out (B20).
      if (!signInAllowed(config, did)) return null;
      if (!service.sessionStore.has(did)) return null;
      try {
        return sessionWriter(await service.restore(did));
      } catch (error) {
        if (error instanceof ReauthRequiredError || REAUTH_ERRORS.has(errorName(error))) return null;
        throw error;
      }
    },
  };
  const outbox: Feature = { name: 'outbox', extensions: [outboxExtension({ writers })] };

  const keepaliveHandler: ExtensionTimerHandler = (now, ctx) => {
    const { deps } = composed();
    return oauthKeepaliveTimer({ db: deps.db, log: deps.log, oauth: oauthService(), diskLow: options.diskLow })(
      now,
      ctx,
    );
  };
  const keepaliveExtension: CoreExtension = {
    name: 'oauth-keepalive',
    timers: { 'oauth-keepalive': keepaliveHandler },
    start(ctx, now) {
      ctx.schedule('oauth-keepalive', now + KEEPALIVE_INTERVAL_MS);
    },
  };
  const keepalive: Feature = { name: 'oauth-keepalive', extensions: [keepaliveExtension] };

  const reconcile = async (): Promise<ReconcileReport> => {
    const { deps } = composed();
    return reconcileSignInPolicy(
      { db: deps.db, clock: deps.clock, log: deps.log, revocations, oauth: oauthService() },
      { signinPolicy: config.signinPolicy, signinDids: config.signinDids },
    );
  };

  const gate = startupGate();
  let started = false;
  const startup = async (): Promise<ReconcileReport> => {
    if (started) throw new Error('the startup reconcile runs once');
    started = true;
    try {
      const report = await reconcile();
      gate.open();
      return report;
    } catch (error) {
      gate.fail(error);
      throw error;
    }
  };

  const sweep = async (now: number): Promise<ExpirySweepReport> => {
    const { deps } = composed();
    const { db, log } = deps;
    const report: ExpirySweepReport = {
      signedOut: 0,
      oauthStates: 0,
      linkStates: 0,
      lastfmTokens: 0,
      webSessions: 0,
      nowPlaying: 0,
      ignoredListens: 0,
      failed: [],
    };
    const step = async (name: string, fn: () => number | Promise<number>, into: keyof ExpirySweepReport) => {
      try {
        (report as unknown as Record<string, number>)[into] = await fn();
      } catch (error) {
        report.failed.push(name);
        log.log('error', 'expiry_sweep.step_failed', { step: name, error: errorName(error) });
      }
    };
    await step('reconcile', async () => (await reconcile()).signedOut.length, 'signedOut');
    await step('oauth_states', () => oauthService().sweepExpiredStates(now), 'oauthStates');
    await step('link_states', () => sweepExpiredLinkStates(db, now, EXPIRY_SWEEP_LIMIT), 'linkStates');
    await step('lastfm_tokens', () => sweepLastfmTokens(db, now), 'lastfmTokens');
    await step('web_sessions', () => sweepExpiredWebSessions(db, now, EXPIRY_SWEEP_LIMIT), 'webSessions');
    await step('now_playing', () => deleteExpiredNowPlaying({ db, clock: { nowMs: () => now } }), 'nowPlaying');
    await step(
      'ignored_listens',
      () =>
        db.all<{ id: number }>(
          'DELETE FROM ignored_listens WHERE created_at_ms <= ? RETURNING id',
          now - IGNORED_LISTEN_RETENTION_MS,
        ).length,
      'ignoredListens',
    );
    // `lastfmTokens` is logged as `lastfmApprovals`: the logger redacts every field named like a token.
    const { failed, lastfmTokens, ...counts } = report;
    log.log('info', 'expiry_sweep.done', { ...counts, lastfmApprovals: lastfmTokens, failed });
    return report;
  };

  const sweepExtension: CoreExtension = {
    name: 'expiry-sweep',
    timers: {
      'expiry-sweep': async (now: number, ctx: ExtensionContext) => {
        try {
          await sweep(now);
        } finally {
          ctx.schedule('expiry-sweep', now + EXPIRY_SWEEP_INTERVAL_MS, { force: true });
        }
      },
    },
    start(ctx, now) {
      // run() reconciles once at startup; the first sweep is one interval later.
      ctx.schedule('expiry-sweep', now + EXPIRY_SWEEP_INTERVAL_MS);
    },
  };
  const expiry: Feature = { name: 'expiry-sweep', extensions: [sweepExtension] };

  const meta: Feature = {
    name: 'meta',
    services(ctx) {
      const service: MetaService = Object.freeze({ capabilities: Object.freeze([...capabilities(ctx)]) });
      return { meta: service };
    },
  };

  const features: Feature[] = [
    sessionsFeature,
    auth,
    writes,
    lastfmAuthFeature({ revocations }),
    lastfm,
    listenbrainz,
    links,
    imports,
    credentials,
    outbox,
    keepalive,
    expiry,
    meta,
  ];
  if (options.backups !== undefined) features.push({ name: 'backup', extensions: [backupExtension(options.backups)] });

  const gatedFeatures = features.map((feature) =>
    feature.extensions === undefined
      ? feature
      : { ...feature, extensions: feature.extensions.map((extension) => afterStartup(extension, gate)) },
  );

  return {
    features: Object.freeze(gatedFeatures),
    oauth: () => oauth,
    reconcile,
    startup,
    sweep,
  };
}
