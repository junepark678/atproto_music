// Fresh secrets for the Node host (ADR 0005 §3.8, §5.4, §14.2; N1-07).
//
// Usage:
//   node scripts/admin/gen-secrets.ts [--out FILE]
//   node scripts/admin/gen-secrets.ts --oauth-key <kid> [--out FILE]
//   (npx tsx scripts/admin/gen-secrets.ts … works too)
//
// Without --oauth-key it prints a complete secrets document for
// worker/src/node/secrets.ts: a 32-byte cursorKey, one 32-byte encryption key
// (id e1) and one private ES256 OAuth signing key (kid k1). The owner adds the
// optional "lastfm": {"apiKey", "sharedSecret"} pair by hand, then encrypts the
// file with `systemd-creds --user encrypt --name=secrets` (§14.2).
//
// With --oauth-key <kid> it prints one new key for the rotation runbook (§5.4):
// {"oauthSigningKey": <private JWK>, "oauthAnnouncedKey": <its public JWK>}.
// The public half goes into oauthAnnouncedKeys first; the private one joins
// oauthSigningKeys after the announcement has been served for 10 minutes.
//
// Output: stdout, or --out FILE, which is created with mode 0600 and never
// overwritten. When stdout is redirected to a regular file it is chmodded to
// 0600 before anything is written (the shell created it with the umask).
//
// Randomness is local only (node:crypto randomBytes); nothing is fetched.
// The file runs under Node's own type stripping: node built-ins only, no
// imports from the workspace.
//
// Exit status: 0 written, 1 the output could not be written, 2 usage error.

import { createECDH, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type RandomBytes = (n: number) => Uint8Array;

export interface PrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  alg: 'ES256';
  d: string;
  x: string;
  y: string;
}

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  kid: string;
  alg: 'ES256';
  x: string;
  y: string;
}

export interface SecretsDocument {
  cursorKey: string;
  encryptionKeys: { id: string; key: string }[];
  oauthSigningKeys: PrivateJwk[];
}

const KID = /^[A-Za-z0-9._-]{1,64}$/;
/** The P-256 group order n. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A P-256 private key from `random` (rejection-sampled into [1, n-1]), as a JWK. */
export function generateEs256Jwk(kid: string, random: RandomBytes = randomBytes): PrivateJwk {
  for (;;) {
    const d = random(32);
    const scalar = BigInt(`0x${Buffer.from(d).toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const point = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
    return {
      kty: 'EC',
      crv: 'P-256',
      kid,
      alg: 'ES256',
      d: b64url(d),
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    };
  }
}

export function publicJwk(jwk: PrivateJwk): PublicJwk {
  return { kty: jwk.kty, crv: jwk.crv, kid: jwk.kid, alg: jwk.alg, x: jwk.x, y: jwk.y };
}

export function generateSecrets(random: RandomBytes = randomBytes): SecretsDocument {
  return {
    cursorKey: b64(random(32)),
    encryptionKeys: [{ id: 'e1', key: b64(random(32)) }],
    oauthSigningKeys: [generateEs256Jwk('k1', random)],
  };
}

export interface GenSecretsDeps {
  random?: RandomBytes;
  /** fd 1 normally; tests pass another descriptor. */
  stdoutFd?: number;
  stderr?: (line: string) => void;
}

const USAGE = 'usage: gen-secrets.ts [--oauth-key <kid>] [--out FILE]';

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

export function main(argv: readonly string[], deps: GenSecretsDeps = {}): number {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let out: string | null = null;
  let oauthKid: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && i + 1 < argv.length && argv[i + 1] !== '') {
      out = argv[++i] as string;
    } else if (arg === '--oauth-key' && i + 1 < argv.length) {
      oauthKid = argv[++i] as string;
      if (!KID.test(oauthKid)) {
        stderr('gen-secrets: --oauth-key needs a kid of 1-64 characters of [A-Za-z0-9._-]');
        return 2;
      }
    } else if (arg === '--help' || arg === '-h') {
      stderr(USAGE);
      return 0;
    } else {
      stderr(USAGE);
      return 2;
    }
  }

  const random = deps.random ?? randomBytes;
  let body: unknown;
  if (oauthKid !== null) {
    const key = generateEs256Jwk(oauthKid, random);
    body = { oauthSigningKey: key, oauthAnnouncedKey: publicJwk(key) };
  } else {
    body = generateSecrets(random);
  }
  const text = `${JSON.stringify(body, null, 2)}\n`;

  if (out !== null) {
    let fd: number;
    try {
      fd = openSync(
        resolve(out),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      stderr(
        `gen-secrets: cannot create ${out} (${(err as NodeJS.ErrnoException).code ?? 'error'}); it must not exist`,
      );
      return 1;
    }
    try {
      fchmodSync(fd, 0o600); // the umask cannot widen it, but make the mode exact
      writeAll(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return 0;
  }

  const fd = deps.stdoutFd ?? 1;
  try {
    if (fstatSync(fd).isFile()) fchmodSync(fd, 0o600);
  } catch (err) {
    stderr(`gen-secrets: cannot restrict the output file to 0600 (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    return 1;
  }
  writeAll(fd, text);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
