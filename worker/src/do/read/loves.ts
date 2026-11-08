// Loved tracks (ADR 0005 §6.3, §7.9 user.getLovedTracks, track.getInfo
// `userloved`, `extended=1` `loved`, §8.6 get-feedback; N2-06).
//
// - `loves` is the proof-gated love projection (N3-11). Only a visible owner's
//   loves are read (./visibility.ts); an unknown, inactive or suppressed user has
//   no loved-tracks list (null) and loves nothing.
// - Order: newest first by `(created_at DESC, uri DESC)` through
//   loves_owner_time; offset paging with `total` and `totalPages`.
// - Love identity is `(artist_key, track_key)` per DID (§6.3), so `isLoved`
//   matches every spelling variant of a track (loves_owner_track). A name that
//   has no music key is loved by nobody.

import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { LoveRow } from '../../app/rows';
import type { MusicBrainzMatch } from '@atmusic/core/api-types';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../contracts';
import { isVisibleUser, type OffsetPage, offsetOf } from './recent';
import { activeUser } from './visibility';

export interface LovedTracksQuery {
  did: string;
  limit: number;
  /** 1-based page; exclusive with `offset` (default page 1). */
  page?: number;
  offset?: number;
}

export type EnrichedLoveRow = LoveRow & { musicbrainz?: MusicBrainzMatch };
export type LovedTracksPage = OffsetPage<EnrichedLoveRow>;

type LoveMatchRow = LoveRow & {
  mb_recording_mbid?: string | null; mb_title?: string | null; mb_artist_credit?: string | null;
  mb_artist_mbids?: string | null; mb_release_mbid?: string | null; mb_release_title?: string | null;
  mb_release_group_mbid?: string | null; mb_duration_ms?: number | null; mb_matched_by?: string | null;
  mb_synced_at_ms?: number | null;
};

/** The visible-owner join for `loves l`. */
const VISIBLE_LOVES = `loves l JOIN users u ON u.did = l.did AND ${activeUser('u')}`;

export function lovedTracks(m: Pick<ModuleDeps, 'db'>, q: LovedTracksQuery): LovedTracksPage | null {
  if (typeof q.did !== 'string' || q.did === '') throw new RangeError('loved tracks need a DID');
  const { offset, page } = offsetOf(q.limit, q.page, q.offset);
  if (!isVisibleUser(m.db, q.did)) return null;
  const total = m.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${VISIBLE_LOVES} WHERE l.did = ?`, q.did)?.n ?? 0;
  const rows =
    total === 0
      ? []
      : m.db.all<LoveMatchRow>(
          `SELECT l.*, mb.recording_mbid AS mb_recording_mbid, mb.title AS mb_title,
             mb.artist_credit AS mb_artist_credit, mb.artist_mbids AS mb_artist_mbids,
             mb.release_mbid AS mb_release_mbid, mb.release_title AS mb_release_title,
             mb.release_group_mbid AS mb_release_group_mbid, mb.duration_ms AS mb_duration_ms,
             mb.matched_by AS mb_matched_by, mb.synced_at_ms AS mb_synced_at_ms
           FROM ${VISIBLE_LOVES}
           LEFT JOIN mb_tracks mb ON mb.status='matched' AND mb.artist_key=l.artist_key
             AND mb.track_key=l.track_key AND mb.album_key=''
           WHERE l.did = ?
           ORDER BY l.created_at DESC, l.uri DESC LIMIT ? OFFSET ?`,
          q.did,
          q.limit,
          offset,
        );
  return { rows: rows.map(withMusicBrainz), total, totalPages: Math.ceil(total / q.limit), page, perPage: q.limit, offset };
}

function withMusicBrainz(row: LoveMatchRow): EnrichedLoveRow {
  const { mb_recording_mbid: _recording, mb_title: _title, mb_artist_credit: _credit, mb_artist_mbids: _artistMbids,
    mb_release_mbid: _release, mb_release_title: _releaseTitle, mb_release_group_mbid: _group,
    mb_duration_ms: _duration, mb_matched_by: _matchedBy, mb_synced_at_ms: syncedAt, ...love } = row;
  if (!row.mb_recording_mbid || !row.mb_title || !row.mb_artist_credit || !row.mb_matched_by || syncedAt == null) return love;
  let artistMbids: string[];
  try {
    const parsed: unknown = JSON.parse(row.mb_artist_mbids ?? '[]');
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) return love;
    artistMbids = parsed;
  } catch { return love; }
  return {
    ...love,
    musicbrainz: {
      recordingMbid: row.mb_recording_mbid, title: row.mb_title, artistCredit: row.mb_artist_credit,
      artistMbids,
      ...(row.mb_release_mbid == null ? {} : { releaseMbid: row.mb_release_mbid }),
      ...(row.mb_release_title == null ? {} : { releaseTitle: row.mb_release_title }),
      ...(row.mb_release_group_mbid == null ? {} : { releaseGroupMbid: row.mb_release_group_mbid }),
      ...(row.mb_duration_ms == null ? {} : { durationSeconds: Math.round(row.mb_duration_ms / 1000) }),
      matchedBy: row.mb_matched_by as MusicBrainzMatch['matchedBy'],
      syncedAt: toDto(fromMs(syncedAt!)),
    },
  };
}

/** The `(artist_key, track_key)` of display names, or null when they have none. */
function keysOf(artist: string, track: string): readonly [string, string] | null {
  try {
    return trackKey(artist, track);
  } catch (err) {
    if (err instanceof MusicKeyError) return null;
    throw err;
  }
}

/** Whether `did` (a visible user) loves the track `artist`/`track`, in any spelling. */
export function isLoved(m: Pick<ModuleDeps, 'db'>, q: { did: string; artist: string; track: string }): boolean {
  const key = keysOf(q.artist, q.track);
  if (key === null) return false;
  return isLovedKey(m, q.did, key[0], key[1]);
}

/** `isLoved` by stored music keys (`scrobbles.artist_key`, `track_key`). */
export function isLovedKey(m: Pick<ModuleDeps, 'db'>, did: string, artistKey: string, trackKey_: string): boolean {
  return (
    m.db.one<{ ok: number }>(
      `SELECT 1 AS ok FROM ${VISIBLE_LOVES} WHERE l.did = ? AND l.artist_key = ? AND l.track_key = ? LIMIT 1`,
      did,
      artistKey,
      trackKey_,
    ) !== null
  );
}

/** An injective id of a `(artist_key, track_key)` pair (keys never hold U+0000). */
export function loveKeyId(artistKey: string, trackKey_: string): string {
  return JSON.stringify([artistKey, trackKey_]);
}

/**
 * Which of `keys` the visible user `did` loves, as `loveKeyId` values: one
 * statement for a page of recent tracks (`extended=1`).
 */
export function lovedKeyIds(
  m: Pick<ModuleDeps, 'db'>,
  did: string,
  keys: ReadonlyArray<{ artistKey: string; trackKey: string }>,
): Set<string> {
  if (keys.length === 0) return new Set();
  const pairs = JSON.stringify(keys.map((k) => [k.artistKey, k.trackKey]));
  const rows = m.db.all<{ artist_key: string; track_key: string }>(
    `SELECT DISTINCT l.artist_key AS artist_key, l.track_key AS track_key FROM ${VISIBLE_LOVES}
     JOIN (SELECT json_extract(value, '$[0]') AS a, json_extract(value, '$[1]') AS t FROM json_each(?)) k
       ON l.artist_key = k.a AND l.track_key = k.t
     WHERE l.did = ?`,
    pairs,
    did,
  );
  return new Set(rows.map((r) => loveKeyId(r.artist_key, r.track_key)));
}
