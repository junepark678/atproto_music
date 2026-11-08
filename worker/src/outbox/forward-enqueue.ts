// Forward rows for linked accounts (ADR 0005 §12.2; N2-05). N3-08 delivers
// them; this module only queues them, inside the caller's acceptance
// transaction, so forwarding never waits for the PDS write.
//
// Forwarded: scrobbles, now playing and love/unlove received through our
// server (the Last.fm and ListenBrainz APIs and the web form). Never
// forwarded: imports, records other apps wrote, deletes.
//
// One row per active link of the DID whose flag allows the kind:
// `forward_scrobbles` for scrobble, love and unlove, `forward_now_playing`
// for nowplaying. `dedupe_key` is unique per (link_id, generation, kind, dedupe_key) and
// is defined per kind (ADR §12.2):
//
// | kind               | dedupe_key                                             |
// |--------------------|--------------------------------------------------------|
// | scrobble           | the listen key (§7.7): a client resend never re-forwards|
// | nowplaying         | nowPlayingKey(did, started_at_ms, artist, track)       |
// | love, unlove       | the love.put / love.delete operation id                |
//
// so a same-track now-playing refresh (which keeps `started_at_ms`) gives no
// new row, the same track playing again later does, and love, unlove, love
// gives three rows in order.
//
// nowPlayingKey = lowercase hex SHA-256 over "atmusic:nowplaying-key:v1" ‖
// field(did) ‖ field(started_at_ms, decimal) ‖ field(artist_key) ‖
// field(normalized track), with field(x) = 4-byte big-endian UTF-8 length ‖
// bytes, like the listen key (packages/core/src/listen-key.ts) but over ms
// and under its own domain tag. Synchronous (node:crypto), so it runs inside
// the transaction.
//
// Payloads (payload_json), read by the forward clients (N3-08):
// - scrobble:   {listen: <the accepted input, uncorrected>, origin}
// - nowplaying: {track: <the now-playing fields>, startedAtMs, origin}
// - love/unlove: {artist, track, album?, recordingMbid?, origin}

import { createHash } from 'node:crypto';
import type { Random } from '@atmusic/core/deps';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { ForwardKind } from '../app/rows';
import type { Db } from '../do/db';
import { newOperationId } from './operations';

export const NOW_PLAYING_KEY_DOMAIN = 'atmusic:nowplaying-key:v1';

function framed(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** The nowplaying dedupe key (see the header). Throws MusicKeyError for an invalid artist or track. */
export function nowPlayingKey(did: string, startedAtMs: number, artist: string, track: string): string {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new RangeError('startedAtMs must be epoch ms');
  const [a, t] = trackKey(artist, track);
  return createHash('sha256')
    .update(NOW_PLAYING_KEY_DOMAIN, 'utf8')
    .update(framed([did, String(startedAtMs), a, t]))
    .digest('hex');
}

export type ForwardItem =
  | { kind: 'scrobble'; listenKey: string; payload: unknown }
  | { kind: 'nowplaying'; startedAtMs: number; artist: string; track: string; payload: unknown }
  | { kind: 'love' | 'unlove'; operationId: string; payload: unknown };

function dedupeKey(did: string, item: ForwardItem): string {
  switch (item.kind) {
    case 'scrobble':
      return item.listenKey;
    case 'nowplaying':
      return nowPlayingKey(did, item.startedAtMs, item.artist, item.track);
    default:
      return item.operationId;
  }
}

function flagColumn(kind: ForwardKind): 'forward_scrobbles' | 'forward_now_playing' {
  return kind === 'nowplaying' ? 'forward_now_playing' : 'forward_scrobbles';
}

export interface EnqueueForwardsArgs {
  did: string;
  items: readonly ForwardItem[];
  /** Excludes the known import source without changing the account's link settings. */
  excludeSourceService?: 'lastfm' | 'listenbrainz';
  /** Excludes every known source bound to one love incarnation. */
  excludeSourceServices?: readonly ('lastfm' | 'listenbrainz')[];
  /** Earliest delivery time (epoch ms); defaults to receipt time. */
  dueAt?: number;
  now: number;
  /** Ids for new rows (the injected randomness). */
  random: Random;
}

/**
 * Queues one row per (item, active link generation with the matching flag); an existing
 * (link, generation, kind, dedupe_key) is left alone. Returns the number of rows created.
 * Runs inside the caller's transaction (or as its own).
 */
export function enqueueForwards(db: Db, args: EnqueueForwardsArgs): number {
  if (args.items.length === 0) return 0;
  const dueAt = args.dueAt ?? args.now;
  if (!Number.isSafeInteger(dueAt) || dueAt < 0) {
    throw new RangeError('dueAt must be a non-negative safe integer of epoch ms');
  }
  return db.tx(() => {
    const links = db.all<{
      id: string;
      generation: number;
      service: 'lastfm' | 'listenbrainz';
      forward_scrobbles: number;
      forward_now_playing: number;
    }>(
      `SELECT id,generation,service,forward_scrobbles,forward_now_playing FROM linked_accounts
       WHERE did = ? AND status = 'active' ORDER BY created_at_ms, id`,
      args.did,
    );
    let created = 0;
    for (const item of args.items) {
      const key = dedupeKey(args.did, item);
      const payload = JSON.stringify(item.payload ?? null);
      let loveArtistKey: string | null = null;
      let loveTrackKey: string | null = null;
      if (
        (item.kind === 'love' || item.kind === 'unlove') &&
        item.payload !== null &&
        typeof item.payload === 'object'
      ) {
        const body = item.payload as Record<string, unknown>;
        if (typeof body.artist === 'string' && typeof body.track === 'string') {
          try {
            [loveArtistKey, loveTrackKey] = trackKey(body.artist, body.track);
          } catch (error) {
            if (!(error instanceof MusicKeyError)) throw error;
          }
        }
      }
      for (const link of links) {
        if (
          (args.excludeSourceService !== undefined && link.service === args.excludeSourceService) ||
          args.excludeSourceServices?.includes(link.service) === true
        )
          continue;
        if (link[flagColumn(item.kind)] !== 1) continue;
        const id = newOperationId(args.random);
        const inserted = db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
             created_at_ms, updated_at_ms, love_artist_key, love_track_key)
           VALUES (?,?,?,?,?,?,?,'queued',0,?,?,?,?,?)
           ON CONFLICT(link_id,generation,kind,dedupe_key) DO NOTHING`,
          id,
          link.id,
          link.generation,
          args.did,
          item.kind,
          key,
          payload,
          dueAt,
          args.now,
          args.now,
          loveArtistKey,
          loveTrackKey,
        ).rowsWritten;
        created += inserted;
        if (inserted === 1 && loveArtistKey !== null && loveTrackKey !== null) {
          const row = db.one<{ rowid: number }>('SELECT rowid FROM forward_outbox WHERE id=?', id);
          if (row) {
            db.run(
              `INSERT INTO mb_forward_love_current(link_id,love_artist_key,love_track_key,forward_rowid) VALUES(?,?,?,?)
               ON CONFLICT(link_id,love_artist_key,love_track_key) DO UPDATE SET forward_rowid=excluded.forward_rowid
               WHERE excluded.forward_rowid>mb_forward_love_current.forward_rowid`,
              link.id,
              loveArtistKey,
              loveTrackKey,
              row.rowid,
            );
          }
        }
      }
    }
    return created;
  });
}
