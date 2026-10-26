// Linked Last.fm and ListenBrainz accounts and the Last.fm link states
// (ADR 0005 §12.1, §13, §14.5; N3-08).
//
// - **Credentials are sealed.** A Last.fm `sk` or a ListenBrainz token is
//   stored only as box ciphertext (crypto/box.ts): purpose `linked-lastfm` /
//   `linked-listenbrainz` (HKDF salt `atmusic/linked/encryption/v1`, info
//   `lastfm` / `listenbrainz`), AAD `linked/<did>/<service>`, so a ciphertext
//   copied to another row fails to open. `key_id` records the sealing key.
// - **One link per (DID, service)** (UNIQUE). Linking again updates the row
//   in place — credential, remote user, status `active`, no last error — and
//   queues its held forward rows again (a relink after a revocation resumes
//   them). The forwarding flags are kept.
// - **Only signed-in accounts hold links** (`requireAccount`, N2-09).
// - **Delete** journals `{kind: 'linked_account', id, did}` inside the
//   deleting transaction, before it commits, then deletes the row; its
//   forward rows go with it (ON DELETE CASCADE, and deleted explicitly too).
// - **Link states** (Last.fm callback): 32 random bytes as 64 hex, valid
//   600 s, stored as SHA-256 with the DID and the SHA-256 of the web session
//   token that started the flow. Consuming a state deletes it, so it is
//   single-use; a state bound to another session is refused and left in
//   place (that request stores nothing at all). `sweepExpiredLinkStates` is
//   the expiry-sweep part (N4-01).

import type { Link } from '@atmusic/core/api-types';
import type { Clock, Random } from '@atmusic/core/deps';
import type { Revocations } from '../app/revocations';
import type { LinkedAccountRow, LinkService } from '../app/rows';
import { newCredentialId, requireAccount, toBlob } from '../credentials/accounts';
import { type Box, linkedAad, linkedPurpose } from '../crypto/box';
import { constantTimeEqual } from '../crypto/constant-time';
import { bytesToHex, hashToken } from '../crypto/tokens';
import type { Db } from '../do/db';
import { resumeHeldRows } from './forward-outbox';

/** How long a Last.fm link state is valid (ADR §12.1). */
export const LINK_STATE_TTL_MS = 600_000;
/** `remote_user` is at most this many characters (the contract's Link.remoteUser). */
export const MAX_REMOTE_USER_CHARS = 128;

const STATE_RE = /^[0-9a-f]{64}$/;

export interface LinkDeps {
  db: Db;
  clock: Clock;
  random: Random;
  box: Box;
}

function blobBytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The contract's Link (api/openapi.yaml v1.2). Never carries the credential. */
export function linkDto(row: LinkedAccountRow): Link {
  return {
    id: row.id,
    service: row.service,
    remoteUser: row.remote_user,
    forwardScrobbles: row.forward_scrobbles === 1,
    forwardNowPlaying: row.forward_now_playing === 1,
    status: row.status,
    lastError: row.last_error,
    createdAt: iso(row.created_at_ms),
    updatedAt: iso(row.updated_at_ms),
  } as Link;
}

// ---------------------------------------------------------------------------
// Link states

/** Creates a single-use state for `did`, bound to the session token's SHA-256. Returns the state. */
export function createLinkState(
  deps: Pick<LinkDeps, 'db' | 'random'>,
  input: { did: string; sessionTokenHash: Uint8Array; service: LinkService; now: number },
): string {
  if (input.sessionTokenHash.length !== 32) throw new RangeError('a session token hash is 32 bytes');
  const state = bytesToHex(deps.random.bytes(32));
  deps.db.run(
    'INSERT INTO link_states(state_hash, did, service, session_hash, expires_at_ms) VALUES (?, ?, ?, ?, ?)',
    toBlob(hashToken(state)),
    input.did,
    input.service,
    toBlob(input.sessionTokenHash),
    input.now + LINK_STATE_TTL_MS,
  );
  return state;
}

export type ConsumeLinkState =
  | { ok: true; did: string; service: LinkService }
  /** Unknown, already used, expired or malformed. */
  | { ok: false; reason: 'unknown' }
  /** Bound to another web session (or another DID): left in place, nothing changed. */
  | { ok: false; reason: 'other_session' };

/** Consumes `state` for the session whose token hash is `sessionTokenHash` (see the header). */
export function consumeLinkState(
  db: Db,
  input: { state: string; sessionTokenHash: Uint8Array; did: string; service: LinkService; now: number },
): ConsumeLinkState {
  if (!STATE_RE.test(input.state)) return { ok: false, reason: 'unknown' };
  const key = toBlob(hashToken(input.state));
  return db.tx((): ConsumeLinkState => {
    const row = db.one<{ did: string; service: LinkService; session_hash: ArrayBuffer; expires_at_ms: number }>(
      'SELECT did, service, session_hash, expires_at_ms FROM link_states WHERE state_hash = ?',
      key,
    );
    if (row === null) return { ok: false, reason: 'unknown' };
    if (row.expires_at_ms <= input.now) {
      db.run('DELETE FROM link_states WHERE state_hash = ?', key);
      return { ok: false, reason: 'unknown' };
    }
    if (
      !constantTimeEqual(blobBytes(row.session_hash), input.sessionTokenHash) ||
      row.did !== input.did ||
      row.service !== input.service
    ) {
      return { ok: false, reason: 'other_session' };
    }
    db.run('DELETE FROM link_states WHERE state_hash = ?', key);
    return { ok: true, did: row.did, service: row.service };
  });
}

/** Deletes up to `limit` expired link states (the expiry-sweep timer, N4-01). Returns how many. */
export function sweepExpiredLinkStates(db: Db, now: number, limit = 1000): number {
  return db.run(
    'DELETE FROM link_states WHERE state_hash IN (SELECT state_hash FROM link_states WHERE expires_at_ms <= ? LIMIT ?)',
    now,
    limit,
  ).rowsWritten;
}

// ---------------------------------------------------------------------------
// Links

export function getLink(db: Db, did: string, id: string): LinkedAccountRow | null {
  return db.one<LinkedAccountRow>('SELECT * FROM linked_accounts WHERE id = ? AND did = ?', id, did);
}

export function getLinkById(db: Db, id: string): LinkedAccountRow | null {
  return db.one<LinkedAccountRow>('SELECT * FROM linked_accounts WHERE id = ?', id);
}

export function listLinks(db: Db, did: string): LinkedAccountRow[] {
  return db.all<LinkedAccountRow>('SELECT * FROM linked_accounts WHERE did = ? ORDER BY created_at_ms, id', did);
}

export interface SaveLinkInput {
  did: string;
  service: LinkService;
  remoteUser: string;
  /** The Last.fm sk or the ListenBrainz token; sealed, never stored in the clear. */
  credential: string;
}

export interface SaveLinkResult {
  link: LinkedAccountRow;
  created: boolean;
  /** Held forward rows queued again by this relink. */
  resumed: number;
}

/** Stores (or replaces) the DID's link to `service` with its sealed credential (see the header). */
export function saveLink(deps: LinkDeps, input: SaveLinkInput): SaveLinkResult {
  const remoteUser = [...input.remoteUser].slice(0, MAX_REMOTE_USER_CHARS).join('');
  if (remoteUser === '') throw new RangeError('a linked account needs a remote user name');
  if (input.credential === '') throw new RangeError('a linked account needs a credential');
  const { db, box } = deps;
  const sealed = box.seal(linkedPurpose(input.service), input.credential, linkedAad(input.did, input.service));
  return db.tx((): SaveLinkResult => {
    requireAccount(db, input.did);
    const now = deps.clock.nowMs();
    const existing = db.one<LinkedAccountRow>(
      'SELECT * FROM linked_accounts WHERE did = ? AND service = ?',
      input.did,
      input.service,
    );
    if (existing !== null) {
      db.run(
        `UPDATE linked_accounts SET remote_user = ?, credential_ciphertext = ?, key_id = ?, status = 'active',
           last_error = NULL, updated_at_ms = ? WHERE id = ?`,
        remoteUser,
        toBlob(sealed),
        box.currentKeyId,
        now,
        existing.id,
      );
      const resumed = resumeHeldRows(db, existing.id, now);
      return { link: getLinkById(db, existing.id) as LinkedAccountRow, created: false, resumed };
    }
    const id = newCredentialId(deps.random);
    db.run(
      `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
         forward_now_playing, status, last_error, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'active', NULL, ?, ?)`,
      id,
      input.did,
      input.service,
      remoteUser,
      toBlob(sealed),
      box.currentKeyId,
      now,
      now,
    );
    return { link: getLinkById(db, id) as LinkedAccountRow, created: true, resumed: 0 };
  });
}

/** The link's credential in the clear (only for the request that sends it). Throws BoxError when it does not open. */
export function openLinkCredential(box: Box, row: LinkedAccountRow): string {
  return box.openText(
    linkedPurpose(row.service),
    blobBytes(row.credential_ciphertext),
    linkedAad(row.did, row.service),
  );
}

export interface LinkPatch {
  forwardScrobbles?: boolean;
  forwardNowPlaying?: boolean;
}

/** Sets the forwarding flags of the DID's link `id`; null when it is not theirs. */
export function patchLink(
  deps: Pick<LinkDeps, 'db' | 'clock'>,
  did: string,
  id: string,
  patch: LinkPatch,
): LinkedAccountRow | null {
  const { db } = deps;
  return db.tx(() => {
    const row = getLink(db, did, id);
    if (row === null) return null;
    const scrobbles = patch.forwardScrobbles ?? row.forward_scrobbles === 1;
    const nowPlaying = patch.forwardNowPlaying ?? row.forward_now_playing === 1;
    db.run(
      'UPDATE linked_accounts SET forward_scrobbles = ?, forward_now_playing = ?, updated_at_ms = ? WHERE id = ?',
      scrobbles ? 1 : 0,
      nowPlaying ? 1 : 0,
      deps.clock.nowMs(),
      id,
    );
    return getLinkById(db, id);
  });
}

/**
 * Deletes the DID's link `id` with its credential and every forward row,
 * journaling it first (ADR §14.5). False when it is not theirs.
 */
export function deleteLink(deps: { db: Db; revocations: Revocations }, did: string, id: string): boolean {
  const { db } = deps;
  return db.tx(() => {
    const row = getLink(db, did, id);
    if (row === null) return false;
    // A journal failure throws here and rolls the transaction back: nothing is deleted.
    deps.revocations.record({ kind: 'linked_account', id: row.id, did: row.did });
    db.run('DELETE FROM forward_outbox WHERE link_id = ?', row.id);
    db.run('DELETE FROM linked_accounts WHERE id = ?', row.id);
    return true;
  });
}

/**
 * Marks a link revoked by its upstream (`error` is a Link.lastError slug),
 * but only while it is still the active link with the credential that was
 * refused: `link` is the row as read before the request, and a relink that
 * replaced the credential while the request was in flight (saveLink sets a
 * fresh ciphertext) is left alone. True when the link was revoked; the caller
 * holds its rows only then.
 */
export function revokeLink(
  db: Db,
  link: Pick<LinkedAccountRow, 'id' | 'credential_ciphertext'>,
  error: string,
  now: number,
): boolean {
  return (
    db.run(
      `UPDATE linked_accounts SET status = 'revoked', last_error = ?, updated_at_ms = ?
       WHERE id = ? AND status = 'active' AND credential_ciphertext = ?`,
      error,
      now,
      link.id,
      toBlob(blobBytes(link.credential_ciphertext)),
    ).rowsWritten === 1
  );
}

/** Records a non-revoking problem on an active link (`error` is a Link.lastError slug). */
export function noteLinkError(db: Db, linkId: string, error: string | null, now: number): void {
  db.run(
    `UPDATE linked_accounts SET last_error = ?, updated_at_ms = ? WHERE id = ? AND last_error IS NOT ?`,
    error,
    now,
    linkId,
    error,
  );
}
