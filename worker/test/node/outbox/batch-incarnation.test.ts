// Removal receipts and verified incarnations (ADR 0006; migration 10).
//
// A succeeded batch-listen removal suppresses only the incarnation it removed.
// Settlement timing is not repository order: the removal's server-checked
// head (migration 11) is. A recreation committed after it is visible (at a new
// or the same CID), while a delayed older proof or a pending or failed local
// intent stays hidden. A legacy receipt without a head keeps the migration 10
// rule (a verified absence newer than its fence starts a new incarnation).

import { expect, it } from 'vitest';
import { recordStatus } from '../../../src/do/ingest/notify';
import { exportUser } from '../../../src/do/read/export';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { markInactive } from '../../../src/do/write/account-state';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { disconnectLocalData } from '../../../src/do/write/suppression';
import { removeScrobble } from '../../../src/lastfm/write-methods';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { proofAt } from '../../write/support';
import { type Harness, PUT, remoteRecords, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2incarnab2';
const TARGET = '3lb2batchidab';
const SIBLING = '3lb2batchidac';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };

const entry = (id: string, track: string, extra: Record<string, unknown> = {}) => ({
  id,
  artist: 'Incarnation Artist',
  track,
  listenedAt: id === TARGET ? '2026-01-14T12:00:00Z' : '2026-01-14T13:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
  ...extra,
});
/** The admission bytes: two listens, with unknown envelope and entry fields. */
const ORIGINAL = {
  $type: BATCH,
  createdAt: '2026-01-15T12:00:00Z',
  remoteEnvelopeField: 'keep',
  listens: [entry(TARGET, 'Target', { remoteEntryField: 'keep' }), entry(SIBLING, 'Sibling')],
};

const container = (h: Harness) => `at://${h.alice}/${BATCH}/${RKEY}`;
const item = (h: Harness, id: string) => `${container(h)}#${id}`;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string; cid: string }>(
      `SELECT s.listen_id, s.cid FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`,
    )
    .map((row) => row.listen_id);
const applyCurrent = async (h: Harness) => {
  const proof = await proofAt(h.kit.repos.Alice, BATCH, RKEY);
  const result = h.db.tx(() => applyRecordProof(h.db, proof, OPTIONS));
  return { proof, result };
};
const status = (h: Harness, id: string) => {
  h.db.run('DELETE FROM hints');
  return recordStatus(h.m, item(h, id));
};
const removeTargetViaLastfm = (h: Harness) =>
  removeScrobble(h.m, {
    did: h.alice,
    artist: 'Incarnation Artist',
    track: 'Target',
    timestamp: Date.parse('2026-01-14T12:00:00Z') / 1000,
  });
const remoteIds = async (h: Harness) =>
  (await remoteRecords(h.kit, 'Alice', BATCH)).flatMap((r) =>
    (r.value as { listens: Array<{ id: string }> }).listens.map((e) => e.id),
  );

async function admitted(h: Harness, listenIds: string[]) {
  h.seedUser(h.alice);
  await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
  const admission = await applyCurrent(h);
  expect(visible(h)).toEqual([TARGET, SIBLING]);
  const removal = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container(h), listenIds, origin: 'web' });
  return { admission: admission.proof, removal };
}

/** Runs `during` inside the removal's read-back, after the write committed and before local settlement. */
function beforeSettlement(h: Harness, during: () => Promise<void>): void {
  const writerFor = h.writers.writerFor.bind(h.writers);
  let gets = 0;
  h.writers.writerFor = async (did: string) => {
    const writer = (await writerFor(did))!;
    return {
      ...writer,
      fetchHandler: async (path: string, init: RequestInit) => {
        const response = await writer.fetchHandler(path, init);
        if (path.includes('com.atproto.repo.getRecord') && ++gets === 2) await during();
        return response;
      },
    };
  };
}

it.each([
  { name: 'a new CID', restored: { ...ORIGINAL, remoteEnvelopeField: 'restored elsewhere' }, sameCid: false },
  { name: 'the same bytes and CID', restored: ORIGINAL, sameCid: true },
])(
  'a recreation at $name proved between the removal commit and its local settlement stays visible and removable',
  async ({ restored, sameCid }) => {
    await withHarness(async (h) => {
      const { admission, removal } = await admitted(h, [TARGET]);
      const before = h.db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did=?', h.alice)!;
      let recreatedCid = '';
      beforeSettlement(h, async () => {
        // The removal is committed: its verified result proves the target absent,
        await applyCurrent(h);
        expect(h.db.one('SELECT state FROM verified_membership WHERE listen_id = ?', TARGET)).toEqual({
          state: 'absent',
        });
        // then a later revision restores it, verified too, all before settlement.
        await h.kit.externalPut('Alice', BATCH, RKEY, restored);
        const { proof } = await applyCurrent(h);
        recreatedCid = proof.state === 'present' ? proof.cid : '';
      });
      await h.runUntilIdle();
      h.db.run('DELETE FROM hints');

      const op = h.op(removal.id);
      expect(op.state).toBe('succeeded');
      expect(op.swap_cid).toBe(admission.state === 'present' ? admission.cid : null);
      expect(recreatedCid === op.swap_cid).toBe(sameCid);
      // Settlement captured nothing: the evidence is the pre-write CID only.
      expect(h.db.all('SELECT cid FROM listen_removal_cids WHERE operation_id = ?', removal.id)).toEqual([
        { cid: op.swap_cid },
      ]);
      expect(visible(h)).toEqual([TARGET, SIBLING]);
      expect(status(h, TARGET)).toMatchObject({ state: 'indexed', cid: recreatedCid });
      // Settlement moved the stats version (visibility changed with it).
      expect(
        h.db.one<{ stats_version: number }>('SELECT stats_version FROM users WHERE did=?', h.alice)!.stats_version,
      ).toBeGreaterThan(before.stats_version);
      expect(exportUser(h.m, h.alice)?.scrobbles.map((s) => s.uri)).toContain(item(h, TARGET));

      // Last.fm sees it and removes the new incarnation, keeping the sibling and unknown fields.
      const again = await removeTargetViaLastfm(h);
      expect(again).toHaveLength(1);
      await h.runUntilIdle();
      expect(await remoteIds(h)).toEqual([SIBLING]);
      expect((await remoteRecords(h.kit, 'Alice', BATCH))[0]!.value).toMatchObject({
        remoteEnvelopeField: sameCid ? 'keep' : 'restored elsewhere',
      });
      expect(visible(h)).toEqual([SIBLING]);
    });
  },
);

it('a whole-container removal is outlived by a verified absence and a byte-identical restore', async () => {
  await withHarness(async (h) => {
    const { admission, removal } = await admitted(h, ['*']);
    await h.runUntilIdle();
    expect(h.op(removal.id).state).toBe('succeeded');
    expect(visible(h)).toEqual([]);
    const absent = await applyCurrent(h);
    expect(absent.proof.state).toBe('absent');
    expect(status(h, TARGET)).toMatchObject({ state: 'absent', revision: absent.proof.commit.rev });

    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const restored = await applyCurrent(h);
    expect(restored.proof.state === 'present' && restored.proof.cid).toBe(
      admission.state === 'present' && admission.cid,
    );
    expect(restored.proof.commit.rev > absent.proof.commit.rev).toBe(true);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
    expect(status(h, TARGET)).toMatchObject({ state: 'indexed', revision: restored.proof.commit.rev });

    // An older, delayed proof cannot reach back across the boundary.
    expect(['stale_head', 'noop_older']).toContain(h.db.tx(() => applyRecordProof(h.db, admission, OPTIONS)).outcome);
    expect(h.db.one('SELECT state FROM verified_membership WHERE listen_id = ?', TARGET)).toEqual({ state: 'present' });
    expect(visible(h)).toEqual([TARGET, SIBLING]);

    expect(await removeTargetViaLastfm(h)).toHaveLength(1);
    await h.runUntilIdle();
    expect(await remoteIds(h)).toEqual([SIBLING]);
    expect(visible(h)).toEqual([SIBLING]);
  });
});

it('a partial removal is outlived by a verified entry absence and the reinsertion of identical container bytes', async () => {
  await withHarness(async (h) => {
    const { admission, removal } = await admitted(h, [TARGET]);
    await h.runUntilIdle();
    expect(h.op(removal.id).state).toBe('succeeded');
    // A delayed pre-removal proof, before any verified absence: still hidden.
    expect(visible(h)).toEqual([SIBLING]);
    await applyCurrent(h);
    expect(
      h.db.one(
        'SELECT state, last_absent_revision IS NOT NULL AS boundary FROM verified_membership WHERE listen_id=?',
        TARGET,
      ),
    ).toEqual({
      state: 'absent',
      boundary: 1,
    });
    expect(status(h, TARGET)).toMatchObject({ state: 'absent' });
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const restored = await applyCurrent(h);
    expect(restored.proof.state === 'present' && restored.proof.cid).toBe(
      admission.state === 'present' && admission.cid,
    );
    expect(visible(h)).toEqual([TARGET, SIBLING]);
    expect(await removeTargetViaLastfm(h)).toHaveLength(1);
    await h.runUntilIdle();
    expect(await remoteIds(h)).toEqual([SIBLING]);
  });
});

it('a byte-identical restore committed after the fenced removal is a later incarnation even with no verified absence in between', async () => {
  await withHarness(async (h) => {
    const { admission, removal } = await admitted(h, ['*']);
    await h.runUntilIdle();
    const op = h.op(removal.id);
    // The owner restores identical bytes before this index observed the
    // deletion. The removal's server-checked head orders the two incarnations.
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const restored = await applyCurrent(h);
    expect(restored.proof.state === 'present' && restored.proof.cid).toBe(
      admission.state === 'present' && admission.cid,
    );
    expect(restored.proof.commit.rev > op.removal_head_rev!).toBe(true);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
    expect(status(h, TARGET)).toMatchObject({ state: 'indexed', revision: restored.proof.commit.rev });
  });
});

it('a legacy receipt (no server-checked head) keeps its migration 9/10 rule: with no verified absence, same-CID stays removed', async () => {
  await withHarness(async (h) => {
    const { admission, removal } = await admitted(h, ['*']);
    await h.runUntilIdle();
    // Settled before migration 11: no head fence was ever recorded.
    h.db.run(
      'UPDATE operations SET removal_head_rev = NULL, removal_commit_rev = NULL, removal_done_rev = NULL, removal_done_basis = NULL WHERE id = ?',
      removal.id,
    );
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    await applyCurrent(h);
    expect(h.db.one('SELECT cid FROM record_state WHERE uri = ?', container(h))).toEqual({
      cid: admission.state === 'present' ? admission.cid : null,
    });
    expect(visible(h)).toEqual([]);
    expect(status(h, TARGET)).toMatchObject({ state: 'unknown' });
  });
});

it.each([
  { name: 'queued', state: 'queued' },
  { name: 'blocked', state: 'blocked' },
  { name: 'failed', state: 'failed' },
])('a $name local removal keeps hiding the target through a verified absence and recreation', async ({ state }) => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, [TARGET]);
    h.db.run('UPDATE operations SET state = ? WHERE id = ?', state, removal.id);
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, listens: [entry(SIBLING, 'Sibling')] });
    await applyCurrent(h);
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    await applyCurrent(h);
    // The unproven intent is never cleared by the arriving events.
    expect(h.op(removal.id).state).toBe(state);
    expect(visible(h)).toEqual([SIBLING]);
    expect(status(h, TARGET)).toMatchObject({ state: 'unknown' });
  });
});

it('verified snapshot sweeps and entries set the same incarnation boundary as live proofs', async () => {
  await withHarness(async (h) => {
    const { removal } = await admitted(h, ['*']);
    await h.runUntilIdle();
    expect(h.op(removal.id).state).toBe('succeeded');
    const generation = h.db.one<{ generation: number }>(
      'SELECT generation FROM users WHERE did = ?',
      h.alice,
    )!.generation;
    h.db.run(
      `INSERT INTO repo_jobs(did, kind, state, generation, reactivate, due_at, updated_at_ms)
       VALUES (?, 'snapshot', 'running', ?, 0, ?, ?)`,
      h.alice,
      generation,
      T0,
      T0,
    );
    const chunk = (headRev: string, entries: Array<{ key: string; cid: string; record?: unknown }>) =>
      h.db.tx(() =>
        applySnapshotChunk(h.db, {
          did: h.alice,
          generation,
          headRev,
          intervalLo: `${PREFIX}.`,
          intervalHi: `${BATCH}/${RKEY}`,
          entries,
          receiptNs: OPTIONS.receiptNs,
          prefix: PREFIX,
          nowNs: OPTIONS.nowNs,
        }),
      );
    // The deleted container is swept absent at the snapshot head,
    expect(chunk(h.kit.repos.Alice.head!.rev, [])).toMatchObject({ outcome: 'applied', deleted: 1 });
    // and a later snapshot finds the identical bytes again.
    const put = await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const restored = await h.kit.repos.Alice.getRecord(BATCH, RKEY);
    expect(
      chunk(h.kit.repos.Alice.head!.rev, [{ key: `${BATCH}/${RKEY}`, cid: put.ops[0]!.cid!, record: restored!.value }]),
    ).toMatchObject({ outcome: 'applied', written: 1 });
    expect(visible(h)).toEqual([TARGET, SIBLING]);
  });
});

it('privacy: an inactive owner discloses neither the restored listen nor its membership, and disconnect purges membership', async () => {
  await withHarness(async (h) => {
    await admitted(h, [TARGET]);
    await h.runUntilIdle();
    await applyCurrent(h);
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    await applyCurrent(h);
    expect(visible(h)).toEqual([TARGET, SIBLING]);
    h.db.tx(() => markInactive(h.db, h.alice, 'deactivated'));
    expect(visible(h)).toEqual([]);
    expect(status(h, TARGET)).toMatchObject({ state: 'unknown' });
    expect(status(h, '3lb2batchidaz')).toMatchObject({ state: 'unknown' });
    h.db.tx(() =>
      disconnectLocalData(h.db, h.alice, {
        settingsUri: `at://${h.alice}/${PREFIX}.settings/self`,
        settingsRev: '3mchjvhag2z22',
        nowNs: OPTIONS.nowNs,
      }),
    );
    expect(h.db.all('SELECT * FROM verified_membership')).toEqual([]);
  });
});

it('the fence is the server-checked head of the write, not the verified revision; the commit revision is kept too', async () => {
  await withHarness(async (h) => {
    const { admission, removal } = await admitted(h, [TARGET]);
    expect(h.op(removal.id)).toMatchObject({ removal_fence_rev: admission.commit.rev, removal_head_rev: null });
    // The owner edits the container (an envelope field); this index never sees it.
    await h.kit.externalPut('Alice', BATCH, RKEY, { ...ORIGINAL, remoteEnvelopeField: 'edited' });
    const edited = h.kit.repos.Alice.head!;
    await h.runUntilIdle();
    const removed = h.kit.repos.Alice.head!;
    expect(h.op(removal.id)).toMatchObject({
      state: 'succeeded',
      // Untouched local admission fence; the PDS-checked head and commit decide.
      removal_fence_rev: admission.commit.rev,
      removal_head_rev: edited.rev,
      removal_commit_rev: removed.rev,
    });
    expect(h.writers.sent.find((r) => r.nsid === PUT)!.body).toMatchObject({ swapCommit: edited.cid });
    expect(h.writers.count(PUT)).toBe(1);
    // The pre-removal edited version proved later is the removed incarnation.
    expect(visible(h)).toEqual([SIBLING]);
  });
});
