import type { Random } from '@atmusic/core/deps';
import type { Db } from '../do/db';
import { countLiveAdmission, type LiveEvidence } from '../do/ingest/live-evidence';
import { projectedListensOfRecord } from '../do/write/apply-record';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { type HistoryRow, payloadForHistoryRow, scrobbleHistoryRow } from './backfill';
import { cancelLoveApiRecipientDecisionsForUri } from './love-api-recipients';
import { projectionListenKey } from './projection';

export function dropLiveState(db: Db, uri: string): void {
  db.tx(() => {
    cancelLoveApiRecipientDecisionsForUri(db, uri);
    db.run('DELETE FROM live_record_evidence WHERE uri=?', uri);
    db.run('DELETE FROM live_acceptance_candidates WHERE uri=?', uri);
    db.run('DELETE FROM live_pending_removals WHERE uri=?', uri);
    db.run('DELETE FROM live_pending_removal_events WHERE uri=?', uri);
    db.run('DELETE FROM live_pending_removal_reconcile WHERE uri=?', uri);
  });
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
        const links = db.all<{
          id: string;
          did: string;
          generation: number;
          service: 'lastfm' | 'listenbrainz';
          status: string;
          forward_scrobbles: number;
          generation_start_seq: number;
        }>(`SELECT * FROM linked_accounts WHERE did=? AND status='active' AND forward_scrobbles=1`, input.did);
        const historyRow = scrobbleHistoryRow(db, input.did, row.uri);
        if (!historyRow || historyRow.cid !== row.cid) continue;
        for (const link of links) {
          if (link.service === 'lastfm' && Date.parse(row.listened_at) < input.nowMs - 13 * 86_400_000) continue;
          const admitted = payloadForHistoryRow(db, link, historyRow, candidate.identity_key, {
            allowLiveAdmission: true,
          });
          if (!admitted) continue;
          enqueueForwards(db, {
            did: input.did,
            linkId: link.id,
            priority: 1,
            items: [{ kind: 'scrobble', listenKey: admitted.key, payload: admitted.payload }],
            now: input.nowMs,
            random: input.random,
          });
        }
        // One accepted candidate, however many linked services it was forwarded to.
        accepted++;
      }
    } else {
      const row = db.one<{
        cid: string;
        artist: string;
        track: string;
        album: string | null;
        recording_mbid: string | null;
        created_at: string;
        artist_key: string;
        track_key: string;
      }>(
        'SELECT cid,artist,track,album,recording_mbid,created_at,artist_key,track_key FROM loves WHERE uri=?',
        candidate.member_uri,
      );
      if (row?.cid === evidence.up_cid) {
        const links = db.all<{
          id: string;
          did: string;
          generation: number;
          service: 'lastfm' | 'listenbrainz';
          generation_start_seq: number;
        }>(`SELECT * FROM linked_accounts WHERE did=? AND status='active' AND forward_scrobbles=1`, input.did);
        const historyRow: HistoryRow = {
          kind: 'love',
          uri: candidate.member_uri,
          cid: row.cid,
          event_at: row.created_at,
          artist: row.artist,
          track: row.track,
          album: row.album,
          recording_mbid: row.recording_mbid,
          artist_key: row.artist_key,
          track_key: row.track_key,
          album_key: null,
          listened_at: null,
        };
        const admitted = links.flatMap((link) => {
          const result = payloadForHistoryRow(db, link, historyRow, candidate.identity_key, {
            allowLiveAdmission: true,
          });
          return result ? [{ link, result }] : [];
        });
        const changed = db.run(
          `UPDATE love_incarnations SET path='live',updated_at_ms=? WHERE uri=? AND incarnation_key=? AND state='present' AND path='snapshot'`,
          input.nowMs,
          candidate.member_uri,
          candidate.identity_key,
        ).rowsWritten;
        if (changed === 1) {
          accepted++;
          for (const { link, result } of admitted) {
            enqueueForwards(db, {
              did: input.did,
              linkId: link.id,
              items: [{ kind: 'love', operationId: result.key, payload: result.payload }],
              now: input.nowMs,
              random: input.random,
            });
          }
        }
      }
    }
  }
  db.run('DELETE FROM live_acceptance_candidates WHERE uri=? AND cid=?', input.uri, evidence.up_cid);
  countLiveAdmission(db, 'late_accepted', accepted);
  countLiveAdmission(db, 'late_rejected', candidates.length - accepted);
  return accepted;
}
