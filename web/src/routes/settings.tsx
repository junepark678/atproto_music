// /settings (M7.2.1 logout_ui, M7.2.3; ADR 0004 §5.1 step 6, §5.3, A9, A10).
//
// - Session: the signed-in identity, when the session ends at the latest
//   (public clients: 14 days after authorization) and sign-out, which stops
//   the outbox runner, revokes upstream and clears IndexedDB.
// - Export: a download of the public `GET /api/v1/users/{did}/export`
//   attachment, saved as music-export.json.
// - Disconnect / reconnect: a confirmed disconnect enqueues the signed opt-out
//   record `<prefix>.settings/self {indexing: "disabled"}` through the outbox;
//   reconnect writes `indexing: "enabled"`. The confirmation offers the export
//   first and says plainly that the PDS records and the opt-out record stay
//   public. Nothing here claims an erasure.

import type { Did, RecordStatus } from '@atmusic/core/api-types';
import { collectionsFor } from '@atmusic/core/namespace';
import { useEffect, useState } from 'preact/hooks';
import { formatUtcMs } from '../components/format';
import { OperationStatus } from '../components/operation-status';
import type { OutboxService } from '../components/outbox-service';
import { useServices } from '../components/services';
import { useSessionHandle } from '../components/session-identity';
import { ErrorState, LoadingState, SignInPrompt } from '../components/state-views';
import { useOutbox, useOutboxOps } from '../components/use-outbox';
import type { SessionExpiry } from '../oauth/session';
import type { OutboxOperation } from '../outbox/store';
import { setSession, useAppState } from '../state/store';

export const EXPORT_FILENAME = 'music-export.json';

export default function Settings() {
  const state = useAppState();
  const session = state.session.value;
  const [signedOut, setSignedOut] = useState(false);
  useSessionHandle();

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title">Settings</h1>
      {signedOut ? (
        <p role="status" data-state="signed-out">
          You have signed out. This browser no longer holds your session or your outbox.
        </p>
      ) : null}
      {session === null ? (
        <SignInPrompt>Sign in to manage your settings.</SignInPrompt>
      ) : (
        <SignedInSettings did={session.did} onSignedOut={() => setSignedOut(true)} />
      )}
    </section>
  );
}

function SignedInSettings({ did, onSignedOut }: { did: Did; onSignedOut(): void }) {
  const state = useAppState();
  const outboxState = useOutbox();
  return (
    <>
      <AccountSection did={did} onSignedOut={onSignedOut} />
      <section aria-labelledby="export-title">
        <h2 id="export-title">Your data</h2>
        <p>
          The export holds the public scrobbles and follows this index has for your account, as JSON. It is a copy of
          indexed public records, not an archive of your PDS.
        </p>
        <ExportLink href={state.api.exportUrl(did)} />
      </section>
      {outboxState.status === 'ready' ? <IndexingSection outbox={outboxState.outbox} /> : null}
      {outboxState.status === 'loading' ? <LoadingState label="Opening your outbox…" /> : null}
      {outboxState.status === 'error' ? (
        <ErrorState title="Your outbox could not be opened." error={outboxState.error} />
      ) : null}
    </>
  );
}

function ExportLink({ href }: { href: string }) {
  return (
    <p>
      <a href={href} download={EXPORT_FILENAME} class="export-link">
        Download your data ({EXPORT_FILENAME})
      </a>
    </p>
  );
}

function AccountSection({ did, onSignedOut }: { did: Did; onSignedOut(): void }) {
  const state = useAppState();
  const services = useServices();
  const [expiry, setExpiry] = useState<SessionExpiry | null | 'loading'>('loading');
  const [signingOut, setSigningOut] = useState(false);
  const handle = state.handle.value;

  useEffect(() => {
    let live = true;
    services
      .session()
      .then((port) => port.expiry())
      .then(
        (value) => {
          if (live) setExpiry(value);
        },
        () => {
          if (live) setExpiry(null);
        },
      );
    return () => {
      live = false;
    };
  }, [services, did]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await services.closeOutbox();
      const port = await services.session();
      await port.signOut();
    } catch {
      // The session controller clears local state whatever the revocation outcome.
    } finally {
      setSession(state, null);
      setSigningOut(false);
      onSignedOut();
    }
  };

  return (
    <section aria-labelledby="account-title">
      <h2 id="account-title">Account</h2>
      <p>
        Signed in as {handle ? <span class="handle">@{handle}</span> : null} <code>{did}</code>
      </p>
      <p data-session-expiry>
        {expiry === 'loading'
          ? 'Checking when your session ends…'
          : expiry?.sessionEndsAtMs != null
            ? `Your session ends no later than ${formatUtcMs(expiry.sessionEndsAtMs)}; you will then need to sign in again.`
            : 'Your session lasts at most 14 days from when you signed in; you will then need to sign in again.'}
      </p>
      <button type="button" onClick={signOut} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}

type IndexingRead = { kind: 'loading' } | { kind: 'ready'; status: RecordStatus } | { kind: 'error'; error: unknown };

function latestSettingsOp(ops: readonly OutboxOperation[] | null): OutboxOperation | null {
  if (ops === null) return null;
  const settings = ops.filter((op) => op.kind === 'settings_put' || op.kind === 'settings_delete');
  return settings.at(-1) ?? null;
}

function IndexingSection({ outbox }: { outbox: OutboxService }) {
  const state = useAppState();
  const ops = useOutboxOps(outbox);
  const [read, setRead] = useState<IndexingRead>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const settingsUri = `at://${outbox.did}/${collectionsFor(outbox.prefix).settings}/self`;
  const latest = latestSettingsOp(ops);
  const settledId = latest !== null && (latest.state === 'indexed' || latest.state === 'failed') ? latest.id : null;

  useEffect(() => {
    let live = true;
    state.api.recordStatus(settingsUri).then(
      (status) => {
        if (live) setRead({ kind: 'ready', status });
      },
      (error: unknown) => {
        if (live) setRead({ kind: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [state, settingsUri, settledId]);

  // While the newest intent is moving only its status shows; once the index
  // confirmed it, it decides; otherwise (none, or failed) the index's answer.
  const pending =
    latest !== null &&
    (latest.state === 'queued' ||
      latest.state === 'running' ||
      (latest.state === 'published' && latest.dueAt !== null));
  const intended =
    latest !== null && latest.state === 'indexed'
      ? latest.kind === 'settings_put' && latest.record?.indexing === 'disabled'
        ? 'disconnected'
        : 'connected'
      : null;
  const indexed =
    read.kind === 'ready' ? (read.status.indexing.state === 'suppressed' ? 'disconnected' : 'connected') : null;
  const current = pending ? null : (intended ?? indexed);

  const run = async (write: () => Promise<unknown>) => {
    setSending(true);
    try {
      await write();
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-labelledby="indexing-title">
      <h2 id="indexing-title">Indexing</h2>
      {read.kind === 'loading' && intended === null ? <LoadingState label="Checking your indexing setting…" /> : null}
      {read.kind === 'error' && intended === null ? (
        <ErrorState title="Your indexing setting could not be checked." error={read.error} />
      ) : null}
      {latest !== null ? (
        <p class="settings-op" data-op-id={latest.id}>
          {latest.kind === 'settings_put' && latest.record?.indexing === 'disabled' ? 'Disconnect: ' : 'Reconnect: '}
          <OperationStatus op={latest} />
        </p>
      ) : null}
      {current === 'disconnected' ? (
        <>
          <p data-indexing="disabled">
            Indexing is turned off for your account: your public opt-out record tells this AppView not to index it.
          </p>
          <p>
            Reconnecting changes that public record to <code>indexing: "enabled"</code>. The index then reads your
            repository again from its signed state.
          </p>
          <button type="button" disabled={sending} onClick={() => run(() => outbox.reconnect())}>
            Reconnect
          </button>
        </>
      ) : null}
      {current === 'connected' && !confirming ? (
        <>
          <p data-indexing="enabled">This AppView indexes your public music records.</p>
          <button type="button" onClick={() => setConfirming(true)}>
            Disconnect…
          </button>
        </>
      ) : null}
      {current === 'connected' && confirming ? (
        <fieldset class="confirm" data-confirm="disconnect">
          <legend>Disconnect from this AppView?</legend>
          <p>You may want to download your data first:</p>
          <ExportLink href={state.api.exportUrl(outbox.did)} />
          <p>
            Disconnecting publishes an opt-out record (<code>settings/self</code> with <code>indexing: "disabled"</code>
            ) in your own repository. Once the index verifies it, this AppView stops showing your scrobbles, follows and
            statistics.
          </p>
          <p>
            Your scrobbles and follows remain in your PDS as public records. Nothing is taken out of your PDS, and other
            apps can still read them.
          </p>
          <p>
            The opt-out record is public too: anyone can see that you opted out. It stays in your repository until you
            reconnect.
          </p>
          <div class="actions">
            <button type="button" disabled={sending} onClick={() => run(() => outbox.disconnect())}>
              Confirm disconnect
            </button>
            <button type="button" disabled={sending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
