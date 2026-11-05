import type { SessionClient } from './client';

const CHANNEL_NAME = 'atmusic-session';
const MESSAGE = 'session-ready';
export const REAUTH_POPUP_MARKER = 'atmusic:reauth-popup';

/** Consume the marker that distinguishes an OAuth popup callback from a normal app reload. */
function consumeReauthPopupMarker(storage: Pick<Storage, 'getItem' | 'removeItem'>): boolean {
  try {
    if (storage.getItem(REAUTH_POPUP_MARKER) !== '1') return false;
    storage.removeItem(REAUTH_POPUP_MARKER);
    return true;
  } catch {
    return false;
  }
}

/** Announce and close only the context explicitly opened for reauthentication. */
export function finishReauthPopup(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  notify: () => void = announceSessionReady,
  close: () => void = () => window.close(),
): boolean {
  if (!consumeReauthPopupMarker(storage)) return false;
  try {
    notify();
  } catch {
    // Popup closure is best-effort; the parent can also refresh on focus.
  }
  try {
    close();
  } catch {
    // Browsers may refuse to close a context they do not consider a popup.
  }
  return true;
}

/** Notify other same-origin tabs that the cookie session may have changed. No session data is sent. */
export function announceSessionReady(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(MESSAGE);
  channel.close();
}

/** Refresh this tab after another same-origin context finishes OAuth. */
export function listenForSessionReady(client: SessionClient): () => void {
  const refresh = () => {
    void client.refresh().catch(() => undefined);
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.data === MESSAGE) refresh();
  };
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  channel?.addEventListener('message', onMessage);
  const onFocus = () => {
    if (document.visibilityState === 'visible' && client.current()?.status !== 'active') refresh();
  };
  window.addEventListener('focus', onFocus);
  return () => {
    channel?.removeEventListener('message', onMessage);
    channel?.close();
    window.removeEventListener('focus', onFocus);
  };
}
