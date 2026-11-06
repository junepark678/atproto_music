// ListenBrainz user tokens (ADR 0005 §8.2, §13; N2-09).
//
// - UUIDv4 values (122 random bits, crypto/tokens.ts) issued by
//   `POST /api/v1/account/listenbrainz-tokens` (N3-10), returned once by
//   `createLbToken`, labelled, and stored only as SHA-256 in `lb_tokens`. A
//   user can hold several.
// - `verifyLbToken` answers the DID and the user name the ListenBrainz API
//   reports (`user_name`, ADR §9: username, else verified handle, else DID),
//   with a constant-time digest comparison. Parsing the `Authorization`
//   header is the routes' job (N3-05); this takes the bare token.
// - `last_used_ms` is updated at most once per minute.
// - `revokeLbToken` journals `{kind: 'lb_token', id, did}` inside the deleting
//   transaction, before it commits (ADR §14.5).
//
// Our tokens are not MetaBrainz tokens: a `meba_` OAuth token, or anything
// that is not a UUID, is simply unknown.

import type { LbTokenRow } from '../app/rows';
import { constantTimeEqual } from '../crypto/constant-time';
import { hashToken, newListenBrainzToken } from '../crypto/tokens';
import type { Db } from '../do/db';
import {
  type CredentialDeps,
  displayName,
  newCredentialId,
  normaliseLabel,
  requireAccount,
  toBlob,
  touchLastUsed,
} from './accounts';

export interface CreatedLbToken {
  id: string;
  /** The token itself: shown to the user once, never stored. */
  token: string;
  label: string | null;
  createdAtMs: number;
}

export interface LbTokenInfo {
  id: string;
  label: string | null;
  createdAtMs: number;
  lastUsedMs: number | null;
}

export interface VerifiedLbToken {
  id: string;
  did: string;
  /** The ListenBrainz `user_name` (ADR §9). */
  username: string;
}

/** Issue a new ListenBrainz token for a signed-in DID. The plaintext is in the result only. */
export function createLbToken(deps: CredentialDeps, input: { did: string; label?: string | null }): CreatedLbToken {
  const label = normaliseLabel(input.label);
  return deps.db.tx(() => {
    requireAccount(deps.db, input.did);
    const id = newCredentialId(deps.random);
    const token = newListenBrainzToken(deps.random);
    const now = deps.clock.nowMs();
    deps.db.run(
      'INSERT INTO lb_tokens (id, did, label, hash, created_at_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, NULL)',
      id,
      input.did,
      label,
      toBlob(hashToken(token)),
      now,
    );
    return { id, token, label, createdAtMs: now };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The token in the form we issued it (lowercase hyphenated UUID), or null when it cannot be ours. */
export function normaliseLbToken(token: string): string | null {
  if (typeof token !== 'string') return null;
  const lower = token.trim().toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

/** The owner of ListenBrainz token `token`, or null. The digest comparison is constant-time. */
export function verifyLbToken(deps: Pick<CredentialDeps, 'db' | 'clock'>, token: string): VerifiedLbToken | null {
  const { db } = deps;
  const normalised = normaliseLbToken(token);
  if (normalised === null) return null;
  const digest = hashToken(normalised);
  const row = db.one<Pick<LbTokenRow, 'id' | 'did' | 'hash'>>(
    'SELECT id, did, hash FROM lb_tokens WHERE hash = ?',
    toBlob(digest),
  );
  if (row === null || !constantTimeEqual(row.hash, digest)) return null;
  touchLastUsed(db, 'lb_tokens', row.id, deps.clock.nowMs());
  return { id: row.id, did: row.did, username: displayName(db, row.did) };
}

/** The DID's ListenBrainz tokens, newest first, metadata only. */
export function listLbTokens(db: Db, did: string): LbTokenInfo[] {
  return db
    .all<Pick<LbTokenRow, 'id' | 'label' | 'created_at_ms' | 'last_used_ms'>>(
      'SELECT id, label, created_at_ms, last_used_ms FROM lb_tokens WHERE did = ? ORDER BY created_at_ms DESC, id',
      did,
    )
    .map((r) => ({ id: r.id, label: r.label, createdAtMs: r.created_at_ms, lastUsedMs: r.last_used_ms }));
}

/** Delete token `id` of `did`, journaling the revocation before the delete commits. False when there is none. */
export function revokeLbToken(deps: Pick<CredentialDeps, 'db' | 'revocations'>, did: string, id: string): boolean {
  return deps.db.tx(() => {
    const gone = deps.db.all<{ id: string }>('DELETE FROM lb_tokens WHERE id = ? AND did = ? RETURNING id', id, did);
    if (gone.length === 0) return false;
    deps.revocations.record({ kind: 'lb_token', id, did });
    return true;
  });
}
