// Publication states of an outbox operation (ADR 0004 §5.2 step 4; M7.2.2):
// queued → published → indexed, or excluded (reason) / failed (code).
//
// The words are chosen so that nothing claims more than is known: "published"
// means the PDS accepted the write and the AppView has not verified it yet;
// only "indexed" (or, for a delete, "removed from the index") is success. A
// failed operation always shows its code, and a failed delete or unfollow
// never says the record is gone.

import type { LocalState } from '../outbox/overlay';
import type { OperationKind, OperationState, OutboxOperation } from '../outbox/store';

export interface StatusInput {
  kind: OperationKind;
  state: OperationState;
  failureCode?: string;
  reason?: string;
  /** Set when the state is `published` and polling has stopped (budget spent or superseded). */
  dueAt?: number | null;
  lastError?: string;
  attempts?: number;
}

export type Tone = 'pending' | 'success' | 'failed';

const NOUN: Record<OperationKind, string> = {
  scrobble_create: 'Scrobble',
  scrobble_delete: 'Delete',
  follow_create: 'Follow',
  follow_delete: 'Unfollow',
  settings_put: 'Setting',
  settings_delete: 'Setting',
};

const INDEXED: Record<OperationKind, string> = {
  scrobble_create: 'Indexed: visible in your public history',
  scrobble_delete: 'Deleted: removed from the index',
  follow_create: 'Following: confirmed by the index',
  follow_delete: 'Unfollowed: confirmed by the index',
  settings_put: 'Saved: verified by the index',
  settings_delete: 'Saved: verified by the index',
};

/** True while the runner will still move this row (not settled, not stopped). */
export function isPending(op: Pick<StatusInput, 'state' | 'dueAt'>): boolean {
  if (op.state === 'queued' || op.state === 'running') return true;
  // A published row whose polling stopped (verdict 'stop', poll budget spent,
  // or superseded) keeps `published` with dueAt null: nothing more will happen.
  return op.state === 'published' && op.dueAt !== null;
}

/**
 * An overlay's `LocalState` with the row's `dueAt`, so a stopped publication
 * reads "not confirmed yet" instead of "waiting for the index".
 */
export function withDueAt<T extends LocalState>(
  local: T,
  ops: readonly OutboxOperation[],
): T & { dueAt?: number | null } {
  const row = ops.find((op) => op.id === local.opId);
  return row === undefined ? local : { ...local, dueAt: row.dueAt };
}

export function describeOperation(op: StatusInput): { text: string; tone: Tone } {
  const noun = NOUN[op.kind];
  switch (op.state) {
    case 'queued': {
      const retry = op.lastError !== undefined ? ` (retrying after ${op.lastError})` : '';
      return { text: `${noun} queued${retry}`, tone: 'pending' };
    }
    case 'running':
      return { text: `${noun} pending: sending to your PDS`, tone: 'pending' };
    case 'published':
      return op.dueAt === null
        ? { text: `${noun} published to your PDS; the index has not confirmed it yet`, tone: 'pending' }
        : { text: `${noun} published to your PDS; waiting for the index`, tone: 'pending' };
    case 'indexed':
      return { text: INDEXED[op.kind], tone: 'success' };
    case 'failed': {
      const code = op.failureCode ?? 'unknown_error';
      if (code === 'record_excluded') {
        return { text: `Excluded by the index: ${op.reason ?? 'no reason given'} (${code})`, tone: 'failed' };
      }
      return { text: `${noun} failed (${code})`, tone: 'failed' };
    }
  }
}

export function OperationStatus({ op }: { op: StatusInput }) {
  const { text, tone } = describeOperation(op);
  return (
    <span class="op-status" data-op-state={op.state} data-tone={tone}>
      {text}
    </span>
  );
}
