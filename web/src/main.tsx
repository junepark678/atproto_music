import { render } from 'preact';
import { App } from './app';
import { sessionClient } from './session/client';
import { createAppState, setSession } from './state/store';
import { removeLegacyDatabases } from './migration';
import './styles/base.css';

const root = document.getElementById('app');
if (!root) throw new Error('index.html must contain <div id="app">');
const state = createAppState();
void removeLegacyDatabases().catch(() => {});
const client = sessionClient();
client.subscribe((session, reauth) => {
  setSession(state, session);
  state.reauthRequired.value = reauth;
});
render(<App state={state} />, root);
void client.getSession().then((session) => setSession(state, session)).catch((error: unknown) => {
  console.error('session restore failed', error);
});
