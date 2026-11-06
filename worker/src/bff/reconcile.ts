// Sign-in policy reconciliation (ADR 0005 §5.5, §5.7, B20; N2-03).
//
// The allowlist (`ATMUSIC_SIGNIN_POLICY=allowlist`, `ATMUSIC_SIGNIN_DIDS`) is
// checked at sign-in (N3-01), and `reconcileSignInPolicy` applies it to the
// DIDs already signed in: at startup (run.ts, before listen) and on every
// `expiry-sweep` run (both wired by N4-01). For every DID with an `accounts`
// row or an OAuth session that the current policy refuses:
//   1. in one transaction, its web sessions, Last.fm sessions, app passwords,
//      ListenBrainz tokens and issued Last.fm apps are deleted, each journaled
//      in the revocation journal (N1-08) before the transaction commits, and
//      its pending Last.fm desktop tokens are deleted; its linked accounts are
//      set `revoked` (journaled as `linked_account`); its queued operations
//      are set `blocked` (not failed: they resume if the DID is allowed and
//      signs in again, §5.8); `accounts.oauth_status` is set `signed_out`;
//   2. then its OAuth session is revoked upstream (best effort) and deleted
//      (journaled as `oauth_session`), via OAuthService.revoke. The local step
//      comes first so that nothing of the DID stays usable while the
//      revocation waits for the AS.
// Removing a DID from ATMUSIC_SIGNIN_DIDS therefore takes effect at the next
// restart or within 10 minutes. An allowed DID is never touched.

import type { Clock } from '@atmusic/core/deps';
import type { Revocations } from '../app/revocations';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';
import type { NodeConfig } from '../node/config';
import type { OAuthService } from './oauth-client';

export type SignInPolicy = Pick<NodeConfig, 'signinPolicy' | 'signinDids'>;

/** Whether the policy admits `did` (§5.7). */
export function signInAllowed(policy: SignInPolicy, did: string): boolean {
  return policy.signinPolicy === 'open' || policy.signinDids.includes(did);
}

export interface ReconcileDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  revocations: Revocations;
  oauth: Pick<OAuthService, 'revoke'>;
}

export interface ReconcileReport {
  /** The refused DIDs, now signed out. */
  signedOut: string[];
  /** Rows deleted or changed per table, summed over the refused DIDs. */
  changed: Record<string, number>;
}

const hex = (b: ArrayBuffer) => Buffer.from(b).toString('hex');

/** Delete or revoke everything a refused DID holds, adding to `changed`; returns how many rows changed. */
function signOutLocally(deps: ReconcileDeps, did: string, changed: Record<string, number>): number {
  const { db, revocations } = deps;
  const now = deps.clock.nowMs();
  let total = 0;
  const add = (table: string, n: number) => {
    if (n > 0) changed[table] = (changed[table] ?? 0) + n;
    total += n;
  };
  db.tx(() => {
    for (const r of db.all<{ token_hash: ArrayBuffer }>('SELECT token_hash FROM web_sessions WHERE did = ?', did)) {
      revocations.record({ kind: 'web_session', hash: hex(r.token_hash), did });
    }
    add('web_sessions', db.run('DELETE FROM web_sessions WHERE did = ?', did).rowsWritten);
    for (const [table, kind, idCol] of [
      ['lastfm_sessions', 'lastfm_session', 'id'],
      ['app_passwords', 'app_password', 'id'],
      ['lb_tokens', 'lb_token', 'id'],
      ['lastfm_apps', 'lastfm_app', 'api_key'],
    ] as const) {
      for (const r of db.all<{ id: string }>(`SELECT ${idCol} AS id FROM ${table} WHERE did = ?`, did)) {
        revocations.record({ kind, id: r.id, did });
      }
      add(table, db.run(`DELETE FROM ${table} WHERE did = ?`, did).rowsWritten);
    }
    add('lastfm_tokens', db.run('DELETE FROM lastfm_tokens WHERE did = ?', did).rowsWritten);
    for (const r of db.all<{ id: string }>(
      "SELECT id FROM linked_accounts WHERE did = ? AND status != 'revoked'",
      did,
    )) {
      revocations.record({ kind: 'linked_account', id: r.id, did });
    }
    add(
      'linked_accounts',
      db.run(
        "UPDATE linked_accounts SET status = 'revoked', updated_at_ms = ? WHERE did = ? AND status != 'revoked'",
        now,
        did,
      ).rowsWritten,
    );
    add(
      'operations',
      db.run("UPDATE operations SET state = 'blocked', updated_at_ms = ? WHERE did = ? AND state = 'queued'", now, did)
        .rowsWritten,
    );
    add(
      'accounts',
      db.run(
        "UPDATE accounts SET oauth_status = 'signed_out', updated_at_ms = ? WHERE did = ? AND oauth_status != 'signed_out'",
        now,
        did,
      ).rowsWritten,
    );
  });
  return total;
}

/** Apply the sign-in policy to every DID already signed in. */
export async function reconcileSignInPolicy(deps: ReconcileDeps, policy: SignInPolicy): Promise<ReconcileReport> {
  const report: ReconcileReport = { signedOut: [], changed: {} };
  if (policy.signinPolicy === 'open') return report;
  const dids = deps.db.all<{ did: string }>(
    'SELECT did FROM accounts UNION SELECT did FROM oauth_sessions ORDER BY did',
  );
  for (const { did } of dids) {
    if (signInAllowed(policy, did)) continue;
    // Local credentials first, in one transaction: nothing of the DID is usable while the
    // upstream revocation below awaits the network.
    const n = signOutLocally(deps, did, report.changed);
    const hadSession = deps.db.one<{ one: number }>('SELECT 1 AS one FROM oauth_sessions WHERE did = ?', did) !== null;
    if (hadSession) {
      await deps.oauth.revoke(did);
      report.changed.oauth_sessions = (report.changed.oauth_sessions ?? 0) + 1;
    }
    // A DID reconciled earlier has nothing left; it is not reported again on every sweep.
    if (!hadSession && n === 0) continue;
    report.signedOut.push(did);
    deps.log.log('warn', 'signin_policy_revoked', { did });
  }
  return report;
}
