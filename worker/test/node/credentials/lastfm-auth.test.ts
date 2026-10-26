// Last.fm desktop/web tokens and session keys (ADR 0005 §7.3; N2-09).
//
// A migrated temporary node:sqlite database (N1-01, N1-10), the frozen clock,
// a seeded Random and the in-memory revocation journal (N1-08). Every expected
// hash is recomputed here with node:crypto, independently of crypto/tokens.ts.

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LastfmSessionRow, LastfmTokenRow } from '../../../src/app/rows';
import { type CredentialDeps, ensureAccount } from '../../../src/credentials/accounts';
import { createAppPassword } from '../../../src/credentials/app-passwords';
import {
  AUTH_TOKEN_UNSUPPORTED,
  authorizeToken,
  createAuthorizedToken,
  getMobileSession,
  getSession,
  issueToken,
  LASTFM_TOKEN_TTL_MS,
  listLastfmSessions,
  revokeLastfmSession,
  sweepLastfmTokens,
  verifySessionKey,
} from '../../../src/credentials/lastfm-auth';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const KEY = 'a'.repeat(32);
const OTHER_KEY = 'panoScrobbler';
const HEX32 = /^[0-9a-f]{32}$/;
const MINUTE = 60_000;

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const hex = (b: ArrayBuffer): string => Buffer.from(b).toString('hex');

function setup(db: SqliteDb) {
  const clock = fixedClock();
  const deps: CredentialDeps & { clock: typeof clock } = {
    db,
    clock,
    random: seededRandom(7),
    revocations: new MemoryRevocations(clock),
  };
  db.run(
    "INSERT INTO users (did, handle, joined_at) VALUES (?, 'alice.bsky.social', '2026-01-15T12:00:00.000000000Z')",
    ALICE,
  );
  ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.bsky.social' });
  return { deps, clock };
}

function tokenRowByHash(db: SqliteDb, token: string): LastfmTokenRow | undefined {
  const want = sha256(token).toString('hex');
  return db.all<LastfmTokenRow>('SELECT * FROM lastfm_tokens').find((r) => hex(r.token_hash) === want);
}

describe('Last.fm tokens and session keys (ADR §7.3)', () => {
  it('getToken issues a 32-hex token; authorize binds it to a DID; getSession consumes it once; unauthorized gives 14, after 60 min 15, unknown or consumed 4', async () => {
    await withMigratedDb((db) => {
      const { deps, clock } = setup(db);
      const issued = issueToken(deps, KEY);
      if (!issued.ok) throw new Error('getToken failed');
      const { token } = issued.value;
      expect(token).toMatch(HEX32);
      expect(issued.value.expiresAtMs).toBe(clock.nowMs() + 60 * MINUTE);

      // Stored only as SHA-256, bound to the api_key, state issued, no DID.
      const all = db.all<LastfmTokenRow>('SELECT * FROM lastfm_tokens');
      expect(all).toHaveLength(1);
      expect(hex(all[0]!.token_hash)).toBe(sha256(token).toString('hex'));
      expect(all[0]).toMatchObject({ api_key: KEY, did: null, state: 'issued', created_at_ms: clock.nowMs() });
      expect(JSON.stringify(db.all('SELECT api_key, did, state FROM lastfm_tokens'))).not.toContain(token);

      // Not yet authorized → 14, and the token is not consumed by asking.
      expect(getSession(deps, { apiKey: KEY, token })).toEqual({ ok: false, code: 14 });
      expect(tokenRowByHash(db, token)?.state).toBe('issued');

      // The signed-in DID approves it.
      clock.advance(5 * MINUTE);
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token })).toEqual({ ok: true });
      expect(tokenRowByHash(db, token)).toMatchObject({ state: 'authorized', did: ALICE });
      // A DID without an account cannot approve; another DID cannot take over an approved token.
      expect(authorizeToken(deps, { did: BOB, apiKey: KEY, token })).toEqual({ ok: false, reason: 'no_account' });
      ensureAccount(deps, { did: BOB, verifiedHandle: null });
      expect(authorizeToken(deps, { did: BOB, apiKey: KEY, token })).toEqual({
        ok: false,
        reason: 'already_authorized',
      });
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token })).toEqual({ ok: true });
      expect(tokenRowByHash(db, token)).toMatchObject({ state: 'authorized', did: ALICE });

      // getSession consumes it exactly once.
      const session = getSession(deps, { apiKey: KEY, token, clientName: 'Pano Scrobbler' });
      expect(session.ok).toBe(true);
      if (!session.ok) return;
      expect(session.value.name).toBe('alice.bsky.social');
      expect(session.value.key).toMatch(HEX32);
      expect(tokenRowByHash(db, token)?.state).toBe('consumed');
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(1);
      expect(getSession(deps, { apiKey: KEY, token })).toEqual({ ok: false, code: 4 });
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token })).toEqual({ ok: false, reason: 'unknown_token' });
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(1);

      // Unknown tokens (well-formed or not) → 4.
      expect(getSession(deps, { apiKey: KEY, token: 'f'.repeat(32) })).toEqual({ ok: false, code: 4 });
      expect(getSession(deps, { apiKey: KEY, token: 'not-a-token' })).toEqual({ ok: false, code: 4 });

      // After 60 min, authorized or not, → 15; nothing is consumed or issued.
      const late = issueToken(deps, KEY);
      const lateUnauthorized = issueToken(deps, KEY);
      if (!late.ok || !lateUnauthorized.ok) throw new Error('getToken failed');
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token: late.value.token })).toEqual({ ok: true });
      clock.advance(LASTFM_TOKEN_TTL_MS - 1);
      clock.advance(1);
      expect(getSession(deps, { apiKey: KEY, token: late.value.token })).toEqual({ ok: false, code: 15 });
      expect(getSession(deps, { apiKey: KEY, token: lateUnauthorized.value.token })).toEqual({ ok: false, code: 15 });
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token: lateUnauthorized.value.token })).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(tokenRowByHash(db, late.value.token)?.state).toBe('authorized');
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(1);

      // A missing or over-long api_key is 10 and stores nothing.
      expect(issueToken(deps, '')).toEqual({ ok: false, code: 10 });
      expect(issueToken(deps, 'k'.repeat(65))).toEqual({ ok: false, code: 10 });
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_tokens')?.n).toBe(3);
      expect(tokenRowByHash(db, token)?.state).toBe('consumed');
    });
  });

  it('session keys are 32 hex, stored as SHA-256, never expire, and fail with 9 after revoke', async () => {
    await withMigratedDb((db) => {
      const { deps, clock } = setup(db);
      const web = createAuthorizedToken(deps, { did: ALICE, apiKey: KEY });
      if (!web.ok) throw new Error('web token failed');
      const session = getSession(deps, { apiKey: KEY, token: web.value.token });
      if (!session.ok) throw new Error('getSession failed');
      const sk = session.value.key;
      expect(sk).toMatch(HEX32);

      const rows = db.all<LastfmSessionRow>('SELECT * FROM lastfm_sessions');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(hex(row.sk_hash)).toBe(sha256(sk).toString('hex'));
      expect(row).toMatchObject({ id: session.value.id, did: ALICE, api_key: KEY, last_used_ms: null });
      expect(Object.values(row).some((v) => v === sk)).toBe(false);
      expect(JSON.stringify(listLastfmSessions(db, ALICE))).not.toContain(sk);

      // Verifies, and last_used_ms is written at most once per minute.
      const t0 = clock.nowMs();
      expect(verifySessionKey(deps, sk)).toEqual({
        ok: true,
        value: { id: row.id, did: ALICE, apiKey: KEY, name: 'alice.bsky.social' },
      });
      expect(listLastfmSessions(db, ALICE)[0]?.lastUsedMs).toBe(t0);
      clock.advance(30_000);
      expect(verifySessionKey(deps, sk).ok).toBe(true);
      expect(listLastfmSessions(db, ALICE)[0]?.lastUsedMs).toBe(t0);
      clock.advance(30_000);
      expect(verifySessionKey(deps, sk).ok).toBe(true);
      expect(listLastfmSessions(db, ALICE)[0]?.lastUsedMs).toBe(t0 + MINUTE);

      // Never expires: ten years later it still verifies.
      clock.advance(10 * 366 * 24 * 60 * MINUTE);
      expect(verifySessionKey(deps, sk).ok).toBe(true);
      expect(verifySessionKey(deps, sk.toUpperCase()).ok).toBe(true);

      // Missing, malformed or unknown → 9.
      expect(verifySessionKey(deps, undefined)).toEqual({ ok: false, code: 9 });
      expect(verifySessionKey(deps, '')).toEqual({ ok: false, code: 9 });
      expect(verifySessionKey(deps, `${sk}0`)).toEqual({ ok: false, code: 9 });
      expect(verifySessionKey(deps, 'e'.repeat(32))).toEqual({ ok: false, code: 9 });

      // Another DID cannot revoke it; its owner can, and then it fails with 9.
      expect(revokeLastfmSession(deps, BOB, row.id)).toBe(false);
      expect(verifySessionKey(deps, sk).ok).toBe(true);
      expect(revokeLastfmSession(deps, ALICE, row.id)).toBe(true);
      expect(verifySessionKey(deps, sk)).toEqual({ ok: false, code: 9 });
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(0);
      expect(revokeLastfmSession(deps, ALICE, row.id)).toBe(false);
      expect((deps.revocations as MemoryRevocations).entries()).toEqual([
        { kind: 'lastfm_session', id: row.id, did: ALICE, at: clock.nowMs() },
      ]);
    });
  });

  it('getSession with an api_key other than the one that called getToken gives 4', async () => {
    await withMigratedDb((db) => {
      const { deps } = setup(db);
      const issued = issueToken(deps, KEY);
      if (!issued.ok) throw new Error('getToken failed');
      const { token } = issued.value;
      // Approving under another api_key is refused too.
      expect(authorizeToken(deps, { did: ALICE, apiKey: OTHER_KEY, token })).toEqual({
        ok: false,
        reason: 'api_key_mismatch',
      });
      expect(tokenRowByHash(db, token)?.state).toBe('issued');
      expect(authorizeToken(deps, { did: ALICE, apiKey: KEY, token })).toEqual({ ok: true });

      expect(getSession(deps, { apiKey: OTHER_KEY, token })).toEqual({ ok: false, code: 4 });
      expect(getSession(deps, { apiKey: KEY.toUpperCase(), token })).toEqual({ ok: false, code: 4 });
      // The refused call consumed nothing and issued no session.
      expect(tokenRowByHash(db, token)?.state).toBe('authorized');
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(0);

      const ok = getSession(deps, { apiKey: KEY, token });
      expect(ok.ok).toBe(true);
      expect(db.one<{ api_key: string }>('SELECT api_key FROM lastfm_sessions')?.api_key).toBe(KEY);
    });
  });

  it('getMobileSession accepts an app password for a username, handle or DID and gives 4 otherwise', async () => {
    await withMigratedDb((db) => {
      const { deps } = setup(db);
      const { password } = createAppPassword(deps, { did: ALICE, label: 'phone' });
      for (const username of ['alice.bsky.social', 'ALICE.bsky.social', ALICE]) {
        const r = getMobileSession(deps, { apiKey: KEY, username, password });
        expect(r.ok, username).toBe(true);
        if (r.ok) expect(r.value.name).toBe('alice.bsky.social');
      }
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(3);
      expect(getMobileSession(deps, { apiKey: KEY, username: 'alice.bsky.social', password: 'a'.repeat(24) })).toEqual({
        ok: false,
        code: 4,
      });
      expect(getMobileSession(deps, { apiKey: KEY, username: 'nobody', password })).toEqual({ ok: false, code: 4 });
      expect(getMobileSession(deps, { apiKey: KEY, username: 'alice.bsky.social', authToken: 'x' })).toEqual({
        ok: false,
        code: 4,
        message: AUTH_TOKEN_UNSUPPORTED,
      });
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_sessions')?.n).toBe(3);
    });
  });

  it('sweepLastfmTokens deletes consumed tokens at once and unconsumed ones an hour after expiry', async () => {
    await withMigratedDb((db) => {
      const { deps, clock } = setup(db);
      const consumed = createAuthorizedToken(deps, { did: ALICE, apiKey: KEY });
      const pending = issueToken(deps, KEY);
      if (!consumed.ok || !pending.ok) throw new Error('token failed');
      expect(getSession(deps, { apiKey: KEY, token: consumed.value.token }).ok).toBe(true);

      expect(sweepLastfmTokens(db, clock.nowMs())).toBe(1);
      expect(tokenRowByHash(db, consumed.value.token)).toBeUndefined();
      expect(tokenRowByHash(db, pending.value.token)?.state).toBe('issued');

      // Expired but within the retention hour: kept, and still answers 15.
      clock.advance(LASTFM_TOKEN_TTL_MS + 59 * MINUTE);
      expect(sweepLastfmTokens(db, clock.nowMs())).toBe(0);
      expect(getSession(deps, { apiKey: KEY, token: pending.value.token })).toEqual({ ok: false, code: 15 });
      clock.advance(MINUTE);
      expect(sweepLastfmTokens(db, clock.nowMs())).toBe(1);
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_tokens')?.n).toBe(0);
      expect(getSession(deps, { apiKey: KEY, token: pending.value.token })).toEqual({ ok: false, code: 4 });
    });
  });
});
