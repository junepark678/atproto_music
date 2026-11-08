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
import type { ForwardRuntime } from './forwarder';

export const BACKFILL_CHUNK_SIZE = 500;
export const BACKFILL_IDLE_MS = 30_000;
const BACKFILL_RETRY_BASE_MS = 5_000;
const BACKFILL_RETRY_MAX_MS = 300_000;
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
type HistoryRow = {
  kind: 'scrobble' | 'love';
  uri: string;
  event_at: string;
  artist: string;
  track: string;
  album: string | null;
  recording_mbid: string | null;
  artist_key: string;
  track_key: string;
  album_key: string | null;
  listened_at: string | null;
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

function candidates(db: Db, link: LinkedAccountRow, now: number, chunkSize: number): HistoryRow[] {
  const cursor = cursorOf(link.backfill_cursor);
  const lastfmCutoff =
    link.service === 'lastfm'
      ? new Date(now - LASTFM_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, '.000000000Z')
      : null;
  const cutoffFilter = lastfmCutoff === null ? '' : ' AND s.listened_at >= ?';
  const keysetFilter = cursor === null ? '' : ' AND (event_at < ? OR (event_at = ? AND uri < ?))';
  return db.all<HistoryRow>(
    `SELECT * FROM (
       SELECT 'scrobble' AS kind, s.uri, s.listened_at AS event_at, s.artist, s.track, s.album,
              s.recording_mbid, s.artist_key, s.track_key, s.album_key, s.listened_at
       FROM scrobbles s WHERE s.did=?${cutoffFilter}
       UNION ALL
       SELECT 'love' AS kind, l.uri, l.created_at AS event_at, l.artist, l.track, l.album,
              l.recording_mbid, l.artist_key, l.track_key, NULL AS album_key, NULL AS listened_at
       FROM loves l WHERE l.did=?
     ) WHERE 1=1${keysetFilter}
     ORDER BY event_at DESC, uri DESC LIMIT ?`,
    link.did,
    ...(lastfmCutoff === null ? [] : [lastfmCutoff]),
    link.did,
    ...(cursor === null ? [] : [cursor.at, cursor.at, cursor.uri]),
    chunkSize,
  );
}

function totalRows(db: Db, link: LinkedAccountRow, now: number): number {
  const since =
    link.service === 'lastfm'
      ? new Date(now - LASTFM_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, '.000000000Z')
      : null;
  const scrobbles =
    db.one<{ n: number }>(
      `SELECT count(*) AS n FROM scrobbles WHERE did=?${since === null ? '' : ' AND listened_at>=?'}`,
      ...(since === null ? [link.did] : [link.did, since]),
    )?.n ?? 0;
  const loves = db.one<{ n: number }>('SELECT count(*) AS n FROM loves WHERE did=?', link.did)?.n ?? 0;
  return scrobbles + loves;
}

function sourceService(source: string | null): 'lastfm' | 'listenbrainz' | null {
  if (source === 'lastfm_api' || source === 'lastfm_json' || source === 'lastfm') return 'lastfm';
  if (source === 'listenbrainz_api' || source === 'listenbrainz_zip' || source === 'listenbrainz')
    return 'listenbrainz';
  return null;
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
    const incarnation = db.one<{ incarnation_key: string; path: string; source_service: string | null }>(
      "SELECT incarnation_key,path,source_service FROM love_incarnations WHERE uri=? AND state='present'",
      row.uri,
    );
    if (!incarnation) return null;
    identityKey = incarnation.incarnation_key;
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

export async function runLinkBackfill(
  db: Db,
  random: ForwardRuntime['random'],
  now: number,
  chunkSize = BACKFILL_CHUNK_SIZE,
): Promise<number> {
  const link = db.one<LinkedAccountRow>(
    `SELECT la.* FROM linked_accounts la JOIN users u ON u.did=la.did
     WHERE la.status='active' AND la.forward_scrobbles=1 AND la.backfill_state IN ('pending','running')
       AND coalesce(la.backfill_next_attempt_ms,0)<=? AND u.indexing_state='current'
     ORDER BY la.created_at_ms,la.id LIMIT 1`,
    now,
  );
  if (link === null) return 0;
  if (link.backfill_state === 'pending') {
    const started = db.run(
      "UPDATE linked_accounts SET backfill_state='running',backfill_total=?,backfill_done=0,backfill_cursor=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='pending'",
      totalRows(db, link, now),
      link.id,
      link.generation,
      link.backfill_run_revision,
    );
    if (started.rowsWritten === 0) return 0;
  }
  try {
    const page = candidates(db, link, now, chunkSize);
    const admitted: Array<{ row: HistoryRow; key: string; payload: unknown }> = [];
    for (const row of page) {
      const result = await admitHistoryRow(db, link, row);
      if (result !== null) admitted.push({ row, ...result });
    }
    const last = page.at(-1);
    const committed = db.tx(() => {
      const current = db.one<{
        generation: number;
        backfill_run_revision: number;
        backfill_state: string;
        status: string;
        forward_scrobbles: number;
      }>('SELECT generation,backfill_run_revision,backfill_state,status,forward_scrobbles FROM linked_accounts WHERE id=?', link.id);
      if (
        current === null ||
        current.generation !== link.generation ||
        current.backfill_run_revision !== link.backfill_run_revision ||
        current.backfill_state !== 'running' ||
        current.status !== 'active' ||
        current.forward_scrobbles !== 1
      )
        return false;
      for (const item of admitted) {
        enqueueForwards(db, {
          did: link.did,
          linkId: link.id,
          priority: 1,
          now,
          random,
          items:
            item.row.kind === 'scrobble'
              ? [{ kind: 'scrobble', listenKey: item.key, payload: item.payload }]
              : [{ kind: 'love', operationId: item.key, payload: item.payload }],
        });
      }
      if (last === undefined) {
        db.run(
          "UPDATE linked_accounts SET backfill_state='done',backfill_cursor=NULL,backfill_failures=0,backfill_next_attempt_ms=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'",
          link.id,
          link.generation,
          link.backfill_run_revision,
        );
      } else {
        const nextState = page.length < chunkSize ? 'done' : 'running';
        db.run(
          "UPDATE linked_accounts SET backfill_state=?,backfill_cursor=?,backfill_done=backfill_done+?,backfill_failures=0,backfill_next_attempt_ms=NULL WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'",
          nextState,
          JSON.stringify({ at: last.event_at, uri: last.uri }),
          page.length,
          link.id,
          link.generation,
          link.backfill_run_revision,
        );
      }
      return true;
    });
    return committed ? page.length : 0;
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
          const link = rt.db.one<{ backfill_failures: number }>(
            `SELECT backfill_failures FROM linked_accounts WHERE id=? AND generation=? AND backfill_run_revision=?
             AND status='active' AND forward_scrobbles=1 AND backfill_state='running'`,
            error.attempt.id,
            error.attempt.generation,
            error.attempt.backfill_run_revision,
          );
          if (link === null) return;
          const failures = link.backfill_failures + 1;
          const delay = Math.min(BACKFILL_RETRY_MAX_MS, BACKFILL_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10));
          const retryAt = now + delay;
          rt.db.run(
            "UPDATE linked_accounts SET backfill_failures=?,backfill_next_attempt_ms=? WHERE id=? AND generation=? AND backfill_run_revision=? AND status='active' AND forward_scrobbles=1 AND backfill_state='running'",
            failures,
            retryAt,
            error.attempt.id,
            error.attempt.generation,
            error.attempt.backfill_run_revision,
          );
          ctx.schedule('link-backfill', retryAt, { force: true });
          rt.log.log('warn', 'forward.backfill_retry', {
            generation: error.attempt.generation,
            delayMs: delay,
            error: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      },
    },
    start(ctx, now) {
      ctx.schedule('link-backfill', now);
    },
  };
}
