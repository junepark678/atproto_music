// Server-enforced removal fences (migration 11; ADR 0006 "Removal receipts").
//
// A scrobble removal (single record or batch listens) must know where it sits
// in its owner's repository history, or a delayed proof of an older version
// cannot be told apart from a later recreation. Local observations cannot
// say that: the newest revision this index has verified is only a lower bound
// of the repository state the write met, and CIDs (even all of them seen)
// cannot enumerate versions this index never saw. So every removal write is
// fenced by the owner's PDS itself:
//
// 1. Read the repository head H (com.atproto.sync.getLatestCommit) over the
//    authenticated writer transport, then the target record.
// 2. Persist H.rev as `removal_head_rev` (never backwards) BEFORE the send.
// 3. Send the write with BOTH `swapCommit = H.cid` and `swapRecord` = the CID
//    just read. The PDS commits it only while H is still its head, so the
//    removal is the very next commit after H: every revision <= H.rev
//    precedes it, and nothing can be committed between the reads and the
//    write. Any intervening commit (to this record or any other) is
//    InvalidSwap: nothing was written, and the next try reads a fresh head
//    and record (no ABA window).
// 4. A success response's `commit.rev` (newer than H) is kept as
//    `removal_commit_rev`; a lost response keeps H.
// A read that finds the target already gone after reading head H also fences
// at H: the target was absent at a moment after H was current, so every
// incarnation at or below H.rev had already been removed by then.
//
// read/visibility then hides a succeeded receipt's targets at every projected
// revision <= removal_head_rev (or < removal_commit_rev) and shows any present
// proof above it, at the same or another CID: a later incarnation. These
// values are owner-PDS metadata, never verified proof; they decide only how
// this receipt suppresses its own targets and never write record_state or
// verified_membership.
//
// Fail closed: a removal never writes without a well-formed head, and never
// writes against a head older than the target's verified revision here (a
// repository that went backwards). It waits (`waiting`, no attempt spent)
// instead, so no receipt ever settles without its fence.

import type { Db } from '../do/db';
import type { Outcome } from './pds-writer';
import type { ExecContext } from './runner';

/** How long a removal holds before it reads an unavailable or inconsistent head again. */
export const HEAD_RETRY_MS = 5_000;

export type CheckedHead = { kind: 'head'; cid: string; rev: string } | { kind: 'outcome'; outcome: Outcome };

/**
 * The owner's repository head for a removal of `uri`, or the outcome to stop
 * with: reauth on a sign-in failure, otherwise `waiting` (fail closed).
 */
export async function checkedHead(ctx: ExecContext, uri: string): Promise<CheckedHead> {
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
