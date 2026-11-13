import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import {
  type HistoryEligibilityLink,
  type HistoryRow,
  payloadForHistoryRow,
  runLinkBackfill,
} from '../../../src/forward/backfill';
import { lateAccept } from '../../../src/forward/live-acceptance';
import { ALICE, NOW_MS, NOW_NS, PREFIX, type proofAt, putProof, repoFor, seedUser } from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const LOVE = `${PREFIX}.love`;
const random = seededRandom(901);
type PresentProof = Extract<Awaited<ReturnType<typeof proofAt>>, { state: 'present' }>;
const present = (proof: Awaited<ReturnType<typeof proofAt>>): PresentProof => {
  if (proof.state !== 'present') throw new Error('expected present proof');
  return proof;
};

async function setup(exclusion: 'explicit-unlove' | 'source-bridge' | null) {
  const repo = await repoFor('alice');
  const proof = present(
    await putProof(repo, LOVE, `love-promotion-${exclusion ?? 'eligible'}`, {
      $type: LOVE,
      artist: 'History Artist',
      track: 'History Track',
      createdAt: '2026-01-15T11:00:00Z',
    }),
  );
  await withMigratedDb(async (db) => {
    seedUser(db, ALICE);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms,forward_scrobbles)
       VALUES('love-promotion-link',?,'lastfm','remote',X'00','fixture',?,?,1)`,
      ALICE,
      NOW_MS,
      NOW_MS,
    );
    db.tx(() =>
      applyRecordProof(db, proof, {
        prefix: PREFIX,
        receiptNs: NOW_NS,
        nowNs: NOW_NS,
        liveCandidates: true,
        live: { random, evidence: null, legacyRev: null },
      }),
    );
    const row = db.one<{
      uri: string;
      artist: string;
      track: string;
      artist_key: string;
      track_key: string;
    }>(
      'SELECT uri,artist,track,artist_key,track_key FROM loves WHERE uri=?',
      `at://${ALICE}/${LOVE}/love-promotion-${exclusion ?? 'eligible'}`,
    )!;
    const candidate = db.one<{ identity_key: string }>('SELECT identity_key FROM live_acceptance_candidates')!;
    if (exclusion === 'explicit-unlove')
      db.run(
        'INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,?,?,?)',
        ALICE,
        `${row.artist_key}\0${row.track_key}`,
        'unlove',
        'explicit-unlove',
        NOW_MS,
      );
    if (exclusion === 'source-bridge')
      db.run(
        "INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms) VALUES(?,?,?,?,?,'bound',?)",
        ALICE,
        'source-operation',
        row.uri,
        candidate.identity_key,
        'lastfm',
        NOW_MS,
      );
    const historyRow = db.one<HistoryRow>(
      `SELECT 'love' AS kind,uri,cid,created_at AS event_at,artist,track,album,recording_mbid,
       artist_key,track_key,NULL AS album_key,NULL AS listened_at FROM loves WHERE uri=?`,
      row.uri,
    )!;
    const link = db.one<HistoryEligibilityLink>("SELECT * FROM linked_accounts WHERE id='love-promotion-link'")!;
    const eligible = payloadForHistoryRow(db, link, historyRow, candidate.identity_key);
    expect(eligible === null).toBe(exclusion !== null);
    for (let turn = 0; turn < 5; turn++) await runLinkBackfill(db, random, NOW_MS);
    if (exclusion) {
      expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
    } else {
      const before = db.all<{ link_id: string; kind: string; dedupe_key: string; payload_json: string; state: string }>(
        'SELECT link_id,kind,dedupe_key,payload_json,state FROM forward_outbox',
      );
      expect(before).toHaveLength(1);
      db.run("UPDATE forward_outbox SET state='sent'");
      db.tx(() =>
        lateAccept(db, {
          uri: row.uri,
          did: ALICE,
          collection: LOVE,
          rkey: `love-promotion-${exclusion ?? 'eligible'}`,
          evidence: {
            up_rev: proof.commit.rev,
            up_action: 'create',
            up_cid: proof.cid,
            del_rev: null,
            conflict_rev: null,
          },
          nowMs: NOW_MS,
          random,
        }),
      );
      expect(db.all('SELECT link_id,kind,dedupe_key,payload_json,state FROM forward_outbox')).toEqual(
        before.map((entry) => ({ ...entry, state: 'sent' })),
      );
      return;
    }
    db.tx(() =>
      lateAccept(db, {
        uri: row.uri,
        did: ALICE,
        collection: LOVE,
        rkey: `love-promotion-${exclusion ?? 'eligible'}`,
        evidence: {
          up_rev: proof.commit.rev,
          up_action: 'create',
          up_cid: proof.cid,
          del_rev: null,
          conflict_rev: null,
        },
        nowMs: NOW_MS,
        random,
      }),
    );
    expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);
  });
}

it.each(['explicit-unlove', 'source-bridge'] as const)(
  'snapshot-first love promotion preserves the %s history exclusion',
  (exclusion) => setup(exclusion),
);

it('eligible love promotion uses the history key and dedupes against a sent history row', () => setup(null));
