import type { Db } from '../do/db';

export const PULL_PAGE_MAX_ITEMS = 1000;
export const PULL_LINK_MAX_ITEMS = 5000;
export const PULL_LINK_MAX_BYTES = 32 * 1024 * 1024;
export const PULL_GLOBAL_MAX_ITEMS = 20000;
export const PULL_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;

export interface PulledListen {
  itemKey: string;
  listenedAtMs: number;
  payload: unknown;
}

export type StageOutcome = 'accepted' | 'duplicate';

/** Broad pull echo suppression; deliberately separate from canonical import/forward identities. */
export function hasListenAtSecond(
  db: Db,
  args: { did: string; second: number; linkId?: string; generation?: number },
): boolean {
  if (
    db.one(
      "SELECT 1 AS hit FROM scrobbles WHERE did=? AND substr(listened_at,1,19)=strftime('%Y-%m-%dT%H:%M:%S',? ,'unixepoch') LIMIT 1",
      args.did,
      args.second,
    )
  )
    return true;
  if (db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND listen_second=? LIMIT 1', args.did, args.second))
    return true;
  if (
    db.one(
      "SELECT 1 AS hit FROM operations WHERE did=? AND state IN ('queued','blocked','sending','uncertain') AND kind='scrobble.create' AND CAST(json_extract(record_json,'$.value.createdAt') AS TEXT) LIKE ? LIMIT 1",
      args.did,
      `${new Date(args.second * 1000).toISOString().slice(0, 19)}%`,
    )
  )
    return true;
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
    return true;
  return false;
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
    }>('SELECT generation,status,pull_enabled,service,remote_user FROM linked_accounts WHERE id=?', args.linkId);
    if (
      !link ||
      link.generation !== args.generation ||
      link.status !== 'active' ||
      link.pull_enabled !== 1 ||
      link.service !== args.sourceService ||
      link.remote_user !== args.sourceAccount
    )
      throw new Error('stale or disabled pull generation');
    const current = db.one<{ generation: number }>(
      'SELECT generation FROM linked_pull_state WHERE link_id=? AND generation=?',
      args.linkId,
      args.generation,
    );
    if (!current) throw new Error('pull state is not initialized');
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
      if (hasListenAtSecond(db, { did: args.did, second, linkId: args.linkId, generation: args.generation })) {
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
