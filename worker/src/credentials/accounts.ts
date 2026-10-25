// Local accounts and their protocol user names (ADR 0005 §6.4 `accounts`, §9;
// N2-09).
//
// Each signed-in DID gets one `accounts` row whose `username` is the stable
// name the Last.fm and ListenBrainz protocols address the user by (handles are
// mutable). The rules (ADR §9):
//
// - **First sign-in** derives the name from the verified handle: lowercased,
//   characters outside `[a-z0-9._-]` removed, truncated to 64, with `-2`,
//   `-3` … appended on collision (the base is shortened so the result still
//   fits 64). The name never changes automatically afterwards.
// - **Dots are reserved for handles.** A rename to a dotted name is allowed
//   only when it equals the caller's own currently verified handle; every
//   other rename must be dotless (`username_invalid`, 422). A name another
//   account holds is `username_taken` (409); names are stored lowercase, so
//   the comparison is case-insensitive.
// - **Resolution** of a protocol `user` value (`resolveUserDid`): a `did:`
//   value is that DID; a dotless value is an `accounts.username`; a dotted
//   value is an `accounts.username` only while its owner's verified handle
//   still equals it, otherwise it falls through to the verified handle.
//
// "Verified handle" means `users.handle` (the column the identity sweeps keep
// bidirectionally verified, unique where not NULL), unless the caller passes
// the handle it has just verified itself (the OAuth callback does).
//
// The module also holds what the other credential modules share: the deps
// shape, the typed error, the label rule, display names and the throttled
// `last_used_ms` update.

import type { Clock, Random } from '@atmusic/core/deps';
import type { Revocations } from '../app/revocations';
import type { AccountRow } from '../app/rows';
import { bytesToHex } from '../crypto/tokens';
import type { Db } from '../do/db';

/** What every credential module needs. Production passes the composed db, clock, random and journal. */
export interface CredentialDeps {
  db: Db;
  clock: Clock;
  random: Random;
  revocations: Revocations;
}

export type CredentialErrorReason =
  | 'no_account'
  | 'label_invalid'
  | 'name_invalid'
  | 'api_key_invalid'
  | 'id_exhausted';

/** A refused credential operation (the routes map it to their envelope). Never carries a secret. */
export class CredentialError extends Error {
  constructor(
    readonly reason: CredentialErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

// --- usernames --------------------------------------------------------------

/** The `accounts.username` shape (ADR §6.4), the same rule as the column CHECK. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const MAX_USERNAME_LENGTH = 64;
/** Collision suffixes tried before giving up (`-2` … `-MAX`); far beyond any real collision chain. */
const MAX_COLLISION_SUFFIX = 10_000;

/**
 * The §9 derivation without the collision step: lowercased, characters
 * outside `[a-z0-9._-]` removed, leading characters that cannot start a
 * username dropped, truncated to 64. Null when nothing usable is left.
 */
export function deriveUsernameBase(source: string): string | null {
  const cleaned = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_USERNAME_LENGTH);
  return USERNAME_RE.test(cleaned) ? cleaned : null;
}

function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, MAX_USERNAME_LENGTH - suffix.length)}${suffix}`;
}

function usernameTaken(db: Db, username: string, exceptDid: string): boolean {
  return (
    db.one<{ one: number }>('SELECT 1 AS one FROM accounts WHERE username = ? AND did != ?', username, exceptDid) !==
    null
  );
}

/** True when `name` is the verified handle of a DID other than `did`. */
function isOtherDidsHandle(db: Db, name: string, did: string): boolean {
  return db.one<{ one: number }>('SELECT 1 AS one FROM users WHERE handle = ? AND did != ?', name, did) !== null;
}

/** The DID's verified handle as `users` records it (lowercase), or null. */
export function storedVerifiedHandle(db: Db, did: string): string | null {
  return db.one<{ handle: string | null }>('SELECT handle FROM users WHERE did = ?', did)?.handle ?? null;
}

function normaliseHandle(handle: string | null | undefined): string | null {
  return typeof handle === 'string' && handle.length > 0 ? handle.toLowerCase() : null;
}

/** The base a DID without a verified handle gets: its text, dotless (dots are reserved for handles). */
function didBase(did: string): string {
  return deriveUsernameBase(did.replace(/\./g, '-')) ?? 'user';
}

export interface EnsureAccountInput {
  did: string;
  /** The handle verified for this DID at this sign-in, or null when none verifies. */
  verifiedHandle: string | null;
}

export interface EnsureAccountResult {
  account: AccountRow;
  /** True when this call created the row (first sign-in). */
  created: boolean;
}

/**
 * The account of `did`, created on first sign-in with a username derived from
 * the verified handle (ADR §9). An existing account is returned unchanged:
 * the username never changes automatically.
 */
export function ensureAccount(
  deps: Pick<CredentialDeps, 'db' | 'clock'>,
  input: EnsureAccountInput,
): EnsureAccountResult {
  const { db } = deps;
  return db.tx(() => {
    const existing = getAccount(db, input.did);
    if (existing !== null) return { account: existing, created: false };
    const handle = normaliseHandle(input.verifiedHandle);
    const base = (handle !== null ? deriveUsernameBase(handle) : null) ?? didBase(input.did);
    // A candidate is free when no account holds it and it is not another DID's
    // verified handle (a derived `alice.bsky.social-2` could be a real handle).
    const free = (name: string): boolean =>
      !usernameTaken(db, name, input.did) && (name === handle || !isOtherDidsHandle(db, name, input.did));
    let username: string | null = free(base) ? base : null;
    for (let n = 2; username === null && n <= MAX_COLLISION_SUFFIX; n++) {
      const candidate = withSuffix(base, n);
      if (free(candidate)) username = candidate;
    }
    if (username === null) throw new CredentialError('id_exhausted', 'no free username for this handle');
    const now = deps.clock.nowMs();
    db.run(
      'INSERT INTO accounts (did, username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      input.did,
      username,
      now,
      now,
    );
    return { account: getAccount(db, input.did) as AccountRow, created: true };
  });
}

export function getAccount(db: Db, did: string): AccountRow | null {
  return db.one<AccountRow>('SELECT * FROM accounts WHERE did = ?', did);
}

export interface RenameInput {
  did: string;
  username: string;
  /**
   * The caller's currently verified handle. Omitted: `users.handle` of the DID.
   * Pass it when the caller has just verified the handle itself.
   */
  verifiedHandle?: string | null;
}

export type RenameResult =
  | { ok: true; account: AccountRow; changed: boolean }
  | { ok: false; error: 'username_invalid' | 'username_taken' | 'no_account' };

/** HTTP status of each rename refusal (ADR §9): invalid 422, taken 409. */
export const RENAME_ERROR_STATUS = { username_invalid: 422, username_taken: 409, no_account: 404 } as const;

/**
 * Rename the account of `did` (PATCH /api/v1/account, N3-02). The name is
 * lowercased first, so a taken name in another case is `username_taken`.
 */
export function renameAccount(deps: Pick<CredentialDeps, 'db' | 'clock'>, input: RenameInput): RenameResult {
  const { db } = deps;
  if (typeof input.username !== 'string') return { ok: false, error: 'username_invalid' };
  const wanted = input.username.toLowerCase();
  if (!USERNAME_RE.test(wanted)) return { ok: false, error: 'username_invalid' };
  return db.tx((): RenameResult => {
    const account = getAccount(db, input.did);
    if (account === null) return { ok: false, error: 'no_account' };
    if (wanted.includes('.')) {
      const own = normaliseHandle(
        input.verifiedHandle === undefined ? storedVerifiedHandle(db, input.did) : input.verifiedHandle,
      );
      // Only one's own verified handle, and never a name `users` says another DID verifies as.
      if (own === null || wanted !== own || isOtherDidsHandle(db, wanted, input.did)) {
        return { ok: false, error: 'username_invalid' };
      }
    }
    if (wanted === account.username) return { ok: true, account, changed: false };
    if (usernameTaken(db, wanted, input.did)) return { ok: false, error: 'username_taken' };
    db.run('UPDATE accounts SET username = ?, updated_at_ms = ? WHERE did = ?', wanted, deps.clock.nowMs(), input.did);
    return { ok: true, account: getAccount(db, input.did) as AccountRow, changed: true };
  });
}

/**
 * The DID a protocol `user` value names (ADR §9), or null:
 * 1. `did:…` → that DID;
 * 2. dotless → the account with that username (case-insensitive);
 * 3. dotted → the account with that username, only while its owner's verified
 *    handle still equals it; otherwise
 * 4. the DID whose verified handle it is (case-insensitive).
 */
export function resolveUserDid(db: Db, name: string): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 2048) return null;
  if (name.startsWith('did:')) return name;
  const lower = name.toLowerCase();
  if (!lower.includes('.')) {
    return db.one<{ did: string }>('SELECT did FROM accounts WHERE username = ?', lower)?.did ?? null;
  }
  const owner = db.one<{ did: string }>(
    'SELECT a.did FROM accounts a JOIN users u ON u.did = a.did WHERE a.username = ? AND u.handle = ?',
    lower,
    lower,
  );
  if (owner !== null) return owner.did;
  return db.one<{ did: string }>('SELECT did FROM users WHERE handle = ?', lower)?.did ?? null;
}

/** The name responses use for a DID (ADR §9): username, else verified handle, else the DID. */
export function displayName(db: Db, did: string): string {
  const row = db.one<{ username: string | null; handle: string | null }>(
    `SELECT (SELECT username FROM accounts WHERE did = ?) AS username,
            (SELECT handle FROM users WHERE did = ?) AS handle`,
    did,
    did,
  );
  return row?.username ?? row?.handle ?? did;
}

/** Throws `no_account` unless `did` has an account: only signed-in DIDs hold protocol credentials (ADR §13). */
export function requireAccount(db: Db, did: string): AccountRow {
  const account = getAccount(db, did);
  if (account === null) throw new CredentialError('no_account', 'only signed-in accounts hold protocol credentials');
  return account;
}

// --- shared helpers ---------------------------------------------------------

/** Credential labels and app names: 1–64 characters after trimming, no control characters. */
export const MAX_LABEL_LENGTH = 64;

/** The trimmed label, null for an absent or empty one; throws `label_invalid` otherwise. */
export function normaliseLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  if (typeof label !== 'string') throw new CredentialError('label_invalid', 'label must be a string');
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if ([...trimmed].length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new CredentialError('label_invalid', `label must be at most ${MAX_LABEL_LENGTH} printable characters`);
  }
  return trimmed;
}

/** A random row id (128 bits, hex). Ids are not secrets: they appear in Settings and the journal. */
export function newCredentialId(random: Random): string {
  return bytesToHex(random.bytes(16));
}

/** `last_used_ms` is written at most once per this interval (N2-09). */
export const LAST_USED_RESOLUTION_MS = 60_000;

export type LastUsedTable = 'lastfm_sessions' | 'app_passwords' | 'lb_tokens';

/**
 * Record a use of credential `id`: writes `last_used_ms = now` only when it was
 * never set or is at least a minute old, so a busy scrobbler costs one write
 * per minute, not one per request. Returns true when it wrote.
 */
export function touchLastUsed(db: Db, table: LastUsedTable, id: string, now: number): boolean {
  const { rowsWritten } = db.run(
    `UPDATE ${table} SET last_used_ms = ? WHERE id = ? AND (last_used_ms IS NULL OR last_used_ms <= ?)`,
    now,
    id,
    now - LAST_USED_RESOLUTION_MS,
  );
  return rowsWritten > 0;
}

/** A Uint8Array as a standalone ArrayBuffer, the BLOB form `Db` binds. */
export function toBlob(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
