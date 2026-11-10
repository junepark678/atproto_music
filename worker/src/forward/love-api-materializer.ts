import type { Random } from '@atmusic/core/deps';
import type { Db } from '../do/db';
import { type ApiRecipientUnloveAck, enqueueApiRecipientUnlove } from '../outbox/forward-enqueue';
import { type LoveApiMaterializerCandidate, prepareLoveApiRecipientHandoff } from './love-api-recipients';
import { recordVerifiedDeferredLoveAuthority } from './love-coverage-authority';

export const LOVE_API_MATERIALIZER_PAGE = 8;
export const LOVE_API_MATERIALIZER_RETRY_MS = 1_000;

export interface LoveApiMaterializerResult {
  visited: number;
  queued: number;
  deferred: number;
  replay: number;
  refused: number;
  awaiting: number;
  expired: number;
}

const AGGREGATE_WHERE = 'did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?';

function releaseDecision(db: Db, candidate: LoveApiMaterializerCandidate, nowMs: number): void {
  db.run(
    `DELETE FROM love_api_unlove_decisions WHERE ${AGGREGATE_WHERE}`,
    candidate.did,
    candidate.uri,
    candidate.incarnationKey,
    candidate.linkId,
    candidate.generation,
  );
  db.run(
    `UPDATE love_api_recipients SET state='released',updated_at_ms=?
     WHERE ${AGGREGATE_WHERE} AND state IN ('present','sealed')`,
    nowMs,
    candidate.did,
    candidate.uri,
    candidate.incarnationKey,
    candidate.linkId,
    candidate.generation,
  );
}

/** One bounded, synchronous page. All durable handoff effects and completion share this transaction. */
export function materializeLoveApiRecipientDecisions(
  db: Db,
  nowMs: number,
  random: Random,
  sessionToken: string,
  limit = LOVE_API_MATERIALIZER_PAGE,
): LoveApiMaterializerResult {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    sessionToken.length === 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LOVE_API_MATERIALIZER_PAGE
  )
    throw new RangeError('invalid API love materializer bounds');
  return db.tx(() => {
    const candidates = db.all<LoveApiMaterializerCandidate>(
      `SELECT did,uri,incarnation_key AS incarnationKey,link_id AS linkId,generation
       FROM love_api_unlove_decisions INDEXED BY love_api_unlove_decisions_due
       WHERE due_at_ms<=? ORDER BY due_at_ms,did,uri,incarnation_key,link_id,generation LIMIT ?`,
      nowMs,
      limit,
    );
    const result: LoveApiMaterializerResult = {
      visited: candidates.length,
      queued: 0,
      deferred: 0,
      replay: 0,
      refused: 0,
      awaiting: 0,
      expired: 0,
    };
    for (const candidate of candidates) {
      const prepared = prepareLoveApiRecipientHandoff(db, candidate, sessionToken, nowMs);
      if (prepared.status === 'awaiting') {
        db.run(
          `UPDATE love_api_unlove_decisions SET due_at_ms=max(due_at_ms,?) WHERE ${AGGREGATE_WHERE}`,
          nowMs + LOVE_API_MATERIALIZER_RETRY_MS,
          candidate.did,
          candidate.uri,
          candidate.incarnationKey,
          candidate.linkId,
          candidate.generation,
        );
        result.awaiting++;
        continue;
      }
      if (prepared.status === 'expired') {
        releaseDecision(db, candidate, nowMs);
        result.expired++;
        continue;
      }
      if (prepared.status !== 'ready') {
        releaseDecision(db, candidate, nowMs);
        result.refused++;
        continue;
      }
      const authorization = prepared.envelope.authorization;
      const retained = recordVerifiedDeferredLoveAuthority(
        db,
        authorization,
        { action: prepared.envelope.action, cid: prepared.envelope.cid },
        nowMs,
      );
      if (retained !== 'active') {
        result.refused++;
        releaseDecision(db, candidate, nowMs);
        continue;
      }
      const broadOperationId = `love-delete:${prepared.envelope.incarnationKey}:rev:${authorization.rev}`;
      const ack: ApiRecipientUnloveAck = enqueueApiRecipientUnlove(db, {
        did: candidate.did,
        linkId: candidate.linkId,
        generation: candidate.generation,
        broadOperationId,
        operationId: `${broadOperationId}:api-recipient`,
        envelope: prepared.envelope,
        now: nowMs,
        random,
      });
      result[ack.status]++;
      // Each acknowledgement closes this exact recipient aggregate atomically.
      releaseDecision(db, candidate, nowMs);
    }
    return result;
  });
}
