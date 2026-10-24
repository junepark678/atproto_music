// W2-03: record inclusion / exclusion proofs (ADR 0004 §7 steps 1 and 3) over a
// real signed repository from the W1-05 kit: the shared fixture's Alice
// scrobbles plus enough filler records that every proof path has several MST
// levels. Assertions are on the returned RecordProof (state, exact CID, exact
// JSON record, commit) or the exact VerifyErrorCode.

import { encode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { findRpathAndBuildProof, NodeStore, ReadonlyMemoryBlockStore } from '@atcute/mst';
import { type TestKey, testKey } from '@atmusic/atproto/test-support/keys';
import {
  cidOf,
  corruptBlockByte,
  corruptMstNodeByte,
  corruptOversize,
  corruptRecordCidSwap,
  corruptTruncate,
  dropBlock,
  encodeCar,
  encodeVarint,
  parseCar,
  SignedRepo,
} from '@atmusic/atproto/test-support/signed-repo';
import { readBoundedCar } from '@atmusic/atproto/verify/car-bounds';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import {
  proveRecord,
  RECORD_PROOF_MAX_BLOCKS,
  RECORD_PROOF_MAX_BYTES,
  verifyRecordProof,
} from '@atmusic/atproto/verify/record-proof';
import { VerifyError, type VerifyErrorCode } from '@atmusic/atproto/verify/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };

const P = 'com.example.atmusic';
const SCROBBLE = `${P}.scrobble`;
const FILLER = `${P}.other`;
const ALICE = fixture.users.Alice.did;
const aliceScrobbles = fixture.scrobbles.filter((s) => s.owner === ALICE);
const recordOf = (rkey: string) => aliceScrobbles.find((s) => s.rkey === rkey)!.record;
/** Alice's live scrobbles; r08 is created and then deleted. */
const live = aliceScrobbles.filter((s) => s.rkey !== 'r08');

/** A record exercising the JSON form of links and bytes. */
const LINKED = {
  $type: `${P}.scrobble`,
  artist: 'Kate Bush',
  track: 'Hounds of Love',
  listenedAt: '2026-01-15T10:00:00Z',
  createdAt: '2026-01-15T10:00:00Z',
  ref: { $link: 'bafyreid5qpw2fo22qy4r6t5xcep5weebu6l7bwwwd4lnzu54glaqu6fchu' },
  blob: { $bytes: 'AQIDBA' },
  nested: [{ n: 1 }, { n: -2, ok: true, none: null }],
};

let key: TestKey;
let repo: SignedRepo;
let opts: (rkey: string, collection?: string) => Parameters<typeof verifyRecordProof>[1];

async function codeOf(p: Promise<unknown>): Promise<VerifyErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VerifyError) return e.code;
    throw e;
  }
  throw new Error('expected a VerifyError, but verification succeeded');
}

/** MST node CIDs from the root to the deepest node the lookup of `path` visits. */
async function pathNodes(path: string): Promise<string[]> {
  const [, proof] = await findRpathAndBuildProof(new NodeStore(repo.store), repo.head!.data, path);
  return [...proof];
}

function expectedCommit() {
  const h = repo.head!;
  return { did: ALICE, cid: h.cid, rev: h.rev, dataCid: h.data, version: 3 };
}

beforeAll(async () => {
  key = await testKey('secp256k1', 0x07);
  repo = new SignedRepo(ALICE, key, { clock: fixedClock('2026-01-15T12:00:00Z') });
  const writes = live.map((s) => ({ action: 'put' as const, collection: SCROBBLE, rkey: s.rkey, record: s.record }));
  for (let i = 0; i < 60; i++) {
    writes.push({
      action: 'put',
      collection: FILLER,
      rkey: `k${String(i).padStart(3, '0')}`,
      record: { n: i } as never,
    });
  }
  writes.push({ action: 'put', collection: SCROBBLE, rkey: 'linked', record: LINKED as never });
  writes.push({ action: 'put', collection: SCROBBLE, rkey: 'r08', record: recordOf('r08') });
  await repo.writes(writes);
  // r08 is created and then deleted (TESTING.md): its absence must be proven.
  await repo.delete(SCROBBLE, 'r08');
  opts = (rkey, collection = SCROBBLE) => ({ did: ALICE, collection, rkey, signingKey: key.didKey });
});

describe('verifyRecordProof', () => {
  it('inclusion proof yields present with exact cid and record', async () => {
    expect(live.map((s) => s.rkey)).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07']);
    for (const s of live) {
      const car = await repo.getRecordCar(SCROBBLE, s.rkey);
      const proof = await verifyRecordProof(car, opts(s.rkey));
      expect(proof).toEqual({
        commit: expectedCommit(),
        collection: SCROBBLE,
        rkey: s.rkey,
        state: 'present',
        cid: cidOf(s.record),
        record: s.record,
      });
      expect(proof.state === 'present' && proof.cid).toBe((await repo.getRecord(SCROBBLE, s.rkey))!.cid);
    }

    // Links and bytes come back in JSON form, as plain objects.
    const linked = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, 'linked'), opts('linked'));
    expect(linked.state).toBe('present');
    if (linked.state !== 'present') throw new Error('unreachable');
    expect(linked.cid).toBe(cidOf(LINKED));
    expect(linked.record).toStrictEqual(LINKED);
    expect(JSON.parse(JSON.stringify(linked.record))).toStrictEqual(LINKED);

    // The full repository CAR proves the same record at the same head.
    const full = await verifyRecordProof(await repo.fullCar(), { ...opts('r01'), maxBytes: 1 << 20 });
    expect(full).toEqual({
      commit: expectedCommit(),
      collection: SCROBBLE,
      rkey: 'r01',
      state: 'present',
      cid: cidOf(recordOf('r01')),
      record: recordOf('r01'),
    });
  });

  it('exclusion proof yields absent', async () => {
    // r08: created, then deleted; the proof is at the head after the delete.
    const r08 = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, 'r08'), opts('r08'));
    expect(r08).toStrictEqual({ commit: expectedCommit(), collection: SCROBBLE, rkey: 'r08', state: 'absent' });

    // Keys that never existed: below, between and above the stored keys, and another collection.
    for (const [collection, rkey] of [
      [SCROBBLE, 'a'],
      [SCROBBLE, 'r035'],
      [SCROBBLE, 'zzz'],
      [`${P}.follow`, 'f00'],
    ] as const) {
      const proof = await verifyRecordProof(await repo.getRecordCar(collection, rkey), opts(rkey, collection));
      expect(proof).toStrictEqual({ commit: expectedCommit(), collection, rkey, state: 'absent' });
    }

    // At the head before the delete, the same key was present: proofs are per head.
    const before = repo.history.at(-2)!;
    const old = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, 'r08', { at: before.cid }), opts('r08'));
    expect(old.state).toBe('present');
    expect(old.commit).toEqual({ did: ALICE, cid: before.cid, rev: before.rev, dataCid: before.data, version: 3 });
    expect(before.rev < repo.head!.rev).toBe(true);

    // The full CAR proves the absence too.
    const full = await verifyRecordProof(await repo.fullCar(), opts('r08'));
    expect(full.state).toBe('absent');
  });

  it('removed path node yields missing_block, never absent', async () => {
    for (const rkey of ['r01', 'r06', 'r08', 'zzz']) {
      const path = `${SCROBBLE}/${rkey}`;
      const nodes = await pathNodes(path);
      // The tree is deep enough that every proof has at least two levels.
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(nodes).toContain(repo.head!.data);
      const car = await repo.getRecordCar(SCROBBLE, rkey);
      expect(new Set(parseCar(car).sections.map((s) => s.cid))).toEqual(
        new Set([
          repo.head!.cid,
          ...nodes,
          ...(rkey.startsWith('r0') && rkey !== 'r08' ? [cidOf(recordOf(rkey))] : []),
        ]),
      );
      for (const node of nodes) {
        expect(await codeOf(verifyRecordProof(dropBlock(car, node), opts(rkey)))).toBe('missing_block');
      }
    }
    // A missing record block (path complete) is missing_block as well.
    const r01 = await repo.getRecordCar(SCROBBLE, 'r01');
    expect(await codeOf(verifyRecordProof(dropBlock(r01, cidOf(recordOf('r01'))), opts('r01')))).toBe('missing_block');

    // A missing node in a full-repo CAR, on the path, is never mistaken for absence.
    const full = await repo.fullCar();
    const deepest = (await pathNodes(`${SCROBBLE}/r08`)).find((n) => n !== repo.head!.data)!;
    expect(await codeOf(verifyRecordProof(dropBlock(full, deepest), opts('r08')))).toBe('missing_block');
  });

  it('block byte change yields cid_mismatch; record CID swap yields record_cid_mismatch', async () => {
    const car = await repo.getRecordCar(SCROBBLE, 'r01');
    const recordCid = cidOf(recordOf('r01'));
    expect(await codeOf(verifyRecordProof(corruptBlockByte(car, recordCid), opts('r01')))).toBe('cid_mismatch');
    expect(await codeOf(verifyRecordProof(corruptMstNodeByte(car), opts('r01')))).toBe('cid_mismatch');
    for (const node of await pathNodes(`${SCROBBLE}/r01`)) {
      expect(await codeOf(verifyRecordProof(corruptBlockByte(car, node), opts('r01')))).toBe('cid_mismatch');
    }
    expect(await codeOf(verifyRecordProof(corruptBlockByte(car, repo.head!.cid), opts('r01')))).toBe('cid_mismatch');

    // Record CID swap at the store: the signed MST commits to r01's CID, but the
    // block store answers with r02's bytes. The bytes are re-hashed, never trusted.
    const { root, blocks } = readBoundedCar(car, {
      maxBytes: RECORD_PROOF_MAX_BYTES,
      maxBlocks: RECORD_PROOF_MAX_BLOCKS,
    });
    const commit = await verifyCommit(blocks, root, { did: ALICE, signingKey: key.didKey });
    const honest = await proveRecord(new ReadonlyMemoryBlockStore(blocks), commit, SCROBBLE, 'r01');
    expect(honest.state === 'present' && honest.cid).toBe(recordCid);
    const swapped = new Map(blocks);
    swapped.set(recordCid, new Uint8Array(encode(recordOf('r02'))));
    expect(await codeOf(proveRecord(new ReadonlyMemoryBlockStore(swapped), commit, SCROBBLE, 'r01'))).toBe(
      'record_cid_mismatch',
    );

    // The same swap inside a CAR cannot reach the store (only CID-verified blocks
    // enter it): the swapped block sits under its own CID, so the proven CID has
    // no block (tests/goldens/README.md, `record_cid_swap`).
    const carSwap = corruptRecordCidSwap(car, recordCid, recordOf('r02'));
    expect(await codeOf(verifyRecordProof(carSwap, opts('r01')))).toBe('missing_block');
  });

  it('truncated and oversize CARs are rejected before decode', async () => {
    const car = await repo.getRecordCar(SCROBBLE, 'r01');
    const parsed = parseCar(car);
    expect(await codeOf(verifyRecordProof(corruptTruncate(car), opts('r01')))).toBe('car_malformed');

    // Every proper prefix fails closed: inside a section it is car_malformed, at
    // a section boundary the CAR is well formed but incomplete (missing_block).
    const boundaries = new Set([parsed.headerEnd, ...parsed.sections.map((s) => s.end)]);
    for (let cut = 0; cut < car.length; cut++) {
      const code = await codeOf(verifyRecordProof(car.subarray(0, cut), opts('r01')));
      expect([cut, code]).toEqual([cut, boundaries.has(cut) ? 'missing_block' : 'car_malformed']);
    }

    // Bounds run before any block is hashed or decoded: a CAR whose first block
    // is corrupt AND whose last section is truncated reports the framing error,
    // not the hash error, and a header length past the input is never decoded.
    const corruptFirst = corruptBlockByte(car, parsed.sections[0]!.cid);
    expect(await codeOf(verifyRecordProof(corruptFirst, opts('r01')))).toBe('cid_mismatch');
    expect(await codeOf(verifyRecordProof(corruptTruncate(corruptFirst), opts('r01')))).toBe('car_malformed');
    const hugeHeader = new Uint8Array([...encodeVarint(2 ** 40), ...car.subarray(parsed.headerEnd)]);
    expect(await codeOf(verifyRecordProof(hugeHeader, opts('r01')))).toBe('car_malformed');
    const overlong = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, ...car]);
    expect(await codeOf(verifyRecordProof(overlong, opts('r01')))).toBe('car_malformed');

    // Unsupported CIDs are refused at framing: dag-pb codec, a CIDv0-style section.
    const s0 = parsed.sections[0]!;
    const cidAt = s0.end - s0.bytes.length - 36;
    const dagPb = new Uint8Array(car);
    dagPb[cidAt + 1] = 0x70;
    expect(await codeOf(verifyRecordProof(dagPb, opts('r01')))).toBe('car_malformed');
    const v0 = new Uint8Array(car);
    v0[cidAt] = 0x12;
    expect(await codeOf(verifyRecordProof(v0, opts('r01')))).toBe('car_malformed');

    // Oversize: one byte over the cap is car_too_large before any parse, even
    // for garbage; exactly at the cap it verifies.
    const atCap = await corruptOversize(car, RECORD_PROOF_MAX_BYTES);
    expect((await verifyRecordProof(atCap, opts('r01'))).state).toBe('present');
    const overCap = await corruptOversize(car, RECORD_PROOF_MAX_BYTES + 1);
    expect(await codeOf(verifyRecordProof(overCap, opts('r01')))).toBe('car_too_large');
    expect(await codeOf(verifyRecordProof(new Uint8Array(RECORD_PROOF_MAX_BYTES + 1).fill(0xff), opts('r01')))).toBe(
      'car_too_large',
    );
    expect(await codeOf(verifyRecordProof(car, { ...opts('r01'), maxBytes: car.length - 1 }))).toBe('car_too_large');
    expect((await verifyRecordProof(car, { ...opts('r01'), maxBytes: car.length })).state).toBe('present');

    // Block cap: counted from framing; one block over is car_too_large even when
    // the extra blocks are corrupt.
    const n = parsed.sections.length;
    expect(await codeOf(verifyRecordProof(car, { ...opts('r01'), maxBlocks: n - 1 }))).toBe('car_too_large');
    expect(await codeOf(verifyRecordProof(corruptFirst, { ...opts('r01'), maxBlocks: n - 1 }))).toBe('car_too_large');
    expect((await verifyRecordProof(car, { ...opts('r01'), maxBlocks: n })).state).toBe('present');

    // A raw-codec padding block is accepted by the bounds (records may be raw) and ignored.
    const rawBlock = new Uint8Array([1, 2, 3]);
    const rawCid = CID.toString(CID.createSync(CID.CODEC_RAW, rawBlock));
    const withRaw = encodeCar(parsed.roots, [
      ...parsed.sections.map((s) => [s.cid, s.bytes] as const),
      [rawCid, rawBlock],
    ]);
    expect(readBoundedCar(withRaw, { maxBytes: 1 << 20, maxBlocks: 64 }).blocks.get(rawCid)).toEqual(rawBlock);
    expect((await verifyRecordProof(withRaw, opts('r01'))).state).toBe('present');
    // Nothing else hides in the returned map: exactly the CAR's blocks, copied.
    const bounded = readBoundedCar(car, { maxBytes: 1 << 20, maxBlocks: 64 });
    expect([...bounded.blocks.keys()]).toEqual(parsed.sections.map((s) => s.cid));
    expect(bounded.blocks.get(s0.cid)!.buffer).not.toBe(car.buffer);
  });
});
