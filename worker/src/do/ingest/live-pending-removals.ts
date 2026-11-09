import type { Random } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { BATCH_MAX_LISTENS } from '@atmusic/core/scrobble-batch';
import { executeListenRemovals, type LiveRemovedListen } from '../../forward/live-removal-effects';
import { projectionListenKey } from '../../forward/projection';
import { enqueueForwards } from '../../outbox/forward-enqueue';
import { tombstoneLove } from '../../sync/tombstones';
import type { Db } from '../db';
import { schedule } from '../timers';
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
    `INSERT OR IGNORE INTO live_pending_removals
      (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
       artist_key,track_key,artist,track,recording_mbid,love_source_service,love_import_sources,
       authorized_rev,created_at_ms,expires_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
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
  const authorized = db.one<{ rev: string; action: LiveAction; cid: string; conflicted: number }>(
    `SELECT rev,action,cid,conflicted FROM live_pending_removal_events INDEXED BY live_pending_removal_events_by_uri
     WHERE uri=? AND rev>? AND rev<=? AND expires_at_ms>? ORDER BY rev LIMIT 1`,
    input.uri,
    input.windowLo,
    input.windowHi,
    input.nowMs,
  );
  if (authorized && eventMatchesPending(authorized, input.replacedByCid ?? '')) {
    db.run(
      `UPDATE live_pending_removals SET conflict_invalidated=CASE WHEN ? THEN 1 ELSE conflict_invalidated END,
       authorized_rev=CASE WHEN ? THEN authorized_rev ELSE ? END
       WHERE uri=? AND member_uri=? AND removed_cid=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
      authorized.conflicted,
      authorized.conflicted,
      authorized.rev,
      input.uri,
      input.row.uri,
      input.row.cid,
      input.windowLo,
      input.windowHi,
      input.replacedByCid ?? '',
    );
  }
  countLiveAdmission(db, 'pending_recorded');
}

function eventMatchesPending(event: { action: LiveAction; cid: string }, replacedByCid: string): boolean {
  return (
    event.action === 'delete' || (event.action === 'update' && replacedByCid !== '' && event.cid === replacedByCid)
  );
}

const AUTHORIZATION_PAGE_SIZE = 128;

interface AuthorizationEvent {
  uri: string;
  rev: string;
  action: LiveAction;
  cid: string;
  conflicted: number;
  cursor_window_hi: string;
  cursor_window_lo: string;
  cursor_replaced_by_cid: string;
  cursor_kind: string;
  cursor_member_uri: string;
  cursor_removed_cid: string;
  scan_complete: number;
}

/** Read and decide one bounded page of potentially intersecting windows. */
function processAuthorizationPage(db: Db, event: AuthorizationEvent): number {
  const page = db.all<{
    kind: 'scrobble' | 'love';
    window_lo: string;
    window_hi: string;
    replaced_by_cid: string;
    member_uri: string;
    removed_cid: string;
    authorized_rev: string | null;
    conflict_invalidated: number;
  }>(
    `SELECT kind,window_lo,window_hi,replaced_by_cid,member_uri,removed_cid,authorized_rev,conflict_invalidated
       FROM live_pending_removals INDEXED BY live_pending_removals_page
      WHERE uri=? AND window_hi>=?
        AND (window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid)>
            (?,?,?,?,?,?)
      ORDER BY window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid LIMIT ?`,
    event.uri,
    event.rev,
    event.cursor_window_hi,
    event.cursor_window_lo,
    event.cursor_replaced_by_cid,
    event.cursor_kind,
    event.cursor_member_uri,
    event.cursor_removed_cid,
    AUTHORIZATION_PAGE_SIZE,
  );
  let authorized = 0;
  for (const row of page) {
    const eligible =
      row.window_lo < event.rev &&
      event.rev <= row.window_hi &&
      (event.conflicted !== 0 || eventMatchesPending(event, row.replaced_by_cid));
    if (!eligible) continue;
    if (event.conflicted) {
      authorized += db.run(
        `UPDATE live_pending_removals SET conflict_invalidated=1
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
        event.uri,
        row.kind,
        row.window_lo,
        row.window_hi,
        row.replaced_by_cid,
      ).rowsWritten;
    } else if (row.authorized_rev === null && row.conflict_invalidated === 0) {
      authorized += db.run(
        `UPDATE live_pending_removals SET authorized_rev=?
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=? AND authorized_rev IS NULL AND conflict_invalidated=0`,
        event.rev,
        event.uri,
        row.kind,
        row.window_lo,
        row.window_hi,
        row.replaced_by_cid,
      ).rowsWritten;
    }
  }
  const last = page.at(-1);
  db.run(
    `UPDATE live_pending_removal_events SET
       cursor_window_hi=?,cursor_window_lo=?,cursor_replaced_by_cid=?,cursor_kind=?,cursor_member_uri=?,cursor_removed_cid=?,scan_complete=?
     WHERE uri=? AND rev=?`,
    last?.window_hi ?? event.cursor_window_hi,
    last?.window_lo ?? event.cursor_window_lo,
    last?.replaced_by_cid ?? event.cursor_replaced_by_cid,
    last?.kind ?? event.cursor_kind,
    last?.member_uri ?? event.cursor_member_uri,
    last?.removed_cid ?? event.cursor_removed_cid,
    page.length < AUTHORIZATION_PAGE_SIZE ? 1 : 0,
    event.uri,
    event.rev,
  );
  return authorized;
}

/** Called from the Jetstream hint transaction, before any coalescing can lose the event. */
export function authorizePendingRemovals(
  db: Db,
  event: { uri: string; rev: string; action: LiveAction; cid?: string; conflicted?: boolean },
  nowMs: number,
): number {
  const cid = event.cid ?? '';
  const previous = db.one<{ action: LiveAction; cid: string; conflicted: number }>(
    'SELECT action,cid,conflicted FROM live_pending_removal_events WHERE uri=? AND rev=?',
    event.uri,
    event.rev,
  );
  const different = Boolean(previous && (previous.action !== event.action || previous.cid !== cid));
  const conflict = Boolean(event.conflicted || previous?.conflicted);
  if (different && !conflict)
    db.run(
      `UPDATE live_pending_removal_events SET action=?,cid=?,cursor_window_hi='',cursor_window_lo='',
       cursor_replaced_by_cid='',cursor_kind='',cursor_member_uri='',cursor_removed_cid='',scan_complete=0
       WHERE uri=? AND rev=?`,
      event.action,
      cid,
      event.uri,
      event.rev,
    );
  db.run(
    `INSERT OR IGNORE INTO live_pending_removal_events(uri,rev,action,cid,conflicted,created_at_ms,expires_at_ms)
     VALUES(?,?,?,?,?,?,?)`,
    event.uri,
    event.rev,
    event.action,
    cid,
    conflict ? 1 : 0,
    nowMs,
    nowMs + LIVE_EVIDENCE_TTL_MS,
  );
  if (conflict && previous?.conflicted !== 1)
    db.run(
      `UPDATE live_pending_removal_events SET conflicted=1,cursor_window_hi='',cursor_window_lo='',
       cursor_replaced_by_cid='',cursor_kind='',cursor_member_uri='',cursor_removed_cid='',scan_complete=0
       WHERE uri=? AND rev=?`,
      event.uri,
      event.rev,
    );
  if (event.action === 'create' && !conflict) {
    db.run('UPDATE live_pending_removal_events SET scan_complete=1 WHERE uri=? AND rev=?', event.uri, event.rev);
    return 0;
  }
  const scan = db.one<AuthorizationEvent>(
    'SELECT * FROM live_pending_removal_events WHERE uri=? AND rev=?',
    event.uri,
    event.rev,
  );
  if (scan === null || scan.scan_complete) return 0;
  return processAuthorizationPage(db, scan);
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
  conflict_invalidated: number;
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
  const invalidatedEvent = db.one(
    `SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=? AND conflicted=1 LIMIT 1`,
    group.uri,
    group.authorized_rev,
  );
  const evidence = db.one<{ conflict_rev: string | null }>(
    'SELECT conflict_rev FROM live_record_evidence WHERE uri=? AND expires_at_ms>? LIMIT 1',
    group.uri,
    nowMs,
  );
  if (
    invalidatedEvent !== null ||
    group.conflict_invalidated !== 0 ||
    evidence?.conflict_rev === group.authorized_rev
  ) {
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
    const currentDid = rows[0]!.uri.slice(5).split('/', 1)[0]!;
    // A projection re-created after the removed window is canonical current
    // state. Do not put its URI in the exclusion set or let the stale CID's
    // tombstone hide it at dispatch.
    const removedRows = rows.filter((row) => {
      const current = db.one<{ revision: string; listened_at: string; artist_key: string; track_key: string }>(
        'SELECT revision,listened_at,artist_key,track_key FROM scrobbles WHERE did=? AND uri=?',
        currentDid,
        row.member_uri,
      );
      if (current === null || current.revision <= group.authorized_rev) return true;
      return (
        current.artist_key !== row.artist_key ||
        current.track_key !== row.track_key ||
        Math.floor(Date.parse(current.listened_at) / 1000) !== (row.listened_at ?? 0)
      );
    });
    if (removedRows.length === 0) {
      deleteGroup(db, group);
      return 0;
    }
    const count = executeListenRemovals(db, {
      did,
      rows: removedRows.map((row) => ({
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
  const newerProjectedLove =
    db.one(
      `SELECT 1 FROM loves INDEXED BY loves_newer_by_track
       WHERE did=? AND artist_key=? AND track_key=? AND revision>? LIMIT 1`,
      did,
      row.artist_key,
      row.track_key,
      group.authorized_rev,
    ) !== null;
  const currentIncarnation = db.one<{ incarnation_key: string; state: string }>(
    `SELECT incarnation_key,state FROM love_incarnations WHERE uri=?`,
    row.uri,
  );
  const currentIncarnationRev = currentIncarnation?.incarnation_key.slice(
    currentIncarnation.incarnation_key.lastIndexOf(':') + 1,
  );
  const sameUriNewerIncarnation =
    currentIncarnation?.state === 'present' &&
    currentIncarnationRev !== undefined &&
    currentIncarnationRev > group.authorized_rev &&
    db.one('SELECT 1 FROM loves WHERE uri=?', row.uri) !== null;
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
  if (!newerLoveIntent && !locallyReloved && !newerProjectedLove && !sameUriNewerIncarnation) {
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
  const expiredEvents = db.run(
    `DELETE FROM live_pending_removal_events WHERE rowid IN
       (SELECT e.rowid FROM live_pending_removal_events e WHERE e.expires_at_ms<=?
        AND (e.conflicted=0 OR NOT EXISTS (
          SELECT 1 FROM live_pending_removals p INDEXED BY live_pending_removals_authorize
          WHERE p.uri=e.uri AND p.window_hi>=e.rev AND p.window_lo<e.rev
        )) ORDER BY e.expires_at_ms,e.uri,e.rev LIMIT ?)`,
    args.nowMs,
    LIVE_SWEEP_LIMIT,
  ).rowsWritten;
  countLiveAdmission(db, 'pending_event_expired', expiredEvents);
  // If the bounded expiry page filled, leave remaining expired rows for the next slice.
  // This prevents the eligibility seek from walking an unbounded expired prefix.
  if (expired >= LIVE_SWEEP_LIMIT) return { groups: 0, expired, effects: 0 };
  const eventIndex =
    args.uri === undefined ? 'live_pending_removal_events_scan' : 'live_pending_removal_events_uri_scan';
  const pendingEvent = db.one<AuthorizationEvent>(
    `SELECT * FROM live_pending_removal_events INDEXED BY ${eventIndex}
     WHERE scan_complete=0 AND expires_at_ms>? ${args.uri === undefined ? '' : 'AND uri=?'}
     ORDER BY created_at_ms,uri,rev LIMIT 1`,
    ...(args.uri === undefined ? [args.nowMs] : [args.nowMs, args.uri]),
  );
  if (pendingEvent) processAuthorizationPage(db, pendingEvent);
  if (
    db.one(
      `SELECT 1 FROM live_pending_removal_events INDEXED BY ${eventIndex}
       WHERE scan_complete=0 AND expires_at_ms>? ${args.uri === undefined ? '' : 'AND uri=?'} LIMIT 1`,
      ...(args.uri === undefined ? [args.nowMs] : [args.nowMs, args.uri]),
    ) !== null
  )
    schedule(db, 'drain', args.nowMs);
  const groups: PendingGroup[] = [];
  const predicate = args.uri === undefined ? 'authorized_rev IS NOT NULL' : 'uri=? AND authorized_rev IS NOT NULL';
  const index = args.uri === undefined ? 'live_pending_removals_ready' : 'live_pending_removals_uri_ready';
  const headBind = args.uri === undefined ? [args.nowMs] : [args.uri, args.nowMs];
  let effects = 0;
  for (let i = 0; i < args.limit; i++) {
    const head = db.one<PendingGroup>(
      `SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev,conflict_invalidated
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
