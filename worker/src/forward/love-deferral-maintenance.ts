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

type Lane = 'inv' | 'due' | 'rr' | 'wit' | 'auth';
interface LaneResult {
  useful: boolean;
  visited: number;
  writes?: number;
  steps?: number;
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
    `SELECT link_id,generation,love_artist_key,love_track_key,intent_seq,operation_id,origin_class,authorization_uri,authorization_rev
     FROM forward_deferred_love_intents INDEXED BY forward_deferred_love_intents_authorization
     WHERE authorization_uri=? AND authorization_rev=?
       AND (link_id>? OR (link_id=? AND generation>?) OR (link_id=? AND generation=? AND operation_id>?))
     ORDER BY link_id,generation,operation_id LIMIT 1`,
    authority.authorization_uri,
    authority.authorization_rev,
    authority.cursor_link_id,
    authority.cursor_link_id,
    authority.cursor_generation,
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
      `SELECT 1 FROM forward_deferred_love_intents INDEXED BY forward_deferred_love_intents_authorization
       WHERE authorization_uri=? AND authorization_rev=?
         AND (link_id>? OR (link_id=? AND generation>?) OR (link_id=? AND generation=? AND operation_id>?)) LIMIT 1`,
      authority.authorization_uri,
      authority.authorization_rev,
      last.link_id,
      last.link_id,
      last.generation,
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

function runRr(db: Db, now: number): LaneResult {
  const state = readSingleton(db);
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
    db.run(
      'UPDATE forward_deferred_love_maintenance SET rr_cursor=0,rr_frontier=?,rr_passes=?,updated_at_ms=? WHERE singleton=1',
      next - 1,
      safeSuccessor(state.rr_passes, 'RR passes'),
      now,
    );
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
  db.run(
    'UPDATE forward_deferred_love_maintenance SET rr_cursor=?,updated_at_ms=? WHERE singleton=1',
    asSafeInt(row.head_seq, 'RR head sequence', 1),
    now,
  );
  return { useful, visited: 1 };
}

function runWit(db: Db, now: number): LaneResult {
  const state = readSingleton(db);
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
    db.run(
      `UPDATE forward_deferred_love_maintenance SET wit_state=?,wit_cursor=?,wit_link_id=?,wit_generation=?,updated_at_ms=? WHERE singleton=1`,
      finished ? 'scan' : 'pruning',
      finished ? cursor : cursor,
      finished ? '' : state.wit_link_id,
      finished ? 0 : state.wit_generation,
      now,
    );
    return { useful: removed > 0, visited: 0, steps: 1 };
  }
  const group = db.one<{ group_seq: string; link_id: string; generation: number }>(
    `SELECT CAST(group_seq AS TEXT) AS group_seq,link_id,generation FROM forward_deferred_love_witnesses INDEXED BY forward_deferred_love_witnesses_group
     WHERE group_seq>? AND group_seq<=? ORDER BY forward_deferred_love_witnesses.group_seq,forward_deferred_love_witnesses.link_id,forward_deferred_love_witnesses.generation LIMIT 1`,
    cursor,
    frontier,
  );
  if (group === null) {
    if (cursor === 0 && frontier === next - 1) return { useful: false, visited: 0 };
    db.run(
      `UPDATE forward_deferred_love_maintenance SET wit_cursor=0,wit_frontier=?,wit_passes=?,updated_at_ms=? WHERE singleton=1`,
      next - 1,
      safeSuccessor(state.wit_passes, 'WIT passes'),
      now,
    );
    return { useful: false, visited: 0, steps: 1 };
  }
  const groupSeq = asSafeInt(group.group_seq, 'WIT group sequence', 1);
  const current = currentGeneration(db, group.link_id);
  if (current === null || group.generation < current) {
    db.run(
      `UPDATE forward_deferred_love_maintenance SET wit_state='pruning',wit_cursor=?,wit_link_id=?,wit_generation=?,updated_at_ms=? WHERE singleton=1`,
      groupSeq,
      group.link_id,
      group.generation,
      now,
    );
    return { useful: false, visited: 0, steps: 1 };
  }
  db.run('UPDATE forward_deferred_love_maintenance SET wit_cursor=?,updated_at_ms=? WHERE singleton=1', groupSeq, now);
  return { useful: false, visited: 0, steps: 1 };
}

function runAuth(db: Db, now: number): LaneResult {
  const state = readSingleton(db);
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
    db.run(
      `UPDATE forward_deferred_love_maintenance SET auth_cursor=0,auth_frontier=?,auth_passes=?,updated_at_ms=? WHERE singleton=1`,
      next - 1,
      safeSuccessor(state.auth_passes, 'AUTH passes'),
      now,
    );
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
  db.run(
    'UPDATE forward_deferred_love_maintenance SET auth_cursor=?,updated_at_ms=? WHERE singleton=1',
    asSafeInt(rows.at(-1)!.authority_seq, 'AUTH sequence', 1),
    now,
  );
  return { useful, visited: 0 };
}

function runLane(db: Db, lane: Lane, now: number): LaneResult {
  const before = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (before === undefined) throw new Error('SQLite change counter unavailable');
  const result = db.tx(() => {
    const laneResult =
      lane === 'inv'
        ? runInv(db)
        : lane === 'due'
          ? runDue(db)
          : lane === 'rr'
            ? runRr(db, now)
            : lane === 'wit'
              ? runWit(db, now)
              : runAuth(db, now);
    countLinkCoverage(db, `deferred_maintenance_${lane}`);
    return laneResult;
  });
  const after = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (after === undefined) throw new Error('SQLite change counter unavailable');
  const writeDelta = BigInt(after) - BigInt(before);
  if (writeDelta < 0n || writeDelta > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('deferred love lane write count is unsafe');
  return { ...result, writes: Number(writeDelta) };
}

export interface LoveMaintenanceResult {
  useful: boolean;
  wakeMs: number;
  writes: number;
  perVisitWrites: number[];
  visits: number;
  witSteps: number;
}

/** Runs five independently committed lanes with bounded per-lane work. */
export function runDeferredLoveMaintenance(db: Db, now: number): LoveMaintenanceResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('maintenance time must be safe epoch milliseconds');
  const beforeChanges = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (beforeChanges === undefined) throw new Error('SQLite change counter unavailable');
  const inserted = db.run('INSERT OR IGNORE INTO forward_deferred_love_maintenance(singleton) VALUES(1)').rowsWritten;
  if (inserted > 0)
    return {
      useful: false,
      wakeMs: LOVE_MAINTENANCE_QUIET_MS,
      writes: Number(
        BigInt(db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')!.changes) -
          BigInt(beforeChanges),
      ),
      perVisitWrites: [],
      visits: 0,
      witSteps: 0,
    };
  const before = readSingleton(db);
  const lanes: Lane[] = ['inv', 'due', 'rr', 'wit', 'auth'];
  let useful = false;
  let visits = 0;
  let witSteps = 0;
  const perVisitWrites: number[] = [];
  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[(before.lane_turn + index) % lanes.length]!;
    const result = runLane(db, lane, now);
    useful ||= result.useful;
    visits += result.visited;
    if (result.visited > 0) perVisitWrites.push(Math.ceil((result.writes ?? 0) / result.visited));
    if (lane === 'wit') witSteps += result.steps ?? 0;
  }
  if (visits > LOVE_MAINTENANCE_VISITS || witSteps > LOVE_MAINTENANCE_WIT_STEPS)
    throw new Error('deferred love maintenance unit budget exceeded');
  if (useful)
    db.run(
      'UPDATE forward_deferred_love_maintenance SET lane_turn=?,updated_at_ms=? WHERE singleton=1',
      (before.lane_turn + 1) % lanes.length,
      now,
    );
  const afterChanges = db.one<{ changes: number | bigint }>('SELECT total_changes() AS changes')?.changes;
  if (afterChanges === undefined) throw new Error('SQLite change counter unavailable');
  const writeDelta = BigInt(afterChanges) - BigInt(beforeChanges);
  if (writeDelta < 0n || writeDelta > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('deferred love write count is unsafe');
  const writes = Number(writeDelta);
  if (writes > LOVE_MAINTENANCE_WRITES) throw new Error(`deferred love maintenance write budget exceeded: ${writes}`);
  return {
    useful,
    wakeMs: useful ? LOVE_MAINTENANCE_ACTIVE_MS : LOVE_MAINTENANCE_QUIET_MS,
    writes,
    perVisitWrites,
    visits,
    witSteps,
  };
}
