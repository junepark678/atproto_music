import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { Db } from '../do/db';
import { hasUnknownListenSecond } from '../outbox/listen-second-receipts';
import { isListenTombstoned, isLoveTombstoned } from './tombstones';

export const PULL_PAGE_MAX_ITEMS = 1000;
export const PULL_LINK_MAX_ITEMS = 5000;
export const PULL_LINK_MAX_BYTES = 32 * 1024 * 1024;
export const PULL_GLOBAL_MAX_ITEMS = 20000;
export const PULL_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;

export interface PulledListen {
  itemKey: string;
  listenedAtMs: number;
  payload: unknown;
  artistKey?: string | null;
  trackKey?: string | null;
}

export interface PulledLove {
  itemKey: string;
  artist: string | null;
  track: string | null;
  recordingMbid?: string | null;
  payload: unknown;
}

export type StageOutcome = 'accepted' | 'duplicate' | 'tombstoned';

export type PendingSecondCoverage = { complete: true; matches: boolean } | { complete: false; matches: false };

function normalizedLoveKey(artist: string, track: string): string | null {
  try {
    const [a, t] = trackKey(artist, track);
    return `${a}\u0000${t}`;
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
}

/** Broad pull echo suppression; deliberately separate from canonical import/forward identities. */
export function hasListenAtSecond(
  db: Db,
  args: { did: string; second: number; linkId?: string; generation?: number },
): PendingSecondCoverage {
  if (
    db.one(
      "SELECT 1 AS hit FROM scrobbles WHERE did=? AND substr(listened_at,1,19)=strftime('%Y-%m-%dT%H:%M:%S',? ,'unixepoch') LIMIT 1",
      args.did,
      args.second,
    )
  )
    return { complete: true, matches: true };
  if (db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND listen_second=? LIMIT 1', args.did, args.second))
    return { complete: true, matches: true };
  // listen_keys is the indexed durable acceptance seam for pending singles
  // and batch members, and survives operation cleanup.
  if (
    args.linkId !== undefined &&
    args.generation !== undefined &&
    db.one(
      "SELECT 1 AS hit FROM linked_pull_items WHERE link_id=? AND generation=? AND kind='listen' AND listened_at_ms/1000=? LIMIT 1",
      args.linkId,
      args.generation,
      args.second,
    )
  )
    return { complete: true, matches: true };
  return hasUnknownListenSecond(db, args.did)
    ? { complete: false, matches: false }
    : { complete: true, matches: false };
}

/** Stage one upstream page and its progress marker atomically. Call within no outer async transaction. */
export function stagePullPage(
  db: Db,
  args: {
    linkId: string;
    generation: number;
    sourceService: string;
    sourceAccount: string;
    did: string;
    proposedCursor: string | null;
    proposedWatermarkMs: number;
    nowMs: number;
    items: readonly PulledListen[];
  },
): StageOutcome[] {
  if (args.items.length > PULL_PAGE_MAX_ITEMS) throw new RangeError('pull page exceeds item limit');
  for (const item of args.items) {
    if (!item.itemKey || !Number.isSafeInteger(item.listenedAtMs) || item.listenedAtMs < 0)
      throw new TypeError('invalid pull item');
  }
  return db.tx(() => {
    const link = db.one<{
      generation: number;
      status: string;
      pull_enabled: number;
      service: string;
      remote_user: string;
      did: string;
    }>('SELECT generation,status,pull_enabled,service,remote_user,did FROM linked_accounts WHERE id=?', args.linkId);
    if (
      !link ||
      link.generation !== args.generation ||
      link.status !== 'active' ||
      link.pull_enabled !== 1 ||
      link.service !== args.sourceService ||
      link.remote_user !== args.sourceAccount ||
      link.did !== args.did
    )
      throw new Error('stale or disabled pull generation');
    const current = db.one<{ generation: number; source_service: string; source_account: string }>(
      'SELECT generation,source_service,source_account FROM linked_pull_state WHERE link_id=? AND generation=?',
      args.linkId,
      args.generation,
    );
    if (!current || current.source_service !== args.sourceService || current.source_account !== args.sourceAccount)
      throw new Error('pull state source changed');
    if (hasUnknownListenSecond(db, args.did)) throw new Error('legacy listen-second coverage incomplete');
    const counts = db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n, coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items WHERE link_id=? AND generation=?',
      args.linkId,
      args.generation,
    )!;
    const global = db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n, coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items',
    )!;
    const outcomes: StageOutcome[] = [];
    let addN = 0,
      addBytes = 0;
    for (const item of args.items) {
      const second = Math.floor(item.listenedAtMs / 1000);
      if (isListenTombstoned(db, args.did, second, item.artistKey, item.trackKey)) {
        outcomes.push('tombstoned');
        continue;
      }
      const accepted = hasListenAtSecond(db, {
        did: args.did,
        second,
        linkId: args.linkId,
        generation: args.generation,
      });
      if (!accepted.complete) throw new Error('legacy listen-second coverage incomplete');
      if (accepted.matches) {
        outcomes.push('duplicate');
        continue;
      }
      const payload = JSON.stringify(item.payload);
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (
        counts.n + addN + 1 > PULL_LINK_MAX_ITEMS ||
        counts.bytes + addBytes + bytes > PULL_LINK_MAX_BYTES ||
        global.n + addN + 1 > PULL_GLOBAL_MAX_ITEMS ||
        global.bytes + addBytes + bytes > PULL_GLOBAL_MAX_BYTES
      )
        throw new Error('pull staging capacity exceeded');
      db.run(
        `INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,listened_at_ms,payload_json,payload_bytes,staged_at_ms)
        VALUES(?,?,?,'listen',?,?,?,?,?,?)`,
        args.linkId,
        args.generation,
        item.itemKey,
        args.sourceService,
        args.sourceAccount,
        item.listenedAtMs,
        payload,
        bytes,
        args.nowMs,
      );
      addN++;
      addBytes += bytes;
      outcomes.push('accepted');
    }
    db.run(
      'UPDATE linked_pull_state SET page_cursor=?,listen_watermark_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?',
      args.proposedCursor,
      args.proposedWatermarkMs,
      args.nowMs,
      args.linkId,
      args.generation,
    );
    return outcomes;
  });
}

/** Persist a loved-track scan page; unresolved metadata is a settled skip. */
export function stageLovePage(
  db: Db,
  args: {
    linkId: string;
    generation: number;
    sourceService: string;
    sourceAccount: string;
    did: string;
    proposedCursor: string | null;
    proposedBoundaryMs: number;
    proposedBoundaryKey: string | null;
    nowMs: number;
    items: readonly PulledLove[];
  },
): Array<'accepted' | 'duplicate' | 'tombstoned' | 'unresolved'> {
  if (args.items.length > PULL_PAGE_MAX_ITEMS) throw new RangeError('pull page exceeds item limit');
  return db.tx(() => {
    const link = db.one<{
      generation: number;
      status: string;
      pull_enabled: number;
      service: string;
      remote_user: string;
      did: string;
    }>('SELECT generation,status,pull_enabled,service,remote_user,did FROM linked_accounts WHERE id=?', args.linkId);
    if (
      !link ||
      link.generation !== args.generation ||
      link.status !== 'active' ||
      link.pull_enabled !== 1 ||
      link.service !== args.sourceService ||
      link.remote_user !== args.sourceAccount ||
      link.did !== args.did
    )
      throw new Error('stale or disabled pull generation');
    const state = db.one<{ source_service: string; source_account: string }>(
      'SELECT source_service,source_account FROM linked_pull_state WHERE link_id=? AND generation=?',
      args.linkId,
      args.generation,
    );
    if (!state || state.source_service !== args.sourceService || state.source_account !== args.sourceAccount)
      throw new Error('pull state source changed');
    const counts = db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items WHERE link_id=? AND generation=?',
      args.linkId,
      args.generation,
    )!;
    const global = db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items',
    )!;
    let addN = 0,
      addBytes = 0;
    const outcomes: Array<'accepted' | 'duplicate' | 'tombstoned' | 'unresolved'> = [];
    for (const item of args.items) {
      if (!item.itemKey) throw new TypeError('invalid pull item key');
      if (!item.artist || !item.track) {
        outcomes.push('unresolved');
        continue;
      }
      const key = normalizedLoveKey(item.artist, item.track);
      if (!key) {
        outcomes.push('unresolved');
        continue;
      }
      if (isLoveTombstoned(db, args.did, key, item.recordingMbid ?? null)) {
        outcomes.push('tombstoned');
        continue;
      }
      const [artistKey, trackKeyValue] = trackKey(item.artist, item.track);
      const indexed =
        db.one(
          'SELECT 1 FROM loves WHERE did=? AND artist_key=? AND track_key=? LIMIT 1',
          args.did,
          artistKey,
          trackKeyValue,
        ) ??
        (item.recordingMbid
          ? db.one('SELECT 1 FROM loves WHERE did=? AND recording_mbid=? LIMIT 1', args.did, item.recordingMbid)
          : null);
      const pending = db.one<{ kind: 'love.put' | 'love.delete' }>(
        `SELECT kind FROM operations WHERE did=? AND kind IN ('love.put','love.delete') AND state IN ('queued','blocked','running','uncertain')
        AND ((json_extract(record_json,'$.artist')=? AND json_extract(record_json,'$.track')=?) OR (? IS NOT NULL AND json_extract(record_json,'$.recordingMbid')=?))
        ORDER BY rowid DESC LIMIT 1`,
        args.did,
        item.artist,
        item.track,
        item.recordingMbid ?? null,
        item.recordingMbid ?? null,
      );
      const localIntent = db.one<{ intent: string }>(
        'SELECT intent FROM linked_love_intents WHERE did=? AND love_key=?',
        args.did,
        key,
      );
      const staged = db.one(
        "SELECT 1 FROM linked_pull_items p JOIN linked_accounts l ON l.id=p.link_id WHERE l.did=? AND p.kind='love' AND (p.love_key=? OR (? IS NOT NULL AND p.recording_mbid=?)) LIMIT 1",
        args.did,
        key,
        item.recordingMbid ?? null,
        item.recordingMbid ?? null,
      );
      if (pending?.kind === 'love.delete' || localIntent?.intent === 'unlove') {
        outcomes.push('tombstoned');
        continue;
      }
      if (indexed || pending?.kind === 'love.put' || localIntent?.intent === 'love' || staged) {
        outcomes.push('duplicate');
        continue;
      }
      const payload = JSON.stringify(item.payload),
        bytes = Buffer.byteLength(payload, 'utf8');
      if (
        counts.n + addN + 1 > PULL_LINK_MAX_ITEMS ||
        counts.bytes + addBytes + bytes > PULL_LINK_MAX_BYTES ||
        global.n + addN + 1 > PULL_GLOBAL_MAX_ITEMS ||
        global.bytes + addBytes + bytes > PULL_GLOBAL_MAX_BYTES
      )
        throw new Error('pull staging capacity exceeded');
      db.run(
        `INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,love_key,recording_mbid,payload_json,payload_bytes,staged_at_ms)
        VALUES(?,?,?,'love',?,?,?,?,?,?,?)`,
        args.linkId,
        args.generation,
        item.itemKey,
        args.sourceService,
        args.sourceAccount,
        key,
        item.recordingMbid ?? null,
        payload,
        bytes,
        args.nowMs,
      );
      addN++;
      addBytes += bytes;
      outcomes.push('accepted');
    }
    db.run(
      "UPDATE linked_pull_state SET page_kind='love',love_cursor=?,love_boundary_ms=?,love_boundary_key=?,updated_at_ms=? WHERE link_id=? AND generation=?",
      args.proposedCursor,
      args.proposedBoundaryMs,
      args.proposedBoundaryKey,
      args.nowMs,
      args.linkId,
      args.generation,
    );
    return outcomes;
  });
}
