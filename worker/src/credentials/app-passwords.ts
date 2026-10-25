// App passwords for Last.fm `auth.getMobileSession` (ADR 0005 §7.3, §13;
// N2-09).
//
// - 24 base32 characters (120 bits) from crypto/tokens.ts, returned once by
//   `createAppPassword` and stored only as SHA-256 (`app_passwords.hash`).
//   They are high-entropy, so no slow hash is needed.
// - `verifyAppPassword` takes the getMobileSession `username` (our username, a
//   verified handle or a DID, resolved as ADR §9 says) and the password, and
//   compares the stored digest with the computed one in constant time. It
//   never tells the caller which half was wrong.
// - `last_used_ms` is updated at most once per minute.
// - `revokeAppPassword` journals `{kind: 'app_password', id, did}` inside the
//   deleting transaction, before it commits (ADR §14.5): a journal failure
//   rolls the delete back.
//
// An app password is never an atproto credential, and the plaintext is never
// stored, logged or journaled.

import type { AppPasswordRow } from '../app/rows';
import { constantTimeEqual } from '../crypto/constant-time';
import { APP_PASSWORD_ALPHABET, APP_PASSWORD_LENGTH, hashToken, newAppPassword } from '../crypto/tokens';
import type { Db } from '../do/db';
import {
  type CredentialDeps,
  newCredentialId,
  normaliseLabel,
  requireAccount,
  resolveUserDid,
  toBlob,
  touchLastUsed,
} from './accounts';

export interface CreatedAppPassword {
  id: string;
  /** The password itself: shown to the user once, never stored. */
  password: string;
  label: string | null;
  createdAtMs: number;
}

/** Settings metadata of one app password (never the hash). */
export interface AppPasswordInfo {
  id: string;
  label: string | null;
  createdAtMs: number;
  lastUsedMs: number | null;
}

/** Issue a new app password for a signed-in DID. The plaintext is in the result only. */
export function createAppPassword(
  deps: CredentialDeps,
  input: { did: string; label?: string | null },
): CreatedAppPassword {
  const label = normaliseLabel(input.label);
  return deps.db.tx(() => {
    requireAccount(deps.db, input.did);
    const id = newCredentialId(deps.random);
    const password = newAppPassword(deps.random);
    const now = deps.clock.nowMs();
    deps.db.run(
      'INSERT INTO app_passwords (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, NULL)',
      id,
      input.did,
      label,
      toBlob(hashToken(password)),
      now,
    );
    return { id, password, label, createdAtMs: now };
  });
}

const PASSWORD_RE = new RegExp(`^[${APP_PASSWORD_ALPHABET}]{${APP_PASSWORD_LENGTH}}$`);

/**
 * The password as we issued it: lowercase base32, with whitespace and hyphens
 * a user may type between groups removed. Null when it cannot be one of ours.
 */
export function normaliseAppPassword(password: string): string | null {
  if (typeof password !== 'string' || password.length > 4 * APP_PASSWORD_LENGTH) return null;
  const candidate = password.toLowerCase().replace(/[\s-]/g, '');
  return PASSWORD_RE.test(candidate) ? candidate : null;
}

export interface VerifiedAppPassword {
  id: string;
  did: string;
}

/**
 * The app password `password` of the user named `username` (ADR §9: username,
 * verified handle or DID), or null. The digest comparison is constant-time.
 */
export function verifyAppPassword(
  deps: Pick<CredentialDeps, 'db' | 'clock'>,
  input: { username: string; password: string },
): VerifiedAppPassword | null {
  const { db } = deps;
  const password = normaliseAppPassword(input.password);
  const did = resolveUserDid(db, input.username);
  if (password === null || did === null) return null;
  const digest = hashToken(password);
  const row = db.one<Pick<AppPasswordRow, 'id' | 'did' | 'hash'>>(
    'SELECT id, did, hash FROM app_passwords WHERE hash = ?',
    toBlob(digest),
  );
  if (row === null || !constantTimeEqual(row.hash, digest) || row.did !== did) return null;
  touchLastUsed(db, 'app_passwords', row.id, deps.clock.nowMs());
  return { id: row.id, did: row.did };
}

/** The DID's app passwords, newest first, metadata only. */
export function listAppPasswords(db: Db, did: string): AppPasswordInfo[] {
  return db
    .all<Pick<AppPasswordRow, 'id' | 'label' | 'created_at_ms' | 'last_used_ms'>>(
      'SELECT id, label, created_at_ms, last_used_ms FROM app_passwords WHERE did = ? ORDER BY created_at_ms DESC, id',
      did,
    )
    .map((r) => ({ id: r.id, label: r.label, createdAtMs: r.created_at_ms, lastUsedMs: r.last_used_ms }));
}

/**
 * Delete app password `id` of `did`, journaling the revocation before the
 * delete commits. False (and nothing journaled) when the DID holds no such
 * password.
 */
export function revokeAppPassword(deps: Pick<CredentialDeps, 'db' | 'revocations'>, did: string, id: string): boolean {
  return deps.db.tx(() => {
    const gone = deps.db.all<{ id: string }>(
      'DELETE FROM app_passwords WHERE id = ? AND did = ? RETURNING id',
      id,
      did,
    );
    if (gone.length === 0) return false;
    deps.revocations.record({ kind: 'app_password', id, did });
    return true;
  });
}
