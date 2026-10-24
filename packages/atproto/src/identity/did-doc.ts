// DID documents: fetch, validate and extract the atproto identity fields
// (https://atproto.com/specs/did; ADR 0004 §5.6, §8; W2-02).
//
// The document is fetched with SafeFetch (kind `didDoc`): the production URL
// policy, the DoH pre-check, `redirect: 'manual'` with every 3xx refused, the
// 10 s deadline and the 64 KiB body cap (ADR §8). The body is then parsed and
// shape-checked exactly as the Rust oracle's serde `DidDocument`
// (crates/atproto/src/identity.rs): only the fields atproto reads are looked
// at, and everything else (`@context`, unknown properties, the content of
// unrelated entries) is ignored, so a document DID Core or a foreign method
// family considers odd still yields its `#atproto` key and `#atproto_pds`.
// A definite structural failure is `invalid_did_document`:
//
// - the body is not UTF-8 JSON, or not an object;
// - `id` is not a string;
// - `alsoKnownAs`, `service`, `verificationMethod`, when present, are not
//   arrays (absent means empty; `null` is malformed, as with serde);
// - an `alsoKnownAs` entry is not a string;
// - a `service` entry is not an object with string `id` and `type` and some
//   `serviceEndpoint` value (any JSON; only `#atproto_pds`'s is interpreted);
// - a `verificationMethod` entry is not an object with string `id`,
//   `controller` and `type`; `publicKeyMultibase` is optional (string or null)
//   and is decoded only for an `#atproto` candidate.
//
// Extraction follows the oracle (identity.rs, sync/current_head.rs
// `signing_key` / `parse_key`; ADR 0003 "Key extraction"):
//
// - `id` must equal the requested DID (`did_mismatch`);
// - signing key: the FIRST VALID verification method whose id is `#atproto`
//   (or `<did>#atproto`) and whose controller is the DID, as a canonical
//   compressed did:key. `publicKeyMultibase` must be base58btc (`z…`) and at
//   most 128 characters. Valid means one of:
//   - a `Multikey` whose value is the canonical multikey of a 33-byte
//     compressed secp256k1 or P-256 point that lies on its curve;
//   - a legacy fragment-only 2019 suite (`EcdsaSecp256k1VerificationKey2019`
//     or `EcdsaSecp256r1VerificationKey2019`, id exactly `#atproto`, never
//     `<did>#atproto`) whose value is a raw 65-byte uncompressed SEC1 point
//     (0x04 ‖ X ‖ Y) on that suite's curve; it is compressed and re-encoded
//     as the canonical multikey.
//   Later keys are never signature fallbacks; an invalid one is simply
//   skipped. None → `no_signing_key`;
// - PDS: the first service whose id is `#atproto_pds` (or `<did>#atproto_pds`)
//   and whose type is `AtprotoPersonalDataServer`. Its endpoint must be a
//   string, pass `checkUrl`, and be a bare origin (path `/`, no query, no
//   explicit `:443`). Otherwise `invalid_pds`; the PDS is never contacted;
// - handle candidate: the first `at://` alias that is a syntactically valid
//   handle, lowercased. It is only a claim; handle.ts verifies it.

import { getPublicKeyFromDidController, parsePublicMultikey } from '@atcute/crypto';
import { isDidPlc, isHandle, MAX_DID_LENGTH, MAX_HANDLE_LENGTH } from '@atmusic/core/syntax';
import { isSafeFetchError, type SafeFetch } from '../net/safe-fetch';
import { checkUrl } from '../net/url-policy';

/** A verification method, as far as atproto reads it. */
export interface VerificationMethod {
  id: string;
  controller: string;
  type: string;
  publicKeyMultibase?: string | null;
}

/** A service entry; `serviceEndpoint` is any JSON value. */
export interface DidService {
  id: string;
  type: string;
  serviceEndpoint: unknown;
}

/**
 * The atproto view of a DID document (the oracle's serde struct). The parsed
 * object keeps every other property, so `json` round-trips the document.
 */
export interface DidDocument {
  id: string;
  alsoKnownAs?: string[];
  service?: DidService[];
  verificationMethod?: VerificationMethod[];
}

export const PLC_DIRECTORY = 'https://plc.directory';

export const IDENTITY_ERROR_CODES = [
  'invalid_did', // not a did:plc / hostname-level did:web DID
  'invalid_handle', // not a syntactically valid handle, or under a reserved TLD
  'did_not_found', // the document host answered 404 / 410 (tombstoned)
  'invalid_did_document', // not JSON, or the atproto fields are malformed
  'did_mismatch', // document `id` differs from the requested DID
  'no_signing_key', // no valid `#atproto` verification method (Multikey or legacy 2019 suite)
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An optional array property: absent → [], present → every entry passes `ok`. */
function optionalArray(doc: Record<string, unknown>, key: string, ok: (entry: unknown) => boolean): boolean {
  if (!Object.hasOwn(doc, key)) return true;
  const value = doc[key];
  return Array.isArray(value) && value.every(ok);
}

function isVerificationMethod(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const key = entry.publicKeyMultibase;
  return (
    typeof entry.id === 'string' &&
    typeof entry.controller === 'string' &&
    typeof entry.type === 'string' &&
    (key === undefined || key === null || typeof key === 'string')
  );
}

function isService(entry: unknown): boolean {
  return (
    isObject(entry) &&
    typeof entry.id === 'string' &&
    typeof entry.type === 'string' &&
    Object.hasOwn(entry, 'serviceEndpoint')
  );
}

/** Parse a document body with the oracle's shape rules; null when malformed. */
export function parseDidDocument(body: Uint8Array): DidDocument | null {
  let value: unknown;
  try {
    // fatal: invalid UTF-8 is malformed; ignoreBOM keeps a BOM, which JSON rejects.
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.id !== 'string') return null;
  if (!optionalArray(value, 'alsoKnownAs', (alias) => typeof alias === 'string')) return null;
  if (!optionalArray(value, 'service', isService)) return null;
  if (!optionalArray(value, 'verificationMethod', isVerificationMethod)) return null;
  return value as unknown as DidDocument;
}

export interface DidDocumentFetcher {
  /** Fetch and validate the document; `id` is checked against `did`. */
  fetch(did: string): Promise<{ doc: DidDocument; json: string }>;
}

export function createDidDocumentFetcher(safeFetch: SafeFetch): DidDocumentFetcher {
  return {
    async fetch(did) {
      const url = didDocumentUrl(did); // syntax gate before any request
      let body: Uint8Array;
      try {
        // Only 2xx returns (SafeFetch throws on 3xx, non-2xx and an oversized body).
        body = (await safeFetch(url, { kind: 'didDoc' })).body;
      } catch (error) {
        if (isSafeFetchError(error) && error.code === 'http_status' && (error.status === 404 || error.status === 410)) {
          throw new IdentityError('did_not_found', `DID document not found (HTTP ${error.status}): ${did}`, {
            cause: error,
          });
        }
        throw error; // transport-level: the caller decides whether to retry
      }
      const doc = parseDidDocument(body);
      if (doc === null) throw new IdentityError('invalid_did_document', `invalid DID document for ${did}`);
      if (doc.id !== did) {
        throw new IdentityError('did_mismatch', `DID document id ${doc.id} does not match ${did}`);
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

type Curve = 'secp256k1' | 'p256';

/** Multicodec varint prefixes of the two public key types. */
const MULTICODEC: Readonly<Record<Curve, readonly [number, number]>> = {
  secp256k1: [0xe7, 0x01],
  p256: [0x80, 0x24],
};

/** The documented legacy fragment-only suites and the curve each names. */
const LEGACY_SUITES: Readonly<Record<string, Curve>> = {
  EcdsaSecp256k1VerificationKey2019: 'secp256k1',
  EcdsaSecp256r1VerificationKey2019: 'p256',
};

function fieldPrime(curve: Curve): bigint {
  return curve === 'secp256k1' ? SECP256K1_P : P256_P;
}

/** x³ + ax + b mod p (secp256k1: a = 0, b = 7; P-256: a = −3). */
function curveRhs(curve: Curve, x: bigint): bigint {
  const p = fieldPrime(curve);
  const x3 = (x * x * x) % p;
  return curve === 'secp256k1' ? (x3 + 7n) % p : (((x3 - 3n * x + P256_B) % p) + p) % p;
}

function bigintOf(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** True when the compressed point's x has a y on the curve (Euler's criterion). */
function compressedPointOnCurve(curve: Curve, point: Uint8Array): boolean {
  if (point.length !== 33 || (point[0] !== 2 && point[0] !== 3)) return false;
  const x = bigintOf(point.subarray(1));
  const p = fieldPrime(curve);
  if (x >= p) return false;
  const rhs = curveRhs(curve, x);
  // Both curves have prime order, so no point has y = 0; rhs must be a nonzero square.
  return rhs !== 0n && modPow(rhs, (p - 1n) / 2n, p) === 1n;
}

/** The 33-byte compressed form of an on-curve 65-byte SEC1 point, else null. */
function compressUncompressedPoint(curve: Curve, point: Uint8Array): Uint8Array | null {
  if (point.length !== 65 || point[0] !== 4) return null;
  const p = fieldPrime(curve);
  const x = bigintOf(point.subarray(1, 33));
  const y = bigintOf(point.subarray(33));
  if (x >= p || y >= p || (y * y) % p !== curveRhs(curve, x)) return null;
  const out = new Uint8Array(33);
  out[0] = (point[64] as number) & 1 ? 3 : 2;
  out.set(point.subarray(1, 33), 1);
  return out;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Multibase base58btc (`z…`) of `bytes`. */
function base58btc(bytes: Uint8Array): string {
  let n = bigintOf(bytes);
  let out = '';
  while (n > 0n) {
    out = (BASE58_ALPHABET[Number(n % 58n)] as string) + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return `z${out}`;
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

/**
 * A legacy 2019-suite key (the oracle's `parse_key` legacy arms) as the
 * canonical compressed `did:key:z…`, else null. Only the fragment-only id
 * `#atproto` is admitted, and the value must be a raw 65-byte uncompressed
 * SEC1 point (0x04 ‖ X ‖ Y) on the suite's curve.
 */
export function validLegacyKey(method: Pick<VerificationMethod, 'id' | 'type' | 'publicKeyMultibase'>): string | null {
  const curve = Object.hasOwn(LEGACY_SUITES, method.type) ? LEGACY_SUITES[method.type] : undefined;
  const multibase = method.publicKeyMultibase;
  if (curve === undefined || method.id !== '#atproto') return null;
  if (typeof multibase !== 'string' || multibase.length > MAX_MULTIKEY_CHARS) return null;
  let raw: Uint8Array;
  try {
    // Requires the `z` (base58btc) multibase prefix, as the oracle does.
    raw = getPublicKeyFromDidController({ type: method.type, publicKeyMultibase: multibase }).publicKeyBytes;
  } catch {
    return null;
  }
  const compressed = compressUncompressedPoint(curve, raw);
  if (compressed === null) return null;
  const multikey = new Uint8Array(35);
  multikey.set(MULTICODEC[curve]);
  multikey.set(compressed, 2);
  // Re-validate the canonical form through the Multikey path.
  return validMultikey(base58btc(multikey));
}

/** The first valid `#atproto` key (Multikey or legacy 2019 suite) as a did:key, or null. */
export function atprotoSigningKey(doc: DidDocument): string | null {
  for (const method of doc.verificationMethod ?? []) {
    if (method.controller !== doc.id || !isFragmentRef(method.id, doc.id, 'atproto')) continue;
    const key = method.type === 'Multikey' ? validMultikey(method.publicKeyMultibase) : validLegacyKey(method);
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
