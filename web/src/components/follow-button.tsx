// Follow / unfollow for a profile (ADR 0004 §5.2 step 6; M7.3.3).
//
// The shown state combines the AppView's edge (does the viewer's indexed
// following list contain the subject?) with the newest local intent from the
// outbox. A follow is "confirmed" only once the index verified it; before that
// it is pending. A failed unfollow says so and states that the follow record
// was not removed: it never claims a removal that did not happen.

import type { Did } from '@atmusic/core/api-types';
import { useState } from 'preact/hooks';
import { followIntent } from '../outbox/overlay';
import type { OutboxOperation } from '../outbox/store';
import { describeOperation, isPending, withDueAt } from './operation-status';

export interface FollowButtonProps {
  viewer: Did;
  subject: Did;
  /** The viewer's outbox rows (null while loading). */
  ops: readonly OutboxOperation[] | null;
  /** The AppView's answer: true following, false not, null unknown/loading. */
  edge: boolean | null;
  onFollow(): Promise<unknown>;
  onUnfollow(): Promise<unknown>;
}

interface View {
  status: string;
  action: 'follow' | 'unfollow' | null;
  busy: boolean;
}

export function followView(props: Pick<FollowButtonProps, 'viewer' | 'subject' | 'ops' | 'edge'>): View {
  const intent = props.ops === null ? null : followIntent(props.ops, props.viewer, props.subject);
  const fromEdge = (): View =>
    props.edge === null
      ? { status: 'Checking whether you follow this account…', action: null, busy: true }
      : props.edge
        ? { status: 'Following', action: 'unfollow', busy: false }
        : { status: 'Not following', action: 'follow', busy: false };
  if (intent === null || props.ops === null) return fromEdge();
  const local = withDueAt(intent.local, props.ops);
  const text = describeOperation(local).text;
  if (isPending(local)) return { status: text, action: null, busy: true };
  if (local.state === 'published') {
    // Polling stopped before the index confirmed it (dueAt null): nothing more
    // will happen on its own, so the AppView's edge decides what is offered.
    if (props.edge === true) {
      const still = intent.intent === 'unfollow' ? ' still' : '';
      return {
        status: `${text}. The index${still} lists you as following this account.`,
        action: 'unfollow',
        busy: false,
      };
    }
    const listed = props.edge === false ? ' The index does not list you as following this account.' : '';
    return { status: `${text}.${listed}`, action: 'follow', busy: false };
  }
  if (intent.intent === 'follow') {
    if (local.state === 'indexed') return { status: 'Following (confirmed)', action: 'unfollow', busy: false };
    const base = fromEdge();
    return {
      status: `${text}. ${props.edge ? 'You still follow this account.' : 'You do not follow this account.'}`,
      action: base.action ?? 'follow',
      busy: false,
    };
  }
  if (local.state === 'indexed') return { status: 'Not following (unfollow confirmed)', action: 'follow', busy: false };
  return {
    status: `${text}. Your follow record was not removed; you still follow this account.`,
    action: 'unfollow',
    busy: false,
  };
}

export function FollowButton(props: FollowButtonProps) {
  const [sending, setSending] = useState(false);
  const view = followView(props);
  const act = (run: () => Promise<unknown>) => {
    setSending(true);
    run().finally(() => setSending(false));
  };
  return (
    <div class="follow-control">
      <p class="follow-status" role="status">
        {view.status}
      </p>
      {view.action === 'follow' ? (
        <button type="button" disabled={sending} onClick={() => act(props.onFollow)}>
          Follow
        </button>
      ) : null}
      {view.action === 'unfollow' ? (
        <button type="button" disabled={sending} onClick={() => act(props.onUnfollow)}>
          Unfollow
        </button>
      ) : null}
    </div>
  );
}
