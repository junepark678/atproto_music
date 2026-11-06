// Deterministic, TEST-ONLY signing keys (ADR 0004 §10.2, §10.3).
//
// Every scalar below is public. Never use these keys outside fixtures.
//
// - `[0x07; 32]` is the Rust oracle scalar (crates/atproto/tests/support/signed_repo.rs,
//   tests/goldens/signed_cars/manifest.json `keys`) for both curves, so Alice's
//   fixture repository can be compared byte for byte with the Rust-signed goldens.
// - Signatures are deterministic (RFC 6979) and low-S on both curves, so commit
//   CIDs are stable across runs:
//   - both curves sign with @atproto/crypto's noble keypairs (Secp256k1Keypair,
//     P256Keypair: RFC 6979, lowS) on every runtime.
//   - @atcute/crypto is NOT used for signing: its secp256k1 signer resolves to a
//     node:crypto build under the `node` export condition (random nonce), and
//     its P-256 signer goes through WebCrypto (random nonce). Either would make
//     commit CIDs differ between runs and runtimes. The @atcute/crypto signers
//     stay available as `signRandomized` for cross-checks.
// - Public keys and did:keys come from @atcute/crypto, the production verifier;
//   key creation asserts both libraries derive the same did:key.

import { type DidKeyString, P256PrivateKey, Secp256k1PrivateKey } from '@atcute/crypto';
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto';

export type Curve = 'secp256k1' | 'p256';

export interface TestKey {
  readonly curve: Curve;
  /** Human label for test output, e.g. `alice-secp256k1`. */
  readonly label: string;
  /** The private scalar, hex. Test-only by construction. */
  readonly scalarHex: string;
  /** `did:key:z…` for the public key. */
  readonly didKey: DidKeyString;
  /** `publicKeyMultibase` of the `#atproto` Multikey verification method (did:key without the prefix). */
  readonly multikey: string;
  /** Deterministic, low-S, 64-byte compact signature over `data` (SHA-256 prehash). */
  sign(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * The @atcute/crypto signer (WebCrypto for P-256; node:crypto or noble for
   * secp256k1 depending on the runtime), whose nonce may be random. For
   * cross-checks only; never used to build fixtures.
   */
  signRandomized(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
}

const cache = new Map<string, Promise<TestKey>>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A 32-byte scalar with every byte equal to `fill` (the Rust `[seed; 32]` convention). */
export function filledScalar(fill: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(fill) || fill < 1 || fill > 0x7f) {
    throw new RangeError(`test scalar fill byte must be in 1..=0x7f, got ${fill}`);
  }
  return new Uint8Array(32).fill(fill);
}

async function build(curve: Curve, scalar: Uint8Array<ArrayBuffer>, label: string): Promise<TestKey> {
  if (scalar.length !== 32) throw new RangeError('test scalar must be 32 bytes');
  const scalarHex = hex(scalar);
  const atcute =
    curve === 'secp256k1' ? await Secp256k1PrivateKey.importRaw(scalar) : await P256PrivateKey.importRaw(scalar);
  const rfc6979 = curve === 'secp256k1' ? await Secp256k1Keypair.import(scalar) : await P256Keypair.import(scalar);
  const didKey = await atcute.exportPublicKey('did');
  if (rfc6979.did() !== didKey) {
    throw new Error(`${curve} key derivation disagrees: ${rfc6979.did()} vs ${didKey}`);
  }
  return Object.freeze({
    curve,
    label,
    scalarHex,
    didKey,
    multikey: await atcute.exportPublicKey('multikey'),
    sign: async (data: Uint8Array) => new Uint8Array(await rfc6979.sign(data)),
    signRandomized: (data: Uint8Array) => atcute.sign(data),
  });
}

/** A deterministic test key; equal arguments return the same (cached) key. */
export function testKey(curve: Curve, fill: number, label = `${curve}-${fill.toString(16).padStart(2, '0')}`) {
  const id = `${curve}:${fill}:${label}`;
  let key = cache.get(id);
  if (!key) {
    key = build(curve, filledScalar(fill), label);
    cache.set(id, key);
  }
  return key;
}

/** Scalar fill bytes of the named fixture keys. */
export const KEY_FILLS = {
  /** Rust oracle secp256k1 key `[0x07; 32]`. */
  oracleSecp256k1: 0x07,
  /** Rust oracle P-256 key `[0x07; 32]`. */
  oracleP256: 0x07,
  carol: 0x0c,
  aliceRotated: 0x11,
  bobRotated: 0x12,
  carolRotated: 0x13,
} as const;

export interface FixtureKeys {
  /** secp256k1, the Rust oracle scalar. */
  alice: TestKey;
  /** P-256, the Rust oracle scalar, so both curves are on the shared fixture path. */
  bob: TestKey;
  /** secp256k1, a different scalar from Alice's. */
  carol: TestKey;
  aliceRotated: TestKey;
  bobRotated: TestKey;
  carolRotated: TestKey;
}

export async function fixtureKeys(): Promise<FixtureKeys> {
  const [alice, bob, carol, aliceRotated, bobRotated, carolRotated] = await Promise.all([
    testKey('secp256k1', KEY_FILLS.oracleSecp256k1, 'alice-secp256k1'),
    testKey('p256', KEY_FILLS.oracleP256, 'bob-p256'),
    testKey('secp256k1', KEY_FILLS.carol, 'carol-secp256k1'),
    testKey('p256', KEY_FILLS.aliceRotated, 'alice-rotated-p256'),
    testKey('secp256k1', KEY_FILLS.bobRotated, 'bob-rotated-secp256k1'),
    testKey('p256', KEY_FILLS.carolRotated, 'carol-rotated-p256'),
  ]);
  return { alice, bob, carol, aliceRotated, bobRotated, carolRotated };
}
