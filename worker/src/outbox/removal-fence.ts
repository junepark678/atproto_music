// Server-enforced removal fences and ordered completion boundaries
// (migrations 11 and 12; ADR 0006 "Removal receipts").
//
// A scrobble removal (single record or batch listens) must know where it sits
// in its owner's repository history, or a delayed proof of an older version
// cannot be told apart from a later recreation. Local observations cannot
// say that: the newest revision this index has verified is only a lower bound
// of the repository state the write met, and CIDs (even all of them seen)
// cannot enumerate versions this index never saw. So every removal is ordered
// by the owner's PDS itself:
//
// 1. Read the repository head H (com.atproto.sync.getLatestCommit) over the
//    authenticated writer transport, then the target record.
// 2. Persist H.rev as `removal_head_rev` (the send fence, never backwards)
//    BEFORE the send.
// 3. Send the write with BOTH `swapCommit = H.cid` and `swapRecord` = the CID
//    just read. When the PDS actually commits, it does so only while H is
//    still its head, so the removal is the very next commit after H. Any
//    intervening commit (to this record or any other) is InvalidSwap:
//    nothing was written, and the next try reads a fresh head and record.
//
// Two durable facts follow, kept apart (migrations 12 and 13):
//
// NO-REPLAY KNOWLEDGE (`removal_reached`, monotone, never cleared): the
// requested state was reached, so this intent never writes again, across a
// failed read-back or head read, a reauth, a crash, a restart or a read-only
// tenth-attempt reconcile. It is persisted the moment the evidence is in
// hand, before anything else is awaited:
// - `commit`: the write's success answer carried a well-formed commit newer
//   than H. The reference PDS (@atproto/pds 0.5.40) answers with `commit` only
//   from processWrites, which enforced swapCommit and swapRecord.
// - `success`: a semantically valid 2xx answer to this intent's own
//   deleteRecord/putRecord, whatever its commit metadata (absent or
//   malformed). The reference PDS's no-op delete of an absent record and
//   no-op put of the stored bytes check no swap, so they are not CAS evidence,
//   but they certify that the requested state existed while the request was
//   handled. A body that does not answer this request (another URI, no CID
//   for a put, not an object) certifies nothing: it is read back like a lost
//   answer.
// - `absent`: a read found every target gone.
// - `verified`: after a send, verified membership (written only by verified
//   ingest) proves every target absent at a revision newer than the send fence.
//
// ORDERED VISIBILITY (`removal_done_rev` / `removal_done_basis`, write-once
// apart from an equal-revision `after` -> `absent` refinement): where that
// moment sits in the owner's repository history, which decides what the
// succeeded receipt still hides (read/visibility):
// - `commit`: the enforced commit itself; hidden at or below it.
// - `absent`: the head of a stable bracket (the same head before and after an
//   absent read, so the read saw exactly that version); hidden at or below.
// - `verified`: the oldest of the per-target newest verified absences after
//   the send fence; hidden at or below. Verified ingest's per-URI revision
//   guards keep the projection at least that new, so a delayed older proof
//   cannot restore a later-removed entry.
// - `after`: the FIRST repository head read after the requested state was
//   reached (the closing head of an absent read whose head moved, or the head
//   read after a success answer or after an earlier unordered absence). The
//   targets were all gone at some version at or below it, so a projection at
//   or above it is a later incarnation (visible), and every pre-removal
//   version is strictly below it (hidden). It is NOT an exact cutoff: a later
//   incarnation committed between that moment and this head is hidden too,
//   until verified ingest proves the record at or above the boundary (a
//   re-proof of unchanged bytes carries the newer revision; settlement queues
//   the record's verify hint). A sibling's presence never decides it, and a
//   later head never replaces it.
//
// The reachable states of one removal and their crash boundaries:
// - unsent: no fence; a crash leaves nothing to reconcile.
// - send unknown: `removal_head_rev` persisted, then the write; a crash or
//   lost answer is reconciled by reading (an absence is `absent`; present
//   targets are written again under a fresh head and swapRecord, since
//   nothing proves the earlier write happened).
// - reached, unordered: `removal_reached` set, no `removal_done_rev` (the
//   closing head of the absent read, or every head read since the answer,
//   failed). It holds read-only (`waiting`, `removal_reached_unordered`, no
//   attempt spent, backoff doubling up to HOLD_MAX_MS) and stays pending, so
//   its overlay hides every target; the next head read orders it.
// - ordered: `removal_done_rev` set; the read-back settles it.
// No path from reached back to a write exists: observeRemoval answers only
// `settled` or an outcome once reached is known.
//
// These values are owner-PDS metadata (or the verified index's own
// revisions), never new verified proof; they decide only how this receipt
// suppresses its own targets and never write record_state or
// verified_membership.
//
// Fail closed: a removal never writes or settles without a well-formed head,
// and never against a head older than the target's verified revision or its
// own persisted fences (a repository that went backwards). It waits
// (`waiting`, no attempt spent) instead.

import { createHash } from 'node:crypto';
import { encode } from '@atcute/cbor';
import type { Db } from '../do/db';
import type { Outcome } from './pds-writer';
import type { ExecContext } from './runner';

/** A base32 CIDv1 string, as a PDS reports record CIDs (pds-writer CID_SYNTAX). */
const CID_SYNTAX = /^b[a-z2-7]{8,256}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The CIDv1 (dag-cbor, sha2-256) of a JSON record, or null when it has no dag-cbor encoding. */
function recordCid(record: unknown): string | null {
  let bytes: Uint8Array;
  try {
    bytes = encode(record);
  } catch {
    return null;
  }
  const raw = [0x01, 0x71, 0x12, 0x20, ...createHash('sha256').update(bytes).digest()];
  let out = 'b';
  let buffer = 0;
  let bits = 0;
  for (const byte of raw) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Whether a 2xx body answers this removal's own write, so the requested state
 * existed while it was handled (no-replay `success`). deleteRecord's output is
 * an object (`{}` for the reference no-op, else `{commit}`); putRecord's names
 * the same URI and the CID of exactly the bytes sent. Commit metadata and
 * unknown fields are not consulted here (reportedCommitRev orders a commit);
 * anything else (no body, an array, another URI, a missing, malformed or
 * different CID) certifies nothing.
 */
export function answersRemoval(body: unknown, request: { uri: string; record?: object }): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  if (request.record === undefined) return true;
  const { uri, cid } = body as { uri?: unknown; cid?: unknown };
  if (uri !== request.uri || typeof cid !== 'string' || !CID_SYNTAX.test(cid)) return false;
  const sent = recordCid(request.record);
  return sent === null || sent === cid;
}

/** How long a removal holds before it reads an unavailable or inconsistent head again. */
export const HEAD_RETRY_MS = 5_000;
/** The longest wait of a reached removal's read-only hold (its backoff doubles from HEAD_RETRY_MS). */
export const HOLD_MAX_MS = 300_000;

export type RepoHeadRef = { cid: string; rev: string };
export type CheckedHead = ({ kind: 'head' } & RepoHeadRef) | { kind: 'outcome'; outcome: Outcome };

/** How a removal's completion boundary (`removal_done_rev`) was established. */
export type RemovalBasis = 'commit' | 'absent' | 'after' | 'verified';
/** Why a removal is known to have reached its requested state (`removal_reached`). */
export type RemovalReached = 'commit' | 'success' | 'absent' | 'verified';
/**
 * The owner's repository head for a removal of `uri`, or the outcome to stop
 * with: reauth on a sign-in failure, otherwise `waiting` (fail closed). With
 * `operationId`, a head older than that removal's persisted send fence or
 * completion boundary is refused too.
 */
export async function checkedHead(ctx: ExecContext, uri: string, operationId?: string): Promise<CheckedHead> {
  const head = await ctx.xrpc.latestCommit();
  const until = ctx.m.clock.nowMs() + HEAD_RETRY_MS;
  if (head.kind === 'failed') {
    if (head.failure.kind === 'reauth') return { kind: 'outcome', outcome: { kind: 'reauth' } };
    return { kind: 'outcome', outcome: { kind: 'waiting', untilMs: until, code: 'repository_head_unavailable' } };
  }
  const verified = ctx.m.db.one<{ revision: string }>('SELECT revision FROM record_state WHERE uri = ?', uri);
  if (verified !== null && verified.revision > head.rev) {
    return { kind: 'outcome', outcome: { kind: 'waiting', untilMs: until, code: 'repository_head_behind_index' } };
  }
  if (operationId !== undefined) {
    const fences = ctx.m.db.one<{ removal_head_rev: string | null; removal_done_rev: string | null }>(
      'SELECT removal_head_rev, removal_done_rev FROM operations WHERE id = ?',
      operationId,
    );
    if (
      (fences?.removal_head_rev != null && fences.removal_head_rev > head.rev) ||
      (fences?.removal_done_rev != null && fences.removal_done_rev > head.rev)
    ) {
      return { kind: 'outcome', outcome: { kind: 'waiting', untilMs: until, code: 'repository_head_behind_fence' } };
    }
  }
  return { kind: 'head', cid: head.cid, rev: head.rev };
}

/** Persists `rev` as the removal's checked head unless an equal or newer one is already kept. */
export function keepRemovalHead(db: Db, id: string, rev: string): void {
  db.run(
    `UPDATE operations SET removal_head_rev = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running'
       AND (removal_head_rev IS NULL OR removal_head_rev < ?)`,
    rev,
    id,
    rev,
  );
}

/** Persists the commit revision the PDS reported for the removal write (never backwards). */
export function keepRemovalCommit(db: Db, id: string, rev: string | null): void {
  if (rev === null) return;
  db.run(
    `UPDATE operations SET removal_commit_rev = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running'
       AND (removal_commit_rev IS NULL OR removal_commit_rev < ?)`,
    rev,
    id,
    rev,
  );
}

/**
 * Persists `rev` as the removal's completion boundary (migration 12). Write
 * once: a known boundary is never recaptured or advanced (a later head or
 * absence could only cover a genuine later incarnation). The one exception is
 * an equal-revision refinement of `after` to `absent`, when a stable bracket
 * proved every target absent at exactly that head.
 */
export function keepRemovalDone(db: Db, id: string, rev: string, basis: RemovalBasis): void {
  db.run(
    `UPDATE operations SET removal_done_rev = ?, removal_done_basis = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running'
       AND (removal_done_rev IS NULL
         OR (removal_done_rev = ? AND removal_done_basis = 'after' AND ? = 'absent'))`,
    rev,
    basis,
    id,
    rev,
    basis,
  );
}

/**
 * Persists durable no-replay knowledge (migration 13): this removal reached
 * its requested state, so it never writes again. Set once; the first reason
 * and time are kept.
 */
export function markReached(db: Db, id: string, reason: RemovalReached, nowMs: number): void {
  db.run(
    `UPDATE operations SET removal_reached = ?, removal_reached_at_ms = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running' AND removal_reached IS NULL`,
    reason,
    nowMs,
    id,
  );
}

/** Whether removal `id` is known to have reached its requested state (never write again). */
export function removalReached(db: Db, id: string): boolean {
  const row = db.one<{ removal_reached: string | null; removal_done_rev: string | null }>(
    'SELECT removal_reached, removal_done_rev FROM operations WHERE id = ?',
    id,
  );
  return row !== null && (row.removal_reached !== null || row.removal_done_rev !== null);
}

function doneRev(db: Db, id: string): string | null {
  return db.one<{ rev: string | null }>('SELECT removal_done_rev AS rev FROM operations WHERE id = ?', id)?.rev ?? null;
}

/**
 * The verified revision proving every target absent after the send fence
 * `fence`, or null: for each target (a listen id, or `*` for the record
 * itself) the newest verified absence of it or of its whole record, all newer
 * than `fence`; the boundary is the oldest of them.
 */
function verifiedAbsence(db: Db, uri: string, targets: readonly string[], fence: string): string | null {
  let boundary: string | null = null;
  for (const target of new Set(targets)) {
    const row = db.one<{ rev: string | null }>(
      `SELECT max(last_absent_revision) AS rev FROM verified_membership
       WHERE record_uri = ? AND listen_id IN (?, '*') AND last_absent_revision IS NOT NULL`,
      uri,
      target,
    );
    const rev = row?.rev ?? null;
    if (rev === null || rev <= fence) return null;
    if (boundary === null || rev < boundary) boundary = rev;
  }
  return boundary;
}

/**
 * Whether removal `id` is already complete and ordered: a completion boundary
 * is persisted, or (after a send) verified membership proves every target
 * absent after the send fence, which is then persisted as the boundary (and
 * as no-replay knowledge).
 */
export function removalEstablished(
  db: Db,
  id: string,
  uri: string,
  targets: readonly string[],
  nowMs: number,
): boolean {
  const row = db.one<{ removal_head_rev: string | null; removal_done_rev: string | null }>(
    'SELECT removal_head_rev, removal_done_rev FROM operations WHERE id = ?',
    id,
  );
  if (row === null) return false;
  if (row.removal_done_rev !== null) return true;
  if (row.removal_head_rev === null || targets.length === 0) return false;
  const witness = verifiedAbsence(db, uri, targets, row.removal_head_rev);
  if (witness === null) return false;
  markReached(db, id, 'verified', nowMs);
  keepRemovalDone(db, id, witness, 'verified');
  return true;
}

/** One read of a removal's targets on the owner's PDS. */
export type TargetRead<T> = { kind: 'absent' } | { kind: 'present'; found: T } | { kind: 'outcome'; outcome: Outcome };

export type Observation<T> =
  /** The removal is complete and its boundary persisted: settle it. */
  | { kind: 'settled' }
  /**
   * The targets are present and the requested state was never known to be
   * reached: `head` was read just before them, and a write may be sent.
   */
  | { kind: 'present'; head: RepoHeadRef; found: T }
  | { kind: 'outcome'; outcome: Outcome };

/**
 * A reached removal that cannot finish its read now holds read-only: a
 * `waiting` outcome (no attempt spent) whose delay doubles with the time since
 * the requested state was reached, from HEAD_RETRY_MS up to HOLD_MAX_MS. A
 * sign-in failure still blocks it (reauth).
 */
export function holdReached(ctx: ExecContext, id: string, cause: Outcome): Outcome {
  if (cause.kind === 'reauth') return cause;
  const db = ctx.m.db;
  const now = ctx.m.clock.nowMs();
  const row = db.one<{ at: number | null; done: string | null }>(
    'SELECT removal_reached_at_ms AS at, removal_done_rev AS done FROM operations WHERE id = ?',
    id,
  );
  const elapsed = row?.at == null ? 0 : Math.max(0, now - row.at);
  const delay = Math.min(HOLD_MAX_MS, Math.max(HEAD_RETRY_MS, elapsed));
  const causeCode =
    cause.kind === 'waiting' || cause.kind === 'transient' || cause.kind === 'permanent' ? cause.code : undefined;
  return {
    kind: 'waiting',
    untilMs: now + delay,
    code: row?.done == null ? 'removal_reached_unordered' : (causeCode ?? 'remote_state_unavailable'),
  };
}

/**
 * Reads the head, then the targets. Once the requested state is known to be
 * reached (before this call, or by an absence found here), the answer is only
 * ever `settled` or an outcome: nothing is written again.
 *
 * - Not reached, targets present: `present` (the caller may write).
 * - An absence: no-replay knowledge at once. A stable bracket (the same head
 *   before and after the read) orders it exactly (`absent`). Otherwise the
 *   closing head, read after the absence, is its `after` boundary, and one
 *   more read bracketed by that head and the next may refine it to an exact
 *   `absent` at the same revision. When the closing head is unavailable, the
 *   next head read is the boundary.
 * - Reached but unordered: the first head read is the `after` boundary.
 * - Ordered: the read-back settles it; a present target is a later
 *   incarnation. Nothing ever moves a boundary (keepRemovalDone).
 * - Reached and the read cannot finish: a read-only hold (holdReached).
 */
export async function observeRemoval<T>(
  ctx: ExecContext,
  operationId: string,
  uri: string,
  targets: readonly string[],
  read: () => Promise<TargetRead<T>>,
): Promise<Observation<T>> {
  const db = ctx.m.db;
  const now = () => ctx.m.clock.nowMs();
  for (let round = 0; round < 2; round++) {
    // Evidence the index already holds decides before any head read.
    const established = removalEstablished(db, operationId, uri, targets, now());
    const reached = established || removalReached(db, operationId);
    const head = await checkedHead(ctx, uri, operationId);
    if (head.kind === 'outcome') {
      return reached ? { kind: 'outcome', outcome: holdReached(ctx, operationId, head.outcome) } : head;
    }
    // The first head read after the requested state was reached orders it.
    if (reached && !established) keepRemovalDone(db, operationId, head.rev, 'after');
    const found = await read();
    if (found.kind === 'outcome') {
      if (!reached) return found;
      if (found.outcome.kind === 'permanent') return { kind: 'settled' };
      return { kind: 'outcome', outcome: holdReached(ctx, operationId, found.outcome) };
    }
    if (found.kind === 'present') {
      // After the requested state was reached, a present target is a later
      // incarnation: settled at the boundary already persisted, never written.
      if (reached) return { kind: 'settled' };
      return { kind: 'present', head: { cid: head.cid, rev: head.rev }, found: found.found };
    }
    // Every target is absent: the requested state is reached (persisted now).
    if (!reached) {
      markReached(db, operationId, 'absent', now());
      // A removal never sent records that head as its send fence too, so
      // verified absences after it can order a later recovery.
      db.run(
        `UPDATE operations SET removal_head_rev = ?
         WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running' AND removal_head_rev IS NULL`,
        head.rev,
        operationId,
      );
    } else if (doneBasis(db, operationId) !== 'after') {
      // An exact boundary (commit, absent, verified) has nothing to refine.
      return { kind: 'settled' };
    }
    const closing = await bracket(ctx, operationId, head, read);
    if (closing === 'settled') return { kind: 'settled' };
    if (closing === 'reauth') return { kind: 'outcome', outcome: { kind: 'reauth' } };
    // An unavailable (or inconsistent) closing head orders nothing: the next
    // round's head is read after the absence.
  }
  return {
    kind: 'outcome',
    outcome: holdReached(ctx, operationId, {
      kind: 'waiting',
      untilMs: ctx.m.clock.nowMs() + HEAD_RETRY_MS,
      code: 'repository_head_unstable',
    }),
  };
}

function doneBasis(db: Db, id: string): string | null {
  return (
    db.one<{ basis: string | null }>('SELECT removal_done_basis AS basis FROM operations WHERE id = ?', id)?.basis ??
    null
  );
}

/**
 * Closes the bracket around an absent read that followed `opening`. The same
 * head again orders the absence exactly at it (`absent`). A head that moved
 * was read after the absence: the `after` boundary when none is persisted,
 * and the opening head of one more read, whose own stable bracket refines an
 * equal `after` boundary to `absent`. Answers `settled` when a boundary is
 * persisted, `reauth`, or `unordered` when no head could be read after it.
 */
async function bracket<T>(
  ctx: ExecContext,
  id: string,
  opening: RepoHeadRef,
  read: () => Promise<TargetRead<T>>,
): Promise<'settled' | 'reauth' | 'unordered'> {
  const db = ctx.m.db;
  let from = opening;
  for (let refine = 0; refine < 2; refine++) {
    const closing = await ctx.xrpc.latestCommit();
    if (closing.kind === 'head' && closing.cid === from.cid && closing.rev === from.rev) {
      // Exact: nothing was committed around the read. Write-once, so this
      // only orders an unordered removal or refines an equal `after` head.
      keepRemovalDone(db, id, from.rev, 'absent');
      return 'settled';
    }
    if (closing.kind === 'head' && closing.rev > from.rev) {
      // The head moved during the read: the absence was at a version at or
      // below this closing head.
      keepRemovalDone(db, id, closing.rev, 'after');
      if (refine > 0 || doneRev(db, id) !== closing.rev || doneBasis(db, id) !== 'after') return 'settled';
      // One more read, bracketed by this head, may make it exact.
      const again = await read();
      if (again.kind !== 'absent') return 'settled';
      from = { cid: closing.cid, rev: closing.rev };
      continue;
    }
    if (doneRev(db, id) !== null) return 'settled';
    if (closing.kind === 'failed' && closing.failure.kind === 'reauth') return 'reauth';
    return 'unordered';
  }
  return 'settled';
}

/**
 * An outcome met after a write was sent. A removal whose requested state is
 * now known to be reached only holds read-only: its `waiting` keeps the
 * attempt counted (`counted`) and is never failed for attempts. Otherwise
 * `waiting` would uncount the attempt of a send, so it is a transient failure
 * (counted, retried) instead.
 */
export function afterSend(db: Db, id: string, outcome: Outcome): Outcome {
  if (outcome.kind === 'waiting' && removalReached(db, id)) return { ...outcome, counted: true };
  return outcome.kind === 'waiting' ? { kind: 'transient', code: outcome.code ?? 'remote_state_unavailable' } : outcome;
}
