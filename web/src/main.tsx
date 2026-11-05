import { render } from 'preact';
import { App } from './app';
import { removeLegacyDatabases } from './migration';
import { bootstrapSession } from './session/bootstrap';
import { sessionClient } from './session/client';
import { finishReauthPopup, listenForSessionReady } from './session/reauth-channel';
import { createAppState, setSession } from './state/store';
import './styles/base.css';

const root = document.getElementById('app');
if (!root) throw new Error('index.html must contain <div id="app">');
const state = createAppState();
void removeLegacyDatabases().catch(() => {});
const client = sessionClient();
listenForSessionReady(client);
render(<App state={state} />, root);
void bootstrapSession(client, (session, reauth, kind) => {
  setSession(state, session, null, { reauthRequired: reauth, kind });
})
  .then((session) => {
    if (session?.status === 'active') finishReauthPopup(sessionStorage);
  })
  .catch((error: unknown) => {
    console.error('session restore failed', error);
  });
