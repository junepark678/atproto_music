// The owner's optimistic view (ADR 0004 §5.2 step 5, §9 A13; API.md deletion
// clarification): pending local operations merged over AppView pages.
//
// - A scrobble with a pending or completed local delete is hidden immediately
//   from its owner's pages, before the AppView has verified absence.
// - A delete that failed does not claim removal: the record stays visible,
//   marked with the failure code. A delete completed locally because the
//   create it was queued behind lost the rkey to another writer
//   (`remote_record_conflict`) hides nothing; that other record was never
//   deleted. (A delete enqueued after the conflict was known is sent normally,
//   so it hides the record while pending and shows its failure if it fails.)
// - Local creates the AppView has not indexed yet (queued, running, published,
//   or failed) are listed separately so the screen can show them with their
//   state; a failed create stays visible with its code.
// - Only operations of the record's own DID apply, so other users' items in a
//   feed are never touched.
//
// Pure functions over `OutboxStore.list(did)` rows; nothing here does I/O.

import type { AtUri, Did, Scrobble } from '@atmusic/core/api-types';
import type { OperationKind, OperationState, OutboxOperation } from './store';

export interface LocalState {
  opId: string;
  kind: OperationKind;
  state: OperationState;
  failureCode?: string;
  reason?: string;
}

export interface OverlaidScrobble {
  scrobble: Scrobble;
  /** The newest local operation on this record, when one exists. */
  local?: LocalState;
}

export interface LocalScrobble {
  uri: AtUri;
  record: Record<string, unknown>;
  local: LocalState;
}

export interface ScrobbleOverlay {
  items: OverlaidScrobble[];
  /** URIs removed from the page because the owner deleted them locally. */
  hidden: AtUri[];
  /** Local creates not (yet) on this page and not indexed, newest first. */
  pending: LocalScrobble[];
}

function localState(op: OutboxOperation): LocalState {
  const out: LocalState = { opId: op.id, kind: op.kind, state: op.state };
  if (op.failureCode !== undefined) out.failureCode = op.failureCode;
  if (op.reason !== undefined) out.reason = op.reason;
  return out;
}

/** The newest scrobble operation per URI, for one owner. */
function latestByUri(ops: readonly OutboxOperation[], owner: Did): Map<string, OutboxOperation> {
  const latest = new Map<string, OutboxOperation>();
  for (const op of ops) {
    if (op.did !== owner || (op.kind !== 'scrobble_create' && op.kind !== 'scrobble_delete')) continue;
    const seen = latest.get(op.uri);
    if (seen === undefined || op.seq > seen.seq) latest.set(op.uri, op);
  }
  return latest;
}

/**
 * A delete that has not failed hides the record from its owner. A delete that
 * completed locally because our create never owned the URI (`localCompletion`)
 * hides nothing: the record there is another writer's and was left in place.
 */
function hides(op: OutboxOperation): boolean {
  return op.kind === 'scrobble_delete' && op.state !== 'failed' && op.localCompletion === undefined;
}

/**
 * Merges `owner`'s outbox over a page of scrobbles (a history page or a feed
 * page). `includePending` (default true) adds the local creates; pass false
 * on pages after the first.
 */
export function overlayScrobbles(
  page: readonly Scrobble[],
  ops: readonly OutboxOperation[],
  owner: Did,
  options: { includePending?: boolean } = {},
): ScrobbleOverlay {
  const latest = latestByUri(ops, owner);
  const items: OverlaidScrobble[] = [];
  const hidden: AtUri[] = [];
  const onPage = new Set<string>();
  for (const scrobble of page) {
    onPage.add(scrobble.uri);
    const op = scrobble.did === owner ? latest.get(scrobble.uri) : undefined;
    if (op !== undefined && hides(op)) {
      hidden.push(scrobble.uri);
      continue;
    }
    items.push(op === undefined || op.state === 'indexed' ? { scrobble } : { scrobble, local: localState(op) });
  }
  const pending: LocalScrobble[] = [];
  if (options.includePending ?? true) {
    for (const op of latest.values()) {
      if (op.kind !== 'scrobble_create' || op.state === 'indexed' || onPage.has(op.uri)) continue;
      if (op.record === undefined) continue;
      pending.push({ uri: op.uri, record: op.record, local: localState(op) });
    }
    pending.sort((a, b) => (latest.get(b.uri)?.seq ?? 0) - (latest.get(a.uri)?.seq ?? 0));
  }
  return { items, hidden, pending };
}

export interface FollowIntent {
  intent: 'follow' | 'unfollow';
  local: LocalState;
}

/** The newest follow/unfollow intent of `owner` for `subject`, or null (use the AppView's edge). */
export function followIntent(ops: readonly OutboxOperation[], owner: Did, subject: Did): FollowIntent | null {
  let newest: OutboxOperation | null = null;
  for (const op of ops) {
    if (op.did !== owner || op.subject !== subject) continue;
    if (op.kind !== 'follow_create' && op.kind !== 'follow_delete') continue;
    if (newest === null || op.seq > newest.seq) newest = op;
  }
  if (newest === null) return null;
  return { intent: newest.kind === 'follow_create' ? 'follow' : 'unfollow', local: localState(newest) };
}
