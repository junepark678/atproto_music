// W3-04 rejection matrix (ADR 0004 §7.6, §10.4; M4.1.2/tampering_matrix).
//
// For every corruption kit helper (packages/atproto/test-support/signed-repo.ts,
// each changing exactly one verification invariant of a real signed getRecord
// CAR), the fake PDS serves the corrupted CAR for a record version the index
// has not seen yet, and the production drain runs on it. The projection and
// checkpoint tables must stay byte-identical; then the same record, served
// valid, applies. Outcomes per kind are hardcoded.

import type { FixtureKit } from '@atmusic/atproto/test-support/read-models';
import { carResponse } from '@atmusic/atproto/test-support/router-transport';
import {
  carCommit,
  corruptBlockByte,
  corruptDid,
  corruptMstNodeByte,
  corruptMstStructure,
  corruptOversize,
  corruptRecordCidSwap,
  corruptRev,
  corruptRoot,
  corruptSignature,
  corruptSignatureHighS,
  corruptTruncate,
  corruptVersion,
  dropBlock,
} from '@atmusic/atproto/test-support/signed-repo';
import { describe, expect, it } from 'vitest';
import { drain } from '../../src/do/ingest/verify-drain';
import { seedUser } from '../write/support';
import { counterValue, depsFor, enqueue, GET_RECORD, hint, kit, protectedTables } from './drain-support';
import { withIngestIndex } from './node-index';

interface Case {
  kind: string;
  corrupt(car: Uint8Array<ArrayBuffer>, ctx: { k: FixtureKit; recordCid: string }): Promise<Uint8Array<ArrayBuffer>>;
  /** The drain outcome and detail for the corrupted proof. */
  outcome: string;
  detail: string;
  /** The counter the rejection increments. */
  counter: [name: string, label: string];
}

const sync = (f: (car: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) => async (car: Uint8Array<ArrayBuffer>) =>
  f(car);

const CASES: Case[] = [
  {
    kind: 'signature',
    corrupt: async (car) => corruptSignature(car),
    outcome: 'verify_failed',
    detail: 'bad_signature',
    counter: ['verify_failed', 'bad_signature'],
  },
  {
    kind: 'signature_high_s',
    corrupt: async (car) => corruptSignatureHighS(car, 'secp256k1'),
    outcome: 'verify_failed',
    detail: 'bad_signature',
    counter: ['verify_failed', 'bad_signature'],
  },
  {
    kind: 'record_block_byte',
    corrupt: async (car, { recordCid }) => corruptBlockByte(car, recordCid),
    outcome: 'verify_failed',
    detail: 'cid_mismatch',
    counter: ['verify_failed', 'cid_mismatch'],
  },
  {
    kind: 'mst_node_byte',
    corrupt: sync(corruptMstNodeByte),
    outcome: 'verify_failed',
    detail: 'cid_mismatch',
    counter: ['verify_failed', 'cid_mismatch'],
  },
  {
    kind: 'mst_structure',
    corrupt: (car, { k }) => corruptMstStructure(car, k.keys.alice),
    outcome: 'verify_failed',
    detail: 'mst_invalid',
    counter: ['verify_failed', 'mst_invalid'],
  },
  {
    kind: 'did',
    corrupt: (car, { k }) => corruptDid(car, k.keys.alice),
    outcome: 'verify_failed',
    detail: 'did_mismatch',
    counter: ['verify_failed', 'did_mismatch'],
  },
  {
    kind: 'version',
    corrupt: (car, { k }) => corruptVersion(car, k.keys.alice),
    outcome: 'verify_failed',
    detail: 'bad_version',
    counter: ['verify_failed', 'bad_version'],
  },
  {
    kind: 'rev',
    corrupt: (car, { k }) => corruptRev(car, k.keys.alice),
    outcome: 'verify_failed',
    detail: 'bad_rev',
    counter: ['verify_failed', 'bad_rev'],
  },
  {
    // The header names a commit the CAR does not hold: no proof here (F4 → snapshot).
    kind: 'root',
    corrupt: sync(corruptRoot),
    outcome: 'snapshot_scheduled',
    detail: 'missing_block',
    counter: ['verify_failed', 'missing_block'],
  },
  {
    kind: 'truncate',
    corrupt: async (car) => corruptTruncate(car),
    outcome: 'snapshot_scheduled',
    detail: 'car_malformed',
    counter: ['verify_failed', 'car_malformed'],
  },
  {
    // Over the 1 MiB getRecord cap: SafeFetch cancels the body; nothing is parsed.
    kind: 'oversize',
    corrupt: (car) => corruptOversize(car),
    outcome: 'fetch_failed',
    detail: 'fetch:body_too_large',
    counter: ['proof_fetch_failed', 'body_too_large'],
  },
  {
    // The record block is swapped for another valid block: the committed CID has no block.
    kind: 'record_cid_swap',
    corrupt: async (car, { recordCid }) => corruptRecordCidSwap(car, recordCid, { $type: 'forged', artist: 'Mallory' }),
    outcome: 'snapshot_scheduled',
    detail: 'missing_block',
    counter: ['verify_failed', 'missing_block'],
  },
  {
    // The MST root node is dropped: the path is incomplete, never "absent".
    kind: 'drop_mst_node',
    corrupt: async (car) => dropBlock(car, carCommit(car).data.$link),
    outcome: 'snapshot_scheduled',
    detail: 'missing_block',
    counter: ['verify_failed', 'missing_block'],
  },
];

describe('rejection matrix', () => {
  it('each single-invariant corruption leaves scrobbles/follows/record_state/users/ingest_checkpoint byte-identical, then a valid hint applies', async () => {
    const k = await kit();
    const alice = k.users.Alice.did;
    const S = k.collections.scrobble;

    await withIngestIndex(async (i) => {
      const db = i.db;
      const m = depsFor(db, k);
      seedUser(db, alice);
      // A baseline row, so "byte-identical" covers a non-empty projection.
      await k.externalPut('Alice', S, 'base', {
        $type: S,
        artist: 'Radiohead',
        track: 'Reckoner',
        listenedAt: '2026-01-15T10:00:00Z',
        createdAt: '2026-01-15T10:00:00Z',
      });
      enqueue(db, [hint(k, alice, S, 'base')]);
      expect((await drain(m, k.clock.nowMs())).outcomes).toEqual([
        { uri: `at://${alice}/${S}/base`, outcome: 'applied' },
      ]);

      const seen: Array<{ kind: string; outcome: string; detail?: string }> = [];
      for (const [n, c] of CASES.entries()) {
        // A record version the index has not seen yet, at a new signed head.
        const rkey = `c${String(n).padStart(2, '0')}`;
        const uri = `at://${alice}/${S}/${rkey}`;
        const put = await k.externalPut('Alice', S, rkey, {
          $type: S,
          artist: 'Kate Bush',
          track: `Case ${c.kind}`,
          listenedAt: '2026-01-15T10:30:00Z',
          createdAt: '2026-01-15T10:30:00Z',
        });
        const valid = await k.repos.Alice.getRecordCar(S, rkey);
        const corrupted = await c.corrupt(valid, { k, recordCid: put.ops[0]!.cid! });
        expect(corrupted).not.toEqual(valid);

        k.clock.advance(600_000); // past any backoff of the previous case
        const before = protectedTables(db);
        const counterBefore = counterValue(db, ...c.counter);
        const calls = k.pds.Alice.calls.count({ nsid: GET_RECORD });
        const documents = k.plc.count(alice);
        k.pds.Alice.fail({ nsid: GET_RECORD }, { kind: 'respond', respond: () => carResponse(corrupted) });
        enqueue(db, [hint(k, alice, S, rkey)]);
        const rejected = await drain(m, k.clock.nowMs());
        expect(rejected.outcomes).toHaveLength(1);
        seen.push({ kind: c.kind, ...rejected.outcomes[0]! });
        expect(k.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(calls + 1);
        // The identity entry expired (10 min passed): one resolution, plus exactly one
        // fresh retry for a signature failure, never more.
        expect(k.plc.count(alice)).toBe(documents + (c.detail === 'bad_signature' ? 2 : 1));

        // Fail closed: the projection and the checkpoint did not move.
        expect(protectedTables(db)).toEqual(before);
        expect(db.one('SELECT uri FROM scrobbles WHERE uri = ?', uri)).toBeNull();
        expect(db.one('SELECT uri FROM record_state WHERE uri = ?', uri)).toBeNull();
        expect(counterValue(db, ...c.counter)).toBe(counterBefore + 1);

        // The same record served valid applies (a fresh hint; the fault was consumed).
        k.clock.advance(600_000);
        enqueue(db, [hint(k, alice, S, rkey)]);
        const accepted = await drain(m, k.clock.nowMs());
        expect(accepted.outcomes).toEqual([{ uri, outcome: 'applied' }]);
        expect(db.one('SELECT revision, cid, track FROM scrobbles WHERE uri = ?', uri)).toEqual({
          revision: put.rev,
          cid: put.ops[0]!.cid,
          track: `Case ${c.kind}`,
        });
        expect(db.one('SELECT count(*) AS n FROM hints WHERE uri = ?', uri)).toEqual({ n: 0 });
      }

      expect(seen).toEqual(
        CASES.map((c) => ({ kind: c.kind, uri: expect.any(String), outcome: c.outcome, detail: c.detail })),
      );
      // Every case's record (and the baseline) is now indexed exactly once.
      expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE did = ?', alice)).toEqual({ n: CASES.length + 1 });
      // Both signature cases were counted (each after its one fresh retry).
      expect(counterValue(db, 'verify_failed', 'bad_signature')).toBe(2);
    });
  });
});
