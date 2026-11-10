// Exact API love-operation provenance and retained A2 comparison facts for L2.
// This leaf has no producer, enqueue, backfill or timer imports.

import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { isTid, parseRecordUri } from '@atmusic/core/syntax';
import type { Origin } from '../app/rows';
import type { Db } from '../do/db';
import { canonicalForwardDedupeKey } from '../outbox/forward-identity';
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

export interface LoveApiSettledRow {
  id: string;
  link_id: string;
  generation: number;
  did: string;
  kind: string;
  dedupe_key: string;
  state: 'sent' | 'ignored' | 'failed' | 'expired';
}

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

/** Retain an exact verified A2 fact before its source event/evidence can be cleaned up. */
export function recordLoveApiComparisonFact(db: Db, fact: LoveApiAuthorizationFact, nowMs: number): boolean {
  if (!validFact(fact) || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  return db.tx(() => {
    const existing = db.one<{ action: LoveApiFactAction; cid: string; conflicted: number; horizon_ms: number }>(
      'SELECT action,cid,conflicted,horizon_ms FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=?',
      fact.uri,
      fact.rev,
    );
    if (existing === null) {
      const seq = allocate(db, 'next_fact_seq');
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
      return !fact.conflicted;
    }
    const mismatch = existing.action !== fact.action || existing.cid !== fact.cid;
    if (mismatch || fact.conflicted) {
      db.run(
        'UPDATE love_api_comparison_facts SET conflicted=1,horizon_ms=min(horizon_ms,?) WHERE authorization_uri=? AND authorization_rev=?',
        fact.horizonMs,
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
    db.run(
      'UPDATE love_api_comparison_facts SET horizon_ms=min(horizon_ms,?) WHERE authorization_uri=? AND authorization_rev=?',
      fact.horizonMs,
      fact.uri,
      fact.rev,
    );
    return existing.conflicted === 0;
  });
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

function memberRows(db: Db, args: LoveApiBindingArgs): Array<{ link_id: string; generation: number; state: string }> {
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

function bindingOrigin(value: string): value is Exclude<Origin, 'import'> {
  return value === 'web' || value === 'lastfm' || value === 'listenbrainz';
}

/** Bind one exact API operation to a present incarnation and current B2 generations atomically. */
export function bindApiLoveOperation(db: Db, args: LoveApiBindingArgs): boolean {
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

    const links = memberRows(db, args);
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
    if (row.state === 'sent')
      db.run(
        `UPDATE love_api_recipients SET sent_operation_id=coalesce(sent_operation_id,?),updated_at_ms=?
         WHERE ${RECIPIENT_KEY} AND state IN ('present','sealed')`,
        operationId,
        nowMs,
        member.did,
        member.uri,
        member.incarnation_key,
        row.link_id,
        row.generation,
      );
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
