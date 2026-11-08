// GET /api/v1/users/{did}/profile (API.md `Profile`, ADR 0004 §5.8,
// docs/profiles.md; crates/server/src/http/profile.rs).
//
// - The path DID must be a syntactic DID: otherwise 422 `fields.did`, with no
//   IndexDO call.
// - One RPC, IndexRpc.profile. It returns null for an unknown, inactive or
//   suppressed user, which is 404 `not_found`; the DO decides that before any
//   identity request.
// - 200 is the eight-field Profile. `Cache-Control: no-store` is forced, so a
//   confirmed listen, deletion or deactivation shows on the next read.

import type { NowPlaying } from '@atmusic/core/api-types';
import { isDid } from '@atmusic/core/syntax';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { EnrichedNowPlayingRow } from '../app/rows';
import { requireSession, withSessionCookie } from '../bff/guard';
import { errorResponse, toErrorResponse } from './error';
import { noStoreJson } from './json';
import type { webWrites } from './operations';
import { invalidField } from './params';
import type { RequestCtx, RouteDef } from './types';

export const PROFILE_PATTERN = '/api/v1/users/{did}/profile';
export const NOW_PLAYING_PATTERN = '/api/v1/users/{did}/now-playing';

export function nowPlayingDto(row: EnrichedNowPlayingRow, shared?: boolean): NowPlaying {
  const dto: NowPlaying = {
    artist: row.artist,
    track: row.track,
    startedAt: toDto(fromMs(row.started_at_ms)),
    updatedAt: toDto(fromMs(row.updated_at_ms ?? row.started_at_ms)),
    expiresAt: toDto(fromMs(row.expires_at_ms)),
    source: row.source,
  };
  if (row.album !== null) dto.album = row.album;
  if (row.album_artist !== null) dto.albumArtist = row.album_artist;
  if (row.track_number !== null) dto.trackNumber = row.track_number;
  if (row.duration_seconds !== null) dto.durationSeconds = row.duration_seconds;
  if (row.recording_mbid !== null) dto.recordingMbid = row.recording_mbid;
  if (row.release_mbid !== null) dto.releaseMbid = row.release_mbid;
  if (row.release_group_mbid !== null) dto.releaseGroupMbid = row.release_group_mbid;
  if (row.artist_mbids !== null) dto.artistMbids = JSON.parse(row.artist_mbids) as string[];
  if (row.isrc !== null) dto.isrc = row.isrc;
  if (row.scrobbled_at_ms !== null) dto.scrobbledAt = toDto(fromMs(row.scrobbled_at_ms));
  if (row.client !== null)
    dto.client = {
      name: row.client,
      ...(row.submission_client_version !== null ? { version: row.submission_client_version } : {}),
    };
  if (row.music_service !== null) dto.musicService = row.music_service;
  if (row.media_player !== null) dto.mediaPlayer = row.media_player;
  if (row.musicbrainz !== undefined) dto.musicbrainz = row.musicbrainz;
  if (shared !== undefined) dto.shared = shared;
  return dto;
}

export async function getNowPlaying(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = didParam(params);
    let owner = false;
    let admittedSession: import('../bff/sessions').WebSession | null = null;
    const cookie = req.headers.get('cookie');
    const service =
      cookie !== null && ctx.app !== undefined
        ? (ctx.app as Partial<{ webWrites: ReturnType<typeof webWrites> }>).webWrites
        : undefined;
    if (cookie !== null && service !== undefined) {
      const services = service;
      const guard = requireSession(req, {
        requestId: ctx.requestId,
        sessions: services.sessions,
        publicOrigin: services.publicOrigin,
        csrfKey: services.csrfKey,
      });
      if (guard.ok) {
        admittedSession = guard.session;
        owner = guard.session.did === did;
      }
    }
    const row = await ctx.index.nowPlaying(did, owner);
    const shared = owner && row !== null ? (await ctx.index.nowPlaying(did, false)) !== null : undefined;
    const response = noStoreJson({
      nowPlaying: row === null ? null : nowPlayingDto(row, shared),
      serverTime: toDto(fromMs(ctx.clock.nowMs())),
    });
    return admittedSession === null ? response : withSessionCookie(response, admittedSession);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

/**
 * The `{did}` path segment as a DID, or 422 `fields.did`. A router that hands
 * over the raw segment may leave `:` percent-encoded; it is decoded once only
 * when the raw value is not already a DID (a DID may itself contain `%XX`).
 */
export function didParam(params: Record<string, string>): string {
  const raw = params.did;
  if (typeof raw === 'string' && isDid(raw)) return raw;
  if (typeof raw === 'string' && raw.includes('%')) {
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = null;
    }
    if (decoded !== null && isDid(decoded)) return decoded;
  }
  throw invalidField('did', 'Expected a DID.');
}

export async function getProfile(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  try {
    const did = didParam(params);
    const profile = await ctx.index.profile(did);
    if (profile === null) return errorResponse('not_found', undefined, ctx.requestId);
    return noStoreJson(profile, 200);
  } catch (error) {
    return toErrorResponse(error, ctx.requestId);
  }
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: PROFILE_PATTERN, handler: getProfile },
  { method: 'GET', pattern: NOW_PLAYING_PATTERN, handler: getNowPlaying },
];
