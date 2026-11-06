// A fake atproto OAuth authorization server (ADR 0005 §5.10, §15.2). TEST-ONLY.
//
// It is reachable only through the router transport (`hosts: {'as.test': as}`)
// and is deterministic: every timestamp comes from the injected Clock and every
// token, code and nonce secret from the injected Random.
//
// Endpoints (shapes follow @atproto/oauth-provider 0.24, the reference AS):
//   GET  /.well-known/oauth-authorization-server   metadata (overridable per test)
//   POST /oauth/par                                 pushed authorization request
//   GET  /oauth/authorize                           auto-approves, 303 to redirect_uri
//   POST /oauth/token                               authorization_code and refresh_token
//   POST /oauth/revoke                              RFC 7009 revocation, always recorded
//
// Rules enforced, as the reference does:
// - private_key_jwt client authentication against the keys of the client's
//   `jwks_uri`, fetched through the injected transport together with the
//   client metadata document and cached for 10 minutes (no stale fallback);
// - the assertion's iss = sub = client_id, aud = issuer, a `kid`, an `iat` at
//   most 60 s old and not in the future, and a `jti` never seen before
//   (a replayed jti or a too-old assertion is `invalid_client`);
// - DPoP proofs on PAR and token requests, with server nonces that rotate every
//   60 s (a handed-out nonce stays valid for up to three rotations);
// - a session is bound to the client key (kid, alg, thumbprint) and the DPoP
//   key it started with; refresh tokens rotate, and a replayed one revokes the
//   session (`invalid_grant`).
//
// Deliberate differences from the reference, all stricter or simpler:
// - only `private_key_jwt` clients are accepted (ADR 0005 §5.1: one
//   confidential client); the metadata advertises only that method;
// - a replayed client-assertion jti is `invalid_client` (the reference answers
//   `invalid_grant`); the package spec (N1-09) fixes `invalid_client`;
// - access tokens are opaque; the fake PDS validates them with `introspect()`;
//   rotating a session's tokens invalidates its previous access token at once.
//
// The lower half of this module holds the JOSE helpers (ES256 over WebCrypto),
// the DPoP proof checker shared with the fake PDS, fixture keys, a fixture
// client app that serves client metadata and JWKS, and a minimal confidential
// client (`FixtureOAuthClient`) for tests that drive the AS without
// @atproto/oauth-client-node.

import type { Clock, Random } from '@atmusic/core/deps';
import {
  CallLog,
  type Fault,
  type FaultMatch,
  FaultQueue,
  faultName,
  faultResponse,
  type HostedRoutable,
  paramsOf,
} from './router-transport';

// ---------------------------------------------------------------------------
// Constants (the reference AS values, oauth-provider/dist/oauth-constants.js)
// ---------------------------------------------------------------------------

export const FAKE_AS_HOST = 'as.test';
/** CLIENT_ASSERTION_MAX_AGE. */
export const CLIENT_ASSERTION_MAX_AGE_SEC = 60;
/** How long fetched client metadata and JWKS are reused (ADR 0005 §5.3). */
export const CLIENT_METADATA_TTL_MS = 10 * 60_000;
/** DPOP_NONCE_MAX_AGE / 3. */
export const DPOP_NONCE_ROTATION_MS = 60_000;
/** The DPoP proof `iat` window: maxTokenAge 10 s plus the 180 s clock tolerance. */
export const DPOP_PROOF_MAX_AGE_SEC = 10;
export const DPOP_CLOCK_TOLERANCE_SEC = 180;
/** TOKEN_MAX_AGE. */
export const ACCESS_TOKEN_TTL_SEC = 3600;
/** PAR_EXPIRES_IN. */
export const PAR_EXPIRES_IN_SEC = 300;
/** AUTHORIZATION_INACTIVITY_TIMEOUT, used for the code lifetime. */
export const CODE_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** REFRESH_LIFETIME_EXTENDED (confidential clients): 3 months of inactivity. */
export const REFRESH_INACTIVITY_MS = Math.round((365.25 * DAY_MS) / 4);
/** SESSION_LIFETIME_EXTENDED (confidential clients): 2 years. */
export const SESSION_LIFETIME_MS = Math.round(2 * 365.25 * DAY_MS);

export const CLIENT_ASSERTION_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

// ---------------------------------------------------------------------------
// base64url and JOSE (ES256 over WebCrypto)
// ---------------------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextEncoder();

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))));
}

export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

/** The public half of a JWK: never carries `d`. */
export function publicJwk(jwk: EcPublicJwk): EcPublicJwk {
  const out: EcPublicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  if (jwk.kid !== undefined) out.kid = jwk.kid;
  if (jwk.alg !== undefined) out.alg = jwk.alg;
  if (jwk.use !== undefined) out.use = jwk.use;
  return out;
}

function isEcPublicJwk(v: unknown): v is EcPublicJwk {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  return (
    j.kty === 'EC' &&
    j.crv === 'P-256' &&
    typeof j.x === 'string' &&
    typeof j.y === 'string' &&
    fromB64url(j.x)?.length === 32 &&
    fromB64url(j.y)?.length === 32
  );
}

/** RFC 7638 SHA-256 thumbprint of an EC key. */
export function jwkThumbprint(jwk: EcPublicJwk): Promise<string> {
  return sha256B64url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A compact JWS signed with ES256. */
export async function signJwt(
  key: EcPrivateJwk,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d },
    ECDSA_P256,
    false,
    ['sign'],
  );
  const input = `${b64url(utf8.encode(JSON.stringify({ alg: 'ES256', ...header })))}.${b64url(
    utf8.encode(JSON.stringify(payload)),
  )}`;
  const sig = new Uint8Array(await crypto.subtle.sign(ES256, k, utf8.encode(input)));
  return `${input}.${b64url(sig)}`;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

function parseJsonObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Decode a compact JWS without verifying it; null when malformed. */
export function decodeJwt(jwt: string): DecodedJwt | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parseJsonObject(fromB64url(h));
  const payload = parseJsonObject(fromB64url(p));
  const signature = fromB64url(s);
  if (!header || !payload || !signature) return null;
  return { header, payload, signingInput: `${h}.${p}`, signature };
}

/** Verify an ES256 signature (raw r‖s, 64 bytes) against a public EC JWK. */
export async function verifyEs256(jwt: DecodedJwt, key: EcPublicJwk): Promise<boolean> {
  if (jwt.signature.length !== 64) return false;
  try {
    const k = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      ECDSA_P256,
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(ES256, k, jwt.signature, utf8.encode(jwt.signingInput));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DPoP nonces and proof verification (shared with the fake PDS)
// ---------------------------------------------------------------------------

/**
 * Server DPoP nonces, as the reference `DpopNonce`: HMAC-SHA256(secret, counter)
 * where counter = ⌊now / rotation⌋. `next()` hands out the nonce of counter + 1,
 * and `check()` accepts the previous, current and next ones, so a handed-out
 * nonce lives for up to three rotations.
 */
export class DpopNonceSource {
  private offset = 0;
  private readonly values = new Map<number, string>();
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly secret: Uint8Array,
    private readonly clock: Clock,
    readonly rotationMs = DPOP_NONCE_ROTATION_MS,
  ) {
    if (secret.length !== 32) throw new RangeError('DPoP nonce secret must be 32 bytes');
    if (!(rotationMs >= 1000)) throw new RangeError('DPoP nonce rotation must be at least 1 s');
  }

  private counter(): number {
    return Math.floor(this.clock.nowMs() / this.rotationMs) + this.offset;
  }

  private async value(counter: number): Promise<string> {
    const cached = this.values.get(counter);
    if (cached !== undefined) return cached;
    this.keyPromise ??= crypto.subtle.importKey(
      'raw',
      new Uint8Array(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const msg = new Uint8Array(8);
    new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
    const nonce = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await this.keyPromise, msg)));
    this.values.set(counter, nonce);
    return nonce;
  }

  /** The nonce to hand out now. */
  next(): Promise<string> {
    return this.value(this.counter() + 1);
  }

  async check(nonce: string): Promise<boolean> {
    const c = this.counter();
    for (const n of [c - 1, c, c + 1]) if ((await this.value(n)) === nonce) return true;
    return false;
  }

  /** Jump three rotations ahead: every nonce handed out so far stops being accepted. */
  rotate(): void {
    this.offset += 3;
  }
}

export type DpopCheck =
  | { ok: true; jkt: string; jti: string; jwk: EcPublicJwk }
  | { ok: false; error: 'invalid_dpop_proof' | 'use_dpop_nonce'; description: string };

export interface DpopCheckOptions {
  nowMs: number;
  /** null: nonces are not required. */
  nonces: DpopNonceSource | null;
  /** Proof jtis already used at this server; a fresh proof's jti is added. */
  seenJtis: Set<string>;
  /** When set, the proof must carry `ath` = b64url(SHA-256(token)); otherwise `ath` is refused. */
  accessToken?: string;
}

const dpopFail = (error: 'invalid_dpop_proof' | 'use_dpop_nonce', description: string): DpopCheck => ({
  ok: false,
  error,
  description,
});

/** RFC 9449 §4.3 proof checks, in the order of the reference `DpopManager.checkProof`. */
export async function checkDpopProof(req: Request, o: DpopCheckOptions): Promise<DpopCheck> {
  const proof = req.headers.get('dpop');
  if (proof === null) return dpopFail('invalid_dpop_proof', 'DPoP proof required');
  if (proof === '' || proof.includes(',')) {
    return dpopFail('invalid_dpop_proof', 'DPoP header must contain a single proof');
  }
  const jwt = decodeJwt(proof);
  if (!jwt) return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: Invalid JWT');
  const { header, payload } = jwt;
  if (header.typ !== 'dpop+jwt') return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: unexpected "typ"');
  if (header.alg !== 'ES256') return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: unsupported "alg"');
  const jwk = header.jwk;
  if (!isEcPublicJwk(jwk) || 'd' in (jwk as object)) {
    return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: "jwk" must be a public P-256 key');
  }
  if (!(await verifyEs256(jwt, jwk))) {
    return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: signature verification failed');
  }
  const nowSec = Math.floor(o.nowMs / 1000);
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: "iat" claim missing');
  }
  const age = nowSec - payload.iat;
  if (age > DPOP_PROOF_MAX_AGE_SEC + DPOP_CLOCK_TOLERANCE_SEC) {
    return dpopFail('invalid_dpop_proof', 'Failed to verify DPoP proof: "iat" claim timestamp check failed (too old)');
  }
  if (age < -DPOP_CLOCK_TOLERANCE_SEC) {
    return dpopFail(
      'invalid_dpop_proof',
      'Failed to verify DPoP proof: "iat" claim timestamp check failed (in the future)',
    );
  }
  const { jti, htm, htu, nonce, ath } = payload;
  if (nonce !== undefined && typeof nonce !== 'string')
    return dpopFail('invalid_dpop_proof', 'Invalid DPoP "nonce" type');
  if (typeof jti !== 'string' || jti === '') return dpopFail('invalid_dpop_proof', 'DPoP "jti" missing');
  if (htm !== req.method) return dpopFail('invalid_dpop_proof', 'DPoP "htm" mismatch');
  if (typeof htu !== 'string') return dpopFail('invalid_dpop_proof', 'Invalid DPoP "htu" type');
  let htuUrl: URL;
  try {
    htuUrl = new URL(htu);
  } catch {
    return dpopFail('invalid_dpop_proof', 'DPoP "htu" is not a valid URL');
  }
  const reqUrl = new URL(req.url);
  if (htuUrl.origin + htuUrl.pathname !== reqUrl.origin + reqUrl.pathname) {
    return dpopFail('invalid_dpop_proof', 'DPoP "htu" mismatch');
  }
  if (o.nonces) {
    if (!nonce) return dpopFail('use_dpop_nonce', 'Authorization server requires nonce in DPoP proof');
    if (!(await o.nonces.check(nonce))) return dpopFail('use_dpop_nonce', 'DPoP "nonce" mismatch');
  }
  if (o.accessToken !== undefined) {
    if (ath !== (await sha256B64url(o.accessToken))) return dpopFail('invalid_dpop_proof', 'DPoP "ath" mismatch');
  } else if (ath !== undefined) {
    return dpopFail('invalid_dpop_proof', 'DPoP "ath" claim not allowed');
  }
  if (o.seenJtis.has(jti)) return dpopFail('invalid_dpop_proof', 'DPoP proof replayed');
  o.seenJtis.add(jti);
  return { ok: true, jkt: await jwkThumbprint(jwk), jti, jwk };
}

// ---------------------------------------------------------------------------
// The fake AS
// ---------------------------------------------------------------------------

export interface FakeOAuthAsOptions {
  /** Defaults to `as.test`; the issuer is `https://<host>`. */
  host?: string;
  clock?: Clock;
  /** Tokens, codes, request URIs and the nonce secret. Defaults to a fixed byte stream. */
  random?: Random;
  /** How the AS fetches client metadata and JWKS: the router transport. Settable later with `connect`. */
  fetch?: (req: Request) => Promise<Response>;
  accessTokenTtlSec?: number;
  nonceRotationMs?: number;
  clientMetadataTtlMs?: number;
  /** Metadata members to override; `null` removes a member (e.g. `{pushed_authorization_request_endpoint: null}`). */
  metadata?: Record<string, unknown>;
}

export type RevocationSource =
  /** POST /oauth/revoke from a client. */
  | 'endpoint'
  /** A rotated-out refresh token was presented again. */
  | 'refresh_replay'
  /** An authorization code was presented again. */
  | 'code_replay'
  /** A refresh with another client key, or another DPoP key, than the session's. */
  | 'binding_mismatch'
  /** Refresh inactivity or the session lifetime ran out. */
  | 'expired'
  /** `revokeSession()`: the user revoked the app at their AS. */
  | 'operator';

export interface Revocation {
  atMs: number;
  source: RevocationSource;
  /** The session's DID, or null when the revoked token was unknown. */
  sub: string | null;
  clientId: string | null;
  sessionId: string | null;
  /** Which token a revocation request named; null for AS-side revocations. */
  tokenType: 'access_token' | 'refresh_token' | null;
  /** Whether the named token belonged to a session (always true for AS-side revocations). */
  known: boolean;
}

export interface AsSession {
  id: string;
  sub: string;
  clientId: string;
  scope: string;
  /** Thumbprint of the DPoP key the tokens are bound to. */
  dpopJkt: string;
  /** The client key the session was started with. */
  clientKid: string;
  clientAlg: string;
  clientJkt: string;
  createdAtMs: number;
  lastRefreshMs: number;
  refreshCount: number;
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  revoked: { atMs: number; source: RevocationSource } | null;
}

export interface Introspection {
  active: boolean;
  /** Why an inactive token is inactive. */
  reason: 'active' | 'expired' | 'revoked' | 'rotated';
  sub: string;
  clientId: string;
  scope: string;
  jkt: string;
  expiresAtMs: number;
}

/** What the next authorize call does (auto-approve otherwise). */
export interface AuthorizeOutcome {
  /** Sign in as this DID instead of the account `login_hint` names. */
  sub?: string;
  /** Redirect with this OAuth error (e.g. `access_denied`) instead of a code. */
  error?: string;
  /** Put this `iss` in the redirect instead of the issuer. */
  iss?: string;
}

interface ClientRecord {
  id: string;
  metadata: Record<string, unknown>;
  redirectUris: string[];
  scopes: string[];
  keys: EcPublicJwk[];
  fetchedAtMs: number;
}

interface ClientAuth {
  kid: string;
  alg: string;
  jkt: string;
}

interface ParRequest {
  clientId: string;
  params: URLSearchParams;
  auth: ClientAuth;
  dpopJkt: string;
  expiresAtMs: number;
}

interface CodeGrant {
  request: ParRequest;
  sub: string;
  issuedAtMs: number;
  used: boolean;
  sessionId: string | null;
}

class OAuthFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(`${error}: ${description}`);
  }
}

const oauthFail = (status: number, error: string, description: string, headers?: Record<string, string>): never => {
  throw new OAuthFailure(status, error, description, headers);
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/** A fixed, non-cryptographic byte stream for when no Random is injected. */
function counterRandom(seed: string): Random {
  let n = 0;
  return {
    bytes(len: number) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        n = (n + 1) >>> 0;
        out[i] = (n * 131 + seed.charCodeAt(n % seed.length)) & 0xff;
      }
      return out;
    },
    float: () => {
      n = (n + 1) >>> 0;
      return (n % 1000) / 1000;
    },
  };
}

function scopeTokens(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter((s) => s !== '') : [];
}

export class FakeOAuthAs implements HostedRoutable {
  readonly host: string;
  readonly issuer: string;
  /** Every request this AS answered. */
  readonly calls = new CallLog();
  /** Faults returned instead of processing a call (match on `path`). */
  readonly faults = new FaultQueue();
  /** Every revocation, client-requested or AS-side, in order. */
  readonly revocations: Revocation[] = [];
  readonly nonces: DpopNonceSource;

  private readonly clock: Clock;
  private readonly random: Random;
  private upstream: ((req: Request) => Promise<Response>) | null;
  private readonly accessTokenTtlSec: number;
  private readonly clientMetadataTtlMs: number;
  private metadataOverrides: Record<string, unknown>;

  private readonly accountsByHandle = new Map<string, string>();
  private readonly accountDids = new Set<string>();
  private readonly outcomes: AuthorizeOutcome[] = [];
  private readonly clients = new Map<string, ClientRecord>();
  private readonly assertionJtis = new Set<string>();
  private readonly dpopJtis = new Set<string>();
  private readonly requests = new Map<string, ParRequest>();
  private readonly codes = new Map<string, CodeGrant>();
  private readonly sessionsById = new Map<string, AsSession>();
  /** Every access token ever issued → session id. */
  private readonly accessIndex = new Map<string, string>();
  /** Every refresh token ever issued → session id. */
  private readonly refreshIndex = new Map<string, string>();

  constructor(opts: FakeOAuthAsOptions = {}) {
    this.host = opts.host ?? FAKE_AS_HOST;
    this.issuer = `https://${this.host}`;
    this.clock = opts.clock ?? { nowMs: () => FIXTURE_NOW_MS };
    this.random = opts.random ?? counterRandom(this.host);
    this.upstream = opts.fetch ?? null;
    this.accessTokenTtlSec = opts.accessTokenTtlSec ?? ACCESS_TOKEN_TTL_SEC;
    this.clientMetadataTtlMs = opts.clientMetadataTtlMs ?? CLIENT_METADATA_TTL_MS;
    this.metadataOverrides = { ...opts.metadata };
    this.nonces = new DpopNonceSource(this.random.bytes(32), this.clock, opts.nonceRotationMs);
  }

  // ---- configuration ---------------------------------------------------

  /** Set the transport the AS fetches client metadata and JWKS through (the router transport). */
  connect(fetch: (req: Request) => Promise<Response>): void {
    this.upstream = fetch;
  }

  /** An account that authorize can sign in, by DID or by handle in `login_hint`. */
  addAccount(did: string, o: { handle?: string } = {}): void {
    this.accountDids.add(did);
    if (o.handle !== undefined) this.accountsByHandle.set(o.handle.toLowerCase(), did);
  }

  /** Script the next authorize call. Outcomes are used in order, then auto-approve resumes. */
  nextAuthorize(outcome: AuthorizeOutcome): void {
    this.outcomes.push(outcome);
  }

  /** Change metadata members (`null` removes one). */
  setMetadata(overrides: Record<string, unknown>): void {
    this.metadataOverrides = { ...this.metadataOverrides, ...overrides };
  }

  /** Inject a fault for the next `times` calls matching `match` (usually `{path}`). */
  fail(match: FaultMatch, fault: Fault, times = 1): Fault {
    return this.faults.add(match, fault, times);
  }

  /** The next `times` calls to `path` answer an OAuth error body (`{error, error_description}`). */
  failOAuth(path: string, error: string, description = `fixture fault ${error}`, status = 400, times = 1): Fault {
    return this.fail(
      { path },
      { kind: 'respond', respond: () => json({ error, error_description: description }, status) },
      times,
    );
  }

  /** Forget cached client metadata and JWKS. */
  clearClientCache(): void {
    this.clients.clear();
  }

  // ---- inspection ------------------------------------------------------

  get metadata(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      issuer: this.issuer,
      request_parameter_supported: false,
      request_uri_parameter_supported: true,
      require_request_uri_registration: true,
      scopes_supported: ['atproto', 'transition:generic', 'transition:chat.bsky'],
      subject_types_supported: ['public'],
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'fragment'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      ui_locales_supported: ['en-US'],
      display_values_supported: ['page', 'popup', 'touch'],
      prompt_values_supported: ['none', 'login', 'consent', 'select_account', 'create'],
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      pushed_authorization_request_endpoint: `${this.issuer}/oauth/par`,
      require_pushed_authorization_requests: true,
      dpop_signing_alg_values_supported: ['ES256'],
      client_id_metadata_document_supported: true,
    };
    for (const [k, v] of Object.entries(this.metadataOverrides)) {
      if (v === null) delete base[k];
      else base[k] = v;
    }
    return base;
  }

  /** Sessions, optionally for one DID, oldest first. */
  sessions(sub?: string): AsSession[] {
    return [...this.sessionsById.values()].filter((s) => sub === undefined || s.sub === sub);
  }

  /** How many requests reached `path` (faults included). */
  count(path?: string, method?: string): number {
    return this.calls.count({ path, method });
  }

  /** What a resource server learns about an access token; null when this AS never issued it. */
  introspect(accessToken: string): Introspection | null {
    const id = this.accessIndex.get(accessToken);
    const s = id === undefined ? undefined : this.sessionsById.get(id);
    if (!s) return null;
    const reason = s.revoked
      ? 'revoked'
      : s.accessToken !== accessToken
        ? 'rotated'
        : this.clock.nowMs() >= s.accessExpiresAtMs
          ? 'expired'
          : 'active';
    return {
      active: reason === 'active',
      reason,
      sub: s.sub,
      clientId: s.clientId,
      scope: s.scope,
      jkt: s.dpopJkt,
      expiresAtMs: s.accessExpiresAtMs,
    };
  }

  /** The user revokes every session of `sub` at the AS; later refreshes are `invalid_grant`. */
  revokeSession(sub: string): number {
    let n = 0;
    for (const s of this.sessions(sub)) {
      if (!s.revoked) {
        this.revoke(s, 'operator');
        n += 1;
      }
    }
    return n;
  }

  /** Make every DPoP nonce handed out so far unacceptable (as if three rotations passed). */
  rotateNonces(): void {
    this.nonces.rotate();
  }

  // ---- the handler -----------------------------------------------------

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'as',
        host: this.host,
        method: req.method,
        path: url.pathname,
        nsid: null,
        params: paramsOf(url),
        did: null,
        status,
        fault: fault ? faultName(fault) : null,
      });
    const fault = this.faults.take({ nsid: null, did: null, path: url.pathname });
    if (fault) {
      if (fault.kind === 'hang') log(0, fault);
      const res = await faultResponse(fault, req);
      log(res.status, fault);
      return res;
    }
    let res: Response;
    try {
      res = await this.route(req, url);
    } catch (e) {
      if (!(e instanceof OAuthFailure)) throw e;
      res = json({ error: e.error, error_description: e.description }, e.status, e.headers);
    }
    if (req.method === 'POST' && !res.headers.has('dpop-nonce'))
      res.headers.set('DPoP-Nonce', await this.nonces.next());
    log(res.status, null);
    return res;
  };

  private route(req: Request, url: URL): Promise<Response> | Response {
    const key = `${req.method} ${url.pathname}`;
    switch (key) {
      case 'GET /.well-known/oauth-authorization-server':
        return new Response(JSON.stringify(this.metadata), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
        });
      case 'POST /oauth/par':
        return this.par(req);
      case 'GET /oauth/authorize':
        return this.authorize(url);
      case 'POST /oauth/token':
        return this.token(req);
      case 'POST /oauth/revoke':
        return this.revocation(req);
      default:
        return json({ error: 'not_found', error_description: `no route for ${key}` }, 404);
    }
  }

  // ---- shared checks ---------------------------------------------------

  private async form(req: Request): Promise<URLSearchParams> {
    const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      oauthFail(400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
    }
    return new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  }

  /** The DPoP proof of a PAR, token or revocation request; returns its key thumbprint. */
  private async dpop(req: Request): Promise<string> {
    const r = await checkDpopProof(req, { nowMs: this.clock.nowMs(), nonces: this.nonces, seenJtis: this.dpopJtis });
    if (r.ok) return r.jkt;
    if (r.error === 'use_dpop_nonce') {
      return oauthFail(400, 'use_dpop_nonce', r.description, { 'DPoP-Nonce': await this.nonces.next() });
    }
    return oauthFail(401, 'invalid_dpop_proof', r.description, {
      'WWW-Authenticate': `DPoP error="invalid_dpop_proof", error_description="${r.description.replace(/"/g, "'")}"`,
    });
  }

  private async getJson(url: string, what: string, clientId: string): Promise<Record<string, unknown>> {
    const fail = (why: string) =>
      oauthFail(400, 'invalid_client_metadata', `Unable to obtain ${what} for "${clientId}": ${why}`);
    if (!this.upstream) return fail('the fake AS has no transport (call connect())');
    let res: Response;
    try {
      res = await this.upstream(new Request(url, { headers: { accept: 'application/json' }, redirect: 'manual' }));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (res.status !== 200) return fail(`HTTP ${res.status}`);
    const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') return fail('not application/json');
    const body = parseJsonObject(new Uint8Array(await res.arrayBuffer()));
    return body ?? fail('not a JSON object');
  }

  /** The client's metadata and JWKS, refetched once the 10-minute cache entry is older than the TTL. */
  private async client(clientId: string): Promise<ClientRecord> {
    const now = this.clock.nowMs();
    const cached = this.clients.get(clientId);
    if (cached && now - cached.fetchedAtMs < this.clientMetadataTtlMs) return cached;
    const bad = (why: string) => oauthFail(400, 'invalid_client_metadata', `Invalid client metadata: ${why}`);
    let id: URL;
    try {
      id = new URL(clientId);
    } catch {
      return oauthFail(400, 'invalid_client', 'client_id must be a URL');
    }
    if (id.protocol !== 'https:') return oauthFail(400, 'invalid_client', 'client_id must be an https URL');
    const md = await this.getJson(clientId, 'client metadata', clientId);
    if (md.client_id !== clientId) bad('"client_id" does not match the metadata URL');
    if (md.token_endpoint_auth_method !== 'private_key_jwt') {
      bad('the fake AS accepts only "private_key_jwt" clients');
    }
    if (md.token_endpoint_auth_signing_alg !== undefined && md.token_endpoint_auth_signing_alg !== 'ES256') {
      bad('"token_endpoint_auth_signing_alg" must be ES256');
    }
    if (md.dpop_bound_access_tokens !== true) bad('"dpop_bound_access_tokens" must be true');
    const scopes = scopeTokens(md.scope);
    if (!scopes.includes('atproto')) bad('"scope" must include "atproto"');
    const grants = Array.isArray(md.grant_types) ? md.grant_types : [];
    if (!grants.includes('authorization_code')) bad('"grant_types" must include "authorization_code"');
    const redirectUris = Array.isArray(md.redirect_uris)
      ? md.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0) bad('"redirect_uris" is required');
    let jwks: Record<string, unknown>;
    if (typeof md.jwks_uri === 'string') jwks = await this.getJson(md.jwks_uri, 'client JWKS', clientId);
    else if (md.jwks !== null && typeof md.jwks === 'object') jwks = md.jwks as Record<string, unknown>;
    else return bad('"jwks_uri" or "jwks" is required for private_key_jwt');
    const keys = Array.isArray(jwks.keys) ? jwks.keys : bad('JWKS without "keys"');
    const published: EcPublicJwk[] = [];
    for (const k of keys as unknown[]) {
      if (k !== null && typeof k === 'object' && 'd' in k) bad('the JWKS contains a private key');
      if (isEcPublicJwk(k) && typeof k.kid === 'string' && k.kid !== '') published.push(publicJwk(k));
    }
    const record: ClientRecord = {
      id: clientId,
      metadata: md,
      redirectUris,
      scopes,
      keys: published,
      fetchedAtMs: now,
    };
    this.clients.set(clientId, record);
    return record;
  }

  /** private_key_jwt client authentication (RFC 7523 §3, as the reference `Client.authenticate`). */
  private async authenticateClient(form: URLSearchParams, dpopJkt: string | null) {
    const clientId = form.get('client_id') ?? oauthFail(400, 'invalid_request', '"client_id" is required');
    const client = await this.client(clientId);
    const invalid = (why: string) => oauthFail(400, 'invalid_client', why);
    const assertion = form.get('client_assertion');
    if (assertion === null) {
      return oauthFail(
        400,
        'invalid_request',
        'client authentication method "private_key_jwt" required a "client_assertion"',
      );
    }
    if (form.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE_JWT_BEARER) {
      invalid(`Unsupported client_assertion_type "${form.get('client_assertion_type')}"`);
    }
    const jwt = decodeJwt(assertion) ?? invalid('Validation of "client_assertion" failed: Invalid Compact JWS');
    const { header, payload } = jwt;
    if (header.alg !== 'ES256') invalid('Validation of "client_assertion" failed: unsupported "alg"');
    const kid =
      typeof header.kid === 'string' && header.kid !== '' ? header.kid : invalid('"kid" required in client_assertion');
    const key = client.keys.find((k) => k.kid === kid && (k.alg === undefined || k.alg === 'ES256'));
    if (!key) invalid(`Validation of "client_assertion" failed: no key "${kid}" in the client's jwks_uri`);
    if (!(await verifyEs256(jwt, key!)))
      invalid('Validation of "client_assertion" failed: signature verification failed');
    if (payload.iss !== clientId) invalid('Validation of "client_assertion" failed: unexpected "iss" claim value');
    if (payload.sub !== clientId) invalid('Validation of "client_assertion" failed: unexpected "sub" claim value');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.issuer)) invalid('Validation of "client_assertion" failed: unexpected "aud" claim value');
    if (typeof payload.jti !== 'string' || payload.jti === '') {
      invalid('Validation of "client_assertion" failed: missing required "jti" claim');
    }
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
      invalid('Validation of "client_assertion" failed: missing required "iat" claim');
    }
    const age = nowSec - (payload.iat as number);
    if (age > CLIENT_ASSERTION_MAX_AGE_SEC) {
      invalid('Validation of "client_assertion" failed: "iat" claim timestamp check failed (too far in the past)');
    }
    if (age < 0)
      invalid('Validation of "client_assertion" failed: "iat" claim timestamp check failed (it should be in the past)');
    if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp <= nowSec)) {
      invalid('Validation of "client_assertion" failed: "exp" claim timestamp check failed');
    }
    const jkt = await jwkThumbprint(key!);
    if (dpopJkt !== null && dpopJkt === jkt) {
      oauthFail(400, 'invalid_request', 'The DPoP proof must be signed with a different key than the client assertion');
    }
    const replayKey = `${clientId}\u0000${payload.jti as string}`;
    if (this.assertionJtis.has(replayKey)) invalid('private_key_jwt jti reused');
    this.assertionJtis.add(replayKey);
    return { client, auth: { kid, alg: 'ES256', jkt } satisfies ClientAuth };
  }

  private token16(prefix: string, bytes = 16): string {
    return `${prefix}${hexOf(this.random.bytes(bytes))}`;
  }

  private revoke(s: AsSession, source: RevocationSource, tokenType: Revocation['tokenType'] = null): void {
    const atMs = this.clock.nowMs();
    if (!s.revoked) s.revoked = { atMs, source };
    this.revocations.push({ atMs, source, sub: s.sub, clientId: s.clientId, sessionId: s.id, tokenType, known: true });
  }

  // ---- endpoints -------------------------------------------------------

  private async par(req: Request): Promise<Response> {
    const dpopJkt = await this.dpop(req);
    const form = await this.form(req);
    const { client, auth } = await this.authenticateClient(form, dpopJkt);
    const invalid = (why: string) => oauthFail(400, 'invalid_request', why);
    if (form.has('request')) invalid('Request objects (JAR) are not supported by the fake AS');
    if (form.get('response_type') !== 'code')
      oauthFail(400, 'unsupported_response_type', 'response_type must be "code"');
    const redirectUri = form.get('redirect_uri') ?? client.redirectUris[0]!;
    if (!client.redirectUris.includes(redirectUri)) invalid('Invalid redirect_uri');
    const challenge = form.get('code_challenge');
    if (!challenge) invalid('code_challenge is required');
    if (form.get('code_challenge_method') !== 'S256') invalid('code_challenge_method must be "S256"');
    const mode = form.get('response_mode') ?? 'query';
    if (mode !== 'query' && mode !== 'fragment') invalid(`Unsupported response_mode "${mode}"`);
    const scope = scopeTokens(form.get('scope') ?? client.metadata.scope);
    if (!scope.includes('atproto')) oauthFail(400, 'invalid_scope', 'The "atproto" scope is required');
    for (const s of scope) {
      if (!client.scopes.includes(s))
        oauthFail(400, 'invalid_scope', `Scope "${s}" is not declared in the client metadata`);
    }
    const hinted = form.get('dpop_jkt');
    if (hinted !== null && hinted !== dpopJkt) invalid('"dpop_jkt" does not match the DPoP proof');
    const params = new URLSearchParams(form);
    params.set('redirect_uri', redirectUri);
    params.set('scope', scope.join(' '));
    params.delete('client_assertion');
    params.delete('client_assertion_type');
    const requestUri = `${REQUEST_URI_PREFIX}${this.token16('req-')}`;
    this.requests.set(requestUri, {
      clientId: client.id,
      params,
      auth,
      dpopJkt,
      expiresAtMs: this.clock.nowMs() + PAR_EXPIRES_IN_SEC * 1000,
    });
    return json({ request_uri: requestUri, expires_in: PAR_EXPIRES_IN_SEC }, 201);
  }

  private authorize(url: URL): Response {
    const requestUri = url.searchParams.get('request_uri');
    const request = requestUri === null ? undefined : this.requests.get(requestUri);
    if (!request || requestUri === null)
      return json({ error: 'invalid_request', error_description: 'Unknown request_uri' }, 400);
    this.requests.delete(requestUri); // single use
    if (this.clock.nowMs() >= request.expiresAtMs) {
      return json({ error: 'invalid_request', error_description: 'This request has expired' }, 400);
    }
    if (url.searchParams.get('client_id') !== request.clientId) {
      return json({ error: 'invalid_request', error_description: 'client_id does not match the request' }, 400);
    }
    const outcome = this.outcomes.shift() ?? {};
    const redirect = new URL(request.params.get('redirect_uri')!);
    const answer = new URLSearchParams();
    const state = request.params.get('state');
    if (state !== null) answer.set('state', state);
    answer.set('iss', outcome.iss ?? this.issuer);
    const sub = outcome.error === undefined ? (outcome.sub ?? this.subjectFor(request.params.get('login_hint'))) : null;
    if (outcome.error !== undefined || sub === null) {
      answer.set('error', outcome.error ?? 'access_denied');
      answer.set('error_description', outcome.error === undefined ? 'Unknown account' : 'The user denied the request');
    } else {
      const code = this.token16('cod-', 32);
      this.codes.set(code, { request, sub, issuedAtMs: this.clock.nowMs(), used: false, sessionId: null });
      answer.set('code', code);
    }
    if (request.params.get('response_mode') === 'fragment') redirect.hash = answer.toString();
    else for (const [k, v] of answer) redirect.searchParams.set(k, v);
    return new Response(null, { status: 303, headers: { location: redirect.href, 'cache-control': 'no-store' } });
  }

  private subjectFor(hint: string | null): string | null {
    if (hint === null) return this.accountDids.size === 1 ? [...this.accountDids][0]! : null;
    if (hint.startsWith('did:')) return this.accountDids.has(hint) ? hint : null;
    return this.accountsByHandle.get(hint.toLowerCase()) ?? null;
  }

  private async token(req: Request): Promise<Response> {
    const dpopJkt = await this.dpop(req);
    const form = await this.form(req);
    const { client, auth } = await this.authenticateClient(form, dpopJkt);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return this.codeGrant(form, client, auth, dpopJkt);
    if (grantType === 'refresh_token') return this.refreshGrant(form, client, auth, dpopJkt);
    return oauthFail(400, 'unsupported_grant_type', `Grant type "${grantType}" not supported`);
  }

  private async codeGrant(form: URLSearchParams, client: ClientRecord, auth: ClientAuth, dpopJkt: string) {
    const grant = this.codes.get(form.get('code') ?? '');
    const invalid = (why: string) => oauthFail(400, 'invalid_grant', why);
    if (!grant) return invalid('Invalid code');
    if (grant.used) {
      // A replayed code kills whatever it was exchanged for.
      const s = grant.sessionId === null ? undefined : this.sessionsById.get(grant.sessionId);
      if (s && !s.revoked) this.revoke(s, 'code_replay');
      return invalid('Invalid code');
    }
    grant.used = true;
    const now = this.clock.nowMs();
    if (now - grant.issuedAtMs > CODE_TTL_MS) invalid('Code expired');
    const { request } = grant;
    if (request.clientId !== client.id) invalid('Token was not issued to this client');
    if (request.auth.kid !== auth.kid || request.auth.alg !== auth.alg || request.auth.jkt !== auth.jkt) {
      invalid('The session was initiated with a different key than the client assertion currently used');
    }
    if (request.dpopJkt !== dpopJkt) invalid('DPoP proof does not match the expected JKT');
    if (form.get('redirect_uri') !== request.params.get('redirect_uri')) {
      invalid('The redirect_uri parameter must match the one used in the authorization request');
    }
    const verifier = form.get('code_verifier');
    if (!verifier) invalid('code_verifier is required');
    if (verifier!.length < 43 || verifier!.length > 128) invalid('code_verifier must be 43 to 128 characters');
    if ((await sha256B64url(verifier!)) !== request.params.get('code_challenge')) invalid('Invalid code_verifier');
    const s: AsSession = {
      id: this.token16('ses-'),
      sub: grant.sub,
      clientId: client.id,
      scope: request.params.get('scope')!,
      dpopJkt,
      clientKid: auth.kid,
      clientAlg: auth.alg,
      clientJkt: auth.jkt,
      createdAtMs: now,
      lastRefreshMs: now,
      refreshCount: 0,
      accessToken: '',
      accessExpiresAtMs: 0,
      refreshToken: '',
      revoked: null,
    };
    this.sessionsById.set(s.id, s);
    grant.sessionId = s.id;
    return this.issue(s);
  }

  private async refreshGrant(form: URLSearchParams, client: ClientRecord, auth: ClientAuth, dpopJkt: string) {
    const token = form.get('refresh_token') ?? '';
    const id = this.refreshIndex.get(token);
    const s = id === undefined ? undefined : this.sessionsById.get(id);
    const invalid = (why: string) => oauthFail(400, 'invalid_grant', why);
    if (!s || s.revoked) return invalid('Invalid refresh token');
    if (s.refreshToken !== token) {
      this.revoke(s, 'refresh_replay');
      return invalid('Refresh token replayed');
    }
    if (s.clientId !== client.id) return invalid('Token was not issued to this client');
    if (s.clientKid !== auth.kid || s.clientAlg !== auth.alg || s.clientJkt !== auth.jkt) {
      this.revoke(s, 'binding_mismatch');
      return invalid('The session was initiated with a different key than the client assertion currently used');
    }
    if (s.dpopJkt !== dpopJkt) {
      this.revoke(s, 'binding_mismatch');
      return invalid('DPoP proof does not match the expected JKT');
    }
    const now = this.clock.nowMs();
    if (now - s.lastRefreshMs > REFRESH_INACTIVITY_MS || now - s.createdAtMs > SESSION_LIFETIME_MS) {
      this.revoke(s, 'expired');
      return invalid('Refresh token expired');
    }
    s.lastRefreshMs = now;
    s.refreshCount += 1;
    return this.issue(s);
  }

  /** New access and refresh tokens for `s`; the previous ones stop working. */
  private issue(s: AsSession): Response {
    s.accessToken = this.token16('at-', 32);
    s.accessExpiresAtMs = this.clock.nowMs() + this.accessTokenTtlSec * 1000;
    s.refreshToken = this.token16('ref-', 32);
    this.accessIndex.set(s.accessToken, s.id);
    this.refreshIndex.set(s.refreshToken, s.id);
    return json({
      access_token: s.accessToken,
      token_type: 'DPoP',
      refresh_token: s.refreshToken,
      scope: s.scope,
      sub: s.sub,
      expires_in: this.accessTokenTtlSec,
    });
  }

  private async revocation(req: Request): Promise<Response> {
    if (req.headers.has('dpop')) await this.dpop(req);
    const form = await this.form(req);
    const { client } = await this.authenticateClient(form, null);
    const token = form.get('token') ?? oauthFail(400, 'invalid_request', '"token" is required');
    const viaAccess = this.accessIndex.get(token);
    const id = viaAccess ?? this.refreshIndex.get(token);
    const s = id === undefined ? undefined : this.sessionsById.get(id);
    if (s && s.clientId === client.id) {
      this.revoke(s, 'endpoint', viaAccess !== undefined ? 'access_token' : 'refresh_token');
    } else {
      this.revocations.push({
        atMs: this.clock.nowMs(),
        source: 'endpoint',
        sub: null,
        clientId: client.id,
        sessionId: null,
        tokenType: null,
        known: false,
      });
    }
    return json({});
  }
}

export function fakeOAuthAs(opts?: FakeOAuthAsOptions): FakeOAuthAs {
  return new FakeOAuthAs(opts);
}

// ---------------------------------------------------------------------------
// Fixture keys (public test keys; never use outside fixtures)
// ---------------------------------------------------------------------------

/** Client signing keys k1, k2, k3 (ES256, with kid). */
export const FIXTURE_CLIENT_KEYS = {
  k1: {
    kty: 'EC',
    crv: 'P-256',
    kid: 'k1',
    alg: 'ES256',
    x: 'bfOIrWjm3AY2xfKGepmlEBnLy0_rXfLkf7eJNaA3P10',
    y: 'UFpwt3uPKsUGDheMApDxJN9FU0kzQVGpNAXVG1VPvVA',
    d: 'Yhz34LpTrJL5fOsxNc4SXrLDA4gyi8JhA414HlP6-H4',
  },
  k2: {
    kty: 'EC',
    crv: 'P-256',
    kid: 'k2',
    alg: 'ES256',
    x: 'CRH6Sc3PMWGUijM-UbgqqIeq18EwAjEih5OhpatsdXQ',
    y: 'kfuAbS0bYk1cLp9HIJ0dQi9K00ht6NhjGNMTx3Z23nE',
    d: 'VvfIaf5_JArvCqMcQHEL1CmMg0onwYok2gcXzG8fxeU',
  },
  k3: {
    kty: 'EC',
    crv: 'P-256',
    kid: 'k3',
    alg: 'ES256',
    x: 'UQ_nD6PySfg3FlqeygTLHA8NrMJpKb10PuH5_tf1vH8',
    y: 'QhD0LAItOlQKH2UlWHA3yPZOTZV4S_1eXbpaA4YicuM',
    d: 'oQ7kFmOX20cwleBmTjjCQsHNWO7Ww1Ps81VK7z5gqnA',
  },
} as const satisfies Record<string, EcPrivateJwk & { kid: string }>;

/** DPoP keys (no kid). */
export const FIXTURE_DPOP_KEYS = [
  {
    kty: 'EC',
    crv: 'P-256',
    x: 'miGi26Zu4MLbUOcBOKaX0f6GAb9Qqz-xsVttMTV9Zyg',
    y: 'o7Dpylc7KnaMGFmEo7-HdZLIX4Yn7gdu_CMpXeg3o24',
    d: 'fXyatTENE17Qn558MSDoXtSOmRNnpkIkx-YOejEeQxY',
  },
  {
    kty: 'EC',
    crv: 'P-256',
    x: 'v341jFP0EYvcp5m29RRc3Ae6S3SBJjSTkf55DcU8r_A',
    y: 'GAZQ2vWEaNHkNd_yCrqdilDCChvirI_CtRcIpn1JQZM',
    d: 'vbuAxlF1yNcy74A1WgE04aVDTfshz4ia0dMqD6xwEcM',
  },
] as const satisfies readonly EcPrivateJwk[];

// ---------------------------------------------------------------------------
// A fixture client app: serves client metadata and JWKS
// ---------------------------------------------------------------------------

export const FIXTURE_CLIENT_HOST = 'client.example.test';

export interface FixtureClientApp extends HostedRoutable {
  readonly origin: string;
  readonly clientId: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  /** The served client metadata document; mutable. */
  metadata: Record<string, unknown>;
  /** Keys whose public halves `jwks.json` serves; mutable (rotation). */
  keys: EcPublicJwk[];
  readonly calls: CallLog;
}

export function fixtureClientApp(
  o: { host?: string; scope?: string; keys?: readonly EcPublicJwk[] } = {},
): FixtureClientApp {
  const host = o.host ?? FIXTURE_CLIENT_HOST;
  const origin = `https://${host}`;
  const clientId = `${origin}/oauth/client-metadata.json`;
  const jwksUri = `${origin}/oauth/jwks.json`;
  const redirectUri = `${origin}/oauth/callback`;
  const calls = new CallLog();
  const app: FixtureClientApp = {
    host,
    origin,
    clientId,
    jwksUri,
    redirectUri,
    calls,
    keys: [...(o.keys ?? [FIXTURE_CLIENT_KEYS.k1])],
    metadata: {
      client_id: clientId,
      client_name: 'Fixture Client',
      client_uri: origin,
      application_type: 'web',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: o.scope ?? 'atproto repo:com.example.atmusic.scrobble',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks_uri: jwksUri,
      dpop_bound_access_tokens: true,
    },
    fetch(req: Request): Response {
      const url = new URL(req.url);
      let res: Response;
      if (req.method === 'GET' && url.href === clientId)
        res = json(app.metadata, 200, { 'cache-control': 'max-age=300' });
      else if (req.method === 'GET' && url.href === jwksUri) {
        res = json({ keys: app.keys.map(publicJwk) }, 200, { 'cache-control': 'max-age=300' });
      } else res = json({ error: 'not_found' }, 404);
      calls.record({
        service: 'client',
        host,
        method: req.method,
        path: url.pathname,
        nsid: null,
        params: paramsOf(url),
        did: null,
        status: res.status,
        fault: null,
      });
      return res;
    },
  };
  return app;
}

// ---------------------------------------------------------------------------
// A minimal confidential client for tests that drive the AS directly
// ---------------------------------------------------------------------------

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  sub: string;
  expires_in: number;
}

export interface AssertionOptions {
  key?: EcPrivateJwk & { kid: string };
  /** `iat` in epoch seconds; defaults to the clock. */
  iatSec?: number;
  /** Defaults to a fresh random value. */
  jti?: string;
  aud?: string;
  /** Seconds after iat; null omits `exp`. Default 60, as @atproto/oauth-client. */
  expInSec?: number | null;
}

export interface FixtureOAuthClientOptions {
  app: FixtureClientApp;
  /** The router transport. */
  transport: (req: Request) => Promise<Response>;
  clock: Clock;
  random: Random;
  /** Defaults to `https://as.test`. */
  issuer?: string;
  signingKey?: EcPrivateJwk & { kid: string };
  dpopKey?: EcPrivateJwk;
}

function isUseDpopNonce(res: Response, body: Record<string, unknown> | null): boolean {
  if (res.status === 400 && body?.error === 'use_dpop_nonce') return true;
  const www = res.headers.get('www-authenticate');
  return res.status === 401 && www !== null && www.startsWith('DPoP') && www.includes('error="use_dpop_nonce"');
}

async function peekJson(res: Response): Promise<Record<string, unknown> | null> {
  return parseJsonObject(new Uint8Array(await res.clone().arrayBuffer()));
}

/**
 * The client side of the flow, as @atproto/oauth-client does it: PAR with PKCE
 * S256 and a private_key_jwt assertion, auto-approved authorize, code exchange,
 * refresh, revoke and DPoP-bound resource requests, each retried once on
 * `use_dpop_nonce` with the same body (and so the same assertion).
 */
export class FixtureOAuthClient {
  readonly app: FixtureClientApp;
  readonly issuer: string;
  signingKey: EcPrivateJwk & { kid: string };
  dpopKey: EcPrivateJwk;
  /** Last DPoP nonce per origin. */
  readonly nonces = new Map<string, string>();
  private readonly transport: (req: Request) => Promise<Response>;
  private readonly clock: Clock;
  private readonly random: Random;

  constructor(o: FixtureOAuthClientOptions) {
    this.app = o.app;
    this.transport = o.transport;
    this.clock = o.clock;
    this.random = o.random;
    this.issuer = o.issuer ?? `https://${FAKE_AS_HOST}`;
    this.signingKey = o.signingKey ?? FIXTURE_CLIENT_KEYS.k1;
    this.dpopKey = o.dpopKey ?? FIXTURE_DPOP_KEYS[0];
  }

  private nowSec(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  private randomId(): string {
    return b64url(this.random.bytes(16));
  }

  assertion(o: AssertionOptions = {}): Promise<string> {
    const key = o.key ?? this.signingKey;
    const iat = o.iatSec ?? this.nowSec();
    const expIn = o.expInSec === undefined ? 60 : o.expInSec;
    const payload: Record<string, unknown> = {
      iss: this.app.clientId,
      sub: this.app.clientId,
      aud: o.aud ?? this.issuer,
      jti: o.jti ?? this.randomId(),
      iat,
    };
    if (expIn !== null) payload.exp = iat + expIn;
    return signJwt(key, { kid: key.kid }, payload);
  }

  proof(
    htm: string,
    htu: string,
    o: { nonce?: string | null; accessToken?: string; key?: EcPrivateJwk; iatSec?: number } = {},
  ): Promise<string> {
    const key = o.key ?? this.dpopKey;
    const url = new URL(htu);
    const nonce = o.nonce === undefined ? this.nonces.get(url.origin) : (o.nonce ?? undefined);
    return (async () => {
      const payload: Record<string, unknown> = {
        iat: o.iatSec ?? this.nowSec(),
        jti: this.randomId(),
        htm,
        htu: url.origin + url.pathname,
      };
      if (nonce !== undefined) payload.nonce = nonce;
      if (o.accessToken !== undefined) payload.ath = await sha256B64url(o.accessToken);
      return signJwt(key, { typ: 'dpop+jwt', jwk: publicJwk(key) }, payload);
    })();
  }

  /** Send `make()` with a DPoP proof; on use_dpop_nonce, store the nonce and resend once. */
  private async withDpop(
    method: string,
    url: string,
    make: (proof: string) => Request,
    o: { accessToken?: string; retry?: boolean } = {},
  ): Promise<Response> {
    const { origin } = new URL(url);
    const send = async () => {
      const res = await this.transport(make(await this.proof(method, url, { accessToken: o.accessToken })));
      const nonce = res.headers.get('dpop-nonce');
      if (nonce !== null) this.nonces.set(origin, nonce);
      return res;
    };
    const first = await send();
    if (o.retry === false || !isUseDpopNonce(first, await peekJson(first))) return first;
    return send();
  }

  /** POST a form to an AS endpoint with client authentication. */
  post(
    endpoint: 'par' | 'token' | 'revoke',
    form: Record<string, string>,
    o: { assertion?: string; retry?: boolean } = {},
  ): Promise<Response> {
    const url = `${this.issuer}/oauth/${endpoint}`;
    return (async () => {
      const body = new URLSearchParams({
        ...form,
        client_id: this.app.clientId,
        client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
        client_assertion: o.assertion ?? (await this.assertion()),
      }).toString();
      return this.withDpop(
        'POST',
        url,
        (proof) =>
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: proof },
            body,
          }),
        { retry: o.retry },
      );
    })();
  }

  /** PAR with a fresh PKCE verifier and state. */
  async par(o: { loginHint?: string; scope?: string; assertion?: string } = {}) {
    const verifier = b64url(this.random.bytes(32));
    const state = this.randomId();
    const form: Record<string, string> = {
      response_type: 'code',
      redirect_uri: this.app.redirectUri,
      code_challenge: await sha256B64url(verifier),
      code_challenge_method: 'S256',
      state,
      response_mode: 'query',
      scope: o.scope ?? String(this.app.metadata.scope),
    };
    if (o.loginHint !== undefined) form.login_hint = o.loginHint;
    const res = await this.post('par', form, { assertion: o.assertion });
    const body = await peekJson(res);
    return { res, body, requestUri: typeof body?.request_uri === 'string' ? body.request_uri : null, verifier, state };
  }

  /** The browser step: GET authorize and read the redirect. */
  async authorize(requestUri: string): Promise<{ res: Response; params: URLSearchParams }> {
    const url = new URL(`${this.issuer}/oauth/authorize`);
    url.searchParams.set('client_id', this.app.clientId);
    url.searchParams.set('request_uri', requestUri);
    const res = await this.transport(new Request(url));
    const location = res.headers.get('location');
    return { res, params: location === null ? new URLSearchParams() : new URL(location).searchParams };
  }

  exchange(code: string, verifier: string, o: { assertion?: string } = {}): Promise<Response> {
    return this.post(
      'token',
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.app.redirectUri },
      o,
    );
  }

  refresh(refreshToken: string, o: { assertion?: string } = {}): Promise<Response> {
    return this.post('token', { grant_type: 'refresh_token', refresh_token: refreshToken }, o);
  }

  revoke(token: string): Promise<Response> {
    return this.post('revoke', { token });
  }

  /** PAR → authorize → token; throws unless every step succeeds. */
  async signIn(loginHint?: string, o: { scope?: string } = {}): Promise<TokenSet> {
    const par = await this.par({ loginHint, scope: o.scope });
    if (par.res.status !== 201 || par.requestUri === null) throw new Error(`PAR failed: ${JSON.stringify(par.body)}`);
    const auth = await this.authorize(par.requestUri);
    const code = auth.params.get('code');
    if (auth.res.status !== 303 || code === null) throw new Error(`authorize failed: ${auth.params}`);
    if (auth.params.get('state') !== par.state) throw new Error('authorize returned another state');
    const res = await this.exchange(code, par.verifier);
    const body = (await res.json()) as TokenSet & { error?: string };
    if (res.status !== 200) throw new Error(`token request failed: ${JSON.stringify(body)}`);
    return body;
  }

  /** A DPoP-bound resource request (e.g. a PDS write), retried once on use_dpop_nonce. */
  resource(
    url: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
    accessToken: string,
  ) {
    const method = init.method ?? 'GET';
    return this.withDpop(
      method,
      url,
      (proof) =>
        new Request(url, {
          method,
          headers: { ...init.headers, authorization: `DPoP ${accessToken}`, dpop: proof },
          body: init.body,
        }),
      { accessToken },
    );
  }
}
