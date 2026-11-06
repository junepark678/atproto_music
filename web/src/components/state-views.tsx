// Reusable labelled states (M7.1.3 state_components): loading, empty, error,
// stale index, sign-in required, publishing unavailable. Each renders text
// with a `data-state` marker; there is no spinner, so nothing can keep
// spinning after an error. Loading is a polite status message that the
// screens replace with the outcome, whatever it is.

import type { Indexing } from '@atmusic/core/api-types';
import type { ComponentChildren } from 'preact';
import { describeFailure, formatUtc } from './format';
import './screens.css';

export function LoadingState({ label }: { label: string }) {
  return (
    <p class="state state-loading" role="status" data-state="loading">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: ComponentChildren }) {
  return (
    <p class="state state-empty" data-state="empty">
      {children}
    </p>
  );
}

export interface ErrorStateProps {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ title, error, onRetry, retryLabel = 'Try again' }: ErrorStateProps) {
  return (
    <div class="state state-error" role="alert" data-state="error">
      <p class="state-title">{title}</p>
      <p>{describeFailure(error)}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

const STATE_TEXT: Record<Indexing['state'], string> = {
  current: 'The index is catching up',
  recovering: 'The index is recovering',
  stale: 'The index is behind',
  suppressed: 'This account has opted out of indexing',
};

/** Shown when the index is not current; null when it is current and caught up. */
export function StaleNotice({ indexing }: { indexing: Indexing }) {
  if (indexing.state === 'current' && indexing.caughtUp) return null;
  const last = indexing.lastIndexedAt !== null ? ` Last indexed ${formatUtc(indexing.lastIndexedAt)}.` : '';
  const lag = indexing.lagSeconds !== null ? ` About ${Math.round(indexing.lagSeconds)} s behind.` : '';
  const tail = indexing.state === 'suppressed' ? '' : ' Recent scrobbles may be missing.';
  return (
    <p class="state state-stale" role="note" data-state="stale">
      {STATE_TEXT[indexing.state]}.{tail}
      {last}
      {lag}
    </p>
  );
}

export function SignInPrompt({ children, action = 'Sign in' }: { children: ComponentChildren; action?: string }) {
  return (
    <div class="state state-signin" data-state="signin-required">
      <p>{children}</p>
      <p>
        <a href="/signin">{action}</a>
      </p>
    </div>
  );
}

export function PublishingUnavailable() {
  return (
    <p class="state state-unavailable" data-state="publishing-unavailable">
      Publishing is not available on this deployment: it has no owned record namespace, so this app cannot write records
      for you. You can still browse feeds, profiles and statistics.
    </p>
  );
}
