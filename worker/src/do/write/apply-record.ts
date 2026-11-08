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
// - scrobbles and batch containers also record verified membership
//   (migration 10, keys.ts noteRecord*/noteBatchEntries): a valid container
//   version lists every valid-TID entry present or excluded and marks the
//   rest absent; an absent record marks itself and all its entries absent
//   (`last_absent_revision`, the incarnation boundary of removal receipts);
// - `users.stats_version` += 1 whenever a scrobble row was inserted, changed
//   or deleted; `users.max_rev = max(max_rev, rev)`.
// Validation uses the hint receipt time for the +300 s bound (`receiptNs`).
//
// ADR 0005 §6.5 (N3-11):
// - A scrobble also projects the §6.2 optional fields its validated record
//   kept, in their remote spelling like the v1 columns: album_artist,
//   track_number, artist_mbids (JSON array text), release_mbid,
//   release_group_mbid, isrc, submission_client and music_service; plus
//   album_artist_key (the artist music key of albumArtist) and recording_msid
//   (§8.4, from artist_key and track_key, so every projected scrobble has
//   one). A field the validator dropped, or one the record never had, is
//   NULL, and a newer revision without a field clears it. The v1 columns are
//   computed exactly as before; the /api/v1 stats keep grouping by
//   (artist_key, album_key).
// - A `<p>.love` record projects into `loves` behind the same guards (owner,
//   per-DID floor, per-URI record_state revision): present and valid upserts
//   the row, invalid deletes it and records `excluded` with its reason, a
//   proven absence deletes it and records `absent`. Loves never touch
//   `users.stats_version` (no /api/v1 stat reads them).

import { encode } from '@atcute/cbor';
import type { RecordProof } from '@atmusic/atproto/verify/types';
import type { Random } from '@atmusic/core/deps';
import { validateFollowRecord } from '@atmusic/core/follow';
import { validateLoveRecord } from '@atmusic/core/love';
import { MusicKeyError } from '@atmusic/core/music-key';
import { reasonText, type ScrobbleRow, validateScrobbleRecord } from '@atmusic/core/scrobble';
import { MAX_INGEST_CBOR_BYTES, validateScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import { isTid } from '@atmusic/core/syntax';
import { toStorage } from '@atmusic/core/timestamp';
import { enqueueTrack } from '../../musicbrainz/store';
import { admitForwardIdentity, projectionListenKey } from '../../forward/projection';
import { enqueueForwards } from '../../outbox/forward-enqueue';
import type { Db } from '../db';
import { advanceUser, bumpStatsVersion, isSuppressed, loadUser } from './account-state';
import {
  albumArtistKey,
  type CollectionKind,
  collectionKind,
  EXCLUDED_COUNTER,
  guardRevision,
  incrementCounter,
  type MembershipEntry,
  musicKeyColumns,
  noteBatchEntries,
  noteRecordAbsent,
  noteRecordPresent,
  readRecordState,
  recordingMsidOf,
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
  /** Explicit opt-in for forwarding a live Jetstream projection; absent elsewhere. */
  forwarding?: { random: Random };
}

export function result(outcome: ApplyOutcome, extra: Partial<ApplyResult> = {}): ApplyResult {
  return { outcome, admit: false, suppressed: false, ...extra };
}

/** The collections whose records project into a table of their own (settings go to suppression.ts). */
export type ProjectedKind = Exclude<CollectionKind, 'settings'>;

/** One verified record version of a scrobble, follow or love, at revision `rev`. */
export interface RecordTarget {
  did: string;
  kind: ProjectedKind;
  collection: string;
  rkey: string;
  uri: string;
  /** Present only for an item projected from a batch container. */
  recordUri?: string;
  listenId?: string;
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

const DELETE_PROJECTION: Readonly<Record<ProjectedKind, string>> = {
  scrobble: 'DELETE FROM scrobbles WHERE uri = ? RETURNING uri',
  scrobbleBatch: 'DELETE FROM scrobbles WHERE record_uri = ? RETURNING uri',
  follow: 'DELETE FROM follows WHERE uri = ? RETURNING uri',
  love: 'DELETE FROM loves WHERE uri = ? RETURNING uri',
};

function deleteProjection(db: Db, kind: ProjectedKind, uri: string): boolean {
  return db.all<{ uri: string }>(DELETE_PROJECTION[kind], uri).length > 0;
}

/** The migration-2 scrobble columns of a validated row (ADR 0005 §6.2, §6.5); NULL where the record has no value. */
export interface ScrobbleFieldColumns {
  album_artist: string | null;
  album_artist_key: string | null;
  track_number: number | null;
  /** JSON array text, remote spelling and order. */
  artist_mbids: string | null;
  release_mbid: string | null;
  release_group_mbid: string | null;
  isrc: string | null;
  submission_client: string | null;
  music_service: string | null;
  recording_msid: string;
}

/**
 * The §6.2 columns of a validated scrobble. `row.record` holds only the fields
 * the validator kept. An album artist whose key cannot be computed
 * (unreachable: the validator applies the same display-string rule) is
 * dropped together with its key rather than stored without one.
 */
export function scrobbleFieldColumns(row: ScrobbleRow, artist_key: string, track_key: string): ScrobbleFieldColumns {
  const r = row.record;
  let albumArtist: string | null = r.albumArtist ?? null;
  let albumKey: string | null = null;
  if (albumArtist !== null) {
    try {
      albumKey = albumArtistKey(albumArtist);
    } catch (error) {
      if (!(error instanceof MusicKeyError)) throw error;
      albumArtist = null;
    }
  }
  return {
    album_artist: albumArtist,
    album_artist_key: albumKey,
    track_number: r.trackNumber ?? null,
    artist_mbids: r.artistMbids === undefined ? null : JSON.stringify(r.artistMbids),
    release_mbid: r.releaseMbid ?? null,
    release_group_mbid: r.releaseGroupMbid ?? null,
    isrc: r.isrc ?? null,
    submission_client: r.submissionClient ?? null,
    music_service: r.musicService ?? null,
    recording_msid: recordingMsidOf(artist_key, track_key),
  };
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
  const fields = scrobbleFieldColumns(row, keys.artist_key, keys.track_key);
  return {
    ok: true,
    write: () => {
      const before = db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri = ?', t.uri);
      enqueueTrack(
        db,
        { artistKey: keys.artist_key, trackKey: keys.track_key, albumKey: keys.album_key },
        Number(o.nowNs / 1_000_000n),
        0,
        row.recordingMbid,
      );
      db.run(
        `INSERT INTO scrobbles(uri, record_uri, listen_id, cid, did, rkey, revision, artist, track, album, listened_at, created_at,
           duration_seconds, recording_mbid, indexed_at, artist_key, track_key, album_key,
           album_artist, album_artist_key, track_number, artist_mbids, release_mbid, release_group_mbid,
           isrc, submission_client, music_service, recording_msid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, rkey = excluded.rkey, revision = excluded.revision,
           record_uri = excluded.record_uri, listen_id = excluded.listen_id,
           artist = excluded.artist, track = excluded.track, album = excluded.album,
           listened_at = excluded.listened_at, created_at = excluded.created_at,
           duration_seconds = excluded.duration_seconds, recording_mbid = excluded.recording_mbid,
           indexed_at = excluded.indexed_at, artist_key = excluded.artist_key,
           track_key = excluded.track_key, album_key = excluded.album_key,
           album_artist = excluded.album_artist, album_artist_key = excluded.album_artist_key,
           track_number = excluded.track_number, artist_mbids = excluded.artist_mbids,
           release_mbid = excluded.release_mbid, release_group_mbid = excluded.release_group_mbid,
           isrc = excluded.isrc, submission_client = excluded.submission_client,
           music_service = excluded.music_service, recording_msid = excluded.recording_msid`,
        t.uri,
        t.recordUri ?? null,
        t.listenId ?? null,
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
        fields.album_artist,
        fields.album_artist_key,
        fields.track_number,
        fields.artist_mbids,
        fields.release_mbid,
        fields.release_group_mbid,
        fields.isrc,
        fields.submission_client,
        fields.music_service,
        fields.recording_msid,
      );
      const identityKey = projectionListenKey(t.did, row.listenedAt, keys.artist_key, keys.track_key);
      const firstAdmission = admitForwardIdentity(db, {
        did: t.did,
        identityKey,
        path: o.forwarding ? 'live' : 'snapshot',
        now: Number(o.nowNs / 1_000_000n),
      });
      const localOperation = db.one<{ origin: string }>(
        'SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1',
        t.did,
        t.collection,
        t.rkey,
      );
      const knownListen = db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND dedupe_key=?', t.did, identityKey);
      if (firstAdmission && o.forwarding && knownListen === null && localOperation?.origin !== 'import') {
        enqueueForwards(db, {
          did: t.did,
          items: [
            {
              kind: 'scrobble',
              listenKey: identityKey,
              payload: {
                listen: {
                  artist: row.artist,
                  track: row.track,
                  album: row.album ?? undefined,
                  listenedAt: row.listenedAt,
                  durationSeconds: row.durationSeconds ?? undefined,
                  recordingMbid: row.recordingMbid ?? undefined,
                },
                origin: 'web',
              },
            },
          ],
          now: Number(o.nowNs / 1_000_000n),
          random: o.forwarding.random,
        });
      }
      return before === null || before.cid !== cid;
    },
  };
}

/** A batch container is replaced as one verified unit; invalid entries are isolated. */
function batchVerdict(db: Db, t: RecordTarget, cid: string, record: unknown, o: ApplyOptions): Verdict {
  // A resource bound, not a write limit: any container the PDS committed (one
  // commit's blocks are at most 2,000,000 bytes) is accepted by size; the
  // entry count is bounded by the validator.
  try {
    if (encode(record).byteLength > MAX_INGEST_CBOR_BYTES) {
      return { ok: false, reason: 'listens: batch record exceeds encoded size limits' };
    }
  } catch {
    return { ok: false, reason: 'listens: batch record cannot be safely encoded' };
  }
  const validated = validateScrobbleBatchRecord(record, o.prefix, o.receiptNs);
  if (!validated.ok) return { ok: false, reason: reasonText(validated.reason) };
  const batch = validated.row;
  for (const dropped of batch.dropped) incrementCounter(db, EXCLUDED_COUNTER, reasonText(dropped.reason));
  if (batch.listens.length === 0) {
    const reason = batch.dropped[0]?.reason;
    return { ok: false, reason: reason ? reasonText(reason) : 'listens: no valid entries' };
  }
  return {
    ok: true,
    write: () => {
      const prior = db.all<{
        uri: string;
        cid: string;
        artist_key: string;
        track_key: string;
        listened_at: string;
        listen_id: string | null;
      }>('SELECT uri,cid,artist_key,track_key,listened_at,listen_id FROM scrobbles WHERE record_uri = ?', t.uri);
      const priorByUri = new Map(prior.map((row) => [row.uri, row]));
      db.run('DELETE FROM scrobbles WHERE record_uri = ?', t.uri);
      let changed = prior.length !== batch.listens.length;
      // Verified membership keeps every valid-TID entry of this version,
      // including one dropped by validation: exclusion is not absence.
      const members: MembershipEntry[] = batch.dropped.flatMap((dropped) =>
        dropped.id !== null && isTid(dropped.id)
          ? [{ id: dropped.id, state: 'excluded' as const, reason: reasonText(dropped.reason) }]
          : [],
      );
      for (const listen of batch.listens) {
        const uri = `${t.uri}#${listen.id}`;
        const singleRecord = { ...listen.row.record, $type: `${o.prefix}.scrobble` };
        const itemTarget: RecordTarget = {
          ...t,
          kind: 'scrobble',
          uri,
          recordUri: t.uri,
          listenId: listen.id,
          present: { cid, record: singleRecord },
        };
        const verdict = scrobbleVerdict(db, itemTarget, cid, singleRecord, o);
        if (!verdict.ok) {
          members.push({ id: listen.id, state: 'excluded', reason: verdict.reason });
          continue;
        }
        members.push({ id: listen.id, state: 'present', reason: null });
        verdict.write();
        const old = priorByUri.get(uri);
        if (
          old === undefined ||
          old.cid !== cid ||
          old.artist_key !== musicKeyColumns(listen.row.artist, listen.row.track, listen.row.album).artist_key ||
          old.track_key !== musicKeyColumns(listen.row.artist, listen.row.track, listen.row.album).track_key ||
          old.listened_at !== listen.row.listenedAt
        )
          changed = true;
      }
      noteBatchEntries(
        db,
        t.did,
        t.uri,
        t.rev,
        cid,
        members,
        prior.flatMap((row) => (row.listen_id !== null && isTid(row.listen_id) ? [row.listen_id] : [])),
      );
      return changed;
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

function loveVerdict(db: Db, t: RecordTarget, cid: string, record: unknown, o: ApplyOptions): Verdict {
  const v = validateLoveRecord(record, o.prefix, o.receiptNs);
  if (!v.ok) return { ok: false, reason: reasonText(v.reason) };
  const row = v.row;
  let keys: ReturnType<typeof musicKeyColumns>;
  try {
    keys = musicKeyColumns(row.artist, row.track, null);
  } catch (error) {
    // Unreachable after validation (same display-string rule); kept fail-closed.
    if (error instanceof MusicKeyError) return { ok: false, reason: `${error.field}: ${error.message}` };
    throw error;
  }
  return {
    ok: true,
    write: () => {
      db.run(
        `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid,
           created_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, rkey = excluded.rkey, artist = excluded.artist,
           track = excluded.track, album = excluded.album, artist_key = excluded.artist_key,
           track_key = excluded.track_key, recording_mbid = excluded.recording_mbid,
           created_at = excluded.created_at, indexed_at = excluded.indexed_at`,
        t.uri,
        t.did,
        t.rkey,
        cid,
        row.artist,
        row.track,
        row.album,
        keys.artist_key,
        keys.track_key,
        row.recordingMbid,
        row.createdAt,
        toStorage(o.nowNs),
      );
      enqueueTrack(
        db,
        { artistKey: keys.artist_key, trackKey: keys.track_key },
        Number(o.nowNs / 1_000_000n),
        0,
        row.recordingMbid,
      );
      return false;
    },
  };
}

type VerdictOf = (db: Db, t: RecordTarget, cid: string, record: unknown, o: ApplyOptions) => Verdict;

const VERDICTS: Readonly<Record<ProjectedKind, VerdictOf>> = {
  scrobble: scrobbleVerdict,
  scrobbleBatch: batchVerdict,
  follow: followVerdict,
  love: loveVerdict,
};

/**
 * Whether re-proving unchanged scrobble bytes at a newer revision can still
 * change what is visible: a succeeded removal of the same record decides by
 * the projection's revision (read/visibility `removedBy`: an `after` cutoff
 * releases a target proven at or above it, an exact one above it), so the
 * same CID proven at a later revision may cross that cutoff. Conservative:
 * any revision advance of a record with such a receipt invalidates
 * statistics, in the proof's own transaction; the cutoffs never move.
 */
function revisionMayReveal(db: Db, t: RecordTarget, priorRevision: string | null): boolean {
  if (priorRevision === t.rev) return false;
  return (
    db.one(
      `SELECT 1 AS x FROM operations WHERE did = ? AND collection = ? AND rkey = ?
         AND kind = 'scrobble.delete' AND state = 'succeeded' LIMIT 1`,
      t.did,
      t.collection,
      t.rkey,
    ) !== null
  );
}

/**
 * Write one verified scrobble/follow/love version. No guards: the caller has
 * checked the owner, the per-DID floor (live proofs) and the per-URI guard.
 * Bumps `stats_version` when a scrobble row changed, or when unchanged bytes
 * move to a revision a succeeded removal's cutoff may decide differently
 * (revisionMayReveal); does not touch max_rev.
 */
export function applyRecordTarget(db: Db, t: RecordTarget, o: ApplyOptions): TargetResult {
  const verifiedAt = toStorage(o.nowNs);
  const priorRevision =
    db.one<{ revision: string }>('SELECT revision FROM record_state WHERE uri = ?', t.uri)?.revision ?? null;
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
    if (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') noteRecordAbsent(db, t.did, t.uri, t.rev);
    out = { outcome: 'absent', statsChanged: (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') && deleted };
  } else {
    const { cid, record } = t.present;
    const verdict = VERDICTS[t.kind](db, t, cid, record, o);
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
      if (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') {
        noteRecordPresent(
          db,
          { did: t.did, uri: t.uri, rev: t.rev, cid, state: 'present', reason: null },
          t.kind === 'scrobbleBatch',
        );
      }
      out = {
        outcome: 'applied',
        statsChanged:
          (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') && (changed || revisionMayReveal(db, t, priorRevision)),
      };
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
      // An excluded container keeps its entry rows: an invalid version proves
      // no entry absent.
      if (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') {
        noteRecordPresent(
          db,
          { did: t.did, uri: t.uri, rev: t.rev, cid, state: 'excluded', reason: verdict.reason },
          t.kind === 'scrobbleBatch',
        );
      }
      out = {
        outcome: 'excluded',
        reason: verdict.reason,
        statsChanged: (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') && deleted,
      };
    }
  }
  if (out.statsChanged) bumpStatsVersion(db, t.did);
  return out;
}

/**
 * Re-proves the stored bytes of a scrobble or batch container (a verified
 * snapshot entry at `rev` whose CID equals the one stored, with no body) with
 * everything a live proof of the same bytes at `rev` would write, in the
 * caller's transaction: record_state, the revision of every projection row of
 * the record (read/visibility decides succeeded removals by it), verified
 * membership, and statistics when a succeeded removal's cutoff may now decide
 * differently (revisionMayReveal). No guards: the caller checked the per-URI
 * guard (rev above the stored revision).
 *
 * Membership is reaffirmed only from what the index verified for these exact
 * bytes, never invented: a single record updates the `*` row an earlier
 * absence created; a container's entries are re-noted at `rev` from its `*`
 * row's last verified version when that row holds this CID and state
 * (entries listed then keep their state, unlisted ones are absent at `rev`
 * exactly as noteBatchEntries does for a live proof). Without such a row
 * (a projection older than membership) the membership is left untouched.
 * An excluded version keeps its exclusion (no projection rows, no counter:
 * it was counted when first proven).
 */
export function reaffirmRecordTarget(
  db: Db,
  t: { did: string; kind: 'scrobble' | 'scrobbleBatch'; collection: string; rkey: string; uri: string; rev: string },
  cid: string,
  o: ApplyOptions,
): void {
  const prior = readRecordState(db, t.uri);
  const state: 'present' | 'excluded' = prior?.state === 'excluded' ? 'excluded' : 'present';
  const reason = state === 'excluded' ? (prior?.reason ?? null) : null;
  const verifiedAt = toStorage(o.nowNs);
  if (prior === null) {
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
  } else {
    db.run(
      'UPDATE record_state SET revision = ?, verified_at = ? WHERE uri = ? AND revision < ?',
      t.rev,
      verifiedAt,
      t.uri,
      t.rev,
    );
  }
  const batch = t.kind === 'scrobbleBatch';
  if (state === 'present') {
    db.run(
      batch
        ? 'UPDATE scrobbles SET revision = ? WHERE record_uri = ? AND revision < ?'
        : 'UPDATE scrobbles SET revision = ? WHERE uri = ? AND revision < ?',
      t.rev,
      t.uri,
      t.rev,
    );
  }
  const verified = { did: t.did, uri: t.uri, rev: t.rev, cid, state, reason };
  if (!batch) {
    noteRecordPresent(db, verified, false);
  } else {
    const container = db.one<{ state: string; revision: string; cid: string | null }>(
      `SELECT state, revision, cid FROM verified_membership WHERE record_uri = ? AND listen_id = '*'`,
      t.uri,
    );
    if (
      container !== null &&
      container.cid === cid &&
      container.state === state &&
      container.revision < t.rev &&
      (prior === null || container.revision <= prior.revision)
    ) {
      if (state === 'present') {
        const entries = db.all<MembershipEntry>(
          `SELECT listen_id AS id, state, reason FROM verified_membership
           WHERE record_uri = ? AND listen_id != '*' AND state IN ('present', 'excluded') AND revision = ?
           ORDER BY listen_id`,
          t.uri,
          container.revision,
        );
        const projected = db
          .all<{ listen_id: string | null }>('SELECT listen_id FROM scrobbles WHERE record_uri = ?', t.uri)
          .flatMap((row) => (row.listen_id !== null && isTid(row.listen_id) ? [row.listen_id] : []));
        noteBatchEntries(db, t.did, t.uri, t.rev, cid, entries, projected);
      }
      noteRecordPresent(db, verified, true);
    }
  }
  const target: RecordTarget = { ...t, present: { cid, record: null } };
  if (state === 'present' && revisionMayReveal(db, target, prior?.revision ?? null)) bumpStatsVersion(db, t.did);
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
