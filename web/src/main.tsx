import { render } from 'preact';
import { App } from './app';
import { removeLegacyDatabases } from './migration';
import { sessionClient } from './session/client';
import { announceSessionReady, listenForSessionReady, REAUTH_POPUP_MARKER } from './session/reauth-channel';
import { createAppState, setSession } from './state/store';
import './styles/base.css';

const root = document.getElementById('app');
if (!root) throw new Error('index.html must contain <div id="app">');
const state = createAppState();
void removeLegacyDatabases().catch(() => {});
const client = sessionClient();
listenForSessionReady(client);
client.subscribe((session, reauth) => {
  setSession(state, session, null, { reauthRequired: reauth });
});
render(<App state={state} />, root);
void client
  .getSession()
  .then((session) => {
    setSession(state, session);
    if (session?.status === 'active') {
      announceSessionReady();
      try {
        if (sessionStorage.getItem(REAUTH_POPUP_MARKER) === '1') {
          sessionStorage.removeItem(REAUTH_POPUP_MARKER);
          window.close();
        }
      } catch {
        // Popup closure is best-effort; the parent also refreshes on focus.
      }
    }
  })
  .catch((error: unknown) => {
    console.error('session restore failed', error);
  });
