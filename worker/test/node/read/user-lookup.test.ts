// N2-06: protocol user names (ADR 0005 §9; review finding 20, §20).
//
// users rows (the verified handle is what the identity sweep stores, lowercase)
// and accounts rows (the local username) are seeded directly: they are what
// admission, the identity sweep and the first sign-in leave behind.

import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { hasStaleDottedUsername, lookupUser, lookupUserStep } from '../../../src/do/read/user-lookup';
import { withMigratedDb } from '../support/node-db';

const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const JOINED = toStorage(fromMs(NOW_MS));

const did = (c: string) => `did:plc:${c.repeat(24)}`;
const ALICE = did('a');
const BOB = did('b');
const CAROL = did('c');
const DAVE = did('d');
const ERIN = did('e');
const XAVIER = did('x');
const YUKI = did('y');
const ZED = did('z');

function seedUser(db: Db, d: string, o: { handle?: string | null; username?: string; active?: boolean } = {}): void {
  db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, ?, ?, 'active', 'current', 1)`,
    d,
    o.handle ?? null,
    JOINED,
    o.active === false ? 0 : 1,
  );
  if (o.username !== undefined) {
    db.run(
      'INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      d,
      o.username,
      NOW_MS,
      NOW_MS,
    );
  }
}

describe('protocol user lookup', () => {
  it('a dotless username, a verified handle in any case and a DID resolve to the same user; unknown, inactive and suppressed users are not found', async () => {
    await withMigratedDb((db) => {
      seedUser(db, ALICE, { handle: 'alice.test', username: 'alice' });
      seedUser(db, BOB, { handle: 'bob.test', username: 'bob', active: false });
      seedUser(db, CAROL, { handle: 'carol.test' });
      seedUser(db, DAVE, { handle: 'dave.test', username: 'dave' });
      db.run('INSERT INTO suppression(did, suppressed_at) VALUES (?, ?)', DAVE, JOINED);
      seedUser(db, ERIN);
      const m = { db };

      const expected = { did: ALICE, username: 'alice', handle: 'alice.test', name: 'alice', joinedAt: JOINED };
      for (const [value, step] of [
        ['alice', 'username'],
        ['ALICE', 'username'],
        ['alice.test', 'handle'],
        ['Alice.TEST', 'handle'],
        [ALICE, 'did'],
      ] as const) {
        expect(lookupUserStep(m, value)).toEqual({ user: expected, step });
      }

      // Jetstream-only users have no username: named by handle, else by DID.
      expect(lookupUser(m, 'CAROL.test')).toEqual({
        did: CAROL,
        username: null,
        handle: 'carol.test',
        name: 'carol.test',
        joinedAt: JOINED,
      });
      expect(lookupUser(m, ERIN)?.name).toBe(ERIN);
      // A dotless value is never a handle; Carol has no username.
      expect(lookupUser(m, 'carol')).toBeNull();

      // Unknown, inactive and suppressed users are not found by any form.
      for (const value of [
        'nobody',
        'nobody.test',
        did('q'),
        'bob',
        'bob.test',
        BOB,
        'dave',
        'dave.test',
        DAVE,
        '',
        'did:',
      ]) {
        expect(lookupUser(m, value)).toBeNull();
      }
      // A DID is case-sensitive, and only ASCII letters fold.
      expect(lookupUser(m, ALICE.toUpperCase())).toBeNull();
      expect(lookupUser(m, 'ALİCE')).toBeNull();
      expect(lookupUser(m, 'Kate.test')).toBeNull();
    });
  });

  it("user=<handle> resolves to the handle's DID even when a stale dotted username of another account equals it", async () => {
    await withMigratedDb((db) => {
      // Xavier's username was his handle when he signed in; he has since changed it.
      seedUser(db, XAVIER, { handle: 'robert.test', username: 'bob.test' });
      // Bob now holds the verified handle bob.test.
      seedUser(db, BOB, { handle: 'bob.test', username: 'bob' });
      // Yuki's dotted username is still her own verified handle.
      seedUser(db, YUKI, { handle: 'yuki.test', username: 'yuki.test' });
      // Zed's stale dotted username is nobody's handle now.
      seedUser(db, ZED, { handle: 'zed2.test', username: 'zed.test' });
      const m = { db };

      expect(lookupUserStep(m, 'bob.test')).toMatchObject({ user: { did: BOB, name: 'bob' }, step: 'handle' });
      expect(lookupUserStep(m, 'BOB.TEST')).toMatchObject({ user: { did: BOB }, step: 'handle' });
      expect(lookupUser(m, 'bob')?.did).toBe(BOB);
      // Xavier is still reachable by his current handle and his DID, named by his username.
      expect(lookupUser(m, 'robert.test')).toMatchObject({ did: XAVIER, name: 'bob.test', handle: 'robert.test' });
      expect(lookupUser(m, XAVIER)?.did).toBe(XAVIER);
      expect(lookupUserStep(m, 'yuki.test')).toMatchObject({ user: { did: YUKI }, step: 'dotted_username' });
      expect(lookupUser(m, 'zed.test')).toBeNull();

      expect([XAVIER, BOB, YUKI, ZED].map((d) => hasStaleDottedUsername(m, d))).toEqual([true, false, false, true]);

      // When Bob's handle verification lapses, bob.test still never falls back to Xavier.
      db.run('UPDATE users SET handle = NULL WHERE did = ?', BOB);
      expect(lookupUser(m, 'bob.test')).toBeNull();
      // And if Xavier verifies bob.test again, his dotted username counts once more.
      db.run('UPDATE users SET handle = ? WHERE did = ?', 'bob.test', XAVIER);
      expect(lookupUserStep(m, 'bob.test')).toMatchObject({ user: { did: XAVIER }, step: 'dotted_username' });
    });
  });
});
