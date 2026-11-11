// Exact API love-operation provenance and retained A2 comparison facts for L2.
// This leaf has no producer, enqueue, backfill or timer imports.

import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { isDid, isTid, parseRecordUri } from '@atmusic/core/syntax';
import type { Origin } from '../app/rows';
import type { Db } from '../do/db';
import { canonicalForwardDedupeKey, storedForwardDedupeKey } from '../outbox/forward-identity';
import { recordVerifiedDeferredLoveAuthority } from './love-coverage-authority';

export type LoveApiFactAction = 'update' | 'delete';

export interface LoveApiAuthorizationFact {
  uri: string;
  rev: string;
  action: LoveApiFactAction;
  cid: string;
  horizonMs: number;
  conflicted?: boolean;
}

export interface LoveApiBindingArgs {
  did: string;
  uri: string;
  incarnationKey: string;
  operationId: string;
  admissionIdentityKey: string;
  nowMs: number;
}

export interface LoveApiRecipientMember {
  link_id: string;
  generation: number;
  state: string;
}

export interface LoveApiProjectedLove {
  artist: string;
  track: string;
  album: string | null;
  recordingMbid: string | null;
}

export interface PreparedLoveApiAbsence {
  did: string;
  uri: string;
  incarnationKey: string;
  rev: string;
  action: LoveApiFactAction;
  cid: string;
  horizonMs: number;
  nowMs: number;
  recipients: Array<{
    linkId: string;
    generation: number;
    sentOperationId: string | null;
    sentOrigin: Exclude<Origin, 'import'> | null;
    pendingApiOperationId: string | null;
    pendingApiOrigin: Exclude<Origin, 'import'> | null;
    hasPendingMembers: boolean;
  }>;
}

export interface LoveApiSettledRow {
  id: string;
  link_id: string;
  generation: number;
  did: string;
  kind: string;
  dedupe_key: string;
  state: 'sent' | 'ignored' | 'failed' | 'expired';
}

export interface LoveApiMaterializerCandidate {
  did: string;
  uri: string;
  incarnationKey: string;
  linkId: string;
  generation: number;
}

export type LoveApiHandoffPreparation =
  | {
      status: 'ready';
      envelope: {
        did: string;
        recordUri: string;
        incarnationKey: string;
        apiOperationId: string;
        projectionRkey: string;
        action: LoveApiFactAction;
        cid: string;
        source: Exclude<Origin, 'import'>;
        sourceExclusions: readonly ('lastfm' | 'listenbrainz')[];
        projection: { artist: string; track: string; album?: string; recordingMbid?: string };
        authorization: { uri: string; rev: string };
      };
    }
  | { status: 'awaiting' }
  | { status: 'vetoed' }
  | { status: 'expired' }
  | { status: 'missing' };

const CID = /^b[a-z2-7]{8,256}$/;
const RECIPIENT_KEY = 'did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?';

function validFact(fact: LoveApiAuthorizationFact): boolean {
  return (
    parseRecordUri(fact.uri) !== null &&
    isTid(fact.rev) &&
    (fact.action === 'delete' ? fact.cid === '' : fact.action === 'update' && CID.test(fact.cid)) &&
    Number.isSafeInteger(fact.horizonMs) &&
    fact.horizonMs > 0 &&
    (fact.conflicted === undefined || typeof fact.conflicted === 'boolean')
  );
}

function ensureProofState(db: Db): void {
  db.run('INSERT OR IGNORE INTO love_api_proof_state(singleton) VALUES(1)');
}

function allocate(db: Db, column: 'next_binding_seq' | 'next_aggregate_seq' | 'next_fact_seq'): number {
  ensureProofState(db);
  const text = db.one<{ value: string }>(
    `SELECT CAST(${column} AS TEXT) AS value FROM love_api_proof_state WHERE singleton=1`,
  )?.value;
  if (text === undefined || !/^[1-9][0-9]*$/.test(text)) throw new RangeError(`invalid L2 allocator ${column}`);
  const current = BigInt(text);
  if (current >= BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`L2 allocator ${column} exhausted`);
  const value = Number(current);
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value + 1))
    throw new RangeError(`L2 allocator ${column} exhausted`);
  const changed = db.run(
    `UPDATE love_api_proof_state SET ${column}=? WHERE singleton=1 AND ${column}=?`,
    value + 1,
    value,
  ).rowsWritten;
  if (changed !== 1) throw new Error(`L2 allocator ${column} changed`);
  return value;
}

function allocateFact(db: Db): number {
  ensureProofState(db);
  const text = db.one<{ value: string }>(
    `UPDATE love_api_proof_state
     SET next_fact_seq=next_fact_seq+1
     WHERE singleton=1 AND typeof(next_fact_seq)='integer' AND next_fact_seq>=1
       AND next_fact_seq<9007199254740991
     RETURNING CAST(next_fact_seq-1 AS TEXT) AS value`,
  )?.value;
  if (text === undefined || !/^[1-9][0-9]*$/.test(text)) throw new RangeError('L2 allocator next_fact_seq exhausted');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value + 1))
    throw new RangeError('L2 allocator next_fact_seq exhausted');
  return value;
}

/** Fence an in-flight MBID alias scan whenever API love intent membership changes. */
export function bumpLoveApiIntentEpoch(db: Db, did: string): number {
  if (!isDid(did)) throw new TypeError('invalid L2 intent DID');
  db.run('INSERT OR IGNORE INTO love_api_intent_epochs(did,epoch) VALUES(?,0)', did);
  const row = db.one<{ epoch: number }>('SELECT epoch FROM love_api_intent_epochs WHERE did=?', did);
  if (row === null || !Number.isSafeInteger(row.epoch) || row.epoch < 0 || row.epoch >= Number.MAX_SAFE_INTEGER)
    throw new RangeError('L2 intent epoch exhausted');
  const next = row.epoch + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError('L2 intent epoch exhausted');
  const changed = db.run(
    'UPDATE love_api_intent_epochs SET epoch=? WHERE did=? AND epoch=?',
    next,
    did,
    row.epoch,
  ).rowsWritten;
  if (changed !== 1) throw new Error('L2 intent epoch changed concurrently');
  return next;
}

/** Retain an exact verified A2 fact before its source event/evidence can be cleaned up. */
export function recordLoveApiComparisonFact(
  db: Db,
  fact: LoveApiAuthorizationFact,
  nowMs: number,
  retainedHorizon?: { value: number | null },
): boolean {
  if (!validFact(fact) || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  return db.tx(() => {
    const existing = db.one<{ action: LoveApiFactAction; cid: string; conflicted: number; horizon_ms: number }>(
      'SELECT action,cid,conflicted,horizon_ms FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
      fact.uri,
      fact.rev,
    );
    if (existing === null) {
      const seq = allocateFact(db);
      db.run(
        `INSERT INTO love_api_comparison_facts(authorization_uri,authorization_rev,fact_seq,action,cid,horizon_ms,conflicted,created_at_ms)
         VALUES(?,?,?,?,?,?,?,?)`,
        fact.uri,
        fact.rev,
        seq,
        fact.action,
        fact.cid,
        fact.horizonMs,
        fact.conflicted ? 1 : 0,
        nowMs,
      );
      if (fact.conflicted)
        recordVerifiedDeferredLoveAuthority(
          db,
          { uri: fact.uri, rev: fact.rev },
          { action: fact.action, cid: fact.cid, conflicted: true },
          nowMs,
        );
      if (retainedHorizon !== undefined) retainedHorizon.value = fact.horizonMs;
      return !fact.conflicted;
    }
    const mismatch = existing.action !== fact.action || existing.cid !== fact.cid;
    if (mismatch || fact.conflicted) {
      const nextHorizon = Math.min(existing.horizon_ms, fact.horizonMs);
      if (retainedHorizon !== undefined) retainedHorizon.value = nextHorizon;
      if (existing.conflicted === 0 || nextHorizon !== existing.horizon_ms)
        db.run(
          'UPDATE love_api_comparison_facts SET conflicted=1,horizon_ms=? WHERE authorization_uri=? AND authorization_rev=?',
          nextHorizon,
          fact.uri,
          fact.rev,
        );
      recordVerifiedDeferredLoveAuthority(
        db,
        { uri: fact.uri, rev: fact.rev },
        { action: existing.action, cid: existing.cid, conflicted: true },
        nowMs,
      );
      return false;
    }
    if (retainedHorizon !== undefined) retainedHorizon.value = Math.min(existing.horizon_ms, fact.horizonMs);
    if (fact.horizonMs < existing.horizon_ms)
      db.run(
        'UPDATE love_api_comparison_facts SET horizon_ms=? WHERE authorization_uri=? AND authorization_rev=?',
        fact.horizonMs,
        fact.uri,
        fact.rev,
      );
    return existing.conflicted === 0;
  });
}

type AcceptedDecisionMinimum = {
  did: string;
  uri: string;
  incarnationKey: string;
  linkId: string;
  generation: number;
  authorizationUri: string;
  authorizationRev: string;
  factAction: string;
  factCid: string;
  expiresAtMs: number;
  dueAtMs: number;
  originalAction: string | null;
  originalCid: string | null;
  originalHorizonMs: number | null;
  originalConflicted: number | null;
};

/** Persist only a minimum supported by the immutable decision's exact clean fact. */
function persistAcceptedDecisionMinimum(
  db: Db,
  decision: AcceptedDecisionMinimum,
  incoming: { uri: string; rev: string; action: string; cid: string; horizonMs: number; conflicted: number } | null,
  nowMs: number,
): void {
  if (
    decision.originalAction !== decision.factAction ||
    decision.originalCid !== decision.factCid ||
    decision.originalConflicted !== 0 ||
    decision.originalHorizonMs === null ||
    !Number.isSafeInteger(decision.originalHorizonMs) ||
    decision.originalHorizonMs <= 0 ||
    !Number.isSafeInteger(decision.expiresAtMs) ||
    decision.expiresAtMs <= 0
  )
    return;
  const incomingHorizon =
    incoming !== null &&
    incoming.uri === decision.uri &&
    incoming.action === decision.factAction &&
    incoming.cid === decision.factCid &&
    incoming.conflicted === 0 &&
    Number.isSafeInteger(incoming.horizonMs) &&
    incoming.horizonMs > 0
      ? incoming.horizonMs
      : Number.MAX_SAFE_INTEGER;
  const minimumHorizon = Math.min(decision.expiresAtMs, decision.originalHorizonMs, incomingHorizon);
  if (minimumHorizon >= decision.expiresAtMs && decision.dueAtMs <= nowMs) return;
  db.run(
    `UPDATE love_api_unlove_decisions SET expires_at_ms=?,due_at_ms=min(due_at_ms,?)
     WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?
       AND authorization_uri=? AND authorization_rev=? AND fact_action=? AND fact_cid=? AND expires_at_ms=?`,
    minimumHorizon,
    nowMs,
    decision.did,
    decision.uri,
    decision.incarnationKey,
    decision.linkId,
    decision.generation,
    decision.authorizationUri,
    decision.authorizationRev,
    decision.factAction,
    decision.factCid,
    decision.expiresAtMs,
  );
}

function decisionMinimumFromRow(row: {
  did: string;
  uri: string;
  incarnation_key: string;
  link_id: string;
  generation: number;
  decision_authorization_uri: string | null;
  decision_authorization_rev: string | null;
  decision_fact_action: string | null;
  decision_fact_cid: string | null;
  decision_expires_at_ms: number | null;
  decision_due_at_ms: number | null;
  original_action: string | null;
  original_cid: string | null;
  original_horizon_ms: number | null;
  original_conflicted: number | null;
}): AcceptedDecisionMinimum | null {
  if (
    row.decision_authorization_uri === null ||
    row.decision_authorization_rev === null ||
    row.decision_fact_action === null ||
    row.decision_fact_cid === null ||
    row.decision_expires_at_ms === null ||
    row.decision_due_at_ms === null
  )
    return null;
  return {
    did: row.did,
    uri: row.uri,
    incarnationKey: row.incarnation_key,
    linkId: row.link_id,
    generation: row.generation,
    authorizationUri: row.decision_authorization_uri,
    authorizationRev: row.decision_authorization_rev,
    factAction: row.decision_fact_action,
    factCid: row.decision_fact_cid,
    expiresAtMs: row.decision_expires_at_ms,
    dueAtMs: row.decision_due_at_ms,
    originalAction: row.original_action,
    originalCid: row.original_cid,
    originalHorizonMs: row.original_horizon_ms,
    originalConflicted: row.original_conflicted,
  };
}

/** Compare an authenticated live tuple before A2 authorization and retain every negative result. */
export function compareLoveApiComparisonFact(
  db: Db,
  event: { uri: string; rev: string; action: string; cid: string },
  nowMs: number,
): boolean {
  return db.tx(() => {
    const fact = db.one<{ action: string; cid: string; conflicted: number }>(
      'SELECT action,cid,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
      event.uri,
      event.rev,
    );
    if (fact === null) return false;
    if (fact.conflicted === 1) return true;
    const eventValid =
      parseRecordUri(event.uri) !== null &&
      isTid(event.rev) &&
      (event.action === 'delete' ? event.cid === '' : event.action === 'update' && CID.test(event.cid));
    if (eventValid && fact.action === event.action && (event.action === 'delete' || fact.cid === event.cid))
      return false;
    db.run(
      'UPDATE love_api_comparison_facts SET conflicted=1 WHERE authorization_uri=? AND authorization_rev=?',
      event.uri,
      event.rev,
    );
    recordVerifiedDeferredLoveAuthority(
      db,
      { uri: event.uri, rev: event.rev },
      { action: fact.action as LoveApiFactAction, cid: fact.cid, conflicted: true },
      nowMs,
    );
    return true;
  });
}

/** Capture an exact, retained live delete fact before source cleanup and A2 authorization. */
export function prepareLoveApiDirectAbsence(
  db: Db,
  args: { did: string; uri: string; incarnationKey: string; rev: string; nowMs: number },
): PreparedLoveApiAbsence | 'conflicted' | null {
  const parsed = parseRecordUri(args.uri);
  if (
    parsed === null ||
    parsed.did !== args.did ||
    !isTid(args.rev) ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0
  )
    return null;
  const rows = db.all<{
    did: string;
    uri: string;
    incarnation_key: string;
    link_id: string;
    generation: number;
    sent_operation_id: string | null;
    state: string;
    evidence_did: string;
    evidence_collection: string;
    evidence_rkey: string;
    evidence_del_rev: string | null;
    evidence_conflict_rev: string | null;
    evidence_expires_at_ms: number;
    has_pending_members: number;
    binding_uri: string | null;
    binding_incarnation_key: string | null;
    binding_origin: string | null;
    pending_api_operation_id: string | null;
    pending_api_origin: string | null;
    decision_authorization_uri: string | null;
    decision_authorization_rev: string | null;
    decision_fact_action: string | null;
    decision_fact_cid: string | null;
    decision_expires_at_ms: number | null;
    decision_due_at_ms: number | null;
    original_action: string | null;
    original_cid: string | null;
    original_horizon_ms: number | null;
    original_conflicted: number | null;
  }>(
    `SELECT r.did,r.uri,r.incarnation_key,r.link_id,r.generation,r.sent_operation_id,r.state,
            e.did AS evidence_did,e.collection AS evidence_collection,e.rkey AS evidence_rkey,
            e.del_rev AS evidence_del_rev,e.conflict_rev AS evidence_conflict_rev,
            e.expires_at_ms AS evidence_expires_at_ms,
            EXISTS(SELECT 1 FROM love_api_recipient_members m
                   WHERE m.link_id=r.link_id AND m.generation=r.generation AND m.did=r.did
                     AND m.uri=r.uri AND m.incarnation_key=r.incarnation_key) AS has_pending_members,
            b.uri AS binding_uri,b.incarnation_key AS binding_incarnation_key,b.api_origin AS binding_origin
            ,(SELECT b2.operation_id FROM love_api_recipient_members m2
               JOIN love_api_bindings b2 ON b2.did=m2.did AND b2.operation_id=m2.operation_id
               WHERE m2.did=r.did AND m2.uri=r.uri AND m2.incarnation_key=r.incarnation_key
                 AND m2.link_id=r.link_id AND m2.generation=r.generation
                 AND b2.uri=r.uri AND b2.incarnation_key=r.incarnation_key LIMIT 1) AS pending_api_operation_id,
            (SELECT b2.api_origin FROM love_api_recipient_members m2
               JOIN love_api_bindings b2 ON b2.did=m2.did AND b2.operation_id=m2.operation_id
               WHERE m2.did=r.did AND m2.uri=r.uri AND m2.incarnation_key=r.incarnation_key
                 AND m2.link_id=r.link_id AND m2.generation=r.generation
                 AND b2.uri=r.uri AND b2.incarnation_key=r.incarnation_key LIMIT 1) AS pending_api_origin,
            d.authorization_uri AS decision_authorization_uri,d.authorization_rev AS decision_authorization_rev,
            d.fact_action AS decision_fact_action,d.fact_cid AS decision_fact_cid,
            d.expires_at_ms AS decision_expires_at_ms,d.due_at_ms AS decision_due_at_ms,
            original.action AS original_action,original.cid AS original_cid,
            original.horizon_ms AS original_horizon_ms,original.conflicted AS original_conflicted
     FROM love_api_recipients r JOIN linked_accounts l ON l.id=r.link_id AND l.generation=r.generation
     JOIN live_record_evidence e ON e.uri=r.uri
     LEFT JOIN love_api_bindings b ON b.did=r.did AND b.operation_id=r.sent_operation_id
     LEFT JOIN love_api_unlove_decisions d ON d.did=r.did AND d.uri=r.uri AND d.incarnation_key=r.incarnation_key
       AND d.link_id=r.link_id AND d.generation=r.generation
     LEFT JOIN love_api_comparison_facts original
       ON original.authorization_uri=d.authorization_uri AND original.authorization_rev=d.authorization_rev
     WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.state IN ('present','sealed')`,
    args.did,
    args.uri,
    args.incarnationKey,
  );
  if (rows.length === 0) return null;
  const first = rows[0]!;
  if (
    first.evidence_did !== args.did ||
    first.evidence_collection !== parsed.collection ||
    first.evidence_rkey !== parsed.rkey ||
    first.evidence_del_rev !== args.rev
  )
    return null;
  if (first.evidence_expires_at_ms <= args.nowMs) {
    // Exact expired evidence may shorten accepted work, but cannot authorize a handoff.
    for (const row of rows) {
      const decision = decisionMinimumFromRow(row);
      if (decision !== null)
        persistAcceptedDecisionMinimum(
          db,
          decision,
          {
            uri: args.uri,
            rev: args.rev,
            action: 'delete',
            cid: '',
            horizonMs: first.evidence_expires_at_ms,
            conflicted: first.evidence_conflict_rev === args.rev ? 1 : 0,
          },
          args.nowMs,
        );
    }
    return null;
  }
  const active = recordLoveApiComparisonFact(
    db,
    {
      uri: args.uri,
      rev: args.rev,
      action: 'delete',
      cid: '',
      horizonMs: first.evidence_expires_at_ms,
      conflicted: first.evidence_conflict_rev === args.rev,
    },
    args.nowMs,
  );
  const retainedFact = db.one<{ action: LoveApiFactAction; cid: string; horizon_ms: number; conflicted: number }>(
    'SELECT action,cid,horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
    args.uri,
    args.rev,
  );
  const acceptedIncoming =
    retainedFact !== null
      ? {
          uri: args.uri,
          rev: args.rev,
          action: retainedFact.action,
          cid: retainedFact.cid,
          horizonMs: retainedFact.horizon_ms,
          conflicted: retainedFact.conflicted,
        }
      : null;
  const factValid =
    retainedFact !== null &&
    retainedFact.action === 'delete' &&
    retainedFact.cid === '' &&
    retainedFact.conflicted === 0 &&
    Number.isSafeInteger(retainedFact.horizon_ms) &&
    retainedFact.horizon_ms > 0;
  if (!active || !factValid || retainedFact === null || retainedFact.horizon_ms <= args.nowMs) {
    for (const row of rows) {
      const decision = decisionMinimumFromRow(row);
      if (decision !== null) persistAcceptedDecisionMinimum(db, decision, acceptedIncoming, args.nowMs);
    }
    return 'conflicted';
  }
  const horizonMs = Math.min(first.evidence_expires_at_ms, retainedFact.horizon_ms);
  const recipients: PreparedLoveApiAbsence['recipients'] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 || row.state === 'released') return 'conflicted';
    let sentOrigin: Exclude<Origin, 'import'> | null = null;
    if (row.sent_operation_id !== null) {
      if (
        row.binding_uri !== args.uri ||
        row.binding_incarnation_key !== args.incarnationKey ||
        row.binding_origin === null ||
        !bindingOrigin(row.binding_origin)
      ) {
        recordLoveApiComparisonFact(
          db,
          {
            uri: args.uri,
            rev: args.rev,
            action: 'delete',
            cid: '',
            horizonMs,
            conflicted: true,
          },
          args.nowMs,
        );
        return 'conflicted';
      }
      sentOrigin = row.binding_origin;
    }
    recipients.push({
      linkId: row.link_id,
      generation: row.generation,
      sentOperationId: row.sent_operation_id,
      sentOrigin,
      pendingApiOperationId: row.pending_api_operation_id,
      pendingApiOrigin:
        row.pending_api_origin !== null && bindingOrigin(row.pending_api_origin) ? row.pending_api_origin : null,
      hasPendingMembers: row.has_pending_members === 1,
    });
  }
  return {
    did: args.did,
    uri: args.uri,
    incarnationKey: args.incarnationKey,
    rev: args.rev,
    action: 'delete',
    cid: '',
    horizonMs,
    nowMs: args.nowMs,
    recipients,
  };
}

/** Prepare one exact A2-owned delayed window from its retained event and owner tuple. */
export function prepareLoveApiWindowAbsence(
  db: Db,
  args: {
    did: string;
    uri: string;
    incarnationKey: string;
    linkId: string;
    generation: number;
    memberUri: string;
    removedCid: string;
    windowLo: string;
    windowHi: string;
    replacedByCid: string;
    rev: string;
    action: string;
    cid: string;
    windowExpiresAtMs: number;
    nowMs: number;
  },
): PreparedLoveApiAbsence | 'conflicted' | null {
  const parsed = parseRecordUri(args.uri);
  const validEvent =
    (args.action === 'delete' && args.cid === '') ||
    (args.action === 'update' && args.replacedByCid !== '' && CID.test(args.cid) && args.cid === args.replacedByCid);
  if (
    parsed === null ||
    parsed.did !== args.did ||
    !isTid(args.rev) ||
    (args.windowLo !== '' && !isTid(args.windowLo)) ||
    !isTid(args.windowHi) ||
    !(args.windowLo < args.rev && args.rev <= args.windowHi) ||
    !validEvent ||
    !Number.isSafeInteger(args.generation) ||
    args.generation < 1 ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0 ||
    !Number.isSafeInteger(args.windowExpiresAtMs) ||
    args.windowExpiresAtMs <= 0
  )
    return null;
  const event = db.one<{ action: string; cid: string; conflicted: number; expires_at_ms: number }>(
    'SELECT action,cid,conflicted,expires_at_ms FROM live_pending_removal_events WHERE uri=? AND rev=?',
    args.uri,
    args.rev,
  );
  if (event === null || event.action !== args.action || event.cid !== args.cid) return null;
  const owner = db.one(
    `SELECT 1 FROM love_api_window_owners o
     JOIN love_api_recipients r ON r.did=o.did AND r.uri=o.uri AND r.incarnation_key=o.incarnation_key
       AND r.link_id=o.link_id AND r.generation=o.generation
     JOIN linked_accounts l ON l.id=o.link_id AND l.generation=o.generation
     WHERE o.uri=? AND o.member_uri=? AND o.removed_cid=? AND o.window_lo=? AND o.window_hi=?
       AND o.replaced_by_cid=? AND o.did=? AND o.incarnation_key=? AND o.link_id=? AND o.generation=?
       AND r.state IN ('present','sealed')`,
    args.uri,
    args.memberUri,
    args.removedCid,
    args.windowLo,
    args.windowHi,
    args.replacedByCid,
    args.did,
    args.incarnationKey,
    args.linkId,
    args.generation,
  );
  if (owner === null) return null;
  const recipient = db.one<{
    did: string;
    uri: string;
    incarnation_key: string;
    link_id: string;
    generation: number;
    sent_operation_id: string | null;
    state: string;
    decision_authorization_uri: string | null;
    decision_authorization_rev: string | null;
    decision_fact_action: string | null;
    decision_fact_cid: string | null;
    decision_expires_at_ms: number | null;
    decision_due_at_ms: number | null;
    original_action: string | null;
    original_cid: string | null;
    original_horizon_ms: number | null;
    original_conflicted: number | null;
  }>(
    `SELECT r.did,r.uri,r.incarnation_key,r.link_id,r.generation,r.sent_operation_id,r.state,
            d.authorization_uri AS decision_authorization_uri,d.authorization_rev AS decision_authorization_rev,
            d.fact_action AS decision_fact_action,d.fact_cid AS decision_fact_cid,
            d.expires_at_ms AS decision_expires_at_ms,d.due_at_ms AS decision_due_at_ms,
            original.action AS original_action,original.cid AS original_cid,
            original.horizon_ms AS original_horizon_ms,original.conflicted AS original_conflicted
     FROM love_api_recipients r
     LEFT JOIN love_api_unlove_decisions d ON d.did=r.did AND d.uri=r.uri AND d.incarnation_key=r.incarnation_key
       AND d.link_id=r.link_id AND d.generation=r.generation
     LEFT JOIN love_api_comparison_facts original
       ON original.authorization_uri=d.authorization_uri AND original.authorization_rev=d.authorization_rev
     WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.link_id=? AND r.generation=?`,
    args.did,
    args.uri,
    args.incarnationKey,
    args.linkId,
    args.generation,
  );
  if (recipient === null || (recipient.state !== 'present' && recipient.state !== 'sealed')) return null;
  let sentOrigin: Exclude<Origin, 'import'> | null = null;
  if (recipient.sent_operation_id !== null) {
    const binding = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
      'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
      args.did,
      recipient.sent_operation_id,
    );
    if (
      binding === null ||
      binding.uri !== args.uri ||
      binding.incarnation_key !== args.incarnationKey ||
      !bindingOrigin(binding.api_origin)
    ) {
      recordLoveApiComparisonFact(
        db,
        {
          uri: args.uri,
          rev: args.rev,
          action: args.action as LoveApiFactAction,
          cid: args.cid,
          horizonMs: Math.min(args.windowExpiresAtMs, event.expires_at_ms),
          conflicted: true,
        },
        args.nowMs,
      );
      return 'conflicted';
    }
    sentOrigin = binding.api_origin;
  }
  const retainedDecision = decisionMinimumFromRow(recipient);
  if (event.expires_at_ms <= args.nowMs || args.windowExpiresAtMs <= args.nowMs) {
    if (event.conflicted === 0 && retainedDecision !== null)
      persistAcceptedDecisionMinimum(
        db,
        retainedDecision,
        {
          uri: args.uri,
          rev: args.rev,
          action: args.action,
          cid: args.cid,
          horizonMs: Math.min(args.windowExpiresAtMs, event.expires_at_ms),
          conflicted: 0,
        },
        args.nowMs,
      );
    else if (retainedDecision !== null) persistAcceptedDecisionMinimum(db, retainedDecision, null, args.nowMs);
    return event.conflicted !== 0 ? 'conflicted' : null;
  }
  if (event.conflicted !== 0) return 'conflicted';
  const hasPendingMembers =
    db.one(
      `SELECT 1 FROM love_api_recipient_members WHERE did=? AND uri=? AND incarnation_key=?
       AND link_id=? AND generation=? LIMIT 1`,
      args.did,
      args.uri,
      args.incarnationKey,
      args.linkId,
      args.generation,
    ) !== null;
  const proposedHorizonMs = Math.min(args.windowExpiresAtMs, event.expires_at_ms);
  const retainedHorizon = { value: null as number | null };
  const recorded = recordLoveApiComparisonFact(
    db,
    {
      uri: args.uri,
      rev: args.rev,
      action: args.action as LoveApiFactAction,
      cid: args.cid,
      horizonMs: proposedHorizonMs,
    },
    args.nowMs,
    retainedHorizon,
  );
  if (!recorded) {
    if (retainedDecision !== null) persistAcceptedDecisionMinimum(db, retainedDecision, null, args.nowMs);
    return 'conflicted';
  }
  if (
    retainedHorizon.value === null ||
    !Number.isSafeInteger(retainedHorizon.value) ||
    retainedHorizon.value <= 0 ||
    retainedHorizon.value <= args.nowMs
  ) {
    if (retainedDecision !== null && retainedHorizon.value !== null && Number.isSafeInteger(retainedHorizon.value))
      persistAcceptedDecisionMinimum(
        db,
        retainedDecision,
        {
          uri: args.uri,
          rev: args.rev,
          action: args.action,
          cid: args.cid,
          horizonMs: retainedHorizon.value,
          conflicted: 0,
        },
        args.nowMs,
      );
    return 'conflicted';
  }
  const horizonMs = Math.min(proposedHorizonMs, retainedHorizon.value);
  return {
    did: args.did,
    uri: args.uri,
    incarnationKey: args.incarnationKey,
    rev: args.rev,
    action: args.action as LoveApiFactAction,
    cid: args.cid,
    horizonMs,
    nowMs: args.nowMs,
    recipients: [
      {
        linkId: args.linkId,
        generation: args.generation,
        sentOperationId: recipient.sent_operation_id,
        sentOrigin,
        pendingApiOperationId:
          db.one<{ operation_id: string }>(
            `SELECT b.operation_id FROM love_api_recipient_members m JOIN love_api_bindings b
             ON b.did=m.did AND b.operation_id=m.operation_id
           WHERE m.did=? AND m.uri=? AND m.incarnation_key=? AND m.link_id=? AND m.generation=?
             AND b.uri=m.uri AND b.incarnation_key=m.incarnation_key LIMIT 1`,
            args.did,
            args.uri,
            args.incarnationKey,
            args.linkId,
            args.generation,
          )?.operation_id ?? null,
        pendingApiOrigin:
          (db.one<{ api_origin: string }>(
            `SELECT b.api_origin FROM love_api_recipient_members m JOIN love_api_bindings b
             ON b.did=m.did AND b.operation_id=m.operation_id
           WHERE m.did=? AND m.uri=? AND m.incarnation_key=? AND m.link_id=? AND m.generation=?
             AND b.uri=m.uri AND b.incarnation_key=m.incarnation_key LIMIT 1`,
            args.did,
            args.uri,
            args.incarnationKey,
            args.linkId,
            args.generation,
          )?.api_origin as Exclude<Origin, 'import'> | undefined) ?? null,
        hasPendingMembers,
      },
    ],
  };
}

function lovePayload(love: LoveApiProjectedLove, origin?: Exclude<Origin, 'import'>): Record<string, string> {
  return {
    artist: love.artist,
    track: love.track,
    ...(love.album === null ? {} : { album: love.album }),
    ...(love.recordingMbid === null ? {} : { recordingMbid: love.recordingMbid }),
    ...(origin === undefined ? {} : { origin }),
  };
}

function sameLovePayload(json: string, love: LoveApiProjectedLove): boolean {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return (
    keys.every((key) => ['artist', 'track', 'album', 'recordingMbid', 'origin'].includes(key)) &&
    object.artist === love.artist &&
    object.track === love.track &&
    (love.album === null ? object.album === undefined : object.album === love.album) &&
    (love.recordingMbid === null ? object.recordingMbid === undefined : object.recordingMbid === love.recordingMbid) &&
    (object.origin === undefined || bindingOrigin(String(object.origin)))
  );
}

/** Seal exact current-generation recipient decisions using the captured projection and retained fact. */
export function sealLoveApiDirectAbsence(
  db: Db,
  prepared: PreparedLoveApiAbsence,
  love: LoveApiProjectedLove,
): boolean {
  const keys = loveApiTrackKeys(love.artist, love.track);
  if (keys === null) return false;
  type RetainedSealRow = {
    retained_action: string | null;
    retained_cid: string | null;
    retained_horizon_ms: number | null;
    retained_conflicted: number | null;
    decision_did: string | null;
    authorization_uri: string | null;
    authorization_rev: string | null;
    fact_action: string | null;
    fact_cid: string | null;
    expires_at_ms: number | null;
    due_at_ms: number | null;
    payload_json: string | null;
    original_action: string | null;
    original_cid: string | null;
    original_horizon_ms: number | null;
    original_conflicted: number | null;
  };
  type ExistingDecision = {
    authorization_uri: string;
    authorization_rev: string;
    fact_action: string;
    fact_cid: string;
    expires_at_ms: number;
    due_at_ms: number;
    payload_json: string;
  };
  type SealItem = {
    recipient: PreparedLoveApiAbsence['recipients'][number];
    hasProof: boolean;
    payload: string;
    retained: RetainedSealRow | null;
    existing: ExistingDecision | null;
    minimumHorizon: number;
    refusal: 'missing-row' | 'invalid-fact' | 'expired' | 'envelope' | 'fact-conflict' | null;
  };
  const items: SealItem[] = [];
  let firstRefusal: SealItem['refusal'] = null;

  // Preflight every exact recipient before any batch refusal. This makes each
  // independently valid stored deadline monotonic even when a sibling refuses.
  for (const recipient of prepared.recipients) {
    const hasProof = recipient.sentOperationId !== null || recipient.pendingApiOperationId !== null;
    if (!hasProof && !recipient.hasPendingMembers) {
      items.push({
        recipient,
        hasProof,
        payload: '',
        retained: null,
        existing: null,
        minimumHorizon: 0,
        refusal: null,
      });
      continue;
    }
    const payload = JSON.stringify(lovePayload(love, recipient.sentOrigin ?? recipient.pendingApiOrigin ?? undefined));
    const retained = db.one<RetainedSealRow>(
      `SELECT incoming.action AS retained_action,incoming.cid AS retained_cid,
              incoming.horizon_ms AS retained_horizon_ms,incoming.conflicted AS retained_conflicted,
              d.did AS decision_did,d.authorization_uri,d.authorization_rev,d.fact_action,d.fact_cid,
              d.expires_at_ms,d.due_at_ms,d.payload_json,
              original.action AS original_action,original.cid AS original_cid,
              original.horizon_ms AS original_horizon_ms,original.conflicted AS original_conflicted
       FROM (SELECT 1) seed
       LEFT JOIN love_api_comparison_facts incoming
         ON incoming.authorization_uri=? AND incoming.authorization_rev=?
       LEFT JOIN love_api_unlove_decisions d
         ON d.did=? AND d.uri=? AND d.incarnation_key=? AND d.link_id=? AND d.generation=?
       LEFT JOIN love_api_comparison_facts original
         ON original.authorization_uri=d.authorization_uri AND original.authorization_rev=d.authorization_rev`,
      prepared.uri,
      prepared.rev,
      prepared.did,
      prepared.uri,
      prepared.incarnationKey,
      recipient.linkId,
      recipient.generation,
    );
    if (retained === null) {
      const item: SealItem = {
        recipient,
        hasProof,
        payload,
        retained,
        existing: null,
        minimumHorizon: 0,
        refusal: 'missing-row',
      };
      items.push(item);
      firstRefusal ??= item.refusal;
      continue;
    }
    const hasDecision = retained.decision_did !== null;
    const existing = hasDecision
      ? {
          authorization_uri: retained.authorization_uri!,
          authorization_rev: retained.authorization_rev!,
          fact_action: retained.fact_action!,
          fact_cid: retained.fact_cid!,
          expires_at_ms: retained.expires_at_ms!,
          due_at_ms: retained.due_at_ms!,
          payload_json: retained.payload_json!,
        }
      : null;
    const incomingValid =
      retained.retained_action === prepared.action &&
      retained.retained_cid === prepared.cid &&
      retained.retained_conflicted === 0 &&
      retained.retained_horizon_ms !== null &&
      Number.isSafeInteger(retained.retained_horizon_ms) &&
      retained.retained_horizon_ms > 0;
    const originalValid =
      existing === null ||
      (retained.original_action === existing.fact_action &&
        retained.original_cid === existing.fact_cid &&
        retained.original_conflicted === 0 &&
        retained.original_horizon_ms !== null &&
        Number.isSafeInteger(retained.original_horizon_ms) &&
        retained.original_horizon_ms > 0);
    const minimumHorizon =
      existing === null
        ? incomingValid
          ? Math.min(prepared.horizonMs, retained.retained_horizon_ms!)
          : Number.MAX_SAFE_INTEGER
        : originalValid
          ? Math.min(
              existing.expires_at_ms,
              retained.original_horizon_ms!,
              incomingValid ? Math.min(prepared.horizonMs, retained.retained_horizon_ms!) : Number.MAX_SAFE_INTEGER,
            )
          : existing.expires_at_ms;
    const item: SealItem = {
      recipient,
      hasProof,
      payload,
      retained,
      existing,
      minimumHorizon,
      refusal: null,
    };
    if (existing !== null && originalValid && Number.isSafeInteger(minimumHorizon))
      db.run(
        `UPDATE love_api_unlove_decisions SET expires_at_ms=?,due_at_ms=min(due_at_ms,?)
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?
           AND authorization_uri=? AND authorization_rev=? AND fact_action=? AND fact_cid=?
           AND (expires_at_ms>? OR due_at_ms>?)`,
        minimumHorizon,
        prepared.nowMs,
        prepared.did,
        prepared.uri,
        prepared.incarnationKey,
        recipient.linkId,
        recipient.generation,
        existing.authorization_uri,
        existing.authorization_rev,
        existing.fact_action,
        existing.fact_cid,
        minimumHorizon,
        prepared.nowMs,
      );
    if (!originalValid || !incomingValid || !Number.isSafeInteger(minimumHorizon)) item.refusal = 'invalid-fact';
    else if (minimumHorizon <= prepared.nowMs) item.refusal = 'expired';
    if (
      item.refusal === null &&
      existing !== null &&
      (existing.authorization_uri !== prepared.uri ||
        existing.authorization_rev !== prepared.rev ||
        !sameLovePayload(existing.payload_json, love) ||
        (recipient.sentOrigin !== null && JSON.parse(existing.payload_json).origin !== recipient.sentOrigin))
    )
      item.refusal = 'envelope';
    if (
      item.refusal === null &&
      existing !== null &&
      (existing.fact_action !== prepared.action || existing.fact_cid !== prepared.cid)
    )
      item.refusal = 'fact-conflict';
    items.push(item);
    firstRefusal ??= item.refusal;
  }

  if (firstRefusal !== null) {
    const conflict = items.find((item) => item.refusal === firstRefusal && item.refusal === 'fact-conflict');
    if (conflict !== undefined) {
      recordLoveApiComparisonFact(
        db,
        {
          uri: prepared.uri,
          rev: prepared.rev,
          action: prepared.action,
          cid: prepared.cid,
          horizonMs: prepared.horizonMs,
          conflicted: true,
        },
        prepared.nowMs,
      );
    }
    return false;
  }

  for (const item of items) {
    const { recipient, hasProof, payload, existing, minimumHorizon } = item;
    if (!hasProof && !recipient.hasPendingMembers) {
      db.run(
        `UPDATE love_api_recipients SET state='released',updated_at_ms=?
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND state IN ('present','sealed')`,
        prepared.nowMs,
        prepared.did,
        prepared.uri,
        prepared.incarnationKey,
        recipient.linkId,
        recipient.generation,
      );
      continue;
    }
    db.run(
      `UPDATE love_api_recipients SET state='sealed',updated_at_ms=?
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND state='present'`,
      prepared.nowMs,
      prepared.did,
      prepared.uri,
      prepared.incarnationKey,
      recipient.linkId,
      recipient.generation,
    );
    if (existing === null) {
      db.run(
        `INSERT INTO love_api_unlove_decisions(
           did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,recording_mbid,payload_json,
           love_source_service,love_import_sources,authorization_uri,authorization_rev,fact_action,fact_cid,
           expires_at_ms,due_at_ms,created_at_ms
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)`,
        prepared.did,
        prepared.uri,
        prepared.incarnationKey,
        recipient.linkId,
        recipient.generation,
        love.artist,
        love.track,
        keys.artistKey,
        keys.trackKey,
        love.recordingMbid,
        payload,
        prepared.uri,
        prepared.rev,
        prepared.action,
        prepared.cid,
        minimumHorizon,
        prepared.nowMs,
        prepared.nowMs,
      );
      continue;
    }
    const expiry = minimumHorizon;
    const payloadChanged = existing.payload_json !== payload;
    if (expiry !== existing.expires_at_ms || payloadChanged)
      db.run(
        `UPDATE love_api_unlove_decisions SET expires_at_ms=?,payload_json=?,due_at_ms=min(due_at_ms,?)
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        expiry,
        payloadChanged ? payload : existing.payload_json,
        prepared.nowMs,
        prepared.did,
        prepared.uri,
        prepared.incarnationKey,
        recipient.linkId,
        recipient.generation,
      );
  }
  return true;
}

/** Release a current-generation API aggregate only when its exact broad delete was durably accepted. */
export function releaseBroadCoveredLoveApiRecipients(
  db: Db,
  args: {
    did: string;
    uri: string;
    incarnationKey: string;
    rev: string;
    operationId: string;
    artist: string;
    track: string;
    recordingMbid: string | null;
    nowMs: number;
  },
): number {
  const parsed = parseRecordUri(args.uri);
  const keys = loveApiTrackKeys(args.artist, args.track);
  const expectedOperationId = `love-delete:${args.incarnationKey}:rev:${args.rev}`;
  if (
    parsed === null ||
    parsed.did !== args.did ||
    !isTid(args.rev) ||
    args.operationId !== expectedOperationId ||
    keys === null ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0
  )
    return 0;

  return db.tx(() => {
    const candidates = db.all<{
      link_id: string;
      generation: number;
      artist_key: string | null;
      track_key: string | null;
      authorization_uri: string | null;
      authorization_rev: string | null;
    }>(
      `SELECT r.link_id,r.generation,d.artist_key,d.track_key,d.authorization_uri,d.authorization_rev
       FROM linked_accounts l
       CROSS JOIN love_api_recipients r
         ON r.did=? AND r.uri=? AND r.incarnation_key=? AND r.link_id=l.id AND r.generation=l.generation
       LEFT JOIN love_api_unlove_decisions d ON d.did=r.did AND d.uri=r.uri AND d.incarnation_key=r.incarnation_key
         AND d.link_id=r.link_id AND d.generation=r.generation
       WHERE l.did=? AND r.state IN ('present','sealed')
         AND (d.did IS NULL OR (d.authorization_uri=? AND d.authorization_rev=? AND d.artist_key=? AND d.track_key=?))`,
      args.did,
      args.uri,
      args.incarnationKey,
      args.did,
      args.uri,
      args.rev,
      keys.artistKey,
      keys.trackKey,
    );
    let released = 0;
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 1) continue;
      if (
        (candidate.authorization_uri !== null && candidate.authorization_uri !== args.uri) ||
        (candidate.authorization_rev !== null && candidate.authorization_rev !== args.rev) ||
        (candidate.artist_key !== null && candidate.artist_key !== keys.artistKey) ||
        (candidate.track_key !== null && candidate.track_key !== keys.trackKey)
      )
        continue;
      const authorizationUri = candidate.authorization_uri ?? args.uri;
      const authorizationRev = candidate.authorization_rev ?? args.rev;
      const canonicalKey = args.operationId;
      const storedKey = storedForwardDedupeKey(candidate.generation, canonicalKey);
      const effect = db.one<{
        did: string;
        generation: number;
        love_artist_key: string | null;
        love_track_key: string | null;
        authorization_uri: string | null;
        authorization_rev: string | null;
        payload_json: string;
        state: string;
      }>(
        `SELECT did,generation,love_artist_key,love_track_key,authorization_uri,authorization_rev,payload_json,state
         FROM forward_outbox WHERE link_id=? AND kind='unlove' AND dedupe_key=?`,
        candidate.link_id,
        storedKey,
      );
      let covered = false;
      if (effect !== null) {
        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(effect.payload_json);
        } catch {
          parsedPayload = null;
        }
        const payload =
          parsedPayload !== null && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
            ? (parsedPayload as Record<string, unknown>)
            : null;
        covered =
          effect.did === args.did &&
          effect.generation === candidate.generation &&
          effect.love_artist_key === keys.artistKey &&
          effect.love_track_key === keys.trackKey &&
          effect.authorization_uri === authorizationUri &&
          effect.authorization_rev === authorizationRev &&
          payload?.artist === args.artist &&
          payload.track === args.track &&
          payload.origin === 'web' &&
          (args.recordingMbid === null
            ? payload.recordingMbid === undefined
            : payload.recordingMbid === args.recordingMbid) &&
          ['queued', 'held', 'sent', 'ignored', 'failed', 'expired'].includes(effect.state);
      } else {
        const deferred = db.one<{ payload_json: string }>(
          `SELECT i.payload_json FROM forward_deferred_love_intents i
           JOIN forward_deferred_love_witnesses w ON w.link_id=i.link_id AND w.generation=i.generation
             AND w.operation_id=i.operation_id AND w.kind=i.kind AND w.love_artist_key=i.love_artist_key
             AND w.love_track_key=i.love_track_key AND w.authorization_uri=i.authorization_uri
             AND w.authorization_rev=i.authorization_rev
           JOIN forward_deferred_love_heads h ON h.link_id=i.link_id AND h.generation=i.generation
             AND h.love_artist_key=i.love_artist_key AND h.love_track_key=i.love_track_key
           WHERE i.link_id=? AND i.generation=? AND i.operation_id=? AND i.kind='unlove'
             AND i.origin_class='authorized' AND i.love_artist_key=? AND i.love_track_key=?
             AND i.authorization_uri=? AND i.authorization_rev=?`,
          candidate.link_id,
          candidate.generation,
          canonicalKey,
          keys.artistKey,
          keys.trackKey,
          authorizationUri,
          authorizationRev,
        );
        if (deferred !== null) {
          let parsedPayload: unknown;
          try {
            parsedPayload = JSON.parse(deferred.payload_json);
          } catch {
            parsedPayload = null;
          }
          const payload =
            parsedPayload !== null && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
              ? (parsedPayload as Record<string, unknown>)
              : null;
          covered =
            payload?.artist === args.artist &&
            payload.track === args.track &&
            payload.origin === 'web' &&
            (args.recordingMbid === null
              ? payload.recordingMbid === undefined
              : payload.recordingMbid === args.recordingMbid);
        } else
          covered =
            db.one(
              `SELECT 1 FROM forward_receipts WHERE link_id=? AND generation=? AND kind='unlove'
             AND dedupe_key=? AND retired_at_ms IS NOT NULL`,
              candidate.link_id,
              candidate.generation,
              canonicalKey,
            ) !== null;
      }
      if (!covered) continue;
      db.run(
        `DELETE FROM love_api_unlove_decisions WHERE did=? AND uri=? AND incarnation_key=? AND link_id=?
         AND generation=? AND authorization_uri=? AND authorization_rev=?`,
        args.did,
        args.uri,
        args.incarnationKey,
        candidate.link_id,
        candidate.generation,
        authorizationUri,
        authorizationRev,
      );
      db.run(
        `UPDATE love_api_recipients SET state='released',updated_at_ms=? WHERE did=? AND uri=?
         AND incarnation_key=? AND link_id=? AND generation=? AND state IN ('present','sealed')`,
        args.nowMs,
        args.did,
        args.uri,
        args.incarnationKey,
        candidate.link_id,
        candidate.generation,
      );
      released++;
    }
    return released;
  });
}

function memberRows(db: Db, args: LoveApiBindingArgs): LoveApiRecipientMember[] {
  return db.all(
    `SELECT l.id AS link_id,l.generation,o.state
     FROM linked_accounts l JOIN forward_outbox o ON o.link_id=l.id AND o.generation=l.generation
     WHERE l.did=? AND l.status IN ('active','disabled','revoked') AND o.did=? AND o.kind='love'
       AND o.state IN ('queued','held','sent')
       AND o.dedupe_key=CASE WHEN l.generation=1 THEN ? ELSE 'g'||l.generation||':'||? END`,
    args.did,
    args.did,
    args.operationId,
    args.operationId,
  );
}

/** Current-generation accepted love effects eligible to bind inside the executor transaction. */
export function currentApiLoveRecipientMembers(db: Db, args: LoveApiBindingArgs): LoveApiRecipientMember[] {
  return memberRows(db, args);
}

function bindingOrigin(value: string): value is Exclude<Origin, 'import'> {
  return value === 'web' || value === 'lastfm' || value === 'listenbrainz';
}

/** Bind one exact API operation to a present incarnation and current B2 generations atomically. */
export function bindApiLoveOperation(
  db: Db,
  args: LoveApiBindingArgs,
  acceptedMembers?: readonly LoveApiRecipientMember[],
): boolean {
  return db.tx(() => {
    const parsed = parseRecordUri(args.uri);
    if (
      parsed === null ||
      parsed.did !== args.did ||
      args.incarnationKey.length === 0 ||
      args.operationId.length === 0 ||
      args.admissionIdentityKey.length === 0 ||
      !Number.isSafeInteger(args.nowMs) ||
      args.nowMs < 0
    )
      return false;
    const incarnation = db.one<{ incarnation_key: string; state: string }>(
      'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
      args.uri,
    );
    const admission = db.one<{ path: string }>(
      'SELECT path FROM forward_admissions WHERE did=? AND identity_key=?',
      args.did,
      args.admissionIdentityKey,
    );
    const operation = db.one<{ kind: string; origin: string; did: string }>(
      'SELECT kind,origin,did FROM operations WHERE id=?',
      args.operationId,
    );
    if (
      incarnation?.state !== 'present' ||
      incarnation.incarnation_key !== args.incarnationKey ||
      admission?.path !== 'api' ||
      operation?.kind !== 'love.put' ||
      operation.did !== args.did ||
      !bindingOrigin(operation.origin)
    )
      return false;

    const links = acceptedMembers ?? memberRows(db, args);
    const prepared = links.map((link) => {
      if (!Number.isSafeInteger(link.generation) || link.generation < 1)
        throw new RangeError('invalid link generation');
      const recipient = db.one<{ state: string; next_member_seq: number }>(
        `SELECT state,next_member_seq FROM love_api_recipients WHERE ${RECIPIENT_KEY}`,
        args.did,
        args.uri,
        args.incarnationKey,
        link.link_id,
        link.generation,
      );
      const member = db.one<{ did: string; uri: string; incarnation_key: string }>(
        'SELECT did,uri,incarnation_key FROM love_api_recipient_members WHERE link_id=? AND generation=? AND operation_id=?',
        link.link_id,
        link.generation,
        args.operationId,
      );
      if (recipient?.state === 'released') throw new Error('API recipient aggregate already released');
      if (
        member !== null &&
        (member.did !== args.did || member.uri !== args.uri || member.incarnation_key !== args.incarnationKey)
      )
        throw new Error('API recipient member identity collision');
      if (link.state !== 'sent' && recipient !== null) {
        const next = recipient.next_member_seq;
        if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER)
          throw new RangeError('API love member sequence exhausted');
      }
      return { link, recipient, member };
    });

    const old = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
      'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
      args.did,
      args.operationId,
    );
    if (
      old !== null &&
      (old.uri !== args.uri || old.incarnation_key !== args.incarnationKey || old.api_origin !== operation.origin)
    )
      return false;
    if (old === null)
      db.run(
        'INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms) VALUES(?,?,?,?,?,?,?)',
        args.did,
        args.operationId,
        operation.origin,
        args.uri,
        args.incarnationKey,
        allocate(db, 'next_binding_seq'),
        args.nowMs,
      );

    for (const { link, recipient, member } of prepared) {
      if (recipient === null)
        db.run(
          `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,?,?,'present',?,?)`,
          args.did,
          args.uri,
          args.incarnationKey,
          link.link_id,
          link.generation,
          allocate(db, 'next_aggregate_seq'),
          args.nowMs,
          args.nowMs,
        );
      if (link.state === 'sent') {
        db.run(
          `UPDATE love_api_recipients SET sent_operation_id=coalesce(sent_operation_id,?),updated_at_ms=? WHERE ${RECIPIENT_KEY}`,
          args.operationId,
          args.nowMs,
          args.did,
          args.uri,
          args.incarnationKey,
          link.link_id,
          link.generation,
        );
        db.run(
          'DELETE FROM love_api_recipient_members WHERE link_id=? AND generation=? AND operation_id=?',
          link.link_id,
          link.generation,
          args.operationId,
        );
        continue;
      }
      if (member !== null) continue;
      const next = recipient?.next_member_seq ?? 1;
      if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER)
        throw new RangeError('API love member sequence exhausted');
      db.run(
        `INSERT INTO love_api_recipient_members(link_id,generation,operation_id,did,uri,incarnation_key,member_seq,created_at_ms)
         VALUES(?,?,?,?,?,?,?,?)`,
        link.link_id,
        link.generation,
        args.operationId,
        args.did,
        args.uri,
        args.incarnationKey,
        next,
        args.nowMs,
      );
      db.run(
        `UPDATE love_api_recipients SET next_member_seq=?,updated_at_ms=? WHERE ${RECIPIENT_KEY}`,
        next + 1,
        args.nowMs,
        args.did,
        args.uri,
        args.incarnationKey,
        link.link_id,
        link.generation,
      );
    }
    return true;
  });
}

/** Bind a successful API create while its exact admission is still in the executor transaction. */
export function bindApiLoveCreatedOperation(
  db: Db,
  args: Omit<LoveApiBindingArgs, 'incarnationKey'> & { collection: string },
): boolean {
  return db.tx(() => {
    const parsed = parseRecordUri(args.uri);
    if (parsed === null || parsed.did !== args.did || parsed.collection !== args.collection) return false;
    const current = db.one<{ incarnation_key: string; state: string; path: string }>(
      'SELECT incarnation_key,state,path FROM love_incarnations WHERE uri=?',
      args.uri,
    );
    const incarnationKey = `love:${args.uri}:api:${args.operationId}`;
    if (
      current !== null &&
      (current.state !== 'present' || current.path !== 'api' || current.incarnation_key !== incarnationKey)
    )
      return false;
    const existingBinding = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
      'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
      args.did,
      args.operationId,
    );
    if (existingBinding !== null) {
      const operation = db.one<{ kind: string; did: string; origin: string }>(
        'SELECT kind,did,origin FROM operations WHERE id=?',
        args.operationId,
      );
      return (
        current?.state === 'present' &&
        existingBinding.uri === args.uri &&
        existingBinding.incarnation_key === incarnationKey &&
        bindingOrigin(existingBinding.api_origin) &&
        operation?.kind === 'love.put' &&
        operation.did === args.did &&
        operation.origin === existingBinding.api_origin
      );
    }
    if (current === null)
      db.run(
        `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
         VALUES(?,?,'present','api',NULL,?)`,
        args.uri,
        incarnationKey,
        args.nowMs,
      );
    const accepted = bindApiLoveOperation(db, { ...args, incarnationKey });
    if (!accepted) return false;
    db.run('DELETE FROM forward_admissions WHERE did=? AND identity_key=?', args.did, args.admissionIdentityKey);
    return true;
  });
}

/** Consume the exact rows returned by B2 terminal transitions in that same transaction. */
export function settleApiLoveRecipientRows(db: Db, rows: readonly LoveApiSettledRow[], nowMs: number): void {
  for (const row of rows) {
    if (row.kind !== 'love') continue;
    const operationId = canonicalForwardDedupeKey(row.generation, row.dedupe_key);
    if (operationId === null) continue;
    const member = db.one<{ did: string; uri: string; incarnation_key: string }>(
      `SELECT did,uri,incarnation_key FROM love_api_recipient_members
       WHERE link_id=? AND generation=? AND operation_id=?`,
      row.link_id,
      row.generation,
      operationId,
    );
    if (member === null || member.did !== row.did) continue;
    let sentOrigin: Exclude<Origin, 'import'> | null = null;
    if (row.state === 'sent') {
      const binding = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
        'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
        member.did,
        operationId,
      );
      if (
        binding !== null &&
        binding.uri === member.uri &&
        binding.incarnation_key === member.incarnation_key &&
        bindingOrigin(binding.api_origin)
      )
        sentOrigin = binding.api_origin;
    }
    let selectedSent = false;
    if (sentOrigin !== null) {
      db.run(
        `UPDATE love_api_recipients SET sent_operation_id=?,updated_at_ms=?
         WHERE ${RECIPIENT_KEY} AND state IN ('present','sealed') AND sent_operation_id IS NULL`,
        operationId,
        nowMs,
        member.did,
        member.uri,
        member.incarnation_key,
        row.link_id,
        row.generation,
      );
      selectedSent =
        db.one<{ sent_operation_id: string | null }>(
          `SELECT sent_operation_id FROM love_api_recipients WHERE ${RECIPIENT_KEY}`,
          member.did,
          member.uri,
          member.incarnation_key,
          row.link_id,
          row.generation,
        )?.sent_operation_id === operationId;
    }
    if (selectedSent) {
      const decision = db.one<{
        payload_json: string;
        authorization_uri: string;
        authorization_rev: string;
        expires_at_ms: number;
      }>(
        `SELECT payload_json,authorization_uri,authorization_rev,expires_at_ms FROM love_api_unlove_decisions
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        member.did,
        member.uri,
        member.incarnation_key,
        row.link_id,
        row.generation,
      );
      if (decision !== null) {
        let value: unknown;
        try {
          value = JSON.parse(decision.payload_json);
        } catch {
          value = null;
        }
        const oldOrigin =
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>).origin
            : undefined;
        if (oldOrigin !== undefined && oldOrigin !== sentOrigin) {
          recordLoveApiComparisonFact(
            db,
            {
              uri: decision.authorization_uri,
              rev: decision.authorization_rev,
              action: 'delete',
              cid: '',
              horizonMs: decision.expires_at_ms,
              conflicted: true,
            },
            nowMs,
          );
        }
        const payload =
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? oldOrigin === undefined || oldOrigin === sentOrigin
              ? { ...(value as Record<string, unknown>), origin: sentOrigin }
              : null
            : null;
        if (payload !== null)
          db.run(
            `UPDATE love_api_unlove_decisions SET payload_json=?,due_at_ms=min(due_at_ms,?)
             WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
            JSON.stringify(payload),
            nowMs,
            member.did,
            member.uri,
            member.incarnation_key,
            row.link_id,
            row.generation,
          );
      }
    }
    db.run(
      'DELETE FROM love_api_recipient_members WHERE link_id=? AND generation=? AND operation_id=?',
      row.link_id,
      row.generation,
      operationId,
    );
    db.run(
      `UPDATE love_api_unlove_decisions SET due_at_ms=min(due_at_ms,?)
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
      nowMs,
      member.did,
      member.uri,
      member.incarnation_key,
      row.link_id,
      row.generation,
    );
  }
}

/** Validate and reconstruct a handoff only from the persisted recipient proof and decision envelope. */
export function prepareLoveApiRecipientHandoff(
  db: Db,
  candidate: LoveApiMaterializerCandidate,
  sessionToken: string,
  nowMs: number,
  aliasPageSize = 16,
): LoveApiHandoffPreparation {
  if (
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation < 1 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    sessionToken.length === 0 ||
    !Number.isSafeInteger(aliasPageSize) ||
    aliasPageSize < 1 ||
    aliasPageSize > 16
  )
    return { status: 'missing' };
  const row = db.one<{
    artist: string;
    track: string;
    artist_key: string;
    track_key: string;
    recording_mbid: string | null;
    payload_json: string;
    authorization_uri: string;
    authorization_rev: string;
    fact_action: LoveApiFactAction;
    fact_cid: string;
    expires_at_ms: number;
    scan_session: string | null;
    alias_epoch: number | null;
    alias_cursor: string | null;
    sent_operation_id: string | null;
    recipient_state: string;
    pending_members: number;
    current_generation: number | null;
  }>(
    `SELECT d.artist,d.track,d.artist_key,d.track_key,d.recording_mbid,d.payload_json,d.authorization_uri,d.authorization_rev,
       d.fact_action,d.fact_cid,d.expires_at_ms,d.scan_session,d.alias_epoch,d.alias_cursor,
       r.sent_operation_id,r.state AS recipient_state,
       (SELECT count(*) FROM love_api_recipient_members m WHERE m.did=d.did AND m.uri=d.uri
         AND m.incarnation_key=d.incarnation_key AND m.link_id=d.link_id AND m.generation=d.generation) AS pending_members,
       l.generation AS current_generation
     FROM love_api_unlove_decisions d
     JOIN love_api_recipients r ON r.did=d.did AND r.uri=d.uri AND r.incarnation_key=d.incarnation_key
       AND r.link_id=d.link_id AND r.generation=d.generation
     LEFT JOIN linked_accounts l ON l.id=d.link_id AND l.did=d.did
     WHERE d.did=? AND d.uri=? AND d.incarnation_key=? AND d.link_id=? AND d.generation=?`,
    candidate.did,
    candidate.uri,
    candidate.incarnationKey,
    candidate.linkId,
    candidate.generation,
  );
  if (row === null) return { status: 'missing' };
  const fact = db.one<{ action: string; cid: string; horizon_ms: number; conflicted: number }>(
    'SELECT action,cid,horizon_ms,conflicted FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
    row.authorization_uri,
    row.authorization_rev,
  );
  if (fact === null || !Number.isSafeInteger(fact.horizon_ms) || fact.horizon_ms <= 0) return { status: 'vetoed' };
  const factMismatch = fact.conflicted !== 0 || fact.action !== row.fact_action || fact.cid !== row.fact_cid;
  const horizon = Math.min(row.expires_at_ms, fact.horizon_ms);
  if (horizon < row.expires_at_ms) {
    db.run(
      `UPDATE love_api_unlove_decisions SET expires_at_ms=?,due_at_ms=min(due_at_ms,?)
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND expires_at_ms>?`,
      horizon,
      nowMs,
      candidate.did,
      candidate.uri,
      candidate.incarnationKey,
      candidate.linkId,
      candidate.generation,
      horizon,
    );
    const persisted = db.one<{ expires_at_ms: number }>(
      `SELECT expires_at_ms FROM love_api_unlove_decisions
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
      candidate.did,
      candidate.uri,
      candidate.incarnationKey,
      candidate.linkId,
      candidate.generation,
    );
    if (persisted?.expires_at_ms !== horizon) return { status: 'missing' };
  }
  if (horizon <= nowMs) return { status: 'expired' };
  if (factMismatch) return { status: 'vetoed' };
  if (row.current_generation !== candidate.generation || row.recipient_state !== 'sealed') return { status: 'missing' };
  if (row.sent_operation_id === null) return row.pending_members > 0 ? { status: 'awaiting' } : { status: 'vetoed' };
  if (row.pending_members > 0) return { status: 'awaiting' };
  const parsed = parseRecordUri(candidate.uri);
  const keys = loveApiTrackKeys(row.artist, row.track);
  if (
    parsed === null ||
    parsed.did !== candidate.did ||
    parsed.rkey === null ||
    keys === null ||
    keys.artistKey !== row.artist_key ||
    keys.trackKey !== row.track_key ||
    row.authorization_uri !== candidate.uri ||
    !isTid(row.authorization_rev) ||
    !validFact({
      uri: row.authorization_uri,
      rev: row.authorization_rev,
      action: row.fact_action,
      cid: row.fact_cid,
      horizonMs: row.expires_at_ms,
    })
  )
    return { status: 'vetoed' };
  const binding = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
    'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
    candidate.did,
    row.sent_operation_id,
  );
  if (
    binding === null ||
    binding.uri !== candidate.uri ||
    binding.incarnation_key !== candidate.incarnationKey ||
    !bindingOrigin(binding.api_origin)
  )
    return { status: 'vetoed' };
  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(row.payload_json);
  } catch {
    return { status: 'vetoed' };
  }
  if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue))
    return { status: 'vetoed' };
  const payload = payloadValue as Record<string, unknown>;
  const projectionKeys = ['artist', 'track'];
  if (typeof payload.album === 'string') projectionKeys.push('album');
  if (typeof payload.recordingMbid === 'string') projectionKeys.push('recordingMbid');
  projectionKeys.push('origin');
  if (
    Object.keys(payload).length !== projectionKeys.length ||
    projectionKeys.some((key) => !Object.hasOwn(payload, key)) ||
    payload.artist !== row.artist ||
    payload.track !== row.track ||
    (row.recording_mbid === null
      ? Object.hasOwn(payload, 'recordingMbid')
      : payload.recordingMbid !== row.recording_mbid) ||
    (typeof payload.album !== 'undefined' && typeof payload.album !== 'string') ||
    payload.origin !== binding.api_origin ||
    JSON.stringify(payload) !== row.payload_json
  )
    return { status: 'vetoed' };
  if (
    db.one(
      `SELECT 1 FROM operations INDEXED BY love_api_active_love_put
       WHERE did=? AND kind='love.put' AND state IN ('queued','blocked','running')
         AND (CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.artist') END)=?
         AND (CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.track') END)=? LIMIT 1`,
      candidate.did,
      row.artist,
      row.track,
    ) !== null ||
    db.one(
      `SELECT 1 FROM operations INDEXED BY love_api_active_love_put_malformed
       WHERE did=? AND kind='love.put' AND state IN ('queued','blocked','running')
         AND (record_json IS NULL OR NOT json_valid(record_json)) LIMIT 1`,
      candidate.did,
    ) !== null
  )
    return { status: 'awaiting' };
  if (
    db.one(
      `SELECT 1 FROM loves INDEXED BY loves_newer_by_track
       WHERE did=? AND artist_key=? AND track_key=? AND revision>? LIMIT 1`,
      candidate.did,
      row.artist_key,
      row.track_key,
      row.authorization_rev,
    ) !== null
  )
    return { status: 'vetoed' };
  const current = db.one<{ incarnation_key: string; state: string }>(
    'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
    candidate.uri,
  );
  if (current?.state === 'present' && current.incarnation_key !== candidate.incarnationKey) return { status: 'vetoed' };
  const exactIntent = db.one<{
    operation_id: string;
    state: string | null;
    attempts: number | null;
    send_state: string | null;
    send_started_at_ms: number | null;
    legacy_absent_at_ms: number | null;
  }>(
    `SELECT i.operation_id,o.state,o.attempts,o.send_state,o.send_started_at_ms,o.legacy_absent_at_ms
     FROM linked_love_intents i LEFT JOIN operations o ON o.id=i.operation_id
     WHERE i.did=? AND i.love_key=? AND i.intent='love'`,
    candidate.did,
    `${row.artist_key}\u0000${row.track_key}`,
  );
  if (exactIntent !== null && exactIntent.operation_id !== row.sent_operation_id) {
    if (exactIntent.state === 'cancelled') {
      // A withdrawn, never-sent love no longer blocks this target.
    } else if (
      (exactIntent.state === 'queued' || exactIntent.state === 'blocked') &&
      exactIntent.send_state === 'unsent' &&
      exactIntent.attempts === 0 &&
      exactIntent.send_started_at_ms === null &&
      exactIntent.legacy_absent_at_ms === null
    ) {
      return { status: 'awaiting' };
    } else {
      return { status: 'vetoed' };
    }
  }

  if (row.recording_mbid !== null) {
    const epochRow = db.one<{ epoch: number }>('SELECT epoch FROM love_api_intent_epochs WHERE did=?', candidate.did);
    const epoch = epochRow?.epoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) return { status: 'vetoed' };
    const cursor = row.scan_session === sessionToken && row.alias_epoch === epoch ? (row.alias_cursor ?? '') : '';
    if (cursor === '' && (row.scan_session !== sessionToken || row.alias_epoch !== epoch))
      db.run(
        `UPDATE love_api_unlove_decisions SET scan_session=?,alias_epoch=?,alias_cursor=''
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        sessionToken,
        epoch,
        candidate.did,
        candidate.uri,
        candidate.incarnationKey,
        candidate.linkId,
        candidate.generation,
      );
    const aliases = db.all<{
      love_key: string;
      operation_id: string;
      state: string | null;
      attempts: number | null;
      send_state: string | null;
      send_started_at_ms: number | null;
      legacy_absent_at_ms: number | null;
    }>(
      `SELECT i.love_key,i.operation_id,o.state,o.attempts,o.send_state,o.send_started_at_ms,o.legacy_absent_at_ms
       FROM linked_love_intents i INDEXED BY love_api_intent_alias_scan
       LEFT JOIN operations o ON o.id=i.operation_id
       WHERE i.did=? AND i.recording_mbid=? AND i.intent='love' AND i.love_key>?
       ORDER BY i.love_key LIMIT ?`,
      candidate.did,
      row.recording_mbid,
      cursor,
      aliasPageSize,
    );
    for (const alias of aliases) {
      if (alias.operation_id === row.sent_operation_id || alias.state === 'cancelled') continue;
      if (
        (alias.state === 'queued' || alias.state === 'blocked') &&
        alias.send_state === 'unsent' &&
        alias.attempts === 0 &&
        alias.send_started_at_ms === null &&
        alias.legacy_absent_at_ms === null
      )
        return { status: 'awaiting' };
      return { status: 'vetoed' };
    }
    if (aliases.length === aliasPageSize) {
      db.run(
        `UPDATE love_api_unlove_decisions SET scan_session=?,alias_epoch=?,alias_cursor=?
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        sessionToken,
        epoch,
        aliases.at(-1)!.love_key,
        candidate.did,
        candidate.uri,
        candidate.incarnationKey,
        candidate.linkId,
        candidate.generation,
      );
      return { status: 'awaiting' };
    }
  }
  return {
    status: 'ready',
    envelope: {
      did: candidate.did,
      recordUri: candidate.uri,
      incarnationKey: candidate.incarnationKey,
      apiOperationId: row.sent_operation_id,
      projectionRkey: parsed.rkey,
      action: row.fact_action,
      cid: row.fact_cid,
      source: binding.api_origin,
      sourceExclusions: [],
      projection: {
        artist: row.artist,
        track: row.track,
        ...(typeof payload.album === 'string' ? { album: payload.album } : {}),
        ...(row.recording_mbid === null ? {} : { recordingMbid: row.recording_mbid }),
      },
      authorization: { uri: row.authorization_uri, rev: row.authorization_rev },
    },
  };
}

/** Shared key validation used when the removal transaction captures a projection envelope. */
export function loveApiTrackKeys(artist: string, track: string): { artistKey: string; trackKey: string } | null {
  try {
    const [artistKey, trackKeyValue] = trackKey(artist, track);
    return { artistKey, trackKey: trackKeyValue };
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
}
