// Local accounts and protocol user names (ADR 0005 §6.4, §9; N2-09).
//
// Runs on a migrated temporary node:sqlite database (N1-01, N1-10) with the
// frozen clock. Verified handles are seeded into `users.handle`, the column
// the identity sweeps keep bidirectionally verified.

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import {
  ensureAccount,
  RENAME_ERROR_STATUS,
  renameAccount,
  resolveUserDid,
  touchLastUsed,
} from '../../../src/credentials/accounts';
import type { Db } from '../../../src/do/db';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:alice000000000000000000';
const ALICE2 = 'did:plc:alicenew0000000000000000';
const CAROL = 'did:plc:carol000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const JOINED = '2026-01-15T12:00:00.000000000Z';

function setHandle(db: Db, did: string, handle: string | null): void {
  db.run(
    `INSERT INTO users (did, handle, joined_at) VALUES (?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET handle = excluded.handle`,
    did,
    handle,
    JOINED,
  );
}

const username = (db: Db, did: string): string | null =>
  db.one<{ username: string }>('SELECT username FROM accounts WHERE did = ?', did)?.username ?? null;

describe('accounts and usernames (ADR §9)', () => {
  it('first sign-in creates username alice.bsky.social from the verified handle; a collision becomes alice.bsky.social-2; renaming to a taken name in another case fails with username_taken', async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const deps = { db, clock };

      // First sign-in of the DID holding alice.bsky.social (handle typed in mixed case).
      setHandle(db, ALICE, 'alice.bsky.social');
      const first = ensureAccount(deps, { did: ALICE, verifiedHandle: 'Alice.Bsky.Social' });
      expect(first.created).toBe(true);
      expect(first.account).toMatchObject({
        did: ALICE,
        username: 'alice.bsky.social',
        oauth_status: 'active',
        share_now_playing: 1,
        import_share_pct: 50,
        daily_listen_cap: 3000,
        created_at_ms: clock.nowMs(),
        updated_at_ms: clock.nowMs(),
      });

      // A later sign-in never changes the name, even after a handle change.
      setHandle(db, ALICE, 'alice.example.com');
      clock.advance(1000);
      const again = ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.example.com' });
      expect(again.created).toBe(false);
      expect(again.account.username).toBe('alice.bsky.social');
      expect(again.account.updated_at_ms).toBe(Date.parse('2026-01-15T12:00:00Z'));

      // The handle now belongs to another DID; its first sign-in collides with the stale name.
      setHandle(db, ALICE2, 'alice.bsky.social');
      const second = ensureAccount(deps, { did: ALICE2, verifiedHandle: 'alice.bsky.social' });
      expect(second.created).toBe(true);
      expect(second.account.username).toBe('alice.bsky.social-2');
      // The stale dotted username never shadows the handle's real owner (§9 step 3).
      expect(resolveUserDid(db, 'alice.bsky.social')).toBe(ALICE2);
      expect(resolveUserDid(db, 'alice.bsky.social-2')).toBe(null);
      expect(resolveUserDid(db, 'ALICE.example.com')).toBe(ALICE);
      expect(resolveUserDid(db, ALICE)).toBe(ALICE);

      // A dotless rename, then another account asks for it in another case.
      expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({
        ok: true,
        changed: true,
        account: { username: 'alice', updated_at_ms: clock.nowMs() },
      });
      expect(resolveUserDid(db, 'ALICE')).toBe(ALICE);
      setHandle(db, CAROL, 'carol.example.com');
      ensureAccount(deps, { did: CAROL, verifiedHandle: 'carol.example.com' });
      const taken = renameAccount(deps, { did: CAROL, username: 'ALICE' });
      expect(taken).toEqual({ ok: false, error: 'username_taken' });
      expect(RENAME_ERROR_STATUS.username_taken).toBe(409);
      expect(username(db, CAROL)).toBe('carol.example.com');
      expect(username(db, ALICE)).toBe('alice');

      // Renaming to one's own current name in another case is a no-op, not a collision.
      expect(renameAccount(deps, { did: ALICE, username: 'Alice' })).toMatchObject({ ok: true, changed: false });
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM accounts')?.n).toBe(3);
    });
  });

  it("renaming to another DID's verified handle, or to any dotted name other than the caller's own verified handle, fails with username_invalid", async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const deps = { db, clock };
      setHandle(db, ALICE, 'alice.bsky.social');
      ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.bsky.social' });
      expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({ ok: true, changed: true });
      // Bob has a verified handle but has never signed in: no account holds bob.com.
      setHandle(db, BOB, 'bob.com');
      expect(db.one('SELECT 1 AS one FROM accounts WHERE did = ?', BOB)).toBe(null);

      const refused = [
        'bob.com', // another DID's verified handle
        'BOB.COM', // the same in another case
        'carol.example.com', // dotted, nobody's handle
        'alice.bsky.social-2', // dotted, not the caller's handle
        'alice.', // dotted
      ];
      for (const name of refused) {
        expect(renameAccount(deps, { did: ALICE, username: name }), name).toEqual({
          ok: false,
          error: 'username_invalid',
        });
      }
      // A caller-supplied verified handle does not let anyone take another DID's verified handle.
      expect(renameAccount(deps, { did: ALICE, username: 'bob.com', verifiedHandle: 'bob.com' })).toEqual({
        ok: false,
        error: 'username_invalid',
      });
      // Malformed names are invalid too, never silently cleaned.
      for (const name of ['a', '-alice', 'al ice', 'alïce', 'x'.repeat(65), '']) {
        expect(renameAccount(deps, { did: ALICE, username: name }), name).toEqual({
          ok: false,
          error: 'username_invalid',
        });
      }
      expect(RENAME_ERROR_STATUS.username_invalid).toBe(422);
      expect(username(db, ALICE)).toBe('alice');
      expect(resolveUserDid(db, 'bob.com')).toBe(BOB);

      // The caller's own verified handle is the one dotted name allowed, from users or from the caller.
      expect(renameAccount(deps, { did: ALICE, username: 'Alice.Bsky.Social' })).toMatchObject({
        ok: true,
        changed: true,
        account: { username: 'alice.bsky.social' },
      });
      expect(renameAccount(deps, { did: ALICE, username: 'alice' })).toMatchObject({ ok: true });
      expect(
        renameAccount(deps, { did: ALICE, username: 'alice.example.net', verifiedHandle: 'alice.example.net' }),
      ).toMatchObject({ ok: true, account: { username: 'alice.example.net' } });
      // Once the handle is no longer verified for the caller, the same dotted name is refused.
      expect(renameAccount(deps, { did: ALICE, username: 'alice.bsky.social', verifiedHandle: null })).toEqual({
        ok: false,
        error: 'username_invalid',
      });
      expect(username(db, ALICE)).toBe('alice.example.net');
      expect(renameAccount(deps, { did: CAROL, username: 'carol' })).toEqual({ ok: false, error: 'no_account' });
    });
  });

  it('last_used_ms is written at most once per minute', async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const hash = createHash('sha256').update('x').digest();
      db.run(
        'INSERT INTO app_passwords (id, did, label, hash, created_at_ms) VALUES (?, ?, NULL, ?, ?)',
        'p1',
        ALICE,
        hash.buffer.slice(hash.byteOffset, hash.byteOffset + 32),
        clock.nowMs(),
      );
      const lastUsed = () => db.one<{ v: number | null }>('SELECT last_used_ms AS v FROM app_passwords')?.v;
      const t0 = clock.nowMs();
      expect(touchLastUsed(db, 'app_passwords', 'p1', t0)).toBe(true);
      expect(touchLastUsed(db, 'app_passwords', 'p1', t0 + 59_999)).toBe(false);
      expect(lastUsed()).toBe(t0);
      expect(touchLastUsed(db, 'app_passwords', 'p1', t0 + 60_000)).toBe(true);
      expect(lastUsed()).toBe(t0 + 60_000);
    });
  });
});
