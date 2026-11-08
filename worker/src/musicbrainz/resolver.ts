import type { Clock } from '@atmusic/core/deps';
import { musicKeyId, artistKey as normalizeArtist, artistKey as normalizeTrack } from '@atmusic/core/music-key';
import type { CoreExtension } from '../app/host';
import type { Db } from '../do/db';
import type { MusicBrainzOutcome } from './client';
import { enqueueCoverArt } from './cover-art-store';
import { backfillLoveReviveKeys, enqueueRevivedLoves } from './revive-loves';
import type { TrackKey } from './store';
import {
  advanceLoveReviveJob,
  deleteLoveReviveJob,
  loveReviveJobs,
  seedHistoricalTracks,
  stageLoveReviveJob,
} from './store';

const DAY = 86_400_000;
const MAX_RUN_REQUESTS = 3;
const MAX_BACKOFF = DAY;

export interface ResolverClient {
  lookupRecording(mbid: string): Promise<MusicBrainzOutcome<Record<string, unknown>>>;
  searchRecordings(args: {
    artist: string;
    recording: string;
    release?: string;
    limit: number;
  }): Promise<MusicBrainzOutcome<{ recordings: unknown[] }>>;
}

interface Row extends TrackKey {
  artist_key: string;
  track_key: string;
  album_key: string;
  submitted_recording_mbid: string | null;
  status: string;
  attempts: number;
  priority: number;
  next_attempt_ms: number;
  last_attempt_ms: number | null;
  matched_by: string | null;
}

function credits(value: unknown): Array<{ name: string; mbid: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const artist = (e.artist && typeof e.artist === 'object' ? e.artist : e) as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : artist.name;
    return typeof name === 'string'
      ? [{ name, mbid: typeof artist.id === 'string' && /^[0-9a-f-]{36}$/i.test(artist.id) ? artist.id : null }]
      : [];
  });
}
function creditDisplay(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const entry = part as Record<string, unknown>;
      const artist = (entry.artist && typeof entry.artist === 'object' ? entry.artist : entry) as Record<
        string,
        unknown
      >;
      return `${typeof entry.name === 'string' ? entry.name : typeof artist.name === 'string' ? artist.name : ''}${typeof entry.joinphrase === 'string' ? entry.joinphrase : ''}`;
    })
    .join('');
}

function official(release: Record<string, unknown>): boolean {
  const status = release.status;
  return status === 'Official';
}
function dateOf(release: Record<string, unknown>): string {
  return typeof release.date === 'string' && /^\d{4}/.test(release.date) ? release.date : '9999';
}

function selectedRelease(releases: unknown[], albumKey: string): Record<string, unknown> | null {
  const items = releases.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const exact = items.find(
    (x) =>
      typeof x.title === 'string' &&
      safeKey(x.title, normalizeArtist) !== null &&
      musicKeyId([safeKey(x.title, normalizeArtist)!, '']) === musicKeyId([albumKey, '']),
  );
  if (exact) return exact;
  const inAlbumGroup = items.filter(
    (x) => official(x) && (x['release-group'] as Record<string, unknown> | undefined)?.['primary-type'] === 'Album',
  );
  const candidates = inAlbumGroup.length ? inAlbumGroup : items.filter(official);
  return candidates.sort((a, b) => dateOf(a).localeCompare(dateOf(b)))[0] ?? null;
}

type CandidateCheck = 'match' | 'mismatch' | 'malformed';
function safeKey(value: string, normalize: (input: string) => string): string | null {
  try {
    return normalize(value);
  } catch {
    return null;
  }
}
function validMbid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function checkRecording(value: Record<string, unknown>, row: Row, minScore = 0): CandidateCheck {
  if (!validMbid(value.id) || typeof value.title !== 'string' || !value.title.trim()) return 'malformed';
  if (
    value.score !== undefined &&
    (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100)
  )
    return 'malformed';
  if (minScore > 0 && typeof value.score !== 'number') return 'malformed';
  if (
    value.length !== undefined &&
    (typeof value.length !== 'number' || !Number.isSafeInteger(value.length) || value.length < 0)
  )
    return 'malformed';
  const creditsValue = value['artist-credit'];
  if (!Array.isArray(creditsValue) || creditsValue.length === 0) return 'malformed';
  const names = credits(creditsValue);
  if (
    names.length !== creditsValue.length ||
    names.some((credit) => !credit.name.trim() || safeKey(credit.name, normalizeArtist) === null)
  )
    return 'malformed';
  for (const item of creditsValue as Array<Record<string, unknown>>) {
    const artist = item.artist && typeof item.artist === 'object' ? (item.artist as Record<string, unknown>) : item;
    if (artist.id !== undefined && !validMbid(artist.id)) return 'malformed';
    if (item.joinphrase !== undefined && typeof item.joinphrase !== 'string') return 'malformed';
  }
  if (value.releases !== undefined && !Array.isArray(value.releases)) return 'malformed';
  for (const release of (Array.isArray(value.releases) ? value.releases : []) as Array<Record<string, unknown>>) {
    if (!release || typeof release !== 'object') return 'malformed';
    if (release.id !== undefined && !validMbid(release.id)) return 'malformed';
    if (
      release.title !== undefined &&
      (typeof release.title !== 'string' || safeKey(release.title, normalizeArtist) === null)
    )
      return 'malformed';
    if (
      release.date !== undefined &&
      (typeof release.date !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(release.date))
    )
      return 'malformed';
    const group = release['release-group'];
    if (group !== undefined && (!group || typeof group !== 'object' || Array.isArray(group))) return 'malformed';
    if (
      group &&
      typeof group === 'object' &&
      (group as Record<string, unknown>).id !== undefined &&
      !validMbid((group as Record<string, unknown>).id)
    )
      return 'malformed';
  }
  if (
    value.isrcs !== undefined &&
    (!Array.isArray(value.isrcs) ||
      value.isrcs.some((isrc) => typeof isrc !== 'string' || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)))
  )
    return 'malformed';
  const titleKey = safeKey(value.title, normalizeTrack);
  if (titleKey === null) return 'malformed';
  if (minScore > 0 && (value.score as number) < minScore) return 'mismatch';
  return titleKey === row.track_key && names.some((c) => safeKey(c.name, normalizeArtist) === row.artist_key)
    ? 'match'
    : 'mismatch';
}

function storeMatch(
  db: Db,
  row: Row,
  recording: Record<string, unknown>,
  matchedBy: string,
  score: number,
  now: number,
  revivalLimit: number,
): number {
  const names = credits(recording['artist-credit']);
  const rel = selectedRelease(Array.isArray(recording.releases) ? recording.releases : [], row.album_key);
  const group = rel?.['release-group'] as Record<string, unknown> | undefined;
  const ids = names.flatMap((c) => (c.mbid ? [c.mbid] : []));
  const firstDate = rel ? dateOf(rel) : null;
  return db.tx(() => {
    db.run(
      `UPDATE mb_tracks SET status='matched',priority=-1,attempts=0,next_attempt_ms=?,last_attempt_ms=?,
    matched_by=?,score=?,recording_mbid=?,title=?,artist_credit=?,artist_mbids=?,release_mbid=?,release_title=?,
    release_group_mbid=?,duration_ms=?,isrcs=?,first_release_date=?,synced_at_ms=?
    WHERE artist_key=? AND track_key=? AND album_key=?`,
      now + 90 * DAY,
      now,
      matchedBy,
      score,
      recording.id as string,
      recording.title as string,
      creditDisplay(recording['artist-credit']),
      JSON.stringify(ids),
      typeof rel?.id === 'string' && /^[0-9a-f-]{36}$/i.test(rel.id) ? rel.id : null,
      typeof rel?.title === 'string' ? rel.title : null,
      typeof group?.id === 'string' ? group.id : null,
      typeof recording.length === 'number' && Number.isFinite(recording.length) ? recording.length : null,
      JSON.stringify(Array.isArray(recording.isrcs) ? recording.isrcs : []),
      firstDate === '9999' ? null : firstDate,
      now,
      row.artist_key,
      row.track_key,
      row.album_key,
    );
    // Cached statistics include their attached IDs; clear them when enrichment changes.
    db.run('DELETE FROM stats_cache');
    const key = { artistKey: row.artist_key, trackKey: row.track_key, albumKey: row.album_key };
    const mbid = recording.id as string;
    stageLoveReviveJob(db, key, mbid, now);
    const releaseMbid = typeof rel?.id === 'string' && validMbid(rel.id) ? rel.id : null;
    const releaseGroupMbid = typeof group?.id === 'string' && validMbid(group.id) ? group.id : null;
    if (releaseMbid) enqueueCoverArt(db, releaseMbid, releaseGroupMbid, now);
    if (revivalLimit <= 0) return 0;
    const slice = enqueueRevivedLoves(db, key, mbid, now, revivalLimit);
    if (slice.complete) deleteLoveReviveJob(db, key);
    else advanceLoveReviveJob(db, key, slice.cursorLinkId);
    return slice.scanned;
  });
}

/** Run a bounded local queue slice. Every request is separately globally paced and persisted before egress. */
export function createMusicBrainzResolver(options: {
  db: Db;
  client: ResolverClient;
  clock: Clock;
  enabled?: boolean;
}) {
  const { db, client, clock } = options;
  function availableAt(): number {
    return (
      db.one<{ available_at_ms: number }>('SELECT available_at_ms FROM mb_pacing WHERE singleton=1')?.available_at_ms ??
      0
    );
  }
  async function run(): Promise<{ requests: number; availableAt: number }> {
    if (options.enabled === false) return { requests: 0, availableAt: availableAt() };
    let requests = 0;
    let localWork = 0;
    const backfill = backfillLoveReviveKeys(db, 100);
    localWork += backfill.scanned;
    if (!backfill.complete || localWork >= 100) return { requests: 0, availableAt: clock.nowMs() + 1 };
    for (const job of loveReviveJobs(db, Math.min(100, 100 - localWork))) {
      if (localWork >= 100) break;
      const remaining = 100 - localWork;
      const slice = enqueueRevivedLoves(db, job, job.recordingMbid, clock.nowMs(), remaining, job.cursorLinkId);
      localWork += slice.scanned;
      if (slice.complete) deleteLoveReviveJob(db, job);
      else advanceLoveReviveJob(db, job, slice.cursorLinkId);
    }
    if (localWork >= 100) return { requests: 0, availableAt: clock.nowMs() + 1 };
    if (loveReviveJobs(db, 1).length > 0) return { requests: 0, availableAt: clock.nowMs() + 1 };
    seedHistoricalTracks(db, clock.nowMs());
    while (requests < MAX_RUN_REQUESTS && localWork < 100) {
      const now = clock.nowMs();
      if (availableAt() > now) break;
      const row = db.one<Row & { matched_by: string | null }>(
        `SELECT artist_key,track_key,album_key,submitted_recording_mbid,status,attempts,priority,next_attempt_ms,last_attempt_ms,matched_by
        FROM mb_tracks WHERE status IN ('pending','matched','unmatched','failed') AND next_attempt_ms<=?
        ORDER BY priority DESC,next_attempt_ms,created_at_ms LIMIT 1`,
        now,
      );
      if (!row) break;
      const pace = (): boolean => {
        const at = clock.nowMs();
        if (availableAt() > at) return false;
        db.run('INSERT OR IGNORE INTO mb_pacing(singleton,available_at_ms) VALUES (1,0)');
        db.run('UPDATE mb_pacing SET available_at_ms=? WHERE singleton=1', at + 1000);
        db.run(
          'UPDATE mb_tracks SET last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?',
          at,
          row.artist_key,
          row.track_key,
          row.album_key,
        );
        requests += 1;
        return true;
      };
      let recording: Record<string, unknown> | null = null;
      let matchedBy = 'search';
      let outcome: MusicBrainzOutcome<Record<string, unknown>> | MusicBrainzOutcome<{ recordings: unknown[] }> | null =
        null;
      const fallbackSearch = row.matched_by === 'lookup_404';
      if (row.submitted_recording_mbid && !fallbackSearch && pace()) {
        outcome = await client.lookupRecording(row.submitted_recording_mbid);
        if (outcome.kind === 'ok') {
          const check = checkRecording(outcome.value, row);
          if (check === 'match') {
            recording = outcome.value;
            matchedBy = 'mbid';
          } else if (check === 'malformed') {
            await retry({ kind: 'malformed' }, row);
            break;
          } else {
            db.run(
              `UPDATE mb_tracks SET matched_by='lookup_404',next_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`,
              clock.nowMs() + 1000,
              row.artist_key,
              row.track_key,
              row.album_key,
            );
            break;
          }
        }
        if (outcome.kind === 'not_found') {
          db.run(
            `UPDATE mb_tracks SET matched_by='lookup_404',next_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`,
            clock.nowMs() + 1000,
            row.artist_key,
            row.track_key,
            row.album_key,
          );
          break;
        }
        if (!recording) {
          await retry(outcome, row);
          break;
        }
      }
      if (!recording) {
        if (!pace()) break;
        outcome = await client.searchRecordings({
          artist: row.artist_key,
          recording: row.track_key,
          ...(row.album_key ? { release: row.album_key } : {}),
          limit: 5,
        });
        if (outcome.kind !== 'ok') {
          await retry(outcome, row);
          break;
        }
        const top = (outcome as { kind: 'ok'; value: { recordings: unknown[] } }).value.recordings[0];
        let candidateCheck: CandidateCheck = 'mismatch';
        if (top && typeof top === 'object' && !Array.isArray(top)) {
          candidateCheck = checkRecording(top as Record<string, unknown>, row, 90);
          if (candidateCheck === 'match') recording = top as Record<string, unknown>;
        }
        if (candidateCheck === 'malformed') {
          await retry({ kind: 'malformed' }, row);
          continue;
        }
        if (recording) {
          const scanned = storeMatch(
            db,
            row,
            recording,
            matchedBy,
            Number(recording.score),
            now,
            Math.max(0, 99 - localWork),
          );
          localWork += 1 + scanned;
        } else
          db.run(
            `UPDATE mb_tracks SET status='unmatched',attempts=0,next_attempt_ms=?,last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`,
            now + 30 * DAY,
            now,
            row.artist_key,
            row.track_key,
            row.album_key,
          );
      } else {
        const scanned = storeMatch(
          db,
          row,
          recording,
          matchedBy,
          Number(recording.score ?? 100),
          now,
          Math.max(0, 99 - localWork),
        );
        localWork += 1 + scanned;
      }
    }
    if (localWork >= 100 || loveReviveJobs(db, 1).length > 0) return { requests, availableAt: clock.nowMs() + 1 };
    return { requests, availableAt: availableAt() };
  }
  async function retry(outcome: MusicBrainzOutcome<unknown>, row: Row): Promise<void> {
    const now = clock.nowMs();
    const attempts = row.attempts + 1;
    const failed = attempts >= 8;
    const retryAfter = outcome.kind === 'status' ? (outcome.retryAfterMs ?? 0) : 0;
    const backoff = Math.min(MAX_BACKOFF, 60_000 * 2 ** Math.min(attempts - 1, 10));
    const delay = failed ? 30 * DAY : Math.max(backoff, retryAfter);
    if (outcome.kind === 'status' && outcome.status === 503 && retryAfter > 0) {
      db.run('INSERT OR IGNORE INTO mb_pacing(singleton,available_at_ms) VALUES (1,0)');
      db.run(
        'UPDATE mb_pacing SET available_at_ms=MAX(available_at_ms,?) WHERE singleton=1',
        clock.nowMs() + retryAfter,
      );
    }
    db.run(
      `UPDATE mb_tracks SET status=?,attempts=?,next_attempt_ms=?,last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`,
      failed ? 'failed' : 'pending',
      attempts,
      now + delay,
      now,
      row.artist_key,
      row.track_key,
      row.album_key,
    );
  }
  return { run, availableAt };
}

export function musicBrainzExtension(resolver: ReturnType<typeof createMusicBrainzResolver>): CoreExtension {
  return {
    name: 'musicbrainz',
    start(ctx, now) {
      ctx.schedule('musicbrainz', now);
    },
    timers: {
      musicbrainz: async (now, ctx) => {
        const result = await resolver.run();
        const due = result.availableAt > now ? result.availableAt : now + 300_000;
        ctx.schedule('musicbrainz', due);
      },
    },
  };
}
