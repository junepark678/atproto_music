// SPA entry (index.html loads it as the only script; the CSP forbids inline
// script). Mounts the shell into #app and, once web/src/oauth/session.ts
// (W2-06) exists, lets its `init(state)` restore a stored session or finish an
// OAuth callback and record it with `setSession` (web/src/state/store.ts).

import { render } from 'preact';
import { App } from './app';
import { type AppState, createAppState } from './state/store';
import './styles/base.css';

type SessionModule = { init?: (state: AppState) => Promise<void> };

const sessionModules = import.meta.glob<SessionModule>('./oauth/session.ts');

async function bootSession(state: AppState): Promise<void> {
  const load = sessionModules['./oauth/session.ts'];
  if (!load) return;
  const mod = await load();
  await mod.init?.(state);
}

const root = document.getElementById('app');
if (!root) throw new Error('index.html must contain <div id="app">');

const state = createAppState();
render(<App state={state} />, root);
bootSession(state).catch((error: unknown) => {
  // Anonymous browsing keeps working; the sign-in screen reports OAuth errors.
  console.error('session restore failed', error);
});
