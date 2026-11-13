import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { lateAccept } from '../../../src/forward/live-acceptance';
import {
  ALICE,
  fixtureScrobble,
  NOW_MS,
  NOW_NS,
  PREFIX,
  type proofAt,
  putProof,
  repoFor,
  SCROBBLE,
  seedSnapshotJob,
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const LOVE = `${PREFIX}.love`;
const BATCH = `${PREFIX}.scrobbleBatch`;
const random = seededRandom(901);
type PresentProof = Extract<Awaited<ReturnType<typeof proofAt>>, { state: 'present' }>;
const present = (proof: Awaited<ReturnType<typeof proofAt>>): PresentProof => {
  if (proof.state !== 'present') throw new Error('expected present proof');
  return proof;
};
const event = (proof: PresentProof, action: 'create' | 'update') => ({
  up_rev: proof.commit.rev,
  up_action: action,
  up_cid: proof.state === 'present' ? proof.cid : null,
  del_rev: null,
  conflict_rev: null,
});

async function refresh(
  mode: 'record-scrobble' | 'snapshot-scrobble' | 'record-batch' | 'snapshot-batch' | 'record-love' | 'snapshot-love',
) {
  const repo = await repoFor('alice');
  const love = mode.endsWith('love');
  const batch = mode.endsWith('batch');
  const collection = love ? LOVE : batch ? BATCH : SCROBBLE;
  const initial = love
    ? { $type: LOVE, artist: 'Candidate Artist', track: 'Candidate Track', createdAt: '2026-01-15T11:00:00Z' }
    : batch
      ? {
          $type: BATCH,
          createdAt: '2026-01-15T11:00:00Z',
          listens: [
            {
              id: '3lb2batchidab',
              artist: 'Candidate Artist',
              track: 'Candidate Track',
              album: 'Before',
              listenedAt: '2026-01-14T11:00:00Z',
              createdAt: '2026-01-15T11:00:00Z',
            },
          ],
        }
      : fixtureScrobble('r02');
  const changed = batch
    ? {
        ...initial,
        listens: [{ ...(initial as { listens: Array<Record<string, unknown>> }).listens[0], album: 'After' }],
      }
    : { ...initial, album: 'Metadata only' };
  const first = present(await putProof(repo, collection, 'candidate-refresh', initial));
  const second = present(await putProof(repo, collection, 'candidate-refresh', changed));
  await withMigratedDb((db) => {
    const generation = seedUser(db, ALICE);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
      VALUES('candidate-link',?,'lastfm','remote',X'00','fixture',?,?)`,
      ALICE,
      NOW_MS,
      NOW_MS,
    );
    seedSnapshotJob(db, ALICE, generation);
    db.run('UPDATE users SET last_snapshot_at_ms=? WHERE did=?', NOW_MS - 1000, ALICE);
    const candidate = (proof = first) =>
      db.tx(() =>
        applyRecordProof(db, proof, {
          prefix: PREFIX,
          receiptNs: NOW_NS,
          nowNs: NOW_NS,
          liveCandidates: true,
          live: { random, evidence: null, legacyRev: null },
        }),
      );
    candidate();
    const before = db.one<{ cid: string; created_at_ms: number; expires_at_ms: number }>(
      'SELECT cid,created_at_ms,expires_at_ms FROM live_acceptance_candidates',
    )!;
    if (mode.startsWith('snapshot')) {
      db.tx(() =>
        applySnapshotChunk(db, {
          did: ALICE,
          generation,
          headRev: second.commit.rev,
          raceFloorRev: first.commit.rev,
          intervalLo: `${PREFIX}.`,
          intervalHi: `${PREFIX}/`,
          entries: [{ key: `${collection}/candidate-refresh`, cid: second.cid!, record: second.record }],
          receiptNs: NOW_NS,
          nowNs: NOW_NS + 1_000_000_000n,
          prefix: PREFIX,
          random,
        }),
      );
    } else {
      candidate(second);
    }
    const after = db.one<{ cid: string; created_at_ms: number; expires_at_ms: number }>(
      'SELECT cid,created_at_ms,expires_at_ms FROM live_acceptance_candidates',
    )!;
    expect(after).toEqual({
      cid: second.cid,
      created_at_ms: before.created_at_ms,
      expires_at_ms: before.expires_at_ms,
    });
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${collection}/candidate-refresh`,
          did: ALICE,
          collection,
          rkey: 'candidate-refresh',
          evidence: event(second, 'update'),
          raceFloorRev: second.commit.rev,
          nowMs: NOW_MS + 1000,
          random,
        }),
      ),
    ).toBe(0);
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${collection}/candidate-refresh`,
          did: ALICE,
          collection,
          rkey: 'candidate-refresh',
          evidence: event(second, 'update'),
          raceFloorRev: first.commit.rev,
          nowMs: NOW_MS + 1000,
          random,
        }),
      ),
    ).toBe(1);
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${collection}/candidate-refresh`,
          did: ALICE,
          collection,
          rkey: 'candidate-refresh',
          evidence: event(second, 'update'),
          raceFloorRev: first.commit.rev,
          nowMs: NOW_MS + 1000,
          random,
        }),
      ),
    ).toBe(0);
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
  });
}

it.each([
  'record-scrobble',
  'snapshot-scrobble',
  'record-batch',
  'snapshot-batch',
  'record-love',
  'snapshot-love',
] as const)('%s metadata changes refresh only the owned candidate and late-accept once', refresh);

it('keeps first-snapshot history out of candidate ownership and late-accepts a same-revision snapshot noop once', async () => {
  const repo = await repoFor('alice');
  const proof = present(await putProof(repo, SCROBBLE, 'snapshot-frontier', fixtureScrobble('r02')));
  const chunk = (db: Db, generation: number, nowNs: bigint) =>
    applySnapshotChunk(db, {
      did: ALICE,
      generation,
      headRev: proof.commit.rev,
      raceFloorRev: '0000000000000',
      intervalLo: `${PREFIX}.`,
      intervalHi: `${PREFIX}/`,
      entries: [{ key: `${SCROBBLE}/snapshot-frontier`, cid: proof.cid!, record: proof.record }],
      receiptNs: NOW_NS,
      nowNs,
      prefix: PREFIX,
      random,
    });
  await withMigratedDb((db) => {
    const generation = seedUser(db, ALICE);
    seedSnapshotJob(db, ALICE, generation);
    db.tx(() => chunk(db, generation, NOW_NS));
    expect(db.all('SELECT * FROM live_acceptance_candidates')).toHaveLength(0);
  });
  await withMigratedDb((db) => {
    const generation = seedUser(db, ALICE);
    db.run('UPDATE users SET last_snapshot_at_ms=? WHERE did=?', NOW_MS - 1000, ALICE);
    seedSnapshotJob(db, ALICE, generation);
    db.tx(() => chunk(db, generation, NOW_NS + 1_000_000_000n));
    const candidate = db.one('SELECT * FROM live_acceptance_candidates');
    expect(candidate).not.toBeNull();
    const uri = `at://${ALICE}/${SCROBBLE}/snapshot-frontier`;
    recordLiveEvidence(
      db,
      {
        uri,
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'snapshot-frontier',
        rev: proof.commit.rev,
        action: 'update',
        cid: proof.cid!,
      },
      NOW_MS + 1000,
    );
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
      VALUES('snapshot-frontier-link',?,'lastfm','remote',X'00','fixture',?,?)`,
      ALICE,
      NOW_MS,
      NOW_MS,
    );
    db.tx(() => chunk(db, generation, NOW_NS + 2_000_000_000n));
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
    db.tx(() => chunk(db, generation, NOW_NS + 3_000_000_000n));
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
  });
});

it('does not refresh an expired candidate or transfer it to a different canonical identity', async () => {
  const repo = await repoFor('alice');
  const first = present(
    await putProof(repo, LOVE, 'candidate-owner', {
      $type: LOVE,
      artist: 'Candidate Artist',
      track: 'Candidate Track',
      createdAt: '2026-01-15T11:00:00Z',
    }),
  );
  const changed = present(
    await putProof(repo, LOVE, 'candidate-owner', {
      $type: LOVE,
      artist: 'Candidate Artist',
      track: 'Candidate Track',
      album: 'Changed',
      createdAt: '2026-01-15T11:00:00Z',
    }),
  );
  await withMigratedDb((db) => {
    seedUser(db, ALICE);
    const apply = (proof: typeof first, nowNs: bigint) =>
      db.tx(() =>
        applyRecordProof(db, proof, {
          prefix: PREFIX,
          receiptNs: NOW_NS,
          nowNs,
          liveCandidates: true,
          live: { random, evidence: null, legacyRev: null },
        }),
      );
    apply(first, NOW_NS);
    const before = db.one<{ expires_at_ms: number }>('SELECT * FROM live_acceptance_candidates')!;
    const expires = Number(before.expires_at_ms);
    apply(changed, BigInt(expires + 1) * 1_000_000n);
    expect(db.one('SELECT * FROM live_acceptance_candidates')).toEqual(before);
  });
});

it('does not transfer a scrobble candidate when an accepted rewrite changes its canonical listen identity', async () => {
  const repo = await repoFor('alice');
  const original = fixtureScrobble('r02');
  const first = present(await putProof(repo, SCROBBLE, 'identity-owner', original));
  const changed = present(
    await putProof(repo, SCROBBLE, 'identity-owner', {
      ...original,
      artist: 'A different canonical artist',
      track: 'A different canonical track',
    }),
  );
  await withMigratedDb((db) => {
    seedUser(db, ALICE);
    const apply = (proof: typeof first, nowNs: bigint) =>
      db.tx(() =>
        applyRecordProof(db, proof, {
          prefix: PREFIX,
          receiptNs: NOW_NS,
          nowNs,
          liveCandidates: true,
          live: { random, evidence: null, legacyRev: null },
        }),
      );
    apply(first, NOW_NS);
    const before = db.one('SELECT * FROM live_acceptance_candidates')!;
    apply(changed, NOW_NS + 1_000_000n);
    expect(db.one('SELECT * FROM live_acceptance_candidates')).toEqual(before);
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${SCROBBLE}/identity-owner`,
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'identity-owner',
          evidence: event(changed, 'update'),
          raceFloorRev: null,
          nowMs: NOW_MS + 1,
          random,
        }),
      ),
    ).toBe(0);
  });
});
