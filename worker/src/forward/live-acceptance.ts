import type { Random } from '@atmusic/core/deps';
import type { Db } from '../do/db';
import { countLiveAdmission, type LiveEvidence } from '../do/ingest/live-evidence';
import { projectedListensOfRecord } from '../do/write/apply-record';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { projectionListenKey } from './projection';

export function dropLiveState(db: Db, uri: string): void {
  db.run('DELETE FROM live_record_evidence WHERE uri=?', uri);
  db.run('DELETE FROM live_acceptance_candidates WHERE uri=?', uri);
  db.run('DELETE FROM live_pending_removals WHERE uri=?', uri);
  db.run('DELETE FROM live_pending_removal_events WHERE uri=?', uri);
}

export function deleteLiveCandidates(db: Db, uri: string): void {
  db.run('DELETE FROM live_acceptance_candidates WHERE uri=?', uri);
}

/** Accept snapshot-first identities once a later Jetstream event proves the exact projected CID. */
export function lateAccept(
  db: Db,
  input: {
    uri: string;
    did: string;
    collection: string;
    rkey: string;
    evidence: LiveEvidence | null;
    nowMs: number;
    random: Random;
  },
): number {
  const evidence = input.evidence;
  if (
    evidence?.up_rev === null ||
    evidence?.up_rev === undefined ||
    evidence.conflict_rev === evidence.up_rev ||
    (evidence.del_rev !== null && evidence.del_rev >= evidence.up_rev)
  )
    return 0;
  const state = db.one<{ state: string; cid: string | null; revision: string }>(
    'SELECT state,cid,revision FROM record_state WHERE uri=?',
    input.uri,
  );
  if (state?.state !== 'present' || state.cid !== evidence.up_cid || state.revision < evidence.up_rev) return 0;
  const candidates = db.all<{ identity_key: string; kind: 'scrobble' | 'love'; member_uri: string; cid: string }>(
    `SELECT identity_key,kind,member_uri,cid FROM live_acceptance_candidates
     WHERE uri=? AND cid=? AND expires_at_ms>? ORDER BY identity_key LIMIT 10000`,
    input.uri,
    evidence.up_cid,
    input.nowMs,
  );
  if (candidates.length === 0) return 0;
  const listens = new Map(
    projectedListensOfRecord(db, input.did, input.uri)
      .filter((row) => row.cid === evidence.up_cid)
      .map((row) => [projectionListenKey(input.did, row.listened_at, row.artist_key, row.track_key), row]),
  );
  let accepted = 0;
  for (const candidate of candidates) {
    if (candidate.kind === 'scrobble') {
      const row = listens.get(candidate.identity_key);
      const marker = db.one<{ path: string }>(
        'SELECT path FROM forward_admissions WHERE did=? AND identity_key=?',
        input.did,
        candidate.identity_key,
      );
      const acceptedBefore = db.one(
        'SELECT 1 AS hit FROM listen_keys WHERE did=? AND dedupe_key=?',
        input.did,
        candidate.identity_key,
      );
      const local = db.one<{ origin: string }>(
        'SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1',
        input.did,
        input.collection,
        input.rkey,
      );
      if (row && marker?.path === 'snapshot' && acceptedBefore === null && local?.origin !== 'import') {
        enqueueForwards(db, {
          did: input.did,
          items: [
            {
              kind: 'scrobble',
              listenKey: candidate.identity_key,
              payload: {
                listen: {
                  artist: row.artist,
                  track: row.track,
                  listenedAt: row.listened_at,
                  recordingMbid: row.recording_mbid ?? undefined,
                },
                origin: 'web',
              },
            },
          ],
          now: input.nowMs,
          random: input.random,
        });
        accepted++;
      }
    } else {
      const row = db.one<{
        cid: string;
        artist: string;
        track: string;
        album: string | null;
        recording_mbid: string | null;
      }>('SELECT cid,artist,track,album,recording_mbid FROM loves WHERE uri=?', candidate.member_uri);
      if (row?.cid === evidence.up_cid) {
        const changed = db.run(
          `UPDATE love_incarnations SET path='live',updated_at_ms=? WHERE uri=? AND incarnation_key=? AND state='present' AND path='snapshot'`,
          input.nowMs,
          candidate.member_uri,
          candidate.identity_key,
        ).rowsWritten;
        if (changed === 1) {
          enqueueForwards(db, {
            did: input.did,
            items: [
              {
                kind: 'love',
                operationId: candidate.identity_key,
                payload: {
                  artist: row.artist,
                  track: row.track,
                  album: row.album ?? undefined,
                  recordingMbid: row.recording_mbid ?? undefined,
                  origin: 'web',
                },
              },
            ],
            now: input.nowMs,
            random: input.random,
          });
          accepted++;
        }
      }
    }
  }
  db.run('DELETE FROM live_acceptance_candidates WHERE uri=? AND cid=?', input.uri, evidence.up_cid);
  countLiveAdmission(db, 'late_accepted', accepted);
  countLiveAdmission(db, 'late_rejected', candidates.length - accepted);
  return accepted;
}
