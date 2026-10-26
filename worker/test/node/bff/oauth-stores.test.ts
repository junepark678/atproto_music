// N2-03: the sealed OAuth stores (ADR 0005 §5.5, §3.8, §13). Sessions are
// written by the real library through worker/src/bff/oauth-stores.ts against
// the fake AS and PDS; a storage failure is injected through the Db interface
// the store is given, never through production code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/do/db';
import { reopen, withMigratedDb } from '../support/node-db';
import { containsBytes, createWorld, DAY_MS, freezeDate, rawDbBytes } from './oauth-world';

beforeEach(freezeDate);
afterEach(() => vi.useRealTimers());

/** `db`, except that every statement touching oauth_sessions throws SQLITE_FULL while `failing.on`. */
function failingDb(db: Db, failing: { on: boolean; attempts: number }): Db {
  const guard = (sql: string) => {
    if (failing.on && /\boauth_sessions\b/.test(sql) && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
      failing.attempts += 1;
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    }
  };
  return {
    all(sql, ...p) {
      guard(sql);
      return db.all(sql, ...p);
    },
    one(sql, ...p) {
      guard(sql);
      return db.one(sql, ...p);
    },
    run(sql, ...p) {
      guard(sql);
      return db.run(sql, ...p);
    },
    tx: (fn) => db.tx(fn),
  };
}

describe('sealed OAuth stores', () => {
  it('the raw database file contains no access token, refresh token or DPoP private key bytes after a sign-in', async () => {
    await withMigratedDb(async (db, ctx) => {
      const w = await createWorld(db);
      const alice = await w.addUser('alice');
      const bob = await w.addUser('bob');
      const svc = w.service();
      await w.signIn(svc, alice);
      await w.signIn(svc, bob);

      const raw = rawDbBytes(ctx.path);
      for (const user of [alice, bob]) {
        const asSession = w.as.sessions(user.did)[0]!;
        const stored = w.storedSession(user.did)!;
        // Non-vacuity: the sealed row decrypts to exactly these secrets, and the scan sees its ciphertext.
        expect(stored.tokenSet.access_token).toBe(asSession.accessToken);
        expect(stored.tokenSet.refresh_token).toBe(asSession.refreshToken);
        expect(stored.dpopJwk.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const row = db.one<{ ciphertext: ArrayBuffer; key_id: string }>(
          'SELECT ciphertext, key_id FROM oauth_sessions WHERE did = ?',
          user.did,
        )!;
        expect(row.key_id).toBe('e1');
        expect(containsBytes(raw, Buffer.from(row.ciphertext))).toBe(true);

        expect(containsBytes(raw, asSession.accessToken)).toBe(false);
        expect(containsBytes(raw, asSession.refreshToken)).toBe(false);
        expect(containsBytes(raw, stored.dpopJwk.d!)).toBe(false);
        expect(containsBytes(raw, Buffer.from(stored.dpopJwk.d!, 'base64url'))).toBe(false);
      }
      // Nor any client signing key (they never enter the database).
      for (const k of w.secrets.oauthSigningKeys) {
        expect(containsBytes(raw, k.d)).toBe(false);
        expect(containsBytes(raw, Buffer.from(k.d, 'base64url'))).toBe(false);
      }

      // The AAD binds each value to its row: alice's ciphertext copied into bob's row does not open.
      db.run(
        'UPDATE oauth_sessions SET ciphertext = (SELECT ciphertext FROM oauth_sessions WHERE did = ?) WHERE did = ?',
        alice.did,
        bob.did,
      );
      expect(svc.sessionStore.get(bob.did)).toBeUndefined();
      expect(w.logs.some((l) => l.event === 'oauth_session_unreadable' && l.fields.did === bob.did)).toBe(true);
      expect(svc.sessionStore.get(alice.did)?.tokenSet.sub).toBe(alice.did);
    });
  });

  it('a rotated refresh token is persisted sealed before use, and after close and reopen the next refresh sends the rotated token', async () => {
    await withMigratedDb(async (db, ctx) => {
      const w = await createWorld(db);
      const alice = await w.addUser('alice');
      const svc = w.service();
      const signedIn = await w.signIn(svc, alice);
      const r0 = w.as.sessions(alice.did)[0]!.refreshToken;
      expect(w.storedSession(alice.did)?.tokenSet.refresh_token).toBe(r0);

      // The access token expires; the next PDS write refreshes first. When the write leaves,
      // the rotated refresh token must already be in the row, sealed.
      w.advance(3_600_000 + 60_000);
      let atFirstPdsRequest: { refresh?: string; generation?: number } | null = null;
      w.oauthObserver = (req) => {
        const url = new URL(req.url);
        // The first XRPC request (the issuer check before the refresh also reads the PDS's metadata).
        if (atFirstPdsRequest === null && url.hostname === w.pds.host && url.pathname.startsWith('/xrpc/')) {
          atFirstPdsRequest = {
            refresh: w.storedSession(alice.did)?.tokenSet.refresh_token,
            generation: w.sessionRows()[0]?.generation,
          };
        }
      };
      expect((await w.writeScrobble(signedIn.session, 1)).status).toBe(200);
      const r1 = w.as.sessions(alice.did)[0]!.refreshToken;
      expect(r1).not.toBe(r0);
      expect(atFirstPdsRequest).toEqual({ refresh: r1, generation: 2 });
      expect(containsBytes(rawDbBytes(ctx.path), r1)).toBe(false);
      w.oauthObserver = null;

      // Restart: close and reopen the database, and a new client with no memory of the session.
      w.db = reopen(db);
      const restarted = w.service();
      w.advance(DAY_MS);
      const mark = w.captured.length;
      await restarted.restore(alice.did, true);
      const refreshes = w.captured
        .slice(mark)
        .filter((c) => c.path === '/oauth/token' && c.status === 200)
        .map((c) => new URLSearchParams(c.body));
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]?.get('grant_type')).toBe('refresh_token');
      expect(refreshes[0]?.get('refresh_token')).toBe(r1);
      // A replayed r0 would have revoked the session; instead it rotated again and nothing was revoked.
      expect(w.as.revocations).toEqual([]);
      expect(w.as.sessions(alice.did)[0]?.refreshCount).toBe(2);
      const r2 = w.as.sessions(alice.did)[0]!.refreshToken;
      expect(w.storedSession(alice.did)?.tokenSet.refresh_token).toBe(r2);
      expect(w.sessionRows()[0]).toMatchObject({ generation: 3, last_refresh_ms: w.clock.nowMs() });
    });
  });

  it('when the oauth_sessions write fails during a refresh, set() does not throw, the next restore() uses the refreshed session from memory, oauth_store_degraded is raised, and the fake AS records no revocation', async () => {
    await withMigratedDb(async (db) => {
      const w = await createWorld(db);
      const alice = await w.addUser('alice');
      const failing = { on: false, attempts: 0 };
      const svc = w.service({ db: failingDb(db, failing) });
      await w.signIn(svc, alice);
      w.seedAccount(alice.did, 'alice');
      const before = w.sessionRows()[0];
      const t0 = w.as.sessions(alice.did)[0]!;
      const oldAccess = t0.accessToken;
      expect(svc.degraded()).toBe(false);

      failing.on = true;
      // The refresh succeeds at the AS; the store write fails; restore() still resolves.
      const refreshed = await svc.restore(alice.did, true);
      expect(failing.attempts).toBeGreaterThanOrEqual(1);
      const t1 = w.as.sessions(alice.did)[0]!;
      expect(t1.refreshCount).toBe(1);
      expect(t1.accessToken).not.toBe(oldAccess);
      expect(svc.degraded()).toBe(true);
      const failed = w.logs.filter((l) => l.event === 'oauth_store_write_failed');
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.fields).toMatchObject({ did: alice.did, error: 'Error', code: 'ERR_SQLITE_ERROR' });
      // The log line names no secret.
      const logged = JSON.stringify(w.logs);
      for (const secret of [t1.accessToken, t1.refreshToken, oldAccess, t0.refreshToken]) {
        expect(logged).not.toContain(secret);
      }
      // The row still holds the old session; memory holds the new one.
      expect(w.sessionRows()[0]).toEqual(before);
      expect(w.storedSession(alice.did)?.tokenSet.access_token).toBe(oldAccess);

      // The next restore() reads memory first: the refreshed token, no second refresh.
      const again = await svc.restore(alice.did);
      expect(svc.sessionStore.get(alice.did)?.tokenSet.access_token).toBe(t1.accessToken);
      const write = await w.writeScrobble(again, 1);
      expect(write.status).toBe(200);
      expect((await w.writeScrobble(refreshed, 2)).status).toBe(200);
      expect(w.as.sessions(alice.did)[0]?.refreshCount).toBe(1);
      // Nothing was revoked or deleted, and the account is untouched.
      expect(w.as.revocations).toEqual([]);
      expect(w.as.count('/oauth/revoke')).toBe(0);
      expect(w.accountStatus(alice.did)).toBe('active');
      expect(w.revocations.entries()).toEqual([]);
      // Still failing: still degraded, and each get retried the write.
      expect(svc.degraded()).toBe(true);
      expect(failing.attempts).toBeGreaterThanOrEqual(3);
    });
  });

  it('after the failing write recovers, the held session is persisted on the next get() and oauth_store_degraded clears', async () => {
    await withMigratedDb(async (db) => {
      const w = await createWorld(db);
      const alice = await w.addUser('alice');
      const failing = { on: false, attempts: 0 };
      const svc = w.service({ db: failingDb(db, failing) });
      await w.signIn(svc, alice);
      failing.on = true;
      w.advance(60_000);
      await svc.restore(alice.did, true);
      const t1 = w.as.sessions(alice.did)[0]!;
      expect(svc.degraded()).toBe(true);
      expect(w.sessionRows()[0]?.generation).toBe(1);

      // Storage recovers. Nothing is written until the store is used again…
      failing.on = false;
      expect(w.sessionRows()[0]?.generation).toBe(1);
      // …and the next get() persists the held session.
      expect(svc.sessionStore.get(alice.did)?.tokenSet.access_token).toBe(t1.accessToken);
      expect(svc.degraded()).toBe(false);
      expect(w.sessionRows()[0]).toMatchObject({ did: alice.did, generation: 2, last_refresh_ms: w.clock.nowMs() });
      expect(w.storedSession(alice.did)?.tokenSet).toMatchObject({
        access_token: t1.accessToken,
        refresh_token: t1.refreshToken,
      });
      expect(w.logs.some((l) => l.event === 'oauth_store_write_recovered' && l.fields.did === alice.did)).toBe(true);

      // A restarted client (no memory) refreshes with the persisted, rotated refresh token.
      const restarted = w.service();
      w.advance(DAY_MS);
      await restarted.restore(alice.did, true);
      expect(w.as.sessions(alice.did)[0]?.refreshCount).toBe(2);
      expect(w.as.revocations).toEqual([]);
    });
  });
});
