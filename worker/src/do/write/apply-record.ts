// Apply one verified record proof to the projection (ADR 0004 §5.4 step 7,
// §7.5). Synchronous over a Db; the drain calls it inside one `db.tx` after
// re-reading nothing outside it, so every guard below is read in the same
// transaction as the writes it protects.
//
// Order of checks (each one leaves every table untouched when it stops):
// 1. Settings records go to suppression.ts (they are processed even for a
//    suppressed DID, ADR §5.3).
// 2. Unknown or suppressed owner, or an unconfigured collection: `ignored`.
//    A hint for an unknown DID goes through admission, never straight here.
// 3. Per-DID floor: `commit.rev < users.max_rev` means the PDS served an older
//    head than one already applied: `stale_head` (the drain retries).
// 4. Per-URI guard: `record_state.revision >= rev`: `noop_older`, so the same
//    proof twice changes nothing and an older proof never resurrects a newer
//    deletion or overwrites a newer payload.
// Then:
// - present and valid: upsert the row (revision = commit.rev, keys from
//   @atmusic/core/music-key), record_state 'present';
// - present and invalid: delete the row, record_state 'excluded' with the
//   validation reason, counters('excluded', reason) += 1;
// - absent (a proven exclusion): delete the row, record_state 'absent';
// - `users.stats_version` += 1 whenever a scrobble row was inserted, changed
//   or deleted; `users.max_rev = max(max_rev, rev)`.
// Validation uses the hint receipt time for the +300 s bound (`receiptNs`).

import type { RecordProof } from '@atmusic/atproto/verify/types';
import { validateFollowRecord } from '@atmusic/core/follow';
import { MusicKeyError } from '@atmusic/core/music-key';
import { reasonText, validateScrobbleRecord } from '@atmusic/core/scrobble';
import { toStorage } from '@atmusic/core/timestamp';
import type { Db } from '../db';
import { advanceUser, bumpStatsVersion, isSuppressed, loadUser } from './account-state';
import {
  type CollectionKind,
  collectionKind,
  EXCLUDED_COUNTER,
  guardRevision,
  incrementCounter,
  musicKeyColumns,
  recordUri,
  writeRecordState,
} from './keys';
import { applySettingsAt } from './suppression';

export type ApplyOutcome = 'applied' | 'noop_older' | 'excluded' | 'absent' | 'stale_head' | 'ignored';

export interface ApplyResult {
  outcome: ApplyOutcome;
  /** The exclusion reason (`field: message`) when outcome is `excluded`. */
  reason?: string;
  /** Settings only: suppression was lifted; the caller admits a fresh snapshot. */
  admit: boolean;
  /** Settings only: the DID is now suppressed (its local data was deleted). */
  suppressed: boolean;
}

export interface ApplyOptions {
  /** Hint receipt time in ns: the +300 s validation bound. */
  receiptNs: bigint;
  /** The configured lexicon prefix. */
  prefix: string;
  /** Now in ns (injected clock): indexed_at, verified_at, last_activity_ms. */
  nowNs: bigint;
}

export function result(outcome: ApplyOutcome, extra: Partial<ApplyResult> = {}): ApplyResult {
  return { outcome, admit: false, suppressed: false, ...extra };
}

/** One verified record version of a scrobble or follow, at revision `rev`. */
export interface RecordTarget {
  did: string;
  kind: 'scrobble' | 'follow';
  collection: string;
  rkey: string;
  uri: string;
  rev: string;
  /** null: proven absent at `rev`. */
  present: { cid: string; record: unknown } | null;
}

export interface TargetResult {
  outcome: 'applied' | 'excluded' | 'absent';
  reason?: string;
  /** A scrobble row was inserted, changed or deleted. */
  statsChanged: boolean;
}

function deleteProjection(db: Db, kind: 'scrobble' | 'follow', uri: string): boolean {
  const sql =
    kind === 'scrobble'
      ? 'DELETE FROM scrobbles WHERE uri = ? RETURNING uri'
      : 'DELETE FROM follows WHERE uri = ? RETURNING uri';
  return db.all<{ uri: string }>(sql, uri).length > 0;
}

type Verdict =
  | { ok: true; write: () => boolean }
  | {
      ok: false;
      reason: string;
    };

function scrobbleVerdict(db: Db, t: RecordTarget, cid: string, record: unknown, o: ApplyOptions): Verdict {
  const v = validateScrobbleRecord(record, o.prefix, o.receiptNs);
  if (!v.ok) return { ok: false, reason: reasonText(v.reason) };
  const row = v.row;
  let keys: ReturnType<typeof musicKeyColumns>;
  try {
    keys = musicKeyColumns(row.artist, row.track, row.album);
  } catch (error) {
    // Unreachable after validation (same display-string rule); kept fail-closed.
    if (error instanceof MusicKeyError) return { ok: false, reason: `${error.field}: ${error.message}` };
    throw error;
  }
  return {
    ok: true,
    write: () => {
      const before = db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri = ?', t.uri);
      db.run(
        `INSERT INTO scrobbles(uri, cid, did, rkey, revision, artist, track, album, listened_at, created_at,
           duration_seconds, recording_mbid, indexed_at, artist_key, track_key, album_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, rkey = excluded.rkey, revision = excluded.revision,
           artist = excluded.artist, track = excluded.track, album = excluded.album,
           listened_at = excluded.listened_at, created_at = excluded.created_at,
           duration_seconds = excluded.duration_seconds, recording_mbid = excluded.recording_mbid,
           indexed_at = excluded.indexed_at, artist_key = excluded.artist_key,
           track_key = excluded.track_key, album_key = excluded.album_key`,
        t.uri,
        cid,
        t.did,
        t.rkey,
        t.rev,
        row.artist,
        row.track,
        row.album,
        row.listenedAt,
        row.createdAt,
        row.durationSeconds,
        row.recordingMbid,
        toStorage(o.nowNs),
        keys.artist_key,
        keys.track_key,
        keys.album_key,
      );
      return before === null || before.cid !== cid;
    },
  };
}

function followVerdict(db: Db, t: RecordTarget, cid: string, record: unknown, o: ApplyOptions): Verdict {
  const v = validateFollowRecord(record, o.prefix, o.receiptNs, t.did);
  if (!v.ok) return { ok: false, reason: reasonText(v.reason) };
  const row = v.row;
  return {
    ok: true,
    write: () => {
      db.run(
        `INSERT INTO follows(uri, cid, actor, subject, revision, created_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, subject = excluded.subject,
           revision = excluded.revision, created_at = excluded.created_at, indexed_at = excluded.indexed_at`,
        t.uri,
        cid,
        t.did,
        row.subject,
        t.rev,
        row.createdAt,
        toStorage(o.nowNs),
      );
      return false;
    },
  };
}

/**
 * Write one verified scrobble/follow version. No guards: the caller has
 * checked the owner, the per-DID floor (live proofs) and the per-URI guard.
 * Bumps `stats_version` when a scrobble row changed; does not touch max_rev.
 */
export function applyRecordTarget(db: Db, t: RecordTarget, o: ApplyOptions): TargetResult {
  const verifiedAt = toStorage(o.nowNs);
  let out: TargetResult;
  if (t.present === null) {
    const deleted = deleteProjection(db, t.kind, t.uri);
    writeRecordState(db, {
      uri: t.uri,
      did: t.did,
      collection: t.collection,
      revision: t.rev,
      cid: null,
      state: 'absent',
      reason: null,
      verified_at: verifiedAt,
    });
    out = { outcome: 'absent', statsChanged: t.kind === 'scrobble' && deleted };
  } else {
    const { cid, record } = t.present;
    const verdict =
      t.kind === 'scrobble' ? scrobbleVerdict(db, t, cid, record, o) : followVerdict(db, t, cid, record, o);
    if (verdict.ok) {
      const changed = verdict.write();
      writeRecordState(db, {
        uri: t.uri,
        did: t.did,
        collection: t.collection,
        revision: t.rev,
        cid,
        state: 'present',
        reason: null,
        verified_at: verifiedAt,
      });
      out = { outcome: 'applied', statsChanged: t.kind === 'scrobble' && changed };
    } else {
      const deleted = deleteProjection(db, t.kind, t.uri);
      writeRecordState(db, {
        uri: t.uri,
        did: t.did,
        collection: t.collection,
        revision: t.rev,
        cid,
        state: 'excluded',
        reason: verdict.reason,
        verified_at: verifiedAt,
      });
      incrementCounter(db, EXCLUDED_COUNTER, verdict.reason);
      out = { outcome: 'excluded', reason: verdict.reason, statsChanged: t.kind === 'scrobble' && deleted };
    }
  }
  if (out.statsChanged) bumpStatsVersion(db, t.did);
  return out;
}

/** Apply a verified getRecord proof (present or proven absent) at its commit's revision. */
export function applyRecordProof(db: Db, proof: RecordProof, o: ApplyOptions): ApplyResult {
  const did = proof.commit.did;
  const rev = proof.commit.rev;
  const kind: CollectionKind | null = collectionKind(o.prefix, proof.collection);
  if (kind === null) return result('ignored');
  if (kind === 'settings') {
    return applySettingsAt(
      db,
      {
        did,
        rkey: proof.rkey,
        rev,
        present: proof.state === 'present' ? { cid: proof.cid, record: proof.record } : null,
      },
      o,
      { floor: true },
    );
  }
  const uri = recordUri(did, proof.collection, proof.rkey);
  if (isSuppressed(db, did)) return result('ignored');
  const user = loadUser(db, did);
  if (user === null) return result('ignored');
  if (user.max_rev !== null && rev < user.max_rev) return result('stale_head');
  const guard = guardRevision(db, uri);
  if (guard !== null && guard >= rev) return result('noop_older');

  const applied = applyRecordTarget(
    db,
    {
      did,
      kind,
      collection: proof.collection,
      rkey: proof.rkey,
      uri,
      rev,
      present: proof.state === 'present' ? { cid: proof.cid, record: proof.record } : null,
    },
    o,
  );
  advanceUser(db, did, rev, o.nowNs);
  return result(applied.outcome, applied.reason === undefined ? {} : { reason: applied.reason });
}
