import type { Db } from '../do/db';

export type LoveAuthorityAction = 'create' | 'update' | 'delete';
export interface LoveAuthorization {
  uri: string;
  rev: string;
}

export const DEFERRED_AUTHORITY_EVENT_SQL =
  'SELECT action,cid,conflicted FROM live_pending_removal_events WHERE uri=? AND rev=?';
export const DEFERRED_AUTHORITY_EVIDENCE_SQL =
  'SELECT up_rev,up_action,up_cid,del_rev,conflict_rev FROM live_record_evidence WHERE uri=?';
export const DEFERRED_AUTHORITY_DEPENDENCY_SQL = `SELECT 1 AS present FROM forward_outbox INDEXED BY forward_outbox_unlove_authority_dependency
WHERE authorization_uri=? AND authorization_rev=? AND kind='unlove' AND authorization_uri IS NOT NULL
  AND (state IN ('queued','held','retrying') OR (state='ignored' AND last_error IN ('no_recording_mbid','mbid_unresolved'))) LIMIT 1`;

interface Fact {
  action: LoveAuthorityAction;
  cid: string;
  conflicted?: number;
  conflict_rev?: string | null;
  del_rev?: string | null;
}

export function allocateDeferredAuthoritySequence(db: Db): number {
  const column = 'next_authority_seq';
  db.run('INSERT OR IGNORE INTO forward_deferred_love_maintenance(singleton) VALUES(1)');
  const currentText = db.one<{ value: string }>(
    `SELECT CAST(${column} AS TEXT) AS value FROM forward_deferred_love_maintenance WHERE singleton=1`,
  )?.value;
  if (currentText === undefined) throw new Error('deferred love allocator missing');
  const current = BigInt(currentText);
  if (current < 1n || current >= BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('deferred love authority sequence exhausted');
  const seq = Number(current);
  const changed = db.run(
    `UPDATE forward_deferred_love_maintenance SET ${column}=? WHERE singleton=1 AND ${column}=?`,
    seq + 1,
    seq,
  ).rowsWritten;
  if (changed !== 1) throw new Error('deferred love authority allocator changed');
  return seq;
}

function readFact(db: Db, uri: string, rev: string): Fact | null {
  const event = db.one<Fact>(DEFERRED_AUTHORITY_EVENT_SQL, uri, rev);
  if (event !== null) return event;
  const evidence = db.one<{
    up_rev: string | null;
    up_action: LoveAuthorityAction | null;
    up_cid: string | null;
    del_rev: string | null;
    conflict_rev: string | null;
  }>(DEFERRED_AUTHORITY_EVIDENCE_SQL, uri);
  if (evidence === null) return null;
  if (evidence.del_rev === rev) return { action: 'delete', cid: '', conflict_rev: evidence.conflict_rev };
  if (evidence.up_rev !== rev || evidence.up_action === null || evidence.up_cid === null) return null;
  return { action: evidence.up_action, cid: evidence.up_cid, conflict_rev: evidence.conflict_rev };
}

/** Materialize a live producer's A2 fact before it can create a deferred authority. */
export function materializeLoveAuthority(
  db: Db,
  authorization: LoveAuthorization,
  now: number,
): 'active' | 'conflicted' | 'missing' {
  const current = db.one<{ state: 'active' | 'conflicted'; action: 'update' | 'delete'; cid: string }>(
    'SELECT state,action,cid FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
    authorization.uri,
    authorization.rev,
  );
  if (current !== null) {
    const fact = readFact(db, authorization.uri, authorization.rev);
    const differs =
      fact !== null &&
      ((fact.conflicted ?? 0) === 1 ||
        fact.conflict_rev === authorization.rev ||
        fact.action === 'create' ||
        fact.action !== current.action ||
        fact.cid !== current.cid);
    if (differs) conflictDeferredLoveAuthority(db, authorization.uri, authorization.rev);
    return differs || current.state === 'conflicted' ? 'conflicted' : 'active';
  }
  const fact = readFact(db, authorization.uri, authorization.rev);
  if (fact === null) return 'missing';
  const conflicted =
    (fact.conflicted ?? 0) === 1 || fact.conflict_rev === authorization.rev || fact.action === 'create';
  if (conflicted) return 'conflicted';
  const authoritySeq = allocateDeferredAuthoritySequence(db);
  db.run(
    `INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,action,cid,state,created_at_ms)
     VALUES(?,?,?,?,?,'active',?)`,
    authorization.uri,
    authorization.rev,
    authoritySeq,
    fact.action,
    fact.cid,
    now,
  );
  return 'active';
}

export function compareDeferredLoveAuthority(
  db: Db,
  event: { uri: string; rev: string; action: LoveAuthorityAction; cid: string },
): boolean {
  const authority = db.one<{ action: 'update' | 'delete'; cid: string; state: 'active' | 'conflicted' }>(
    'SELECT action,cid,state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
    event.uri,
    event.rev,
  );
  if (authority === null) return false;
  const differs =
    authority.state === 'conflicted' ||
    authority.action !== event.action ||
    (event.action !== 'delete' && authority.cid !== event.cid);
  if (differs) conflictDeferredLoveAuthority(db, event.uri, event.rev);
  return differs;
}

export function conflictDeferredLoveAuthority(db: Db, uri: string, rev: string): boolean {
  const current = db.one<{ state: 'active' | 'conflicted'; authority_seq: number }>(
    'SELECT state,authority_seq FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
    uri,
    rev,
  );
  if (current === null) return false;
  if (current.state === 'conflicted') return false;
  const dueSeq = allocateDeferredAuthoritySequence(db);
  db.run(
    `UPDATE forward_deferred_love_authorities SET state='conflicted',due_seq=?
     WHERE authorization_uri=? AND authorization_rev=? AND state='active'`,
    dueSeq,
    uri,
    rev,
  );
  return true;
}

export function hasAuthorityDependency(db: Db, uri: string, rev: string): boolean {
  return (
    db.one(
      'SELECT 1 AS present FROM forward_deferred_love_intents WHERE authorization_uri=? AND authorization_rev=? LIMIT 1',
      uri,
      rev,
    ) !== null || db.one(DEFERRED_AUTHORITY_DEPENDENCY_SQL, uri, rev) !== null
  );
}

export function deferredAuthorityStatus(db: Db, authorization: LoveAuthorization): 'active' | 'conflicted' | 'missing' {
  const authority = db.one<{ state: 'active' | 'conflicted'; action: 'update' | 'delete'; cid: string }>(
    'SELECT state,action,cid FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
    authorization.uri,
    authorization.rev,
  );
  if (authority === null) return 'missing';
  if (authority.state !== 'active') return 'conflicted';
  const fact = readFact(db, authorization.uri, authorization.rev);
  if (fact === null) return 'active';
  const valid =
    (fact.conflicted ?? 0) !== 1 &&
    fact.conflict_rev !== authorization.rev &&
    fact.action !== 'create' &&
    authority.action === fact.action &&
    (fact.action === 'delete' || authority.cid === fact.cid);
  return valid ? 'active' : 'conflicted';
}

export function deferredAuthorityValid(db: Db, authorization: LoveAuthorization): boolean {
  return deferredAuthorityStatus(db, authorization) === 'active';
}

export function releaseUnusedDeferredAuthority(db: Db, uri: string, rev: string): boolean {
  if (hasAuthorityDependency(db, uri, rev)) return false;
  return (
    db.run('DELETE FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?', uri, rev)
      .rowsWritten === 1
  );
}
