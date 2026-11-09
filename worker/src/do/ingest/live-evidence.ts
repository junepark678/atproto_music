import type { Db } from '../db';

export const LIVE_EVIDENCE_TTL_MS = 6 * 60 * 60 * 1000;
export const LIVE_REHINT_DELAY_MS = 30_000;
export const LIVE_SWEEP_LIMIT = 200;

export function countLiveAdmission(db: Db, label: string, amount = 1): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  db.run(
    `INSERT INTO counters(name,label,value) VALUES('live_admission',?,?)
    ON CONFLICT(name,label) DO UPDATE SET value=counters.value+excluded.value`,
    label,
    amount,
  );
}

export type LiveAction = 'create' | 'update' | 'delete';
export interface LiveEvidence {
  up_rev: string | null;
  up_action: 'create' | 'update' | null;
  up_cid: string | null;
  del_rev: string | null;
  conflict_rev: string | null;
}
export interface LiveAuthority {
  evidence: LiveEvidence | null;
  /** Exact revision compatibility for a legacy Jetstream hint only. */
  legacyRev: string | null;
}

interface EvidenceRow extends LiveEvidence {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  received_ms: number;
  expires_at_ms: number;
}

export function isStale(evidence: LiveEvidence | null, proofRev: string): boolean {
  return evidence !== null && [evidence.up_rev, evidence.del_rev].some((rev) => rev !== null && proofRev < rev);
}

export function additionAuthority(authority: LiveAuthority | undefined, proofRev: string, cid: string): boolean {
  if (authority === undefined) return false;
  const { evidence, legacyRev } = authority;
  const eventAuthority =
    evidence?.up_rev !== null &&
    evidence?.up_rev !== undefined &&
    (evidence.del_rev === null || evidence.up_rev > evidence.del_rev) &&
    evidence.up_rev <= proofRev &&
    evidence.up_cid === cid &&
    evidence.conflict_rev !== evidence.up_rev;
  return eventAuthority || (legacyRev !== null && legacyRev === proofRev && evidence?.conflict_rev !== proofRev);
}

export function absenceAuthority(
  authority: LiveAuthority | undefined,
  priorRev: string | null,
  proofRev: string,
): string | null {
  if (authority === undefined) return null;
  const { evidence, legacyRev } = authority;
  if (evidence?.del_rev !== null && evidence?.del_rev !== undefined) {
    return (priorRev ?? '') < evidence.del_rev &&
      evidence.del_rev <= proofRev &&
      evidence.conflict_rev !== evidence.del_rev
      ? evidence.del_rev
      : null;
  }
  // A1's binding override: old action-less hints never authorize removal.
  void legacyRev;
  return null;
}

export function replacementAuthority(
  authority: LiveAuthority | undefined,
  priorRev: string | null,
  proofRev: string,
  cid: string,
): string | null {
  if (authority === undefined) return null;
  const evidence = authority.evidence;
  if (evidence && additionAuthority(authority, proofRev, cid)) {
    if (evidence.up_action === 'update' && (priorRev ?? '') < evidence.up_rev!) return evidence.up_rev;
  }
  return null;
}

export function readLiveEvidence(db: Db, uri: string, nowMs: number): LiveEvidence | null {
  const row = db.one<EvidenceRow>('SELECT * FROM live_record_evidence WHERE uri=? AND expires_at_ms>? ', uri, nowMs);
  if (!row) return null;
  const { up_rev, up_action, up_cid, del_rev, conflict_rev } = row;
  return { up_rev, up_action, up_cid, del_rev, conflict_rev };
}

export function recordLiveCandidate(
  db: Db,
  input: { uri: string; identityKey: string; kind: 'scrobble' | 'love'; memberUri: string; cid: string; nowMs: number },
): void {
  db.run(
    `INSERT INTO live_acceptance_candidates(uri,identity_key,kind,member_uri,cid,created_at_ms,expires_at_ms)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(uri,identity_key) DO UPDATE SET kind=excluded.kind,member_uri=excluded.member_uri,
       cid=excluded.cid`,
    input.uri,
    input.identityKey,
    input.kind,
    input.memberUri,
    input.cid,
    input.nowMs,
    input.nowMs + LIVE_EVIDENCE_TTL_MS,
  );
  countLiveAdmission(db, 'addition_candidate');
}

export function sweepLiveAdmission(
  db: Db,
  nowMs: number,
  limit = LIVE_SWEEP_LIMIT,
): { evidence: number; candidates: number } {
  const evidence = db.run(
    `DELETE FROM live_record_evidence WHERE rowid IN
       (SELECT rowid FROM live_record_evidence WHERE expires_at_ms<=? ORDER BY expires_at_ms,uri LIMIT ?)`,
    nowMs,
    limit,
  ).rowsWritten;
  const candidates = db.run(
    `DELETE FROM live_acceptance_candidates WHERE rowid IN
       (SELECT rowid FROM live_acceptance_candidates WHERE expires_at_ms<=? ORDER BY expires_at_ms,uri,identity_key LIMIT ?)`,
    nowMs,
    limit,
  ).rowsWritten;
  countLiveAdmission(db, 'evidence_expired', evidence);
  countLiveAdmission(db, 'candidate_expired', candidates);
  return { evidence, candidates };
}

/** Merge one Jetstream event without letting coalescing or replay cross-pair its revision and CID. */
export function recordLiveEvidence(
  db: Db,
  event: { uri: string; did: string; collection: string; rkey: string; rev: string; action: LiveAction; cid?: string },
  nowMs: number,
): void {
  db.run('DELETE FROM live_record_evidence WHERE uri=? AND expires_at_ms<=?', event.uri, nowMs);
  const previous = db.one<EvidenceRow>('SELECT * FROM live_record_evidence WHERE uri=?', event.uri);
  let upRev = previous?.up_rev ?? null;
  let upAction = previous?.up_action ?? null;
  let upCid = previous?.up_cid ?? null;
  let delRev = previous?.del_rev ?? null;
  let conflictRev = previous?.conflict_rev ?? null;
  const incomingUp = event.action !== 'delete';
  const incomingRev = event.rev;
  const sameRevisionDisagreement = incomingUp
    ? (upRev === incomingRev && (upAction !== event.action || upCid !== event.cid)) || delRev === incomingRev
    : upRev === incomingRev;
  if (sameRevisionDisagreement)
    conflictRev = conflictRev === null || conflictRev < incomingRev ? incomingRev : conflictRev;
  else if (conflictRev !== null && conflictRev < incomingRev) conflictRev = null;

  if (incomingUp) {
    if (upRev === null || upRev < incomingRev) {
      upRev = incomingRev;
      upAction = event.action as 'create' | 'update';
      upCid = event.cid ?? null;
    }
  } else if (delRev === null || delRev < incomingRev) {
    delRev = incomingRev;
  }
  const expiresAt = nowMs + LIVE_EVIDENCE_TTL_MS;
  db.run(
    `INSERT INTO live_record_evidence(uri,did,collection,rkey,up_rev,up_action,up_cid,del_rev,conflict_rev,received_ms,expires_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uri) DO UPDATE SET up_rev=excluded.up_rev,up_action=excluded.up_action,up_cid=excluded.up_cid,
       del_rev=excluded.del_rev,conflict_rev=excluded.conflict_rev,received_ms=max(live_record_evidence.received_ms,excluded.received_ms),
       expires_at_ms=max(live_record_evidence.expires_at_ms,excluded.expires_at_ms)`,
    event.uri,
    event.did,
    event.collection,
    event.rkey,
    upRev,
    upAction,
    upCid,
    delRev,
    conflictRev,
    nowMs,
    expiresAt,
  );
}
