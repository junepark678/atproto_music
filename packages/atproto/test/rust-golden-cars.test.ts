/// <reference types="vite/client" />
// W2-03 / M4.1.2 valid_signed_repo: the TypeScript verifier against the
// Rust-signed golden CARs (ADR 0004 §7.7, tests/goldens/signed_cars). Every
// manifest entry is run through verifyRecordProof over the file's exact bytes
// (sha-256 checked against the manifest). Valid CARs must prove exactly the
// expected state and CID, and for full repositories every music record the
// Rust verify_snapshot enumerated must be proven present with its exact CID.
// Invalid CARs must fail with exactly the expected VerifyErrorCode.

import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { VerifyError } from '@atmusic/atproto/verify/types';
import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import manifest from '../../../tests/goldens/signed_cars/manifest.json' with { type: 'json' };
import enumeration from '../../../tests/goldens/snapshot_enumeration.json' with { type: 'json' };

// `?url&inline` makes Vite serve each file as a base64 data: URL, so the
// workerd test sees the exact bytes on disk. Lazy: the 8 MiB oversize CARs
// load only when their entry runs.
const carFiles = import.meta.glob<string>('../../../tests/goldens/signed_cars/*.car', {
  query: '?url&inline',
  import: 'default',
});
const DIR = '../../../tests/goldens/signed_cars/';

type Entry = (typeof manifest.entries)[number];

async function loadCar(file: string): Promise<Uint8Array<ArrayBuffer>> {
  const load = carFiles[`${DIR}${file}`];
  if (!load) throw new Error(`no golden CAR ${file}`);
  const url = await load();
  const prefix = 'data:application/octet-stream;base64,';
  if (!url.startsWith(prefix)) throw new Error(`${file} did not load as a base64 data URL`);
  const bin = atob(url.slice(prefix.length));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function outcome(car: Uint8Array, e: Entry, collection: string, rkey: string, maxBytes?: number) {
  try {
    const proof = await verifyRecordProof(car, {
      did: e.did,
      collection,
      rkey,
      signingKey: e.signingKey,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    return { verdict: 'valid' as const, proof };
  } catch (err) {
    if (err instanceof VerifyError) return { verdict: 'invalid' as const, code: err.code };
    throw err;
  }
}

it('every tests/goldens/signed_cars manifest entry yields the expected verdict and error code', async () => {
  // The manifest covers every CAR on disk, and nothing else.
  expect(
    Object.keys(carFiles)
      .map((k) => k.slice(DIR.length))
      .sort(),
  ).toEqual(manifest.entries.map((e) => e.file).sort());
  expect(manifest.entries.length).toBe(34);
  const r01 = fixture.scrobbles.find((s) => s.rkey === 'r01')!.record;

  let checked = 0;
  let musicProven = 0;
  for (const e of manifest.entries) {
    const car = await loadCar(e.file);
    expect([e.name, car.length]).toEqual([e.name, e.bytes]);
    expect([e.name, await sha256Hex(car)]).toEqual([e.name, e.sha256]);
    expect(e.signingKey).toBe(manifest.keys[e.curve as 'secp256k1' | 'p256'].didKey);

    const { collection, rkey } = e.target;
    // The Rust cap (8 MiB; the oversize CARs are one byte over it) and the
    // default getRecord cap must agree on every verdict.
    const atRustCap = await outcome(car, e, collection, rkey, manifest.maxCarBytesRust);
    const atDefault = await outcome(car, e, collection, rkey);
    expect([e.name, atDefault]).toEqual([e.name, atRustCap]);

    if (e.expected.verdict === 'invalid') {
      expect([e.name, atRustCap]).toEqual([e.name, { verdict: 'invalid', code: e.expected.code }]);
      expect(e.rust.verdict).toBe('invalid');
    } else {
      expect([e.name, atRustCap.verdict]).toEqual([e.name, 'valid']);
      if (atRustCap.verdict !== 'valid') throw new Error('unreachable');
      const { proof } = atRustCap;
      expect(proof.commit).toEqual({
        did: e.did,
        cid: e.carRoot,
        rev: e.rev,
        dataCid: proof.commit.dataCid,
        version: 3,
      });
      const state = e.expected.state ?? 'present';
      if (state === 'present') {
        // The record is the shared fixture's r01, byte for byte (its CID is the signed one).
        expect([e.name, proof]).toEqual([
          e.name,
          { commit: proof.commit, collection, rkey, state: 'present', cid: e.target.cid, record: r01 },
        ]);
      } else {
        expect([e.name, proof]).toEqual([e.name, { commit: proof.commit, collection, rkey, state: 'absent' }]);
      }

      if (e.kind === 'full_repo') {
        // valid_signed_repo: every music record Rust's verify_snapshot returned is
        // proven present at the signed head with its exact CID …
        const snap = enumeration.snapshots.find((s) => s.car === `signed_cars/${e.file}`)!;
        expect(snap.commitCid).toBe(e.carRoot);
        expect(snap.entries.length).toBe(9);
        for (const m of snap.entries) {
          const slash = m.key.indexOf('/');
          const got = await outcome(car, e, m.key.slice(0, slash), m.key.slice(slash + 1));
          expect([m.key, got.verdict === 'valid' && got.proof.state === 'present' && got.proof.cid]).toEqual([
            m.key,
            m.cid,
          ]);
          musicProven++;
        }
        // … and the deleted r08 is proven absent from the same complete tree.
        const r08 = await outcome(car, e, collection, 'r08');
        expect(r08.verdict === 'valid' && r08.proof.state).toBe('absent');
      }
    }
    checked++;
  }
  expect(checked).toBe(34);
  expect(musicProven).toBe(18);
});
