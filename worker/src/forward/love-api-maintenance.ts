import type { Db } from '../do/db';

export const LOVE_API_RECLAIM_PAGE = 8;

export const LOVE_API_BINDING_RECLAIM_DELETE_SQL = `DELETE FROM love_api_bindings WHERE did=? AND operation_id=? AND binding_seq=?
  AND NOT EXISTS(SELECT 1 FROM love_api_unlove_decisions d
    WHERE d.did=? AND d.uri=? AND d.incarnation_key=? LIMIT 1)`;

export interface LoveApiReclaimResult {
  visited: number;
  bindingsDeleted: number;
  factsDeleted: number;
  lane: 'binding' | 'fact';
}

type ProofState = {
  reclaim_kind: 'binding' | 'fact';
  binding_cursor: number;
  binding_frontier: number;
  fact_cursor: number;
  fact_frontier: number;
  reclaim_passes: number;
};

type ReclaimCursor = Pick<
  ProofState,
  'reclaim_kind' | 'binding_cursor' | 'binding_frontier' | 'fact_cursor' | 'fact_frontier'
>;

type ReclaimState = ReclaimCursor & {
  reclaim_passes: number;
};

type BindingRow = {
  did: string;
  operation_id: string;
  uri: string;
  incarnation_key: string;
  binding_seq: number;
};

type FactRow = {
  authorization_uri: string;
  authorization_rev: string;
  fact_seq: number;
  horizon_ms: number;
};

function successor(value: number, name: string): number {
  checked(value, name);
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError(`L2 ${name} successor is unsafe`);
  return value + 1;
}

function safeState(db: Db): ProofState {
  const state = db.one<ProofState>(
    `SELECT reclaim_kind,binding_cursor,binding_frontier,fact_cursor,fact_frontier,reclaim_passes
     FROM love_api_proof_state WHERE singleton=1`,
  );
  if (state === null) throw new Error('missing L2 proof maintenance state');
  checked(state.binding_cursor, 'binding cursor');
  checked(state.binding_frontier, 'binding frontier');
  checked(state.fact_cursor, 'fact cursor');
  checked(state.fact_frontier, 'fact frontier');
  checked(state.reclaim_passes, 'reclaim passes');
  return state;
}

function writeState(db: Db, state: ReclaimState, nowMs: number): void {
  db.run(
    `UPDATE love_api_proof_state SET reclaim_kind=?,binding_cursor=?,binding_frontier=?,fact_cursor=?,fact_frontier=?,
       reclaim_passes=?,updated_at_ms=? WHERE singleton=1`,
    state.reclaim_kind,
    state.binding_cursor,
    state.binding_frontier,
    state.fact_cursor,
    state.fact_frontier,
    state.reclaim_passes,
    nowMs,
  );
}

function checked(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid L2 ${name}`);
  return value;
}

/** Reclaims one finite, keyset-bounded proof lane; dependent origin/facts stay durable. */
export function reclaimLoveApiProofRows(db: Db, nowMs: number, limit = LOVE_API_RECLAIM_PAGE): LoveApiReclaimResult {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LOVE_API_RECLAIM_PAGE
  )
    throw new RangeError('invalid L2 reclaim bounds');
  return db.tx(() => {
    db.run('INSERT OR IGNORE INTO love_api_proof_state(singleton) VALUES(1)');
    const state = safeState(db);
    const lane = state.reclaim_kind;
    const next: ReclaimState = { ...state };
    let cursor = lane === 'binding' ? next.binding_cursor : next.fact_cursor;
    let frontier = lane === 'binding' ? next.binding_frontier : next.fact_frontier;
    if (cursor === frontier) {
      const max = db.one<{ value: number }>(
        lane === 'binding'
          ? 'SELECT coalesce(max(binding_seq),0) AS value FROM love_api_bindings'
          : 'SELECT coalesce(max(fact_seq),0) AS value FROM love_api_comparison_facts',
      )?.value;
      if (max === undefined) throw new Error('missing L2 reclaim frontier');
      frontier = checked(max, 'reclaim maximum');
      if (frontier === 0) {
        const otherMax = db.one<{ value: number }>(
          lane === 'binding'
            ? 'SELECT coalesce(max(fact_seq),0) AS value FROM love_api_comparison_facts'
            : 'SELECT coalesce(max(binding_seq),0) AS value FROM love_api_bindings',
        )?.value;
        if (otherMax === undefined) throw new Error('missing L2 alternate reclaim frontier');
        if (checked(otherMax, 'alternate reclaim maximum') > 0) {
          next.reclaim_kind = lane === 'binding' ? 'fact' : 'binding';
          writeState(db, next, nowMs);
        }
        return { visited: 0, bindingsDeleted: 0, factsDeleted: 0, lane };
      }
      next.reclaim_passes = successor(next.reclaim_passes, 'reclaim passes');
      cursor = 0;
      if (lane === 'binding') {
        next.binding_cursor = 0;
        next.binding_frontier = frontier;
      } else {
        next.fact_cursor = 0;
        next.fact_frontier = frontier;
      }
    }

    let visited = 0;
    let bindingsDeleted = 0;
    let factsDeleted = 0;
    let lastSeq = cursor;
    let rowCount = 0;
    if (lane === 'binding') {
      const rows = db.all<BindingRow>(
        `SELECT did,operation_id,uri,incarnation_key,binding_seq FROM love_api_bindings
         WHERE binding_seq>? AND binding_seq<=? ORDER BY binding_seq LIMIT ?`,
        cursor,
        frontier,
        limit,
      );
      rowCount = rows.length;
      for (const row of rows) {
        const seq = checked(row.binding_seq, 'binding sequence');
        if (seq <= lastSeq || seq > frontier) throw new Error('L2 binding cursor escaped frontier');
        visited++;
        const used = db.one(
          `SELECT 1 FROM linked_accounts l
           CROSS JOIN love_api_recipients r ON r.did=? AND r.uri=? AND r.incarnation_key=?
             AND r.link_id=l.id AND r.generation=l.generation
           WHERE l.did=? AND r.state IN ('present','sealed') AND (
             r.sent_operation_id IS NOT NULL OR EXISTS(
               SELECT 1 FROM love_api_recipient_members m
               WHERE m.link_id=r.link_id AND m.generation=r.generation AND m.operation_id=?
                 AND m.did=r.did AND m.uri=r.uri AND m.incarnation_key=r.incarnation_key
             )
           ) LIMIT 1`,
          row.did,
          row.uri,
          row.incarnation_key,
          row.did,
          row.operation_id,
        );
        if (used === null)
          bindingsDeleted += db.run(
            LOVE_API_BINDING_RECLAIM_DELETE_SQL,
            row.did,
            row.operation_id,
            seq,
            row.did,
            row.uri,
            row.incarnation_key,
          ).rowsWritten;
        lastSeq = seq;
      }
      if (rows.length < limit || rows.length === 0 || rows.at(-1)!.binding_seq >= frontier) {
        next.reclaim_kind = 'fact';
        next.binding_cursor = 0;
        next.binding_frontier = 0;
      } else next.binding_cursor = lastSeq;
    } else {
      const rows = db.all<FactRow>(
        `SELECT authorization_uri,authorization_rev,fact_seq,horizon_ms FROM love_api_comparison_facts
         WHERE fact_seq>? AND fact_seq<=? ORDER BY fact_seq LIMIT ?`,
        cursor,
        frontier,
        limit,
      );
      rowCount = rows.length;
      for (const row of rows) {
        const seq = checked(row.fact_seq, 'fact sequence');
        if (seq <= lastSeq || seq > frontier) throw new Error('L2 fact cursor escaped frontier');
        visited++;
        if (row.horizon_ms <= nowMs) {
          const held = db.one(
            `SELECT 1 FROM love_api_unlove_decisions WHERE authorization_uri=? AND authorization_rev=?
             UNION ALL SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=? LIMIT 1`,
            row.authorization_uri,
            row.authorization_rev,
            row.authorization_uri,
            row.authorization_rev,
          );
          if (held === null)
            factsDeleted += db.run(
              `DELETE FROM love_api_comparison_facts WHERE authorization_uri=? AND authorization_rev=? AND fact_seq=? AND horizon_ms<=?`,
              row.authorization_uri,
              row.authorization_rev,
              seq,
              nowMs,
            ).rowsWritten;
        }
        lastSeq = seq;
      }
      if (rows.length < limit || rows.length === 0 || rows.at(-1)!.fact_seq >= frontier) {
        next.reclaim_kind = 'binding';
        next.fact_cursor = 0;
        next.fact_frontier = 0;
      } else next.fact_cursor = lastSeq;
    }
    if (
      visited > 0 ||
      rowCount > 0 ||
      next.reclaim_kind !== state.reclaim_kind ||
      next.binding_cursor !== state.binding_cursor ||
      next.binding_frontier !== state.binding_frontier ||
      next.fact_cursor !== state.fact_cursor ||
      next.fact_frontier !== state.fact_frontier ||
      next.reclaim_passes !== state.reclaim_passes
    )
      writeState(db, next, nowMs);
    return { visited, bindingsDeleted, factsDeleted, lane };
  });
}
