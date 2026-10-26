// ListenBrainz user tokens (ADR 0005 §8.2, §9; N2-09).
//
// A migrated temporary node:sqlite database, the frozen clock, a seeded
// Random and the in-memory revocation journal (N1-08).

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LbTokenRow } from '../../../src/app/rows';
import { type CredentialDeps, ensureAccount } from '../../../src/credentials/accounts';
import { createLbToken, listLbTokens, revokeLbToken, verifyLbToken } from '../../../src/credentials/lb-tokens';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ListenBrainz tokens (ADR §8.2)', () => {
  it('a UUIDv4 token is returned once, stored hashed, resolves to the DID and username, and fails after revoke', async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const memory = new MemoryRevocations(clock);
      const deps: CredentialDeps = { db, clock, random: seededRandom(3), revocations: memory };
      db.run(
        "INSERT INTO users (did, handle, joined_at) VALUES (?, 'alice.bsky.social', '2026-01-15T12:00:00.000000000Z')",
        ALICE,
      );
      ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.bsky.social' });
      // The sign-in that verified bob.example.com also recorded it in users (the OAuth callback does).
      db.run(
        "INSERT INTO users (did, handle, joined_at) VALUES (?, 'bob.example.com', '2026-01-15T12:00:00.000000000Z')",
        BOB,
      );
      ensureAccount(deps, { did: BOB, verifiedHandle: 'bob.example.com' });

      const created = createLbToken(deps, { did: ALICE, label: 'Navidrome' });
      expect(created.token).toMatch(UUID_V4);
      expect(created).toMatchObject({ label: 'Navidrome', createdAtMs: clock.nowMs() });
      const bobs = createLbToken(deps, { did: BOB, label: null });
      expect(bobs.token).not.toBe(created.token);

      // Stored as SHA-256 only; the listing is metadata.
      const row = db.one<LbTokenRow>('SELECT * FROM lb_tokens WHERE id = ?', created.id);
      expect(Buffer.from(row!.hash).toString('hex')).toBe(createHash('sha256').update(created.token).digest('hex'));
      expect(Object.values(row!).some((v) => v === created.token)).toBe(false);
      const listed = listLbTokens(db, ALICE);
      expect(listed).toEqual([{ id: created.id, label: 'Navidrome', createdAtMs: clock.nowMs(), lastUsedMs: null }]);
      expect(JSON.stringify(listed)).not.toContain(created.token);

      // Resolves to the DID and the ListenBrainz user_name (the username), in any case.
      expect(verifyLbToken(deps, created.token)).toEqual({ id: created.id, did: ALICE, username: 'alice.bsky.social' });
      expect(verifyLbToken(deps, created.token.toUpperCase())?.did).toBe(ALICE);
      expect(verifyLbToken(deps, bobs.token)).toEqual({ id: bobs.id, did: BOB, username: 'bob.example.com' });
      expect(listLbTokens(db, ALICE)[0]?.lastUsedMs).toBe(clock.nowMs());
      db.run("UPDATE accounts SET username = 'alice' WHERE did = ?", ALICE);
      expect(verifyLbToken(deps, created.token)?.username).toBe('alice');

      // Unknown values: a random UUID, a MetaBrainz OAuth token, garbage.
      expect(verifyLbToken(deps, '6f1c0d3e-0f0a-4b2b-9b9b-1234567890ab')).toBe(null);
      expect(verifyLbToken(deps, 'meba_0123456789abcdef')).toBe(null);
      expect(verifyLbToken(deps, '')).toBe(null);

      // Revoked: fails; Bob's token is unaffected; one journal entry with the id only.
      expect(revokeLbToken(deps, BOB, created.id)).toBe(false);
      expect(revokeLbToken(deps, ALICE, created.id)).toBe(true);
      expect(verifyLbToken(deps, created.token)).toBe(null);
      expect(verifyLbToken(deps, bobs.token)?.did).toBe(BOB);
      expect(memory.entries()).toEqual([{ kind: 'lb_token', id: created.id, did: ALICE, at: clock.nowMs() }]);
      expect(memory.text()).not.toContain(created.token);
    });
  });
});
