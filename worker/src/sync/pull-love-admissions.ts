import type { Db } from '../do/db';

/**
 * Accepted pull love identities survive operation cleanup until that exact
 * repository incarnation is removed or a local unlove supersedes it. Key and
 * MBID are independent aliases: title corrections cannot create a second
 * love for the same recording.
 */
export function hasActivePullLoveAdmission(
  db: Db,
  args: { did: string; loveKey: string; recordingMbid: string | null },
): boolean {
  return (
    db.one(
      `SELECT 1 AS hit FROM linked_pull_love_admissions
       WHERE did=? AND state IN ('accepted','present')
         AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?)) LIMIT 1`,
      args.did,
      args.loveKey,
      args.recordingMbid,
      args.recordingMbid,
    ) !== null
  );
}

export function insertPullLoveAdmission(
  db: Db,
  args: {
    did: string;
    linkId: string;
    generation: number;
    operationId: string;
    loveKey: string;
    recordingMbid: string | null;
    sourceService: string;
    sourceAccount: string;
    nowMs: number;
  },
): void {
  db.run(
    `INSERT INTO linked_pull_love_admissions(
       did,link_id,generation,operation_id,love_key,recording_mbid,source_service,source_account,state,updated_at_ms
     ) VALUES(?,?,?,?,?,?,?,?, 'accepted',?)`,
    args.did,
    args.linkId,
    args.generation,
    args.operationId,
    args.loveKey,
    args.recordingMbid,
    args.sourceService,
    args.sourceAccount,
    args.nowMs,
  );
}

/** Bind accepted alias/source evidence to the repository incarnation after a confirmed PDS write. */
export function bindPullLoveAdmission(
  db: Db,
  args: { did: string; operationId: string; uri: string; incarnationKey: string; nowMs: number },
): void {
  db.run(
    `UPDATE linked_pull_love_admissions
     SET state=CASE WHEN state='accepted' THEN 'present' ELSE state END,uri=?,incarnation_key=?,updated_at_ms=?
     WHERE did=? AND operation_id=? AND state IN ('accepted','retired')`,
    args.uri,
    args.incarnationKey,
    args.nowMs,
    args.did,
    args.operationId,
  );
}

/** A local delete supersedes, but retains, prior pull identity evidence for precise alias tombstones. */
export function retirePullLoveAdmissions(
  db: Db,
  args: { did: string; loveKey: string; recordingMbid?: string | null; nowMs: number },
): Array<{ love_key: string; recording_mbid: string | null; source_service: string; source_account: string }> {
  const aliases = db.all<{
    love_key: string;
    recording_mbid: string | null;
    source_service: string;
    source_account: string;
  }>(
    `SELECT love_key,recording_mbid,source_service,source_account FROM linked_pull_love_admissions
     WHERE did=? AND state IN ('accepted','present')
       AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?))`,
    args.did,
    args.loveKey,
    args.recordingMbid ?? null,
    args.recordingMbid ?? null,
  );
  db.run(
    `UPDATE linked_pull_love_admissions SET state='retired',updated_at_ms=?
     WHERE did=? AND state IN ('accepted','present')
       AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?))`,
    args.nowMs,
    args.did,
    args.loveKey,
    args.recordingMbid ?? null,
    args.recordingMbid ?? null,
  );
  return aliases;
}

/** Use durable admission provenance if operation-based receipts have been collected. */
export function pullLoveAdmissionForUri(
  db: Db,
  args: { did: string; uri: string },
): { incarnation_key: string | null; source_service: string; source_account: string } | null {
  return db.one(
    `SELECT incarnation_key,source_service,source_account FROM linked_pull_love_admissions
     WHERE did=? AND uri=? AND state IN ('accepted','present','retired')
     ORDER BY CASE state WHEN 'present' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,updated_at_ms DESC,operation_id DESC LIMIT 1`,
    args.did,
    args.uri,
  );
}

export function retirePullLoveAdmissionUri(db: Db, args: { did: string; uri: string; nowMs: number }): void {
  db.run(
    `UPDATE linked_pull_love_admissions SET state='superseded',updated_at_ms=?
     WHERE did=? AND uri=? AND state IN ('accepted','present','retired')`,
    args.nowMs,
    args.did,
    args.uri,
  );
}
