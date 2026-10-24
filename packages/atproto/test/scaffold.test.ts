import { VERIFY_ERROR_CODES, VerifyError } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';

const utf8 = new TextEncoder();

describe('workerd runtime', () => {
  it('workerd runtime has WebCrypto ECDSA P-256 and String.prototype.normalize NFKC', async () => {
    // Running inside workerd, not Node: navigator.userAgent identifies the runtime.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');

    // ECDSA P-256 sign/verify round trip through WebCrypto (the path
    // @atcute/crypto uses for P-256 keys).
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const message = utf8.encode('atmusic commit bytes');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message));
    expect(sig.length).toBe(64); // IEEE P1363 r||s, as atproto signatures are encoded
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, message)).toBe(true);
    const tampered = sig.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, tampered, message)).toBe(
      false,
    );
    expect(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, utf8.encode('other')),
    ).toBe(false);

    // The public key exports as an uncompressed SEC1 point (0x04 || x || y).
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);

    // SHA-256 known answer (CIDs are sha2-256).
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode('abc')));
    expect(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );

    // ICU NFKC, used by the music grouping keys.
    expect('\uFB01'.normalize('NFKC')).toBe('fi'); // ligature fi
    expect('\u212A'.normalize('NFKC')).toBe('K'); // Kelvin sign
    expect('\uFF22\uFF4A\uFF4F\uFF52\uFF4B'.normalize('NFKC')).toBe('Bjork'); // fullwidth
    expect('Bjo\u0308rk'.normalize('NFKC')).toBe('Bj\u00F6rk'); // composes
    expect('\u00B2'.normalize('NFKC')).toBe('2');
    expect('\u00B2'.normalize('NFC')).toBe('\u00B2'); // NFC alone does not fold compatibility
  });

  it('VerifyError carries its typed code', () => {
    const err = new VerifyError('missing_block', 'subtree node absent');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('missing_block');
    expect(err.message).toBe('subtree node absent');
    expect(new VerifyError('no_proof').message).toBe('no_proof');
    expect(VERIFY_ERROR_CODES).toHaveLength(12);
  });
});
