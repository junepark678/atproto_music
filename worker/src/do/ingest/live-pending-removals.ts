import type { Random } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { BATCH_MAX_LISTENS } from '@atmusic/core/scrobble-batch';
import { executeListenRemovals, type LiveRemovedListen } from '../../forward/live-removal-effects';
import { projectionListenKey } from '../../forward/projection';
import { enqueueForwards } from '../../outbox/forward-enqueue';
import { tombstoneLove } from '../../sync/tombstones';
import type { Db } from '../db';
import { countLiveAdmission, LIVE_EVIDENCE_TTL_MS, LIVE_SWEEP_LIMIT, type LiveAction } from './live-evidence';

export interface PendingListen extends LiveRemovedListen {
  record_uri: string | null;
  listen_id: string | null;
}

export interface PendingRemovalInput {
  did: string;
  uri: string;
  kind: 'scrobble' | 'love';
  row: PendingListen;
  identityKey: string;
  windowLo: string;
  windowHi: string;
  replacedByCid: string | null;
  loveSourceService?: string | null;
  loveImportSources?: readonly string[];
  nowMs: number;
}

/** A removal observation is immutable. An exact replay is ignored; a later window gets a distinct group. */
export function recordPendingRemoval(db: Db, input: PendingRemovalInput): void {
  if (db.one('SELECT 1 FROM linked_accounts WHERE did=? LIMIT 1', input.did) === null) return;
  const second = Math.floor(Date.parse(input.row.listened_at) / 1000);
  db.run(
    `INSERT INTO live_pending_removals
      (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
       artist_key,track_key,artist,track,recording_mbid,love_source_service,love_import_sources,
       authorized_rev,created_at_ms,expires_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid)
     DO UPDATE SET expires_at_ms=max(live_pending_removals.expires_at_ms,excluded.expires_at_ms)`,
    input.uri,
    input.row.uri,
    input.row.cid,
    input.kind,
    input.windowLo,
    input.windowHi,
    input.replacedByCid ?? '',
    input.identityKey,
    input.kind === 'love' ? null : second,
    input.row.artist_key,
    input.row.track_key,
    input.row.artist,
    input.row.track,
    input.row.recording_mbid,
    input.loveSourceService ?? null,
    input.loveImportSources?.length ? JSON.stringify([...new Set(input.loveImportSources)].sort()) : null,
    input.nowMs,
    input.nowMs + LIVE_EVIDENCE_TTL_MS,
  );
  countLiveAdmission(db, 'pending_recorded');
}

/** Called from the Jetstream hint transaction, before any coalescing can lose the event. */
export function authorizePendingRemovals(
  db: Db,
  event: { uri: string; rev: string; action: LiveAction; cid?: string },
  nowMs: number,
): number {
  if (event.action !== 'delete' && (event.action !== 'update' || event.cid === undefined)) return 0;
  const candidate = db.one<{
    kind: 'scrobble' | 'love';
    window_lo: string;
    window_hi: string;
    replaced_by_cid: string;
    authorized_rev: string | null;
    expires_at_ms: number;
  }>(
    `SELECT kind,window_lo,window_hi,replaced_by_cid,authorized_rev,expires_at_ms
     FROM live_pending_removals INDEXED BY live_pending_removals_authorize
     WHERE uri=? AND window_hi>=? ORDER BY window_hi,window_lo DESC LIMIT 1`,
    event.uri,
    event.rev,
  );
  if (
    candidate === null ||
    candidate.window_lo >= event.rev ||
    candidate.expires_at_ms <= nowMs ||
    candidate.authorized_rev !== null ||
    (event.action === 'update' && candidate.replaced_by_cid !== event.cid)
  )
    return 0;
  return db.run(
    `UPDATE live_pending_removals INDEXED BY live_pending_removals_group SET authorized_rev=?
     WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=? AND authorized_rev IS NULL`,
    event.rev,
    event.uri,
    candidate.kind,
    candidate.window_lo,
    candidate.window_hi,
    candidate.replaced_by_cid,
  ).rowsWritten;
}

interface PendingRow {
  uri: string;
  member_uri: string;
  removed_cid: string;
  kind: 'scrobble' | 'love';
  identity_key: string;
  listened_at: number | null;
  window_lo: string;
  window_hi: string;
  replaced_by_cid: string;
  authorized_rev: string | null;
  artist_key: string;
  track_key: string;
  artist: string;
  track: string;
  recording_mbid: string | null;
  love_source_service: string | null;
  love_import_sources: string | null;
  created_at_ms: number;
  expires_at_ms: number;
}

interface PendingGroup {
  uri: string;
  kind: 'scrobble' | 'love';
  window_lo: string;
  window_hi: string;
  replaced_by_cid: string;
  authorized_rev: string;
}

function deleteGroup(db: Db, group: PendingGroup): void {
  db.run(
    `DELETE FROM live_pending_removals INDEXED BY live_pending_removals_group WHERE uri=? AND kind=? AND window_lo=? AND window_hi=?
       AND replaced_by_cid=? AND authorized_rev=?`,
    group.uri,
    group.kind,
    group.window_lo,
    group.window_hi,
    group.replaced_by_cid,
    group.authorized_rev,
  );
}

function processGroup(db: Db, group: PendingGroup, nowMs: number, random: Random): number {
  const evidence = db.one<{ conflict_rev: string | null }>(
    'SELECT conflict_rev FROM live_record_evidence WHERE uri=? AND expires_at_ms>? LIMIT 1',
    group.uri,
    nowMs,
  );
  if (evidence?.conflict_rev === group.authorized_rev) {
    deleteGroup(db, group);
    countLiveAdmission(db, 'pending_conflict');
    return 0;
  }
  const rows = db.all<PendingRow>(
    `SELECT * FROM live_pending_removals INDEXED BY live_pending_removals_group
     WHERE uri=? AND kind=? AND window_lo=? AND window_hi=?
       AND replaced_by_cid=? AND authorized_rev=? AND expires_at_ms>? ORDER BY member_uri,removed_cid`,
    group.uri,
    group.kind,
    group.window_lo,
    group.window_hi,
    group.replaced_by_cid,
    group.authorized_rev,
    nowMs,
  );
  if (rows.length === 0) return 0;
  if (group.kind === 'scrobble') {
    if (rows.length > BATCH_MAX_LISTENS)
      throw new Error(`pending removal group exceeds validator bound: ${rows.length}`);
    const did = rows[0]!.uri.slice(5).split('/', 1)[0]!;
    const count = executeListenRemovals(db, {
      did,
      rows: rows.map((row) => ({
        uri: row.member_uri,
        cid: row.removed_cid,
        listened_at: new Date((row.listened_at ?? 0) * 1000).toISOString(),
        artist_key: row.artist_key,
        track_key: row.track_key,
        artist: row.artist,
        track: row.track,
        recording_mbid: row.recording_mbid,
      })),
      authRev: group.authorized_rev,
      now: nowMs,
      identity: (row) => projectionListenKey(did, row.listened_at, row.artist_key, row.track_key),
      tombstoneIdentity: (row) =>
        group.replaced_by_cid === ''
          ? `live:${row.uri}:${row.cid}`
          : row.uri === group.uri
            ? `single-replaced:${row.uri}:${group.replaced_by_cid}`
            : `batch-replaced:${row.uri}:${group.replaced_by_cid}`,
    });
    deleteGroup(db, group);
    return count;
  }

  const row = rows[0]!;
  const did = row.uri.slice(5).split('/', 1)[0]!;
  const newerLoveIntent =
    db.one(
      `SELECT 1 FROM operations WHERE did=? AND kind='love.put' AND state IN ('queued','blocked','running')
       AND json_extract(record_json,'$.artist')=? AND json_extract(record_json,'$.track')=? LIMIT 1`,
      did,
      row.artist,
      row.track,
    ) !== null;
  const [artistKey, trackKeyValue] = trackKey(row.artist, row.track);
  const locallyReloved =
    db.one(
      `SELECT 1 FROM linked_love_intents WHERE did=? AND intent='love'
       AND (love_key=? OR (? IS NOT NULL AND recording_mbid=?)) LIMIT 1`,
      did,
      `${artistKey}\u0000${trackKeyValue}`,
      row.recording_mbid,
      row.recording_mbid,
    ) !== null;
  if (!newerLoveIntent && !locallyReloved) {
    const identity = `love-delete:${row.identity_key}`;
    tombstoneLove(db, {
      did,
      identity: `live:${row.uri}:${row.removed_cid}`,
      loveKey: `${artistKey}\u0000${trackKeyValue}`,
      recordingMbid: row.recording_mbid,
      nowMs,
    });
    db.run(
      `UPDATE forward_admissions SET path='live' WHERE did=? AND identity_key=? AND path='snapshot'`,
      did,
      identity,
    );
    const sources = new Set<'lastfm' | 'listenbrainz'>(
      row.love_import_sources ? (JSON.parse(row.love_import_sources) as ('lastfm' | 'listenbrainz')[]) : [],
    );
    if (row.love_source_service === 'lastfm' || row.love_source_service === 'listenbrainz')
      sources.add(row.love_source_service);
    enqueueForwards(db, {
      did,
      items: [
        {
          kind: 'unlove',
          operationId: `${identity}:rev:${group.authorized_rev}`,
          payload: {
            artist: row.artist,
            track: row.track,
            recordingMbid: row.recording_mbid ?? undefined,
            origin: 'web',
          },
        },
      ],
      ...(sources.size ? { excludeSourceServices: [...sources] } : {}),
      now: nowMs,
      random,
    });
  }
  deleteGroup(db, group);
  return 0;
}

/** Process a bounded number of complete groups; every group is atomic, including all batch exclusions. */
export function executeAuthorizedRemovals(
  db: Db,
  args: { nowMs: number; random: Random; uri?: string; limit: number },
): { groups: number; expired: number; effects: number } {
  const expired = db.run(
    `DELETE FROM live_pending_removals WHERE rowid IN
       (SELECT rowid FROM live_pending_removals WHERE expires_at_ms<=? ORDER BY expires_at_ms,uri,window_hi LIMIT ?)`,
    args.nowMs,
    LIVE_SWEEP_LIMIT,
  ).rowsWritten;
  countLiveAdmission(db, 'pending_expired', expired);
  // If the bounded expiry page filled, leave remaining expired rows for the next slice.
  // This prevents the eligibility seek from walking an unbounded expired prefix.
  if (expired >= LIVE_SWEEP_LIMIT) return { groups: 0, expired, effects: 0 };
  const groups: PendingGroup[] = [];
  const predicate = args.uri === undefined ? 'authorized_rev IS NOT NULL' : 'uri=? AND authorized_rev IS NOT NULL';
  const index = args.uri === undefined ? 'live_pending_removals_ready' : 'live_pending_removals_uri_ready';
  const headBind = args.uri === undefined ? [args.nowMs] : [args.uri, args.nowMs];
  let effects = 0;
  for (let i = 0; i < args.limit; i++) {
    const head = db.one<PendingGroup>(
      `SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev
         FROM live_pending_removals INDEXED BY ${index} WHERE ${predicate} AND expires_at_ms>?
         ORDER BY authorized_rev,created_at_ms,uri,window_hi LIMIT 1`,
      ...headBind,
    );
    if (head === null) break;
    groups.push(head);
    // Processing deletes this group, so the next indexed head advances without a full-history offset.
    effects += processGroup(db, head, args.nowMs, args.random);
  }
  countLiveAdmission(db, 'pending_groups_run', groups.length);
  return { groups: groups.length, expired, effects };
}
