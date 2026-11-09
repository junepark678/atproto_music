// Bounded indexed-history admission for S2. This timer performs no network I/O;
// the ordinary `forward` timer owns every upstream request.
import { listenKey } from '@atmusic/core/listen-key';
import { albumKey } from '@atmusic/core/music-key';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import type { CoreExtension } from '../app/host';
import type { LinkedAccountRow } from '../app/rows';
import type { Db } from '../do/db';
import { matchedRecordingMbid } from '../musicbrainz/store';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { forwardListenMetadata } from '../outbox/forward-payload';
import type { ForwardRuntime } from './forwarder';
import { projectionListenKey } from './projection';

export const BACKFILL_CHUNK_SIZE = 500;
export const BACKFILL_IDLE_MS = 30_000;
const BACKFILL_RETRY_BASE_MS = 5_000;
const BACKFILL_RETRY_MAX_MS = 300_000;
export const BACKFILL_MAX_FAILURES = 8;
export const BACKFILL_HISTORY_QUEUE_HIGH_WATER = 10_000;
const LASTFM_WINDOW_MS = 13 * 86_400_000;

type Cursor = { at: string; uri: string };
type AttemptFence = Pick<LinkedAccountRow, 'id' | 'generation' | 'backfill_run_revision'>;
class BackfillAttemptFailure extends Error {
  constructor(
    readonly attempt: AttemptFence,
    readonly originalError: unknown,
  ) {
    super('linked history backfill page failed');
  }
}

export function recordBackfillFailure(
  db: Db,
  attempt: AttemptFence,
  now: number,
): { failures: number; retryAt: number | null; exhausted: boolean } | null {
  return db.tx(() => {
    const link = db.one<{ backfill_failures: number }>(
      `SELECT backfill_failures FROM linked_accounts WHERE id=? AND generation=? AND backfill_run_revision=?
       AND status='active' AND forward_scrobbles=1 AND backfill_state='running'`,
      attempt.id,
      attempt.generation,
      attempt.backfill_run_revision,
    );
    if (link === null) return null;
    const failures = link.backfill_failures + 1;
    const exhausted = failures >= BACKFILL_MAX_FAILURES;
    const delay = Math.min(BACKFILL_RETRY_MAX_MS, BACKFILL_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10));
    const retryAt = exhausted ? null : now + delay;
    const updated = db.run(
      `UPDATE linked_accounts SET backfill_failures=?,backfill_next_attempt_ms=?,
       backfill_state=CASE WHEN ? THEN 'skipped' ELSE backfill_state END,
         backfill_last_error=CASE WHEN ? THEN 'retry_exhausted' ELSE backfill_last_error END,
         backfill_done=CASE WHEN ? THEN backfill_total ELSE backfill_done END
       WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active'
         AND forward_scrobbles=1 AND backfill_state='running'`,
      failures,
      retryAt,
      exhausted ? 1 : 0,
      exhausted ? 1 : 0,
      exhausted ? 1 : 0,
      attempt.id,
      attempt.generation,
      attempt.backfill_run_revision,
    );
    if (updated.rowsWritten === 0) return null;
    if (exhausted)
      db.run(
        'DELETE FROM link_backfill_items WHERE link_id=? AND generation=? AND run_revision=?',
        attempt.id,
        attempt.generation,
        attempt.backfill_run_revision,
      );
    return { failures, retryAt, exhausted };
  });
}
type HistoryRow = {
  kind: 'scrobble' | 'love';
  uri: string;
  cid: string;
  event_at: string;
  artist: string;
  track: string;
  album: string | null;
  recording_mbid: string | null;
  artist_key: string;
  track_key: string;
  album_key: string | null;
  listened_at: string | null;
  album_artist?: string | null;
  track_number?: number | null;
  artist_mbids?: string | null;
  release_mbid?: string | null;
  release_group_mbid?: string | null;
  isrc?: string | null;
  submission_client?: string | null;
  music_service?: string | null;
};

function cursorOf(raw: string | null): Cursor | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return typeof parsed.at === 'string' && typeof parsed.uri === 'string' ? { at: parsed.at, uri: parsed.uri } : null;
  } catch {
    return null;
  }
}

function candidates(
  db: Db,
  link: LinkedAccountRow,
  now: number,
  chunkSize: number,
  cursor: Cursor | null,
): HistoryRow[] {
  const lastfmCutoff =
    link.service === 'lastfm'
      ? new Date(now - LASTFM_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, '.000000000Z')
      : null;
  const cutoffFilter = lastfmCutoff === null ? '' : ' AND s.listened_at >= ?';
  const scrobbleKeyset = cursor === null ? '' : ' AND (s.listened_at,s.uri) < (?,?)';
  const loveKeyset = cursor === null ? '' : ' AND (l.created_at,l.uri) < (?,?)';
  const scrobbles = db.all<HistoryRow>(
    `SELECT 'scrobble' AS kind,s.uri,s.cid,s.listened_at AS event_at,s.artist,s.track,s.album,
            s.recording_mbid,s.artist_key,s.track_key,s.album_key,s.listened_at,
            s.album_artist,s.track_number,s.artist_mbids,s.release_mbid,s.release_group_mbid,s.isrc,s.submission_client,s.music_service
     FROM scrobbles s WHERE s.did=?${cutoffFilter}${scrobbleKeyset}
     ORDER BY s.listened_at DESC,s.uri DESC LIMIT ?`,
    link.did,
    ...(lastfmCutoff === null ? [] : [lastfmCutoff]),
    ...(cursor === null ? [] : [cursor.at, cursor.uri]),
    chunkSize,
  );
  const loves = db.all<HistoryRow>(
    `SELECT 'love' AS kind,l.uri,l.cid,l.created_at AS event_at,l.artist,l.track,l.album,
            l.recording_mbid,l.artist_key,l.track_key,NULL AS album_key,NULL AS listened_at
     FROM loves l WHERE l.did=?${loveKeyset}
     ORDER BY l.created_at DESC,l.uri DESC LIMIT ?`,
    link.did,
    ...(cursor === null ? [] : [cursor.at, cursor.uri]),
    chunkSize,
  );
  const merged: HistoryRow[] = [];
  let scrobbleIndex = 0;
  let loveIndex = 0;
  while (merged.length < chunkSize && (scrobbleIndex < scrobbles.length || loveIndex < loves.length)) {
    const scrobble = scrobbles[scrobbleIndex];
    const love = loves[loveIndex];
    if (
      scrobble !== undefined &&
      (love === undefined ||
        scrobble.event_at > love.event_at ||
        (scrobble.event_at === love.event_at && scrobble.uri > love.uri))
    ) {
      merged.push(scrobble);
      scrobbleIndex++;
    } else if (love !== undefined) {
      merged.push(love);
      loveIndex++;
    }
  }
  return merged;
}

function sourceService(source: string | null): 'lastfm' | 'listenbrainz' | null {
  if (source === 'lastfm_api' || source === 'lastfm_json' || source === 'lastfm') return 'lastfm';
  if (source === 'listenbrainz_api' || source === 'listenbrainz_zip' || source === 'listenbrainz')
    return 'listenbrainz';
  return null;
}

function payloadForHistoryRow(
  db: Db,
  link: LinkedAccountRow,
  row: HistoryRow,
  identityKey: string,
): { key: string; payload: unknown } | null {
  if (row.kind === 'love') {
    const incarnation = db.one<{ incarnation_key: string; path: string; source_service: string | null }>(
      "SELECT incarnation_key,path,source_service FROM love_incarnations WHERE uri=? AND state='present'",
      row.uri,
    );
    if (incarnation === null || incarnation.incarnation_key !== identityKey) return null;
    if (incarnation.path === 'import' && sourceService(incarnation.source_service) === null) return null;
    if (incarnation.path === 'import' && sourceService(incarnation.source_service) === link.service) return null;
  }
  const marker = db.one<{ path: string; source_service: string | null; admission_seq: number }>(
    'SELECT path,source_service,admission_seq FROM forward_admissions WHERE did=? AND identity_key=?',
    link.did,
    identityKey,
  );
  if (row.kind === 'scrobble') {
    const legacy = db.one<{ source: string }>(
      'SELECT source FROM listen_keys WHERE did=? AND dedupe_key=?',
      link.did,
      identityKey,
    );
    if (legacy?.source === 'import' && marker === null) return null;
    if (marker?.path === 'import' && sourceService(marker.source_service) === null) return null;
    if (marker?.path === 'import' && sourceService(marker.source_service) === link.service) return null;
  }
  if (marker !== null && marker.admission_seq > link.generation_start_seq && marker.path !== 'snapshot') return null;
  const mbid =
    row.recording_mbid ??
    matchedRecordingMbid(db, {
      artistKey: row.artist_key,
      trackKey: row.track_key,
      albumKey: row.album_key ?? (row.album ? albumKey(row.artist, row.album)?.[1] : undefined),
    });
  if (row.kind === 'love' && link.service === 'listenbrainz' && mbid === null) return null;
  if (row.kind === 'scrobble') {
    const listenedAt = row.listened_at as string;
    return {
      key: identityKey,
      payload: {
        listen: {
          artist: row.artist,
          track: row.track,
          listenedAt,
          ...(row.album ? { album: row.album } : {}),
          ...(mbid ? { recordingMbid: mbid } : {}),
          ...forwardListenMetadata(row),
        },
        origin: 'backfill',
      },
    };
  }
  return {
    key: identityKey,
    payload: {
      artist: row.artist,
      track: row.track,
      ...(row.album ? { album: row.album } : {}),
      ...(mbid ? { recordingMbid: mbid } : {}),
      origin: 'backfill',
    },
  };
}

async function admitHistoryRow(
  db: Db,
  link: LinkedAccountRow,
  row: HistoryRow,
): Promise<{ key: string; payload: unknown } | null> {
  let identityKey: string;
  if (row.kind === 'scrobble') {
    const ns = parseRfc3339(row.listened_at ?? '');
    if (ns === null) return null;
    identityKey = await listenKey({ did: link.did, listenedAtNs: ns, artist: row.artist, track: row.track });
  } else {
    const incarnation = db.one<{ incarnation_key: string }>(
      "SELECT incarnation_key FROM love_incarnations WHERE uri=? AND state='present'",
      row.uri,
    );
    if (incarnation === null) return null;
    identityKey = incarnation.incarnation_key;
  }
  return payloadForHistoryRow(db, link, row, identityKey);
}

/** Re-read the candidate inside the enqueue transaction after identity work yielded. */
function validateCurrentCandidate(
  db: Db,
  link: LinkedAccountRow,
  candidate: Pick<HistoryRow, 'kind' | 'uri' | 'cid'>,
  expectedKey: string,
): { key: string; payload: unknown } | null {
  if (candidate.kind === 'scrobble') {
    const current = db.one<HistoryRow>(
      `SELECT 'scrobble' AS kind,uri,cid,listened_at AS event_at,artist,track,album,recording_mbid,
              artist_key,track_key,album_key,listened_at,
              album_artist,track_number,artist_mbids,release_mbid,release_group_mbid,isrc,submission_client,music_service
       FROM scrobbles WHERE uri=? AND did=? AND cid=?`,
      candidate.uri,
      link.did,
      candidate.cid,
    );
    if (current === null) return null;
    const key = projectionListenKey(link.did, current.listened_at ?? '', current.artist_key, current.track_key);
    return key === expectedKey ? payloadForHistoryRow(db, link, current, key) : null;
  }

  const current = db.one<HistoryRow>(
    `SELECT 'love' AS kind,l.uri,l.cid,l.created_at AS event_at,l.artist,l.track,l.album,l.recording_mbid,
            l.artist_key,l.track_key,NULL AS album_key,NULL AS listened_at
     FROM loves l WHERE l.uri=? AND l.did=? AND l.cid=?`,
    candidate.uri,
    link.did,
    candidate.cid,
  );
  if (current === null) return null;
  const incarnation = db.one<{ incarnation_key: string; state: string }>(
    'SELECT incarnation_key,state FROM love_incarnations WHERE uri=?',
    current.uri,
  );
  if (incarnation?.state !== 'present' || incarnation.incarnation_key !== expectedKey) return null;
  return payloadForHistoryRow(db, link, current, incarnation.incarnation_key);
}

export async function runLinkBackfill(
  db: Db,
  random: ForwardRuntime['random'],
  now: number,
  chunkSize = BACKFILL_CHUNK_SIZE,
): Promise<number> {
  const maxPageSize = Math.max(1, Math.min(BACKFILL_CHUNK_SIZE, Math.trunc(chunkSize)));
  const link = db.tx(() => {
    const selected = db.one<LinkedAccountRow>(
      `SELECT la.* FROM linked_accounts la JOIN users u ON u.did=la.did
     WHERE la.status='active' AND la.forward_scrobbles=1 AND la.backfill_state IN ('pending','running')
       AND coalesce(la.backfill_next_attempt_ms,0)<=? AND u.indexing_state='current'
     ORDER BY la.backfill_last_serviced_seq,la.created_at_ms,la.id LIMIT 1`,
      now,
    );
    if (selected === null) return null;
    db.run("INSERT OR IGNORE INTO counters(name,label,value) VALUES('link_backfill','service_sequence',0)");
    const nextSeq = db.one<{ value: number }>(
      "UPDATE counters SET value=value+1 WHERE name='link_backfill' AND label='service_sequence' RETURNING value",
    )?.value;
    if (nextSeq === undefined) throw new Error('missing backfill fairness sequence');
    db.run(
      'UPDATE linked_accounts SET backfill_last_serviced_seq=? WHERE id=? AND generation=? AND backfill_run_revision=?',
      nextSeq,
      selected.id,
      selected.generation,
      selected.backfill_run_revision,
    );
    return selected;
  });
  if (link === null) return 0;
  if (link.backfill_state === 'pending') {
    const started = db.run(
      "UPDATE linked_accounts SET backfill_state='running',backfill_total=0,backfill_done=0,backfill_cursor=NULL,backfill_discovery_cursor=NULL,backfill_discovery_done=0,backfill_last_error=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='pending'",
      link.id,
      link.generation,
      link.backfill_run_revision,
    );
    if (started.rowsWritten === 0) return 0;
  }
  try {
    const current = db.one<{ backfill_discovery_done: number; staged: number }>(
      `SELECT la.backfill_discovery_done,
         (SELECT count(*) FROM link_backfill_items i WHERE i.link_id=la.id AND i.generation=la.generation
            AND i.run_revision=la.backfill_run_revision) AS staged
       FROM linked_accounts la WHERE la.id=? AND la.generation=? AND la.backfill_run_revision=? AND la.backfill_state='running'`,
      link.id,
      link.generation,
      link.backfill_run_revision,
    );
    if (current === null) return 0;
    if (current.staged > 0) {
      const queuedHistory = db.one<{ n: number }>(
        "SELECT count(*) AS n FROM forward_outbox WHERE priority=1 AND state='queued'",
      )?.n;
      if (queuedHistory === undefined) throw new Error('missing history queue count');
      const queueSpace = BACKFILL_HISTORY_QUEUE_HIGH_WATER - queuedHistory;
      if (queueSpace <= 0) return 0;
      const page = db.all<{
        identity_key: string;
        uri: string;
        cid: string;
        kind: 'scrobble' | 'love';
        ordinal: number;
      }>(
        `SELECT identity_key,uri,cid,kind,ordinal FROM link_backfill_items
         WHERE link_id=? AND generation=? AND run_revision=? ORDER BY ordinal LIMIT ?`,
        link.id,
        link.generation,
        link.backfill_run_revision,
        Math.min(maxPageSize, queueSpace),
      );
      const committed = db.tx(() => {
        const row = db.one<{
          generation: number;
          backfill_run_revision: number;
          backfill_state: string;
          status: string;
          forward_scrobbles: number;
          backfill_discovery_done: number;
        }>(
          'SELECT generation,backfill_run_revision,backfill_state,status,forward_scrobbles,backfill_discovery_done FROM linked_accounts WHERE id=?',
          link.id,
        );
        if (
          row === null ||
          row.generation !== link.generation ||
          row.backfill_run_revision !== link.backfill_run_revision ||
          row.backfill_state !== 'running' ||
          row.status !== 'active' ||
          row.forward_scrobbles !== 1
        )
          return false;
        for (const item of page) {
          const currentItem = validateCurrentCandidate(db, link, item, item.identity_key);
          if (currentItem !== null) {
            enqueueForwards(db, {
              did: link.did,
              linkId: link.id,
              priority: 1,
              now,
              random,
              items:
                item.kind === 'scrobble'
                  ? [{ kind: 'scrobble', listenKey: currentItem.key, payload: currentItem.payload }]
                  : [{ kind: 'love', operationId: currentItem.key, payload: currentItem.payload }],
            });
          }
          db.run(
            'DELETE FROM link_backfill_items WHERE link_id=? AND generation=? AND run_revision=? AND identity_key=?',
            link.id,
            link.generation,
            link.backfill_run_revision,
            item.identity_key,
          );
        }
        if (page.length > 0) {
          db.run(
            `UPDATE linked_accounts SET backfill_done=backfill_done+?,backfill_failures=0,backfill_next_attempt_ms=NULL
             WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'`,
            page.length,
            link.id,
            link.generation,
            link.backfill_run_revision,
          );
        }
        const remaining = db.one<{ n: number }>(
          'SELECT count(*) AS n FROM link_backfill_items WHERE link_id=? AND generation=? AND run_revision=?',
          link.id,
          link.generation,
          link.backfill_run_revision,
        )?.n;
        if (remaining === 0 && row.backfill_discovery_done === 1) {
          db.run(
            "UPDATE linked_accounts SET backfill_state='done',backfill_failures=0,backfill_next_attempt_ms=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'",
            link.id,
            link.generation,
            link.backfill_run_revision,
          );
        }
        return true;
      });
      return committed ? page.length : 0;
    }
    if (current.backfill_discovery_done === 1) {
      db.run(
        "UPDATE linked_accounts SET backfill_state='done',backfill_failures=0,backfill_next_attempt_ms=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'",
        link.id,
        link.generation,
        link.backfill_run_revision,
      );
      return 0;
    }
    {
      const discovery = candidates(db, link, now, maxPageSize, cursorOf(link.backfill_discovery_cursor));
      const eligible: Array<{ row: HistoryRow; key: string }> = [];
      for (const row of discovery) {
        const result = await admitHistoryRow(db, link, row);
        if (result !== null) eligible.push({ row, key: result.key });
      }
      const lastDiscovered = discovery.at(-1);
      db.tx(() => {
        const active = db.one<{
          generation: number;
          backfill_run_revision: number;
          backfill_state: string;
          status: string;
          forward_scrobbles: number;
          backfill_discovery_done: number;
          total: number;
        }>(
          `SELECT generation,backfill_run_revision,backfill_state,status,forward_scrobbles,backfill_discovery_done,
             backfill_total AS total FROM linked_accounts WHERE id=?`,
          link.id,
        );
        if (
          active === null ||
          active.generation !== link.generation ||
          active.backfill_run_revision !== link.backfill_run_revision ||
          active.backfill_state !== 'running' ||
          active.status !== 'active' ||
          active.forward_scrobbles !== 1 ||
          active.backfill_discovery_done !== 0
        )
          return;
        let addedTotal = 0;
        let settledSkipped = 0;
        for (let i = 0; i < eligible.length; i++) {
          const item = eligible[i];
          if (item === undefined) continue;
          const valid = validateCurrentCandidate(db, link, item.row, item.key);
          if (valid === null) {
            addedTotal++;
            settledSkipped++;
            continue;
          }
          const inserted = db.run(
            `INSERT OR IGNORE INTO link_backfill_items(link_id,generation,run_revision,ordinal,identity_key,uri,cid,kind,event_at)
             VALUES(?,?,?,?,?,?,?,?,?)`,
            link.id,
            link.generation,
            link.backfill_run_revision,
            active.total + i,
            item.key,
            item.row.uri,
            item.row.cid,
            item.row.kind,
            item.row.event_at,
          );
          if (inserted.rowsWritten > 0) addedTotal++;
        }
        db.run(
          `UPDATE linked_accounts SET backfill_total=backfill_total+?,backfill_done=backfill_done+?,backfill_discovery_cursor=?,
             backfill_discovery_done=CASE WHEN ? THEN 1 ELSE 0 END,
             backfill_cursor=NULL
           WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active'
             AND forward_scrobbles=1 AND backfill_state='running' AND backfill_discovery_done=0`,
          addedTotal,
          settledSkipped,
          lastDiscovered === undefined
            ? null
            : JSON.stringify({ at: lastDiscovered.event_at, uri: lastDiscovered.uri }),
          discovery.length < maxPageSize ? 1 : 0,
          link.id,
          link.generation,
          link.backfill_run_revision,
        );
      });
      return discovery.length;
    }
  } catch (error) {
    throw new BackfillAttemptFailure(
      { id: link.id, generation: link.generation, backfill_run_revision: link.backfill_run_revision },
      error,
    );
  }
}

export function linkBackfillExtension(runtime: () => ForwardRuntime | null): CoreExtension {
  return {
    name: 'link-backfill',
    timers: {
      'link-backfill': async (now, ctx) => {
        const rt = runtime();
        if (rt === null) return;
        try {
          const scanned = await runLinkBackfill(rt.db, rt.random, now);
          if (scanned > 0) ctx.schedule('link-backfill', now, { force: true });
          else {
            const next = rt.db.one<{ next: number | null }>(
              "SELECT min(backfill_next_attempt_ms) AS next FROM linked_accounts WHERE status='active' AND forward_scrobbles=1 AND backfill_state IN ('pending','running') AND backfill_next_attempt_ms>?",
              now,
            )?.next;
            ctx.schedule(
              'link-backfill',
              next === null || next === undefined ? now + BACKFILL_IDLE_MS : Math.min(now + BACKFILL_IDLE_MS, next),
              { force: true },
            );
          }
        } catch (error) {
          if (!(error instanceof BackfillAttemptFailure)) throw error;
          const result = recordBackfillFailure(rt.db, error.attempt, now);
          if (result === null) return;
          ctx.schedule('link-backfill', result.retryAt ?? now + BACKFILL_IDLE_MS, { force: true });
          rt.log.log('warn', 'forward.backfill_retry', {
            generation: error.attempt.generation,
            delayMs: result.retryAt === null ? null : result.retryAt - now,
            error: error.originalError instanceof Error ? error.originalError.name : 'UnknownError',
          });
        }
      },
    },
    start(ctx, now) {
      ctx.schedule('link-backfill', now);
    },
  };
}
