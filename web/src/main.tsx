// SPA entry (index.html loads it as the only script; the CSP forbids inline
// script). Mounts the shell into #app and, once web/src/oauth/session.ts
// (W2-06) exists, calls its `init()` to restore a stored session or finish an
// OAuth callback, then records `current()` with `setSession`
// (web/src/state/store.ts). The contract is `SessionModule` in
// web/src/oauth/types.ts.

import { render } from 'preact';
import { App } from './app';
import type { SessionModule } from './oauth/types';
import { type AppState, createAppState, setSession } from './state/store';
import './styles/base.css';

const sessionModules = import.meta.glob<SessionModule>('./oauth/session.ts');

async function bootSession(state: AppState): Promise<void> {
  const load = sessionModules['./oauth/session.ts'];
  if (!load) return;
  const mod = await load();
  await mod.init?.();
  setSession(state, mod.current?.() ?? null);
}

const root = document.getElementById('app');
if (!root) throw new Error('index.html must contain <div id="app">');

const state = createAppState();
render(<App state={state} />, root);
bootSession(state).catch((error: unknown) => {
  // Anonymous browsing keeps working; the sign-in screen reports OAuth errors.
  console.error('session restore failed', error);
});
