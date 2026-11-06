// The signed `<prefix>.settings/self` opt-out (ADR 0004 §5.3, A10).
// Synchronous; every caller runs inside `db.tx`.
//
// - `indexing: "disabled"` (valid, verified): `disconnectLocalData` deletes the
//   DID's scrobbles, actor follows, record_state, hints, repo_jobs,
//   stats_cache, snapshot/commit/identity cache rows, per-DID indexing_status
//   and the users row, and upserts `suppression(did, settings_uri,
//   settings_rev, suppressed_at)`. `backfill_generation` is kept, so a later
//   admission gets a fresh, never reused generation. Other owners' follows of
//   the DID stay stored but are hidden by read/visibility.ts (the subject is
//   not an active user). It is honoured for an unknown DID too, so the opt-out
//   survives a rebuild of the index.
// - `indexing: "enabled"`, or a proven absent `settings/self`, with a revision
//   above `settings_rev`: the suppression row is deleted and the result asks
//   the caller to admit a fresh snapshot (`admit: true`). The settings URI's
//   record_state is written at that revision, so an older "disabled" proof
//   can never re-suppress.
// - While suppressed nothing but the suppression row is kept: an invalid
//   settings record or an older/equal revision changes nothing.

import type { RecordProof } from '@atmusic/atproto/verify/types';
import { collectionsFor } from '@atmusic/core/namespace';
import { reasonText } from '@atmusic/core/scrobble';
import { SETTINGS_RKEY, validateSettingsRecord } from '@atmusic/core/settings';
import { toStorage } from '@atmusic/core/timestamp';
import type { Db } from '../db';
import { advanceUser, loadUser } from './account-state';
import type { ApplyOptions, ApplyOutcome, ApplyResult } from './apply-record';
import { EXCLUDED_COUNTER, guardRevision, incrementCounter, recordUri, writeRecordState } from './keys';

export interface SuppressionRow {
  did: string;
  suppressed_at: string;
  settings_uri: string | null;
  settings_rev: string | null;
}

export function loadSuppression(db: Db, did: string): SuppressionRow | null {
  return db.one<SuppressionRow>(
    'SELECT did, suppressed_at, settings_uri, settings_rev FROM suppression WHERE did = ?',
    did,
  );
}

function out(outcome: ApplyOutcome, extra: Partial<ApplyResult> = {}): ApplyResult {
  return { outcome, admit: false, suppressed: false, ...extra };
}

/** Rows of other tables keyed by the DID, deleted on disconnect (the users row last). */
const DISCONNECT_DELETES: readonly string[] = [
  'DELETE FROM scrobbles WHERE did = ?',
  'DELETE FROM follows WHERE actor = ?',
  'DELETE FROM record_state WHERE did = ?',
  'DELETE FROM hints WHERE did = ?',
  'DELETE FROM repo_jobs WHERE did = ?',
  'DELETE FROM stats_cache WHERE did = ?',
  'DELETE FROM snapshot_blocks WHERE did = ?',
  'DELETE FROM verified_commits WHERE did = ?',
  'DELETE FROM identity_cache WHERE did = ?',
  'DELETE FROM indexing_status WHERE scope = ?',
  'DELETE FROM users WHERE did = ?',
];

export interface DisconnectInput {
  settingsUri: string;
  settingsRev: string;
  nowNs: bigint;
}

/** Drop every local row of `did` and keep only the suppression marker. */
export function disconnectLocalData(db: Db, did: string, input: DisconnectInput): void {
  if (did === 'global') throw new RangeError('refusing to disconnect the global indexing scope');
  for (const sql of DISCONNECT_DELETES) db.run(sql, did);
  db.run(
    `INSERT INTO suppression(did, suppressed_at, settings_uri, settings_rev) VALUES (?, ?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET suppressed_at = excluded.suppressed_at,
       settings_uri = excluded.settings_uri, settings_rev = excluded.settings_rev`,
    did,
    toStorage(input.nowNs),
    input.settingsUri,
    input.settingsRev,
  );
}

export interface SettingsTarget {
  did: string;
  rkey: string;
  rev: string;
  /** null: proven absent at `rev`. */
  present: { cid: string; record: unknown } | null;
}

/**
 * Apply one verified settings version. `floor` applies the per-DID
 * `users.max_rev` floor (live proofs); a snapshot passes false and has
 * already checked the generation.
 */
export function applySettingsAt(db: Db, t: SettingsTarget, o: ApplyOptions, g: { floor: boolean }): ApplyResult {
  const collection = collectionsFor(o.prefix).settings;
  const uri = recordUri(t.did, collection, t.rkey);
  const suppression = loadSuppression(db, t.did);
  const user = suppression === null ? loadUser(db, t.did) : null;

  if (suppression !== null) {
    // Only the owner's `self` record can lift the opt-out, and only at a newer revision.
    if (t.rkey !== SETTINGS_RKEY) return out('ignored');
    if (suppression.settings_rev !== null && t.rev <= suppression.settings_rev) return out('noop_older');
  } else {
    if (g.floor && user?.max_rev != null && t.rev < user.max_rev) return out('stale_head');
    const guard = guardRevision(db, uri);
    if (guard !== null && guard >= t.rev) return out('noop_older');
  }

  const verifiedAt = toStorage(o.nowNs);
  let indexing: 'enabled' | 'disabled' | null = null;
  if (t.present !== null) {
    const v = validateSettingsRecord(t.present.record, o.prefix, o.receiptNs, t.rkey);
    if (!v.ok) {
      const reason = reasonText(v.reason);
      // An invalid record is not an opt-out, and it does not lift one either.
      if (suppression !== null || user === null) return out('excluded', { reason });
      writeRecordState(db, {
        uri,
        did: t.did,
        collection,
        revision: t.rev,
        cid: t.present.cid,
        state: 'excluded',
        reason,
        verified_at: verifiedAt,
      });
      incrementCounter(db, EXCLUDED_COUNTER, reason);
      advanceUser(db, t.did, t.rev, o.nowNs);
      return out('excluded', { reason });
    }
    indexing = v.row.indexing;
  }

  if (indexing === 'disabled') {
    disconnectLocalData(db, t.did, { settingsUri: uri, settingsRev: t.rev, nowNs: o.nowNs });
    return out('applied', { suppressed: true });
  }

  const outcome: ApplyOutcome = t.present === null ? 'absent' : 'applied';
  // An unknown, unsuppressed DID is admitted through the drain, not here.
  if (suppression === null && user === null) return out('ignored');
  writeRecordState(db, {
    uri,
    did: t.did,
    collection,
    revision: t.rev,
    cid: t.present?.cid ?? null,
    state: t.present === null ? 'absent' : 'present',
    reason: null,
    verified_at: verifiedAt,
  });
  if (suppression !== null) {
    db.run('DELETE FROM suppression WHERE did = ?', t.did);
    return out(outcome, { admit: true });
  }
  advanceUser(db, t.did, t.rev, o.nowNs);
  return out(outcome);
}

/** Apply a verified proof of `did`'s settings record (live path, with the per-DID floor). */
export function applySettings(db: Db, did: string, proof: RecordProof, o: ApplyOptions): ApplyResult {
  if (proof.commit.did !== did) throw new RangeError(`proof is for ${proof.commit.did}, not ${did}`);
  if (proof.collection !== collectionsFor(o.prefix).settings) {
    throw new RangeError(`not a settings proof: ${proof.collection}`);
  }
  return applySettingsAt(
    db,
    {
      did,
      rkey: proof.rkey,
      rev: proof.commit.rev,
      present: proof.state === 'present' ? { cid: proof.cid, record: proof.record } : null,
    },
    o,
    { floor: true },
  );
}
