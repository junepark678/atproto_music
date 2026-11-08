// The now-playing store (ADR 0005 §7.8 track.updateNowPlaying, §8.3
// playing_now, §8.4 playing-now, §8.6 playing-now/delete; N2-06).
//
// - One `now_playing` row per DID; ephemeral local state, never a PDS record.
// - Durations: a given duration is a finite positive number of seconds, rounded
//   half-up to whole seconds with a minimum of 1 (the §7.6 rule, so a
//   ListenBrainz `duration_ms` of 215,347 passed as 215.347 s counts as 215 s).
//   Anything else (absent, null, 0, negative, NaN) means "no duration"; an
//   infinite value or one that would overflow the expiry is a RangeError.
// - Expiry: `started + duration` when the duration is usable, otherwise
//   `started + 600 s`. Usable means 30–5,400 s for the Last.fm API and the web
//   form (§7.8), and any duration at all for ListenBrainz ("the TTL is
//   `duration`, else `duration_ms`/1000, else 600 s", §8.3). The column CHECK
//   (1–86,400 s) limits only what is stored in `duration_seconds`, never the
//   TTL: a longer duration is used for the expiry and stored as NULL. An entry
//   is current while `now < expires_at_ms`.
// - The same track (equal music keys, so spelling variants count) while the
//   entry is still current is not a new entry: `refresh` (Last.fm, §7.8) keeps
//   the row and its `started_at_ms` and moves the expiry to `now + ttl` and
//   `duration_seconds` to the new submission's duration, so the stored
//   duration is always the basis of the stored expiry; `keep` (ListenBrainz
//   "an identical current track is ignored") changes nothing.
//   Anything else replaces the row, starting now.
// - Reads (`currentNowPlaying`) show an entry only when it is current, its
//   owner is a visible user, and the owner's account shares now playing
//   (`accounts.share_now_playing = 1`, the default). Without an account row
//   nothing is shown. `ownNowPlaying` ignores the share flag (the owner's own
//   data: playing-now/delete, the feedback MSID lookup).
// - `clearNowPlaying` follows ListenBrainz's order: no current entry →
//   `already_cleared`; a stored client that is set and differs from the given
//   one → `client_mismatch`; otherwise the row is deleted → `cleared`.
// - Expired rows are deleted by `deleteExpiredNowPlaying` (the expiry-sweep
//   timer, §3.3); reads never depend on that sweep.

import { artistKey, trackKey } from '@atmusic/core/music-key';
import type { NowPlayingRow, NowPlayingSource } from '../../app/rows';
import type { ModuleDeps } from '../contracts';
import { NOW_PLAYING_SOURCES } from '../schema';
import { activeUser } from './visibility';

export const NOW_PLAYING_DEFAULT_TTL_SECONDS = 600;
/** Last.fm durations outside this range fall back to the default TTL (§7.8). */
export const LASTFM_MIN_DURATION_SECONDS = 30;
export const LASTFM_MAX_DURATION_SECONDS = 5400;
/** The `now_playing.duration_seconds` column CHECK. */
export const MAX_STORED_DURATION_SECONDS = 86_400;

export interface NowPlayingInput {
  did: string;
  artist: string;
  track: string;
  album?: string | null;
  albumArtist?: string | null;
  durationSeconds?: number | null;
  recordingMbid?: string | null;
  trackNumber?: number | null;
  releaseMbid?: string | null;
  releaseGroupMbid?: string | null;
  artistMbids?: readonly string[] | null;
  isrc?: string | null;
  submissionClientVersion?: string | null;
  musicService?: string | null;
  mediaPlayer?: string | null;
  /** Submitting client (ListenBrainz `submission_client`, Last.fm session client). */
  client?: string | null;
  source: NowPlayingSource;
  /** Retained for caller compatibility; same-track submissions always refresh. */
  sameTrack?: 'refresh' | 'keep';
}

export type NowPlayingOutcome = 'stored' | 'refreshed' | 'unchanged';

export interface NowPlayingResult {
  outcome: NowPlayingOutcome;
  row: NowPlayingRow;
}

/** A submitted duration in whole seconds (half-up, minimum 1), or null when there is none. */
function wholeSeconds(d: number | null | undefined): number | null {
  if (typeof d !== 'number' || Number.isNaN(d) || d <= 0) return null;
  if (!Number.isFinite(d)) throw new RangeError('now-playing duration must be finite');
  return Math.max(1, Math.round(d));
}

/** What `duration_seconds` stores: the whole-second duration when it fits the column CHECK. */
function storedDuration(d: number | null | undefined): number | null {
  const s = wholeSeconds(d);
  return s !== null && s <= MAX_STORED_DURATION_SECONDS ? s : null;
}

/** The entry's lifetime in seconds for a submission from `source`. */
export function nowPlayingTtlSeconds(source: NowPlayingSource, durationSeconds: number | null | undefined): number {
  const d = wholeSeconds(durationSeconds);
  if (d === null) return NOW_PLAYING_DEFAULT_TTL_SECONDS;
  if (source === 'listenbrainz') return d;
  return d >= LASTFM_MIN_DURATION_SECONDS && d <= LASTFM_MAX_DURATION_SECONDS ? d : NOW_PLAYING_DEFAULT_TTL_SECONDS;
}

function sameTrack(row: NowPlayingRow, artist: string, track: string): boolean {
  if (artistKey(row.artist) !== artistKey(artist)) return false;
  return trackKey(row.artist, row.track)[1] === trackKey(artist, track)[1];
}

/** Upsert the DID's now-playing entry (see the module comment). Throws MusicKeyError for invalid names. */
export function upsertNowPlaying(m: Pick<ModuleDeps, 'db' | 'clock'>, input: NowPlayingInput): NowPlayingResult {
  if (typeof input.did !== 'string' || input.did === '') throw new RangeError('now playing needs a DID');
  if (!(NOW_PLAYING_SOURCES as readonly string[]).includes(input.source)) {
    throw new RangeError(`unknown now-playing source ${String(input.source)}`);
  }
  // Validates both names before anything is read or written.
  trackKey(input.artist, input.track);
  const db = m.db;
  const now = m.clock.nowMs();
  const ttlMs = nowPlayingTtlSeconds(input.source, input.durationSeconds) * 1000;
  if (!Number.isSafeInteger(now + ttlMs)) throw new RangeError('now-playing duration overflows the expiry');
  const durationSeconds = storedDuration(input.durationSeconds);
  return db.tx(() => {
    const existing = db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', input.did);
    if (existing !== null && existing.expires_at_ms > now && sameTrack(existing, input.artist, input.track)) {
      const expires = now + ttlMs;
      const merge = <T>(incoming: T | null | undefined, previous: T | null): T | null => incoming ?? previous;
      const fields = {
        album: merge(input.album, existing.album), album_artist: merge(input.albumArtist, existing.album_artist),
        duration_seconds: merge(input.durationSeconds === undefined ? undefined : durationSeconds, existing.duration_seconds), recording_mbid: merge(input.recordingMbid, existing.recording_mbid),
        client: merge(input.client, existing.client), track_number: merge(input.trackNumber, existing.track_number),
        release_mbid: merge(input.releaseMbid, existing.release_mbid), release_group_mbid: merge(input.releaseGroupMbid, existing.release_group_mbid),
        artist_mbids: merge(input.artistMbids ? JSON.stringify(input.artistMbids) : undefined, existing.artist_mbids),
        isrc: merge(input.isrc, existing.isrc), submission_client_version: merge(input.submissionClientVersion, existing.submission_client_version),
        music_service: merge(input.musicService, existing.music_service), media_player: merge(input.mediaPlayer, existing.media_player),
      };
      db.run(
        `UPDATE now_playing SET album=?, album_artist=?, duration_seconds=?, recording_mbid=?, client=?, track_number=?, release_mbid=?,
         release_group_mbid=?, artist_mbids=?, isrc=?, submission_client_version=?, music_service=?, media_player=?, updated_at_ms=?, expires_at_ms=? WHERE did=?`,
        fields.album, fields.album_artist, fields.duration_seconds, fields.recording_mbid, fields.client, fields.track_number,
        fields.release_mbid, fields.release_group_mbid, fields.artist_mbids, fields.isrc, fields.submission_client_version,
        fields.music_service, fields.media_player, now,
        expires,
        input.did,
      );
      return {
        outcome: 'refreshed' as const,
        row: { ...existing, ...fields, updated_at_ms: now, expires_at_ms: expires },
      };
    }
    const row: NowPlayingRow = {
      did: input.did,
      artist: input.artist,
      track: input.track,
      album: input.album ?? null,
      album_artist: input.albumArtist ?? null,
      duration_seconds: durationSeconds,
      recording_mbid: input.recordingMbid ?? null,
      client: input.client ?? null,
      source: input.source,
      started_at_ms: now,
      expires_at_ms: now + ttlMs,
      updated_at_ms: now,
      track_number: input.trackNumber ?? null,
      release_mbid: input.releaseMbid ?? null,
      release_group_mbid: input.releaseGroupMbid ?? null,
      artist_mbids: input.artistMbids ? JSON.stringify(input.artistMbids) : null,
      isrc: input.isrc ?? null,
      submission_client_version: input.submissionClientVersion ?? null,
      music_service: input.musicService ?? null,
      media_player: input.mediaPlayer ?? null,
      scrobbled_at_ms: null,
    };
    db.run(
      `INSERT INTO now_playing(did, artist, track, album, album_artist, duration_seconds, recording_mbid, client,
         source, started_at_ms, expires_at_ms, updated_at_ms, track_number, release_mbid, release_group_mbid, artist_mbids, isrc,
         submission_client_version, music_service, media_player, scrobbled_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(did) DO UPDATE SET artist = excluded.artist, track = excluded.track, album = excluded.album,
         album_artist = excluded.album_artist, duration_seconds = excluded.duration_seconds,
         recording_mbid = excluded.recording_mbid, client = excluded.client, source = excluded.source,
         started_at_ms = excluded.started_at_ms, expires_at_ms = excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms,
         track_number=excluded.track_number, release_mbid=excluded.release_mbid, release_group_mbid=excluded.release_group_mbid,
         artist_mbids=excluded.artist_mbids, isrc=excluded.isrc, submission_client_version=excluded.submission_client_version,
         music_service=excluded.music_service, media_player=excluded.media_player, scrobbled_at_ms=NULL`,
      row.did,
      row.artist,
      row.track,
      row.album,
      row.album_artist,
      row.duration_seconds,
      row.recording_mbid,
      row.client,
      row.source,
      row.started_at_ms,
      row.expires_at_ms,
      row.updated_at_ms, row.track_number, row.release_mbid, row.release_group_mbid, row.artist_mbids, row.isrc,
      row.submission_client_version, row.music_service, row.media_player, row.scrobbled_at_ms,
    );
    return { outcome: 'stored' as const, row };
  });
}

/** The current entry as other people may see it: visible owner, shared, not expired. */
export function currentNowPlaying(m: Pick<ModuleDeps, 'db' | 'clock'>, did: string): NowPlayingRow | null {
  return m.db.one<NowPlayingRow>(
    `SELECT n.* FROM now_playing n
     JOIN accounts a ON a.did = n.did AND a.share_now_playing = 1
     JOIN users u ON u.did = n.did AND ${activeUser('u')}
     WHERE n.did = ? AND n.expires_at_ms > ?`,
    did,
    m.clock.nowMs(),
  );
}

/** The owner's own current entry, regardless of the share flag. */
export function ownNowPlaying(m: Pick<ModuleDeps, 'db' | 'clock'>, did: string): NowPlayingRow | null {
  return m.db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ? AND expires_at_ms > ?', did, m.clock.nowMs());
}

export type ClearNowPlayingOutcome = 'already_cleared' | 'client_mismatch' | 'cleared';

/** POST /1/playing-now/delete semantics (§8.6). */
export function clearNowPlaying(
  m: Pick<ModuleDeps, 'db' | 'clock'>,
  did: string,
  client?: string | null,
): ClearNowPlayingOutcome {
  const db = m.db;
  return db.tx(() => {
    const row = ownNowPlaying(m, did);
    if (row === null) return 'already_cleared';
    if (row.client !== null && row.client !== (client ?? null)) return 'client_mismatch';
    db.run('DELETE FROM now_playing WHERE did = ?', did);
    return 'cleared';
  });
}

/** Deletes every expired entry; returns how many were removed. */
export function deleteExpiredNowPlaying(m: Pick<ModuleDeps, 'db' | 'clock'>): number {
  return m.db.all<{ did: string }>('DELETE FROM now_playing WHERE expires_at_ms <= ? RETURNING did', m.clock.nowMs())
    .length;
}
