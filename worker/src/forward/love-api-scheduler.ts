import type { Random } from '@atmusic/core/deps';
import type { Db, SqlParam } from '../do/db';
import { storedForwardDedupeKey } from '../outbox/forward-identity';
import { countLinkCoverage } from './coverage';
import { LOVE_API_RECLAIM_PAGE, reclaimLoveApiProofRows } from './love-api-maintenance';
import { materializeLoveApiRecipientDecisions } from './love-api-materializer';
import { settleApiLoveRecipientRows } from './love-api-recipients';

export const LOVE_API_WRITES = 96;
export const LOVE_API_VISITS = 16;
export const LOVE_API_METADATA_RESERVE = 12;
export const LOVE_API_UNIT_BUDGET = LOVE_API_WRITES - LOVE_API_METADATA_RESERVE;
export const LOVE_API_DECISION_COST = 28;
export const LOVE_API_SWEEP_COST = 17;
export const LOVE_API_RECLAIM_COST = 8;
export const LOVE_API_LANE_UNITS = { decision: 3, sweep: 4, reclaim: 10 } as const;
export const LOVE_API_LANE_GUARANTEE_WRITES = 28;
export const LOVE_API_LANE_GUARANTEE_VISITS = 5;
export const LOVE_API_ACTIVE_MS = 1_000;
export const LOVE_API_QUIET_MS = 30_000;

type Lane = 'decision' | 'sweep' | 'reclaim';
type LaneState = {
  lane_turn: number;
  next_aggregate_seq: number;
  sweep_cursor: number;
  sweep_frontier: number;
  sweep_passes: number;
};

type Metric = { reads: number; mutations: number; returnedRows: number };
type UnitResult = { work: number; visits: number; useful: boolean; performed: boolean; cursorProgress: boolean };
type LaneReport = {
  lane: Lane;
  reserved: number;
  work: number;
  changedRows: number;
  visits: number;
  units: number;
  reads: number;
  mutationStatements: number;
  returnedRows: number;
};
type TransactionReport = {
  phase: string;
  reads: number;
  mutationStatements: number;
  changedRows: number;
  returnedRows: number;
  visits: number;
};

/** Synchronous SQL probe seam for exercising the actual decision transaction read meter. */
export type LoveApiDecisionReadProbe = (db: Db) => void;

export interface LoveApiMaintenanceResult {
  useful: boolean;
  wakeMs: number;
  writes: number;
  visits: number;
  reads: number;
  mutationStatements: number;
  returnedRows: number;
  decisions: { queued: number; deferred: number; replay: number; refused: number; awaiting: number; expired: number };
  sweepUnits: number;
  reclaimUnits: number;
  lanes: LaneReport[];
  transactions: TransactionReport[];
}

type Budget = {
  reserved: number;
  work: number;
  metadata: number;
  visits: number;
  laneUnits: Record<Lane, number>;
};

const MUTATION = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

function observedDb(raw: Db): { db: Db; metric(): Metric; reset(): void } {
  let reads = 0;
  let mutations = 0;
  let returnedRows = 0;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const rows = raw.all<T>(sql, ...params);
      account(sql, rows.length);
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      const row = raw.one<T>(sql, ...params);
      account(sql, row === null ? 0 : 1);
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      const result = raw.run(sql, ...params);
      account(sql, 0);
      return result;
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return raw.tx(fn);
    },
  };
  function account(sql: string, rowCount: number): void {
    if (MUTATION.test(sql)) mutations++;
    else reads++;
    returnedRows += rowCount;
  }
  return {
    db,
    metric: () => ({ reads, mutations, returnedRows }),
    reset: () => {
      reads = 0;
      mutations = 0;
      returnedRows = 0;
    },
  };
}

function totalChanges(db: Db): bigint {
  const value = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (value === undefined) throw new Error('SQLite change counter unavailable');
  return BigInt(value);
}

function safe(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`invalid L2 ${label}`);
  return value;
}

export function assertLoveApiInvocationBudget(changedRows: bigint, visits: number): void {
  if (changedRows < 0n || changedRows > BigInt(LOVE_API_WRITES))
    throw new Error(`L2 invocation changed-row bound exceeded: ${changedRows}/96`);
  if (!Number.isSafeInteger(visits) || visits < 0 || visits > LOVE_API_VISITS)
    throw new Error(`L2 invocation visit bound exceeded: ${visits}/16`);
}

export function assertLoveApiDecisionBudget(reads: number, changedRows: bigint): void {
  if (!Number.isSafeInteger(reads) || reads < 0 || reads > 128)
    throw new Error(`L2 DECISION read bound exceeded: ${reads}/128`);
  if (changedRows < 0n || changedRows > BigInt(LOVE_API_DECISION_COST))
    throw new Error(`L2 DECISION unit exceeded 28 changed rows: ${changedRows}`);
}

function successor(value: number, label: string): number {
  safe(value, label);
  if (value >= Number.MAX_SAFE_INTEGER) throw new RangeError(`L2 ${label} successor is unsafe`);
  return value + 1;
}

function readLaneState(db: Db): LaneState {
  const row = db.one<LaneState>(
    `SELECT lane_turn,next_aggregate_seq,sweep_cursor,sweep_frontier,sweep_passes
     FROM love_api_proof_state WHERE singleton=1`,
  );
  if (row === null) throw new Error('missing L2 proof maintenance state');
  if (safe(row.lane_turn, 'lane turn') > 2) throw new RangeError('invalid L2 lane turn');
  safe(row.next_aggregate_seq, 'next aggregate sequence', 1);
  safe(row.sweep_cursor, 'sweep cursor');
  safe(row.sweep_frontier, 'sweep frontier');
  safe(row.sweep_passes, 'sweep passes');
  return row;
}

function checkedUpdate(db: Db, sql: string, ...params: SqlParam[]): number {
  return db.run(sql, ...params).rowsWritten;
}

function validateOwnedMember(
  db: Db,
  key: readonly [string, string, string, string, number],
  validateAfterSeq: number,
  nowMs: number,
): { work: number; useful: boolean } {
  const cursor = safe(validateAfterSeq, 'member validation cursor');
  const member = db.one<{ operation_id: string; member_seq: number }>(
    `SELECT operation_id,member_seq FROM love_api_recipient_members
     WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND member_seq>?
     ORDER BY member_seq LIMIT 1`,
    ...key,
    cursor,
  );
  let work = 0;
  let useful = false;
  if (member === null) {
    if (cursor !== 0) {
      work += checkedUpdate(
        db,
        `UPDATE love_api_recipients SET validate_after_seq=0
         WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND validate_after_seq=?`,
        ...key,
        cursor,
      );
    }
    return { work, useful };
  }
  const seq = safe(member.member_seq, 'member sequence', 1);
  const effect = db.one<{
    id: string;
    did: string;
    link_id: string;
    generation: number;
    kind: string;
    dedupe_key: string;
    state: string;
    binding_uri: string | null;
    binding_incarnation_key: string | null;
    binding_origin: string | null;
  }>(
    `SELECT f.id,f.did,f.link_id,f.generation,f.kind,f.dedupe_key,f.state,
            b.uri AS binding_uri,b.incarnation_key AS binding_incarnation_key,b.api_origin AS binding_origin
     FROM forward_outbox f
     LEFT JOIN love_api_bindings b ON b.did=? AND b.operation_id=? AND b.uri=? AND b.incarnation_key=?
     WHERE f.did=? AND f.link_id=? AND f.generation=? AND f.kind='love' AND f.dedupe_key=? LIMIT 1`,
    key[0],
    member.operation_id,
    key[1],
    key[2],
    key[0],
    key[3],
    key[4],
    storedForwardDedupeKey(key[4], member.operation_id),
  );
  const validBinding =
    effect?.did === key[0] &&
    effect.binding_uri === key[1] &&
    effect.binding_incarnation_key === key[2] &&
    effect.binding_origin !== null &&
    ['web', 'lastfm', 'listenbrainz'].includes(effect.binding_origin);
  if (effect === null || !validBinding || !['queued', 'held'].includes(effect.state)) {
    if (
      effect?.state === 'sent' &&
      effect.did === key[0] &&
      effect.link_id === key[3] &&
      effect.generation === key[4]
    ) {
      if (validBinding && effect.binding_origin !== null)
        settleApiLoveRecipientRows(
          db,
          [
            {
              id: effect.id,
              link_id: effect.link_id,
              generation: effect.generation,
              did: effect.did,
              kind: 'love',
              dedupe_key: effect.dedupe_key,
              state: 'sent',
            },
          ],
          nowMs,
        );
    }
    work += checkedUpdate(
      db,
      `DELETE FROM love_api_recipient_members
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND operation_id=? AND member_seq=?`,
      ...key,
      member.operation_id,
      seq,
    );
    useful = work > 0;
  }
  work += checkedUpdate(
    db,
    `UPDATE love_api_recipients SET validate_after_seq=?
     WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? AND validate_after_seq=?`,
    seq,
    ...key,
    cursor,
  );
  return { work, useful };
}

function sweepOne(db: Db, state: LaneState, nowMs: number): UnitResult {
  let cursor = state.sweep_cursor;
  let frontier = state.sweep_frontier;
  let cursorProgress = false;
  if (cursor === frontier) {
    const nextFrontier = safe(state.next_aggregate_seq - 1, 'aggregate frontier');
    if (nextFrontier === 0) return { work: 0, visits: 0, useful: false, performed: false, cursorProgress: false };
    if (state.sweep_passes >= Number.MAX_SAFE_INTEGER) throw new RangeError('L2 sweep pass exhausted');
    state.sweep_passes = successor(state.sweep_passes, 'sweep passes');
    state.sweep_cursor = 0;
    state.sweep_frontier = nextFrontier;
    cursor = 0;
    frontier = nextFrontier;
    cursorProgress = true;
  }
  const row = db.one<{
    did: string;
    uri: string;
    incarnation_key: string;
    link_id: string;
    generation: number;
    aggregate_seq: number;
    state: 'present' | 'sealed' | 'released';
  }>(
    `SELECT did,uri,incarnation_key,link_id,generation,aggregate_seq,state FROM love_api_recipients
     WHERE aggregate_seq>? AND aggregate_seq<=? ORDER BY aggregate_seq LIMIT 1`,
    cursor,
    frontier,
  );
  if (row === null) {
    state.sweep_cursor = 0;
    state.sweep_frontier = 0;
    return { work: 0, visits: 0, useful: false, performed: false, cursorProgress: true };
  }
  const seq = safe(row.aggregate_seq, 'aggregate sequence', 1);
  if (seq <= cursor || seq > frontier) throw new Error('L2 sweep cursor escaped frontier');
  const key = [row.did, row.uri, row.incarnation_key, row.link_id, row.generation] as const;
  const windowOwned =
    db.one(
      `SELECT 1 FROM love_api_window_owners WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? LIMIT 1`,
      ...key,
    ) !== null;
  const ownership = db.one<{ validate_after_seq: number; decision_did: string | null }>(
    `SELECT r.validate_after_seq,d.did AS decision_did
     FROM love_api_recipients r
     LEFT JOIN love_api_unlove_decisions d
       ON d.did=r.did AND d.uri=r.uri AND d.incarnation_key=r.incarnation_key
       AND d.link_id=r.link_id AND d.generation=r.generation
     WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.link_id=? AND r.generation=? LIMIT 1`,
    ...key,
  );
  const decisionOwned = ownership?.decision_did !== null && ownership?.decision_did !== undefined;
  const link = db.one<{ generation: number }>('SELECT generation FROM linked_accounts WHERE id=?', row.link_id);
  const incarnation = db.one<{ incarnation_key: string; state: string }>(
    'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
    row.uri,
  );
  const currentPresent =
    incarnation !== null && incarnation.incarnation_key === row.incarnation_key && incarnation.state === 'present';
  const staleAggregate =
    row.state === 'released' ||
    (row.state === 'sealed' && !decisionOwned) ||
    (link !== null && link.generation > row.generation) ||
    (row.state === 'present' && !currentPresent);
  if (decisionOwned && !staleAggregate) {
    const validated = validateOwnedMember(db, key, ownership!.validate_after_seq, nowMs);
    state.sweep_cursor = seq;
    return {
      work: validated.work,
      visits: 1,
      useful: validated.useful,
      performed: true,
      cursorProgress: true,
    };
  }
  const owned = windowOwned;
  const eligible =
    !owned &&
    (row.state === 'released' ||
      row.state === 'sealed' ||
      (link !== null && link.generation > row.generation) ||
      (row.state === 'present' && !currentPresent));
  let work = 0;
  let useful = false;
  let done = true;
  if (eligible) {
    const members = db.all<{ operation_id: string }>(
      `SELECT operation_id FROM love_api_recipient_members
       WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?
       ORDER BY member_seq LIMIT 16`,
      ...key,
    );
    for (const member of members) {
      work += checkedUpdate(
        db,
        'DELETE FROM love_api_recipient_members WHERE link_id=? AND generation=? AND operation_id=?',
        row.link_id,
        row.generation,
        member.operation_id,
      );
    }
    done =
      db.one(
        `SELECT 1 FROM love_api_recipient_members WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=? LIMIT 1`,
        ...key,
      ) === null;
    // A full member page can consume16 rows; defer the parent so its exact
    // decision cascade is charged to a later bounded visit.
    if (done && decisionOwned && members.length === 16) done = false;
    if (done) {
      work += checkedUpdate(
        db,
        `DELETE FROM love_api_recipients WHERE did=? AND uri=? AND incarnation_key=? AND link_id=? AND generation=?`,
        ...key,
      );
    }
    useful = work > 0;
  }
  if (done) state.sweep_cursor = seq;
  cursorProgress ||= state.sweep_cursor !== cursor || state.sweep_frontier !== frontier;
  return { work, visits: 1, useful, performed: true, cursorProgress };
}

type PhaseBudget = { writes: number; visits: number; writesLimit: number; visitsLimit: number };

function beginUnit(budget: Budget, lane: Lane, cost: number, visits: number, phase: PhaseBudget): void {
  if (budget.reserved + cost > LOVE_API_UNIT_BUDGET) throw new Error('L2 unit write budget exceeded');
  if (budget.visits + visits > LOVE_API_VISITS) throw new Error('L2 visit budget exceeded');
  if (phase.writes + cost > phase.writesLimit || phase.visits + visits > phase.visitsLimit)
    throw new Error(`L2 ${lane} phase allowance exceeded`);
  budget.reserved += cost;
  phase.writes += cost;
  phase.visits += visits;
}

function runLanePhase(
  db: Db,
  lane: Lane,
  nowMs: number,
  random: Random,
  sessionToken: string,
  budget: Budget,
  invocationStart: bigint,
  laneReports: LaneReport[],
  decisions: LoveApiMaintenanceResult['decisions'],
  stopped: Set<Lane>,
  writesLimit: number,
  visitsLimit: number,
  observer: ReturnType<typeof observedDb>,
  transactions: TransactionReport[],
  turnTail: { value: boolean },
  decisionReadProbe?: LoveApiDecisionReadProbe,
): { useful: boolean; units: number; visits: number } {
  if (stopped.has(lane)) return { useful: false, units: 0, visits: 0 };
  let phaseUseful = 0;
  let units = 0;
  let phaseVisits = 0;
  let phaseWork = 0;
  let metaReserved = 0;
  const phase = { writes: 0, visits: 0, writesLimit, visitsLimit };
  const cursorState: LaneState | null = lane === 'sweep' ? readLaneState(db) : null;
  const transactionMetricStart = observer.metric();
  let changesBefore = 0n;
  let decisionUnitMetricStart: Metric | null = null;
  let decisionUnitChangesBefore = 0n;
  let decisionLaneReport: LaneReport | null = null;
  db.tx(() => {
    changesBefore = totalChanges(db);
    while (budget.laneUnits[lane] < LOVE_API_LANE_UNITS[lane]) {
      const metadataBeforeUnit = Number(totalChanges(db) - invocationStart) - budget.work;
      const reservedTail = lane === 'reclaim' ? 4 : lane === 'sweep' ? 3 : 2;
      if (metadataBeforeUnit + reservedTail > LOVE_API_METADATA_RESERVE) {
        stopped.add(lane);
        break;
      }
      const cost =
        lane === 'decision' ? LOVE_API_DECISION_COST : lane === 'sweep' ? LOVE_API_SWEEP_COST : LOVE_API_RECLAIM_COST;
      const maxVisits =
        lane === 'reclaim'
          ? Math.min(LOVE_API_RECLAIM_PAGE, LOVE_API_VISITS - budget.visits, phase.visitsLimit - phase.visits)
          : 1;
      if (maxVisits <= 0) break;
      if (budget.reserved + cost > LOVE_API_UNIT_BUDGET || budget.visits + maxVisits > LOVE_API_VISITS) break;
      if (phase.writes + cost > phase.writesLimit || phase.visits + maxVisits > phase.visitsLimit) break;
      const unitMetricStart = observer.metric();
      const unitReadStart = unitMetricStart.reads;
      const unitChangesBefore = totalChanges(db);
      if (lane === 'decision') {
        decisionUnitMetricStart = transactionMetricStart;
        decisionUnitChangesBefore = changesBefore;
        beginUnit(budget, lane, cost, 1, phase);
        const result = materializeLoveApiRecipientDecisions(db, nowMs, random, sessionToken, 1);
        if (result.visited === 0) {
          budget.reserved -= cost;
          phase.writes -= cost;
          phase.visits -= 1;
          stopped.add(lane);
          break;
        }
        const probeResult: unknown = decisionReadProbe?.(observer.db);
        if (
          probeResult !== null &&
          typeof probeResult === 'object' &&
          'then' in probeResult &&
          typeof probeResult.then === 'function'
        )
          throw new TypeError('L2 decision read probe must be synchronous');
        const delta = totalChanges(db) - unitChangesBefore;
        budget.work += Number(delta);
        phaseWork += Number(delta);
        budget.visits++;
        phaseVisits++;
        budget.laneUnits.decision++;
        units++;
        decisions.queued += result.queued;
        decisions.deferred += result.deferred;
        decisions.replay += result.replay;
        decisions.refused += result.refused;
        decisions.awaiting += result.awaiting;
        decisions.expired += result.expired;
        const useful = result.queued + result.deferred + result.replay + result.refused + result.expired > 0;
        if (useful) {
          phaseUseful++;
          turnTail.value = true;
        }
        decisionLaneReport = {
          lane,
          reserved: cost,
          work: Number(delta),
          changedRows: Number(delta),
          visits: 1,
          units: 1,
          reads: observer.metric().reads - unitReadStart,
          mutationStatements: observer.metric().mutations - unitMetricStart.mutations,
          returnedRows: observer.metric().returnedRows - unitMetricStart.returnedRows,
        };
      } else if (lane === 'sweep') {
        beginUnit(budget, lane, cost, 1, phase);
        const result = sweepOne(db, cursorState!, nowMs);
        if (result.cursorProgress) metaReserved = 1;
        if (!result.performed) {
          budget.reserved -= cost;
          phase.writes -= cost;
          phase.visits -= 1;
          stopped.add(lane);
          break;
        }
        const delta = totalChanges(db) - unitChangesBefore;
        if (delta < 0n || delta > BigInt(cost))
          throw new Error(`L2 SWEEP unit exceeded ${cost} changed rows: ${delta}`);
        const reads = observer.metric().reads - unitReadStart;
        if (reads > 22) throw new Error(`L2 SWEEP read bound exceeded: ${reads}/22`);
        if (result.work > Number(delta))
          throw new Error(`L2 SWEEP changed-row accounting mismatch: ${delta}/${result.work}`);
        budget.work += Number(delta);
        phaseWork += Number(delta);
        budget.visits++;
        phaseVisits++;
        budget.laneUnits.sweep++;
        units++;
        if (result.useful) {
          phaseUseful++;
          turnTail.value = true;
        }
        laneReports.push({
          lane,
          reserved: cost,
          work: Number(delta),
          changedRows: Number(delta),
          visits: 1,
          units: 1,
          reads,
          mutationStatements: observer.metric().mutations - unitMetricStart.mutations,
          returnedRows: observer.metric().returnedRows - unitMetricStart.returnedRows,
        });
      } else {
        beginUnit(budget, lane, cost, maxVisits, phase);
        const result = reclaimLoveApiProofRows(db, nowMs, maxVisits);
        const delta = totalChanges(db) - unitChangesBefore;
        const work = result.bindingsDeleted + result.factsDeleted;
        const metadata = Number(delta) - work;
        if (result.visited > maxVisits)
          throw new Error(`L2 RECLAIM visit bound exceeded: ${result.visited}/${maxVisits}`);
        if (metadata < 0 || metadata > 2) throw new Error(`L2 reclaim metadata exceeded reservation: ${metadata}/2`);
        if (work > cost) throw new Error(`L2 RECLAIM unit exceeded ${cost} changed rows: ${work}`);
        const reads = observer.metric().reads - unitReadStart;
        if (reads > 24) throw new Error(`L2 RECLAIM read bound exceeded: ${reads}/24`);
        if (delta !== BigInt(work + metadata)) throw new Error(`L2 RECLAIM changed-row accounting mismatch: ${delta}`);
        budget.work += work;
        phaseWork += work;
        if (result.visited === 0 && work === 0) {
          budget.reserved -= cost;
          phase.writes -= cost;
          phase.visits -= maxVisits;
          stopped.add(lane);
          break;
        }
        phase.visits -= maxVisits - result.visited;
        budget.visits += result.visited;
        phaseVisits += result.visited;
        budget.laneUnits.reclaim++;
        units++;
        if (work > 0) {
          phaseUseful++;
          turnTail.value = true;
        }
        laneReports.push({
          lane,
          reserved: cost,
          work,
          changedRows: Number(delta),
          visits: result.visited,
          units: 1,
          reads,
          mutationStatements: observer.metric().mutations - unitMetricStart.mutations,
          returnedRows: observer.metric().returnedRows - unitMetricStart.returnedRows,
        });
      }
      const currentDelta = totalChanges(db) - invocationStart;
      assertLoveApiInvocationBudget(currentDelta, budget.visits);
      // One decision owns this entire transaction, including its final counters and
      // every total_changes() meter query. Never split the cap across a phase tail.
      if (lane === 'decision') break;
    }

    if (lane === 'sweep' && cursorState !== null && metaReserved > 0) {
      const changes = totalChanges(db);
      const updated = checkedUpdate(
        db,
        `UPDATE love_api_proof_state SET sweep_cursor=?,sweep_frontier=?,sweep_passes=?,updated_at_ms=?
         WHERE singleton=1 AND (sweep_cursor<>? OR sweep_frontier<>? OR sweep_passes<>?)`,
        cursorState.sweep_cursor,
        cursorState.sweep_frontier,
        cursorState.sweep_passes,
        nowMs,
        cursorState.sweep_cursor,
        cursorState.sweep_frontier,
        cursorState.sweep_passes,
      );
      const delta = totalChanges(db) - changes;
      if (updated > 1 || delta > 1n) throw new Error('L2 sweep cursor exceeded its metadata reservation');
      if (updated > 0) metaReserved++;
    }
    if (phaseUseful > 0) {
      const changes = totalChanges(db);
      countLinkCoverage(db, `api_love_maintenance_${lane}`);
      const delta = totalChanges(db) - changes;
      if (delta < 0n || delta > 1n) throw new Error('L2 coverage counter exceeded metadata reservation');
      metaReserved++;
    }
    const totalDelta = totalChanges(db) - changesBefore;
    const phaseMetadata = Number(totalDelta) - phaseWork;
    if (phaseMetadata < 0 || totalDelta !== BigInt(phaseWork + phaseMetadata))
      throw new Error(`L2 ${lane} phase accounting mismatch: ${totalDelta}/${phaseWork}/${phaseMetadata}`);
    const invocationDelta = totalChanges(db) - invocationStart;
    assertLoveApiInvocationBudget(invocationDelta, budget.visits);
    if (invocationDelta - BigInt(budget.work) > BigInt(LOVE_API_METADATA_RESERVE))
      throw new Error('L2 invocation metadata reserve exceeded');
    const turnReserve = turnTail.value ? 1 : 0;
    assertLoveApiInvocationBudget(invocationDelta + BigInt(turnReserve), budget.visits);
    if (Number(invocationDelta) - budget.work + turnReserve > LOVE_API_METADATA_RESERVE)
      throw new Error('L2 mandatory lane-turn metadata was not reserved');
    if (budget.visits > LOVE_API_VISITS) throw new Error('L2 invocation visit budget exceeded');
    if (lane === 'decision' && decisionLaneReport !== null && decisionUnitMetricStart !== null) {
      const completeReads = observer.metric().reads - decisionUnitMetricStart.reads;
      const completeChangedRows = totalChanges(db) - decisionUnitChangesBefore;
      assertLoveApiDecisionBudget(completeReads, completeChangedRows);
      decisionLaneReport.reads = completeReads;
      decisionLaneReport.changedRows = Number(completeChangedRows);
      decisionLaneReport.work = Number(completeChangedRows);
      laneReports.push(decisionLaneReport);
      // Include the changed-row meter read above in the same hard read boundary.
      const finalReads = observer.metric().reads - decisionUnitMetricStart.reads;
      assertLoveApiDecisionBudget(finalReads, completeChangedRows);
      decisionLaneReport.reads = finalReads;
    }
    const transactionMetricEnd = observer.metric();
    transactions.push({
      phase: `l2-${lane}`,
      reads: transactionMetricEnd.reads - transactionMetricStart.reads,
      mutationStatements: transactionMetricEnd.mutations - transactionMetricStart.mutations,
      changedRows: Number(totalDelta),
      returnedRows: transactionMetricEnd.returnedRows - transactionMetricStart.returnedRows,
      visits: phaseVisits,
    });
  });
  return { useful: phaseUseful > 0, units, visits: phaseVisits };
}

function updateLaneTurn(db: Db, nowMs: number, turn: number, budget: Budget, invocationStart: bigint): void {
  const before = totalChanges(db);
  const updated = checkedUpdate(
    db,
    'UPDATE love_api_proof_state SET lane_turn=?,updated_at_ms=? WHERE singleton=1 AND lane_turn<>?',
    (turn + 1) % 3,
    nowMs,
    (turn + 1) % 3,
  );
  const delta = totalChanges(db) - before;
  if (updated > 1 || delta > 1n) throw new Error('L2 lane turn exceeded its metadata reservation');
  const invocationDelta = totalChanges(db) - invocationStart;
  assertLoveApiInvocationBudget(invocationDelta, budget.visits);
  if (invocationDelta - BigInt(budget.work) > BigInt(LOVE_API_METADATA_RESERVE))
    throw new Error('L2 invocation metadata reserve exceeded before lane commit');
  budget.metadata += Number(delta);
}

/** Runs the three production L2 lanes under one measured invocation budget. */
export function runLoveApiMaintenance(
  db: Db,
  nowMs: number,
  random: Random,
  sessionToken: string,
  decisionReadProbe?: LoveApiDecisionReadProbe,
): LoveApiMaintenanceResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || sessionToken.length === 0)
    throw new RangeError('invalid L2 maintenance invocation');
  const observed = observedDb(db);
  const workDb = observed.db;
  const transactions: TransactionReport[] = [];
  const invocationStart = totalChanges(workDb);
  const initMetricStart = observed.metric();
  let initDelta = 0n;
  workDb.tx(() => {
    const initBefore = totalChanges(workDb);
    const changed = checkedUpdate(workDb, 'INSERT OR IGNORE INTO love_api_proof_state(singleton) VALUES(1)');
    initDelta = totalChanges(workDb) - initBefore;
    if (initDelta < 0n || initDelta > 1n || initDelta !== BigInt(changed))
      throw new Error('L2 singleton init exceeded reserve 1');
  });
  if (initDelta < 0n || initDelta > 1n) throw new Error('L2 singleton init exceeded reserve 1');
  const initMetricEnd = observed.metric();
  transactions.push({
    phase: 'l2-cold-singleton-init',
    reads: initMetricEnd.reads - initMetricStart.reads,
    mutationStatements: initMetricEnd.mutations - initMetricStart.mutations,
    changedRows: Number(initDelta),
    returnedRows: initMetricEnd.returnedRows - initMetricStart.returnedRows,
    visits: 0,
  });
  const initial = readLaneState(workDb);
  const budget: Budget = {
    reserved: 0,
    work: 0,
    metadata: Number(initDelta),
    visits: 0,
    laneUnits: { decision: 0, sweep: 0, reclaim: 0 },
  };
  const decisions: LoveApiMaintenanceResult['decisions'] = {
    queued: 0,
    deferred: 0,
    replay: 0,
    refused: 0,
    awaiting: 0,
    expired: 0,
  };
  const lanes: LaneReport[] = [];
  const stopped = new Set<Lane>();
  const turnTail = { value: false };
  let useful = false;
  const order: Lane[] = ['decision', 'sweep', 'reclaim'];
  for (const phase of ['guaranteed', 'leftover'] as const) {
    for (let offset = 0; offset < order.length; offset++) {
      const lane = order[(initial.lane_turn + offset) % order.length]!;
      const writesLimit =
        phase === 'guaranteed' ? LOVE_API_LANE_GUARANTEE_WRITES : LOVE_API_UNIT_BUDGET - budget.reserved;
      const visitsLimit = phase === 'guaranteed' ? LOVE_API_LANE_GUARANTEE_VISITS : LOVE_API_VISITS - budget.visits;
      if (writesLimit <= 0 || visitsLimit < 0) continue;
      const report = runLanePhase(
        workDb,
        lane,
        nowMs,
        random,
        sessionToken,
        budget,
        invocationStart,
        lanes,
        decisions,
        stopped,
        writesLimit,
        visitsLimit,
        observed,
        transactions,
        turnTail,
        decisionReadProbe,
      );
      useful ||= report.useful;
    }
  }
  if (useful) {
    const beforeTurn = totalChanges(workDb) - invocationStart;
    assertLoveApiInvocationBudget(beforeTurn + 1n, budget.visits);
    if (Number(beforeTurn) - budget.work + 1 > LOVE_API_METADATA_RESERVE)
      throw new Error('L2 mandatory lane-turn metadata reservation exceeded before commit');
    const changeStart = totalChanges(workDb);
    const metricStart = observed.metric();
    workDb.tx(() => updateLaneTurn(workDb, nowMs, initial.lane_turn, budget, invocationStart));
    const metricEnd = observed.metric();
    transactions.push({
      phase: 'l2-lane-turn',
      reads: metricEnd.reads - metricStart.reads,
      mutationStatements: metricEnd.mutations - metricStart.mutations,
      changedRows: Number(totalChanges(workDb) - changeStart),
      returnedRows: metricEnd.returnedRows - metricStart.returnedRows,
      visits: 0,
    });
  }
  const writeDelta = totalChanges(workDb) - invocationStart;
  assertLoveApiInvocationBudget(writeDelta, budget.visits);
  const actualMetadata = Number(writeDelta) - budget.work;
  if (actualMetadata < 0 || actualMetadata > LOVE_API_METADATA_RESERVE)
    throw new Error(`L2 invocation metadata reserve exceeded: ${actualMetadata}/12`);
  const metric = observed.metric();
  return {
    useful,
    wakeMs: useful ? LOVE_API_ACTIVE_MS : LOVE_API_QUIET_MS,
    writes: Number(writeDelta),
    visits: budget.visits,
    reads: metric.reads,
    mutationStatements: metric.mutations,
    returnedRows: metric.returnedRows,
    decisions,
    sweepUnits: budget.laneUnits.sweep,
    reclaimUnits: budget.laneUnits.reclaim,
    lanes,
    transactions,
  };
}
