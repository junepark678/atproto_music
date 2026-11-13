// applyWrites batching and bisection, and the PdsWriter path (ADR 0005 §5.8
// "Batching", "Writer port", §3.5; N2-05).

import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { OperationRow } from '../../../src/app/rows';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { projectionListenKey } from '../../../src/forward/projection';
import { createJob } from '../../../src/imports/jobs';
import { encodeBatch, MAX_BATCH_BYTES } from '../../../src/outbox/apply-writes';
import { batchDeleteExecutor, enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { acceptListens } from '../../../src/outbox/ingress';
import { insertOperation, newOperationId, prepare } from '../../../src/outbox/operations';
import type { ExecContext } from '../../../src/outbox/runner';
import { enqueueScrobbleCreates, insertScrobbleCreate } from '../../../src/outbox/scrobble-ops';
import { authorizedLiveOptions, proofAt } from '../../write/support';
import {
  APPLY,
  CREATE,
  GET,
  type Harness,
  HEAD,
  listenInput,
  PUT,
  remoteRecords,
  SCROBBLE,
  T0,
  withHarness,
  zeroJitter,
} from './support';

const BATCH = 'com.example.atmusic.scrobbleBatch';

async function importCreates(h: Harness, n: number, did = h.alice): Promise<OperationRow[]> {
  const r = await enqueueScrobbleCreates(h.m, {
    did,
    origin: 'import',
    inputs: Array.from({ length: n }, (_, i) => listenInput(i)),
    importJobId: 'job-1',
  });
  if (!r.ok) throw new Error(JSON.stringify(r.reason));
  return r.operations;
}

/** Records written per rkey by the fake PDS's commits. */
function commitCounter(h: Harness, name: 'Alice' | 'Bob'): Map<string, number> {
  const writes = new Map<string, number>();
  h.kit.pds[name].onCommit((_did, commit) => {
    for (const op of commit.ops) {
      if (op.action === 'delete') continue;
      writes.set(op.rkey, (writes.get(op.rkey) ?? 0) + 1);
    }
  });
  return writes;
}

it('437 import creates go as applyWrites batches of 200, 200 and 37; a 250 KB-record set splits to stay under 1,000,000 bytes', async () => {
  await withHarness(async (h) => {
    const ops = await importCreates(h, 437);
    expect(ops.every((o) => o.priority === 1 && o.origin === 'import' && o.import_job_id === 'job-1')).toBe(true);
    const reports = await h.runUntilIdle();
    expect(reports.flatMap((r) => r.batches)).toEqual([200, 200, 37]);
    expect(h.writers.order()).toEqual([APPLY, APPLY, APPLY]);
    expect(h.writers.sent.map((s) => (s.body!.writes as unknown[]).length)).toEqual([200, 200, 37]);
    // FIFO: the batches carry the operations in their persisted order and rkeys.
    expect(h.writers.sent.flatMap((s) => (s.body!.writes as { rkey: string }[]).map((w) => w.rkey))).toEqual(
      ops.map((o) => o.rkey),
    );
    expect(h.ops().every((o) => o.state === 'succeeded' && o.attempts === 1 && o.result_cid !== null)).toBe(true);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(437);
    // 437 creates × 3 points, charged before sending and confirmed by the PDS headers.
    expect(h.db.one('SELECT points FROM pds_budget WHERE did = ? AND window = ?', h.alice, 'hour')).toEqual({
      points: 1311,
    });
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 1311);

    // Six records of about 250 KB each: four would exceed the 1,000,000-byte body limit.
    const big = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        prepare({
          $type: SCROBBLE,
          artist: `Long ${i}`,
          track: 'x'.repeat(250_000),
          listenedAt: new Date(T0 - (i + 1) * 60_000).toISOString(),
          createdAt: '2026-01-15T12:00:00Z',
        }),
      ),
    );
    const bigOps = h.db.tx(() =>
      big.map((prepared) => insertScrobbleCreate(h.m, { did: h.bob, origin: 'import', prepared }, T0)),
    );
    expect(encodeBatch(h.bob, bigOps.slice(0, 4)).bytes).toBeGreaterThan(MAX_BATCH_BYTES);
    const mark = h.seen.length;
    const bigReports = await h.runUntilIdle();
    expect(bigReports.flatMap((r) => r.batches)).toEqual([3, 3]);
    const applies = h.seen.slice(mark).filter((s) => s.url.endsWith(`/xrpc/${APPLY}`));
    expect(applies).toHaveLength(2);
    for (const request of applies) {
      expect(request.bytes).toBeGreaterThan(750_000);
      expect(request.bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    // The fake PDS (jsonLimit 1,000,000) accepted both; nothing was refused as 413.
    expect(h.kit.pds.Bob.calls.filter({ nsid: APPLY }).map((c) => c.status)).toEqual([200, 200]);
    expect(bigOps.every((o) => h.op(o.id).state === 'succeeded')).toBe(true);
    expect(await remoteRecords(h.kit, 'Bob', SCROBBLE)).toHaveLength(6);
  });
});

it('keeps legacy never-sent import singles dormant even with the batch gate open', async () => {
  await withHarness(async (h) => {
    const [op] = await importCreates(h, 1);
    createJob(h.db, { id: 'job-1', did: h.alice, source: 'lastfm_json', remoteUser: null, now: T0 });
    const record = JSON.parse(op!.record_json!) as { listenedAt: string };
    h.db.run(
      "INSERT INTO import_items(job_id, seq, dedupe_key, listened_at, record_json, state, operation_id) VALUES ('job-1', 0, 'legacy-key', ?, ?, 'queued', ?)",
      record.listenedAt,
      JSON.stringify({ kind: 'listen', input: listenInput(0) }),
      op!.id,
    );
    h.m.config = { ...h.m.config, batchPublication: true };
    const report = await h.run();
    expect(report).toMatchObject({ attempted: 0, nextDueMs: null });
    expect(h.writers.sent).toEqual([]);
    expect(h.op(op!.id)).toMatchObject({ state: 'queued', attempts: 0, send_started_at_ms: null });
  });
});

it('excludes attempted batch operations while the batch gate is closed without parking their DID', async () => {
  await withHarness(async (h) => {
    const record = {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: [
        {
          id: '3lb2batchentry1',
          artist: 'Artist',
          track: 'Track',
          listenedAt: '2026-01-14T12:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
        },
      ],
    };
    const batch = h.db.tx(() =>
      insertOperation(
        h.db,
        {
          id: newOperationId(h.m.random),
          did: h.alice,
          kind: 'scrobble.create',
          origin: 'import',
          collection: BATCH,
          rkey: '3lb2batchcontainer1',
          prepared: { record, digest: 'digest' },
          dueAt: T0,
          importJobId: 'job-gated',
        },
        T0,
      ),
    );
    h.db.run('UPDATE operations SET attempts = 1, send_started_at_ms = ? WHERE id = ?', T0, batch.id);
    const live = await enqueueScrobbleCreates(h.m, { did: h.bob, origin: 'web', inputs: [listenInput(999)] });
    expect(live.ok).toBe(true);
    h.m.config = { ...h.m.config, batchPublication: false };

    const report = await h.run();
    expect(report.attempted).toBe(1);
    expect(h.writers.sent.every((request) => request.did !== h.alice)).toBe(true);
    expect(h.op(batch.id)).toMatchObject({ state: 'queued', attempts: 1 });
  });
});

it('removes one indexed batch listen with CAS and preserves sibling and unknown remote fields', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const uriKey = '3lb2batchcontainer1';
    const record = {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      remoteEnvelopeField: { keep: true },
      listens: [
        {
          id: '3lb2batchidab',
          artist: 'Artist',
          track: 'Removed',
          listenedAt: '2026-01-14T12:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
          remoteEntryField: 'keep too',
        },
        {
          id: '3lb2batchidac',
          artist: 'Artist',
          track: 'Sibling',
          listenedAt: '2026-01-14T13:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
          remoteSiblingField: { exact: 'preserve' },
        },
      ],
    };
    await h.kit.externalPut('Alice', BATCH, uriKey, record);
    const [artistKey, trackKeyValue] = trackKey('Artist', 'Removed');
    const removedAt = toStorage(BigInt(Math.floor(Date.parse('2026-01-14T12:00:00Z') / 1000)) * NS_PER_SECOND);
    h.db.run(
      `INSERT INTO scrobbles(uri,record_uri,listen_id,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
       VALUES(?,?,?,?,?,?,'rev','Artist','Removed',?,?,?, ?,?)`,
      `at://${h.alice}/${BATCH}/${uriKey}#3lb2batchidab`,
      `at://${h.alice}/${BATCH}/${uriKey}`,
      '3lb2batchidab',
      'cid',
      h.alice,
      uriKey,
      removedAt,
      removedAt,
      removedAt,
      artistKey,
      trackKeyValue,
    );
    const linkId = h.link(h.alice, 'listenbrainz');
    const identityKey = projectionListenKey(h.alice, removedAt, artistKey, trackKeyValue);
    h.db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,generation)
      VALUES('sent-batch-row',?,?,'scrobble',?,'{}','sent',1,?,?,?,1)`,
      linkId,
      h.alice,
      identityKey,
      T0,
      T0,
      T0,
    );
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${uriKey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    expect(h.db.one('SELECT listen_id FROM batch_delete_listens WHERE operation_id=?', del.id)).toEqual({
      listen_id: '3lb2batchidab',
    });
    expect(h.db.all('SELECT identity_key,listened_at,track,state FROM listenbrainz_deletes')).toEqual([
      { identity_key: identityKey, listened_at: 1768392000, track: 'Removed', state: 'queued' },
    ]);
    expect(
      h.db.one(
        "SELECT listen_second FROM linked_pull_tombstones WHERE did=? AND kind='listen' AND listen_second=1768392000",
        h.alice,
      ),
    ).not.toBeNull();
    await h.runUntilIdle();
    expect(h.op(del.id)).toMatchObject({ state: 'succeeded', collection: BATCH });
    const value = (await remoteRecords(h.kit, 'Alice', BATCH)).find((item) => item.rkey === uriKey);
    expect(value!.value).toMatchObject({
      remoteEnvelopeField: { keep: true },
      listens: [{ id: '3lb2batchidac', track: 'Sibling', remoteSiblingField: { exact: 'preserve' } }],
    });
    expect(h.writers.sent.filter((request) => request.nsid === PUT).map((request) => request.body)).toHaveLength(1);
    const whole = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${uriKey}`,
      listenIds: ['*'],
      origin: 'web',
    });
    await h.runUntilIdle();
    expect(h.op(whole.id)).toMatchObject({ state: 'succeeded' });
    expect((await remoteRecords(h.kit, 'Alice', BATCH)).some((item) => item.rkey === uriKey)).toBe(false);
  });
});

it('re-reads after InvalidSwap and preserves a concurrent remote edit while removing only its target', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    const record = {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: [
        {
          id: '3lb2batchidab',
          artist: 'Artist',
          track: 'Removed',
          listenedAt: '2026-01-14T12:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
        },
        {
          id: '3lb2batchidac',
          artist: 'Artist',
          track: 'Sibling',
          listenedAt: '2026-01-14T13:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
          siblingRemoteField: 'keep',
        },
      ],
    };
    await h.kit.externalPut('Alice', BATCH, rkey, record);
    enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    h.kit.pds.Alice.fail(
      { nsid: PUT },
      {
        kind: 'respond',
        respond: async () => {
          await h.kit.externalPut('Alice', BATCH, rkey, { ...record, concurrentRemoteField: { retained: true } });
          return Response.json({ error: 'InvalidSwap', message: 'record revision changed' }, { status: 400 });
        },
      },
    );

    await h.runUntilIdle();

    expect(h.writers.count(PUT)).toBe(2);
    const current = (await remoteRecords(h.kit, 'Alice', BATCH)).find((item) => item.rkey === rkey);
    expect(current!.value).toMatchObject({
      concurrentRemoteField: { retained: true },
      listens: [{ id: '3lb2batchidac', siblingRemoteField: 'keep' }],
    });
  });
});

it('serializes two independent listen removals for one container and keeps the third entry', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    await h.kit.externalPut('Alice', BATCH, rkey, {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: ['ab', 'ac', 'ad'].map((suffix, index) => ({
        id: `3lb2batchid${suffix}`,
        artist: 'Artist',
        track: `Track ${index}`,
        listenedAt: `2026-01-14T1${index}:00:00Z`,
        createdAt: '2026-01-15T12:00:00Z',
      })),
    });
    const first = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    const second = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidac'],
      origin: 'web',
    });

    expect(h.db.one('SELECT pred_id FROM operation_deps WHERE op_id = ?', second.id)).toEqual({ pred_id: first.id });
    await h.runUntilIdle();

    expect(h.op(first.id)).toMatchObject({ state: 'succeeded' });
    expect(h.op(second.id)).toMatchObject({ state: 'succeeded' });
    expect(h.writers.count(PUT)).toBe(2);
    expect((await remoteRecords(h.kit, 'Alice', BATCH)).find((item) => item.rkey === rkey)?.value).toMatchObject({
      listens: [{ id: '3lb2batchidad' }],
    });
  });
});

it('recovers an ambiguous partial delete by reading the container before sending again', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    await h.kit.externalPut('Alice', BATCH, rkey, {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: [
        {
          id: '3lb2batchidab',
          artist: 'Artist',
          track: 'Removed',
          listenedAt: '2026-01-14T12:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
        },
        {
          id: '3lb2batchidac',
          artist: 'Artist',
          track: 'Sibling',
          listenedAt: '2026-01-14T13:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
        },
      ],
    });
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    const crashed = h.writers.crashOn(PUT, 'after_commit');
    void h.run();
    await crashed;
    h.restart();

    await h.runUntilIdle();

    expect(h.op(del.id)).toMatchObject({ state: 'succeeded' });
    expect(h.writers.count(PUT)).toBe(1);
    const current = (await remoteRecords(h.kit, 'Alice', BATCH)).find((item) => item.rkey === rkey);
    expect(current!.value).toMatchObject({ listens: [{ id: '3lb2batchidac' }] });
  });
});

it('recovers a whole-container delete after a lost success and keeps the stale projection hidden', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    const record = {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: ['ab', 'ac'].map((suffix, index) => ({
        id: `3lb2batchid${suffix}`,
        artist: 'Artist',
        track: `Track ${index}`,
        listenedAt: `2026-01-14T1${index}:00:00Z`,
        createdAt: '2026-01-15T12:00:00Z',
      })),
    };
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', BATCH, rkey, record);
    const proof = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    const proofOptions = {
      receiptNs: BigInt(T0) * 1_000_000n,
      nowNs: BigInt(T0) * 1_000_000n,
      prefix: 'com.example.atmusic',
    };
    h.db.tx(() => applyRecordProof(h.db, proof, proofOptions));
    expect(h.db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toHaveLength(2);

    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['*'],
      origin: 'web',
    });
    const originalCid = proof.state === 'present' ? proof.cid : null;
    expect(originalCid).not.toBeNull();
    const crashed = h.writers.crashOn('com.atproto.repo.deleteRecord', 'after_commit');
    void h.run();
    await crashed;
    h.restart();
    await h.runUntilIdle();

    expect(h.op(del.id)).toMatchObject({ state: 'succeeded', swap_cid: originalCid });
    expect(h.db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toHaveLength(0);
    expect(h.writers.count('com.atproto.repo.deleteRecord')).toBe(1);

    // A later verified recreation has a new CID and becomes visible again.
    await h.kit.externalPut('Alice', BATCH, rkey, { ...record, createdAt: '2026-01-15T12:01:00Z' });
    const recreated = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() => applyRecordProof(h.db, recreated, proofOptions));
    expect(h.db.all(`SELECT s.uri FROM ${visibleScrobblesFrom()}`)).toHaveLength(2);
  });
});

const REMOVED_ID = '3lb2batchidab';
const SIBLING_ID = '3lb2batchidac';
const twoListenRecord = (extra: Record<string, unknown> = {}) => ({
  $type: BATCH,
  createdAt: '2026-01-15T12:00:00Z',
  ...extra,
  listens: [
    {
      id: REMOVED_ID,
      artist: 'Artist',
      track: 'Removed',
      listenedAt: '2026-01-14T12:00:00Z',
      createdAt: '2026-01-15T12:00:00Z',
      remoteEntryField: 'keep',
    },
    {
      id: SIBLING_ID,
      artist: 'Artist',
      track: 'Sibling',
      listenedAt: '2026-01-14T13:00:00Z',
      createdAt: '2026-01-15T12:00:00Z',
    },
  ],
});
const PROOF_OPTIONS = {
  receiptNs: BigInt(T0) * 1_000_000n,
  nowNs: BigInt(T0) * 1_000_000n,
  prefix: 'com.example.atmusic',
};

it('live batch replacement tombstones removed members only; snapshot replacement does not', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const rkey = '3lb2batchcontainer1',
      uri = `at://${h.alice}/${BATCH}/${rkey}`;
    await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord());
    let proof = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() =>
      applyRecordProof(h.db, proof, { ...PROOF_OPTIONS, ...authorizedLiveOptions(h.db, proof, h.m.random) }),
    );
    const member = h.db.one<{ listened_at: string }>(
      'SELECT listened_at FROM scrobbles WHERE record_uri=? AND listen_id=?',
      uri,
      REMOVED_ID,
    )!;
    const sibling = h.db.one<{ listened_at: string }>(
      'SELECT listened_at FROM scrobbles WHERE record_uri=? AND listen_id=?',
      uri,
      SIBLING_ID,
    )!;
    const removedSecond = Math.floor(Date.parse(member.listened_at) / 1000),
      retainedSecond = Math.floor(Date.parse(sibling.listened_at) / 1000);
    const replacement = twoListenRecord();
    replacement.listens = replacement.listens.filter((item) => item.id === SIBLING_ID);
    await h.kit.externalPut('Alice', BATCH, rkey, replacement);
    proof = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() =>
      applyRecordProof(h.db, proof, { ...PROOF_OPTIONS, ...authorizedLiveOptions(h.db, proof, h.m.random) }),
    );
    expect(
      h.db.one(
        "SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='listen' AND listen_second=?",
        h.alice,
        removedSecond,
      ),
    ).toEqual({ n: 1 });
    expect(
      h.db.one(
        "SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='listen' AND listen_second=?",
        h.alice,
        retainedSecond,
      ),
    ).toEqual({ n: 0 });
  });
});

const cidOf = (proof: Awaited<ReturnType<typeof proofAt>>): string => {
  if (proof.state !== 'present') throw new Error('expected a present proof');
  return proof.cid;
};
const visibleUris = (h: Harness): string[] =>
  h.db.all<{ uri: string }>(`SELECT s.uri FROM ${visibleScrobblesFrom()} ORDER BY s.uri`).map((row) => row.uri);

it('keeps a settled partial removal hidden at its admission and pre-write CIDs, through a delayed older proof, until a verified recreation', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    const container = `at://${h.alice}/${BATCH}/${rkey}`;
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord());
    const admission = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() => applyRecordProof(h.db, admission, PROOF_OPTIONS));
    expect(visibleUris(h)).toEqual([`${container}#${REMOVED_ID}`, `${container}#${SIBLING_ID}`]);

    const del = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container, listenIds: [REMOVED_ID], origin: 'web' });
    expect(visibleUris(h)).toEqual([`${container}#${SIBLING_ID}`]);
    // The owner edits the container elsewhere before the removal runs: the
    // CAS write targets that newer CID, which this index has not verified yet.
    await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord({ remoteEnvelopeField: 'edited elsewhere' }));
    const prewrite = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    await h.runUntilIdle();

    const written = (await remoteRecords(h.kit, 'Alice', BATCH)).find((item) => item.rkey === rkey)!;
    expect(written.value).toMatchObject({
      remoteEnvelopeField: 'edited elsewhere',
      listens: [{ id: SIBLING_ID }],
    });
    expect(written.cid).not.toBe(cidOf(prewrite));
    // The receipt keeps the pre-CAS CID, never the post-write one.
    expect(h.op(del.id)).toMatchObject({ state: 'succeeded', swap_cid: cidOf(prewrite) });
    expect(
      h.db
        .all<{ cid: string }>('SELECT cid FROM listen_removal_cids WHERE operation_id = ?', del.id)
        .map((row) => row.cid)
        .sort(),
    ).toEqual([cidOf(admission), cidOf(prewrite)].sort());
    // Projected at the admission CID after settlement: still hidden.
    expect(visibleUris(h)).toEqual([`${container}#${SIBLING_ID}`]);
    // A delayed older signed proof (the pre-write CID) arrives after the
    // local delete settled: the listen stays hidden, the sibling visible.
    expect(h.db.tx(() => applyRecordProof(h.db, prewrite, PROOF_OPTIONS)).outcome).toBe('applied');
    expect(visibleUris(h)).toEqual([`${container}#${SIBLING_ID}`]);
    // The proof of the removal's own write drops it from the projection; no
    // record_state absence was fabricated for the container meanwhile.
    expect(h.db.one('SELECT state FROM record_state WHERE uri = ?', container)).toEqual({ state: 'present' });
    const removed = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() => applyRecordProof(h.db, removed, PROOF_OPTIONS));
    expect(h.db.all('SELECT listen_id FROM scrobbles WHERE record_uri = ?', container)).toEqual([
      { listen_id: SIBLING_ID },
    ]);
    // The owner deliberately restores the same listen id: a verified new CID is visible again.
    await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord({ remoteEnvelopeField: 'restored' }));
    const restored = await proofAt(h.kit.repos.Alice, BATCH, rkey);
    h.db.tx(() => applyRecordProof(h.db, restored, PROOF_OPTIONS));
    expect(visibleUris(h)).toEqual([`${container}#${REMOVED_ID}`, `${container}#${SIBLING_ID}`]);
  });
});

it.each([
  { name: 'partial', listenIds: [REMOVED_ID], method: PUT, hidden: [REMOVED_ID] },
  { name: 'wildcard', listenIds: ['*'], method: 'com.atproto.repo.deleteRecord', hidden: [REMOVED_ID, SIBLING_ID] },
])(
  'a $name removal reconciled after its tenth attempt keeps the pre-CAS evidence and hides admission and delayed proofs',
  async ({ listenIds, method, hidden }) => {
    await withHarness(async (h) => {
      const rkey = '3lb2batchcontainer1';
      const container = `at://${h.alice}/${BATCH}/${rkey}`;
      const all = [`${container}#${REMOVED_ID}`, `${container}#${SIBLING_ID}`];
      const expectedVisible = all.filter((uri) => !hidden.some((id) => uri.endsWith(`#${id}`)));
      h.seedUser(h.alice);
      await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord());
      const admission = await proofAt(h.kit.repos.Alice, BATCH, rkey);
      h.db.tx(() => applyRecordProof(h.db, admission, PROOF_OPTIONS));
      const del = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container, listenIds, origin: 'web' });
      await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord({ remoteEnvelopeField: 'edited elsewhere' }));
      const prewrite = await proofAt(h.kit.repos.Alice, BATCH, rkey);
      // The tenth attempt commits remotely and its answer is lost.
      h.db.run('UPDATE operations SET attempts = 9 WHERE id = ?', del.id);
      const crashed = h.writers.crashOn(method, 'after_commit');
      void h.run();
      await crashed;
      h.restart();
      await h.runUntilIdle();

      expect(h.writers.count(method)).toBe(1);
      expect(h.op(del.id)).toMatchObject({ state: 'succeeded', attempts: 10, swap_cid: cidOf(prewrite) });
      expect(visibleUris(h)).toEqual(expectedVisible);
      expect(h.db.tx(() => applyRecordProof(h.db, prewrite, PROOF_OPTIONS)).outcome).toBe('applied');
      expect(visibleUris(h)).toEqual(expectedVisible);
      // The verified result of the write, then a deliberate recreation at a new CID.
      const result = await proofAt(h.kit.repos.Alice, BATCH, rkey);
      h.db.tx(() => applyRecordProof(h.db, result, PROOF_OPTIONS));
      expect(visibleUris(h)).toEqual(expectedVisible);
      await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord({ remoteEnvelopeField: 'restored' }));
      const restored = await proofAt(h.kit.repos.Alice, BATCH, rkey);
      h.db.tx(() => applyRecordProof(h.db, restored, PROOF_OPTIONS));
      expect(visibleUris(h)).toEqual(all);
    });
  },
);

it('holds a batch deletion on explicit scope denial and resumes its durable intent after re-consent', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    await h.kit.externalPut('Alice', BATCH, rkey, {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: ['ab', 'ac'].map((suffix, index) => ({
        id: `3lb2batchid${suffix}`,
        artist: 'Artist',
        track: `Track ${index}`,
        listenedAt: `2026-01-14T1${index}:00:00Z`,
        createdAt: '2026-01-15T12:00:00Z',
      })),
    });
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    h.kit.pds.Alice.fail(
      { nsid: GET },
      { kind: 'status', status: 403, error: 'ScopeMissing', message: 'scope missing' },
    );
    await h.run();
    expect(h.op(del.id)).toMatchObject({ state: 'blocked', last_error: 'batch_scope_required' });
    expect(h.db.all('SELECT listen_id FROM batch_delete_listens WHERE operation_id=?', del.id)).toEqual([
      { listen_id: '3lb2batchidab' },
    ]);
    expect(((await remoteRecords(h.kit, 'Alice', BATCH))[0]!.value as { listens: unknown[] }).listens).toHaveLength(2);

    h.writers.grantedScope = `repo:${BATCH}`;
    h.db.tx(() => h.db.run("UPDATE operations SET state='queued',last_error=NULL WHERE id=?", del.id));
    await h.runUntilIdle();
    expect(h.op(del.id).state).toBe('succeeded');
    expect(((await remoteRecords(h.kit, 'Alice', BATCH))[0]!.value as { listens: unknown[] }).listens).toMatchObject([
      { id: '3lb2batchidac' },
    ]);
  });
});

const DELETE_RECORD = 'com.atproto.repo.deleteRecord';

it.each([
  { nsid: GET, listenIds: [REMOVED_ID], writes: [] as string[] },
  { nsid: PUT, listenIds: [REMOVED_ID], writes: [PUT] },
  { nsid: DELETE_RECORD, listenIds: ['*'], writes: [DELETE_RECORD] },
])(
  'a 5xx $nsid whose body names a scope error stays retryable without a scope hold, resend loop or lost CAS evidence',
  async ({ nsid, listenIds, writes }) => {
    await withHarness(
      async (h) => {
        const rkey = '3lb2batchcontainer1';
        const container = `at://${h.alice}/${BATCH}/${rkey}`;
        const put = await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord());
        const cid = put.ops[0]!.cid;
        const del = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container, listenIds, origin: 'web' });
        h.kit.pds.Alice.fail(
          { nsid },
          { kind: 'status', status: 500, error: 'ScopeMissing', message: 'scope missing' },
        );

        await h.run();

        const queued = h.op(del.id);
        expect(queued).toMatchObject({ state: 'queued', attempts: 1, last_error: 'upstream_unavailable' });
        expect(h.ops("state = 'blocked'")).toEqual([]);
        // One write request per attempt: a transient answer is not resent in a loop.
        for (const write of writes) expect(h.writers.count(write)).toBe(1);
        if (writes.length > 0) {
          expect(queued.swap_cid).toBe(cid);
          expect(h.db.all('SELECT cid FROM listen_removal_cids WHERE operation_id = ?', del.id)).toEqual([{ cid }]);
        }
        expect(h.db.all('SELECT listen_id FROM batch_delete_listens WHERE operation_id = ?', del.id)).toEqual(
          listenIds.map((listen_id) => ({ listen_id })),
        );

        h.kit.clock.advance(60_000);
        await h.runUntilIdle();
        expect(h.op(del.id)).toMatchObject({ state: 'succeeded', swap_cid: cid });
      },
      { random: zeroJitter() },
    );
  },
);

it.each([
  { nsid: PUT, listenIds: [REMOVED_ID], error: 'ScopeMissing' },
  { nsid: DELETE_RECORD, listenIds: ['*'], error: 'InsufficientScope' },
  { nsid: PUT, listenIds: [REMOVED_ID], error: undefined },
])(
  'a classified 403 $error denial of $nsid holds the batch lane for re-consent and keeps the intent',
  async ({ nsid, listenIds, error }) => {
    await withHarness(async (h) => {
      const rkey = '3lb2batchcontainer1';
      const container = `at://${h.alice}/${BATCH}/${rkey}`;
      const put = await h.kit.externalPut('Alice', BATCH, rkey, twoListenRecord());
      const del = enqueueBatchListenDelete(h.m, { did: h.alice, uri: container, listenIds, origin: 'web' });
      h.kit.pds.Alice.fail(
        { nsid },
        error === undefined
          ? { kind: 'status', status: 403 }
          : { kind: 'status', status: 403, error, message: 'denied' },
      );

      await h.run();

      expect(h.op(del.id)).toMatchObject({ state: 'blocked', last_error: 'batch_scope_required' });
      expect(h.op(del.id).swap_cid).toBe(put.ops[0]!.cid);
      expect(h.writers.count(nsid)).toBe(1);
      expect(h.db.all('SELECT listen_id FROM batch_delete_listens WHERE operation_id = ?', del.id)).toEqual(
        listenIds.map((listen_id) => ({ listen_id })),
      );
      expect(((await remoteRecords(h.kit, 'Alice', BATCH))[0]!.value as { listens: unknown[] }).listens).toHaveLength(
        2,
      );
    });
  },
);

it('does not trust a wrong remote record URI or crash on a null batch entry', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    const procedures: unknown[] = [];
    const context = {
      m: h.m,
      xrpc: {
        did: h.alice,
        latestCommit: async () => ({
          kind: 'head',
          cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
          rev: '3lb2batchhead',
        }),
        getRecord: async () => ({
          kind: 'present',
          uri: `at://${h.bob}/${BATCH}/${rkey}`,
          cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
          value: { $type: BATCH, listens: [{ id: '3lb2batchidab' }] },
        }),
        procedure: async (...args: unknown[]) => {
          procedures.push(args);
          return { ok: true };
        },
      },
      collections: { scrobbleBatch: BATCH },
      afford: () => null,
      persist: () => undefined,
      hint: () => undefined,
      memo: (_key: string, build: () => unknown) => build(),
    } as unknown as ExecContext;
    expect(await batchDeleteExecutor.execute({ ...h.op(del.id), did: h.bob }, context)).toMatchObject({
      kind: 'permanent',
      code: 'invalid_record_identity',
    });
    expect(await batchDeleteExecutor.execute(h.op(del.id), context)).toMatchObject({
      kind: 'permanent',
      code: 'invalid_batch_record_identity',
    });
    expect(procedures).toEqual([]);

    await h.kit.externalPut('Alice', BATCH, rkey, { $type: BATCH, listens: [null] });
    const report = await h.run();
    expect(report.attempted).toBe(1);
    expect(h.op(del.id).state).toBe('succeeded');
    expect(
      h.writers.sent.filter((request) => request.nsid === PUT || request.nsid === 'com.atproto.repo.deleteRecord'),
    ).toEqual([]);
  });
});

it('verifies a 2xx batch delete by read-back before settling success', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    await h.kit.externalPut('Alice', BATCH, rkey, {
      $type: BATCH,
      listens: [
        { id: '3lb2batchidab', artist: 'A', track: 'T' },
        { id: '3lb2batchidac', artist: 'A', track: 'S' },
      ],
    });
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['3lb2batchidab'],
      origin: 'web',
    });
    h.kit.pds.Alice.fail(
      { nsid: PUT },
      {
        kind: 'respond',
        respond: async () =>
          Response.json({
            uri: `at://${h.alice}/${BATCH}/${rkey}`,
            cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
          }),
      },
    );
    await h.run();
    expect(h.op(del.id)).toMatchObject({ state: 'queued', last_error: 'remote_delete_unconfirmed' });
    expect((await remoteRecords(h.kit, 'Alice', BATCH))[0]!.value).toMatchObject({
      listens: [{ id: '3lb2batchidab' }, { id: '3lb2batchidac' }],
    });
    h.kit.clock.advance(60_000);
    await h.runUntilIdle();
    expect(h.op(del.id).state).toBe('succeeded');
    expect(h.writers.count(PUT)).toBe(2);
  });
});

it('reconciles an interrupted tenth batch delete attempt without an eleventh send', async () => {
  await withHarness(async (h) => {
    const rkey = '3lb2batchcontainer1';
    await h.kit.externalPut('Alice', BATCH, rkey, {
      $type: BATCH,
      listens: [{ id: '3lb2batchidab', artist: 'A', track: 'T' }],
    });
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: ['*'],
      origin: 'web',
    });
    h.db.run("UPDATE operations SET state='running',attempts=10,send_started_at_ms=? WHERE id=?", T0, del.id);
    await h.run();
    expect(h.op(del.id)).toMatchObject({ state: 'failed', attempts: 10 });
    // Read-only: the head and the container, never a write.
    expect(h.writers.sent.map((request) => request.nsid)).toEqual([HEAD, GET]);
    expect(await remoteRecords(h.kit, 'Alice', BATCH)).toHaveLength(1);
  });
});

it('does not delete a colliding record after this batch create is rejected as remote_record_conflict', async () => {
  await withHarness(async (h) => {
    const entryId = '3lb2batchidab';
    const rkey = '3lb2batchcontainer1';
    const record = {
      $type: BATCH,
      createdAt: '2026-01-15T12:00:00Z',
      listens: [
        {
          id: entryId,
          artist: 'Artist',
          track: 'Track',
          listenedAt: '2026-01-14T12:00:00Z',
          createdAt: '2026-01-15T12:00:00Z',
        },
      ],
    };
    const create = h.db.tx(() =>
      insertOperation(
        h.db,
        {
          id: newOperationId(h.m.random),
          did: h.alice,
          kind: 'scrobble.create',
          origin: 'import',
          collection: BATCH,
          rkey,
          prepared: { record, digest: 'different-digest' },
          dueAt: T0,
        },
        T0,
      ),
    );
    const other = { ...record, createdAt: '2020-01-01T00:00:00Z' };
    const prior = await h.kit.externalPut('Alice', BATCH, rkey, other);
    const del = enqueueBatchListenDelete(h.m, {
      did: h.alice,
      uri: `at://${h.alice}/${BATCH}/${rkey}`,
      listenIds: [entryId],
      origin: 'web',
    });

    await h.runUntilIdle();

    expect(h.op(create.id)).toMatchObject({ state: 'failed', last_error: 'remote_record_conflict' });
    expect(h.op(del.id)).toMatchObject({ state: 'succeeded', last_error: 'record_not_ours' });
    expect(await remoteRecords(h.kit, 'Alice', BATCH)).toMatchObject([{ rkey, cid: prior.ops[0]!.cid, value: other }]);
    expect(
      h.writers.sent.filter((request) => request.nsid === PUT || request.nsid === 'com.atproto.repo.deleteRecord'),
    ).toEqual([]);
    expect(h.db.one('SELECT operation_id FROM listen_removals WHERE operation_id = ?', del.id)).toBeNull();
  });
});

it('a batch failing because one rkey exists is bisected; the other 199 are written once and the existing one is reconciled by digest', async () => {
  await withHarness(async (h) => {
    const ops = await importCreates(h, 200);
    const existing = ops[137]!;
    // The same record is already at one rkey (a batch that landed before a crash, or a lost answer).
    const prior = await h.kit.externalPut('Alice', SCROBBLE, existing.rkey!, JSON.parse(existing.record_json!));
    const writes = commitCounter(h, 'Alice');

    const reports = await h.runUntilIdle();
    expect(reports.flatMap((r) => r.batches)).toEqual([200]);
    // Bisected down to the one create, which reconciles by digest: no second write at its rkey.
    const applyStatuses = h.writers.sent.filter((s) => s.nsid === APPLY).map((s) => s.status);
    expect(applyStatuses[0]).toBe(400);
    expect(applyStatuses.filter((s) => s === 400).length).toBeGreaterThan(1);
    expect(h.writers.sent.filter((s) => s.nsid === CREATE).map((s) => [s.body?.rkey, s.status])).toEqual([
      [existing.rkey, 400],
    ]);
    expect(h.writers.sent.filter((s) => s.nsid === GET).map((s) => s.status)).toEqual([200]);
    for (const op of ops) {
      expect(writes.get(op.rkey!) ?? 0).toBe(op.id === existing.id ? 0 : 1);
    }
    expect([...writes.values()].reduce((a, b) => a + b, 0)).toBe(199);
    // Every operation succeeded with its one counted attempt; the existing record kept its CID.
    for (const op of ops) expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect(h.op(existing.id).result_cid).toBe(prior.ops[0]!.cid);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(200);
  });
});

it('a 200-write batch whose answer was lost after the PDS committed is reconciled with getRecord reads, spending no write points; a batch refused with 500 is read back and written once', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    const ops = await importCreates(h, 200);
    const writes = commitCounter(h, 'Alice');
    const crashed = h.writers.crashOn(APPLY, 'after_commit');
    void h.run();
    await crashed;
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 600);
    h.restart();

    const mark = h.writers.sent.length;
    const reports = await h.runUntilIdle();
    const after = h.writers.sent.slice(mark);
    // Every member is looked up, none is written again.
    expect(after.map((s) => s.nsid)).toEqual(Array(200).fill(GET));
    expect(after.every((s) => s.status === 200)).toBe(true);
    expect(reports.flatMap((r) => r.batches)).toEqual([200]);
    expect(reports.at(-1)!.nextDueMs).toBeNull();
    // Each record was committed once, by the batch whose answer was lost.
    for (const op of ops) expect(writes.get(op.rkey!)).toBe(1);
    expect([...writes.values()].reduce((a, b) => a + b, 0)).toBe(200);
    expect(h.kit.pds.Alice.pointsRemaining(h.alice)).toBe(5000 - 600);
    expect(h.db.all(`SELECT window, points FROM pds_budget WHERE did = ? ORDER BY window`, h.alice)).toEqual([
      { window: 'day', points: 600 },
      { window: 'hour', points: 600 },
    ]);
    const remote = new Map((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => [r.rkey, r.cid]));
    for (const op of ops) {
      expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2, result_cid: remote.get(op.rkey!) });
    }
    // Each reconciled record is hinted like a written one.
    expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM hints WHERE source = 'notify'`)!.n).toBe(200);
  });

  await withHarness(
    async (h) => {
      const ops = await importCreates(h, 200);
      const writes = commitCounter(h, 'Alice');
      h.kit.pds.Alice.serverError(APPLY, 500, 1);
      await h.run();
      expect(h.ops().every((o) => o.state === 'queued' && o.attempts === 1)).toBe(true);
      h.kit.clock.advance(1_000);
      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      // The 500 may have committed: every member is read (absent), then the batch is written once.
      expect(h.writers.sent.slice(mark).map((s) => [s.nsid, s.status])).toEqual([
        ...Array(200).fill([GET, 400]),
        [APPLY, 200],
      ]);
      for (const op of ops) {
        expect(writes.get(op.rkey!)).toBe(1);
        expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      }
    },
    { random: zeroJitter() },
  );
}, 60_000); // hundreds of fake-PDS round trips; the nested check-ts control runs it under the full suite's load

it('PdsWriter requests reach the fake PDS through policyFetch, and a 3xx from the PDS is a retryable TransportError redirect, never followed', async () => {
  await withHarness(
    async (h) => {
      const r = await acceptListens(h.m, {
        did: h.alice,
        origin: 'web',
        listens: [{ input: listenInput(0) }],
        receiptMs: T0,
      });
      const id = r.results[0]?.status === 'accepted' ? r.results[0].operationId! : '';
      h.kit.pds.Alice.redirect(CREATE, `https://${h.kit.users.Bob.host}/xrpc/${CREATE}`);

      await h.run();
      // The request went through policyFetch to the fake PDS (manual redirects, the writer's credentials) …
      expect(h.seen.map((s) => [s.method, new URL(s.url).host, s.redirect, s.authorization])).toEqual([
        ['POST', h.kit.users.Alice.host, 'manual', `Bearer ${h.kit.users.Alice.token}`],
      ]);
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([302]);
      // … and the 302 became TransportError `redirect`: transient, Location never requested.
      expect(h.kit.pds.Bob.count()).toBe(0);
      expect(h.op(id)).toMatchObject({ state: 'queued', attempts: 1, last_error: 'transport_redirect' });
      expect(h.op(id).due_at).toBe(T0 + 1_000);

      h.kit.clock.advance(1_000);
      await h.runUntilIdle();
      expect(h.seen.map((s) => new URL(s.url).host)).toEqual([h.kit.users.Alice.host, h.kit.users.Alice.host]);
      expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([302, 200]);
      expect(h.op(id)).toMatchObject({ state: 'succeeded', attempts: 2, last_error: null });
      expect(h.kit.pds.Bob.count()).toBe(0);
    },
    { random: zeroJitter() },
  );
});
