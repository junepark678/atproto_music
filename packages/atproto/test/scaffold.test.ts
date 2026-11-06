import { VERIFY_ERROR_CODES, VerifyError } from '@atmusic/atproto/verify/types';
import { describe, expect, it } from 'vitest';

const utf8 = new TextEncoder();

describe('workerd runtime', () => {
  it('workerd runtime has WebCrypto ECDSA P-256 and String.prototype.normalize NFKC', async () => {
    // Runtime-neutral (ADR 0005 §15.3, N1-04): this suite runs on the
    // production host (Node 26) and once ran in workerd; it checks the web
    // platform capabilities the package relies on, never the runtime's name.
    expect(crypto.subtle).toBeInstanceOf(SubtleCrypto);

    // ECDSA P-256 known answer: RFC 6979 §A.2.5, SHA-256, message "sample".
    // The fixed public key verifies the fixed r||s, and rejects it for another
    // message, so verification is checked against an external vector, not only
    // against this runtime's own signer.
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!, (b) => Number.parseInt(b, 16));
    const b64url = (u: Uint8Array) =>
      btoa(String.fromCharCode(...u))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const rfcKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(hex('60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6')),
        y: b64url(hex('7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299')),
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const rfcSig = hex(
      'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716' +
        'F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8',
    );
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rfcKey, rfcSig, utf8.encode('sample'))).toBe(
      true,
    );
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rfcKey, rfcSig, utf8.encode('test'))).toBe(
      false,
    );

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
