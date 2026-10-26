// N2-03: sign-in policy reconciliation (ADR 0005 §5.5, §5.7, B20). The policy
// comes from parseNodeConfig, the OAuth sessions are real sessions at the fake
// AS, and the credentials are rows of the migration-2 tables.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileSignInPolicy, signInAllowed } from '../../../src/bff/reconcile';
import { type NodeEnv, parseNodeConfig } from '../../../src/node/config';
import { withMigratedDb } from '../support/node-db';
import { createWorld, freezeDate, hex, PREFIX, type World } from './oauth-world';

beforeEach(freezeDate);
afterEach(() => vi.useRealTimers());

function policy(dids: string[]) {
  const env: NodeEnv = {
    ATMUSIC_PUBLIC_ORIGIN: 'https://music.214510.xyz',
    ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip',
    ATMUSIC_SIGNIN_DIDS: dids.join(','),
    STATE_DIRECTORY: '/home/owner/.local/state/atmusic',
    XDG_RUNTIME_DIR: '/run/user/1000',
    LEXICON_PREFIX: PREFIX,
    NAMESPACE_OWNERSHIP_REF: '',
    JETSTREAM_URLS: 'wss://jetstream.example.org',
    JETSTREAM_LOOKBACK_HOURS: '24',
    RELAY_URL: 'https://relay.example.org',
  };
  return parseNodeConfig(env, { allowFixturePrefix: true, releaseRoot: '/opt/atmusic/release' });
}

const TABLES = [
  'web_sessions',
  'lastfm_sessions',
  'app_passwords',
  'lb_tokens',
  'lastfm_apps',
  'lastfm_tokens',
  'linked_accounts',
  'operations',
  'accounts',
  'oauth_sessions',
] as const;

/** Every row of `did` in the credential, link, operation and account tables. */
function snapshot(w: World, did: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    out[t] = w.db
      .all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE did = ?`, did)
      .map((r) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof ArrayBuffer ? hex(v) : v])),
        ),
      )
      .sort();
  }
  return out;
}

function seedCredentials(w: World, did: string, tag: string) {
  const db = w.db;
  const now = w.clock.nowMs();
  const h = (s: string) => new Uint8Array(Buffer.from(s.padEnd(32, '.').slice(0, 32))).buffer;
  const web = [h(`${tag}-web-1`), h(`${tag}-web-2`)];
  for (const token_hash of web) {
    db.run(
      'INSERT INTO web_sessions (token_hash, did, created_at_ms, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)',
      token_hash,
      did,
      now,
      now + 30 * 86_400_000,
      now,
    );
  }
  db.run(
    'INSERT INTO lastfm_sessions (id, sk_hash, did, api_key, client_name, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `${tag}-lfs`,
    h(`${tag}-sk`),
    did,
    'a'.repeat(32),
    'Pano Scrobbler',
    now,
    now,
  );
  db.run(
    'INSERT INTO app_passwords (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?)',
    `${tag}-ap`,
    did,
    'phone',
    h(`${tag}-ap`),
    now,
    null,
  );
  db.run(
    'INSERT INTO lb_tokens (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?)',
    `${tag}-lb`,
    did,
    'navidrome',
    h(`${tag}-lb`),
    now,
    now,
  );
  db.run(
    'INSERT INTO lastfm_apps (api_key, did, name, secret_ciphertext, key_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    `${tag}-apikey`,
    did,
    'my app',
    h(`${tag}-secret`),
    'e1',
    now,
  );
  db.run(
    "INSERT INTO lastfm_tokens (token_hash, api_key, did, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, 'authorized', ?, ?)",
    h(`${tag}-tok`),
    `${tag}-apikey`,
    did,
    now,
    now + 3_600_000,
  );
  db.run(
    `INSERT INTO linked_accounts (id, did, service, remote_user, credential_ciphertext, key_id, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'lastfm', 'remote', ?, 'e1', 'active', ?, ?)`,
    `${tag}-link`,
    did,
    h(`${tag}-cred`),
    now,
    now,
  );
  w.seedOperation(`${tag}-op-1`, did, 'queued');
  w.seedOperation(`${tag}-op-2`, did, 'succeeded');
  return { webHashes: web.map(hex) };
}

describe('sign-in policy reconciliation', () => {
  it('after a DID is removed from ATMUSIC_SIGNIN_DIDS, reconcile revokes its OAuth session at the fake AS, deletes its web sessions, Last.fm sessions, app passwords, ListenBrainz tokens and issued apps with journal entries, revokes its links, blocks its queued operations and marks it signed_out; an allowed DID is untouched', async () => {
    await withMigratedDb(async (db) => {
      const w = await createWorld(db);
      const alice = await w.addUser('alice');
      const bob = await w.addUser('bob');
      const svc = w.service();
      await w.signIn(svc, alice);
      await w.signIn(svc, bob);
      w.seedAccount(alice.did, 'alice');
      w.seedAccount(bob.did, 'bob');
      const aliceCreds = seedCredentials(w, alice.did, 'alice');
      seedCredentials(w, bob.did, 'bob');
      const deps = { db, clock: w.clock, log: w.log, revocations: w.revocations, oauth: svc };

      // Both allowed: nothing changes.
      const both = policy([alice.did, bob.did]);
      expect(signInAllowed(both, alice.did)).toBe(true);
      const aliceBefore = snapshot(w, alice.did);
      const bobBefore = snapshot(w, bob.did);
      expect(await reconcileSignInPolicy(deps, both)).toEqual({ signedOut: [], changed: {} });
      expect(snapshot(w, alice.did)).toEqual(aliceBefore);
      expect(w.as.revocations).toEqual([]);

      // Alice is removed from ATMUSIC_SIGNIN_DIDS.
      w.advance(60_000);
      const onlyBob = policy([bob.did]);
      expect(signInAllowed(onlyBob, alice.did)).toBe(false);
      const report = await reconcileSignInPolicy(deps, onlyBob);
      expect(report.signedOut).toEqual([alice.did]);
      expect(report.changed).toEqual({
        oauth_sessions: 1,
        web_sessions: 2,
        lastfm_sessions: 1,
        app_passwords: 1,
        lb_tokens: 1,
        lastfm_apps: 1,
        lastfm_tokens: 1,
        linked_accounts: 1,
        operations: 1,
        accounts: 1,
      });

      // Revoked at the AS, and gone locally.
      expect(w.as.revocations.map((r) => [r.sub, r.source])).toEqual([[alice.did, 'endpoint']]);
      expect(w.as.sessions(alice.did)[0]?.revoked).not.toBeNull();
      const after = snapshot(w, alice.did);
      for (const t of [
        'oauth_sessions',
        'web_sessions',
        'lastfm_sessions',
        'app_passwords',
        'lb_tokens',
        'lastfm_apps',
        'lastfm_tokens',
      ]) {
        expect(after[t]).toEqual([]);
      }
      expect(db.all('SELECT id, status FROM linked_accounts WHERE did = ?', alice.did)).toEqual([
        { id: 'alice-link', status: 'revoked' },
      ]);
      expect(db.all('SELECT id, state FROM operations WHERE did = ? ORDER BY id', alice.did)).toEqual([
        { id: 'alice-op-1', state: 'blocked' },
        { id: 'alice-op-2', state: 'succeeded' },
      ]);
      expect(w.accountStatus(alice.did)).toBe('signed_out');

      // Every deletion and revocation is in the journal, for alice only.
      const at = w.clock.nowMs();
      expect(w.revocations.entries()).toEqual([
        { kind: 'web_session', hash: aliceCreds.webHashes[0], did: alice.did, at },
        { kind: 'web_session', hash: aliceCreds.webHashes[1], did: alice.did, at },
        { kind: 'lastfm_session', id: 'alice-lfs', did: alice.did, at },
        { kind: 'app_password', id: 'alice-ap', did: alice.did, at },
        { kind: 'lb_token', id: 'alice-lb', did: alice.did, at },
        { kind: 'lastfm_app', id: 'alice-apikey', did: alice.did, at },
        { kind: 'linked_account', id: 'alice-link', did: alice.did, at },
        { kind: 'oauth_session', did: alice.did, at },
      ]);

      // Bob is untouched: every row identical, his session alive at the AS and usable.
      expect(snapshot(w, bob.did)).toEqual(bobBefore);
      expect(w.as.sessions(bob.did)[0]?.revoked).toBeNull();
      expect((await w.writeScrobble(await svc.restore(bob.did), 1)).status).toBe(200);

      // A second sweep finds nothing left to do.
      const revokeCalls = w.as.count('/oauth/revoke');
      expect(await reconcileSignInPolicy(deps, onlyBob)).toEqual({ signedOut: [], changed: {} });
      expect(w.as.count('/oauth/revoke')).toBe(revokeCalls);
      expect(w.revocations.entries()).toHaveLength(8);
    });
  });
});
