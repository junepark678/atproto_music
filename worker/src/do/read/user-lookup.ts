// Protocol user names (ADR 0005 §9; review finding 20, §20; N2-06).
//
// A protocol `user` value (Last.fm `user`/`username`, ListenBrainz `{user}`)
// resolves in this order:
//   1. a value starting with `did:` → that DID;
//   2. a dotless value → an `accounts.username`, case-insensitive;
//   3. a dotted value → an `accounts.username` equal to it only while its
//      owner's currently verified handle (`users.handle`) still equals it;
//      otherwise it falls through to
//   4. a currently verified handle, case-insensitive.
// A stale dotted username (its owner changed handle) therefore never shadows
// the handle's real owner. Usernames and verified handles are stored in
// lowercase ASCII (schema CHECK; ingest/sweeps.ts), so the comparison folds
// ASCII letters only: no other code point may turn into an ASCII letter
// (U+212A KELVIN SIGN lowercases to `k` in JavaScript).
//
// The resolved user must be visible (./visibility.ts): unknown, inactive and
// suppressed users are not found (Last.fm error 6, ListenBrainz 404), and a
// match of an invisible user does not fall through to another account.
//
// `name` is how responses name the user: the username when one exists, else
// the verified handle, else the DID.

import type { ModuleDeps } from '../contracts';
import { activeUser } from './visibility';

export interface ProtocolUser {
  did: string;
  username: string | null;
  handle: string | null;
  /** username ?? handle ?? did. */
  name: string;
  /** users.joined_at (storage timestamp). */
  joinedAt: string;
}

export type LookupStep = 'did' | 'username' | 'dotted_username' | 'handle';

export interface LookupResult {
  user: ProtocolUser;
  /** Which §9 rule matched. */
  step: LookupStep;
}

/** The longest value worth looking up: a DID is at most 2 KiB, a handle 253 characters. */
const MAX_NAME_LENGTH = 2048;

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

interface UserRowLite {
  did: string;
  handle: string | null;
  joined_at: string;
  username: string | null;
}

const SELECT_USER = `SELECT u.did AS did, u.handle AS handle, u.joined_at AS joined_at, a.username AS username
  FROM users u LEFT JOIN accounts a ON a.did = u.did`;

function toUser(r: UserRowLite): ProtocolUser {
  return {
    did: r.did,
    username: r.username,
    handle: r.handle,
    name: r.username ?? r.handle ?? r.did,
    joinedAt: r.joined_at,
  };
}

/** The §9 resolution with the rule that matched, or null when not found. */
export function lookupUserStep(m: Pick<ModuleDeps, 'db'>, value: string): LookupResult | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NAME_LENGTH) return null;
  const db = m.db;
  const visible = (did: string): UserRowLite | null =>
    db.one<UserRowLite>(`${SELECT_USER} WHERE u.did = ? AND ${activeUser('u')}`, did);

  // 1. A DID (case-sensitive, exactly as stored).
  if (value.startsWith('did:')) {
    const row = visible(value);
    return row === null ? null : { user: toUser(row), step: 'did' };
  }

  const name = asciiLower(value);
  // 2. A dotless value can only be a username.
  if (!name.includes('.')) {
    const owner = db.one<{ did: string }>('SELECT did FROM accounts WHERE username = ?', name);
    if (owner === null) return null;
    const row = visible(owner.did);
    return row === null ? null : { user: toUser(row), step: 'username' };
  }

  // 3. A dotted username counts only while it is its owner's current verified handle.
  const dotted = db.one<{ did: string }>(
    'SELECT a.did AS did FROM accounts a JOIN users u ON u.did = a.did WHERE a.username = ? AND u.handle = ?',
    name,
    name,
  );
  if (dotted !== null) {
    const row = visible(dotted.did);
    return row === null ? null : { user: toUser(row), step: 'dotted_username' };
  }

  // 4. A currently verified handle.
  const byHandle = db.one<UserRowLite>(`${SELECT_USER} WHERE u.handle = ? AND ${activeUser('u')}`, name);
  return byHandle === null ? null : { user: toUser(byHandle), step: 'handle' };
}

/** Resolve a protocol `user` value to a visible user (§9), or null. */
export function lookupUser(m: Pick<ModuleDeps, 'db'>, value: string): ProtocolUser | null {
  return lookupUserStep(m, value)?.user ?? null;
}

/** Whether the account's username is dotted but no longer its owner's verified handle (the UI warning, §9). */
export function hasStaleDottedUsername(m: Pick<ModuleDeps, 'db'>, did: string): boolean {
  const row = m.db.one<{ username: string; handle: string | null }>(
    'SELECT a.username AS username, u.handle AS handle FROM accounts a LEFT JOIN users u ON u.did = a.did WHERE a.did = ?',
    did,
  );
  if (row === null) return false;
  return row.username.includes('.') && row.username !== row.handle;
}
