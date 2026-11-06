// Authenticated encryption of user credentials at rest (ADR 0005 §3.8, §5.5,
// §13; N1-08).
//
// AES-256-GCM under keys derived with HKDF-SHA256 from the operator's
// `encryptionKeys` (secrets.ts, N1-07). Each purpose has its own derived key:
//
// | purpose               | HKDF salt                           | info           | AAD the caller passes        |
// |-----------------------|-------------------------------------|----------------|------------------------------|
// | `oauth-state`         | `atmusic/oauth/encryption/v1`       | `state`        | hex SHA-256 of the state key |
// | `oauth-session`       | `atmusic/oauth/encryption/v1`       | `tokens`       | the DID                      |
// | `linked-lastfm`       | `atmusic/linked/encryption/v1`      | `lastfm`       | `linked/<did>/lastfm`        |
// | `linked-listenbrainz` | `atmusic/linked/encryption/v1`      | `listenbrainz` | `linked/<did>/listenbrainz`  |
// | `lastfm-app`          | `atmusic/credentials/encryption/v1` | `lastfm-app`   | `lastfm-app/<api_key>/<did>` |
//
// The OAuth derivation is byte-compatible with the Rust oracle
// (crates/atproto/src/oauth/token_store.rs:63-68: `Hkdf::<Sha256>::new(Some(salt),
// master)` then `expand(info)` to 32 bytes). The CSRF HMAC key (salt
// `atmusic/csrf/v1`, info `hmac`) comes from the same derivation, but it is a
// MAC key, not a box purpose: `csrfKey()`.
//
// **Format** (ADR §5.5): `keyId ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, where
// keyId is framed as one length byte followed by its UTF-8 bytes. The GCM
// additional data is that framed keyId followed by the caller's AAD bytes, so
// the stored key id is authenticated too and a value copied to another row
// (another AAD) fails to open.
//
// **Rotation:** `seal` always uses `keys[0]`; `open` uses whichever configured
// key the sealed value names (old keys can only decrypt). `reseal` re-encrypts
// a value under `keys[0]`.
//
// Every failure is a typed BoxError whose message never contains key material,
// plaintext or the AAD. The nonce comes from the injected Random: 96 random bits
// per seal, which is within GCM's limits for the volume of a single-user host.

import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import type { Random } from '@atmusic/core/deps';

export type BoxPurpose = 'oauth-state' | 'oauth-session' | 'linked-lastfm' | 'linked-listenbrainz' | 'lastfm-app';

/** HKDF salt and info for every derived key (ADR §3.8). */
export const DERIVATIONS = {
  'oauth-state': { salt: 'atmusic/oauth/encryption/v1', info: 'state' },
  'oauth-session': { salt: 'atmusic/oauth/encryption/v1', info: 'tokens' },
  'linked-lastfm': { salt: 'atmusic/linked/encryption/v1', info: 'lastfm' },
  'linked-listenbrainz': { salt: 'atmusic/linked/encryption/v1', info: 'listenbrainz' },
  'lastfm-app': { salt: 'atmusic/credentials/encryption/v1', info: 'lastfm-app' },
  csrf: { salt: 'atmusic/csrf/v1', info: 'hmac' },
} as const satisfies Record<BoxPurpose | 'csrf', { salt: string; info: string }>;

export const BOX_PURPOSES = Object.freeze([
  'oauth-state',
  'oauth-session',
  'linked-lastfm',
  'linked-listenbrainz',
  'lastfm-app',
] as const satisfies readonly BoxPurpose[]);

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const MASTER_KEY_BYTES = 32;
const MAX_KEY_ID_BYTES = 255;

export type BoxErrorReason =
  /** The key list is empty, has a duplicate id, a bad id or a key that is not 32 bytes. */
  | 'invalid_keys'
  /** The purpose is not one of BOX_PURPOSES. */
  | 'unknown_purpose'
  /** The sealed value is too short or its key-id frame is inconsistent. */
  | 'malformed'
  /** The sealed value names a key id that is not configured. */
  | 'unknown_key'
  /** GCM authentication failed: wrong AAD, wrong purpose, or a modified nonce, ciphertext or tag. */
  | 'authentication';

export class BoxError extends Error {
  constructor(
    readonly reason: BoxErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'BoxError';
  }
}

/** One operator key: `encryptionKeys[i]` of the secrets document, already base64-decoded. */
export interface EncryptionKey {
  id: string;
  key: Uint8Array;
}

export type BoxAad = string | Uint8Array;

export interface Box {
  /** Encrypt under `keys[0]`. */
  seal(purpose: BoxPurpose, plaintext: Uint8Array | string, aad: BoxAad): Uint8Array;
  /** Decrypt with the key the value names. Throws BoxError on any failure. */
  open(purpose: BoxPurpose, sealed: Uint8Array, aad: BoxAad): Uint8Array;
  /** `open` decoded as UTF-8 (fatal on invalid UTF-8, reported as BoxError 'malformed'). */
  openText(purpose: BoxPurpose, sealed: Uint8Array, aad: BoxAad): string;
  /** Open with any configured key and seal again under `keys[0]`. */
  reseal(purpose: BoxPurpose, sealed: Uint8Array, aad: BoxAad): Uint8Array;
  /** The id of the current sealing key, `keys[0].id` (stored in the rows' `key_id` columns). */
  readonly currentKeyId: string;
  /** HMAC key for the CSRF token (ADR §5.6), derived from `keys[0]`. */
  csrfKey(): Uint8Array;
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** HKDF-SHA256(ikm, salt, info) to `length` bytes (RFC 5869). */
export function hkdfSha256(ikm: Uint8Array, salt: string, info: string, length = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, encoder.encode(salt), encoder.encode(info), length));
}

/** The 32-byte AES key of `purpose` (or the CSRF HMAC key) derived from one master key. */
export function deriveKey(master: Uint8Array, purpose: BoxPurpose | 'csrf'): Uint8Array {
  if (!Object.hasOwn(DERIVATIONS, purpose)) throw new BoxError('unknown_purpose', 'unknown box purpose');
  const d = DERIVATIONS[purpose];
  return hkdfSha256(master, d.salt, d.info, 32);
}

function aadBytes(aad: BoxAad): Uint8Array {
  if (typeof aad === 'string') return encoder.encode(aad);
  if (aad instanceof Uint8Array) return aad;
  throw new BoxError('malformed', 'box AAD must be a string or Uint8Array');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function frameKeyId(id: string): Uint8Array {
  const bytes = encoder.encode(id);
  return concat(Uint8Array.of(bytes.length), bytes);
}

interface ParsedBox {
  keyId: string;
  header: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

function parse(sealed: Uint8Array): ParsedBox {
  if (!(sealed instanceof Uint8Array)) throw new BoxError('malformed', 'sealed value must be a Uint8Array');
  const idLength = sealed[0];
  if (idLength === undefined || idLength === 0) throw new BoxError('malformed', 'sealed value has no key id');
  const headerEnd = 1 + idLength;
  if (sealed.length < headerEnd + NONCE_BYTES + TAG_BYTES) {
    throw new BoxError('malformed', 'sealed value is too short');
  }
  let keyId: string;
  try {
    keyId = utf8.decode(sealed.subarray(1, headerEnd));
  } catch {
    throw new BoxError('malformed', 'sealed key id is not UTF-8');
  }
  return {
    keyId,
    header: sealed.subarray(0, headerEnd),
    nonce: sealed.subarray(headerEnd, headerEnd + NONCE_BYTES),
    ciphertext: sealed.subarray(headerEnd + NONCE_BYTES, sealed.length - TAG_BYTES),
    tag: sealed.subarray(sealed.length - TAG_BYTES),
  };
}

/** The key id a sealed value names, without decrypting it (for the `key_id` columns and reseal planning). */
export function sealedKeyId(sealed: Uint8Array): string {
  return parse(sealed).keyId;
}

function checkPurpose(purpose: BoxPurpose): void {
  if (!(BOX_PURPOSES as readonly string[]).includes(purpose)) {
    throw new BoxError('unknown_purpose', 'unknown box purpose');
  }
}

interface KeyEntry {
  id: string;
  header: Uint8Array;
  derived: Map<BoxPurpose | 'csrf', Uint8Array>;
}

/**
 * Build the box over the configured keys. `keys[0]` seals; every key opens.
 * `random` supplies the 12-byte nonces.
 */
export function createBox(keys: readonly EncryptionKey[], random: Random): Box {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new BoxError('invalid_keys', 'at least one encryption key is required');
  }
  const byId = new Map<string, KeyEntry>();
  const ordered: KeyEntry[] = [];
  keys.forEach((k, index) => {
    if (typeof k?.id !== 'string' || k.id.length === 0) {
      throw new BoxError('invalid_keys', `encryption key ${index} has no id`);
    }
    if (encoder.encode(k.id).length > MAX_KEY_ID_BYTES) {
      throw new BoxError('invalid_keys', `encryption key ${index} has an id longer than ${MAX_KEY_ID_BYTES} bytes`);
    }
    if (!(k.key instanceof Uint8Array) || k.key.length !== MASTER_KEY_BYTES) {
      throw new BoxError('invalid_keys', `encryption key ${index} must be exactly ${MASTER_KEY_BYTES} bytes`);
    }
    if (byId.has(k.id)) throw new BoxError('invalid_keys', `encryption key ${index} repeats an earlier id`);
    const derived = new Map<BoxPurpose | 'csrf', Uint8Array>();
    for (const purpose of [...BOX_PURPOSES, 'csrf'] as const) derived.set(purpose, deriveKey(k.key, purpose));
    const entry: KeyEntry = { id: k.id, header: frameKeyId(k.id), derived };
    byId.set(k.id, entry);
    ordered.push(entry);
  });
  const current = ordered[0] as KeyEntry;

  const sealWith = (entry: KeyEntry, purpose: BoxPurpose, plaintext: Uint8Array, aad: Uint8Array): Uint8Array => {
    const nonce = random.bytes(NONCE_BYTES);
    if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) {
      throw new RangeError(`Random.bytes(${NONCE_BYTES}) returned the wrong length`);
    }
    const cipher = createCipheriv('aes-256-gcm', entry.derived.get(purpose) as Uint8Array, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(concat(entry.header, aad));
    const body = concat(cipher.update(plaintext), cipher.final());
    return concat(entry.header, nonce, body, cipher.getAuthTag());
  };

  const open = (purpose: BoxPurpose, sealed: Uint8Array, aad: BoxAad): Uint8Array => {
    checkPurpose(purpose);
    const additional = aadBytes(aad);
    const parsed = parse(sealed);
    const entry = byId.get(parsed.keyId);
    if (entry === undefined) throw new BoxError('unknown_key', 'sealed value names an unconfigured key id');
    try {
      const decipher = createDecipheriv('aes-256-gcm', entry.derived.get(purpose) as Uint8Array, parsed.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(concat(parsed.header, additional));
      decipher.setAuthTag(parsed.tag);
      return concat(decipher.update(parsed.ciphertext), decipher.final());
    } catch {
      throw new BoxError('authentication', 'sealed value failed authentication');
    }
  };

  return {
    currentKeyId: current.id,
    seal(purpose, plaintext, aad) {
      checkPurpose(purpose);
      const bytes = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
      if (!(bytes instanceof Uint8Array)) throw new BoxError('malformed', 'plaintext must be a string or Uint8Array');
      return sealWith(current, purpose, bytes, aadBytes(aad));
    },
    open,
    openText(purpose, sealed, aad) {
      const bytes = open(purpose, sealed, aad);
      try {
        return utf8.decode(bytes);
      } catch {
        throw new BoxError('malformed', 'opened value is not UTF-8');
      }
    },
    reseal(purpose, sealed, aad) {
      const plaintext = open(purpose, sealed, aad);
      return sealWith(current, purpose, plaintext, aadBytes(aad));
    },
    csrfKey() {
      return Uint8Array.from(current.derived.get('csrf') as Uint8Array);
    },
  };
}

// --- AAD helpers: the row each sealed value is bound to (ADR §3.8) ----------

/** AAD of an `oauth_states` value: the row key, hex SHA-256 of the state key. */
export function oauthStateAad(keyHashHex: string): string {
  return keyHashHex;
}

/** AAD of an `oauth_sessions` value: the DID. */
export function oauthSessionAad(did: string): string {
  return did;
}

/** AAD of a `linked_accounts` credential: `linked/<did>/<service>`. */
export function linkedAad(did: string, service: 'lastfm' | 'listenbrainz'): string {
  return `linked/${did}/${service}`;
}

/** AAD of an issued app's shared secret: `lastfm-app/<api_key>/<did>`. */
export function lastfmAppAad(apiKey: string, did: string): string {
  return `lastfm-app/${apiKey}/${did}`;
}

/** The box purpose of a linked account's credential. */
export function linkedPurpose(service: 'lastfm' | 'listenbrainz'): BoxPurpose {
  return service === 'lastfm' ? 'linked-lastfm' : 'linked-listenbrainz';
}
