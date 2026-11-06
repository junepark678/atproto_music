// The confidential atproto OAuth client of the BFF (ADR 0005 §5.1, §5.2, §5.5,
// §5.6; N2-03).
//
// One NodeOAuthClient (@atproto/oauth-client-node 0.5.10) at the client_id of
// client-metadata.ts, constructed with:
//   - the keyset of keyset.ts (private_key_jwt, ES256);
//   - the sealed stores of oauth-stores.ts;
//   - `requestLock: requestLocalLock` (one process: refreshes of one DID are
//     serialised in memory, so a rotated refresh token is never used twice);
//   - `identityResolver` = identity-adapter.ts over our identity module, and a
//     refusing `handleResolver`, so the library never builds its own PLC or DNS
//     resolver (§5.2, review round 1 #13);
//   - `fetch` = policyFetch (N1-05) with the OAuth caps: every PAR, token,
//     revocation and metadata request, and every PDS request made through
//     `session.fetchHandler`, goes through the URL policy and the pinned
//     transport, and a network failure is a TransportError, never a TypeError
//     (the library deletes sessions on TypeError);
//   - `responseMode: 'query'`; `allowHttp` is never set;
//   - a runtime whose randomness (PKCE verifier, state, assertion jti, DPoP
//     keys) comes from the injected Random, and metadata and nonce caches on the
//     injected clock.
//
// `authorize(handle, {bindingHash})` resolves the handle with our module,
// applies the caller's sign-in policy, refuses an authorization server without
// PAR or S256 PKCE before anything is stored, and stores the state with the
// login-binding hash (SHA-256 of the `__Host-atmusic_oauth` cookie) in
// `oauth_states.session_binding`. A failure after the library stored the state
// (a PAR error) deletes that row, so nothing is left behind.
//
// `callback(params, {bindingHash})` refuses a missing, unknown, expired or
// mismatching state before the code exchange (the mismatching state is
// consumed), then lets the library exchange the code, then runs the **binding
// check** of §5.5: the session's `sub` must be the DID sign-in started for (the
// handle-resolved DID), and `identity.resolveDid(sub, {fresh: true})` must name
// a PDS whose authorization server is the session's issuer.
//
// **Callback failures use the v1.2 contract codes** (api/openapi.yaml
// /oauth/callback, API.md, ADR §5.5/§5.6): a missing, replayed, expired or
// unknown state, a cookie mismatch, a malformed authorization response, an
// issuer or subject mismatch and an identity our rules reject are all 403
// `oauth_binding_mismatch`; a transient failure is 502 `oauth_upstream`. The
// finer cause is `OAuthFlowError.reason`, for logs only. `oauth_denied` (an
// AS-reported error such as access_denied) is the signal for N3-01's 303 to
// `/signin?error=denied`, not a response body.
//   - A definite mismatch (another DID, another issuer, or a document our rules
//     reject) revokes the new session and is 403 `oauth_binding_mismatch`.
//   - A resolution error (PLC or DNS timeout, 5xx, TransportError) revokes
//     nothing: the new session stays stored (the library has already checked
//     the issuer through our resolver), and the caller sets no cookie and
//     answers 502 `oauth_upstream`; the previous session was already revoked by
//     the library, so revoking the new one would leave the DID with none.
//
// **Hooks (§5.2).** `onSessionUpdated(sub)` sets `accounts.oauth_status` to
// `active` and moves the DID's `blocked` operations back to `queued`.
// `onSessionDeleted(sub)` sets `reauth_required` and blocks the DID's queued
// operations — except while the callback wrapper's per-sub in-callback flag is
// set: `OAuthClient.callback()` always revokes the previous session of the DID
// before storing the new one (oauth-client.js:196-205), and that deletion only
// removes the old row. A user who signs in again with queued and blocked
// operations therefore ends `active` with them runnable, never
// `reauth_required`.
//
// **revoke(did)** (sign-out, keepalive, reconciliation) does not use the
// library's `revoke(sub)`, whose `finally` deletes whatever session the DID has
// once the upstream request returns — possibly one a concurrent sign-in stored
// meanwhile, which would then stay live at the AS with no local record
// (review round 1). Instead, under the library's per-DID request lock (so a
// refresh cannot rotate the tokens under it), it snapshots the session,
// revokes that session's token upstream, and then, synchronously, deletes the
// row only if it is still that session (`delIfUnchanged`, journaled in the
// same transaction). It writes `signed_out` and blocks queued operations only
// when the DID then has no session at all; while a callback of the DID is in
// flight that decision waits until the callback ends, so a sign-in that
// completes wins and one that fails still leaves the account `signed_out`.

import { createECDH, createHash } from 'node:crypto';
import { isResolvableDid } from '@atmusic/atproto/identity/did-doc';
import { normalizeHandleInput } from '@atmusic/atproto/identity/handle';
import { isIdentityError } from '@atmusic/atproto/identity/resolver';
import type { IdentityResolver, ResolvedIdentity } from '@atmusic/atproto/identity/types';
import type { Clock, Random } from '@atmusic/core/deps';
import {
  JoseKey,
  NodeOAuthClient,
  type NodeOAuthClientOptions,
  OAuthCallbackError,
  type OAuthSession,
  requestLocalLock,
} from '@atproto/oauth-client-node';
import type { Revocations } from '../app/revocations';
import type { Box } from '../crypto/box';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import { bindPolicyFetch, type PolicyCaps, type PolicyFetch } from '../node/policy-fetch';
import type { ClientMetadataDocument } from './client-metadata';
import { createOAuthIdentityResolver } from './identity-adapter';
import type { OAuthKeyset } from './keyset';
import {
  ClockTtlStore,
  type ConditionalDeleteOutcome,
  encodeAppState,
  OAuthSessionStore,
  OAuthStateStore,
} from './oauth-stores';

/**
 * policyFetch caps for the OAuth client. The same fetch carries PDS writes made
 * through `session.fetchHandler` (N2-05), whose applyWrites bodies are at most
 * 1,000,000 bytes (§5.8), so the request cap is 1 MiB.
 */
export const OAUTH_FETCH_CAPS: PolicyCaps = Object.freeze({ maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576 });
/** The library's defaults: metadata and DPoP nonces are reused for a minute. */
export const OAUTH_METADATA_CACHE_TTL_MS = 60_000;
export const OAUTH_NONCE_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Every code is a v1.2 contract code of /api/v1/auth/start or /oauth/callback, with its HTTP status. */
export const OAUTH_ERROR_STATUS = {
  /** AS or PDS discovery, PAR or the token request failed, the AS lacks PAR or S256, or the binding check could not resolve the identity (transient). */
  oauth_upstream: 502,
  /**
   * The callback cannot be bound to this sign-in: a missing, replayed, expired
   * or unknown state, a login-binding cookie mismatch, a malformed
   * authorization response, an issuer or subject mismatch, or a DID document
   * our identity rules reject. No session is kept.
   */
  oauth_binding_mismatch: 403,
  /** The AS redirected with an error (e.g. access_denied): N3-01 answers 303 to /signin?error=denied. */
  oauth_denied: 303,
  /** The sign-in policy refuses the DID (§5.7). */
  signin_not_allowed: 403,
  /** authorize: the handle is not a valid handle (422 fields.handle). */
  invalid_handle: 422,
  /** authorize: the handle does not resolve to an acceptable DID (422 fields.handle). */
  handle_unresolved: 422,
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_STATUS;

/** The finer cause of an OAuthFlowError, for logs only (never a response code). */
export type OAuthFailureReason =
  | 'state_missing'
  | 'state_unknown'
  | 'state_expired'
  | 'cookie_mismatch'
  | 'response_invalid'
  | 'issuer_mismatch'
  | 'subject_mismatch'
  | 'identity_rejected'
  | 'identity_unavailable'
  | 'as_capabilities'
  | 'upstream'
  | 'denied'
  | 'policy'
  | 'invalid_handle'
  | 'handle_unresolved';

const DEFAULT_REASON: Record<OAuthErrorCode, OAuthFailureReason> = {
  oauth_upstream: 'upstream',
  oauth_binding_mismatch: 'state_unknown',
  oauth_denied: 'denied',
  signin_not_allowed: 'policy',
  invalid_handle: 'invalid_handle',
  handle_unresolved: 'handle_unresolved',
};

export class OAuthFlowError extends Error {
  readonly status: number;
  /** The finer cause (logs only). */
  readonly reason: OAuthFailureReason;
  constructor(
    readonly code: OAuthErrorCode,
    message: string = code,
    options?: ErrorOptions & { upstreamError?: string; reason?: OAuthFailureReason },
  ) {
    super(message, options);
    this.name = 'OAuthFlowError';
    this.status = OAUTH_ERROR_STATUS[code];
    this.reason = options?.reason ?? DEFAULT_REASON[code];
    this.upstreamError = options?.upstreamError ?? null;
  }
  /** The AS's `error` parameter, for oauth_denied. */
  readonly upstreamError: string | null;
}

/** Depth-first search of an error's `cause` chain and AggregateError members. */
export function findCause(error: unknown, pred: (e: unknown) => boolean, depth = 0): unknown {
  if (depth > 10 || error === null || error === undefined) return undefined;
  if (pred(error)) return error;
  if (error instanceof AggregateError) {
    for (const e of error.errors) {
      const hit = findCause(e, pred, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  if (typeof error === 'object' && 'cause' in error)
    return findCause((error as { cause: unknown }).cause, pred, depth + 1);
  return undefined;
}

/**
 * The library's issuer check after the code exchange (`verifyIssuer`,
 * oauth-server-agent.js:117-119): the subject's PDS names another AS. It is a
 * definite mismatch (the library has already revoked the new tokens); 0.8.10
 * reports it only as `TypeError('Issuer mismatch')`.
 */
function isIssuerMismatch(e: unknown): boolean {
  return e instanceof TypeError && e.message === 'Issuer mismatch';
}

/**
 * Map a library failure to a contract code. In the callback, an issuer
 * mismatch or an identity our rules reject is `oauth_binding_mismatch`; at
 * authorize, an identity our rules reject is `handle_unresolved` (/auth/start
 * answers 422 fields.handle). Anything else is a transient `oauth_upstream`.
 */
function classify(error: unknown, what: 'authorize' | 'callback'): OAuthFlowError {
  if (error instanceof OAuthFlowError) return error;
  if (findCause(error, isIssuerMismatch) !== undefined) {
    return new OAuthFlowError('oauth_binding_mismatch', `${what}: the DID's PDS names another authorization server`, {
      cause: error,
      reason: 'issuer_mismatch',
    });
  }
  if (findCause(error, (e) => isIdentityError(e)) !== undefined) {
    return new OAuthFlowError(
      what === 'callback' ? 'oauth_binding_mismatch' : 'handle_unresolved',
      `${what}: the DID's identity is not acceptable`,
      { cause: error, reason: 'identity_rejected' },
    );
  }
  return new OAuthFlowError('oauth_upstream', `${what} failed upstream`, { cause: error, reason: 'upstream' });
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------
// Runtime: injected randomness
// ---------------------------------------------------------------------------

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/** A P-256 DPoP key whose scalar comes from the injected Random. */
export async function createDpopKey(algs: readonly string[], random: Random): Promise<JoseKey> {
  if (!algs.includes('ES256')) throw new Error('the authorization server does not accept ES256 DPoP proofs');
  for (let attempt = 0; attempt < 16; attempt++) {
    const d = random.bytes(32);
    const scalar = BigInt(`0x${Buffer.from(d).toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();
    return JoseKey.fromJWK({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      d: b64url(d),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    });
  }
  throw new Error('could not derive a P-256 scalar from the random source');
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface OAuthServiceDeps {
  db: Db;
  clock: Clock;
  random: Random;
  log: Logger;
  /** Our identity module (ModuleDeps.identity). */
  identity: IdentityResolver;
  /** N1-05; production passes it over the pinned transport. */
  policyFetch: PolicyFetch;
  box: Box;
  keyset: OAuthKeyset;
  clientMetadata: ClientMetadataDocument;
  revocations: Revocations;
  /** Called after a DID's blocked operations were moved back to queued (the outbox kick, N4-01). */
  onAccountActive?(did: string): void;
}

export interface AuthorizeOptions {
  /** SHA-256 of the `__Host-atmusic_oauth` cookie value (32 bytes). */
  bindingHash: Uint8Array;
  /** The sign-in policy (§5.7); a refused DID is `signin_not_allowed` and nothing is stored. */
  allow?: (did: string) => boolean;
  signal?: AbortSignal;
}

export interface AuthorizeResult {
  /** The authorization URL to send the browser to. */
  url: URL;
  /** The DID sign-in is for. */
  did: string;
  /** The handle sign-in started from (lowercase), or null for a DID. */
  handle: string | null;
}

export interface CallbackOptions {
  /** SHA-256 of the `__Host-atmusic_oauth` cookie the callback request carried; null when it carried none. */
  bindingHash: Uint8Array | null;
}

export interface CallbackResult {
  did: string;
  /** The DID's verified handle from the binding check's fresh resolution, or null. */
  handle: string | null;
  /** The handle sign-in started from, or null. */
  startedFrom: string | null;
  session: OAuthSession;
}

export interface RevokeOptions {
  /** Evaluated under the DID's lock right before anything is revoked; true skips the revoke. */
  unless?: () => boolean;
}

export type RevokeOutcome = 'revoked' | 'superseded' | 'skipped';

export interface OAuthService {
  readonly client: NodeOAuthClient;
  readonly stateStore: OAuthStateStore;
  readonly sessionStore: OAuthSessionStore;
  authorize(input: string, options: AuthorizeOptions): Promise<AuthorizeResult>;
  callback(params: URLSearchParams, options: CallbackOptions): Promise<CallbackResult>;
  /** The DID's session, refreshed when stale (`refresh: true` forces it, `false` never refreshes). */
  restore(did: string, refresh?: boolean | 'auto'): Promise<OAuthSession>;
  /**
   * Revoke the DID's current session upstream (best effort), delete it locally
   * (journaled) if it is still the current session, then set `signed_out` and
   * block queued operations unless a newer session exists. `superseded`: a
   * concurrent sign-in stored a newer session, which is kept; `skipped`:
   * `unless()` was true and nothing was done.
   */
  revoke(did: string, options?: RevokeOptions): Promise<RevokeOutcome>;
  /** `oauth_store_degraded` (§5.5). */
  degraded(): boolean;
  /** Retry the held session writes; true when none is left. */
  flush(): boolean;
  /** The expiry-sweep step for oauth_states. */
  sweepExpiredStates(nowMs?: number): number;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

type CacheValue<K extends 'authorizationServerMetadataCache' | 'protectedResourceMetadataCache'> = Exclude<
  Awaited<ReturnType<NonNullable<NodeOAuthClientOptions[K]>['get']>>,
  undefined
>;
type AsMetadata = CacheValue<'authorizationServerMetadataCache'>;
type RsMetadata = CacheValue<'protectedResourceMetadataCache'>;

const refusingHandleResolver = {
  resolve(): Promise<never> {
    return Promise.reject(new Error('handle resolution goes through the identity adapter'));
  },
};

export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { db, clock, random, log } = deps;
  const stateStore = new OAuthStateStore({ db, clock, box: deps.box, log });
  const sessionStore = new OAuthSessionStore({ db, clock, box: deps.box, log, revocations: deps.revocations });

  /** DIDs whose callback is running: the library's revoke of their previous session only deletes the old row. */
  const inCallback = new Map<string, number>();
  /** DIDs whose revoke() found no session left while a callback of theirs was running (settled when it ends). */
  const pendingSignOut = new Set<string>();
  const enter = (m: Map<string, number>, did: string) => m.set(did, (m.get(did) ?? 0) + 1);
  const leave = (m: Map<string, number>, did: string) => {
    const n = (m.get(did) ?? 1) - 1;
    if (n <= 0) m.delete(did);
    else m.set(did, n);
  };
  sessionStore.quiet = (did) => inCallback.has(did);

  const onSessionUpdated = (sub: string): void => {
    try {
      const now = clock.nowMs();
      let unblocked = 0;
      db.tx(() => {
        db.run(
          "UPDATE accounts SET oauth_status = 'active', updated_at_ms = ? WHERE did = ? AND oauth_status != 'active'",
          now,
          sub,
        );
        unblocked = db.run(
          "UPDATE operations SET state = 'queued', updated_at_ms = ? WHERE did = ? AND state = 'blocked'",
          now,
          sub,
        ).rowsWritten;
      });
      if (unblocked > 0) deps.onAccountActive?.(sub);
    } catch (error) {
      // A hook must never fail the library's store path (that would revoke the new tokens).
      log.log('error', 'oauth_session_hook_failed', { did: sub, hook: 'updated', error: errorClass(error) });
    }
  };

  const markSessionLost = (sub: string, cause: unknown): void => {
    try {
      const now = clock.nowMs();
      db.tx(() => {
        db.run(
          "UPDATE accounts SET oauth_status = 'reauth_required', updated_at_ms = ? WHERE did = ? AND oauth_status = 'active'",
          now,
          sub,
        );
        db.run(
          "UPDATE operations SET state = 'blocked', updated_at_ms = ? WHERE did = ? AND state = 'queued'",
          now,
          sub,
        );
      });
      log.log('warn', 'oauth_session_deleted', { did: sub, cause: errorClass(cause) });
    } catch (error) {
      log.log('error', 'oauth_session_hook_failed', { did: sub, hook: 'deleted', error: errorClass(error) });
    }
  };

  const onSessionDeleted = (sub: string, cause: unknown): void => {
    if (inCallback.has(sub)) {
      log.log('info', 'oauth_session_replaced', { did: sub });
      return;
    }
    markSessionLost(sub, cause);
  };

  const markSignedOut = (did: string): void => {
    const now = clock.nowMs();
    db.tx(() => {
      db.run("UPDATE accounts SET oauth_status = 'signed_out', updated_at_ms = ? WHERE did = ?", now, did);
      db.run("UPDATE operations SET state = 'blocked', updated_at_ms = ? WHERE did = ? AND state = 'queued'", now, did);
    });
  };

  const options: NodeOAuthClientOptions = {
    clientMetadata: deps.clientMetadata,
    keyset: deps.keyset.keyset,
    responseMode: 'query',
    stateStore,
    sessionStore,
    requestLock: requestLocalLock,
    identityResolver: createOAuthIdentityResolver(deps.identity),
    handleResolver: refusingHandleResolver as unknown as NonNullable<NodeOAuthClientOptions['handleResolver']>,
    fetch: bindPolicyFetch(deps.policyFetch, OAUTH_FETCH_CAPS),
    runtimeImplementation: {
      requestLock: requestLocalLock,
      createKey: (algs) => createDpopKey(algs, random),
      getRandomValues: (length) => random.bytes(length),
      digest: (bytes, algorithm) => new Uint8Array(createHash(algorithm.name).update(bytes).digest()),
    },
    authorizationServerMetadataCache: new ClockTtlStore<AsMetadata>(clock, OAUTH_METADATA_CACHE_TTL_MS),
    protectedResourceMetadataCache: new ClockTtlStore<RsMetadata>(clock, OAUTH_METADATA_CACHE_TTL_MS),
    dpopNonceCache: new ClockTtlStore<string>(clock, OAUTH_NONCE_CACHE_TTL_MS),
    onSessionUpdated,
    onSessionDeleted,
  };
  const client = new NodeOAuthClient(options);

  /**
   * The library's per-DID request lock (session-getter.js: every getSession,
   * so every refresh and the callback's revoke of the previous session, runs
   * under `@atproto-oauth-client-${sub}`). Holding it keeps a refresh from
   * rotating the tokens between our snapshot and our conditional delete.
   */
  const withDidLock = <T>(did: string, fn: () => Promise<T>): Promise<T> =>
    Promise.resolve(requestLocalLock(`@atproto-oauth-client-${did}`, fn));

  /**
   * Revoke the DID's current session upstream (best effort) and delete it
   * locally only if it is still the current session afterwards. Call under
   * withDidLock.
   */
  async function revokeCurrent(did: string): Promise<ConditionalDeleteOutcome> {
    const snap = sessionStore.snapshot(did);
    const saved = snap.session;
    if (saved !== undefined) {
      try {
        const dpopKey = await JoseKey.fromJWK(saved.dpopJwk);
        const server = await client.serverFactory.fromIssuer(saved.tokenSet.iss, saved.authMethod, dpopKey);
        await server.revoke(saved.tokenSet.access_token);
      } catch (error) {
        log.log('warn', 'oauth_revoke_failed', { did, error: errorClass(error) });
      }
    }
    const outcome = sessionStore.delIfUnchanged(snap);
    if (outcome === 'superseded') log.log('info', 'oauth_revoke_superseded', { did });
    return outcome;
  }

  /** The binding check's revocation of the session this callback just stored. */
  async function revokeNewSession(did: string): Promise<void> {
    const outcome = await withDidLock(did, () => revokeCurrent(did));
    if (outcome === 'deleted') markSessionLost(did, new Error('binding check'));
  }

  async function authorize(input: string, o: AuthorizeOptions): Promise<AuthorizeResult> {
    if (!(o?.bindingHash instanceof Uint8Array) || o.bindingHash.length !== 32) {
      throw new TypeError('authorize needs the 32-byte SHA-256 of the login-binding cookie');
    }
    let did: string;
    let handle: string | null = null;
    try {
      if (typeof input === 'string' && input.startsWith('did:')) {
        if (!isResolvableDid(input)) throw new OAuthFlowError('invalid_handle', 'not a resolvable DID');
        did = input;
      } else {
        handle = normalizeHandleInput(input);
        did = await deps.identity.resolveHandle(handle);
      }
    } catch (error) {
      if (error instanceof OAuthFlowError) throw error;
      if (isIdentityError(error, 'invalid_handle'))
        throw new OAuthFlowError('invalid_handle', 'invalid handle', { cause: error });
      if (isIdentityError(error))
        throw new OAuthFlowError('handle_unresolved', 'the handle does not resolve', { cause: error });
      throw new OAuthFlowError('oauth_upstream', 'handle resolution failed', { cause: error });
    }
    if (o.allow && !o.allow(did)) throw new OAuthFlowError('signin_not_allowed', 'the sign-in policy refuses this DID');

    // Capabilities first: an AS without PAR or S256 PKCE is refused before any state exists.
    let metadata: Awaited<ReturnType<NodeOAuthClient['oauthResolver']['resolveFromIdentity']>>['metadata'];
    try {
      ({ metadata } = await client.oauthResolver.resolveFromIdentity(did, { signal: o.signal }));
    } catch (error) {
      throw classify(error, 'authorize');
    }
    if (!metadata.pushed_authorization_request_endpoint) {
      throw new OAuthFlowError('oauth_upstream', 'the authorization server does not support PAR', {
        reason: 'as_capabilities',
      });
    }
    if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) {
      throw new OAuthFlowError('oauth_upstream', 'the authorization server does not support S256 PKCE', {
        reason: 'as_capabilities',
      });
    }

    const flow = b64url(random.bytes(16));
    const appState = encodeAppState({ v: 1, flow, binding: Buffer.from(o.bindingHash).toString('hex'), did, handle });
    let url: URL;
    try {
      url = await client.authorize(did, { state: appState, signal: o.signal });
    } catch (error) {
      stateStore.discardFlow(flow);
      throw classify(error, 'authorize');
    }
    stateStore.forgetFlow(flow);
    log.log('info', 'oauth_authorize', { did });
    return { url, did, handle };
  }

  async function callback(params: URLSearchParams, o: CallbackOptions): Promise<CallbackResult> {
    const stateKey = params.get('state');
    if (stateKey === null || stateKey === '') {
      throw new OAuthFlowError('oauth_binding_mismatch', 'missing state', { reason: 'state_missing' });
    }
    const seen = stateStore.inspect(stateKey);
    if (seen.status !== 'ok') {
      throw seen.status === 'expired'
        ? new OAuthFlowError('oauth_binding_mismatch', 'expired state', { reason: 'state_expired' })
        : new OAuthFlowError('oauth_binding_mismatch', 'unknown state', { reason: 'state_unknown' });
    }
    if (o.bindingHash === null || !(o.bindingHash instanceof Uint8Array) || !sameBytes(seen.binding, o.bindingHash)) {
      stateStore.del(stateKey); // consumed: the flow cannot be completed by anyone else either
      throw new OAuthFlowError('oauth_binding_mismatch', 'the login-binding cookie does not match this sign-in', {
        reason: 'cookie_mismatch',
      });
    }
    const expected = seen.app;

    let result: Awaited<ReturnType<NodeOAuthClient['callback']>>;
    enter(inCallback, expected.did);
    try {
      result = await client.callback(params);
    } catch (error) {
      const upstreamError = params.get('error');
      if (upstreamError !== null && error instanceof OAuthCallbackError && error.cause === undefined) {
        throw new OAuthFlowError('oauth_denied', 'the authorization server refused the request', {
          cause: error,
          upstreamError,
        });
      }
      if (error instanceof OAuthCallbackError && error.cause === undefined) {
        // A malformed authorization response (no code, `iss` naming another issuer, JARM).
        throw new OAuthFlowError('oauth_binding_mismatch', error.message, {
          cause: error,
          reason: error.message === 'Issuer mismatch' ? 'issuer_mismatch' : 'response_invalid',
        });
      }
      throw classify(error, 'callback');
    } finally {
      leave(inCallback, expected.did);
      settlePendingSignOut(expected.did);
    }
    const session = result.session;
    const sub = session.did;

    // Binding check (§5.5).
    if (sub !== expected.did) {
      log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'subject' });
      await revokeNewSession(sub);
      throw new OAuthFlowError(
        'oauth_binding_mismatch',
        'the session is for another DID than the one sign-in started for',
        {
          reason: 'subject_mismatch',
        },
      );
    }
    let identity: ResolvedIdentity;
    try {
      identity = await deps.identity.resolveDid(sub, { fresh: true });
    } catch (error) {
      if (isIdentityError(error)) {
        log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'identity' });
        await revokeNewSession(sub);
        throw new OAuthFlowError('oauth_binding_mismatch', "the DID's identity is not acceptable", {
          cause: error,
          reason: 'identity_rejected',
        });
      }
      log.log('warn', 'oauth_binding_check_unavailable', { did: sub, error: errorClass(error) });
      throw new OAuthFlowError('oauth_upstream', 'the identity could not be resolved; the new session is kept', {
        cause: error,
        reason: 'identity_unavailable',
      });
    }
    let issuer: string;
    try {
      issuer = (await client.oauthResolver.getResourceServerMetadata(identity.pds, { noCache: true })).issuer;
    } catch (error) {
      log.log('warn', 'oauth_binding_check_unavailable', { did: sub, error: errorClass(error) });
      throw new OAuthFlowError('oauth_upstream', "the PDS's authorization server could not be resolved", {
        cause: error,
        reason: 'identity_unavailable',
      });
    }
    if (issuer !== session.serverMetadata.issuer) {
      log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'issuer' });
      await revokeNewSession(sub);
      throw new OAuthFlowError('oauth_binding_mismatch', "the DID's PDS names another authorization server", {
        reason: 'issuer_mismatch',
      });
    }
    log.log('info', 'oauth_signed_in', { did: sub });
    return { did: sub, handle: identity.handle, startedFrom: expected.handle, session };
  }

  /** A callback of `did` ended: apply the sign-out a revoke() deferred, unless a session exists now. */
  function settlePendingSignOut(did: string): void {
    if (inCallback.has(did) || !pendingSignOut.delete(did)) return;
    if (sessionStore.has(did)) return;
    markSignedOut(did);
    log.log('info', 'oauth_revoked', { did, deferred: true });
  }

  async function revoke(did: string, o: RevokeOptions = {}): Promise<RevokeOutcome> {
    return withDidLock(did, async () => {
      // Checked synchronously right before the snapshot (keepalive: the DID may have come into use).
      if (o.unless?.() === true) return 'skipped';
      const outcome = await revokeCurrent(did);
      if (outcome === 'superseded' || sessionStore.has(did)) return 'superseded';
      if (inCallback.has(did)) {
        // A sign-in of this DID is in flight: it decides (settlePendingSignOut).
        pendingSignOut.add(did);
        return 'revoked';
      }
      markSignedOut(did);
      log.log('info', 'oauth_revoked', { did });
      return 'revoked';
    });
  }

  return {
    client,
    stateStore,
    sessionStore,
    authorize,
    callback,
    restore: (did, refresh = 'auto') => client.restore(did, refresh),
    revoke,
    degraded: () => sessionStore.degraded(),
    flush: () => sessionStore.flush(),
    sweepExpiredStates: (nowMs) => stateStore.sweepExpired(nowMs),
  };
}
