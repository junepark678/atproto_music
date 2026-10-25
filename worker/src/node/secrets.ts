// Node host secrets (ADR 0005 §3.8, §5.4, §14.2; N1-07).
//
// One JSON document, read from `$CREDENTIALS_DIRECTORY/secrets` (systemd
// `LoadCredentialEncrypted=` or `LoadCredential=`), or for development and
// tests from `ATMUSIC_SECRETS_FILE`, which is refused unless it is a regular
// file owned by this user with mode 0600 or stricter. Setting both is refused,
// so a stray development variable can never shadow the production credential.
//
//   { "cursorKey": "<base64, >= 32 bytes>",
//     "encryptionKeys": [{"id": "e1", "key": "<base64, 32 bytes>"}],
//     "oauthSigningKeys": [{"kty":"EC","crv":"P-256","kid":"k1","d":…,"x":…,"y":…}],
//     "oauthAnnouncedKeys": [{"kty":"EC","crv":"P-256","kid":"k2","x":…,"y":…}],
//     "lastfm": {"apiKey": "…", "sharedSecret": "…"} }
//
// `oauthAnnouncedKeys` and `lastfm` are optional. Unknown members are refused
// (a typo must not silently drop a key).
//
// Rules: secrets never go into process.env; a ConfigError names the field and
// never contains a value (nor a JSON.parse message, which quotes the input);
// the returned object serialises (JSON.stringify, util.inspect) with every
// secret byte redacted.

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { ConfigError, type ConfigIssue } from '../config';
import type { NodeEnv } from './config';

export const SECRETS_CREDENTIAL_NAME = 'secrets';
export const MIN_CURSOR_KEY_BYTES = 32;
export const ENCRYPTION_KEY_BYTES = 32;
/** A secrets document is a few KiB; anything larger is not one. */
export const MAX_SECRETS_FILE_BYTES = 1 << 20;

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const LASTFM_VALUE = /^[\x21-\x7e]{1,128}$/;
const TOP_LEVEL = new Set(['cursorKey', 'encryptionKeys', 'oauthSigningKeys', 'oauthAnnouncedKeys', 'lastfm']);
/** JWK members that only a private key carries (RFC 7518 §6.2.2, §6.3.2, §6.4). */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export interface EncryptionKey {
  id: string;
  key: Uint8Array;
}

/** A private ES256 JWK: P-256 with d, x and y (base64url, 32 bytes each). */
export interface PrivateEs256Jwk {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  alg: 'ES256';
  d: string;
  x: string;
  y: string;
}

/** The public half of an ES256 JWK. */
export interface PublicEs256Jwk {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  alg: 'ES256';
  x: string;
  y: string;
}

export interface LastfmSecrets {
  apiKey: string;
  sharedSecret: string;
}

export interface Secrets {
  readonly cursorKey: Uint8Array;
  /** encryptionKeys[0] seals; every entry may open. */
  readonly encryptionKeys: readonly EncryptionKey[];
  /** New sessions bind to oauthSigningKeys[0]. */
  readonly oauthSigningKeys: readonly PrivateEs256Jwk[];
  /** Public keys announced in jwks.json before use (§5.4). */
  readonly oauthAnnouncedKeys: readonly PublicEs256Jwk[];
  /** Null without the owner's Last.fm pair: Last.fm linking, forwarding and API import are off. */
  readonly lastfm: LastfmSecrets | null;
}

/** Strict standard base64 (padding required), decoded; null when malformed. */
function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  return new Uint8Array(bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicJwkOf(key: KeyObject): { x?: unknown; y?: unknown } {
  return createPublicKey(key).export({ format: 'jwk' }) as { x?: unknown; y?: unknown };
}

/** Validate the parsed document. Throws a ConfigError naming every bad field. */
export function parseSecrets(doc: unknown): Secrets {
  const issues: ConfigIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });
  if (!isObject(doc)) throw new ConfigError([{ field: 'secrets', message: 'must be a JSON object' }]);
  for (const name of Object.keys(doc)) {
    if (!TOP_LEVEL.has(name)) issue('secrets', `has an unknown member (allowed: ${[...TOP_LEVEL].join(', ')})`);
  }

  // cursorKey
  const cursorKey = decodeBase64(doc.cursorKey);
  if (cursorKey === null || cursorKey.length < MIN_CURSOR_KEY_BYTES) {
    issue('cursorKey', `must be standard base64 of at least ${MIN_CURSOR_KEY_BYTES} bytes`);
  } else if (cursorKey.every((b) => b === 0)) {
    issue('cursorKey', 'must not be all zero');
  }

  // encryptionKeys
  const encryptionKeys: EncryptionKey[] = [];
  if (!Array.isArray(doc.encryptionKeys) || doc.encryptionKeys.length === 0) {
    issue('encryptionKeys', 'must be a non-empty array of {id, key}');
  } else {
    doc.encryptionKeys.forEach((entry: unknown, i: number) => {
      if (!isObject(entry) || Object.keys(entry).some((k) => k !== 'id' && k !== 'key')) {
        issue('encryptionKeys', `entry ${i} must be an object with exactly id and key`);
        return;
      }
      if (typeof entry.id !== 'string' || !KEY_ID.test(entry.id)) {
        issue('encryptionKeys', `entry ${i} id must be 1-32 characters of [A-Za-z0-9_-]`);
        return;
      }
      const key = decodeBase64(entry.key);
      if (key === null || key.length !== ENCRYPTION_KEY_BYTES) {
        issue('encryptionKeys', `entry ${i} key must be standard base64 of exactly ${ENCRYPTION_KEY_BYTES} bytes`);
        return;
      }
      if (encryptionKeys.some((k) => k.id === entry.id)) {
        issue('encryptionKeys', `entry ${i} repeats the id of an earlier entry; ids must be unique`);
        return;
      }
      encryptionKeys.push({ id: entry.id, key });
    });
  }

  // oauthSigningKeys: private ES256 JWKs, unique kids, d consistent with x/y.
  const oauthSigningKeys: PrivateEs256Jwk[] = [];
  if (!Array.isArray(doc.oauthSigningKeys) || doc.oauthSigningKeys.length === 0) {
    issue('oauthSigningKeys', 'must be a non-empty array of private ES256 JWKs');
  } else {
    doc.oauthSigningKeys.forEach((jwk: unknown, i: number) => {
      const where = `entry ${i}`;
      if (!isEs256Shape(jwk)) {
        issue('oauthSigningKeys', `${where} must be an EC P-256 JWK with kid, x and y`);
        return;
      }
      if (jwk.alg !== undefined && jwk.alg !== 'ES256') {
        issue('oauthSigningKeys', `${where} alg must be ES256`);
        return;
      }
      if (jwk.use !== undefined && jwk.use !== 'sig') {
        issue('oauthSigningKeys', `${where} use must be sig`);
        return;
      }
      if (typeof jwk.d !== 'string' || !B64URL_32.test(jwk.d)) {
        issue(
          'oauthSigningKeys',
          `${where} must be a private key (d, base64url of 32 bytes); a public-only key cannot sign`,
        );
        return;
      }
      let derived: { x?: unknown; y?: unknown };
      try {
        derived = publicJwkOf(
          createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, format: 'jwk' }),
        );
      } catch {
        issue('oauthSigningKeys', `${where} is not a valid P-256 private key`);
        return;
      }
      if (derived.x !== jwk.x || derived.y !== jwk.y) {
        issue('oauthSigningKeys', `${where} x and y do not match its private key d`);
        return;
      }
      if (oauthSigningKeys.some((k) => k.kid === jwk.kid)) {
        issue('oauthSigningKeys', `${where} repeats the kid of an earlier key; kids must be unique`);
        return;
      }
      oauthSigningKeys.push({ kty: 'EC', crv: 'P-256', kid: jwk.kid, alg: 'ES256', d: jwk.d, x: jwk.x, y: jwk.y });
    });
  }

  // oauthAnnouncedKeys: public keys only.
  const oauthAnnouncedKeys: PublicEs256Jwk[] = [];
  if (doc.oauthAnnouncedKeys !== undefined) {
    if (!Array.isArray(doc.oauthAnnouncedKeys)) {
      issue('oauthAnnouncedKeys', 'must be an array of public ES256 JWKs');
    } else {
      doc.oauthAnnouncedKeys.forEach((jwk: unknown, i: number) => {
        const where = `entry ${i}`;
        if (!isEs256Shape(jwk)) {
          issue('oauthAnnouncedKeys', `${where} must be an EC P-256 JWK with kid, x and y`);
          return;
        }
        if (PRIVATE_JWK_MEMBERS.some((m) => m in jwk)) {
          issue('oauthAnnouncedKeys', `${where} holds private key material; announced keys must be public only`);
          return;
        }
        if (jwk.alg !== undefined && jwk.alg !== 'ES256') {
          issue('oauthAnnouncedKeys', `${where} alg must be ES256`);
          return;
        }
        if (jwk.use !== undefined && jwk.use !== 'sig') {
          issue('oauthAnnouncedKeys', `${where} use must be sig`);
          return;
        }
        try {
          createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
        } catch {
          issue('oauthAnnouncedKeys', `${where} is not a valid P-256 public key`);
          return;
        }
        if (oauthAnnouncedKeys.some((k) => k.kid === jwk.kid)) {
          issue('oauthAnnouncedKeys', `${where} repeats the kid of an earlier key; kids must be unique`);
          return;
        }
        // During rotation step 3 (§5.4) a key may be both announced and in the
        // keyset; the same kid must then be the same key.
        const signing = oauthSigningKeys.find((k) => k.kid === jwk.kid);
        if (signing !== undefined && (signing.x !== jwk.x || signing.y !== jwk.y)) {
          issue('oauthAnnouncedKeys', `${where} reuses the kid of a different signing key`);
          return;
        }
        oauthAnnouncedKeys.push({ kty: 'EC', crv: 'P-256', kid: jwk.kid, alg: 'ES256', x: jwk.x, y: jwk.y });
      });
    }
  }

  // lastfm (optional)
  let lastfm: LastfmSecrets | null = null;
  if (doc.lastfm !== undefined) {
    const block = doc.lastfm;
    if (
      !isObject(block) ||
      Object.keys(block).some((k) => k !== 'apiKey' && k !== 'sharedSecret') ||
      typeof block.apiKey !== 'string' ||
      typeof block.sharedSecret !== 'string' ||
      !LASTFM_VALUE.test(block.apiKey) ||
      !LASTFM_VALUE.test(block.sharedSecret)
    ) {
      issue('lastfm', 'must be {apiKey, sharedSecret}, each 1-128 printable non-space characters');
    } else {
      lastfm = { apiKey: block.apiKey, sharedSecret: block.sharedSecret };
    }
  }

  if (issues.length > 0 || cursorKey === null) throw new ConfigError(issues);
  return redacted({ cursorKey, encryptionKeys, oauthSigningKeys, oauthAnnouncedKeys, lastfm });
}

interface Es256Shape {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  x: string;
  y: string;
  d?: unknown;
  alg?: unknown;
  use?: unknown;
  [member: string]: unknown;
}

function isEs256Shape(jwk: unknown): jwk is Es256Shape {
  return (
    isObject(jwk) &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.kid === 'string' &&
    KID.test(jwk.kid) &&
    typeof jwk.x === 'string' &&
    B64URL_32.test(jwk.x) &&
    typeof jwk.y === 'string' &&
    B64URL_32.test(jwk.y)
  );
}

/** What JSON.stringify and util.inspect show instead of the secrets: ids and kids only. */
function summary(s: Secrets): Record<string, unknown> {
  return {
    cursorKey: '[redacted]',
    encryptionKeys: s.encryptionKeys.map((k) => ({ id: k.id, key: '[redacted]' })),
    oauthSigningKeys: s.oauthSigningKeys.map((k) => ({ kid: k.kid, d: '[redacted]' })),
    oauthAnnouncedKeys: s.oauthAnnouncedKeys.map((k) => ({ kid: k.kid })),
    lastfm: s.lastfm === null ? null : '[redacted]',
  };
}

function redacted(s: Secrets): Secrets {
  const out = { ...s };
  Object.defineProperty(out, 'toJSON', { value: () => summary(s), enumerable: false });
  Object.defineProperty(out, inspect.custom, { value: () => summary(s), enumerable: false });
  return Object.freeze(out);
}

export interface LoadSecretsDeps {
  /** The calling process's uid; a secrets file owned by another user is refused. */
  uid?: number;
}

/**
 * Read and validate the secrets document named by the environment. Never
 * copies anything into `env` or process.env.
 */
export function loadSecrets(env: NodeEnv, deps: LoadSecretsDeps = {}): Secrets {
  const credDir = env.CREDENTIALS_DIRECTORY;
  const devFile = env.ATMUSIC_SECRETS_FILE;
  if (credDir !== undefined && credDir !== '' && devFile !== undefined) {
    throw new ConfigError([
      {
        field: 'ATMUSIC_SECRETS_FILE',
        message: 'must not be set when systemd provides CREDENTIALS_DIRECTORY (the credential is authoritative)',
      },
    ]);
  }
  let text: string;
  if (credDir !== undefined && credDir !== '') {
    text = readSecretsFile(join(credDir, SECRETS_CREDENTIAL_NAME), 'CREDENTIALS_DIRECTORY', null);
  } else if (devFile !== undefined && devFile !== '') {
    text = readSecretsFile(devFile, 'ATMUSIC_SECRETS_FILE', deps.uid ?? process.getuid?.() ?? null);
  } else {
    throw new ConfigError([
      {
        field: 'CREDENTIALS_DIRECTORY',
        message: 'no secrets: load the "secrets" credential in the unit, or set ATMUSIC_SECRETS_FILE (0600)',
      },
    ]);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // The SyntaxError quotes the input, so it is never passed on.
    throw new ConfigError([{ field: 'secrets', message: 'is not valid JSON' }]);
  }
  return parseSecrets(doc);
}

/**
 * Open without following a symlink, then check the opened file itself (no
 * stat-then-open race). `ownerUid` non-null enforces the 0600 rule.
 */
function readSecretsFile(path: string, field: string, ownerUid: number | null): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (ownerUid !== null ? constants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    throw new ConfigError([{ field, message: `secrets file cannot be opened (${code})` }]);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError([{ field, message: 'secrets file is not a regular file' }]);
    if (ownerUid !== null) {
      if ((st.mode & 0o777 & ~0o600) !== 0) {
        throw new ConfigError([
          { field, message: `secrets file mode is 0${(st.mode & 0o777).toString(8)}; must be 0600 or stricter` },
        ]);
      }
      if (st.uid !== ownerUid) throw new ConfigError([{ field, message: 'secrets file is owned by another user' }]);
    }
    if (st.size > MAX_SECRETS_FILE_BYTES) throw new ConfigError([{ field, message: 'secrets file is too large' }]);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
