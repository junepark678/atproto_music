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
// for nowplaying. `dedupe_key` is unique per (link_id, kind, dedupe_key) and
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
import { trackKey } from '@atmusic/core/music-key';
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
  now: number;
  /** Ids for new rows (the injected randomness). */
  random: Random;
}

/**
 * Queues one row per (item, active link with the matching flag); an existing
 * (link, kind, dedupe_key) is left alone. Returns the number of rows created.
 * Runs inside the caller's transaction (or as its own).
 */
export function enqueueForwards(db: Db, args: EnqueueForwardsArgs): number {
  if (args.items.length === 0) return 0;
  return db.tx(() => {
    const links = db.all<{ id: string; forward_scrobbles: number; forward_now_playing: number }>(
      `SELECT id, forward_scrobbles, forward_now_playing FROM linked_accounts
       WHERE did = ? AND status = 'active' ORDER BY created_at_ms, id`,
      args.did,
    );
    let created = 0;
    for (const item of args.items) {
      const key = dedupeKey(args.did, item);
      const payload = JSON.stringify(item.payload ?? null);
      for (const link of links) {
        if (link[flagColumn(item.kind)] !== 1) continue;
        created += db.run(
          `INSERT INTO forward_outbox(id, link_id, did, kind, dedupe_key, payload_json, state, attempts, due_at,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
           ON CONFLICT(link_id, kind, dedupe_key) DO NOTHING`,
          newOperationId(args.random),
          link.id,
          args.did,
          item.kind,
          key,
          payload,
          args.now,
          args.now,
          args.now,
        ).rowsWritten;
      }
    }
    return created;
  });
}
