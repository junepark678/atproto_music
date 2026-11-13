import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { payloadForHistoryRow, runLinkBackfill } from '../../../src/forward/backfill';
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
  await withMigratedDb(async (db) => {
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
    if (!love) {
      const projected = db.one<{ artist_key: string; track_key: string; album_key: string | null }>(
        'SELECT artist_key,track_key,album_key FROM scrobbles LIMIT 1',
      )!;
      // Distinct matches prove promotion uses the same album-specific
      // recording selection as indexed history.
      db.run(
        `INSERT OR REPLACE INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms)
         VALUES(?,?,?,'matched',?,?)`,
        projected.artist_key,
        projected.track_key,
        projected.album_key ?? '',
        '11111111-1111-4111-8111-111111111111',
        NOW_MS,
      );
      db.run(
        `INSERT OR REPLACE INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms)
         VALUES(?,?,?,'matched',?,?)`,
        projected.artist_key,
        projected.track_key,
        '',
        '22222222-2222-4222-8222-222222222222',
        NOW_MS,
      );
    }
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${collection}/candidate-refresh`,
          did: ALICE,
          collection,
          rkey: 'candidate-refresh',
          evidence: event(second, 'update'),
          nowMs: NOW_MS + 1000,
          random,
        }),
      ),
    ).toBe(1);
    if (!love) {
      const row = db.one<{
        kind: 'scrobble';
        uri: string;
        cid: string;
        event_at: string;
        artist: string;
        track: string;
        album: string | null;
        recording_mbid: string | null;
        artist_key: string;
        track_key: string;
        album_key: string | null;
        listened_at: string;
      }>(
        "SELECT 'scrobble' AS kind,uri,cid,listened_at AS event_at,artist,track,album,recording_mbid,artist_key,track_key,album_key,listened_at FROM scrobbles LIMIT 1",
      )!;
      const identity = db.one<{ identity_key: string }>('SELECT identity_key FROM forward_admissions LIMIT 1')!;
      const link = db.one<{
        id: string;
        did: string;
        generation: number;
        service: 'lastfm' | 'listenbrainz';
        generation_start_seq: number;
      }>("SELECT * FROM linked_accounts WHERE id='candidate-link'")!;
      const expected = payloadForHistoryRow(db, link, row, identity.identity_key)!;
      const queued = JSON.parse(
        db.one<{ payload_json: string }>('SELECT payload_json FROM forward_outbox')!.payload_json,
      );
      expect(queued).toEqual(expected.payload);
      expect(queued).toEqual({
        listen: {
          artist: row.artist,
          track: row.track,
          listenedAt: row.listened_at,
          album: row.album,
          recordingMbid: '11111111-1111-4111-8111-111111111111',
        },
        origin: 'backfill',
      });
    }
    const queuedBeforeHistory = db.all('SELECT link_id,kind,dedupe_key FROM forward_outbox');
    for (let turn = 0; turn < 5; turn++) await runLinkBackfill(db, random, NOW_MS + 1000);
    expect(db.all('SELECT link_id,kind,dedupe_key FROM forward_outbox')).toEqual(queuedBeforeHistory);
    if (!love) {
      const queued = JSON.parse(
        db.one<{ payload_json: string }>('SELECT payload_json FROM forward_outbox')!.payload_json,
      );
      expect(queued.listen.album).toBe(db.one<{ album: string | null }>('SELECT album FROM scrobbles LIMIT 1')!.album);
      expect(queued.listen.recordingMbid).toBe('11111111-1111-4111-8111-111111111111');
    }
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(1);
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${collection}/candidate-refresh`,
          did: ALICE,
          collection,
          rkey: 'candidate-refresh',
          evidence: event(second, 'update'),
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

it('A1-7 R2: a forged relay claim for snapshot history outside Last.fm backfill eligibility queues no row', async () => {
  const repo = await repoFor('alice');
  const listenedAt = new Date(NOW_MS - 14 * 86_400_000).toISOString();
  const proof = present(
    await putProof(repo, SCROBBLE, 'relay-historical-r2', {
      ...fixtureScrobble('r02'),
      listenedAt,
    }),
  );
  await withMigratedDb((db) => {
    const generation = seedUser(db, ALICE);
    db.run('UPDATE users SET last_snapshot_at_ms=? WHERE did=?', NOW_MS - 1000, ALICE);
    seedSnapshotJob(db, ALICE, generation);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES('relay-r2-lastfm',?,'lastfm','remote',X'00','fixture',?,?)`,
      ALICE,
      NOW_MS,
      NOW_MS,
    );
    db.tx(() =>
      applySnapshotChunk(db, {
        did: ALICE,
        generation,
        headRev: proof.commit.rev,
        intervalLo: `${PREFIX}.`,
        intervalHi: `${PREFIX}/`,
        entries: [{ key: `${SCROBBLE}/relay-historical-r2`, cid: proof.cid!, record: proof.record }],
        receiptNs: NOW_NS,
        nowNs: NOW_NS + 1_000_000_000n,
        prefix: PREFIX,
        random,
      }),
    );
    expect(
      db.one('SELECT path FROM forward_admissions WHERE did=? ORDER BY admission_seq DESC LIMIT 1', ALICE),
    ).toEqual({
      path: 'snapshot',
    });
    expect(
      db.tx(() =>
        lateAccept(db, {
          uri: `at://${ALICE}/${SCROBBLE}/relay-historical-r2`,
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'relay-historical-r2',
          evidence: event(proof, 'update'),
          nowMs: NOW_MS,
          random,
        }),
      ),
    ).toBe(1);
    expect(db.all("SELECT link_id,kind,dedupe_key FROM forward_outbox WHERE link_id='relay-r2-lastfm'")).toEqual([]);
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
          nowMs: NOW_MS + 1,
          random,
        }),
      ),
    ).toBe(0);
  });
});

it.each(['scrobble', 'love'] as const)(
  'a %s candidate promoted to two linked services counts as one late acceptance',
  async (kind) => {
    const repo = await repoFor('alice');
    const collection = kind === 'love' ? LOVE : SCROBBLE;
    const initial =
      kind === 'love'
        ? {
            $type: LOVE,
            artist: 'Candidate Artist',
            track: 'Candidate Track',
            recordingMbid: '33333333-3333-4333-8333-333333333333',
            createdAt: '2026-01-15T11:00:00Z',
          }
        : fixtureScrobble('r02');
    const first = present(await putProof(repo, collection, 'two-links', initial));
    const second = present(await putProof(repo, collection, 'two-links', { ...initial, album: 'Metadata only' }));
    await withMigratedDb((db) => {
      const generation = seedUser(db, ALICE);
      for (const [id, service] of [
        ['two-links-lastfm', 'lastfm'],
        ['two-links-listenbrainz', 'listenbrainz'],
      ] as const) {
        db.run(
          `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
          VALUES(?,?,?,'remote',X'00','fixture',?,?)`,
          id,
          ALICE,
          service,
          NOW_MS,
          NOW_MS,
        );
      }
      seedSnapshotJob(db, ALICE, generation);
      db.run('UPDATE users SET last_snapshot_at_ms=? WHERE did=?', NOW_MS - 1000, ALICE);
      for (const proof of [first, second]) {
        db.tx(() =>
          applyRecordProof(db, proof, {
            prefix: PREFIX,
            receiptNs: NOW_NS,
            nowNs: NOW_NS,
            liveCandidates: true,
            live: { random, evidence: null, legacyRev: null },
          }),
        );
      }
      expect(
        db.tx(() =>
          lateAccept(db, {
            uri: `at://${ALICE}/${collection}/two-links`,
            did: ALICE,
            collection,
            rkey: 'two-links',
            evidence: event(second, 'update'),
            nowMs: NOW_MS + 1000,
            random,
          }),
        ),
      ).toBe(1);
      expect(
        db.all<{ link_id: string }>('SELECT link_id FROM forward_outbox ORDER BY link_id').map((r) => r.link_id),
      ).toEqual(['two-links-lastfm', 'two-links-listenbrainz']);
      expect(
        db.all<{ label: string; value: number }>(
          "SELECT label,value FROM counters WHERE name='live_admission' AND label LIKE 'late_%' ORDER BY label",
        ),
      ).toEqual([{ label: 'late_accepted', value: 1 }]);
    });
  },
);
