import type { Db } from '../do/db';
import { countLinkCoverage } from './coverage';
import { allocateDeferredAuthoritySequence, hasAuthorityDependency } from './love-coverage-authority';
import { allocateDeferredSequence, armLoveCoverage } from './love-deferral-storage';
import { deferredIntentBarrier, deferredIntentValid } from './love-intent-policy';

export const LOVE_MAINTENANCE_WRITES = 128;
export const LOVE_MAINTENANCE_METADATA_RESERVE = 18;
export const LOVE_MAINTENANCE_UNIT_BUDGET = LOVE_MAINTENANCE_WRITES - LOVE_MAINTENANCE_METADATA_RESERVE;
export const LOVE_MAINTENANCE_LANE_ALLOWANCE = 22;
export const LOVE_MAINTENANCE_VISITS = 16;
export const LOVE_MAINTENANCE_K = 16;
export const LOVE_MAINTENANCE_WIT_STEPS = 4;
export const LOVE_MAINTENANCE_ACTIVE_MS = 1_000;
export const LOVE_MAINTENANCE_QUIET_MS = 30_000;

export type LoveMaintenanceLane = 'inv' | 'due' | 'rr' | 'wit' | 'auth';
type Lane = LoveMaintenanceLane;
interface LaneResult {
  useful: boolean;
  visited: number;
  writes?: number;
  steps?: number;
  work?: number;
}
interface Singleton {
  lane_turn: number;
  next_head_seq: string;
  next_group_seq: string;
  next_authority_seq: string;
  rr_cursor: string;
  rr_frontier: string;
  wit_cursor: string;
  wit_frontier: string;
  wit_state: 'scan' | 'pruning';
  wit_link_id: string;
  wit_generation: number;
  auth_cursor: string;
  auth_frontier: string;
  rr_passes: string;
  wit_passes: string;
  auth_passes: string;
}
interface Head {
  link_id: string;
  generation: number;
  love_artist_key: string;
  love_track_key: string;
  head_seq: number;
  next_seq: number;
  live_from_seq: number;
  armed_seq: number | null;
  maintenance_seq: number | null;
  decided_seq: number | null;
  scan_seq: number | null;
}
interface Intent {
  intent_seq: number;
  operation_id: string;
  origin_class: 'operation' | 'authorized' | 'live_love' | 'unclassified';
  authorization_uri: string | null;
  authorization_rev: string | null;
}

export const INV_AUTHORITY_SEEK_SQL = `SELECT link_id,generation,love_artist_key,love_track_key,intent_seq,operation_id,
       origin_class,authorization_uri,authorization_rev
     FROM forward_deferred_love_intents INDEXED BY forward_deferred_love_intents_authorization
     WHERE authorization_uri=? AND authorization_rev=? AND (link_id,generation,operation_id)>(?,?,?)
     ORDER BY link_id,generation,operation_id LIMIT 1`;
export const INV_AUTHORITY_MORE_SQL = `SELECT 1 FROM forward_deferred_love_intents INDEXED BY forward_deferred_love_intents_authorization
       WHERE authorization_uri=? AND authorization_rev=? AND (link_id,generation,operation_id)>(?,?,?) LIMIT 1`;

function asSafeInt(value: string | number, label: string, min = 0): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new RangeError(`deferred love ${label} is not an integer`);
  }
  if (parsed < BigInt(min) || parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`deferred love ${label} is outside safe integer range`);
  return Number(parsed);
}

function safeSuccessor(value: string, label: string): number {
  const current = asSafeInt(value, label);
  if (current === Number.MAX_SAFE_INTEGER) throw new RangeError(`deferred love ${label} successor is unsafe`);
  return current + 1;
}

function readSingleton(db: Db): Singleton {
  const row = db.one<Singleton>(
    `SELECT lane_turn,CAST(next_head_seq AS TEXT) AS next_head_seq,CAST(next_group_seq AS TEXT) AS next_group_seq,
       CAST(next_authority_seq AS TEXT) AS next_authority_seq,CAST(rr_cursor AS TEXT) AS rr_cursor,
       CAST(rr_frontier AS TEXT) AS rr_frontier,CAST(wit_cursor AS TEXT) AS wit_cursor,
       CAST(wit_frontier AS TEXT) AS wit_frontier,wit_state,wit_link_id,wit_generation,
       CAST(auth_cursor AS TEXT) AS auth_cursor,CAST(auth_frontier AS TEXT) AS auth_frontier,
       CAST(rr_passes AS TEXT) AS rr_passes,CAST(wit_passes AS TEXT) AS wit_passes,CAST(auth_passes AS TEXT) AS auth_passes
     FROM forward_deferred_love_maintenance WHERE singleton=1`,
  );
  if (row === null) throw new Error('deferred love maintenance singleton missing');
  asSafeInt(row.lane_turn, 'lane turn');
  asSafeInt(row.next_head_seq, 'next head sequence', 1);
  asSafeInt(row.next_group_seq, 'next group sequence', 1);
  asSafeInt(row.next_authority_seq, 'next authority sequence', 1);
  asSafeInt(row.rr_cursor, 'RR cursor');
  asSafeInt(row.rr_frontier, 'RR frontier');
  asSafeInt(row.wit_cursor, 'WIT cursor');
  asSafeInt(row.wit_frontier, 'WIT frontier');
  asSafeInt(row.wit_generation, 'WIT generation');
  asSafeInt(row.auth_cursor, 'AUTH cursor');
  asSafeInt(row.auth_frontier, 'AUTH frontier');
  asSafeInt(row.rr_passes, 'RR passes');
  asSafeInt(row.wit_passes, 'WIT passes');
  asSafeInt(row.auth_passes, 'AUTH passes');
  if (!Number.isInteger(row.lane_turn) || row.lane_turn > 4) throw new RangeError('deferred love lane turn is invalid');
  return row;
}

function intentInvalid(db: Db, row: Intent): boolean {
  return !deferredIntentValid(db, row);
}

function currentGeneration(db: Db, linkId: string): number | null {
  return (
    db.one<{ generation: number }>('SELECT generation FROM linked_accounts WHERE id=?', linkId)?.generation ?? null
  );
}

function intentRows(
  db: Db,
  head: Head,
  predicate: string,
  args: readonly (string | number)[],
  limit: number,
): Intent[] {
  return db.all<Intent>(
    `SELECT intent_seq,operation_id,origin_class,authorization_uri,authorization_rev FROM forward_deferred_love_intents
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND ${predicate}
     ORDER BY intent_seq LIMIT ?`,
    head.link_id,
    head.generation,
    head.love_artist_key,
    head.love_track_key,
    ...args,
    limit,
  );
}

function newestIntents(
  db: Db,
  head: Head,
  predicate: string,
  args: readonly (string | number)[],
  limit: number,
): Intent[] {
  return db.all<Intent>(
    `SELECT intent_seq,operation_id,origin_class,authorization_uri,authorization_rev FROM forward_deferred_love_intents
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND ${predicate}
     ORDER BY intent_seq DESC LIMIT ?`,
    head.link_id,
    head.generation,
    head.love_artist_key,
    head.love_track_key,
    ...args,
    limit,
  );
}

function deleteIntents(db: Db, head: Head, rows: readonly Intent[]): number {
  let removed = 0;
  for (const row of rows)
    removed += db.run(
      `DELETE FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND intent_seq=?`,
      head.link_id,
      head.generation,
      head.love_artist_key,
      head.love_track_key,
      row.intent_seq,
    ).rowsWritten;
  return removed;
}

function headExistsChild(db: Db, head: Head): boolean {
  return (
    db.one(
      'SELECT 1 AS present FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? LIMIT 1',
      head.link_id,
      head.generation,
      head.love_artist_key,
      head.love_track_key,
    ) !== null
  );
}

function readHead(db: Db, linkId: string, generation: number, artist: string, track: string): Head | null {
  const row = db.one<{
    link_id: string;
    generation: number;
    love_artist_key: string;
    love_track_key: string;
    head_seq: string;
    next_seq: string;
    live_from_seq: string;
    armed_seq: string | null;
    maintenance_seq: string | null;
    decided_seq: string | null;
    scan_seq: string | null;
  }>(
    `SELECT link_id,generation,love_artist_key,love_track_key,CAST(head_seq AS TEXT) AS head_seq,
       CAST(next_seq AS TEXT) AS next_seq,CAST(live_from_seq AS TEXT) AS live_from_seq,
       CAST(armed_seq AS TEXT) AS armed_seq,CAST(maintenance_seq AS TEXT) AS maintenance_seq,
       CAST(decided_seq AS TEXT) AS decided_seq,CAST(scan_seq AS TEXT) AS scan_seq
     FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    linkId,
    generation,
    artist,
    track,
  );
  return row === null
    ? null
    : {
        link_id: row.link_id,
        generation: row.generation,
        love_artist_key: row.love_artist_key,
        love_track_key: row.love_track_key,
        head_seq: asSafeInt(row.head_seq, 'head sequence', 1),
        next_seq: asSafeInt(row.next_seq, 'next intent sequence', 1),
        live_from_seq: asSafeInt(row.live_from_seq, 'live floor', 1),
        armed_seq: row.armed_seq === null ? null : asSafeInt(row.armed_seq, 'armed sequence', 1),
        maintenance_seq:
          row.maintenance_seq === null ? null : asSafeInt(row.maintenance_seq, 'maintenance sequence', 1),
        decided_seq: row.decided_seq === null ? null : asSafeInt(row.decided_seq, 'decision sequence', 1),
        scan_seq: row.scan_seq === null ? null : asSafeInt(row.scan_seq, 'scan sequence', 1),
      };
}

function runInv(db: Db): LaneResult {
  const authority = db.one<{
    authorization_uri: string;
    authorization_rev: string;
    cursor_link_id: string;
    cursor_generation: number;
    cursor_operation_id: string;
  }>(
    `SELECT authorization_uri,authorization_rev,cursor_link_id,cursor_generation,cursor_operation_id
     FROM forward_deferred_love_authorities WHERE state='conflicted' AND due_seq IS NOT NULL ORDER BY due_seq,authority_seq LIMIT 1`,
  );
  if (authority === null) return { useful: false, visited: 0 };
  const rows = db.all<
    Intent & { link_id: string; generation: number; love_artist_key: string; love_track_key: string }
  >(
    INV_AUTHORITY_SEEK_SQL,
    authority.authorization_uri,
    authority.authorization_rev,
    authority.cursor_link_id,
    authority.cursor_generation,
    authority.cursor_operation_id,
  );
  let useful = false;
  let visited = 0;
  let last: (typeof rows)[number] | undefined;
  if (rows[0] !== undefined) {
    const row = rows[0];
    last = row;
    visited = 1;
    const head = readHead(db, row.link_id, row.generation, row.love_artist_key, row.love_track_key);
    db.run(
      `DELETE FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND operation_id=?`,
      row.link_id,
      row.generation,
      row.operation_id,
    );
    if (
      head !== null &&
      row.generation === currentGeneration(db, row.link_id) &&
      row.intent_seq >= head.live_from_seq
    ) {
      if (armLoveCoverage(db, { id: row.link_id, generation: row.generation }, row.love_artist_key, row.love_track_key))
        useful = true;
    }
    if (head !== null && !headExistsChild(db, head)) {
      db.run(
        'DELETE FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
        row.link_id,
        row.generation,
        row.love_artist_key,
        row.love_track_key,
      );
      useful = true;
    }
    useful = true;
  }
  const more =
    last !== undefined &&
    db.one(
      INV_AUTHORITY_MORE_SQL,
      authority.authorization_uri,
      authority.authorization_rev,
      last.link_id,
      last.generation,
      last.operation_id,
    ) !== null;
  if (!more && !hasAuthorityDependency(db, authority.authorization_uri, authority.authorization_rev)) {
    db.run(
      "DELETE FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=? AND state='conflicted'",
      authority.authorization_uri,
      authority.authorization_rev,
    );
    useful = true;
  } else {
    const due = allocateDeferredAuthoritySequence(db);
    db.run(
      `UPDATE forward_deferred_love_authorities SET cursor_link_id=?,cursor_generation=?,cursor_operation_id=?,due_seq=?
       WHERE authorization_uri=? AND authorization_rev=?`,
      more ? (last?.link_id ?? '') : '',
      more ? (last?.generation ?? 0) : 0,
      more ? (last?.operation_id ?? '') : '',
      due,
      authority.authorization_uri,
      authority.authorization_rev,
    );
  }
  return { useful, visited };
}

function runDue(db: Db): LaneResult {
  const raw = db.one<Pick<Head, 'link_id' | 'generation' | 'love_artist_key' | 'love_track_key'>>(
    `SELECT link_id,generation,love_artist_key,love_track_key
     FROM forward_deferred_love_heads WHERE maintenance_seq IS NOT NULL ORDER BY maintenance_seq,head_seq LIMIT 1`,
  );
  if (raw === null) return { useful: false, visited: 0 };
  const head = readHead(db, raw.link_id, raw.generation, raw.love_artist_key, raw.love_track_key);
  if (head === null) return { useful: false, visited: 0 };
  let useful = false;
  let deleted = 0;
  const generation = currentGeneration(db, head.link_id);
  const old = generation === null || generation > head.generation;
  if (old) {
    const rows = intentRows(db, head, '1=1', [], LOVE_MAINTENANCE_K);
    deleted += deleteIntents(db, head, rows);
    useful ||= deleted > 0;
    if (rows.length < LOVE_MAINTENANCE_K) {
      db.run(
        'DELETE FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
        head.link_id,
        head.generation,
        head.love_artist_key,
        head.love_track_key,
      );
      useful = true;
    } else {
      const next = allocateDeferredSequence(db, 'next_head_seq');
      db.run(
        `UPDATE forward_deferred_love_heads SET maintenance_seq=? WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
        next,
        head.link_id,
        head.generation,
        head.love_artist_key,
        head.love_track_key,
      );
    }
    return { useful, visited: 1 };
  }

  const below = intentRows(db, head, 'intent_seq<?', [head.live_from_seq], LOVE_MAINTENANCE_K);
  deleted += deleteIntents(db, head, below);
  let remaining = LOVE_MAINTENANCE_K - deleted;
  if (remaining > 0) {
    const top = newestIntents(db, head, 'intent_seq>=?', [head.live_from_seq], TOP_LIMIT);
    const invalid = top.filter((row) => intentInvalid(db, row)).slice(0, remaining);
    deleted += deleteIntents(db, head, invalid);
    remaining = LOVE_MAINTENANCE_K - deleted;
  }
  useful ||= deleted > 0;
  const current = readHead(db, head.link_id, head.generation, head.love_artist_key, head.love_track_key);
  if (current === null) return { useful, visited: 1 };
  const top = newestIntents(db, current, 'intent_seq>=?', [current.live_from_seq], TOP_LIMIT);
  let newest: Intent | null = null;
  let barrier: Intent | null = null;
  for (const row of top) {
    if (intentInvalid(db, row)) continue;
    newest ??= row;
    if (deferredIntentBarrier(db, row)) barrier ??= row;
  }
  let floor = current.live_from_seq;
  if (barrier !== null) floor = Math.max(floor, barrier.intent_seq);
  const shouldArm = newest !== null && current.armed_seq === null && newest.intent_seq !== current.decided_seq;
  if (
    shouldArm &&
    armLoveCoverage(
      db,
      { id: current.link_id, generation: current.generation },
      current.love_artist_key,
      current.love_track_key,
    )
  )
    useful = true;
  if (floor === current.next_seq && !headExistsChild(db, current)) {
    db.run(
      'DELETE FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
      current.link_id,
      current.generation,
      current.love_artist_key,
      current.love_track_key,
    );
    useful = true;
    return { useful, visited: 1 };
  }
  const moreBelow =
    db.one(
      'SELECT 1 FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND intent_seq<? LIMIT 1',
      current.link_id,
      current.generation,
      current.love_artist_key,
      current.love_track_key,
      floor,
    ) !== null;
  const requeue = moreBelow || remaining === 0;
  const maintenance = requeue ? allocateDeferredSequence(db, 'next_head_seq') : null;
  db.run(
    `UPDATE forward_deferred_love_heads SET live_from_seq=?,maintenance_seq=?
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    floor,
    maintenance,
    current.link_id,
    current.generation,
    current.love_artist_key,
    current.love_track_key,
  );
  if (floor !== current.live_from_seq) useful = true;
  return { useful, visited: 1 };
}

const TOP_LIMIT = 17;

function runRr(db: Db, state = readSingleton(db)): LaneResult {
  const cursor = asSafeInt(state.rr_cursor, 'RR cursor');
  const frontier = asSafeInt(state.rr_frontier, 'RR frontier');
  const next = asSafeInt(state.next_head_seq, 'next head sequence', 1);
  const row = db.one<
    Pick<Head, 'link_id' | 'generation' | 'love_artist_key' | 'love_track_key'> & { head_seq: string }
  >(
    `SELECT link_id,generation,love_artist_key,love_track_key,CAST(head_seq AS TEXT) AS head_seq
     FROM forward_deferred_love_heads WHERE head_seq>? AND head_seq<=? ORDER BY forward_deferred_love_heads.head_seq LIMIT 1`,
    cursor,
    frontier,
  );
  if (row === null) {
    if (cursor === 0 && frontier === next - 1) return { useful: false, visited: 0 };
    state.rr_cursor = '0';
    state.rr_frontier = String(next - 1);
    state.rr_passes = String(safeSuccessor(state.rr_passes, 'RR passes'));
    return { useful: false, visited: 0 };
  }
  const head = readHead(db, row.link_id, row.generation, row.love_artist_key, row.love_track_key);
  if (head === null) return { useful: false, visited: 1 };
  let useful = false;
  const generation = currentGeneration(db, head.link_id);
  if (generation === null || generation > head.generation) {
    if (head.maintenance_seq === null) {
      db.run(
        `UPDATE forward_deferred_love_heads SET maintenance_seq=head_seq WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
        head.link_id,
        head.generation,
        head.love_artist_key,
        head.love_track_key,
      );
      useful = true;
    }
  } else {
    const scanBefore = head.scan_seq ?? head.next_seq;
    const rows = newestIntents(
      db,
      head,
      'intent_seq>=? AND intent_seq<?',
      [head.live_from_seq, scanBefore],
      LOVE_MAINTENANCE_K,
    );
    const invalid = rows.filter((item) => intentInvalid(db, item));
    if (deleteIntents(db, head, invalid) > 0) useful = true;
    if (!headExistsChild(db, head)) {
      db.run(
        'DELETE FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
        head.link_id,
        head.generation,
        head.love_artist_key,
        head.love_track_key,
      );
      useful = true;
    }
    const validRows = rows.filter((item) => !intentInvalid(db, item));
    const barrier = validRows.find((item) => deferredIntentBarrier(db, item));
    const floor = barrier === undefined ? head.live_from_seq : Math.max(head.live_from_seq, barrier.intent_seq);
    const first = validRows[0];
    const top = newestIntents(db, head, 'intent_seq>=?', [floor], TOP_LIMIT);
    const newest = top.find((item) => !intentInvalid(db, item));
    const shouldArm = newest !== undefined && head.armed_seq === null && newest.intent_seq !== head.decided_seq;
    if (
      shouldArm &&
      armLoveCoverage(db, { id: head.link_id, generation: head.generation }, head.love_artist_key, head.love_track_key)
    )
      useful = true;
    const minRead = rows.at(-1)?.intent_seq;
    const scanSeq = minRead !== undefined && minRead > head.live_from_seq ? minRead : null;
    db.run(
      `UPDATE forward_deferred_love_heads SET live_from_seq=?,scan_seq=?,maintenance_seq=CASE WHEN ? THEN coalesce(maintenance_seq,head_seq) ELSE maintenance_seq END
       WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
      floor,
      scanSeq,
      floor > head.live_from_seq ? 1 : 0,
      head.link_id,
      head.generation,
      head.love_artist_key,
      head.love_track_key,
    );
    if (floor > head.live_from_seq) useful = true;
    void first;
  }
  state.rr_cursor = String(asSafeInt(row.head_seq, 'RR head sequence', 1));
  return { useful, visited: 1 };
}

function runWit(db: Db, state = readSingleton(db)): LaneResult {
  const cursor = asSafeInt(state.wit_cursor, 'WIT cursor');
  const frontier = asSafeInt(state.wit_frontier, 'WIT frontier');
  const next = asSafeInt(state.next_group_seq, 'next group sequence', 1);
  if (state.wit_state === 'pruning') {
    const removed = db.run(
      `DELETE FROM forward_deferred_love_witnesses WHERE rowid IN (
         SELECT rowid FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? ORDER BY operation_id LIMIT ?
       )`,
      state.wit_link_id,
      state.wit_generation,
      LOVE_MAINTENANCE_K,
    ).rowsWritten;
    const finished = removed < LOVE_MAINTENANCE_K;
    state.wit_state = finished ? 'scan' : 'pruning';
    state.wit_link_id = finished ? '' : state.wit_link_id;
    state.wit_generation = finished ? 0 : state.wit_generation;
    return { useful: removed > 0, visited: 0, steps: 1, work: removed };
  }
  const group = db.one<{ group_seq: string; link_id: string; generation: number }>(
    `SELECT CAST(group_seq AS TEXT) AS group_seq,link_id,generation FROM forward_deferred_love_witnesses INDEXED BY forward_deferred_love_witnesses_group
     WHERE group_seq>? AND group_seq<=? ORDER BY forward_deferred_love_witnesses.group_seq,forward_deferred_love_witnesses.link_id,forward_deferred_love_witnesses.generation LIMIT 1`,
    cursor,
    frontier,
  );
  if (group === null) {
    if (cursor === 0 && frontier === next - 1) return { useful: false, visited: 0 };
    state.wit_cursor = '0';
    state.wit_frontier = String(next - 1);
    state.wit_passes = String(safeSuccessor(state.wit_passes, 'WIT passes'));
    return { useful: false, visited: 0, steps: 1, work: 1 };
  }
  const groupSeq = asSafeInt(group.group_seq, 'WIT group sequence', 1);
  const current = currentGeneration(db, group.link_id);
  if (current === null || group.generation < current) {
    state.wit_state = 'pruning';
    state.wit_cursor = String(groupSeq);
    state.wit_link_id = group.link_id;
    state.wit_generation = group.generation;
    return { useful: false, visited: 0, steps: 1, work: 1 };
  }
  state.wit_cursor = String(groupSeq);
  return { useful: false, visited: 0, steps: 1, work: 1 };
}

function runAuth(db: Db, state = readSingleton(db)): LaneResult {
  const cursor = asSafeInt(state.auth_cursor, 'AUTH cursor');
  const frontier = asSafeInt(state.auth_frontier, 'AUTH frontier');
  const next = asSafeInt(state.next_authority_seq, 'next authority sequence', 1);
  const rows = db.all<{ authorization_uri: string; authorization_rev: string; authority_seq: string; state: string }>(
    `SELECT authorization_uri,authorization_rev,CAST(authority_seq AS TEXT) AS authority_seq,state FROM forward_deferred_love_authorities
     WHERE authority_seq>? AND authority_seq<=? ORDER BY forward_deferred_love_authorities.authority_seq LIMIT 8`,
    cursor,
    frontier,
  );
  if (rows.length === 0) {
    if (cursor === 0 && frontier === next - 1) return { useful: false, visited: 0 };
    state.auth_cursor = '0';
    state.auth_frontier = String(next - 1);
    state.auth_passes = String(safeSuccessor(state.auth_passes, 'AUTH passes'));
    return { useful: false, visited: 0 };
  }
  let useful = false;
  for (const row of rows) {
    if (row.state !== 'active' || hasAuthorityDependency(db, row.authorization_uri, row.authorization_rev)) continue;
    db.run(
      "DELETE FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=? AND state='active'",
      row.authorization_uri,
      row.authorization_rev,
    );
    useful = true;
  }
  state.auth_cursor = String(asSafeInt(rows.at(-1)!.authority_seq, 'AUTH sequence', 1));
  return { useful, visited: 0, work: rows.length };
}

export const LOVE_MAINTENANCE_UNIT_COSTS: Readonly<Record<LoveMaintenanceLane, number>> = {
  inv: 10,
  due: 19,
  rr: 21,
  wit: 16,
  auth: 8,
};
const UNIT_COST: Record<Lane, number> = { ...LOVE_MAINTENANCE_UNIT_COSTS };
const LANE_UNITS: Record<Lane, number> = { inv: 16, due: 5, rr: 5, wit: 4, auth: 13 };
const LANES: readonly Lane[] = ['inv', 'due', 'rr', 'wit', 'auth'];
const CURSOR_COLUMNS = [
  'rr_cursor',
  'rr_frontier',
  'rr_passes',
  'wit_cursor',
  'wit_frontier',
  'wit_state',
  'wit_link_id',
  'wit_generation',
  'wit_passes',
  'auth_cursor',
  'auth_frontier',
  'auth_passes',
] as const;

function cursorSignature(state: Singleton): string {
  return CURSOR_COLUMNS.map((column) => state[column]).join('\0');
}

function totalChanges(db: Db): bigint {
  const value = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (value === undefined) throw new Error('SQLite change counter unavailable');
  return BigInt(value);
}

function laneStep(db: Db, lane: Lane, state: Singleton): LaneResult {
  return lane === 'inv'
    ? runInv(db)
    : lane === 'due'
      ? runDue(db)
      : lane === 'rr'
        ? runRr(db, state)
        : lane === 'wit'
          ? runWit(db, state)
          : runAuth(db, state);
}

interface SchedulerBudget {
  unitWrites: number;
  visits: number;
  witSteps: number;
  laneUnits: Record<Lane, number>;
  metadataWrites: number;
}

function executeLanePhase(
  db: Db,
  lane: Lane,
  now: number,
  allowance: number,
  budget: SchedulerBudget,
  perVisitWrites: number[],
  unitCosts: { lane: Lane; reserved: number; work: number; actual: number }[],
  stoppedLanes: Set<Lane>,
): { useful: boolean; actualWrites: number } {
  let useful = false;
  let phaseCost = 0;
  const metadataBefore = budget.metadataWrites;
  const beforePhase = totalChanges(db);
  db.tx(() => {
    const cursor = readSingleton(db);
    while (
      budget.laneUnits[lane] < LANE_UNITS[lane] &&
      budget.unitWrites + UNIT_COST[lane] <= LOVE_MAINTENANCE_UNIT_BUDGET &&
      phaseCost + UNIT_COST[lane] <= allowance &&
      (lane === 'wit'
        ? budget.witSteps < LOVE_MAINTENANCE_WIT_STEPS
        : lane === 'auth'
          ? true
          : budget.visits < LOVE_MAINTENANCE_VISITS)
    ) {
      const reservation = UNIT_COST[lane];
      // Reserve the conservative unit charge before running SQL that can mutate.
      phaseCost += reservation;
      budget.unitWrites += reservation;
      const beforeCursor = cursorSignature(cursor);
      const beforeUnit = totalChanges(db);
      const result = laneStep(db, lane, cursor);
      const delta = totalChanges(db) - beforeUnit;
      if (delta < 0n || delta > BigInt(reservation))
        throw new Error(`deferred love ${lane} unit exceeded reserved cost ${reservation}: ${delta}`);
      const actual = Number(delta);
      const work = Math.max(actual, result.work ?? 0);
      if (work > reservation)
        throw new Error(`deferred love ${lane} unit exceeded reserved work ${reservation}: ${work}`);
      const cursorProgress = cursorSignature(cursor) !== beforeCursor;
      phaseCost -= reservation - work;
      budget.unitWrites -= reservation - work;
      if (result.visited === 0 && (result.steps ?? 0) === 0 && actual === 0 && !cursorProgress) {
        stoppedLanes.add(lane);
        break;
      }
      unitCosts.push({ lane, reserved: reservation, work, actual });
      budget.laneUnits[lane]++;
      budget.visits += result.visited;
      budget.witSteps += result.steps ?? 0;
      if (result.visited > 0) perVisitWrites.push(actual);
      useful ||= result.useful;
      if (budget.visits > LOVE_MAINTENANCE_VISITS || budget.witSteps > LOVE_MAINTENANCE_WIT_STEPS)
        throw new Error(
          `deferred love maintenance visit budget exceeded (${budget.visits}/${budget.witSteps}, ${lane}, ${result.visited}/${result.steps ?? 0})`,
        );
    }
    if (cursorSignature(cursor) !== cursorSignature(readSingleton(db))) {
      const assignments = CURSOR_COLUMNS.map((column) => `${column}=?`).join(',');
      const params = CURSOR_COLUMNS.map((column) => cursor[column]);
      const changed = db.run(
        `UPDATE forward_deferred_love_maintenance SET ${assignments},updated_at_ms=? WHERE singleton=1`,
        ...params,
        now,
      ).rowsWritten;
      budget.metadataWrites += changed;
    }
    // One lane counter per lane transaction. No-op phases do not create rows.
    if (useful) {
      countLinkCoverage(db, `deferred_maintenance_${lane}`);
      budget.metadataWrites++;
    }
    if (budget.metadataWrites > LOVE_MAINTENANCE_METADATA_RESERVE)
      throw new Error('deferred love metadata reserve exceeded');
    const totalDelta = totalChanges(db) - beforePhase;
    const metadataAdded = budget.metadataWrites - metadataBefore;
    if (totalDelta < 0n || totalDelta > BigInt(allowance + metadataAdded))
      throw new Error(`deferred love ${lane} phase exceeded allowance ${allowance}: ${totalDelta}`);
  });
  const actualWrites = Number(totalChanges(db) - beforePhase);
  if (actualWrites < 0 || !Number.isSafeInteger(actualWrites))
    throw new RangeError('deferred love lane write count is unsafe');
  return { useful, actualWrites };
}

export interface LoveMaintenanceResult {
  useful: boolean;
  wakeMs: number;
  writes: number;
  perVisitWrites: number[];
  unitCosts: { lane: LoveMaintenanceLane; reserved: number; work: number; actual: number }[];
  visits: number;
  witSteps: number;
}

/** Runs a rotated guaranteed phase, then shares its unused allowance in a second rotated phase. */
export function runDeferredLoveMaintenance(db: Db, now: number): LoveMaintenanceResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('maintenance time must be safe epoch milliseconds');
  const beforeChanges = totalChanges(db);
  const inserted = db.tx(
    () => db.run('INSERT OR IGNORE INTO forward_deferred_love_maintenance(singleton) VALUES(1)').rowsWritten,
  );
  if (inserted > 0)
    return {
      useful: false,
      wakeMs: LOVE_MAINTENANCE_QUIET_MS,
      writes: Number(totalChanges(db) - beforeChanges),
      perVisitWrites: [],
      unitCosts: [],
      visits: 0,
      witSteps: 0,
    };
  const before = readSingleton(db);
  const budget: SchedulerBudget = {
    unitWrites: 0,
    visits: 0,
    witSteps: 0,
    laneUnits: { inv: 0, due: 0, rr: 0, wit: 0, auth: 0 },
    metadataWrites: 0,
  };
  let useful = false;
  const perVisitWrites: number[] = [];
  const unitCosts: { lane: Lane; reserved: number; work: number; actual: number }[] = [];
  const stoppedLanes = new Set<Lane>();
  for (const allowance of [LOVE_MAINTENANCE_LANE_ALLOWANCE, LOVE_MAINTENANCE_UNIT_BUDGET]) {
    for (let index = 0; index < LANES.length; index++) {
      const lane = LANES[(before.lane_turn + index) % LANES.length]!;
      if (stoppedLanes.has(lane)) continue;
      const phaseAllowance =
        allowance === LOVE_MAINTENANCE_LANE_ALLOWANCE
          ? LOVE_MAINTENANCE_LANE_ALLOWANCE
          : LOVE_MAINTENANCE_UNIT_BUDGET - budget.unitWrites;
      if (phaseAllowance <= 0) break;
      const result = executeLanePhase(db, lane, now, phaseAllowance, budget, perVisitWrites, unitCosts, stoppedLanes);
      useful ||= result.useful;
    }
  }
  if (useful)
    db.tx(() => {
      const writes = db.run(
        'UPDATE forward_deferred_love_maintenance SET lane_turn=?,updated_at_ms=? WHERE singleton=1',
        (before.lane_turn + 1) % LANES.length,
        now,
      ).rowsWritten;
      budget.metadataWrites += writes;
      if (budget.metadataWrites > 18) throw new Error('deferred love metadata reserve exceeded');
    });
  const writeDelta = totalChanges(db) - beforeChanges;
  if (writeDelta < 0n || writeDelta > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('deferred love write count is unsafe');
  const writes = Number(writeDelta);
  return {
    useful,
    wakeMs: useful ? LOVE_MAINTENANCE_ACTIVE_MS : LOVE_MAINTENANCE_QUIET_MS,
    writes,
    perVisitWrites,
    unitCosts,
    visits: budget.visits,
    witSteps: budget.witSteps,
  };
}
