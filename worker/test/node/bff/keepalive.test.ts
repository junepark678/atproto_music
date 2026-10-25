// N2-03: the oauth-keepalive timer (ADR 0005 §5.5, §3.3, §18 Q19). Sessions
// are real library sessions at the fake AS; "in use" is seeded as rows of the
// migration-2 tables; free space comes from an injected statfs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_MAX_PER_RUN, runOAuthKeepalive } from '../../../src/bff/keepalive';
import type { OAuthService } from '../../../src/bff/oauth-client';
import { DEFAULT_MIN_FREE_BYTES } from '../../../src/node/config';
import { diskLowProbe, type StatfsFn } from '../../../src/node/disk';
import { withMigratedDb } from '../support/node-db';
import { createWorld, DAY_MS, freezeDate, type World, type WorldUser } from './oauth-world';

beforeEach(freezeDate);
afterEach(() => vi.useRealTimers());

const TIMEOUT = 60_000;

type Reason =
  | 'web_session'
  | 'lastfm_session'
  | 'app_password'
  | 'lb_token'
  | 'new_credential'
  | 'link'
  | 'operation'
  | 'import';

const REASONS: readonly Reason[] = [
  'web_session',
  'lastfm_session',
  'app_password',
  'lb_token',
  'new_credential',
  'link',
  'operation',
  'import',
];

let seq = 0;
const blob = () => {
  seq += 1;
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(0, seq);
  return b.buffer;
};

/** Make `did` in use (or, with `stale`, leave a row that does not count) for a run at `runAt`. */
function seed(w: World, did: string, reason: Reason, runAt: number, stale = false): void {
  const db = w.db;
  const now = w.clock.nowMs();
  const id = `${reason}-${seq + 1}`;
  switch (reason) {
    case 'web_session':
      db.run(
        'INSERT INTO web_sessions (token_hash, did, created_at_ms, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)',
        blob(),
        did,
        now,
        stale ? runAt - 1 : runAt + DAY_MS,
        now,
      );
      break;
    case 'lastfm_session':
      db.run(
        'INSERT INTO lastfm_sessions (id, sk_hash, did, api_key, client_name, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        blob(),
        did,
        'k'.repeat(32),
        'Pano',
        now - 200 * DAY_MS,
        stale ? runAt - 91 * DAY_MS : runAt - 89 * DAY_MS,
      );
      break;
    case 'app_password':
    case 'lb_token':
      db.run(
        `INSERT INTO ${reason === 'app_password' ? 'app_passwords' : 'lb_tokens'} (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        did,
        'phone',
        blob(),
        now - 200 * DAY_MS,
        stale ? runAt - 91 * DAY_MS : runAt - DAY_MS,
      );
      break;
    case 'new_credential':
      // Never used: it counts from its creation.
      db.run(
        'INSERT INTO app_passwords (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, NULL)',
        id,
        did,
        'new',
        blob(),
        stale ? runAt - 91 * DAY_MS : runAt - 2 * DAY_MS,
      );
      break;
    case 'link':
      db.run(
        `INSERT INTO linked_accounts (id, did, service, remote_user, credential_ciphertext, key_id, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'listenbrainz', 'remote', ?, 'e1', ?, ?, ?)`,
        id,
        did,
        blob(),
        stale ? 'revoked' : 'active',
        now,
        now,
      );
      break;
    case 'operation':
      w.seedOperation(id, did, stale ? 'succeeded' : ['queued', 'running', 'blocked'][seq % 3]!);
      seq += 1;
      break;
    case 'import':
      db.run(
        "INSERT INTO import_jobs (id, did, source, state, created_at_ms, updated_at_ms) VALUES (?, ?, 'lastfm_api', ?, ?, ?)",
        id,
        did,
        stale ? 'done' : 'fetching',
        now,
        now,
      );
      break;
  }
}

async function signInMany(w: World, svc: OAuthService, n: number, prefix: string): Promise<WorldUser[]> {
  const users: WorldUser[] = [];
  for (let i = 0; i < n; i++) {
    const u = await w.addUser(`${prefix}${i}`);
    await w.signIn(svc, u);
    w.seedAccount(u.did, `${prefix}${i}`);
    users.push(u);
  }
  return users;
}

const refreshCount = (w: World, did: string) => w.as.sessions(did).at(-1)?.refreshCount ?? -1;

describe('oauth-keepalive', () => {
  it(
    'after advancing 31 days, sessions of DIDs in use last refreshed over 30 days ago are refreshed once each, at most 20 per run',
    async () => {
      await withMigratedDb(async (db) => {
        const w = await createWorld(db);
        const svc = w.service();
        const due = await signInMany(w, svc, 22, 'old');
        // One more DID signs in 21 days later: at the run its session is only 10 days old.
        w.advance(21 * DAY_MS);
        const [recent] = await signInMany(w, svc, 1, 'new');
        w.advance(10 * DAY_MS);
        const runAt = w.clock.nowMs();
        for (const [i, u] of due.entries()) seed(w, u.did, REASONS[i % REASONS.length]!, runAt);
        seed(w, recent!.did, 'web_session', runAt);
        const deps = { db, clock: w.clock, log: w.log, oauth: svc, diskLow: () => false };

        const first = await runOAuthKeepalive(deps);
        expect(first.status).toBe('ok');
        expect(first.refreshed).toHaveLength(KEEPALIVE_MAX_PER_RUN);
        expect(KEEPALIVE_MAX_PER_RUN).toBe(20);
        expect(first.signedOut).toEqual([]);
        expect(first.failed).toEqual([]);
        expect(first.deferred).toBe(2);
        // Oldest first, ties by DID: the first 20 of the 22.
        expect(first.refreshed).toEqual(due.slice(0, 20).map((u) => u.did));
        for (const u of due.slice(0, 20)) expect(refreshCount(w, u.did)).toBe(1);
        for (const u of due.slice(20)) expect(refreshCount(w, u.did)).toBe(0);
        expect(refreshCount(w, recent!.did)).toBe(0);
        const rows = new Map(w.sessionRows().map((r) => [r.did, r]));
        for (const u of due.slice(0, 20)) expect(rows.get(u.did)?.last_refresh_ms).toBe(runAt);

        // The next run (an hour later) takes the two left; nobody is refreshed twice.
        w.advance(3_600_000);
        const second = await runOAuthKeepalive(deps);
        expect(second.refreshed).toEqual(due.slice(20).map((u) => u.did));
        expect(second.deferred).toBe(0);
        for (const u of due) expect(refreshCount(w, u.did)).toBe(1);
        expect(refreshCount(w, recent!.did)).toBe(0);

        const third = await runOAuthKeepalive(deps);
        expect(third).toMatchObject({ refreshed: [], signedOut: [], deferred: 0 });
        expect(w.as.revocations).toEqual([]);
        for (const u of [...due, recent!]) expect(w.accountStatus(u.did)).toBe('active');
      });
    },
    TIMEOUT,
  );

  it(
    'a DID with no live web session, no credential used in 90 days, no active link, no pending operation and no unfinished import is revoked upstream and marked signed_out instead of refreshed',
    async () => {
      await withMigratedDb(async (db) => {
        const w = await createWorld(db);
        const svc = w.service();
        const [idle, busy] = await signInMany(w, svc, 2, 'u');
        w.advance(60 * DAY_MS); // due (over 30 days) and inside the AS's 3-month refresh window
        const runAt = w.clock.nowMs();
        // Every kind of row, each one not counting: expired, unused for 91 days, revoked, finished.
        for (const r of REASONS) seed(w, idle!.did, r, runAt, true);
        seed(w, busy!.did, 'lb_token', runAt);
        const credentialsBefore = db.all('SELECT id FROM app_passwords WHERE did = ? ORDER BY id', idle!.did);
        expect(credentialsBefore.length).toBe(2);

        const report = await runOAuthKeepalive({ db, clock: w.clock, log: w.log, oauth: svc, diskLow: () => false });
        expect(report.signedOut).toEqual([idle!.did]);
        expect(report.refreshed).toEqual([busy!.did]);
        // Revoked upstream, not refreshed.
        expect(refreshCount(w, idle!.did)).toBe(0);
        expect(w.as.revocations.map((r) => [r.sub, r.source])).toEqual([[idle!.did, 'endpoint']]);
        expect(w.as.sessions(idle!.did)[0]?.revoked).not.toBeNull();
        expect(w.sessionRows().map((r) => r.did)).toEqual([busy!.did]);
        expect(w.accountStatus(idle!.did)).toBe('signed_out');
        expect(w.revocations.entries()).toEqual([{ kind: 'oauth_session', did: idle!.did, at: runAt }]);
        // Its protocol credentials stay (a later scrobble waits as blocked until sign-in).
        expect(db.all('SELECT id FROM app_passwords WHERE did = ? ORDER BY id', idle!.did)).toEqual(credentialsBefore);
        // The busy DID was refreshed and stays active.
        expect(refreshCount(w, busy!.did)).toBe(1);
        expect(w.accountStatus(busy!.did)).toBe('active');
      });
    },
    TIMEOUT,
  );

  it(
    'below ATMUSIC_MIN_FREE_BYTES the keepalive refreshes nothing and reports low_disk',
    async () => {
      await withMigratedDb(async (db, ctx) => {
        const w = await createWorld(db);
        const svc = w.service();
        const [u] = await signInMany(w, svc, 1, 'u');
        w.advance(31 * DAY_MS);
        seed(w, u!.did, 'web_session', w.clock.nowMs());
        let free = BigInt(DEFAULT_MIN_FREE_BYTES) - 1n;
        const statfs: StatfsFn = () => ({ bavail: free, bsize: 1n });
        const deps = {
          db,
          clock: w.clock,
          log: w.log,
          oauth: svc,
          diskLow: diskLowProbe(ctx.dir, DEFAULT_MIN_FREE_BYTES, statfs),
        };
        const tokenCalls = w.as.count('/oauth/token');

        const paused = await runOAuthKeepalive(deps);
        expect(paused).toEqual({ status: 'low_disk', refreshed: [], signedOut: [], failed: [], deferred: 0 });
        expect(w.as.count('/oauth/token')).toBe(tokenCalls);
        expect(refreshCount(w, u!.did)).toBe(0);
        expect(w.logs.some((l) => l.event === 'oauth_keepalive_paused' && l.fields.reason === 'low_disk')).toBe(true);

        // At the floor exactly, it runs again.
        free = BigInt(DEFAULT_MIN_FREE_BYTES);
        const resumed = await runOAuthKeepalive(deps);
        expect(resumed.status).toBe('ok');
        expect(resumed.refreshed).toEqual([u!.did]);
        expect(refreshCount(w, u!.did)).toBe(1);
      });
    },
    TIMEOUT,
  );
});
