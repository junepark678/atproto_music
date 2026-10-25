// The `oauth-keepalive` timer (ADR 0005 §3.3, §5.5, §18 Q19; N2-03).
//
// Hourly, it keeps the OAuth sessions of DIDs **in use** inside the reference
// AS's 3-month refresh-token inactivity window: every active session whose
// `last_refresh_ms` is more than 30 days old is refreshed once, at most 20
// sessions per run (oldest first). A DID is in use when it has
//   - a live web session (`web_sessions.expires_at_ms` in the future),
//   - a protocol credential (Last.fm session, app password, ListenBrainz token)
//     used within the last 90 days (one never used counts from its creation),
//   - an `active` linked account,
//   - a `queued`, `running` or `blocked` operation, or
//   - an import job that is not finished (`done`, `failed`, `cancelled`).
// A DID that is not in use is revoked upstream instead and marked
// `signed_out`; its protocol credentials stay, and a later scrobble is
// accepted and waits as `blocked` until the user signs in again (§5.8).
// Revocations count toward the per-run bound of 20 upstream actions. The
// "not in use" decision is re-evaluated under the DID's lock immediately before
// the revocation (`revoke(did, {unless})`), so a DID that came into use while
// the run awaited earlier DIDs is refreshed instead, and a session a concurrent
// sign-in stored is never deleted (revoke() answers `superseded`).
//
// Each run first retries the session store's held writes (§5.5), then pauses —
// refreshing and revoking nothing and reporting `low_disk` — while the
// injected `diskLow()` predicate (worker/src/node/disk.ts) is true, so the only
// writes left below the free-space floor are live scrobbles and session
// updates.
//
// The handler (`oauthKeepaliveTimer`) reschedules itself an hour later through
// the extension context; N4-01 registers it in the production feature list.

import type { Clock } from '@atmusic/core/deps';
import type { ExtensionTimerHandler } from '../app/host';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import type { OAuthService } from './oauth-client';

const DAY_MS = 86_400_000;
export const KEEPALIVE_INTERVAL_MS = 3_600_000;
/** Refresh sessions last refreshed more than this long ago. */
export const KEEPALIVE_REFRESH_AGE_MS = 30 * DAY_MS;
/** A protocol credential used within this window keeps its DID in use (§18 Q19). */
export const KEEPALIVE_CREDENTIAL_WINDOW_MS = 90 * DAY_MS;
/** Upstream actions (refreshes and revocations) per run. */
export const KEEPALIVE_MAX_PER_RUN = 20;

export interface KeepaliveDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  oauth: Pick<OAuthService, 'restore' | 'revoke' | 'flush'>;
  /** worker/src/node/disk.ts diskLowProbe(stateDir, ATMUSIC_MIN_FREE_BYTES). */
  diskLow: () => boolean;
}

export interface KeepaliveReport {
  status: 'ok' | 'low_disk';
  /** DIDs whose session was refreshed. */
  refreshed: string[];
  /** DIDs not in use: revoked upstream and marked signed_out. */
  signedOut: string[];
  /** DIDs whose refresh failed (the library deletes the session on invalid_grant). */
  failed: string[];
  /** Due sessions left for a later run by the per-run bound. */
  deferred: number;
}

/** Whether `did` is in use at `nowMs` (the list above). */
export function didInUse(db: Db, did: string, nowMs: number): boolean {
  const since = nowMs - KEEPALIVE_CREDENTIAL_WINDOW_MS;
  const row = db.one<{ used: number }>(
    `SELECT (
       EXISTS(SELECT 1 FROM web_sessions WHERE did = ?1 AND expires_at_ms > ?2)
       OR EXISTS(SELECT 1 FROM lastfm_sessions WHERE did = ?1 AND COALESCE(last_used_ms, created_at_ms) >= ?3)
       OR EXISTS(SELECT 1 FROM app_passwords WHERE did = ?1 AND COALESCE(last_used_ms, created_at_ms) >= ?3)
       OR EXISTS(SELECT 1 FROM lb_tokens WHERE did = ?1 AND COALESCE(last_used_ms, created_at_ms) >= ?3)
       OR EXISTS(SELECT 1 FROM linked_accounts WHERE did = ?1 AND status = 'active')
       OR EXISTS(SELECT 1 FROM operations WHERE did = ?1 AND state IN ('queued', 'running', 'blocked'))
       OR EXISTS(SELECT 1 FROM import_jobs WHERE did = ?1 AND state NOT IN ('done', 'failed', 'cancelled'))
     ) AS used`,
    did,
    nowMs,
    since,
  );
  return row?.used === 1;
}

/** One keepalive run. */
export async function runOAuthKeepalive(deps: KeepaliveDeps): Promise<KeepaliveReport> {
  const report: KeepaliveReport = { status: 'ok', refreshed: [], signedOut: [], failed: [], deferred: 0 };
  deps.oauth.flush();
  if (deps.diskLow()) {
    deps.log.log('warn', 'oauth_keepalive_paused', { reason: 'low_disk' });
    return { ...report, status: 'low_disk' };
  }
  const now = deps.clock.nowMs();
  const due = deps.db.all<{ did: string }>(
    "SELECT did FROM oauth_sessions WHERE status = 'active' AND last_refresh_ms < ? ORDER BY last_refresh_ms, did",
    now - KEEPALIVE_REFRESH_AGE_MS,
  );
  let actions = 0;
  for (const { did } of due) {
    if (actions >= KEEPALIVE_MAX_PER_RUN) {
      report.deferred += 1;
      continue;
    }
    actions += 1;
    if (!didInUse(deps.db, did, now)) {
      // The check is repeated under the DID's lock right before the revocation (no await in
      // between), and revoke() keeps a session a concurrent sign-in stored meanwhile.
      const outcome = await deps.oauth.revoke(did, { unless: () => didInUse(deps.db, did, deps.clock.nowMs()) });
      if (outcome === 'revoked') {
        report.signedOut.push(did);
        continue;
      }
      if (outcome === 'superseded') {
        deps.log.log('info', 'oauth_keepalive_superseded', { did });
        continue;
      }
      // 'skipped': the DID came into use while the run awaited; it is due, so refresh it.
    }
    try {
      await deps.oauth.restore(did, true);
      report.refreshed.push(did);
    } catch (error) {
      report.failed.push(did);
      deps.log.log('warn', 'oauth_keepalive_refresh_failed', {
        did,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  deps.log.log('info', 'oauth_keepalive', {
    refreshed: report.refreshed.length,
    signedOut: report.signedOut.length,
    failed: report.failed.length,
    deferred: report.deferred,
  });
  return report;
}

/** The extension timer handler: one run, then again in an hour. */
export function oauthKeepaliveTimer(deps: Omit<KeepaliveDeps, 'clock'> & { clock?: Clock }): ExtensionTimerHandler {
  return async (now, ctx) => {
    try {
      await runOAuthKeepalive({ ...deps, clock: deps.clock ?? ctx.deps.clock });
    } finally {
      ctx.schedule('oauth-keepalive', now + KEEPALIVE_INTERVAL_MS, { force: true });
    }
  };
}
