// Crypto primitives of the Node host (ADR 0005 §3.8, §5.5, §7.3, §7.4, §8.2,
// §13; N1-08): the AES-256-GCM box with HKDF-derived keys, the bearer
// credential generators and their SHA-256 hash, the portable constant-time
// compare, and MD5 for Last.fm signatures.
//
// Every expected value is independent of the code under test: the HKDF vectors
// were computed by the Rust oracle's own crates (hkdf 0.12.4 + sha2 0.10.9,
// the versions in Cargo.lock, running exactly TokenStore::new of
// crates/atproto/src/oauth/token_store.rs:60-69) and cross-checked with a
// Python RFC 5869 implementation; the MD5 and SHA-256 vectors come from
// Python's hashlib, RFC 1321 and FIPS 180-2; the box's output is decrypted
// with raw node:crypto under the vector key, not through createBox.

import { createDecipheriv } from 'node:crypto';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import {
  BOX_PURPOSES,
  BoxError,
  type BoxPurpose,
  createBox,
  DERIVATIONS,
  deriveKey,
  type EncryptionKey,
  lastfmAppAad,
  linkedAad,
  NONCE_BYTES,
  oauthSessionAad,
  oauthStateAad,
  sealedKeyId,
  TAG_BYTES,
} from '../../src/crypto/box';
import { constantTimeEqual } from '../../src/crypto/constant-time';
import { md5Hex } from '../../src/crypto/md5';
import {
  APP_PASSWORD_ALPHABET,
  hashToken,
  hashTokenBlob,
  hashTokenHex,
  newAppPassword,
  newLastfmApiKey,
  newLastfmSessionKey,
  newLastfmSharedSecret,
  newLastfmToken,
  newListenBrainzToken,
  newOAuthBindingToken,
  newSessionToken,
} from '../../src/crypto/tokens';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Master key 00 01 02 … 1f. */
const SEQ_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const FF_KEY = new Uint8Array(32).fill(0xff);

// Rust oracle output (see the file header):
//   seq master=000102…1f state=57cb…50ba tokens=8726…bdc2
//   ff  master=ffff…ffff state=85ad…dca6 tokens=5b01…b0f1
const RUST_VECTORS = [
  {
    master: SEQ_KEY,
    state: '57cb172416432bda9dccf0a5f3423d9ff1529978aafd4950da45914d0b1c50ba',
    tokens: '8726f7e95c300b2674049d0971ce168dc647c68edf298d326b2ab4f4b2dfbdc2',
  },
  {
    master: FF_KEY,
    state: '85ad295fa01c39eb87b15fbbe09fb7173d8eb8e13153d0f5f0120d2808d7dca6',
    tokens: '5b010956feab7a36b3b7146dea5a3a75dc43b36f799699384ed20cd1769fb0f1',
  },
] as const;

const e1: EncryptionKey = { id: 'e1', key: SEQ_KEY };
const e2: EncryptionKey = { id: 'e2', key: FF_KEY };

/** Assert that `fn` throws a BoxError with `reason`. */
function expectBoxError(fn: () => unknown, reason: BoxError['reason']): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BoxError);
  expect((caught as BoxError).reason).toBe(reason);
}

/** A copy of `bytes` with bit `bit` of byte `index` flipped. */
function flip(bytes: Uint8Array, index: number, bit = 0): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[index] = (out[index] as number) ^ (1 << bit);
  return out;
}

/** Decrypt a sealed box with raw node:crypto under an externally supplied 32-byte key. */
function rawOpen(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  const idLength = sealed[0] as number;
  const header = sealed.subarray(0, 1 + idLength);
  const nonce = sealed.subarray(1 + idLength, 1 + idLength + NONCE_BYTES);
  const body = sealed.subarray(1 + idLength + NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  d.setAAD(Buffer.concat([header, utf8(aad)]));
  d.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
}

describe('crypto box', () => {
  it('open(seal(x, aad)) returns x; a flipped bit in nonce, ciphertext, tag or AAD throws BoxError', () => {
    const box = createBox([e1], seededRandom(7));
    const did = 'did:plc:alice';
    const x = utf8('{"refresh_token":"r-123","dpop_jwk":{"kty":"EC"}}');
    const sealed = box.seal('oauth-session', x, oauthSessionAad(did));

    // Format: [len=2]['e','1'] ‖ nonce(12) ‖ ciphertext(|x|) ‖ tag(16).
    expect(sealed[0]).toBe(2);
    expect(new TextDecoder().decode(sealed.subarray(1, 3))).toBe('e1');
    expect(sealed.length).toBe(3 + NONCE_BYTES + x.length + TAG_BYTES);
    expect(sealedKeyId(sealed)).toBe('e1');
    // The plaintext is not visible in the sealed bytes.
    expect(Buffer.from(sealed).includes(Buffer.from('refresh_token'))).toBe(false);

    expect(hex(box.open('oauth-session', sealed, oauthSessionAad(did)))).toBe(hex(x));
    expect(box.openText('oauth-session', sealed, did)).toBe(new TextDecoder().decode(x));

    // Two seals of the same value use different nonces and differ.
    const again = box.seal('oauth-session', x, did);
    expect(hex(again)).not.toBe(hex(sealed));
    expect(hex(again.subarray(3, 3 + NONCE_BYTES))).not.toBe(hex(sealed.subarray(3, 3 + NONCE_BYTES)));

    const nonceStart = 3;
    const ctStart = nonceStart + NONCE_BYTES;
    const tagStart = sealed.length - TAG_BYTES;
    const regions: Record<string, number[]> = {
      nonce: [nonceStart, nonceStart + 5, ctStart - 1],
      ciphertext: [ctStart, ctStart + 10, tagStart - 1],
      tag: [tagStart, tagStart + 7, sealed.length - 1],
    };
    let tampered = 0;
    for (const indexes of Object.values(regions)) {
      for (const index of indexes) {
        for (const bit of [0, 7]) {
          expectBoxError(() => box.open('oauth-session', flip(sealed, index, bit), did), 'authentication');
          tampered++;
        }
      }
    }
    expect(tampered).toBe(18);

    // AAD: another DID, and one flipped bit in the AAD bytes.
    expectBoxError(() => box.open('oauth-session', sealed, 'did:plc:alicf'), 'authentication');
    expectBoxError(() => box.open('oauth-session', sealed, flip(utf8(did), 3, 1)), 'authentication');
    expectBoxError(() => box.open('oauth-session', sealed, ''), 'authentication');
    // Another purpose derives another key.
    expectBoxError(() => box.open('oauth-state', sealed, did), 'authentication');
    // The key id is authenticated: a flipped id is an unknown key, a dropped tail is malformed.
    expectBoxError(() => box.open('oauth-session', flip(sealed, 2, 0), did), 'unknown_key');
    expectBoxError(
      () => box.open('oauth-session', sealed.subarray(0, 3 + NONCE_BYTES + TAG_BYTES - 1), did),
      'malformed',
    );
    expectBoxError(() => box.open('oauth-session', new Uint8Array(0), did), 'malformed');
    // Nothing above changed the original, which still opens.
    expect(hex(box.open('oauth-session', sealed, did))).toBe(hex(x));

    // Key configuration errors are typed and never echo key material.
    for (const bad of [
      [],
      [{ id: 'e1', key: new Uint8Array(31) }],
      [e1, { id: 'e1', key: FF_KEY }],
      [{ id: '', key: SEQ_KEY }],
    ]) {
      let caught: unknown;
      try {
        createBox(bad as EncryptionKey[], seededRandom(1));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BoxError);
      expect((caught as BoxError).reason).toBe('invalid_keys');
      expect((caught as BoxError).message).not.toContain(hex(FF_KEY));
    }
  });

  it('HKDF keys for salt atmusic/oauth/encryption/v1 info state and tokens equal the vectors from crates/atproto/src/oauth/token_store.rs', () => {
    expect(DERIVATIONS['oauth-state']).toEqual({ salt: 'atmusic/oauth/encryption/v1', info: 'state' });
    expect(DERIVATIONS['oauth-session']).toEqual({ salt: 'atmusic/oauth/encryption/v1', info: 'tokens' });
    for (const v of RUST_VECTORS) {
      expect(hex(deriveKey(v.master, 'oauth-state'))).toBe(v.state);
      expect(hex(deriveKey(v.master, 'oauth-session'))).toBe(v.tokens);
    }

    // The box really encrypts under those keys: raw AES-256-GCM with the Rust
    // vector key (not deriveKey) opens what the box sealed.
    const box = createBox([e1], seededRandom(11));
    const keyHash = 'ab'.repeat(32);
    const stateSealed = box.seal('oauth-state', 'state-payload', oauthStateAad(keyHash));
    expect(new TextDecoder().decode(rawOpen(fromHex(RUST_VECTORS[0].state), stateSealed, keyHash))).toBe(
      'state-payload',
    );
    const sessionSealed = box.seal('oauth-session', 'session-payload', oauthSessionAad('did:plc:alice'));
    expect(new TextDecoder().decode(rawOpen(fromHex(RUST_VECTORS[0].tokens), sessionSealed, 'did:plc:alice'))).toBe(
      'session-payload',
    );
    // …and not under the other OAuth key.
    expect(() => rawOpen(fromHex(RUST_VECTORS[0].tokens), stateSealed, keyHash)).toThrow();

    // The other §3.8 derivations (Python RFC 5869 over master 00…1f).
    expect(hex(deriveKey(SEQ_KEY, 'linked-lastfm'))).toBe(
      '5e48e999ede9ab5ae0038d659c11a47939a6b85d55517951c92780c25c8f2f3d',
    );
    expect(hex(deriveKey(SEQ_KEY, 'linked-listenbrainz'))).toBe(
      '6e66e2507445201022a62cb068f2895e9e2d55d32417398ed6a6a1dd83978f19',
    );
    expect(hex(deriveKey(SEQ_KEY, 'lastfm-app'))).toBe(
      '6a641fb67b05497ccd0bac0cbf37497e20e4ec40ba62d213bcbedfc14471c0b7',
    );
    expect(hex(box.csrfKey())).toBe('30ae331ff2a4cbc4c359ea89c4b94f865bd90d5de70c0f9bcdc36061f2a5ab67');
    // Five distinct purpose keys.
    expect(new Set(BOX_PURPOSES.map((p) => hex(deriveKey(SEQ_KEY, p)))).size).toBe(5);
  });

  it('ciphertext sealed under e1 opens after e2 is prepended, and a reseal is tagged e2', () => {
    const aad = linkedAad('did:plc:alice', 'listenbrainz');
    const before = createBox([e1], seededRandom(3));
    const sealed = before.seal('linked-listenbrainz', 'lb-token-value', aad);
    expect(sealedKeyId(sealed)).toBe('e1');

    const rotated = createBox([e2, e1], seededRandom(4));
    expect(rotated.currentKeyId).toBe('e2');
    expect(rotated.openText('linked-listenbrainz', sealed, aad)).toBe('lb-token-value');

    const resealed = rotated.reseal('linked-listenbrainz', sealed, aad);
    expect(sealedKeyId(resealed)).toBe('e2');
    expect(rotated.openText('linked-listenbrainz', resealed, aad)).toBe('lb-token-value');
    // A new seal is tagged e2 too, and really uses e2's derived key.
    const fresh = rotated.seal('linked-listenbrainz', 'other', aad);
    expect(sealedKeyId(fresh)).toBe('e2');
    expect(new TextDecoder().decode(rawOpen(deriveKey(FF_KEY, 'linked-listenbrainz'), resealed, aad))).toBe(
      'lb-token-value',
    );

    // The pre-rotation box cannot open e2 values; once e1 is retired, e1 values are unknown.
    expectBoxError(() => before.open('linked-listenbrainz', resealed, aad), 'unknown_key');
    const retired = createBox([e2], seededRandom(5));
    expectBoxError(() => retired.open('linked-listenbrainz', sealed, aad), 'unknown_key');
    expect(retired.openText('linked-listenbrainz', resealed, aad)).toBe('lb-token-value');
    // A reseal with the wrong AAD fails and produces nothing.
    expectBoxError(
      () => rotated.reseal('linked-listenbrainz', sealed, linkedAad('did:plc:bob', 'listenbrainz')),
      'authentication',
    );
  });

  it('a value sealed with AAD linked/did:a/lastfm fails to open with AAD linked/did:b/lastfm or lastfm-app/K/did:a', () => {
    const box = createBox([e1], seededRandom(9));
    expect(linkedAad('did:a', 'lastfm')).toBe('linked/did:a/lastfm');
    expect(lastfmAppAad('K', 'did:a')).toBe('lastfm-app/K/did:a');
    const sealed = box.seal('linked-lastfm', 'sk-of-alice', linkedAad('did:a', 'lastfm'));

    expect(box.openText('linked-lastfm', sealed, 'linked/did:a/lastfm')).toBe('sk-of-alice');
    expectBoxError(() => box.open('linked-lastfm', sealed, 'linked/did:b/lastfm'), 'authentication');
    // The issued-app row's AAD, under its own purpose and under the linked purpose.
    expectBoxError(() => box.open('lastfm-app', sealed, 'lastfm-app/K/did:a'), 'authentication');
    expectBoxError(() => box.open('linked-lastfm', sealed, 'lastfm-app/K/did:a'), 'authentication');
    // Same DID, other service.
    expectBoxError(() => box.open('linked-listenbrainz', sealed, linkedAad('did:a', 'listenbrainz')), 'authentication');
    expectBoxError(() => box.open('linked-lastfm', sealed, linkedAad('did:a', 'listenbrainz')), 'authentication');

    // An issued app secret is bound to its api_key and DID the same way.
    const secret = box.seal('lastfm-app', 'shared-secret', lastfmAppAad('K', 'did:a'));
    expect(box.openText('lastfm-app', secret, 'lastfm-app/K/did:a')).toBe('shared-secret');
    expectBoxError(() => box.open('lastfm-app', secret, 'lastfm-app/K2/did:a'), 'authentication');
    expectBoxError(() => box.open('lastfm-app', secret, 'lastfm-app/K/did:b'), 'authentication');
    expectBoxError(() => box.open('unknown' as BoxPurpose, secret, 'lastfm-app/K/did:a'), 'unknown_purpose');
  });
});

describe('credential tokens', () => {
  it('a seeded Random yields fixed session tokens, 32-hex keys, a version-4 UUID and a 24-char base32 password; hashToken is SHA-256', () => {
    // Fixed outputs for seed 42: the generators are pure functions of the Random.
    const r = seededRandom(42);
    const session = newSessionToken(r);
    const lastfmToken = newLastfmToken(r);
    const sk = newLastfmSessionKey(r);
    const lb = newListenBrainzToken(r);
    const password = newAppPassword(r);
    expect({ session, lastfmToken, sk, lb, password }).toEqual(SEED_42);
    const again = seededRandom(42);
    expect(newSessionToken(again)).toBe(session);
    expect(newSessionToken(seededRandom(43))).not.toBe(session);

    // Each value is exactly the encoding of the next bytes of the Random,
    // checked with independent encoders (Buffer hex, BigInt base32).
    const ref = seededRandom(42);
    expect(session).toBe(hex(ref.bytes(32)));
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(lastfmToken).toBe(hex(ref.bytes(16)));
    expect(sk).toBe(hex(ref.bytes(16)));
    expect(lastfmToken).toMatch(/^[0-9a-f]{32}$/);
    expect(sk).toMatch(/^[0-9a-f]{32}$/);

    const uuidBytes = ref.bytes(16);
    expect(lb).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const lbBytes = fromHex(lb.replaceAll('-', ''));
    expect(lbBytes[6]).toBe(((uuidBytes[6] as number) & 0x0f) | 0x40);
    expect(lbBytes[8]).toBe(((uuidBytes[8] as number) & 0x3f) | 0x80);
    lbBytes.forEach((byte, i) => {
      if (i !== 6 && i !== 8) expect(byte).toBe(uuidBytes[i]);
    });

    const pwBytes = ref.bytes(15);
    let n = BigInt(`0x${hex(pwBytes)}`);
    let expectedPassword = '';
    for (let i = 0; i < 24; i++) {
      expectedPassword = 'abcdefghijklmnopqrstuvwxyz234567'[Number(n & 31n)] + expectedPassword;
      n >>= 5n;
    }
    expect(password).toBe(expectedPassword);
    expect(password).toHaveLength(24);
    expect(password).toMatch(/^[a-z2-7]{24}$/);
    expect(APP_PASSWORD_ALPHABET).toBe('abcdefghijklmnopqrstuvwxyz234567');

    // The other 32-hex and 64-hex generators.
    const r2 = seededRandom(5);
    for (const value of [newLastfmApiKey(r2), newLastfmSharedSecret(r2)]) expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(newOAuthBindingToken(r2)).toMatch(/^[0-9a-f]{64}$/);

    // Over many draws the UUID version and variant never vary, and the password stays base32.
    const many = seededRandom(99);
    for (let i = 0; i < 200; i++) {
      expect(newListenBrainzToken(many)[14]).toBe('4');
      expect('89ab').toContain(newListenBrainzToken(many)[19]);
      expect(newAppPassword(many)).toMatch(/^[a-z2-7]{24}$/);
    }

    // hashToken = SHA-256 of the UTF-8 bytes (FIPS 180-2 vectors).
    expect(hashTokenHex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashTokenHex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('abc')).toBeInstanceOf(Uint8Array);
    expect(hashToken('abc')).toHaveLength(32);
    expect(hex(hashToken('abc'))).toBe(hashTokenHex('abc'));
    const blob = hashTokenBlob('abc');
    expect(blob).toBeInstanceOf(ArrayBuffer);
    expect(blob.byteLength).toBe(32);
    expect(hex(new Uint8Array(blob))).toBe(hashTokenHex('abc'));
    expect(hashTokenHex(session)).not.toBe(hashTokenHex(lastfmToken));

    // A Random that returns the wrong length is refused rather than producing a short token.
    expect(() => newSessionToken({ bytes: () => new Uint8Array(3), float: () => 0 })).toThrow(RangeError);
  });

  it('constantTimeEqual returns false for different lengths and true only for equal digests', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    expect(constantTimeEqual(a, Uint8Array.from(a))).toBe(true);
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, a.subarray(0, 31))).toBe(false);
    expect(constantTimeEqual(a.subarray(0, 31), a)).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array(0))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    // Any single differing bit anywhere is detected.
    for (let i = 0; i < a.length; i++) {
      expect(constantTimeEqual(a, flip(a, i, i % 8))).toBe(false);
    }
    // ArrayBuffer and Uint8Array views of the same bytes are equal.
    expect(constantTimeEqual(hashTokenBlob('token-a'), a)).toBe(true);
    expect(constantTimeEqual(hashTokenBlob('token-a'), hashTokenBlob('token-b'))).toBe(false);
    // Strings compare by their UTF-8 bytes: an api_sig compare lowercases first.
    const sig = md5Hex('x');
    expect(constantTimeEqual(sig, md5Hex('x'))).toBe(true);
    expect(constantTimeEqual(sig.toUpperCase(), sig)).toBe(false);
    expect(constantTimeEqual(sig.toUpperCase().toLowerCase(), sig)).toBe(true);
    expect(constantTimeEqual(sig, `${sig}0`)).toBe(false);
    expect(constantTimeEqual('é', 'é')).toBe(false);
    expect(() => constantTimeEqual(42 as unknown as string, 'x')).toThrow(TypeError);
  });
});

describe('md5', () => {
  it('md5 of api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret matches the independently computed vector', () => {
    // The Last.fm API documentation's signing example (api_key, method, token, then the secret),
    // hashed by Python hashlib.md5.
    expect(md5Hex('api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret')).toBe('68afb32bee072407a63b6c41f3e1e2b4');
    // RFC 1321 appendix A.5.
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    // Non-ASCII values are signed as UTF-8 (hashlib.md5('Björk'.encode())).
    expect(md5Hex('Björk')).toBe('7dab4f23a40857b30fdd81370c211680');
    expect(md5Hex(utf8('Björk'))).toBe('7dab4f23a40857b30fdd81370c211680');
    expect(md5Hex('Bjork')).not.toBe('7dab4f23a40857b30fdd81370c211680');
  });
});

/**
 * Outputs of the generators for seededRandom(42), in the order drawn above,
 * computed by an independent Python port of test-support/random.ts
 * (splitmix32 + xorshift128) with bytes.hex(), uuid.UUID and base64.b32encode.
 */
const SEED_42 = {
  session: '2c82f9d20ef164dfdb693bf16d40b7e6755641f8f224550092e00a2a9679e276',
  lastfmToken: 'c17be2841bad392d5ed64a50083b0135',
  sk: '1a72aaa221421b421a94e544f53e0078',
  lb: '4da9cb89-1ff8-4911-aafb-74792795fa00',
  password: 'wtk27vb6k3uavistthklxny6',
};
