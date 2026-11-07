// A list of scrobbles in server order (feed, history), keyed by AT URI.
//
// Text only: every value is rendered as a text node. The owner's own records
// can carry a delete control (with an inline confirmation) and the local
// state of an outbox operation on them; other people's records never do.

import type { Scrobble } from '@atmusic/core/api-types';
import { useState } from 'preact/hooks';
import type { LocalState } from '../outbox/overlay';
import { describeFailure, formatLocalTime } from './format';
import { OperationStatus } from './operation-status';

export interface ListItem {
  scrobble: Scrobble;
  /** With the row's dueAt (see `withDueAt`) so a stopped publication is described as such. */
  local?: LocalState & { dueAt?: number | null };
}

export interface ScrobbleListProps {
  items: readonly ListItem[];
  label: string;
  /** Show the owner's DID with a profile link (feeds). */
  showActor?: boolean;
  /** Whether the viewer may delete this record (the signed-in owner, with publication). */
  canDelete?: (scrobble: Scrobble) => boolean;
  onDelete?: (scrobble: Scrobble) => Promise<void>;
}

export function ScrobbleList({ items, label, showActor = false, canDelete, onDelete }: ScrobbleListProps) {
  return (
    <ol class="scrobble-list" aria-label={label}>
      {items.map(({ scrobble, local }) => (
        <li key={scrobble.uri} data-uri={scrobble.uri}>
          <ScrobbleText scrobble={scrobble} showActor={showActor} />
          {local !== undefined ? <OperationStatus op={local} /> : null}
          {onDelete !== undefined &&
          canDelete?.(scrobble) &&
          !(local?.kind === 'scrobble_delete' && local.state !== 'failed') ? (
            <DeleteControl scrobble={scrobble} onDelete={onDelete} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function ScrobbleText({
  scrobble,
  showActor = false,
}: {
  scrobble: Pick<Scrobble, 'artist' | 'track' | 'listenedAt' | 'did'> & { album?: string; handle?: string | null };
  showActor?: boolean;
}) {
  return (
    <>
      <span class="track">{scrobble.track}</span>
      {' by '}
      <span class="artist">{scrobble.artist}</span>
      {scrobble.album !== undefined ? (
        <>
          {' from '}
          <span class="album">{scrobble.album}</span>
        </>
      ) : null}
      <span class="scrobble-meta">
        {' · '}
        <time dateTime={scrobble.listenedAt}>{formatLocalTime(scrobble.listenedAt)}</time>
        {showActor ? (
          <>
            {' · '}
            <a href={`/u/${scrobble.did}`} class="actor">
              {scrobble.handle ? `@${scrobble.handle}` : 'Unknown account'}
            </a>
          </>
        ) : null}
      </span>
    </>
  );
}

function DeleteControl({ scrobble, onDelete }: { scrobble: Scrobble; onDelete: (s: Scrobble) => Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'sending'>('idle');
  const [error, setError] = useState<string | null>(null);
  const name = `“${scrobble.track}” by ${scrobble.artist}`;
  if (phase === 'idle') {
    return (
      <button type="button" class="delete" aria-label={`Delete ${name}`} onClick={() => setPhase('confirm')}>
        Delete
      </button>
    );
  }
  return (
    <fieldset class="confirm" aria-label={`Confirm deleting ${name}`}>
      {error ? <p role="alert">{error}</p> : null}
      <p>
        Delete {name} from your PDS? It disappears from your view now and from public views once the index verifies the
        deletion.
      </p>
      <div class="actions">
        <button
          type="button"
          disabled={phase === 'sending'}
          onClick={() => {
            setError(null);
            setPhase('sending');
            onDelete(scrobble)
              .catch((failure: unknown) => setError(describeFailure(failure)))
              .finally(() => setPhase('idle'));
          }}
        >
          Confirm delete
        </button>
        <button type="button" disabled={phase === 'sending'} onClick={() => setPhase('idle')}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
