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
  const priorGroup = db.one<{
    authorized_rev: string | null;
    conflict_invalidated: number;
    conflicted_auth_rev: string | null;
  }>(
    `SELECT authorized_rev,conflict_invalidated,conflicted_auth_rev FROM live_pending_removals
     WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=? LIMIT 1`,
    input.uri,
    input.kind,
    input.windowLo,
    input.windowHi,
    input.replacedByCid ?? '',
  );
  const inserted = db.run(
    `INSERT OR IGNORE INTO live_pending_removals
      (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
       artist_key,track_key,artist,track,recording_mbid,love_source_service,love_import_sources,
       authorized_rev,created_at_ms,expires_at_ms,conflict_invalidated,conflicted_auth_rev)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    priorGroup?.authorized_rev ?? null,
    input.nowMs,
    input.nowMs + LIVE_EVIDENCE_TTL_MS,
    priorGroup?.conflict_invalidated ?? 0,
    priorGroup?.conflicted_auth_rev ?? null,
  );
  if (inserted.rowsWritten > 0) {
    db.run(
      `INSERT OR IGNORE INTO live_pending_removal_reconcile
        (uri,window_lo,window_hi,replaced_by_cid,cursor_rev,next_due_ms,created_at_ms)
       VALUES(?,?,?,?,?,?,?)`,
      input.uri,
      input.windowLo,
      input.windowHi,
      input.replacedByCid ?? '',
      input.windowLo,
      input.nowMs,
      input.nowMs,
    );
    reconcilePendingWindowPage(db, input.uri, input.windowLo, input.windowHi, input.replacedByCid ?? '', input.nowMs);
  }
  countLiveAdmission(db, 'pending_recorded');
}

function eventMatchesPending(event: { action: LiveAction; cid: string }, replacedByCid: string): boolean {
  return (
    event.action === 'delete' || (event.action === 'update' && replacedByCid !== '' && event.cid === replacedByCid)
  );
}

function reconcilePendingWindowPage(
  db: Db,
  uri: string,
  windowLo: string,
  windowHi: string,
  replacedByCid: string,
  nowMs: number,
): void {
  const frontier = db.one<{ cursor_rev: string }>(
    `SELECT cursor_rev FROM live_pending_removal_reconcile
     WHERE uri=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
    uri,
    windowLo,
    windowHi,
    replacedByCid,
  );
  if (frontier === null) return;
  const events = db.all<{
    rev: string;
    action: LiveAction;
    cid: string;
    conflicted: number;
    expires_at_ms: number;
  }>(
    `SELECT rev,action,cid,conflicted,expires_at_ms FROM live_pending_removal_events INDEXED BY live_pending_removal_events_by_uri
     WHERE uri=? AND rev>? AND rev<=? AND rev>? ORDER BY rev LIMIT ?`,
    uri,
    windowLo,
    windowHi,
    frontier.cursor_rev,
    RECONCILE_PAGE_SIZE,
  );
  for (const event of events) {
    if (event.expires_at_ms <= nowMs) continue;
    if (event.conflicted !== 0) {
      db.run(
        `UPDATE live_pending_removals SET conflicted_auth_rev=?
         WHERE uri=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
        event.rev,
        uri,
        windowLo,
        windowHi,
        replacedByCid,
      );
    } else if (eventMatchesPending(event, replacedByCid)) {
      db.run(
        `UPDATE live_pending_removals SET authorized_rev=?,conflict_invalidated=0
         WHERE uri=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?
           AND (authorized_rev IS NULL OR authorized_rev=conflicted_auth_rev)`,
        event.rev,
        uri,
        windowLo,
        windowHi,
        replacedByCid,
      );
    }
  }
  const last = events.at(-1);
  if (events.length < RECONCILE_PAGE_SIZE) {
    db.run(
      `DELETE FROM live_pending_removal_reconcile
       WHERE uri=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
      uri,
      windowLo,
      windowHi,
      replacedByCid,
    );
  } else if (last) {
    db.run(
      `UPDATE live_pending_removal_reconcile SET cursor_rev=?,next_due_ms=?
       WHERE uri=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?`,
      last.rev,
      nowMs,
      uri,
      windowLo,
      windowHi,
      replacedByCid,
    );
  }
}

const AUTHORIZATION_PAGE_SIZE = 128;
const EVENT_CLEANUP_PAGE_SIZE = 128;
const RECONCILE_PAGE_SIZE = 128;
const RETAINED_EVENT_RECHECK_MS = 60_000;

/** Production statements shared with the actual-SQL bounds regressions. */
export const AUTHORIZATION_PAGE_SQL = `SELECT kind,window_lo,window_hi,replaced_by_cid,member_uri,removed_cid,authorized_rev,conflict_invalidated,conflicted_auth_rev
  FROM live_pending_removals INDEXED BY live_pending_removals_page
 WHERE uri=? AND (window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid)>(?,?,?,?,?,?)
 ORDER BY window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid LIMIT ?`;
export const AUTHORIZATION_EVENT_HEAD_SQL = `SELECT * FROM live_pending_removal_events INDEXED BY live_pending_removal_events_ready_v2
 WHERE scan_complete=0 ORDER BY created_at_ms,uri,rev LIMIT 1`;
export const AUTHORIZATION_EVENT_HEAD_URI_SQL = `SELECT * FROM live_pending_removal_events INDEXED BY live_pending_removal_events_uri_ready_order
 WHERE uri=? AND scan_complete=0 ORDER BY created_at_ms,rev LIMIT 1`;
export const PENDING_EVENT_CLEANUP_PAGE_SQL = `SELECT rowid,uri,rev,conflicted,expires_at_ms FROM live_pending_removal_events INDEXED BY live_pending_removal_events_cleanup
 WHERE cleanup_due_ms<=? ORDER BY cleanup_due_ms,uri,rev LIMIT ?`;
export const PENDING_EXPIRY_PAGE_SQL = `SELECT rowid FROM live_pending_removals INDEXED BY live_pending_removals_expiry
 WHERE expires_at_ms<=? ORDER BY expires_at_ms,uri,window_hi LIMIT ?`;
export const CONFLICT_QUEUED_EFFECT_RETENTION_SQL = `SELECT 1 FROM listenbrainz_deletes INDEXED BY listenbrainz_deletes_authorization
 WHERE authorization_uri=? AND authorization_rev=? AND state='queued' LIMIT 1`;
export const CONFLICT_QUEUED_UNLOVE_RETENTION_SQL = `SELECT 1 FROM forward_outbox INDEXED BY forward_outbox_authorization
 WHERE authorization_uri=? AND authorization_rev=? AND kind='unlove' AND state='queued' LIMIT 1`;
export const CONFLICT_RETENTION_SCAN_SQL = `SELECT window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid
  FROM live_pending_removals INDEXED BY live_pending_removals_page
 WHERE uri=? AND (window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid)>(?,?,?,?,?,?)
 ORDER BY window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid LIMIT ?`;

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
  expires_at_ms: number;
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
    conflicted_auth_rev: string | null;
  }>(
    AUTHORIZATION_PAGE_SQL,
    event.uri,
    event.cursor_window_hi < event.rev ? event.rev : event.cursor_window_hi,
    event.cursor_window_hi < event.rev ? '' : event.cursor_window_lo,
    event.cursor_window_hi < event.rev ? '' : event.cursor_replaced_by_cid,
    event.cursor_window_hi < event.rev ? '' : event.cursor_kind,
    event.cursor_window_hi < event.rev ? '' : event.cursor_member_uri,
    event.cursor_window_hi < event.rev ? '' : event.cursor_removed_cid,
    AUTHORIZATION_PAGE_SIZE,
  );
  let authorized = 0;
  const groups = new Map<string, (typeof page)[number]>();
  for (const row of page) {
    const eligible =
      row.window_lo < event.rev &&
      event.rev <= row.window_hi &&
      (event.conflicted !== 0 || eventMatchesPending(event, row.replaced_by_cid));
    if (!eligible) continue;
    const key = JSON.stringify([row.kind, row.window_lo, row.window_hi, row.replaced_by_cid]);
    if (!groups.has(key)) groups.set(key, row);
  }
  for (const row of groups.values()) {
    if (event.conflicted) {
      if (row.conflicted_auth_rev !== null && row.conflicted_auth_rev >= event.rev) continue;
      db.run(
        `UPDATE forward_outbox SET authorization_conflicted=1
         WHERE authorization_uri=? AND authorization_rev=? AND kind='unlove' AND state='queued'`,
        event.uri,
        event.rev,
      );
      authorized += db.run(
        `UPDATE live_pending_removals SET conflicted_auth_rev=?
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?
           AND (conflicted_auth_rev IS NULL OR conflicted_auth_rev<?)`,
        event.rev,
        event.uri,
        row.kind,
        row.window_lo,
        row.window_hi,
        row.replaced_by_cid,
        event.rev,
      ).rowsWritten;
    } else if (
      (row.authorized_rev === null && (row.conflicted_auth_rev === null || event.rev > row.conflicted_auth_rev)) ||
      (row.authorized_rev === row.conflicted_auth_rev && row.authorized_rev !== null && event.rev > row.authorized_rev)
    ) {
      authorized += db.run(
        `UPDATE live_pending_removals SET authorized_rev=?,conflict_invalidated=0
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=?
           AND ((authorized_rev IS NULL AND (conflicted_auth_rev IS NULL OR conflicted_auth_rev<?))
             OR (authorized_rev=conflicted_auth_rev AND authorized_rev<?))`,
        event.rev,
        event.uri,
        row.kind,
        row.window_lo,
        row.window_hi,
        row.replaced_by_cid,
        event.rev,
        event.rev,
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
  const conflict = Boolean(event.conflicted || previous?.conflicted || different);
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
  if (conflict)
    db.run(
      `UPDATE forward_outbox SET authorization_conflicted=1
       WHERE authorization_uri=? AND authorization_rev=? AND kind='unlove' AND state='queued'`,
      event.uri,
      event.rev,
    );
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
  conflicted_auth_rev: string | null;
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
    group.conflicted_auth_rev === group.authorized_rev ||
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
      authUri: group.uri,
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
          authorization: { uri: group.uri, rev: group.authorized_rev },
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
  const expiredRows = db.all<{ rowid: number }>(PENDING_EXPIRY_PAGE_SQL, args.nowMs, LIVE_SWEEP_LIMIT);
  let expired = 0;
  for (const row of expiredRows)
    expired += db.run(
      'DELETE FROM live_pending_removals WHERE rowid=? AND expires_at_ms<=?',
      row.rowid,
      args.nowMs,
    ).rowsWritten;
  countLiveAdmission(db, 'pending_expired', expired);
  const cleanupEvents = db.all<{
    rowid: number;
    uri: string;
    rev: string;
    conflicted: number;
    expires_at_ms: number;
    cleanup_cursor_window_hi: string;
    cleanup_cursor_window_lo: string;
    cleanup_cursor_replaced_by_cid: string;
    cleanup_cursor_kind: string;
    cleanup_cursor_member_uri: string;
    cleanup_cursor_removed_cid: string;
    cleanup_scan_complete: number;
    cleanup_has_match: number;
  }>(PENDING_EVENT_CLEANUP_PAGE_SQL.replace('expires_at_ms FROM', 'expires_at_ms,cleanup_cursor_window_hi,cleanup_cursor_window_lo,cleanup_cursor_replaced_by_cid,cleanup_cursor_kind,cleanup_cursor_member_uri,cleanup_cursor_removed_cid,cleanup_scan_complete,cleanup_has_match FROM'), args.nowMs, EVENT_CLEANUP_PAGE_SIZE);
  let expiredEvents = 0;
  for (const event of cleanupEvents) {
    if (event.expires_at_ms > args.nowMs) {
      db.run('UPDATE live_pending_removal_events SET cleanup_due_ms=? WHERE rowid=?', event.expires_at_ms, event.rowid);
      continue;
    }
    let retainedPending = false;
    if (event.conflicted !== 0 && event.cleanup_scan_complete === 0) {
      const page = db.all<{
        window_hi: string;
        window_lo: string;
        replaced_by_cid: string;
        kind: 'scrobble' | 'love';
        member_uri: string;
        removed_cid: string;
      }>(
        CONFLICT_RETENTION_SCAN_SQL,
        event.uri,
        event.cleanup_cursor_window_hi,
        event.cleanup_cursor_window_lo,
        event.cleanup_cursor_replaced_by_cid,
        event.cleanup_cursor_kind,
        event.cleanup_cursor_member_uri,
        event.cleanup_cursor_removed_cid,
        EVENT_CLEANUP_PAGE_SIZE,
      );
      const hasMatch = event.cleanup_has_match !== 0 || page.some((row) => row.window_lo < event.rev && row.window_hi >= event.rev);
      const last = page.at(-1);
      if (page.length === EVENT_CLEANUP_PAGE_SIZE && last) {
        db.run(
          `UPDATE live_pending_removal_events SET cleanup_cursor_window_hi=?,cleanup_cursor_window_lo=?,
           cleanup_cursor_replaced_by_cid=?,cleanup_cursor_kind=?,cleanup_cursor_member_uri=?,cleanup_cursor_removed_cid=?,
           cleanup_has_match=?,cleanup_due_ms=? WHERE rowid=?`,
          last.window_hi,
          last.window_lo,
          last.replaced_by_cid,
          last.kind,
          last.member_uri,
          last.removed_cid,
          hasMatch ? 1 : 0,
          args.nowMs + RETAINED_EVENT_RECHECK_MS,
          event.rowid,
        );
        retainedPending = true;
      } else if (hasMatch) {
        db.run(
          `UPDATE live_pending_removal_events SET cleanup_cursor_window_hi='',cleanup_cursor_window_lo='',
           cleanup_cursor_replaced_by_cid='',cleanup_cursor_kind='',cleanup_cursor_member_uri='',cleanup_cursor_removed_cid='',
           cleanup_has_match=0,cleanup_due_ms=? WHERE rowid=?`,
          args.nowMs + RETAINED_EVENT_RECHECK_MS,
          event.rowid,
        );
        retainedPending = true;
      } else {
        db.run('UPDATE live_pending_removal_events SET cleanup_scan_complete=1,cleanup_has_match=0 WHERE rowid=?', event.rowid);
      }
    }
    const retainedEffect =
      db.one(CONFLICT_QUEUED_EFFECT_RETENTION_SQL, event.uri, event.rev) !== null ||
      db.one(CONFLICT_QUEUED_UNLOVE_RETENTION_SQL, event.uri, event.rev) !== null;
    if (retainedPending || retainedEffect) {
      db.run(
        'UPDATE live_pending_removal_events SET cleanup_due_ms=? WHERE rowid=?',
        args.nowMs + RETAINED_EVENT_RECHECK_MS,
        event.rowid,
      );
    } else {
      expiredEvents += db.run('DELETE FROM live_pending_removal_events WHERE rowid=?', event.rowid).rowsWritten;
    }
  }
  countLiveAdmission(db, 'pending_event_expired', expiredEvents);
  // If the bounded expiry page filled, leave remaining expired rows for the next slice.
  // This prevents the eligibility seek from walking an unbounded expired prefix.
  if (expired >= LIVE_SWEEP_LIMIT) return { groups: 0, expired, effects: 0 };
  const reconcileHead = db.one<{
    uri: string;
    window_lo: string;
    window_hi: string;
    replaced_by_cid: string;
  }>(
    `SELECT uri,window_lo,window_hi,replaced_by_cid FROM live_pending_removal_reconcile
     WHERE next_due_ms<=? ORDER BY next_due_ms,created_at_ms,uri,window_lo,window_hi,replaced_by_cid LIMIT 1`,
    args.nowMs,
  );
  if (reconcileHead)
    reconcilePendingWindowPage(
      db,
      reconcileHead.uri,
      reconcileHead.window_lo,
      reconcileHead.window_hi,
      reconcileHead.replaced_by_cid,
      args.nowMs,
    );
  const eventIndex =
    args.uri === undefined ? 'live_pending_removal_events_ready_v2' : 'live_pending_removal_events_uri_ready_order';
  const pendingEvent = db.one<AuthorizationEvent>(
    args.uri === undefined ? AUTHORIZATION_EVENT_HEAD_SQL : AUTHORIZATION_EVENT_HEAD_URI_SQL,
    ...(args.uri === undefined ? [] : [args.uri]),
  );
  if (pendingEvent) {
    if (pendingEvent.expires_at_ms <= args.nowMs)
      db.run(
        'UPDATE live_pending_removal_events SET scan_complete=1 WHERE uri=? AND rev=?',
        pendingEvent.uri,
        pendingEvent.rev,
      );
    else processAuthorizationPage(db, pendingEvent);
  }
  if (
    db.one(
      `SELECT 1 FROM live_pending_removal_events INDEXED BY ${eventIndex}
       WHERE scan_complete=0 ${args.uri === undefined ? '' : 'AND uri=?'} LIMIT 1`,
      ...(args.uri === undefined ? [] : [args.uri]),
    ) !== null
  )
    schedule(db, 'drain', args.nowMs + 2_000);
  const groups: PendingGroup[] = [];
  const predicate = args.uri === undefined ? 'authorized_rev IS NOT NULL' : 'uri=? AND authorized_rev IS NOT NULL';
  const index = args.uri === undefined ? 'live_pending_removals_ready' : 'live_pending_removals_uri_ready';
  const headBind = args.uri === undefined ? [args.nowMs] : [args.uri, args.nowMs];
  let effects = 0;
  for (let i = 0; i < args.limit; i++) {
    const head = db.one<PendingGroup>(
      `SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev,conflict_invalidated,conflicted_auth_rev
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
  const nextPendingDue = nextPendingRemovalDue(db, args.nowMs);
  if (nextPendingDue !== null) schedule(db, 'drain', Math.max(nextPendingDue, args.nowMs + 2_000));
  return { groups: groups.length, expired, effects };
}

/** Bounded existence probes used by drain scheduling and startup reconciliation. */
export function hasPendingRemovalWork(db: Db, nowMs: number): boolean {
  return nextPendingRemovalDue(db, nowMs) !== null;
}

/** The next immediate continuation or retained cleanup deadline. */
export function nextPendingRemovalDue(db: Db, nowMs: number): number | null {
  const immediate =
    db.one(
      `SELECT 1 FROM live_pending_removal_events INDEXED BY live_pending_removal_events_ready_v2
       WHERE scan_complete=0 LIMIT 1`,
    ) !== null ||
    db.one(
      `SELECT 1 FROM live_pending_removal_reconcile INDEXED BY live_pending_removal_reconcile_due
       WHERE next_due_ms<=? LIMIT 1`,
      nowMs,
    ) !== null ||
    db.one(
      `SELECT 1 FROM live_pending_removals INDEXED BY live_pending_removals_ready
       WHERE authorized_rev IS NOT NULL AND expires_at_ms>? LIMIT 1`,
      nowMs,
    ) !== null ||
    db.one(
      `SELECT 1 FROM live_pending_removals INDEXED BY live_pending_removals_expiry WHERE expires_at_ms<=? LIMIT 1`,
      nowMs,
    ) !== null ||
    db.one(
      `SELECT 1 FROM live_pending_removal_events INDEXED BY live_pending_removal_events_cleanup
       WHERE cleanup_due_ms<=? LIMIT 1`,
      nowMs,
    ) !== null;
  if (immediate) return nowMs;
  const cleanup =
    db.one<{ due: number | null }>(
      `SELECT min(cleanup_due_ms) AS due FROM live_pending_removal_events INDEXED BY live_pending_removal_events_cleanup
     WHERE cleanup_due_ms>?`,
      nowMs,
    )?.due ?? null;
  const pendingExpiry =
    db.one<{ due: number | null }>(
      `SELECT min(expires_at_ms) AS due FROM live_pending_removals INDEXED BY live_pending_removals_expiry
     WHERE expires_at_ms>?`,
      nowMs,
    )?.due ?? null;
  if (cleanup === null) return pendingExpiry;
  if (pendingExpiry === null) return cleanup;
  return Math.min(cleanup, pendingExpiry);
}
