// W2-03: commit verification (ADR 0004 §7 step 2) over real signed repositories
// from the W1-05 kit, on both curves, in workerd (WebCrypto P-256, noble
// secp256k1). Every corruption below changes exactly one invariant; where the
// corruption re-signs, the test also shows the corrupted commit is otherwise
// valid, so the rejection is attributable to that invariant alone.

import { decode, fromBytes } from '@atcute/cbor';
import { parseDidKey, verifySig } from '@atcute/crypto';
import { type Curve, type TestKey, testKey } from '@atmusic/atproto/test-support/keys';
import {
  carCommit,
  cborCid,
  corruptDid,
  corruptRev,
  corruptRoot,
  corruptSignature,
  corruptSignatureHighS,
  corruptVersion,
  encodeCar,
  parseCar,
  SignedRepo,
  unsignedCommitBytes,
} from '@atmusic/atproto/test-support/signed-repo';
import { readBoundedCar } from '@atmusic/atproto/verify/car-bounds';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import { type VerifiedCommit, VerifyError, type VerifyErrorCode } from '@atmusic/atproto/verify/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { verifySignature as atprotoVerify } from '@atproto/crypto';
import { describe, expect, it } from 'vitest';
import manifest from '../../../tests/goldens/signed_cars/manifest.json' with { type: 'json' };

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_DID = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
const SCROBBLE = 'com.example.atmusic.scrobble';
const BOUNDS = { maxBytes: 1024 * 1024, maxBlocks: 1024 };
const CURVES: Curve[] = ['secp256k1', 'p256'];
const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

function scrobble(n: number) {
  return {
    $type: SCROBBLE,
    artist: `Artist ${n}`,
    track: `Track ${n}`,
    listenedAt: '2026-01-15T11:00:00Z',
    createdAt: '2026-01-15T11:00:00Z',
  };
}

async function repoFor(key: TestKey) {
  const repo = new SignedRepo(DID, key, { clock: fixedClock('2026-01-15T12:00:00Z') });
  await repo.put(SCROBBLE, 'r01', scrobble(1));
  await repo.put(SCROBBLE, 'r02', scrobble(2));
  await repo.put(SCROBBLE, 'r03', scrobble(3));
  return repo;
}

async function verifyCar(car: Uint8Array, opts: { did: string; signingKey: string }): Promise<VerifiedCommit> {
  const { root, blocks } = readBoundedCar(car, BOUNDS);
  return verifyCommit(blocks, root, opts);
}

/**
 * Rewrite the root commit block's raw bytes, replacing the single occurrence
 * of `from` with `to`, keeping the original signature; re-hash and re-root.
 * The result is a CID-valid CAR whose commit decodes to the same value.
 */
function rewriteCommitBytes(car: Uint8Array, from: number[], to: number[]) {
  const parsed = parseCar(car);
  const root = parsed.roots[0]!;
  const block = parsed.sections.find((s) => s.cid === root)!.bytes;
  let at = -1;
  for (let i = 0; i + from.length <= block.length; i++) {
    if (from.every((b, j) => block[i + j] === b)) {
      expect(at).toBe(-1); // exactly one occurrence
      at = i;
    }
  }
  expect(at).toBeGreaterThanOrEqual(0);
  const bytes = new Uint8Array([...block.subarray(0, at), ...to, ...block.subarray(at + from.length)]);
  const cid = cborCid(bytes);
  const rebuilt = encodeCar(
    [cid],
    parsed.sections.map((s): [string, Uint8Array] => (s.cid === root ? [cid, bytes] : [s.cid, s.bytes])),
  );
  return { car: rebuilt, cid, bytes };
}

const utf8 = (s: string) => [...new TextEncoder().encode(s)];

async function codeOf(p: Promise<unknown>): Promise<VerifyErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VerifyError) return e.code;
    throw e;
  }
  throw new Error('expected a VerifyError, but verification succeeded');
}

describe('verifyCommit', () => {
  it('valid secp256k1 and P-256 commits verify', async () => {
    const seen = new Set<string>();
    for (const curve of CURVES) {
      // The Rust-oracle scalar [0x07; 32]: the did:key the golden manifest lists.
      const key = await testKey(curve, 0x07);
      expect(key.didKey).toBe(manifest.keys[curve].didKey);
      const repo = await repoFor(key);
      const head = repo.head!;
      const car = await repo.fullCar();

      const { root, blocks } = readBoundedCar(car, BOUNDS);
      expect(root).toBe(head.cid);
      const commit = await verifyCar(car, { did: DID, signingKey: key.didKey });
      expect(commit).toEqual({ did: DID, cid: head.cid, rev: head.rev, dataCid: head.data, version: 3 });
      expect(commit.rev).toMatch(TID);
      seen.add(commit.cid);

      // Cross-check: @atproto/crypto accepts the same signature over the same bytes.
      const decoded = carCommit(car);
      expect(await atprotoVerify(key.didKey, unsignedCommitBytes(decoded), fromBytes(decoded.sig))).toBe(true);

      // A firehose-style diff CAR of a later commit verifies at its own head.
      const next = await repo.put(SCROBBLE, 'r04', scrobble(4));
      const later = await verifyCar(next.car, { did: DID, signingKey: key.didKey });
      expect(later).toEqual({ did: DID, cid: next.cid, rev: next.rev, dataCid: next.data, version: 3 });
      expect(later.rev > commit.rev).toBe(true);
      expect(later.cid).not.toBe(commit.cid);

      // The key binding matters: the same commit under any other key fails.
      const otherCurve = await testKey(curve === 'p256' ? 'secp256k1' : 'p256', 0x07);
      const sameCurveOther = await testKey(curve, 0x0c);
      expect(await codeOf(verifyCommit(blocks, root, { did: DID, signingKey: otherCurve.didKey }))).toBe(
        'bad_signature',
      );
      expect(await codeOf(verifyCommit(blocks, root, { did: DID, signingKey: sameCurveOther.didKey }))).toBe(
        'bad_signature',
      );
    }
    // Same records, different curves: distinct commit blocks.
    expect(seen.size).toBe(2);
  });

  it('high-S signature, wrong DID, version 2, non-TID rev are rejected with codes', async () => {
    for (const curve of CURVES) {
      const key = await testKey(curve, 0x07);
      const repo = await repoFor(key);
      const car = await repo.fullCar();
      const ok = { did: DID, signingKey: key.didKey };
      expect((await verifyCar(car, ok)).cid).toBe(repo.head!.cid);

      // High-S: the malleable twin is valid ECDSA (the library accepts it when
      // malleability is explicitly allowed), so only the low-S rule rejects it.
      const highS = await corruptSignatureHighS(car, curve);
      expect(await codeOf(verifyCar(highS, ok))).toBe('bad_signature');
      const twin = carCommit(highS);
      expect(
        await verifySig(parseDidKey(key.didKey), new Uint8Array(fromBytes(twin.sig)), unsignedCommitBytes(twin), {
          allowMalleableSig: true,
        }),
      ).toBe(true);
      expect(twin.data.$link).toBe(repo.head!.data);

      // A flipped signature byte.
      expect(await codeOf(verifyCar(await corruptSignature(car), ok))).toBe('bad_signature');

      // Wrong DID: the commit names another DID (re-signed, so it is valid for that DID) …
      const otherDid = await corruptDid(car, key, OTHER_DID);
      expect(await codeOf(verifyCar(otherDid, ok))).toBe('did_mismatch');
      expect((await verifyCar(otherDid, { did: OTHER_DID, signingKey: key.didKey })).did).toBe(OTHER_DID);
      // … or the caller asks for another DID than the valid commit names.
      expect(await codeOf(verifyCar(car, { did: OTHER_DID, signingKey: key.didKey }))).toBe('did_mismatch');

      // Version 2 (re-signed) and a version that is not even a number.
      const v2 = await corruptVersion(car, key, 2);
      expect((decode(parseCar(v2).sections[0]!.bytes) as { version: number }).version).toBe(2);
      expect(await codeOf(verifyCar(v2, ok))).toBe('bad_version');
      expect(await codeOf(verifyCar(await corruptVersion(car, key, 4), ok))).toBe('bad_version');

      // Non-canonical commit, original signature kept: version written as
      // float64 3.0. It decodes to the honest commit value (version === 3),
      // so the signature still verifies over the re-encoded unsigned commit;
      // only the canonical round-trip check stops this second commit CID
      // from being accepted (the Rust oracle requires Ipld::Integer(3)).
      const floatVersion = rewriteCommitBytes(
        car,
        [0x67, ...utf8('version'), 0x03],
        [0x67, ...utf8('version'), 0xfb, 0x40, 0x08, 0, 0, 0, 0, 0, 0],
      );
      expect(floatVersion.cid).not.toBe(repo.head!.cid);
      const floatTwin = carCommit(floatVersion.car);
      expect(floatTwin).toEqual(carCommit(car));
      expect(floatTwin.version).toBe(3);
      expect(
        await verifySig(
          parseDidKey(key.didKey),
          new Uint8Array(fromBytes(floatTwin.sig)),
          unsignedCommitBytes(floatTwin),
          { allowMalleableSig: false },
        ),
      ).toBe(true);
      expect(await codeOf(verifyCar(floatVersion.car, ok))).toBe('car_malformed');

      // Non-TID revs (re-signed): outside the alphabet, first char out of range, wrong length.
      for (const rev of ['1111111111111', 'z222222222222', '3m4zm2ufr222']) {
        expect(await codeOf(verifyCar(await corruptRev(car, key, rev), ok))).toBe('bad_rev');
      }

      // Unusable keys and a missing commit block have their own codes.
      expect(await codeOf(verifyCar(car, { did: DID, signingKey: key.multikey }))).toBe('key_unavailable');
      expect(await codeOf(verifyCar(car, { did: DID, signingKey: 'did:key:zNotAKey' }))).toBe('key_unavailable');
      expect(await codeOf(verifyCar(corruptRoot(car), ok))).toBe('missing_block');
    }
  });
});
