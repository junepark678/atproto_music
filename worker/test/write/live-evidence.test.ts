import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import {
  absenceAuthority,
  additionAuthority,
  isStale,
  type LiveEvidence,
  readLiveEvidence,
  recordLiveEvidence,
  replacementAuthority,
} from '../../src/do/ingest/live-evidence';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { runLinkBackfill } from '../../src/forward/backfill';
import { lateAccept } from '../../src/forward/live-acceptance';
import { withMigratedDb } from '../node/support/node-db';
import { ALICE, fixtureScrobble, NOW_MS, OPTS, PREFIX, putProof, repoFor, SCROBBLE, seedUser } from './support';

const R1 = '2222222222222';
const R2 = '3333333333333';
const R3 = '4444444444444';
const CID_A = 'bafya';
const CID_B = 'bafyb';
const CID_C = 'bafyc';
const uri = 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r01';
const event = { uri, did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', collection: 'com.example.atmusic.scrobble', rkey: 'r01' };
const up = (
  rev = R1,
  cid = CID_A,
  action: 'create' | 'update' = 'create',
  conflict: string | null = null,
): LiveEvidence => ({
  up_rev: rev,
  up_action: action,
  up_cid: cid,
  del_rev: null,
  conflict_rev: conflict,
});

describe('live evidence authority', () => {
  it('requires one exact event CID and permits a proof at or after its revision', () => {
    expect(additionAuthority({ evidence: up(), legacyRev: null }, R2, CID_A)).toBe(true);
    expect(additionAuthority({ evidence: up(), legacyRev: null }, R2, CID_B)).toBe(false);
    expect(additionAuthority({ evidence: up(), legacyRev: null }, R1, CID_A)).toBe(true);
    expect(additionAuthority({ evidence: up(R2), legacyRev: null }, R1, CID_A)).toBe(false);
    expect(additionAuthority({ evidence: up(R1, CID_A, 'create', R1), legacyRev: null }, R2, CID_A)).toBe(false);
    expect(additionAuthority({ evidence: up(R1, CID_A, 'create', R1), legacyRev: R1 }, R1, CID_A)).toBe(false);
  });

  it('authorizes absence only from an explicit delete in (R0, P], never from a legacy hint', () => {
    const deleted = { ...up(), del_rev: R2 };
    expect(absenceAuthority({ evidence: deleted, legacyRev: null }, R1, R2)).toBe(R2);
    expect(absenceAuthority({ evidence: deleted, legacyRev: null }, R2, R2)).toBeNull();
    expect(absenceAuthority({ evidence: deleted, legacyRev: null }, R1, R1)).toBeNull();
    expect(absenceAuthority({ evidence: null, legacyRev: R2 }, R1, R2)).toBeNull();
    expect(absenceAuthority({ evidence: { ...deleted, conflict_rev: R2 }, legacyRev: null }, R1, R2)).toBeNull();
  });

  it('authorizes a replacement only from a matching update CID, not a create or mismatched CID', () => {
    expect(replacementAuthority({ evidence: up(R2, CID_B, 'update'), legacyRev: null }, R1, R2, CID_B)).toBe(R2);
    expect(replacementAuthority({ evidence: up(R2, CID_B, 'update'), legacyRev: null }, R1, R2, CID_A)).toBeNull();
    expect(replacementAuthority({ evidence: up(R2, CID_B, 'create'), legacyRev: null }, R1, R2, CID_B)).toBeNull();
    expect(replacementAuthority({ evidence: up(R2, CID_B, 'update'), legacyRev: null }, R2, R2, CID_B)).toBeNull();
  });

  it('keeps stale proofs out of every projection decision', () => {
    const evidence = { ...up(R2), del_rev: R3 };
    expect(isStale(evidence, R1)).toBe(true);
    expect(isStale(evidence, R3)).toBe(false);
    expect(isStale(null, R1)).toBe(false);
  });

  it('coalesces out-of-order events without regressing tuples and makes same-revision conflicts sticky until newer evidence', async () => {
    await withMigratedDb((db) => {
      const evidencePlan = db
        .all<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT * FROM live_record_evidence WHERE uri=? AND expires_at_ms>?',
          uri,
          0,
        )
        .map((step) => step.detail)
        .join(' ');
      const candidatePlan = db
        .all<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT identity_key FROM live_acceptance_candidates WHERE uri=? AND cid=? AND expires_at_ms>?',
          uri,
          CID_A,
          0,
        )
        .map((step) => step.detail)
        .join(' ');
      const expiryPlan = db
        .all<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT rowid FROM live_acceptance_candidates WHERE expires_at_ms<=? ORDER BY expires_at_ms,uri,identity_key LIMIT 200',
          1,
        )
        .map((step) => step.detail)
        .join(' ');
      expect(evidencePlan).toContain('sqlite_autoindex_live_record_evidence');
      expect(candidatePlan).toContain('sqlite_autoindex_live_acceptance_candidates');
      expect(expiryPlan).toContain('live_acceptance_candidates_expiry');
      db.tx(() => recordLiveEvidence(db, { ...event, rev: R1, action: 'create', cid: CID_A }, 10));
      db.tx(() => recordLiveEvidence(db, { ...event, rev: R1, action: 'create', cid: CID_B }, 11));
      expect(readLiveEvidence(db, uri, 11)).toEqual({ ...up(R1, CID_A), conflict_rev: R1 });

      db.tx(() => recordLiveEvidence(db, { ...event, rev: R2, action: 'delete' }, 12));
      expect(readLiveEvidence(db, uri, 12)).toEqual({ ...up(R1, CID_A), del_rev: R2, conflict_rev: null });

      db.tx(() => recordLiveEvidence(db, { ...event, rev: R1, action: 'create', cid: CID_B }, 13));
      expect(readLiveEvidence(db, uri, 13)).toEqual({ ...up(R1, CID_A), del_rev: R2, conflict_rev: R1 });

      db.tx(() => recordLiveEvidence(db, { ...event, rev: R3, action: 'update', cid: CID_C }, 14));
      expect(readLiveEvidence(db, uri, 14)).toEqual({ ...up(R3, CID_C, 'update'), del_rev: R2, conflict_rev: null });
      expect(readLiveEvidence(db, uri, 14 + 6 * 60 * 60 * 1000)).toBeNull();
    });
  });

  it('keeps a snapshot candidate until a matching Jetstream event late-accepts it exactly once', async () => {
    const repo = await repoFor('alice');
    const proof = await putProof(repo, SCROBBLE, 'late-candidate', fixtureScrobble('r02'));
    if (proof.state !== 'present') throw new Error('expected signed present proof');
    const candidateUri = `at://${ALICE}/${SCROBBLE}/late-candidate`;
    const random = seededRandom(0xa1c);
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
         VALUES('late-candidate-link',?,'lastfm','remote',X'00','fixture',?,?)`,
        ALICE,
        NOW_MS,
        NOW_MS,
      );
      db.tx(() =>
        applyRecordProof(db, proof, {
          ...OPTS,
          prefix: PREFIX,
          live: { random, evidence: null, legacyRev: null },
          liveCandidates: true,
        }),
      );
      expect(db.all('SELECT * FROM live_acceptance_candidates')).toHaveLength(1);
      expect(db.all('SELECT * FROM forward_outbox')).toHaveLength(0);

      db.tx(() =>
        recordLiveEvidence(
          db,
          {
            ...event,
            uri: candidateUri,
            did: ALICE,
            collection: SCROBBLE,
            rkey: 'late-candidate',
            rev: proof.commit.rev,
            action: 'create',
            cid: proof.cid,
          },
          NOW_MS,
        ),
      );
      const evidence = readLiveEvidence(db, candidateUri, NOW_MS);
      const args = {
        uri: candidateUri,
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'late-candidate',
        evidence,
        nowMs: NOW_MS,
        random,
      };
      expect(lateAccept(db, args)).toBe(1);
      expect(db.all('SELECT kind FROM forward_outbox')).toEqual([{ kind: 'scrobble' }]);
      expect(db.all('SELECT * FROM live_acceptance_candidates')).toHaveLength(0);
      expect(lateAccept(db, args)).toBe(0);
      expect(db.all('SELECT kind FROM forward_outbox')).toHaveLength(1);
    });
  });

  it('keeps late scrobble and love acceptance snapshot-owned while forwarding is disabled, then backfills once', async () => {
    const repo = await repoFor('alice');
    const scrobbleProof = await putProof(repo, SCROBBLE, 'disabled-late-scrobble', fixtureScrobble('r03'));
    const loveCollection = `${PREFIX}.love`;
    const loveProof = await putProof(repo, loveCollection, 'disabled-late-love', {
      $type: loveCollection,
      artist: 'Björk',
      track: 'Jóga',
      createdAt: '2026-01-15T11:00:00Z',
    });
    if (scrobbleProof.state !== 'present' || loveProof.state !== 'present') throw new Error('expected signed proofs');
    const scrobbleUri = `at://${ALICE}/${SCROBBLE}/disabled-late-scrobble`;
    const loveUri = `at://${ALICE}/${loveCollection}/disabled-late-love`;
    const random = seededRandom(0xb10);
    await withMigratedDb(async (db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,forward_scrobbles,created_at_ms,updated_at_ms)
         VALUES('disabled-late-link',?,'lastfm','remote',X'00','fixture',0,?,?)`,
        ALICE,
        NOW_MS,
        NOW_MS,
      );
      for (const proof of [scrobbleProof, loveProof])
        db.tx(() =>
          applyRecordProof(db, proof, {
            ...OPTS,
            live: { random, evidence: null, legacyRev: null },
            liveCandidates: true,
          }),
        );

      expect(
        db.all<{ path: string }>('SELECT path FROM forward_admissions WHERE did=? ORDER BY identity_key', ALICE),
      ).toEqual([{ path: 'snapshot' }, { path: 'snapshot' }]);
      expect(db.all('SELECT * FROM forward_outbox')).toEqual([]);
      expect(db.all('SELECT * FROM forward_receipts')).toEqual([]);
      for (const [collection, rkey, proof, candidateUri] of [
        [SCROBBLE, 'disabled-late-scrobble', scrobbleProof, scrobbleUri],
        [loveCollection, 'disabled-late-love', loveProof, loveUri],
      ] as const) {
        const evidence = {
          up_rev: proof.commit.rev,
          up_action: 'create' as const,
          up_cid: proof.cid,
          del_rev: null,
          conflict_rev: null,
        };
        expect(
          lateAccept(db, { uri: candidateUri, did: ALICE, collection, rkey, evidence, nowMs: NOW_MS, random }),
        ).toBe(1);
      }
      expect(db.all('SELECT * FROM forward_outbox')).toEqual([]);
      expect(db.all('SELECT * FROM forward_receipts')).toEqual([]);
      expect(
        db.all<{ path: string }>('SELECT path FROM forward_admissions WHERE did=? ORDER BY identity_key', ALICE),
      ).toEqual([{ path: 'snapshot' }, { path: 'snapshot' }]);

      db.run(
        "UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='pending' WHERE id=?",
        'disabled-late-link',
      );
      for (let i = 0; i < 5; i++) await runLinkBackfill(db, seededRandom(0xb11 + i), NOW_MS);
      expect(db.all('SELECT kind FROM forward_outbox ORDER BY kind')).toEqual([{ kind: 'love' }, { kind: 'scrobble' }]);
      expect(db.all('SELECT kind FROM forward_receipts ORDER BY kind')).toEqual([
        { kind: 'love' },
        { kind: 'scrobble' },
      ]);
      for (let i = 0; i < 5; i++) await runLinkBackfill(db, seededRandom(0xb21 + i), NOW_MS);
      expect(db.all('SELECT kind FROM forward_outbox ORDER BY kind')).toEqual([{ kind: 'love' }, { kind: 'scrobble' }]);
    });
  });

  it('refreshes an owned candidate CID across metadata updates without extending its TTL', async () => {
    const repo = await repoFor('alice');
    const first = await putProof(repo, SCROBBLE, 'candidate-metadata', fixtureScrobble('r02'));
    const next = await putProof(repo, SCROBBLE, 'candidate-metadata', {
      ...fixtureScrobble('r02'),
      album: 'updated album',
    });
    if (first.state !== 'present' || next.state !== 'present') throw new Error('expected signed present proofs');
    const candidateUri = `at://${ALICE}/${SCROBBLE}/candidate-metadata`;
    const random = seededRandom(0xc1d);
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
         VALUES('candidate-metadata-link',?,'lastfm','remote',X'00','fixture',?,?)`,
        ALICE,
        NOW_MS,
        NOW_MS,
      );
      db.tx(() =>
        applyRecordProof(db, first, {
          ...OPTS,
          live: { random, evidence: null, legacyRev: null },
          liveCandidates: true,
        }),
      );
      const original = db.one<{ created_at_ms: number; expires_at_ms: number }>(
        'SELECT created_at_ms,expires_at_ms FROM live_acceptance_candidates WHERE uri=?',
        candidateUri,
      );
      expect(original).not.toBeNull();
      db.tx(() =>
        applyRecordProof(db, next, {
          ...OPTS,
          live: { random, evidence: null, legacyRev: null },
          liveCandidates: true,
        }),
      );
      expect(db.one<{ cid: string }>('SELECT cid FROM live_acceptance_candidates WHERE uri=?', candidateUri)?.cid).toBe(
        next.cid,
      );
      expect(
        db.one('SELECT created_at_ms,expires_at_ms FROM live_acceptance_candidates WHERE uri=?', candidateUri),
      ).toEqual(original);
      const evidence = {
        up_rev: next.commit.rev,
        up_action: 'update' as const,
        up_cid: next.cid,
        del_rev: null,
        conflict_rev: null,
      };
      expect(
        lateAccept(db, {
          uri: candidateUri,
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'candidate-metadata',
          evidence,
          nowMs: NOW_MS,
          random,
        }),
      ).toBe(1);
      expect(db.all('SELECT kind FROM forward_outbox')).toEqual([{ kind: 'scrobble' }]);
    });
  });
});
