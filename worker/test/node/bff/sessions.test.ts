// Browser sessions (ADR 0005 §5.6, §14.5; N2-04): the __Host-atmusic_session
// cookie, SHA-256-only storage, 30-day expiry with renewal after 24 h, logout
// and logout-all journaled before the rows are deleted.
//
// Every test runs on a fresh migrated node:sqlite file (support/node-db.ts),
// the frozen clock 2026-01-15T12:00:00Z and a seeded Random. Faults reach the
// code only through the injected Revocations port.

import { createHash } from 'node:crypto';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import {
  MemoryRevocations,
  type RevocationEvent,
  RevocationJournalError,
  type Revocations,
} from '../../../src/app/revocations';
import {
  clearSessionCookie,
  createWebSessions,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  sessionTokenFromCookies,
  sweepExpiredWebSessions,
  type WebSessions,
} from '../../../src/bff/sessions';
import type { Db } from '../../../src/do/db';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { dumpDb, withMigratedDb } from '../support/node-db';

const T0 = Date.parse('2026-01-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

interface SessionRow {
  token_hash_hex: string;
  did: string;
  created_at_ms: number;
  expires_at_ms: number;
  last_seen_ms: number;
}

function rows(db: Db): SessionRow[] {
  return db.all<SessionRow>(
    'SELECT hex(token_hash) AS token_hash_hex, did, created_at_ms, expires_at_ms, last_seen_ms FROM web_sessions ORDER BY did, created_at_ms, token_hash',
  );
}

function setup(
  db: SqliteDb,
  revocations?: Revocations,
): { clock: FixedClock; sessions: WebSessions; journal: MemoryRevocations } {
  const clock = fixedClock();
  const journal = new MemoryRevocations(clock);
  const sessions = createWebSessions({ db, clock, random: seededRandom(7), revocations: revocations ?? journal });
  return { clock, sessions, journal };
}

/** Parse a Set-Cookie value into its name, value and attributes (lowercased names). */
function parseSetCookie(header: string): { name: string; value: string; attrs: Map<string, string | true> } {
  const [first, ...rest] = header.split(';').map((s) => s.trim());
  const eq = (first as string).indexOf('=');
  const attrs = new Map<string, string | true>();
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i === -1) attrs.set(part.toLowerCase(), true);
    else attrs.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
  }
  return { name: (first as string).slice(0, eq), value: (first as string).slice(eq + 1), attrs };
}

describe('web sessions', () => {
  it('create() sets __Host-atmusic_session with HttpOnly, Secure, SameSite=Lax, Path=/ and Max-Age=2592000, and stores only SHA-256 of the token', async () => {
    await withMigratedDb((db) => {
      const { sessions } = setup(db);
      const issued = sessions.create(ALICE);

      // The cookie: exactly the §5.6 attributes, no Domain (forbidden by __Host-).
      const cookie = parseSetCookie(issued.setCookie);
      expect(cookie.name).toBe('__Host-atmusic_session');
      expect(cookie.value).toBe(issued.token);
      expect(cookie.value).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.fromEntries(cookie.attrs)).toEqual({
        httponly: true,
        secure: true,
        samesite: 'Lax',
        path: '/',
        'max-age': '2592000',
      });
      expect(SESSION_MAX_AGE_S).toBe(2592000);

      // Storage: one row holding SHA-256(token) as a 32-byte BLOB, 30-day expiry.
      expect(rows(db)).toEqual([
        {
          token_hash_hex: sha256Hex(issued.token).toUpperCase(),
          did: ALICE,
          created_at_ms: T0,
          expires_at_ms: T0 + 30 * DAY,
          last_seen_ms: T0,
        },
      ]);
      expect(db.one<{ n: number }>('SELECT length(token_hash) AS n FROM web_sessions')?.n).toBe(32);
      expect(issued.tokenHash).toBe(sha256Hex(issued.token));
      expect(issued.expiresAtMs).toBe(T0 + 30 * DAY);

      // The token itself appears nowhere in the database, as text or as bytes.
      const dump = JSON.stringify(dumpDb(db));
      expect(dump).not.toContain(issued.token);
      expect(dump.toLowerCase()).not.toContain(Buffer.from(issued.token, 'utf8').toString('hex'));
      expect(dump.toLowerCase()).toContain(sha256Hex(issued.token));

      // Two sessions get distinct tokens and rows; the cookie round-trips.
      const second = sessions.create(ALICE);
      expect(second.token).not.toBe(issued.token);
      expect(rows(db)).toHaveLength(2);
      expect(sessions.resolveCookieHeader(`theme=dark; ${SESSION_COOKIE}=${issued.token}`)?.did).toBe(ALICE);

      // A DID the revocation journal would refuse is refused here too, so no
      // stored session is ever unrevocable; nothing is written.
      for (const bad of ['did:Web:Example', 'did:plc:', 'did:plc:a%zz', 'did:plc:a b', 'notadid', '']) {
        expect(() => sessions.create(bad)).toThrow(TypeError);
      }
      expect(rows(db)).toHaveLength(2);
      expect(clearSessionCookie()).toBe('__Host-atmusic_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    });
  });

  it('unknown, expired and logged-out tokens resolve to no session; a session older than 24 h is renewed with the same token', async () => {
    await withMigratedDb((db) => {
      const { clock, sessions, journal } = setup(db);
      const issued = sessions.create(ALICE);

      // Unknown: well-formed but never issued; malformed and repeated cookies.
      expect(sessions.resolve('0'.repeat(64))).toBeNull();
      expect(sessions.resolve(issued.token.toUpperCase())).toBeNull();
      expect(sessions.resolve(issued.token.slice(1))).toBeNull();
      expect(sessions.resolve(null)).toBeNull();
      expect(
        sessionTokenFromCookies(`${SESSION_COOKIE}=${issued.token}; ${SESSION_COOKIE}=${issued.token}`),
      ).toBeNull();
      expect(sessions.resolveCookieHeader(`atmusic_session=${issued.token}`)).toBeNull();

      // Fresh: resolves without a write and without a renewal cookie.
      const fresh = sessions.resolve(issued.token);
      expect(fresh).toMatchObject({ did: ALICE, token: issued.token, expiresAtMs: T0 + 30 * DAY, renewCookie: null });
      expect(fresh?.tokenHash).toBe(sha256Hex(issued.token));

      // Exactly 24 h old: not yet renewed (renewal is "more than 24 hours").
      clock.advance(DAY);
      expect(sessions.resolve(issued.token)?.renewCookie).toBeNull();
      expect(rows(db)[0]?.expires_at_ms).toBe(T0 + 30 * DAY);

      // Older than 24 h: lookup() alone neither renews nor writes ...
      clock.advance(1);
      const beforeLookup = rows(db);
      expect(sessions.lookup(issued.token)).toMatchObject({
        did: ALICE,
        token: issued.token,
        expiresAtMs: T0 + 30 * DAY,
        renewCookie: null,
      });
      expect(sessions.lookupCookieHeader(`${SESSION_COOKIE}=${issued.token}`)?.renewCookie).toBeNull();
      expect(rows(db)).toEqual(beforeLookup);
      // ... and resolve() (lookup then renew) renews in place with the same token and row.
      const renewed = sessions.resolve(issued.token);
      const now = T0 + DAY + 1;
      expect(renewed).toMatchObject({ did: ALICE, token: issued.token, expiresAtMs: now + 30 * DAY, lastSeenMs: now });
      const cookie = parseSetCookie(renewed?.renewCookie as string);
      expect(cookie.name).toBe(SESSION_COOKIE);
      expect(cookie.value).toBe(issued.token);
      expect(cookie.attrs.get('max-age')).toBe('2592000');
      expect(rows(db)).toEqual([
        {
          token_hash_hex: sha256Hex(issued.token).toUpperCase(),
          did: ALICE,
          created_at_ms: T0,
          expires_at_ms: now + 30 * DAY,
          last_seen_ms: now,
        },
      ]);
      // The next resolve within the new term does not renew again.
      expect(sessions.resolve(issued.token)?.renewCookie).toBeNull();

      // Expiry boundary. `issued` (renewed at `now`) and a second session
      // created at `now` both expire at now + 30 d. Any resolve after 24 h
      // renews (the sliding window), so `issued` is not touched again before
      // its expiry instant; `late` is resolved one millisecond before it.
      const late = sessions.create(ALICE);
      expect(late.expiresAtMs).toBe(now + 30 * DAY);

      // One millisecond before expiry: still live, and renewed on purpose.
      clock.set(new Date(now + 30 * DAY - 1).toISOString());
      const lateNow = now + 30 * DAY - 1;
      const lastMinute = sessions.resolve(late.token);
      expect(lastMinute).toMatchObject({
        did: ALICE,
        token: late.token,
        expiresAtMs: lateNow + 30 * DAY,
        lastSeenMs: lateNow,
      });
      expect(parseSetCookie(lastMinute?.renewCookie as string).value).toBe(late.token);

      // Exactly at expires_at, with no renewing resolve in between: gone.
      clock.set(new Date(now + 30 * DAY).toISOString());
      expect(sessions.resolve(issued.token)).toBeNull();
      // The expired resolve neither renewed nor deleted the row.
      expect(rows(db).find((r) => r.token_hash_hex === sha256Hex(issued.token).toUpperCase())?.expires_at_ms).toBe(
        now + 30 * DAY,
      );
      // The sweep deletes only the expired row, without journaling it.
      const lateRow = {
        token_hash_hex: sha256Hex(late.token).toUpperCase(),
        did: ALICE,
        created_at_ms: now,
        expires_at_ms: lateNow + 30 * DAY,
        last_seen_ms: lateNow,
      };
      expect(sweepExpiredWebSessions(db, clock.nowMs())).toBe(1);
      expect(rows(db)).toEqual([lateRow]);
      expect(sessions.resolve(late.token)?.did).toBe(ALICE);
      expect(journal.entries()).toEqual([]);

      // Logged out: resolves to nothing afterwards; a second logout is a no-op.
      const other = sessions.create(BOB);
      expect(sessions.resolve(other.token)?.did).toBe(BOB);
      expect(sessions.logout(other.token)).toBe(true);
      expect(sessions.resolve(other.token)).toBeNull();
      expect(sessions.logout(other.token)).toBe(false);
      expect(rows(db)).toEqual([lateRow]);
    });
  });

  it("logout-all deletes every session of the DID and leaves other DIDs' sessions", async () => {
    await withMigratedDb((db) => {
      const { sessions, journal } = setup(db);
      const a1 = sessions.create(ALICE);
      const a2 = sessions.create(ALICE);
      const a3 = sessions.create(ALICE);
      const b1 = sessions.create(BOB);

      expect(sessions.logoutAll(ALICE)).toBe(3);

      for (const s of [a1, a2, a3]) expect(sessions.resolve(s.token)).toBeNull();
      expect(sessions.resolve(b1.token)?.did).toBe(BOB);
      expect(rows(db).map((r) => [r.did, r.token_hash_hex])).toEqual([[BOB, sha256Hex(b1.token).toUpperCase()]]);
      expect(
        journal
          .entries()
          .map((e) => ('hash' in e ? e.hash : null))
          .sort(),
      ).toEqual([a1, a2, a3].map((s) => sha256Hex(s.token)).sort());

      // A DID with no sessions: nothing deleted, nothing journaled.
      expect(sessions.logoutAll('did:plc:nobody')).toBe(0);
      expect(journal.entries()).toHaveLength(3);
      expect(rows(db)).toHaveLength(1);
    });
  });

  it('logout and logout-all append one revocation journal entry per deleted session before the rows are gone', async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const inner = new MemoryRevocations(clock);
      // At the moment of each append, the session row must still exist.
      const presentAtRecord: boolean[] = [];
      const observing: Revocations = {
        record(event: RevocationEvent) {
          const hash = 'hash' in event ? event.hash : '';
          presentAtRecord.push(
            db.one<{ n: number }>('SELECT count(*) AS n FROM web_sessions WHERE lower(hex(token_hash)) = ?', hash)
              ?.n === 1,
          );
          inner.record(event);
        },
        entries: () => inner.entries(),
        replay: (d) => inner.replay(d),
        truncateBefore: (ms) => inner.truncateBefore(ms),
      };
      const sessions = createWebSessions({ db, clock, random: seededRandom(11), revocations: observing });
      const a1 = sessions.create(ALICE);
      const a2 = sessions.create(ALICE);
      const b1 = sessions.create(BOB);

      clock.advance(5_000);
      expect(sessions.logout(b1.token)).toBe(true);
      expect(inner.entries()).toEqual([{ kind: 'web_session', hash: sha256Hex(b1.token), did: BOB, at: T0 + 5_000 }]);

      clock.advance(5_000);
      expect(sessions.logoutAll(ALICE)).toBe(2);
      const aliceEntries = inner.entries().slice(1);
      expect(aliceEntries).toHaveLength(2);
      expect(aliceEntries.map((e) => ('hash' in e ? e.hash : '')).sort()).toEqual(
        [sha256Hex(a1.token), sha256Hex(a2.token)].sort(),
      );
      for (const e of aliceEntries) expect(e).toMatchObject({ kind: 'web_session', did: ALICE, at: T0 + 10_000 });
      expect(presentAtRecord).toEqual([true, true, true]);
      expect(rows(db)).toEqual([]);

      // Every DID create() accepts can be journaled and logged out.
      for (const did of ['did:web:example.com', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', 'did:web:localhost%3A8443']) {
        const s = sessions.create(did);
        expect(sessions.logout(s.token)).toBe(true);
        expect(sessions.resolve(s.token)).toBeNull();
        expect(inner.entries().at(-1)).toMatchObject({ kind: 'web_session', hash: sha256Hex(s.token), did });
      }
      expect(rows(db)).toEqual([]);
      expect(presentAtRecord).toEqual([true, true, true, true, true, true]);

      // A journal that cannot append: the transaction rolls back, every
      // session stays valid and nothing is deleted.
      const failing: Revocations = {
        ...observing,
        record() {
          throw new RevocationJournalError('write_failed', 'injected');
        },
      };
      const broken = createWebSessions({ db, clock, random: seededRandom(12), revocations: failing });
      const c1 = broken.create(ALICE);
      const c2 = broken.create(ALICE);
      expect(() => broken.logout(c1.token)).toThrow(RevocationJournalError);
      expect(() => broken.logoutAll(ALICE)).toThrow(RevocationJournalError);
      expect(
        rows(db)
          .map((r) => r.token_hash_hex)
          .sort(),
      ).toEqual([sha256Hex(c1.token), sha256Hex(c2.token)].map((h) => h.toUpperCase()).sort());
      expect(broken.resolve(c1.token)?.did).toBe(ALICE);
      expect(broken.resolve(c2.token)?.did).toBe(ALICE);

      // Replaying the journal onto a database holding the logged-out rows
      // deletes exactly those rows again (the restore path, §14.5).
      for (const s of [a1, a2, b1]) {
        db.run(
          'INSERT INTO web_sessions (token_hash, did, created_at_ms, expires_at_ms, last_seen_ms) VALUES (unhex(?), ?, ?, ?, ?)',
          sha256Hex(s.token),
          s.did,
          T0,
          T0 + 30 * DAY,
          T0,
        );
      }
      expect(inner.replay(db).deleted.web_sessions).toBe(3);
      expect(rows(db)).toHaveLength(2);
    });
  });
});
