import type { SessionClient } from './client';

const CHANNEL_NAME = 'atmusic-session';
const MESSAGE = 'session-ready';
export const REAUTH_POPUP_MARKER = 'atmusic:reauth-popup';

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
