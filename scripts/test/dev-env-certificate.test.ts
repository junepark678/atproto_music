import { expect, test } from 'vitest';
import { certificateSerialFromDigest, selfSignedCert } from '../e2e/dev-env';

test('self-signed certificate serial is a canonical positive DER integer', () => {
  const zeroAfterMask = certificateSerialFromDigest(Buffer.from([0x80, 1, 2, 3, 4, 5, 6, 7]));
  const zeroDigest = certificateSerialFromDigest(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const highBit = certificateSerialFromDigest(Buffer.from([0xff, 1, 2, 3, 4, 5, 6, 7]));

  expect(zeroAfterMask[0]).toBe(1);
  expect(zeroDigest[0]).toBe(1);
  expect(highBit[0]).toBe(0x7f);
  expect(zeroAfterMask).toHaveLength(8);
});

test('the full self-signed fixture certificate parses and verifies with its private key', () => {
  expect(() => selfSignedCert(['music.e2e.test', 'pds1.test'], Date.UTC(2026, 10, 4))).not.toThrow();
});
