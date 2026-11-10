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
  horizonMs: number;
  nowMs: number;
  recipients: Array<{
    linkId: string;
    generation: number;
    sentOperationId: string | null;
    sentOrigin: Exclude<Origin, 'import'> | null;
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
    link_id: string;
    generation: number;
    sent_operation_id: string | null;
    state: string;
  }>(
    `SELECT r.link_id,r.generation,r.sent_operation_id,r.state
     FROM love_api_recipients r JOIN linked_accounts l ON l.id=r.link_id AND l.generation=r.generation
     WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.state IN ('present','sealed')`,
    args.did,
    args.uri,
    args.incarnationKey,
  );
  if (rows.length === 0) return null;
  const evidence = db.one<{
    did: string;
    collection: string;
    rkey: string;
    del_rev: string | null;
    conflict_rev: string | null;
    expires_at_ms: number;
  }>('SELECT did,collection,rkey,del_rev,conflict_rev,expires_at_ms FROM live_record_evidence WHERE uri=?', args.uri);
  if (
    evidence === null ||
    evidence.did !== args.did ||
    evidence.collection !== parsed.collection ||
    evidence.rkey !== parsed.rkey ||
    evidence.del_rev !== args.rev ||
    evidence.expires_at_ms <= args.nowMs
  )
    return null;
  const active = recordLoveApiComparisonFact(
    db,
    {
      uri: args.uri,
      rev: args.rev,
      action: 'delete',
      cid: '',
      horizonMs: evidence.expires_at_ms,
      conflicted: evidence.conflict_rev === args.rev,
    },
    args.nowMs,
  );
  if (!active) return 'conflicted';
  const recipients: PreparedLoveApiAbsence['recipients'] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 || row.state === 'released') return 'conflicted';
    let sentOrigin: Exclude<Origin, 'import'> | null = null;
    if (row.sent_operation_id !== null) {
      const binding = db.one<{ uri: string; incarnation_key: string; api_origin: string }>(
        'SELECT uri,incarnation_key,api_origin FROM love_api_bindings WHERE did=? AND operation_id=?',
        args.did,
        row.sent_operation_id,
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
            action: 'delete',
            cid: '',
            horizonMs: evidence.expires_at_ms,
            conflicted: true,
          },
          args.nowMs,
        );
        return 'conflicted';
      }
      sentOrigin = binding.api_origin;
    }
    const hasPendingMembers =
      db.one(
        `SELECT 1 AS present FROM love_api_recipient_members
         WHERE link_id=? AND generation=? AND did=? AND uri=? AND incarnation_key=? LIMIT 1`,
        row.link_id,
        row.generation,
        args.did,
        args.uri,
        args.incarnationKey,
      ) !== null;
    recipients.push({
      linkId: row.link_id,
      generation: row.generation,
      sentOperationId: row.sent_operation_id,
      sentOrigin,
      hasPendingMembers,
    });
  }
  return {
    did: args.did,
    uri: args.uri,
    incarnationKey: args.incarnationKey,
    rev: args.rev,
    horizonMs: evidence.expires_at_ms,
    nowMs: args.nowMs,
    recipients,
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
  for (const recipient of prepared.recipients) {
    const hasProof = recipient.sentOperationId !== null;
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
    const payload = JSON.stringify(lovePayload(love, recipient.sentOrigin ?? undefined));
    const existing = db.one<{
      authorization_uri: string;
      authorization_rev: string;
      fact_action: string;
      fact_cid: string;
      expires_at_ms: number;
      payload_json: string;
    }>(
      `SELECT authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,payload_json
       FROM love_api_unlove_decisions WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
      prepared.did,
      prepared.uri,
      prepared.incarnationKey,
      recipient.linkId,
      recipient.generation,
    );
    if (
      existing !== null &&
      (existing.authorization_uri !== prepared.uri ||
        existing.authorization_rev !== prepared.rev ||
        existing.fact_action !== 'delete' ||
        existing.fact_cid !== '' ||
        !sameLovePayload(existing.payload_json, love) ||
        (recipient.sentOrigin !== null && JSON.parse(existing.payload_json).origin !== recipient.sentOrigin))
    ) {
      recordLoveApiComparisonFact(
        db,
        {
          uri: prepared.uri,
          rev: prepared.rev,
          action: 'delete',
          cid: '',
          horizonMs: prepared.horizonMs,
          conflicted: true,
        },
        prepared.nowMs,
      );
      return false;
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
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,'delete','',?,?,?)`,
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
        prepared.horizonMs,
        prepared.nowMs,
        prepared.nowMs,
      );
      continue;
    }
    const expiry = Math.min(existing.expires_at_ms, prepared.horizonMs);
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
