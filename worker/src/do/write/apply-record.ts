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
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { reasonText, type ScrobbleRow, validateScrobbleRecord } from '@atmusic/core/scrobble';
import { MAX_INGEST_CBOR_BYTES, validateScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import { isTid } from '@atmusic/core/syntax';
import { toStorage } from '@atmusic/core/timestamp';
import { executeListenRemovals } from '../../forward/live-removal-effects';
import {
  admitForwardIdentity,
  admitProjectedIdentity,
  type ForwardProvenance,
  projectionListenKey,
  retainedForwardProvenance,
  retainedRecordProvenance,
} from '../../forward/projection';
import { enqueueTrack } from '../../musicbrainz/store';
import { enqueueForwards } from '../../outbox/forward-enqueue';
import { pullLoveAdmissionForUri, retirePullLoveAdmissionUri } from '../../sync/pull-love-admissions';
import { archiveMatchingLiveListenTombstones, hasListenRemovalTombstones, tombstoneLove } from '../../sync/tombstones';
import type { Db } from '../db';
import {
  absenceAuthority,
  additionAuthority,
  countLiveAdmission,
  type LiveAuthority,
  recordLiveCandidate,
  replacementAuthority,
} from '../ingest/live-evidence';
import { recordPendingRemoval } from '../ingest/live-pending-removals';
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
  /** Authenticated durable Jetstream evidence; absent for notify/API/snapshot callers. */
  live?: LiveAuthority & { random: Random };
  /** Snapshot walks after initial account admission may retain late candidates. */
  liveCandidates?: boolean;
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
  /** Revision in record_state before this observation is applied. */
  priorRevision?: string | null;
}

export interface TargetResult {
  outcome: 'applied' | 'excluded' | 'absent';
  reason?: string;
  /** A scrobble row was inserted, changed or deleted. */
  statsChanged: boolean;
}

type ProjectedListen = {
  uri: string;
  record_uri: string | null;
  listen_id: string | null;
  cid: string;
  listened_at: string;
  artist_key: string;
  track_key: string;
  artist: string;
  track: string;
  recording_mbid: string | null;
};

/** Indexed lookup for the single scrobble or batch members at one record URI. */
export function projectedListensOfRecord(db: Db, did: string, uri: string): ProjectedListen[] {
  return db.all<ProjectedListen>(
    `SELECT uri,record_uri,listen_id,cid,listened_at,artist_key,track_key,artist,track,recording_mbid
       FROM scrobbles WHERE uri=? AND did=?
     UNION ALL
     SELECT uri,record_uri,listen_id,cid,listened_at,artist_key,track_key,artist,track,recording_mbid
       FROM scrobbles WHERE record_uri=? AND did=?`,
    uri,
    did,
    uri,
    did,
  );
}

/** Preserve the legacy admission before an absence or exclusion removes a projection. */
function seedRemovedListenAdmissions(
  db: Db,
  target: RecordTarget,
  listens: readonly ProjectedListen[],
  now: number,
): void {
  if (listens.length === 0) return;
  const provenance: ForwardProvenance | null = retainedRecordProvenance(db, target.did, target.collection, target.rkey);
  for (const listen of listens) {
    admitProjectedIdentity(db, {
      did: target.did,
      identityKey: projectionListenKey(target.did, listen.listened_at, listen.artist_key, listen.track_key),
      provenance,
      legacyPresent: true,
      path: 'snapshot',
      now,
    });
  }
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
      const before = db.one<{
        uri: string;
        cid: string;
        listened_at: string;
        artist_key: string;
        track_key: string;
        artist: string;
        track: string;
        recording_mbid: string | null;
      }>(
        'SELECT uri,cid,listened_at,artist_key,track_key,artist,track,recording_mbid FROM scrobbles WHERE uri = ?',
        t.uri,
      );
      enqueueTrack(
        db,
        { artistKey: keys.artist_key, trackKey: keys.track_key, albumKey: keys.album_key },
        Number(o.nowNs / 1_000_000n),
        0,
        row.recordingMbid,
      );
      const identityKey = projectionListenKey(t.did, row.listenedAt, keys.artist_key, keys.track_key);
      const priorIdentityKey = before
        ? projectionListenKey(t.did, before.listened_at, before.artist_key, before.track_key)
        : undefined;
      // Admission belongs to the canonical listen, including copies at other
      // record/container URIs and subsecond variants of the same listen key.
      const second = BigInt(Math.floor(Date.parse(row.listenedAt) / 1000)) * 1_000_000_000n;
      const canonical = db.one<{ uri: string; record_uri: string | null; rkey: string }>(
        `SELECT uri,record_uri,rkey FROM scrobbles
         WHERE did=? AND artist_key=? AND track_key=? AND listened_at>=? AND listened_at<? LIMIT 1`,
        t.did,
        keys.artist_key,
        keys.track_key,
        toStorage(second),
        toStorage(second + 1_000_000_000n),
      );
      const legacyPresent =
        canonical !== null ||
        before !== null ||
        db.one('SELECT 1 AS hit FROM record_state WHERE uri=? LIMIT 1', t.uri) !== null;
      const now = Number(o.nowNs / 1_000_000n);
      const replacementRev = replacementAuthority(o.live, t.priorRevision ?? null, t.rev, cid);
      if (replacementRev !== null) countLiveAdmission(db, 'replacement_authorized');
      if (
        replacementRev === null &&
        t.recordUri === undefined &&
        before &&
        priorIdentityKey !== undefined &&
        priorIdentityKey !== identityKey
      )
        recordPendingRemoval(db, {
          did: t.did,
          uri: t.uri,
          kind: 'scrobble',
          row: { ...before, record_uri: null, listen_id: null },
          identityKey: priorIdentityKey,
          windowLo: t.priorRevision ?? '',
          windowHi: t.rev,
          replacedByCid: cid,
          nowMs: now,
        });
      if (
        replacementRev !== null &&
        t.recordUri === undefined &&
        before &&
        priorIdentityKey !== undefined &&
        priorIdentityKey !== identityKey
      ) {
        executeListenRemovals(db, {
          did: t.did,
          rows: [before],
          authRev: replacementRev,
          now,
          identity: () => priorIdentityKey,
          tombstoneIdentity: () => `single-replaced:${t.uri}:${cid}`,
        });
      }
      const canonicalCollection = (canonical?.record_uri ?? canonical?.uri)?.split('/')[3];
      const provenance =
        canonical && canonicalCollection
          ? retainedRecordProvenance(db, t.did, canonicalCollection, canonical.rkey)
          : legacyPresent
            ? retainedRecordProvenance(db, t.did, t.collection, t.rkey)
            : null;
      const anyUriCandidate = db.one(
        'SELECT 1 AS hit FROM live_acceptance_candidates WHERE uri=? LIMIT 1',
        t.recordUri ?? t.uri,
      );
      const replacementCandidate =
        canonical === null &&
        before !== null &&
        priorIdentityKey !== undefined &&
        priorIdentityKey !== identityKey &&
        anyUriCandidate === null;
      const firstAdmission = admitProjectedIdentity(db, {
        did: t.did,
        identityKey,
        ...(priorIdentityKey === undefined ? {} : { priorIdentityKey }),
        provenance,
        legacyPresent,
        path: additionAuthority(o.live, t.rev, cid) ? 'live' : 'snapshot',
        now,
      });
      if (replacementCandidate && !additionAuthority(o.live, t.rev, cid))
        db.run("UPDATE forward_admissions SET path='snapshot' WHERE did=? AND identity_key=?", t.did, identityKey);
      if (additionAuthority(o.live, t.rev, cid)) countLiveAdmission(db, 'addition_matched');
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
      const localOperation = db.one<{ origin: string }>(
        'SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1',
        t.did,
        t.collection,
        t.rkey,
      );
      const knownListen = db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND dedupe_key=?', t.did, identityKey);
      const ownedCandidate = db.one(
        'SELECT 1 AS hit FROM live_acceptance_candidates WHERE uri=? AND identity_key=? AND expires_at_ms>? ',
        t.recordUri ?? t.uri,
        identityKey,
        now,
      );
      if (
        firstAdmission &&
        !legacyPresent &&
        additionAuthority(o.live, t.rev, cid) &&
        knownListen === null &&
        localOperation?.origin !== 'import'
      ) {
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
          random: o.live!.random,
        });
      }
      if (
        (ownedCandidate !== null || firstAdmission) &&
        (!legacyPresent || replacementCandidate) &&
        knownListen === null &&
        localOperation?.origin !== 'import' &&
        (ownedCandidate !== null || !additionAuthority(o.live, t.rev, cid)) &&
        o.liveCandidates
      ) {
        recordLiveCandidate(db, {
          uri: t.recordUri ?? t.uri,
          identityKey,
          kind: 'scrobble',
          memberUri: t.uri,
          cid,
          nowMs: now,
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
        artist: string;
        track: string;
        record_uri: string | null;
        recording_mbid: string | null;
      }>(
        'SELECT uri,cid,artist_key,track_key,listened_at,listen_id,artist,track,record_uri,recording_mbid FROM scrobbles WHERE record_uri = ?',
        t.uri,
      );
      const priorByUri = new Map(prior.map((row) => [row.uri, row]));
      const now = Number(o.nowNs / 1_000_000n);
      const replacementRev = replacementAuthority(o.live, t.priorRevision ?? null, t.rev, cid);
      if (replacementRev !== null) countLiveAdmission(db, 'replacement_authorized');
      const retainedIdentities = new Set(
        batch.listens.map((listen) => {
          const keys = musicKeyColumns(listen.row.artist, listen.row.track, listen.row.album);
          return projectionListenKey(t.did, listen.row.listenedAt, keys.artist_key, keys.track_key);
        }),
      );
      // An excluded member is not verified absence of its previous listen.
      const excludedIds = new Set(batch.dropped.map((entry) => entry.id));
      const removed = prior.filter((old) => {
        const identityKey = projectionListenKey(t.did, old.listened_at, old.artist_key, old.track_key);
        return !retainedIdentities.has(identityKey) && !(old.listen_id !== null && excludedIds.has(old.listen_id));
      });
      if (replacementRev === null) {
        for (const old of removed)
          recordPendingRemoval(db, {
            did: t.did,
            uri: t.uri,
            kind: 'scrobble',
            row: old,
            identityKey: projectionListenKey(t.did, old.listened_at, old.artist_key, old.track_key),
            windowLo: t.priorRevision ?? '',
            windowHi: t.rev,
            replacedByCid: cid,
            nowMs: now,
          });
      }
      if (replacementRev !== null) {
        executeListenRemovals(db, {
          did: t.did,
          rows: removed,
          authRev: replacementRev,
          now,
          identity: (old) => projectionListenKey(t.did, old.listened_at, old.artist_key, old.track_key),
          tombstoneIdentity: (old) => `batch-replaced:${old.uri}:${cid}`,
        });
      }
      const provenance = retainedRecordProvenance(db, t.did, t.collection, t.rkey);
      for (const old of prior) {
        admitProjectedIdentity(db, {
          did: t.did,
          identityKey: projectionListenKey(t.did, old.listened_at, old.artist_key, old.track_key),
          provenance,
          legacyPresent: true,
          path: 'snapshot',
          now,
        });
      }
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
        const itemKeys = musicKeyColumns(listen.row.artist, listen.row.track, listen.row.album);
        const priorItem = priorByUri.get(uri);
        const priorIdentityKey = priorItem
          ? projectionListenKey(t.did, priorItem.listened_at, priorItem.artist_key, priorItem.track_key)
          : undefined;
        const memberEvidence = db.one(
          'SELECT 1 AS hit FROM verified_membership WHERE record_uri=? AND listen_id=? LIMIT 1',
          t.uri,
          listen.id,
        );
        if (priorItem !== undefined || memberEvidence !== null)
          admitProjectedIdentity(db, {
            did: t.did,
            identityKey: projectionListenKey(t.did, listen.row.listenedAt, itemKeys.artist_key, itemKeys.track_key),
            ...(priorIdentityKey === undefined ? {} : { priorIdentityKey }),
            provenance,
            legacyPresent: true,
            path: additionAuthority(o.live, t.rev, cid) ? 'live' : 'snapshot',
            now,
          });
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
      const priorLove = db.one<{ cid: string }>('SELECT cid FROM loves WHERE uri=?', t.uri);
      const replacementAfterDelete =
        db.run(
          `UPDATE love_delete_bridges SET state='obsolete'
         WHERE did=? AND uri=? AND state IN ('pending','succeeded')
           AND delete_rev IS NOT NULL AND delete_rev < ?`,
          t.did,
          t.uri,
          t.rev,
        ).rowsWritten > 0;
      if (replacementAfterDelete) {
        // A verified post-delete revision starts a new incarnation even when
        // the recreated record has byte-identical content and the same CID.
        db.run(
          "UPDATE love_incarnations SET state='absent',updated_at_ms=? WHERE uri=?",
          Number(o.nowNs / 1_000_000n),
          t.uri,
        );
        retirePullLoveAdmissionUri(db, { did: t.did, uri: t.uri, nowMs: Number(o.nowNs / 1_000_000n) });
      }
      const previousRecordState = db.one<{ state: string; cid: string | null }>(
        'SELECT state,cid FROM record_state WHERE uri=?',
        t.uri,
      );
      db.run(
        `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid,
           created_at, indexed_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, rkey = excluded.rkey, artist = excluded.artist,
           track = excluded.track, album = excluded.album, artist_key = excluded.artist_key,
           track_key = excluded.track_key, recording_mbid = excluded.recording_mbid,
           created_at = excluded.created_at, indexed_at = excluded.indexed_at, revision = excluded.revision`,
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
        t.rev,
      );
      enqueueTrack(
        db,
        { artistKey: keys.artist_key, trackKey: keys.track_key },
        Number(o.nowNs / 1_000_000n),
        0,
        row.recordingMbid,
      );
      const current = db.one<{ incarnation_key: string; state: string; path: string; source_service: string | null }>(
        'SELECT incarnation_key,state,path,source_service FROM love_incarnations WHERE uri=?',
        t.uri,
      );
      const identityKey = current?.state === 'present' ? current.incarnation_key : `love:${t.uri}:${t.rev}`;
      const acceptanceKey = `love-uri:${t.did}:${t.collection}:${t.rkey}`;
      const pullAdmission = pullLoveAdmissionForUri(db, { did: t.did, uri: t.uri });
      const apiBridge = replacementAfterDelete
        ? null
        : (retainedForwardProvenance(db, t.did, acceptanceKey) ??
          (priorLove !== null ? retainedRecordProvenance(db, t.did, t.collection, t.rkey) : null) ??
          (pullAdmission === null ? null : { path: 'import' as const, sourceService: pullAdmission.source_service }));
      const legacyPresent =
        !replacementAfterDelete &&
        (current?.state === 'present' || priorLove !== null || previousRecordState?.state === 'present');
      const isLiveAdmission = additionAuthority(o.live, t.rev, cid);
      if (isLiveAdmission) countLiveAdmission(db, 'addition_matched');
      const provenancePath = apiBridge?.path ?? (legacyPresent ? 'snapshot' : isLiveAdmission ? 'live' : 'snapshot');
      const path = current?.state === 'present' ? current.path : provenancePath;
      const sourceService = current?.state === 'present' ? current.source_service : (apiBridge?.sourceService ?? null);
      const admittedIdentityKey =
        current?.state === 'present'
          ? current.incarnation_key
          : legacyPresent
            ? `love:${t.uri}:legacy:${priorLove?.cid ?? previousRecordState?.cid ?? cid}`
            : identityKey;
      const local = db.one<{ origin: string }>(
        'SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1',
        t.did,
        t.collection,
        t.rkey,
      );
      if (current?.state !== 'present') {
        const firstAdmission = admitForwardIdentity(db, {
          did: t.did,
          identityKey: admittedIdentityKey,
          path: path as 'api' | 'import' | 'live' | 'snapshot',
          sourceService: sourceService ?? undefined,
          now: Number(o.nowNs / 1_000_000n),
        });
        db.run(
          `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms) VALUES (?,?,?,?,?,?)
           ON CONFLICT(uri) DO UPDATE SET incarnation_key=excluded.incarnation_key,state='present',path=excluded.path,source_service=excluded.source_service,updated_at_ms=excluded.updated_at_ms`,
          t.uri,
          admittedIdentityKey,
          'present',
          path,
          sourceService,
          Number(o.nowNs / 1_000_000n),
        );
        if (apiBridge) db.run('DELETE FROM forward_admissions WHERE did=? AND identity_key=?', t.did, acceptanceKey);
        if (o.live && firstAdmission && !legacyPresent && path === 'live') {
          if (replacementAfterDelete || local?.origin !== 'import')
            enqueueForwards(db, {
              did: t.did,
              items: [
                {
                  kind: 'love',
                  operationId: admittedIdentityKey,
                  payload: {
                    artist: row.artist,
                    track: row.track,
                    album: row.album ?? undefined,
                    recordingMbid: row.recordingMbid ?? undefined,
                    origin: 'web',
                  },
                },
              ],
              now: Number(o.nowNs / 1_000_000n),
              random: o.live.random,
            });
        }
        if (
          firstAdmission &&
          !legacyPresent &&
          !apiBridge &&
          path === 'snapshot' &&
          !isLiveAdmission &&
          (replacementAfterDelete || local?.origin !== 'import') &&
          o.liveCandidates
        ) {
          recordLiveCandidate(db, {
            uri: t.uri,
            identityKey: admittedIdentityKey,
            kind: 'love',
            memberUri: t.uri,
            cid,
            nowMs: Number(o.nowNs / 1_000_000n),
          });
        }
      } else
        db.run(
          "UPDATE love_incarnations SET state='present',updated_at_ms=? WHERE uri=?",
          Number(o.nowNs / 1_000_000n),
          t.uri,
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
  t = { ...t, priorRevision };
  let out: TargetResult;
  if (t.present === null) {
    const now = Number(o.nowNs / 1_000_000n);
    const removedListens =
      t.kind === 'scrobble' || t.kind === 'scrobbleBatch' ? projectedListensOfRecord(db, t.did, t.uri) : [];
    if (removedListens.length > 0) seedRemovedListenAdmissions(db, t, removedListens, now);
    const priorLove =
      t.kind === 'love'
        ? db.one<{ cid: string; artist: string; track: string; album: string | null; recording_mbid: string | null }>(
            'SELECT cid,artist,track,album,recording_mbid FROM loves WHERE uri=?',
            t.uri,
          )
        : null;
    db.run('DELETE FROM live_acceptance_candidates WHERE uri=?', t.uri);
    let loveIncarnation =
      t.kind === 'love'
        ? db.one<{ incarnation_key: string; path: string; state: string; source_service: string | null }>(
            'SELECT incarnation_key,path,state,source_service FROM love_incarnations WHERE uri=?',
            t.uri,
          )
        : null;
    if (t.kind === 'love' && priorLove !== null && loveIncarnation === null) {
      const acceptance =
        retainedForwardProvenance(db, t.did, `love-uri:${t.did}:${t.collection}:${t.rkey}`) ??
        retainedRecordProvenance(db, t.did, t.collection, t.rkey);
      const path = acceptance?.path ?? 'snapshot';
      const sourceService = acceptance?.sourceService ?? null;
      const incarnationKey = `love:${t.uri}:legacy:${priorLove.cid}`;
      admitForwardIdentity(db, {
        did: t.did,
        identityKey: incarnationKey,
        path,
        sourceService: sourceService ?? undefined,
        now: Number(o.nowNs / 1_000_000n),
      });
      db.run(
        `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
         VALUES (?,?,'present',?,?,?) ON CONFLICT(uri) DO NOTHING`,
        t.uri,
        incarnationKey,
        path,
        sourceService,
        Number(o.nowNs / 1_000_000n),
      );
      loveIncarnation = { incarnation_key: incarnationKey, state: 'present', path, source_service: sourceService };
    }
    const importLoveBridges =
      t.kind === 'love' && loveIncarnation?.state === 'present'
        ? db.all<{ source_service: string | null }>(
            `SELECT source_service FROM love_import_bridges
             WHERE did=? AND uri=? AND incarnation_key=? AND state='bound' ORDER BY created_at_ms,operation_id`,
            t.did,
            t.uri,
            loveIncarnation.incarnation_key,
          )
        : [];
    const authRev = absenceAuthority(o.live, priorRevision, t.rev);
    if (authRev !== null) countLiveAdmission(db, 'removal_authorized');
    else if (removedListens.length > 0 || (t.kind === 'love' && priorLove !== null))
      countLiveAdmission(db, 'removal_deferred');
    if (authRev === null && (t.kind === 'scrobble' || t.kind === 'scrobbleBatch'))
      for (const listen of removedListens)
        recordPendingRemoval(db, {
          did: t.did,
          uri: t.uri,
          kind: 'scrobble',
          row: listen,
          identityKey: projectionListenKey(t.did, listen.listened_at, listen.artist_key, listen.track_key),
          windowLo: priorRevision ?? '',
          windowHi: t.rev,
          replacedByCid: null,
          nowMs: now,
        });
    if (authRev !== null && (t.kind === 'scrobble' || t.kind === 'scrobbleBatch'))
      executeListenRemovals(db, {
        did: t.did,
        rows: removedListens,
        authRev,
        now,
        identity: (listen) => projectionListenKey(t.did, listen.listened_at, listen.artist_key, listen.track_key),
        tombstoneIdentity: (listen) => `live:${listen.uri}:${listen.cid}`,
      });
    const newerLoveIntent =
      authRev !== null && t.kind === 'love' && priorLove
        ? db.one(
            `SELECT 1 FROM operations WHERE did=? AND kind='love.put' AND state IN ('queued','blocked','running')
             AND json_extract(record_json,'$.artist')=? AND json_extract(record_json,'$.track')=? LIMIT 1`,
            t.did,
            priorLove.artist,
            priorLove.track,
          ) !== null
        : false;
    const [priorArtistKey, priorTrackKey] = priorLove ? trackKey(priorLove.artist, priorLove.track) : ['', ''];
    const locallyReloved =
      priorLove !== null &&
      db.one(
        `SELECT 1 FROM linked_love_intents WHERE did=? AND intent='love'
         AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?)) LIMIT 1`,
        t.did,
        `${priorArtistKey}\u0000${priorTrackKey}`,
        priorLove.recording_mbid,
        priorLove.recording_mbid,
      ) !== null;
    if (authRev !== null && t.kind === 'love' && priorLove && !newerLoveIntent && !locallyReloved) {
      const [artistKeyValue, trackKeyValue] = trackKey(priorLove.artist, priorLove.track);
      const key = `${artistKeyValue}\u0000${trackKeyValue}`;
      tombstoneLove(db, {
        did: t.did,
        identity: `live:${t.uri}:${priorLove.cid}`,
        loveKey: key,
        recordingMbid: priorLove.recording_mbid,
        nowMs: Number(o.nowNs / 1_000_000n),
      });
    }
    const deleted = deleteProjection(db, t.kind, t.uri);
    if (t.kind === 'love')
      retirePullLoveAdmissionUri(db, { did: t.did, uri: t.uri, nowMs: Number(o.nowNs / 1_000_000n) });
    if (t.kind === 'love' && priorLove && loveIncarnation?.state === 'present') {
      const identityKey = `love-delete:${loveIncarnation.incarnation_key}`;
      const apiBridge = db.one<{ expected_cid: string }>(
        `SELECT expected_cid FROM love_delete_bridges WHERE did=? AND uri=? AND incarnation_key=? AND state IN ('pending','succeeded')
         ORDER BY created_at_ms DESC LIMIT 1`,
        t.did,
        t.uri,
        loveIncarnation.incarnation_key,
      );
      const priorCid = db.one<{ cid: string }>('SELECT cid FROM record_state WHERE uri=?', t.uri)?.cid;
      const apiEcho = apiBridge !== null && apiBridge.expected_cid === priorCid;
      if (apiBridge && !apiEcho)
        db.run(
          "UPDATE love_delete_bridges SET state='obsolete' WHERE did=? AND uri=? AND incarnation_key=? AND state IN ('pending','succeeded')",
          t.did,
          t.uri,
          loveIncarnation.incarnation_key,
        );
      const path = authRev !== null ? 'live' : 'snapshot';
      const firstAdmission = admitForwardIdentity(db, {
        did: t.did,
        identityKey,
        path,
        sourceService: loveIncarnation.source_service ?? undefined,
        now: Number(o.nowNs / 1_000_000n),
      });
      if (apiEcho)
        db.run(
          "UPDATE love_delete_bridges SET state='consumed' WHERE did=? AND uri=? AND incarnation_key=? AND state IN ('pending','succeeded')",
          t.did,
          t.uri,
          loveIncarnation.incarnation_key,
        );
      db.run(
        `UPDATE love_import_bridges SET state='consumed'
         WHERE did=? AND uri=? AND incarnation_key=? AND state='bound'`,
        t.did,
        t.uri,
        loveIncarnation.incarnation_key,
      );
      db.run(
        "UPDATE love_incarnations SET state='absent',updated_at_ms=? WHERE uri=?",
        Number(o.nowNs / 1_000_000n),
        t.uri,
      );
      if (firstAdmission && !apiEcho) {
        const local = db.one<{ origin: string }>(
          'SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? ORDER BY created_at_ms DESC LIMIT 1',
          t.did,
          t.collection,
          t.rkey,
        );
        const importSources = new Set<'lastfm' | 'listenbrainz'>();
        if (loveIncarnation.source_service === 'lastfm' || loveIncarnation.source_service === 'listenbrainz')
          importSources.add(loveIncarnation.source_service);
        let unknownImportSource = loveIncarnation.path === 'import' && loveIncarnation.source_service === null;
        for (const bridge of importLoveBridges) {
          if (bridge.source_service === 'lastfm' || bridge.source_service === 'listenbrainz')
            importSources.add(bridge.source_service);
          else unknownImportSource = true;
        }
        const importMayForward = importSources.size > 0;
        const eligiblePath = loveIncarnation.path === 'live' || loveIncarnation.path === 'api' || importMayForward;
        if (!unknownImportSource && eligiblePath && (local?.origin !== 'import' || importMayForward)) {
          if (authRev !== null)
            enqueueForwards(db, {
              did: t.did,
              items: [
                {
                  kind: 'unlove',
                  operationId: `${identityKey}:rev:${authRev}`,
                  payload: {
                    artist: priorLove.artist,
                    track: priorLove.track,
                    recordingMbid: priorLove.recording_mbid ?? undefined,
                    origin: 'web',
                  },
                },
              ],
              ...(importSources.size > 0 ? { excludeSourceServices: [...importSources] } : {}),
              now,
              random: o.live!.random,
            });
          else
            recordPendingRemoval(db, {
              did: t.did,
              uri: t.uri,
              kind: 'love',
              row: {
                uri: t.uri,
                record_uri: null,
                listen_id: null,
                cid: priorLove.cid,
                listened_at: '',
                artist_key: priorArtistKey,
                track_key: priorTrackKey,
                artist: priorLove.artist,
                track: priorLove.track,
                recording_mbid: priorLove.recording_mbid,
              },
              identityKey: loveIncarnation.incarnation_key,
              windowLo: priorRevision ?? '',
              windowHi: t.rev,
              replacedByCid: null,
              loveSourceService: loveIncarnation.source_service,
              loveImportSources: [...importSources],
              nowMs: now,
            });
        }
      }
    }
    if (t.kind === 'love' && !priorLove) {
      // API deletes can target a remote love the index never projected. A
      // successful, matching absence still consumes the pre-send bridge.
      db.run(
        "UPDATE love_delete_bridges SET state='consumed' WHERE did=? AND uri=? AND state IN ('pending','succeeded')",
        t.did,
        t.uri,
      );
      db.run("UPDATE love_import_bridges SET state='consumed' WHERE did=? AND uri=? AND state='bound'", t.did, t.uri);
      db.run(
        "UPDATE love_incarnations SET state='absent',updated_at_ms=? WHERE uri=?",
        Number(o.nowNs / 1_000_000n),
        t.uri,
      );
    }
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
      if (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') {
        seedRemovedListenAdmissions(db, t, projectedListensOfRecord(db, t.did, t.uri), Number(o.nowNs / 1_000_000n));
      }
      db.run('DELETE FROM live_acceptance_candidates WHERE uri=?', t.uri);
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
  if (t.present !== null && out.outcome === 'applied') refreshOwnedCandidates(db, t, Number(o.nowNs / 1_000_000n));
  if (t.present !== null && out.outcome === 'applied' && (t.kind === 'scrobble' || t.kind === 'scrobbleBatch')) {
    archiveAcceptedListenTombstones(db, t.did, t.uri, t.rev);
  }
  return out;
}

/** Keep an existing candidate aligned with an accepted projection revision.
 * The exact canonical identity / love incarnation match prevents transferring
 * ownership across replacements; the expiry predicate preserves the original
 * admission window and never creates a candidate from projection history. */
function refreshOwnedCandidates(db: Db, t: RecordTarget, nowMs: number): void {
  if (t.kind === 'scrobble' || t.kind === 'scrobbleBatch') {
    const listens = projectedListensOfRecord(db, t.did, t.uri);
    for (const listen of listens) {
      const identityKey = projectionListenKey(t.did, listen.listened_at, listen.artist_key, listen.track_key);
      const ownerUri = listen.record_uri ?? listen.uri;
      db.run(
        `UPDATE live_acceptance_candidates SET cid=?,member_uri=?
         WHERE uri=? AND identity_key=? AND kind='scrobble' AND expires_at_ms>?`,
        listen.cid,
        listen.uri,
        ownerUri,
        identityKey,
        nowMs,
      );
    }
  } else if (t.kind === 'love') {
    const incarnation = db.one<{ incarnation_key: string; state: string }>(
      'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
      t.uri,
    );
    const love = db.one<{ cid: string }>('SELECT cid FROM loves WHERE uri=? AND did=?', t.uri, t.did);
    if (incarnation?.state !== 'present' || love === null) return;
    db.run(
      `UPDATE live_acceptance_candidates SET cid=?,member_uri=?
       WHERE uri=? AND identity_key=? AND kind='love' AND expires_at_ms>?`,
      love.cid,
      t.uri,
      t.uri,
      incarnation.incarnation_key,
      nowMs,
    );
  }
}

function archiveAcceptedListenTombstones(db: Db, did: string, uri: string, revision: string): void {
  if (!hasListenRemovalTombstones(db, did)) return;
  const listens = projectedListensOfRecord(db, did, uri);
  for (const listen of listens) {
    archiveMatchingLiveListenTombstones(db, {
      did,
      uri: listen.uri,
      recordUri: listen.record_uri,
      listenId: listen.listen_id,
      revision,
      cid: listen.cid,
      second: Math.floor(Date.parse(listen.listened_at) / 1000),
      artistKey: listen.artist_key,
      trackKey: listen.track_key,
    });
  }
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
    archiveAcceptedListenTombstones(db, t.did, t.uri, t.rev);
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
  if (kind === 'love' && proof.state === 'present') {
    const deletion = db.one(
      `SELECT 1 AS hit FROM love_delete_bridges
       WHERE did=? AND uri=? AND state IN ('pending','succeeded')
         AND (delete_rev IS NULL OR delete_rev>=?) LIMIT 1`,
      did,
      uri,
      rev,
    );
    // A present proof at or before a confirmed delete boundary is stale. A
    // legacy/ambiguous delete without a commit revision remains fenced until
    // a verified absence or a revisioned post-delete present proof arrives.
    if (deletion !== null) return result('noop_older');
  }
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
