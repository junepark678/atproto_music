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
// Completion is a separate, durable fact (migration 12): `removal_done_rev`
// is a revision at or after which the targets were proven absent, so every
// present projection of a target at or below it is a removed (or an already
// superseded) incarnation, and one above it is a later incarnation. It is set
// only from ordered evidence, never from a 2xx alone:
//
// - `commit`: the write's success answer carried a well-formed commit newer
//   than H. The reference PDS (@atproto/pds 0.5.40) answers with `commit` only
//   from processWrites, which enforced swapCommit and swapRecord, so that
//   commit removed the targets.
// - `absent`: a read found the targets gone and the head read before it was
//   still the head after it (a stable bracket: no commit in between), or the
//   read followed an earlier completion (any absence then postdates it).
// - `absent_after`: a read found the targets gone but the head moved during
//   it. The targets were gone at some moment after that first head, which
//   proves this intent complete and bounds suppression below it, but an
//   intermediate version committed between that head and the absence could
//   still be pre-removal; the next read refines the boundary.
// - `verified`: after a send, verified membership (written only by verified
//   ingest) proves every target absent at a revision newer than the send
//   fence, so whatever that send targeted is gone.
//
// A success without a usable commit (the reference PDS's no-op delete of an
// absent record and no-op put of the stored bytes return before processWrites
// and check no swap at all), a failed write, a lost answer and a read-only
// reconcile therefore settle only through ordered absence. Once completion is
// established, a retry never writes again: a target present on a later read
// is a later incarnation, which a fresh intent removes normally.
//
// read/visibility hides a succeeded receipt's targets at every projected
// revision <= removal_done_rev and shows any present proof above it, at the
// same or another CID. These values are owner-PDS metadata (or the verified
// index's own revisions), never new verified proof; they decide only how this
// receipt suppresses its own targets and never write record_state or
// verified_membership.
//
// Fail closed: a removal never writes or settles without a well-formed head,
// and never against a head older than the target's verified revision or its
// own persisted fences (a repository that went backwards). It waits
// (`waiting`, no attempt spent) instead.

import type { Db } from '../do/db';
import type { Outcome } from './pds-writer';
import type { ExecContext } from './runner';

/** How long a removal holds before it reads an unavailable or inconsistent head again. */
export const HEAD_RETRY_MS = 5_000;

export type RepoHeadRef = { cid: string; rev: string };
export type CheckedHead = ({ kind: 'head' } & RepoHeadRef) | { kind: 'outcome'; outcome: Outcome };

/** How a removal's completion boundary (`removal_done_rev`) was established. */
export type RemovalBasis = 'commit' | 'absent' | 'absent_after' | 'verified';

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
 * Persists `rev` as the removal's completion boundary (migration 12). It
 * never moves backwards; an equal revision only upgrades `absent_after` to an
 * exact basis.
 */
export function keepRemovalDone(db: Db, id: string, rev: string, basis: RemovalBasis): void {
  db.run(
    `UPDATE operations SET removal_done_rev = ?, removal_done_basis = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running'
       AND (removal_done_rev IS NULL OR removal_done_rev < ?
         OR (removal_done_rev = ? AND removal_done_basis = 'absent_after' AND ? != 'absent_after'))`,
    rev,
    basis,
    id,
    rev,
    rev,
    basis,
  );
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
 * Whether removal `id` is already complete: a completion boundary is
 * persisted, or (after a send) verified membership proves every target absent
 * after the send fence, which is then persisted as the boundary.
 */
export function removalEstablished(db: Db, id: string, uri: string, targets: readonly string[]): boolean {
  const row = db.one<{ removal_head_rev: string | null; removal_done_rev: string | null }>(
    'SELECT removal_head_rev, removal_done_rev FROM operations WHERE id = ?',
    id,
  );
  if (row === null) return false;
  if (row.removal_done_rev !== null) return true;
  if (row.removal_head_rev === null || targets.length === 0) return false;
  const witness = verifiedAbsence(db, uri, targets, row.removal_head_rev);
  if (witness === null) return false;
  keepRemovalDone(db, id, witness, 'verified');
  return true;
}

/** One read of a removal's targets on the owner's PDS. */
export type TargetRead<T> = { kind: 'absent' } | { kind: 'present'; found: T } | { kind: 'outcome'; outcome: Outcome };

export type Observation<T> =
  /** The removal is complete and its boundary persisted: settle it. */
  | { kind: 'settled' }
  /** The targets are present and the removal is not complete: `head` was read just before them. */
  | { kind: 'present'; head: RepoHeadRef; found: T }
  | { kind: 'outcome'; outcome: Outcome };

/**
 * Reads the head, then the targets; an absence is ordered before it settles
 * anything. A stable bracket (the same head before and after the read) or an
 * earlier completion makes it exact at that head. A moved head records
 * `absent_after` (complete, boundary not yet exact) and reads once more,
 * which is then ordered after the first absence. A present target after an
 * established completion is a later incarnation: settled, never written.
 */
export async function observeRemoval<T>(
  ctx: ExecContext,
  operationId: string,
  uri: string,
  targets: readonly string[],
  read: () => Promise<TargetRead<T>>,
): Promise<Observation<T>> {
  const db = ctx.m.db;
  for (let round = 0; round < 2; round++) {
    const head = await checkedHead(ctx, uri, operationId);
    if (head.kind === 'outcome') return head;
    const found = await read();
    if (found.kind === 'outcome') return found;
    // Evidence only grows; consult it after the read.
    const established = removalEstablished(db, operationId, uri, targets);
    if (found.kind === 'present') {
      return established
        ? { kind: 'settled' }
        : { kind: 'present', head: { cid: head.cid, rev: head.rev }, found: found.found };
    }
    if (established) {
      // Read after the completion (its head is not behind the boundary): the
      // targets were gone at a moment after this head.
      settleAbsent(db, operationId, head.rev);
      return { kind: 'settled' };
    }
    const after = await ctx.xrpc.latestCommit();
    if (after.kind === 'head' && after.cid === head.cid && after.rev === head.rev) {
      settleAbsent(db, operationId, head.rev);
      return { kind: 'settled' };
    }
    keepRemovalDone(db, operationId, head.rev, 'absent_after');
    if (after.kind === 'failed' && after.failure.kind === 'reauth') {
      return { kind: 'outcome', outcome: { kind: 'reauth' } };
    }
  }
  return {
    kind: 'outcome',
    outcome: { kind: 'waiting', untilMs: ctx.m.clock.nowMs() + HEAD_RETRY_MS, code: 'repository_head_unstable' },
  };
}

/** An ordered absence at `rev` completes the removal; a removal never sent records that head as its fence too. */
function settleAbsent(db: Db, id: string, rev: string): void {
  keepRemovalDone(db, id, rev, 'absent');
  db.run(
    `UPDATE operations SET removal_head_rev = ?
     WHERE id = ? AND kind = 'scrobble.delete' AND state = 'running' AND removal_head_rev IS NULL`,
    rev,
    id,
  );
}

/**
 * An outcome met after a write was sent: `waiting` would uncount the attempt
 * of a send, so it is a transient failure (counted, retried) instead.
 */
export function afterSend(outcome: Outcome): Outcome {
  return outcome.kind === 'waiting' ? { kind: 'transient', code: outcome.code ?? 'remote_state_unavailable' } : outcome;
}
