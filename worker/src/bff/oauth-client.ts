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
//   - A definite mismatch (another DID, another issuer, or a document our rules
//     reject) revokes the new session and is 403 `oauth_binding_mismatch` (or
//     `oauth_identity_rejected`).
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
// `reauth_required`. `revoke(did)` (sign-out, keepalive, reconciliation)
// suppresses the hook too and sets `signed_out` itself.

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
import { ClockTtlStore, encodeAppState, OAuthSessionStore, OAuthStateStore } from './oauth-stores';

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

export const OAUTH_ERROR_STATUS = {
  /** AS or PDS discovery, PAR or the token request failed, the AS lacks PAR or S256, or the binding check could not resolve the identity. */
  oauth_upstream: 502,
  /** The login-binding cookie does not match the state, or the session's DID or issuer is not the one sign-in started for. */
  oauth_binding_mismatch: 403,
  /** Missing, unknown, replayed or expired state. */
  oauth_state_invalid: 400,
  /** The authorization response was malformed (issuer mismatch, no code). */
  oauth_callback_invalid: 400,
  /** The AS redirected with an error (e.g. access_denied). */
  oauth_denied: 400,
  /** Our identity rules reject the DID's document. */
  oauth_identity_rejected: 403,
  /** The sign-in policy refuses the DID (§5.7). */
  signin_not_allowed: 403,
  /** The handle is not a valid handle. */
  invalid_handle: 422,
  /** The handle does not resolve to a DID. */
  handle_unresolved: 422,
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_STATUS;

export class OAuthFlowError extends Error {
  readonly status: number;
  constructor(
    readonly code: OAuthErrorCode,
    message: string = code,
    options?: ErrorOptions & { upstreamError?: string },
  ) {
    super(message, options);
    this.name = 'OAuthFlowError';
    this.status = OAUTH_ERROR_STATUS[code];
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

function classify(error: unknown, what: string): OAuthFlowError {
  if (error instanceof OAuthFlowError) return error;
  if (findCause(error, isIssuerMismatch) !== undefined) {
    return new OAuthFlowError('oauth_binding_mismatch', `${what}: the DID's PDS names another authorization server`, {
      cause: error,
    });
  }
  if (findCause(error, (e) => isIdentityError(e)) !== undefined) {
    return new OAuthFlowError('oauth_identity_rejected', `${what}: the DID's identity is not acceptable`, {
      cause: error,
    });
  }
  return new OAuthFlowError('oauth_upstream', `${what} failed upstream`, { cause: error });
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

export interface OAuthService {
  readonly client: NodeOAuthClient;
  readonly stateStore: OAuthStateStore;
  readonly sessionStore: OAuthSessionStore;
  authorize(input: string, options: AuthorizeOptions): Promise<AuthorizeResult>;
  callback(params: URLSearchParams, options: CallbackOptions): Promise<CallbackResult>;
  /** The DID's session, refreshed when stale (`refresh: true` forces it, `false` never refreshes). */
  restore(did: string, refresh?: boolean | 'auto'): Promise<OAuthSession>;
  /** Revoke upstream (best effort), delete locally (journaled), set `signed_out`, block queued operations. */
  revoke(did: string): Promise<void>;
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
  /** DIDs being revoked by revoke(): the caller sets the account status. */
  const revoking = new Map<string, number>();
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

  const onSessionDeleted = (sub: string, cause: unknown): void => {
    if (inCallback.has(sub)) {
      log.log('info', 'oauth_session_replaced', { did: sub });
      return;
    }
    if (revoking.has(sub)) return;
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

  async function revokeQuietly(did: string): Promise<void> {
    try {
      await client.revoke(did);
    } catch (error) {
      log.log('warn', 'oauth_revoke_failed', { did, error: errorClass(error) });
    }
    sessionStore.del(did);
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
      throw classify(error, 'authorization server discovery');
    }
    if (!metadata.pushed_authorization_request_endpoint) {
      throw new OAuthFlowError('oauth_upstream', 'the authorization server does not support PAR');
    }
    if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) {
      throw new OAuthFlowError('oauth_upstream', 'the authorization server does not support S256 PKCE');
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
    if (stateKey === null || stateKey === '') throw new OAuthFlowError('oauth_state_invalid', 'missing state');
    const seen = stateStore.inspect(stateKey);
    if (seen.status !== 'ok') {
      throw new OAuthFlowError('oauth_state_invalid', seen.status === 'expired' ? 'expired state' : 'unknown state');
    }
    if (o.bindingHash === null || !(o.bindingHash instanceof Uint8Array) || !sameBytes(seen.binding, o.bindingHash)) {
      stateStore.del(stateKey); // consumed: the flow cannot be completed by anyone else either
      throw new OAuthFlowError('oauth_binding_mismatch', 'the login-binding cookie does not match this sign-in');
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
        throw new OAuthFlowError('oauth_callback_invalid', error.message, { cause: error });
      }
      throw classify(error, 'callback');
    } finally {
      leave(inCallback, expected.did);
    }
    const session = result.session;
    const sub = session.did;

    // Binding check (§5.5).
    if (sub !== expected.did) {
      log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'subject' });
      await revokeQuietly(sub);
      throw new OAuthFlowError(
        'oauth_binding_mismatch',
        'the session is for another DID than the one sign-in started for',
      );
    }
    let identity: ResolvedIdentity;
    try {
      identity = await deps.identity.resolveDid(sub, { fresh: true });
    } catch (error) {
      if (isIdentityError(error)) {
        log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'identity' });
        await revokeQuietly(sub);
        throw new OAuthFlowError('oauth_identity_rejected', "the DID's identity is not acceptable", { cause: error });
      }
      log.log('warn', 'oauth_binding_check_unavailable', { did: sub, error: errorClass(error) });
      throw new OAuthFlowError('oauth_upstream', 'the identity could not be resolved; the new session is kept', {
        cause: error,
      });
    }
    let issuer: string;
    try {
      issuer = (await client.oauthResolver.getResourceServerMetadata(identity.pds, { noCache: true })).issuer;
    } catch (error) {
      log.log('warn', 'oauth_binding_check_unavailable', { did: sub, error: errorClass(error) });
      throw new OAuthFlowError('oauth_upstream', "the PDS's authorization server could not be resolved", {
        cause: error,
      });
    }
    if (issuer !== session.serverMetadata.issuer) {
      log.log('warn', 'oauth_binding_mismatch', { did: sub, reason: 'issuer' });
      await revokeQuietly(sub);
      throw new OAuthFlowError('oauth_binding_mismatch', "the DID's PDS names another authorization server");
    }
    log.log('info', 'oauth_signed_in', { did: sub });
    return { did: sub, handle: identity.handle, startedFrom: expected.handle, session };
  }

  async function revoke(did: string): Promise<void> {
    enter(revoking, did);
    try {
      await revokeQuietly(did);
    } finally {
      leave(revoking, did);
    }
    const now = clock.nowMs();
    db.tx(() => {
      db.run("UPDATE accounts SET oauth_status = 'signed_out', updated_at_ms = ? WHERE did = ?", now, did);
      db.run("UPDATE operations SET state = 'blocked', updated_at_ms = ? WHERE did = ? AND state = 'queued'", now, did);
    });
    log.log('info', 'oauth_revoked', { did });
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
