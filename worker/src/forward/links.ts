// Linked Last.fm and ListenBrainz accounts and the Last.fm link states
// (ADR 0005 §12.1, §13, §14.5; N3-08).
//
// - **Credentials are sealed.** A Last.fm `sk` or a ListenBrainz token is
//   stored only as box ciphertext (crypto/box.ts): purpose `linked-lastfm` /
//   `linked-listenbrainz` (HKDF salt `atmusic/linked/encryption/v1`, info
//   `lastfm` / `listenbrainz`), AAD `linked/<did>/<service>`, so a ciphertext
//   copied to another row fails to open. `key_id` records the sealing key.
// - **One link per (DID, service)** (UNIQUE). Linking again updates the row
//   in place. A same-remote relink preserves its generation and resumes held
//   rows; a different remote rotates generation and expires the old rows.
//   A request already in flight may have reached the old remote before the
//   relink committed; local generation guards discard its eventual response,
//   but cannot retract that upstream request.
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
import { admissionHighWater, closeOpenLinkGap, openLinkGap } from './coverage';

/** How long a Last.fm link state is valid (ADR §12.1). */
export const LINK_STATE_TTL_MS = 600_000;
/** `remote_user` is at most this many characters (the contract's Link.remoteUser). */
export const MAX_REMOTE_USER_CHARS = 128;
/** Consecutive transient forward failures before a link exposes a persistent error. */
export const LINK_ERROR_THRESHOLD = 3;

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
export function linkDto(row: LinkedAccountRow, db: Db): Link {
  const pullState = db.one<{ hold_reason: string | null }>(
    'SELECT hold_reason FROM linked_pull_state WHERE link_id=? AND generation=?',
    row.id,
    row.generation,
  );
  const holdReason = pullState?.hold_reason;
  const needsReauth = holdReason === 'session_missing' || holdReason === 'reauth_required';
  const queue = {
    queued:
      db.one<{ n: number }>(
        "SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND generation=? AND state IN ('queued','held')",
        row.id,
        row.generation,
      )?.n ?? 0,
    failed:
      db.one<{ n: number }>(
        "SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND generation=? AND state='failed'",
        row.id,
        row.generation,
      )?.n ?? 0,
  };
  queue.queued +=
    db.one<{ n: number }>(
      "SELECT count(*) AS n FROM listenbrainz_deletes WHERE link_id=? AND generation=? AND state='queued'",
      row.id,
      row.generation,
    )?.n ?? 0;
  queue.failed +=
    db.one<{ n: number }>(
      "SELECT count(*) AS n FROM listenbrainz_deletes WHERE link_id=? AND generation=? AND state='failed'",
      row.id,
      row.generation,
    )?.n ?? 0;
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
    sync: {
      backfill: {
        state: row.backfill_state,
        done: row.backfill_done,
        total: row.backfill_total,
        ...(row.backfill_last_error === 'retry_exhausted' ? { lastError: 'retry_exhausted' as const } : {}),
      },
      pullEnabled: row.pull_enabled === 1,
      ...(holdReason === null || holdReason === undefined
        ? {}
        : { holdReason: holdReason as NonNullable<Link['sync']>['holdReason'] }),
      ...(holdReason === null || holdReason === undefined ? {} : { needsReauth }),
      ...(row.last_success_ms === null ? {} : { lastSuccessAt: iso(row.last_success_ms) }),
      ...(row.last_failure_ms === null ? {} : { lastFailureAt: iso(row.last_failure_ms) }),
      ...(row.last_error === null ? {} : { lastError: row.last_error as Link['lastError'] }),
      ...(row.last_pull_ms === null ? {} : { lastPulledAt: iso(row.last_pull_ms) }),
      queued: queue.queued,
      failed: queue.failed,
    },
  };
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
      const changedRemote = existing.remote_user !== remoteUser;
      const reactivated = existing.status !== 'active';
      const generation = existing.generation + (changedRemote ? 1 : 0);
      const generationStartSeq = changedRemote
        ? (db.one<{ boundary: number }>('SELECT coalesce(max(admission_seq),0) AS boundary FROM forward_admissions')
            ?.boundary ?? 0)
        : existing.generation_start_seq;
      if (changedRemote || reactivated) db.run('DELETE FROM link_backfill_items WHERE link_id=?', existing.id);
      if (reactivated && !changedRemote) closeOpenLinkGap(db, existing, admissionHighWater(db), now);
      if (changedRemote)
        db.run(
          `UPDATE forward_outbox SET state='expired',last_error='account_changed',updated_at_ms=?
           WHERE link_id=? AND generation=? AND state IN ('queued','held')`,
          now,
          existing.id,
          existing.generation,
        );
      if (changedRemote)
        db.run(
          `UPDATE listenbrainz_deletes SET state='expired',last_error='account_changed',updated_at_ms=?
           WHERE link_id=? AND generation=? AND state='queued'`,
          now,
          existing.id,
          existing.generation,
        );
      db.run(
        `UPDATE linked_accounts SET remote_user = ?, credential_ciphertext = ?, key_id = ?, status = 'active',
           last_error=NULL,consecutive_failures=0,
           last_success_ms=CASE WHEN ? THEN NULL ELSE last_success_ms END,
           last_failure_ms=CASE WHEN ? THEN NULL ELSE last_failure_ms END,
           backfill_state=CASE WHEN ? THEN 'pending' ELSE backfill_state END,
           backfill_cursor=CASE WHEN ? THEN NULL ELSE backfill_cursor END,
           backfill_total=CASE WHEN ? THEN 0 ELSE backfill_total END,
           backfill_done=CASE WHEN ? THEN 0 ELSE backfill_done END,
           backfill_failures=CASE WHEN ? THEN 0 ELSE backfill_failures END,
           backfill_next_attempt_ms=CASE WHEN ? THEN NULL ELSE backfill_next_attempt_ms END,
           backfill_run_revision=backfill_run_revision+CASE WHEN ? THEN 1 ELSE 0 END,
           backfill_discovery_cursor=CASE WHEN ? THEN NULL ELSE backfill_discovery_cursor END,
           backfill_discovery_done=CASE WHEN ? THEN 0 ELSE backfill_discovery_done END,
           backfill_last_error=CASE WHEN ? THEN NULL ELSE backfill_last_error END,
           pull_watermark_ms=CASE WHEN ? THEN ? ELSE pull_watermark_ms END,
           sync_remote_user=CASE WHEN ? THEN ? ELSE sync_remote_user END,
           generation=?,generation_start_seq=?,updated_at_ms=? WHERE id=?`,
        remoteUser,
        toBlob(sealed),
        box.currentKeyId,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        changedRemote ? 1 : 0,
        now,
        changedRemote ? 1 : 0,
        remoteUser,
        generation,
        generationStartSeq,
        now,
        existing.id,
      );
      if (reactivated && !changedRemote)
        db.run(
          `UPDATE linked_accounts SET backfill_state='pending',backfill_cursor=NULL,backfill_total=0,backfill_done=0,
             backfill_failures=0,backfill_next_attempt_ms=NULL,backfill_run_revision=backfill_run_revision+1,
             backfill_discovery_cursor=NULL,backfill_discovery_done=0,backfill_last_error=NULL WHERE id=?`,
          existing.id,
        );
      if (changedRemote)
        db.run('DELETE FROM linked_pull_items WHERE link_id=? AND generation=?', existing.id, existing.generation);
      db.run(
        `INSERT OR IGNORE INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
          listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        existing.id,
        generation,
        input.service,
        remoteUser,
        now,
        now,
        now,
        now,
        now,
        now,
      );
      if (changedRemote)
        db.run('DELETE FROM forward_love_lanes WHERE link_id=? AND generation=?', existing.id, existing.generation);
      db.run(
        `UPDATE linked_pull_state SET hold_reason=NULL,retry_at_ms=NULL,failures=0,listen_round_saturated=0,
          listen_round_upper_ms=NULL,listen_round_floor_ms=NULL,listen_round_page=NULL,page_cursor=NULL,
          poll_next_at_ms=?,updated_at_ms=?
         WHERE link_id=? AND generation=?`,
        now,
        now,
        existing.id,
        generation,
      );
      const resumed = resumeHeldRows(db, existing.id, now, generation);
      return { link: getLinkById(db, existing.id) as LinkedAccountRow, created: false, resumed };
    }
    const id = newCredentialId(deps.random);
    const generationStartSeq =
      db.one<{ boundary: number }>('SELECT coalesce(max(admission_seq),0) AS boundary FROM forward_admissions')
        ?.boundary ?? 0;
    db.run(
      `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
         forward_now_playing, status, last_error, generation, generation_start_seq, created_at_ms, updated_at_ms,
         backfill_state, pull_enabled, pull_watermark_ms, sync_remote_user)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'active', NULL, 1, ?, ?, ?, 'pending', 1, ?, ?)`,
      id,
      input.did,
      input.service,
      remoteUser,
      toBlob(sealed),
      box.currentKeyId,
      generationStartSeq,
      now,
      now,
      now,
      remoteUser,
    );
    db.run(
      `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
        listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id,
      1,
      input.service,
      remoteUser,
      now,
      now,
      now,
      now,
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
  pullEnabled?: boolean;
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
    const pullEnabled = patch.pullEnabled ?? row.pull_enabled === 1;
    const resumePull = row.pull_enabled === 0 && pullEnabled;
    const enableScrobbles = row.forward_scrobbles === 0 && scrobbles;
    const disableScrobbles = row.forward_scrobbles === 1 && !scrobbles;
    const now = deps.clock.nowMs();
    if (enableScrobbles) db.run('DELETE FROM link_backfill_items WHERE link_id=?', row.id);
    if (disableScrobbles) {
      closeOpenLinkGap(db, row, row.generation_start_seq, now);
      openLinkGap(db, row, 'disabled', now);
    }
    if (enableScrobbles) {
      const highWater = admissionHighWater(db);
      if (!closeOpenLinkGap(db, row, highWater, now) && highWater > row.generation_start_seq) {
        openLinkGap(db, row, 'legacy', now, row.generation_start_seq);
        closeOpenLinkGap(db, row, highWater, now);
      }
    }
    db.run(
      `UPDATE linked_accounts SET forward_scrobbles = ?, forward_now_playing = ?, pull_enabled = ?,
       backfill_state=CASE WHEN ? THEN 'pending' ELSE backfill_state END,
       backfill_cursor=CASE WHEN ? THEN NULL ELSE backfill_cursor END,
       backfill_total=CASE WHEN ? THEN 0 ELSE backfill_total END,
       backfill_done=CASE WHEN ? THEN 0 ELSE backfill_done END,
       backfill_failures=CASE WHEN ? THEN 0 ELSE backfill_failures END,
       backfill_next_attempt_ms=CASE WHEN ? THEN NULL ELSE backfill_next_attempt_ms END,
       backfill_run_revision=backfill_run_revision+CASE WHEN ? THEN 1 ELSE 0 END,
       backfill_discovery_cursor=CASE WHEN ? THEN NULL ELSE backfill_discovery_cursor END,
       backfill_discovery_done=CASE WHEN ? THEN 0 ELSE backfill_discovery_done END,
       backfill_last_error=CASE WHEN ? THEN NULL ELSE backfill_last_error END,
       updated_at_ms = ? WHERE id = ?`,
      scrobbles ? 1 : 0,
      nowPlaying ? 1 : 0,
      pullEnabled ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      enableScrobbles ? 1 : 0,
      now,
      id,
    );
    if (resumePull)
      db.run(
        `UPDATE linked_pull_state SET poll_next_at_ms=?,hold_reason=NULL,retry_at_ms=NULL,failures=0,
          listen_round_saturated=0,listen_round_upper_ms=NULL,listen_round_floor_ms=NULL,listen_round_page=NULL,
          page_cursor=NULL,updated_at_ms=?
         WHERE link_id=? AND generation=?`,
        deps.clock.nowMs(),
        deps.clock.nowMs(),
        id,
        row.generation,
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
    db.run('DELETE FROM forward_love_recording_targets WHERE link_id=?', row.id);
    db.run(
      `DELETE FROM forward_unlove_lookup_progress WHERE unlove_rowid IN (
        SELECT rowid FROM forward_outbox WHERE link_id=? AND kind='unlove'
      )`,
      row.id,
    );
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
  link: Pick<LinkedAccountRow, 'id' | 'generation' | 'credential_ciphertext'>,
  error: string,
  now: number,
): boolean {
  const safeError = /^[a-z0-9_]{1,64}$/.test(error) ? error : 'credential_revoked';
  return db.tx(() => {
    const revoked = db.run(
      `UPDATE linked_accounts SET status='revoked',last_error=?,last_failure_ms=?,
         consecutive_failures=consecutive_failures+1,updated_at_ms=?
       WHERE id = ? AND generation = ? AND status = 'active' AND credential_ciphertext = ?`,
      safeError,
      now,
      now,
      link.id,
      link.generation,
      toBlob(blobBytes(link.credential_ciphertext)),
    ).rowsWritten === 1;
    if (revoked) openLinkGap(db, link, 'revoked', now);
    return revoked;
  });
}

/** Records a generation-scoped failure; transient errors surface after three consecutive failures. */
export function noteLinkError(
  db: Db,
  link: Pick<LinkedAccountRow, 'id' | 'generation'>,
  error: string,
  now: number,
  immediate = false,
): boolean {
  const safeError = /^[a-z0-9_]{1,64}$/.test(error) ? error : 'upstream_error';
  return (
    db.run(
      `UPDATE linked_accounts SET
         last_error=CASE WHEN ? OR consecutive_failures+1>=? THEN ? ELSE last_error END,
         last_failure_ms=?,consecutive_failures=consecutive_failures+1,updated_at_ms=?
       WHERE id=? AND generation=? AND status='active'`,
      immediate ? 1 : 0,
      LINK_ERROR_THRESHOLD,
      safeError,
      now,
      now,
      link.id,
      link.generation,
    ).rowsWritten === 1
  );
}

/** Records a successful response and clears the consecutive failure state for this generation. */
export function noteLinkSuccess(db: Db, link: Pick<LinkedAccountRow, 'id' | 'generation'>, now: number): boolean {
  return (
    db.run(
      `UPDATE linked_accounts SET last_error=NULL,last_success_ms=?,consecutive_failures=0,updated_at_ms=?
       WHERE id=? AND generation=? AND status='active'`,
      now,
      now,
      link.id,
      link.generation,
    ).rowsWritten === 1
  );
}
