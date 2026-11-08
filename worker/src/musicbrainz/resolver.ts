import type { Clock } from '@atmusic/core/deps';
import { artistKey as normalizeArtist, artistKey as normalizeTrack } from '@atmusic/core/music-key';
import type { Db } from '../do/db';
import type { MusicBrainzOutcome } from './client';
import type { TrackKey } from './store';
import { musicKeyId } from '@atmusic/core/music-key';

const DAY = 86_400_000;
const MAX_RUN_REQUESTS = 3;
const MAX_BACKOFF = DAY;

export interface ResolverClient {
  lookupRecording(mbid: string): Promise<MusicBrainzOutcome<Record<string, unknown>>>;
  searchRecordings(args: { artist: string; recording: string; release?: string; limit: number }): Promise<MusicBrainzOutcome<{ recordings: unknown[] }>>;
}

interface Row extends TrackKey {
  artist_key: string; track_key: string; album_key: string; submitted_recording_mbid: string | null;
  status: string; attempts: number; priority: number; next_attempt_ms: number; last_attempt_ms: number | null;
  matched_by: string | null;
}

function credits(value: unknown): Array<{ name: string; mbid: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const artist = (e.artist && typeof e.artist === 'object' ? e.artist : e) as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : artist.name;
    return typeof name === 'string' ? [{ name, mbid: typeof artist.id === 'string' && /^[0-9a-f-]{36}$/i.test(artist.id) ? artist.id : null }] : [];
  });
}
function creditDisplay(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const entry = part as Record<string, unknown>;
    const artist = (entry.artist && typeof entry.artist === 'object' ? entry.artist : entry) as Record<string, unknown>;
    return `${typeof entry.name === 'string' ? entry.name : typeof artist.name === 'string' ? artist.name : ''}${typeof entry.joinphrase === 'string' ? entry.joinphrase : ''}`;
  }).join('');
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
  const exact = items.find((x) => typeof x.title === 'string' && musicKeyId([normalizeArtist(x.title), '']) === musicKeyId([albumKey, '']));
  if (exact) return exact;
  const inAlbumGroup = items.filter((x) => official(x) && (x['release-group'] as Record<string, unknown> | undefined)?.['primary-type'] === 'Album');
  const candidates = inAlbumGroup.length ? inAlbumGroup : items.filter(official);
  return candidates.sort((a, b) => dateOf(a).localeCompare(dateOf(b)))[0] ?? null;
}

function validRecording(value: Record<string, unknown>, row: Row, minScore = 0): boolean {
  const names = credits(value['artist-credit']);
  return typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.title === 'string' &&
    (minScore === 0 || (typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= minScore)) && normalizeTrack(value.title) === row.track_key &&
    names.some((c) => normalizeArtist(c.name) === row.artist_key);
}

function storeMatch(db: Db, row: Row, recording: Record<string, unknown>, matchedBy: string, score: number, now: number): void {
  const names = credits(recording['artist-credit']);
  const rel = selectedRelease(Array.isArray(recording.releases) ? recording.releases : [], row.album_key);
  const group = rel?.['release-group'] as Record<string, unknown> | undefined;
  const ids = names.flatMap((c) => c.mbid ? [c.mbid] : []);
  const firstDate = rel ? dateOf(rel) : null;
  db.run(`UPDATE mb_tracks SET status='matched',priority=-1,attempts=0,next_attempt_ms=?,last_attempt_ms=?,
    matched_by=?,score=?,recording_mbid=?,title=?,artist_credit=?,artist_mbids=?,release_mbid=?,release_title=?,
    release_group_mbid=?,duration_ms=?,isrcs=?,first_release_date=?,synced_at_ms=?
    WHERE artist_key=? AND track_key=? AND album_key=?`,
  now + 90 * DAY, now, matchedBy, score, recording.id as string, recording.title as string,
  creditDisplay(recording['artist-credit']), JSON.stringify(ids), typeof rel?.id === 'string' && /^[0-9a-f-]{36}$/i.test(rel.id) ? rel.id : null, typeof rel?.title === 'string' ? rel.title : null,
  typeof group?.id === 'string' ? group.id : null, typeof recording.length === 'number' && Number.isFinite(recording.length) ? recording.length : null,
  JSON.stringify(Array.isArray(recording.isrcs) ? recording.isrcs : []), firstDate === '9999' ? null : firstDate, now,
  row.artist_key, row.track_key, row.album_key);
}

/** Run a bounded local queue slice. Every request is separately globally paced and persisted before egress. */
export function createMusicBrainzResolver(options: { db: Db; client: ResolverClient; clock: Clock; enabled?: boolean }) {
  const { db, client, clock } = options;
  function availableAt(): number { return db.one<{ available_at_ms: number }>('SELECT available_at_ms FROM mb_pacing WHERE singleton=1')?.available_at_ms ?? 0; }
  async function run(): Promise<{ requests: number; availableAt: number }> {
    if (options.enabled === false) return { requests: 0, availableAt: availableAt() };
    let requests = 0;
    while (requests < MAX_RUN_REQUESTS) {
      const now = clock.nowMs();
      if (availableAt() > now) break;
      const row = db.one<Row & { matched_by: string | null }>(`SELECT artist_key,track_key,album_key,submitted_recording_mbid,status,attempts,priority,next_attempt_ms,last_attempt_ms,matched_by
        FROM mb_tracks WHERE status IN ('pending','matched','unmatched','failed') AND next_attempt_ms<=?
        ORDER BY priority DESC,next_attempt_ms,created_at_ms LIMIT 1`, now);
      if (!row) break;
      const pace = (): boolean => {
        const at = clock.nowMs();
        if (availableAt() > at) return false;
        db.run('INSERT OR IGNORE INTO mb_pacing(singleton,available_at_ms) VALUES (1,0)');
        db.run('UPDATE mb_pacing SET available_at_ms=? WHERE singleton=1', at + 1000);
        db.run('UPDATE mb_tracks SET last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?', at, row.artist_key, row.track_key, row.album_key);
        requests += 1; return true;
      };
      let recording: Record<string, unknown> | null = null;
      let matchedBy = 'search';
      let outcome: MusicBrainzOutcome<Record<string, unknown>> | MusicBrainzOutcome<{ recordings: unknown[] }> | null = null;
      const fallbackSearch = row.matched_by === 'lookup_404';
      if (row.submitted_recording_mbid && !fallbackSearch && pace()) {
        outcome = await client.lookupRecording(row.submitted_recording_mbid);
        if (outcome.kind === 'ok' && validRecording(outcome.value, row)) { recording = outcome.value; matchedBy = 'mbid'; }
        if (outcome.kind === 'not_found') {
          db.run(`UPDATE mb_tracks SET matched_by='lookup_404',next_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`, clock.nowMs() + 1000, row.artist_key,row.track_key,row.album_key);
          break;
        }
        if (!recording) { await retry(outcome, row, now); break; }
      }
      if (!recording) {
        if (!pace()) break;
        outcome = await client.searchRecordings({ artist: row.artist_key, recording: row.track_key, ...(row.album_key ? { release: row.album_key } : {}), limit: 5 });
        if (outcome.kind !== 'ok') { await retry(outcome, row, now); break; }
        const top = (outcome as { kind: 'ok'; value: { recordings: unknown[] } }).value.recordings[0];
        if (top && typeof top === 'object' && validRecording(top as Record<string, unknown>, row, 90)) recording = top as Record<string, unknown>;
        if (recording) storeMatch(db, row, recording, matchedBy, Number(recording.score), now);
        else db.run(`UPDATE mb_tracks SET status='unmatched',attempts=0,next_attempt_ms=?,last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`, now + 30*DAY, now, row.artist_key,row.track_key,row.album_key);
      } else storeMatch(db, row, recording, matchedBy, Number(recording.score ?? 100), now);
    }
    return { requests, availableAt: availableAt() };
  }
  async function retry(outcome: MusicBrainzOutcome<unknown>, row: Row, now: number): Promise<void> {
    const attempts = row.attempts + 1;
    const failed = attempts >= 8;
    const retryAfter = outcome.kind === 'status' ? outcome.retryAfterMs ?? 0 : 0;
    const backoff = Math.min(MAX_BACKOFF, 60_000 * 2 ** Math.min(attempts - 1, 10));
    const delay = failed ? 30*DAY : Math.max(backoff, retryAfter);
    if (outcome.kind === 'status' && outcome.status === 503 && retryAfter > 0) {
      db.run('INSERT OR IGNORE INTO mb_pacing(singleton,available_at_ms) VALUES (1,0)');
      db.run('UPDATE mb_pacing SET available_at_ms=MAX(available_at_ms,?) WHERE singleton=1', now + retryAfter);
    }
    db.run(`UPDATE mb_tracks SET status=?,attempts=?,next_attempt_ms=?,last_attempt_ms=? WHERE artist_key=? AND track_key=? AND album_key=?`, failed ? 'failed' : 'pending', attempts, now+delay, now, row.artist_key,row.track_key,row.album_key);
  }
  return { run, availableAt };
}
