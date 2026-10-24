// DID documents: fetch, validate and extract the atproto identity fields
// (https://atproto.com/specs/did; ADR 0004 §5.6, §8; W2-02).
//
// Fetching uses @atcute/identity-resolver's PLC and atproto did:web document
// resolvers, whose `fetch` is injectable: we hand them an adapter over
// SafeFetch, so every document request runs the production URL policy, the
// DoH pre-check, `redirect: 'manual'` with every 3xx refused, the 10 s
// deadline and the 64 KiB `didDoc` body cap. @atcute then checks the
// content-type, applies its own (smaller, 20 KiB) size bound and validates the
// document shape. Extraction follows the Rust oracle exactly
// (crates/atproto/src/identity.rs, crates/atproto/src/sync/current_head.rs):
//
// - `id` must equal the requested DID (`did_mismatch`);
// - signing key: the FIRST VALID verification method whose id is `#atproto`
//   (or `<did>#atproto`) and whose controller is the DID. Valid means a
//   `Multikey` whose `publicKeyMultibase` is a canonical base58btc multikey of
//   at most 128 characters, encoding a 33-byte compressed secp256k1 or P-256
//   point that lies on its curve. Later keys are never signature fallbacks;
//   an invalid one is simply skipped. None → `no_signing_key`;
// - PDS: the first service whose id is `#atproto_pds` (or `<did>#atproto_pds`)
//   and whose type is `AtprotoPersonalDataServer`. Its endpoint must be a
//   string, pass `checkUrl`, and be a bare origin (path `/`, no query, no
//   explicit `:443`). Otherwise `invalid_pds`; the PDS is never contacted;
// - handle candidate: the first `at://` alias that is a syntactically valid
//   handle, lowercased. It is only a claim; handle.ts verifies it.

import { parsePublicMultikey } from '@atcute/crypto';
import type { DidDocument } from '@atcute/identity';
import {
  AtprotoWebDidDocumentResolver,
  type DidDocumentResolver,
  PlcDidDocumentResolver,
} from '@atcute/identity-resolver';
import { isDidPlc, isHandle, MAX_DID_LENGTH, MAX_HANDLE_LENGTH } from '@atmusic/core/syntax';
import { isSafeFetchError, type SafeFetch } from '../net/safe-fetch';
import { checkUrl } from '../net/url-policy';

export type { DidDocument } from '@atcute/identity';

export const PLC_DIRECTORY = 'https://plc.directory';

export const IDENTITY_ERROR_CODES = [
  'invalid_did', // not a did:plc / hostname-level did:web DID
  'invalid_handle', // not a syntactically valid handle
  'did_not_found', // the document host answered 404 / 410 (tombstoned)
  'invalid_did_document', // wrong content-type, oversized for @atcute, or malformed shape
  'did_mismatch', // document `id` differs from the requested DID
  'no_signing_key', // no valid `#atproto` Multikey verification method
  'invalid_pds', // missing `#atproto_pds` service, or its endpoint fails the URL policy
  'handle_not_found', // neither DoH TXT nor /.well-known/atproto-did names a DID
  'ambiguous_handle', // DoH TXT names more than one distinct DID
  'invalid_handle_response', // /.well-known/atproto-did is not text/plain or not a DID
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

/**
 * A definite identity failure. Transport-level failures (timeout, 429/5xx,
 * blocked destination, oversized body) are NOT wrapped: they propagate as the
 * original `SafeFetchError`, so callers can tell "retry later" from "this
 * identity is invalid".
 */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? code, options);
    this.name = 'IdentityError';
  }
}

export function isIdentityError(value: unknown, code?: IdentityErrorCode): value is IdentityError {
  return value instanceof IdentityError && (code === undefined || value.code === code);
}

/**
 * The DIDs this AppView resolves, exactly as the oracle's `validate_did`:
 * did:plc (24 base32 chars) or hostname-level did:web (no path, no port).
 */
export function isResolvableDid(did: string): boolean {
  if (typeof did !== 'string' || did.length > MAX_DID_LENGTH) return false;
  if (did.startsWith('did:plc:')) return isDidPlc(did);
  if (did.startsWith('did:web:')) return isHandle(did.slice('did:web:'.length));
  return false;
}

/** Where the document lives: plc.directory, or https://<host>/.well-known/did.json. */
export function didDocumentUrl(did: string): string {
  if (!isResolvableDid(did)) throw new IdentityError('invalid_did', `unsupported or invalid DID: ${did}`);
  if (did.startsWith('did:web:')) return `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  return `${PLC_DIRECTORY}/${did}`;
}

/** A `fetch` for @atcute resolvers that goes through SafeFetch (kind `didDoc`). */
function safeDocFetch(safeFetch: SafeFetch): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    // @atcute percent-encodes the DID's colons (`/did%3Aplc%3A…`); request the
    // canonical `https://plc.directory/<did>` form the oracle and spec use.
    // A did:plc path holds only [a-z2-7:], so decoding it is lossless.
    if (/^\/did%3Aplc%3A[a-z2-7]{24}$/i.test(url.pathname)) url.pathname = decodeURIComponent(url.pathname);
    const res = await safeFetch(url, { kind: 'didDoc' });
    // Only 2xx reaches here (SafeFetch throws on 3xx and non-2xx).
    return new Response(res.body.byteLength === 0 ? null : (res.body as Uint8Array<ArrayBuffer>), {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof fetch;
}

export interface DidDocumentFetcher {
  /** Fetch and validate the document; `id` is checked against `did`. */
  fetch(did: string): Promise<{ doc: DidDocument; json: string }>;
}

export function createDidDocumentFetcher(safeFetch: SafeFetch): DidDocumentFetcher {
  const fetchFn = safeDocFetch(safeFetch);
  const plc: DidDocumentResolver<'plc'> = new PlcDidDocumentResolver({ apiUrl: PLC_DIRECTORY, fetch: fetchFn });
  const web: DidDocumentResolver<'web'> = new AtprotoWebDidDocumentResolver({ fetch: fetchFn });

  return {
    async fetch(did) {
      didDocumentUrl(did); // syntax gate before any request
      let doc: DidDocument;
      try {
        doc = did.startsWith('did:plc:')
          ? await plc.resolve(did as `did:plc:${string}`)
          : await web.resolve(did as `did:web:${string}`);
      } catch (error) {
        const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
        if (isSafeFetchError(cause)) {
          if (cause.code === 'http_status' && (cause.status === 404 || cause.status === 410)) {
            throw new IdentityError('did_not_found', `DID document not found (HTTP ${cause.status}): ${did}`, {
              cause,
            });
          }
          throw cause; // transport-level: the caller decides whether to retry
        }
        throw new IdentityError('invalid_did_document', `invalid DID document for ${did}`, { cause: error });
      }
      if (doc.id !== did) {
        throw new IdentityError('did_mismatch', `DID document id ${String(doc.id)} does not match ${did}`);
      }
      return { doc, json: JSON.stringify(doc) };
    },
  };
}

// ---------------------------------------------------------------------------
// Signing key

/** Oracle bound: base58 decoding is not constant-time in input length. */
const MAX_MULTIKEY_CHARS = 128;

const SECP256K1_P = 2n ** 256n - 2n ** 32n - 977n;
const P256_P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** True when the compressed point's x has a y on the curve (Euler's criterion). */
function compressedPointOnCurve(curve: 'secp256k1' | 'p256', point: Uint8Array): boolean {
  if (point.length !== 33 || (point[0] !== 2 && point[0] !== 3)) return false;
  let x = 0n;
  for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(point[i] as number);
  const p = curve === 'secp256k1' ? SECP256K1_P : P256_P;
  if (x >= p) return false;
  const x3 = (x * x * x) % p;
  const rhs = curve === 'secp256k1' ? (x3 + 7n) % p : (((x3 - 3n * x + P256_B) % p) + p) % p;
  // Both curves have prime order, so no point has y = 0; rhs must be a nonzero square.
  return rhs !== 0n && modPow(rhs, (p - 1n) / 2n, p) === 1n;
}

/** `did:key:z…` for a valid public multikey, else null. */
export function validMultikey(multibase: unknown): string | null {
  if (typeof multibase !== 'string' || multibase.length > MAX_MULTIKEY_CHARS) return null;
  let found: ReturnType<typeof parsePublicMultikey>;
  try {
    found = parsePublicMultikey(multibase);
  } catch {
    return null;
  }
  // A leading '1' would decode to a 0x00 byte and an unknown multicodec, so a
  // key that parses here is already the canonical base58btc encoding.
  if (!compressedPointOnCurve(found.type, found.publicKeyBytes)) return null;
  return `did:key:${multibase}`;
}

function isFragmentRef(id: unknown, did: string, fragment: string): boolean {
  return id === `#${fragment}` || id === `${did}#${fragment}`;
}

/** The first valid `#atproto` Multikey as a did:key, or null. */
export function atprotoSigningKey(doc: DidDocument): string | null {
  for (const method of doc.verificationMethod ?? []) {
    if (method.controller !== doc.id || !isFragmentRef(method.id, doc.id, 'atproto')) continue;
    if (method.type !== 'Multikey') continue;
    const key = validMultikey(method.publicKeyMultibase);
    if (key !== null) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PDS endpoint

export interface PdsPolicyOptions {
  /** Fixture transport in use: admits the reserved fixture TLDs, nothing else. */
  fixture?: boolean;
}

/** The `#atproto_pds` endpoint as a bare https origin, or throws `invalid_pds`. */
export function atprotoPds(doc: DidDocument, options: PdsPolicyOptions = {}): string {
  const service = (doc.service ?? []).find(
    (s) => isFragmentRef(s.id, doc.id, 'atproto_pds') && s.type === 'AtprotoPersonalDataServer',
  );
  if (!service) throw new IdentityError('invalid_pds', 'DID document has no #atproto_pds service');
  const endpoint = service.serviceEndpoint;
  if (typeof endpoint !== 'string') throw new IdentityError('invalid_pds', 'PDS endpoint is not a string');
  const check = checkUrl(endpoint, { fixture: options.fixture === true });
  if (!check.ok) throw new IdentityError('invalid_pds', `PDS endpoint refused by URL policy: ${check.reason}`);
  if (check.url.pathname !== '/' || check.url.search !== '') {
    throw new IdentityError('invalid_pds', 'PDS endpoint must be a bare origin');
  }
  // WHATWG URL erases an explicit default port; AT forbids writing it at all.
  const authority = endpoint.slice('https://'.length).split('/')[0] ?? '';
  if (!endpoint.startsWith('https://') || authority.endsWith(':443')) {
    throw new IdentityError('invalid_pds', 'PDS endpoint must not name an explicit port');
  }
  return check.url.origin;
}

// ---------------------------------------------------------------------------
// Handle claim

/** The first `at://` alias that is a valid handle, lowercased; an unverified claim. */
export function claimedHandle(doc: Pick<DidDocument, 'alsoKnownAs'>): string | null {
  for (const alias of doc.alsoKnownAs ?? []) {
    if (typeof alias !== 'string' || !alias.startsWith('at://')) continue;
    const handle = alias.slice('at://'.length);
    if (handle.length <= MAX_HANDLE_LENGTH && isHandle(handle)) return handle.toLowerCase();
  }
  return null;
}

export interface ParsedIdentityDocument {
  signingKey: string;
  pds: string;
  claimedHandle: string | null;
}

/** All three atproto fields, or the first definite failure. */
export function parseIdentityDocument(doc: DidDocument, options: PdsPolicyOptions = {}): ParsedIdentityDocument {
  const signingKey = atprotoSigningKey(doc);
  if (signingKey === null) throw new IdentityError('no_signing_key', `no valid #atproto key for ${doc.id}`);
  return { signingKey, pds: atprotoPds(doc, options), claimedHandle: claimedHandle(doc) };
}
