import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { runLinkBackfill } from '../../../src/forward/backfill';
import { admitForwardIdentity, projectionListenKey } from '../../../src/forward/projection';
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

type PresentProof = Extract<Awaited<ReturnType<typeof proofAt>>, { state: 'present' }>;
const present = (proof: Awaited<ReturnType<typeof proofAt>>): PresentProof => {
  if (proof.state !== 'present') throw new Error('expected present proof');
  return proof;
};

it('snapshot replacement preserves an established import admission and source exclusion', async () => {
  const repo = await repoFor('alice');
  const old = present(await putProof(repo, SCROBBLE, 'import-replacement', fixtureScrobble('r02')));
  const oldRecord = old.record as Record<string, unknown>;
  const replacement = present(
    await putProof(repo, SCROBBLE, 'import-replacement', { ...oldRecord, track: 'Replacement track' }),
  );
  const row = replacement.record as { listenedAt: string; artist: string; track: string };
  const [artistKey, trackKeyValue] = trackKey(row.artist, row.track);
  const identityKey = projectionListenKey(ALICE, row.listenedAt, artistKey, trackKeyValue);
  await withMigratedDb(async (db) => {
    const generation = seedUser(db, ALICE);
    db.run('UPDATE users SET last_snapshot_at_ms=? WHERE did=?', NOW_MS - 1000, ALICE);
    seedSnapshotJob(db, ALICE, generation);
    db.tx(() => applyRecordProof(db, old, { prefix: PREFIX, receiptNs: NOW_NS, nowNs: NOW_NS }));
    expect(
      admitForwardIdentity(db, {
        did: ALICE,
        identityKey,
        path: 'import',
        sourceService: 'lastfm',
        now: NOW_MS,
      }),
    ).toBe(true);
    db.tx(() =>
      applySnapshotChunk(db, {
        did: ALICE,
        generation,
        headRev: replacement.commit.rev,
        intervalLo: null,
        intervalHi: `${SCROBBLE}/import-replacement`,
        entries: [{ key: `${SCROBBLE}/import-replacement`, cid: replacement.cid, record: replacement.record }],
        receiptNs: NOW_NS,
        nowNs: NOW_NS + 1_000_000_000n,
        prefix: PREFIX,
      }),
    );
    expect(
      db.one('SELECT path,source_service FROM forward_admissions WHERE did=? AND identity_key=?', ALICE, identityKey),
    ).toEqual({ path: 'import', source_service: 'lastfm' });
    const admissionSeq = db.one<{ admission_seq: number }>(
      'SELECT admission_seq FROM forward_admissions WHERE did=? AND identity_key=?',
      ALICE,
      identityKey,
    )!.admission_seq;
    const link = (id: string, service: 'lastfm' | 'listenbrainz') => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,X'00','fixture',?,?)`,
        id,
        ALICE,
        service,
        `remote-${id}`,
        NOW_MS,
        NOW_MS,
      );
      db.run('UPDATE linked_accounts SET generation_start_seq=? WHERE id=?', admissionSeq, id);
    };
    link('import-source-lastfm', 'lastfm');
    for (let turn = 0; turn < 5; turn++) await runLinkBackfill(db, seededRandom(1 + turn), NOW_MS);
    expect(db.one("SELECT backfill_state FROM linked_accounts WHERE id='import-source-lastfm'")).toEqual({
      backfill_state: 'done',
    });
    expect(db.all("SELECT id FROM forward_outbox WHERE link_id='import-source-lastfm'")).toEqual([]);

    link('other-destination-lb', 'listenbrainz');
    for (let turn = 0; turn < 5; turn++) await runLinkBackfill(db, seededRandom(20 + turn), NOW_MS);
    expect(db.all("SELECT kind FROM forward_outbox WHERE link_id='other-destination-lb'")).toEqual([
      { kind: 'scrobble' },
    ]);
  });
});
