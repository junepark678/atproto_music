// App passwords (ADR 0005 §7.3; N2-09), and the revocation journal entries
// every credential revoke and delete writes before it commits (ADR §14.5).
//
// A migrated temporary node:sqlite database, the frozen clock, a seeded
// Random and the in-memory journal (N1-08); faults only through an injected
// Revocations whose record() throws.

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations, RevocationJournalError, type Revocations } from '../../../src/app/revocations';
import type { AppPasswordRow } from '../../../src/app/rows';
import { type CredentialDeps, CredentialError, ensureAccount } from '../../../src/credentials/accounts';
import {
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
  verifyAppPassword,
} from '../../../src/credentials/app-passwords';
import { createLastfmApp, deleteLastfmApp, issuedAppSecret } from '../../../src/credentials/lastfm-apps';
import { createSession, revokeLastfmSession, verifySessionKey } from '../../../src/credentials/lastfm-auth';
import { createLbToken, revokeLbToken, verifyLbToken } from '../../../src/credentials/lb-tokens';
import { createBox } from '../../../src/crypto/box';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const BASE32_24 = /^[a-z2-7]{24}$/;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hex = (b: ArrayBuffer): string => Buffer.from(b).toString('hex');
const count = (db: SqliteDb, table: string): number =>
  db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? -1;

function setup(db: SqliteDb, revocations?: Revocations) {
  const clock = fixedClock();
  const random = seededRandom(11);
  const memory = new MemoryRevocations(clock);
  const deps: CredentialDeps = { db, clock, random, revocations: revocations ?? memory };
  const insertUser = "INSERT INTO users (did, handle, joined_at) VALUES (?, ?, '2026-01-15T12:00:00.000000000Z')";
  db.run(insertUser, ALICE, 'alice.bsky.social');
  db.run(insertUser, BOB, 'bob.example.com');
  ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.bsky.social' });
  ensureAccount(deps, { did: BOB, verifiedHandle: 'bob.example.com' });
  const box = createBox([{ id: 'k1', key: new Uint8Array(32).fill(9) }], random);
  return { deps, clock, memory, box };
}

describe('app passwords (ADR §7.3)', () => {
  it('a 24-char base32 app password is returned once, stored hashed, verified by username or handle, and fails after revoke', async () => {
    await withMigratedDb((db) => {
      const { deps, clock } = setup(db);
      const created = createAppPassword(deps, { did: ALICE, label: '  Pano on my phone ' });
      expect(created.password).toMatch(BASE32_24);
      expect(created).toMatchObject({ label: 'Pano on my phone', createdAtMs: clock.nowMs() });

      // Stored as SHA-256 only: no column and no listing holds the plaintext.
      const rows = db.all<AppPasswordRow>('SELECT * FROM app_passwords');
      expect(rows).toHaveLength(1);
      expect(hex(rows[0]!.hash)).toBe(sha256Hex(created.password));
      expect(rows[0]).toMatchObject({ id: created.id, did: ALICE, label: 'Pano on my phone', last_used_ms: null });
      expect(Object.values(rows[0]!).some((v) => v === created.password)).toBe(false);
      const listed = listAppPasswords(db, ALICE);
      expect(listed).toEqual([
        { id: created.id, label: 'Pano on my phone', createdAtMs: clock.nowMs(), lastUsedMs: null },
      ]);
      expect(JSON.stringify(listed)).not.toContain(created.password);

      // Returned once: a second password is a different value, and nothing re-reveals the first.
      const second = createAppPassword(deps, { did: ALICE });
      expect(second.password).not.toBe(created.password);
      expect(second.label).toBe(null);

      // Verified by username, by verified handle in any case, and by DID.
      const want = { id: created.id, did: ALICE };
      expect(verifyAppPassword(deps, { username: 'alice.bsky.social', password: created.password })).toEqual(want);
      expect(verifyAppPassword(deps, { username: 'Alice.BSKY.social', password: created.password })).toEqual(want);
      expect(verifyAppPassword(deps, { username: ALICE, password: created.password })).toEqual(want);
      expect(listAppPasswords(db, ALICE).find((p) => p.id === created.id)?.lastUsedMs).toBe(clock.nowMs());
      // ... after a dotless rename, by the new username too.
      db.run("UPDATE accounts SET username = 'alice' WHERE did = ?", ALICE);
      expect(verifyAppPassword(deps, { username: 'ALICE', password: created.password })).toEqual(want);
      // Grouping a user may type is tolerated; the value is still the same 120 bits.
      const grouped = `${created.password.slice(0, 12).toUpperCase()} ${created.password.slice(12)}`;
      expect(verifyAppPassword(deps, { username: 'alice', password: grouped })).toEqual(want);

      // The right password for the wrong user, a wrong password, or an unknown user: null.
      expect(verifyAppPassword(deps, { username: 'bob.example.com', password: created.password })).toBe(null);
      expect(verifyAppPassword(deps, { username: 'alice', password: 'a'.repeat(24) })).toBe(null);
      expect(verifyAppPassword(deps, { username: 'alice', password: `${created.password}x` })).toBe(null);
      expect(verifyAppPassword(deps, { username: 'nobody', password: created.password })).toBe(null);

      // Only signed-in DIDs hold credentials.
      expect(() => createAppPassword(deps, { did: 'did:plc:stranger000000000000000', label: 'x' })).toThrow(
        CredentialError,
      );
      expect(() => createAppPassword(deps, { did: ALICE, label: 'x'.repeat(65) })).toThrow(CredentialError);
      expect(count(db, 'app_passwords')).toBe(2);

      // Revoked: fails at once; the other password still works.
      expect(revokeAppPassword(deps, BOB, created.id)).toBe(false);
      expect(revokeAppPassword(deps, ALICE, created.id)).toBe(true);
      expect(verifyAppPassword(deps, { username: 'alice', password: created.password })).toBe(null);
      expect(verifyAppPassword(deps, { username: 'alice', password: second.password })).toEqual({
        id: second.id,
        did: ALICE,
      });
      expect(listAppPasswords(db, ALICE).map((p) => p.id)).toEqual([second.id]);
    });
  });

  it('revoking an app password, a ListenBrainz token, a Last.fm session or an issued app appends one revocation journal entry holding its id and no secret', async () => {
    await withMigratedDb((db) => {
      const { deps, clock, memory, box } = setup(db);
      const password = createAppPassword(deps, { did: ALICE, label: 'phone' });
      const lb = createLbToken(deps, { did: ALICE, label: 'navidrome' });
      const session = createSession(deps, { did: ALICE, apiKey: 'panoScrobbler', clientName: 'Pano' });
      const app = createLastfmApp({ ...deps, box }, { did: ALICE, name: 'my client' });
      const secrets = [password.password, lb.token, session.key, app.sharedSecret];
      const hashes = [password.password, lb.token, session.key].map(sha256Hex);

      // Refused revokes (another DID's id, an unknown id) journal nothing.
      expect(revokeAppPassword(deps, BOB, password.id)).toBe(false);
      expect(revokeLbToken(deps, ALICE, 'missing')).toBe(false);
      expect(revokeLastfmSession(deps, BOB, session.id)).toBe(false);
      expect(deleteLastfmApp(deps, BOB, app.apiKey)).toBe(false);
      expect(memory.entries()).toEqual([]);

      const at = clock.nowMs();
      expect(revokeAppPassword(deps, ALICE, password.id)).toBe(true);
      expect(memory.entries()).toHaveLength(1);
      expect(revokeLbToken(deps, ALICE, lb.id)).toBe(true);
      expect(memory.entries()).toHaveLength(2);
      expect(revokeLastfmSession(deps, ALICE, session.id)).toBe(true);
      expect(memory.entries()).toHaveLength(3);
      expect(deleteLastfmApp(deps, ALICE, app.apiKey)).toBe(true);
      expect(memory.entries()).toEqual([
        { kind: 'app_password', id: password.id, did: ALICE, at },
        { kind: 'lb_token', id: lb.id, did: ALICE, at },
        { kind: 'lastfm_session', id: session.id, did: ALICE, at },
        { kind: 'lastfm_app', id: app.apiKey, did: ALICE, at },
      ]);
      // A second revoke of the same credential journals nothing more.
      expect(revokeAppPassword(deps, ALICE, password.id)).toBe(false);
      expect(memory.entries()).toHaveLength(4);

      // The journal text holds ids, never a secret or a credential hash.
      const text = memory.text();
      for (const secret of secrets) expect(text).not.toContain(secret);
      for (const hash of hashes) expect(text).not.toContain(hash);
      for (const line of text.trimEnd().split('\n')) {
        expect(Object.keys(JSON.parse(line))).toEqual(['kind', 'id', 'did', 'at']);
      }
      // The rows are gone and the credentials no longer verify.
      for (const table of ['app_passwords', 'lb_tokens', 'lastfm_sessions', 'lastfm_apps'])
        expect(count(db, table)).toBe(0);
      expect(verifyLbToken(deps, lb.token)).toBe(null);
      expect(verifySessionKey(deps, session.key)).toEqual({ ok: false, code: 9 });
      expect(issuedAppSecret({ db, box }, app.apiKey)).toBe(null);
    });
  });

  it('a journal write that fails rolls the revoke back and the credential stays valid', async () => {
    await withMigratedDb((db) => {
      let calls = 0;
      const failing: Revocations = {
        record() {
          calls++;
          throw new RevocationJournalError('write_failed', 'disk full');
        },
        entries: () => [],
        replay: () => ({ entries: 0, deleted: {} }),
        truncateBefore: () => 0,
      };
      const { deps, box } = setup(db, failing);
      const password = createAppPassword(deps, { did: ALICE });
      const lb = createLbToken(deps, { did: ALICE });
      const session = createSession(deps, { did: ALICE, apiKey: 'k' });
      const app = createLastfmApp({ ...deps, box }, { did: ALICE, name: 'app' });

      expect(() => revokeAppPassword(deps, ALICE, password.id)).toThrow(RevocationJournalError);
      expect(() => revokeLbToken(deps, ALICE, lb.id)).toThrow(RevocationJournalError);
      expect(() => revokeLastfmSession(deps, ALICE, session.id)).toThrow(RevocationJournalError);
      expect(() => deleteLastfmApp(deps, ALICE, app.apiKey)).toThrow(RevocationJournalError);
      expect(calls).toBe(4);

      for (const table of ['app_passwords', 'lb_tokens', 'lastfm_sessions', 'lastfm_apps'])
        expect(count(db, table)).toBe(1);
      expect(verifyAppPassword(deps, { username: ALICE, password: password.password })).not.toBe(null);
      expect(verifyLbToken(deps, lb.token)?.did).toBe(ALICE);
      expect(verifySessionKey(deps, session.key).ok).toBe(true);
      expect(issuedAppSecret({ db, box }, app.apiKey)?.secret).toBe(app.sharedSecret);
    });
  });
});
