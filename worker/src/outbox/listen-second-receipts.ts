// Durable migration-30 recovery for broad same-second pull dedupe. The key is
// opaque, so every repaired receipt is joined by the canonical member key,
// never by an arbitrary operation-level row.

import { listenKey } from '@atmusic/core/listen-key';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import type { Db } from '../do/db';

export const LEGACY_RECEIPT_MEMBER_SLICE = 100;
export const LEGACY_PROJECTION_ROW_SLICE = 200;

export interface ListenSecondReceipt {
  dedupeKey: string;
  second: number;
}

function records(value: unknown): Array<{ artist?: unknown; track?: unknown; listenedAt?: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const object = value as { listens?: unknown };
  if (Array.isArray(object.listens))
    return object.listens.filter(
      (item): item is { artist?: unknown; track?: unknown; listenedAt?: unknown } =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    );
  return [object as { artist?: unknown; track?: unknown; listenedAt?: unknown }];
}

export async function prepareListenSecondReceipts(did: string, recordJson: string): Promise<ListenSecondReceipt[]> {
  const parsed: unknown = JSON.parse(recordJson);
  const members = records(parsed);
  if (members.length === 0 || members.length > 1000) throw new RangeError('legacy listen receipt member bound');
  const receipts: ListenSecondReceipt[] = [];
  for (const member of members) {
    if (typeof member.artist !== 'string' || typeof member.track !== 'string' || typeof member.listenedAt !== 'string')
      throw new TypeError('legacy listen receipt member is incomplete');
    const ns = parseRfc3339(member.listenedAt);
    if (ns === null) throw new TypeError('legacy listen receipt timestamp is invalid');
    receipts.push({
      dedupeKey: await listenKey({ did, listenedAtNs: ns, artist: member.artist, track: member.track }),
      second: Number(ns / 1_000_000_000n),
    });
  }
  return receipts;
}

/** Set exact legacy member receipts; callers keep this in the success transaction. */
export function persistListenSecondReceipts(
  db: Db,
  args: { did: string; operationId: string; receipts: readonly ListenSecondReceipt[] },
): void {
  for (const receipt of args.receipts)
    db.run(
      'UPDATE listen_keys SET listen_second=? WHERE did=? AND operation_id=? AND dedupe_key=? AND listen_second IS NULL',
      receipt.second,
      args.did,
      args.operationId,
      receipt.dedupeKey,
    );
}

/** A null timestamp cannot be decoded from the hash; it remains a hard pull hold until repaired. */
export function hasUnknownListenSecond(db: Db, did: string): boolean {
  return db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND listen_second IS NULL LIMIT 1', did) !== null;
}

/** One keyset slice over pre-existing operation payloads; stable after restart. */
export async function seedLegacyListenSecondSlice(
  db: Db,
  nowMs: number,
): Promise<{ processed: number; more: boolean }> {
  db.run(
    'INSERT OR IGNORE INTO linked_pull_receipt_seed(singleton,last_rowid,member_offset,done,updated_at_ms) VALUES(1,0,0,0,?)',
    nowMs,
  );
  const progress = db.one<{ last_rowid: number; member_offset: number }>(
    'SELECT last_rowid,member_offset FROM linked_pull_receipt_seed WHERE singleton=1',
  );
  if (progress === null) return { processed: 0, more: false };
  let row =
    progress.member_offset > 0
      ? db.one<{ rowid: number; id: string; did: string; record_json: string }>(
          `SELECT rowid,id,did,record_json FROM operations WHERE rowid=? AND kind='scrobble.create'
           AND record_json IS NOT NULL AND EXISTS (SELECT 1 FROM listen_keys k WHERE k.did=operations.did
             AND k.operation_id=operations.id AND k.listen_second IS NULL)`,
          progress.last_rowid,
        )
      : null;
  row ??= db.one<{ rowid: number; id: string; did: string; record_json: string }>(
    `SELECT rowid,id,did,record_json FROM operations WHERE rowid>? AND kind='scrobble.create'
     AND record_json IS NOT NULL AND EXISTS (SELECT 1 FROM listen_keys k WHERE k.did=operations.did
       AND k.operation_id=operations.id AND k.listen_second IS NULL)
     ORDER BY rowid LIMIT 1`,
    progress.last_rowid,
  );
  if (row === null) {
    db.run('UPDATE linked_pull_receipt_seed SET done=1,updated_at_ms=? WHERE singleton=1', nowMs);
    return { processed: 0, more: false };
  }
  let receipts: ListenSecondReceipt[] = [];
  try {
    receipts = await prepareListenSecondReceipts(row.did, row.record_json);
  } catch {
    // Leave this hash unknown. The bounded projection scanner may resolve it;
    // pull acceptance remains held in the meantime.
  }
  const start = progress.member_offset;
  const end = Math.min(start + LEGACY_RECEIPT_MEMBER_SLICE, receipts.length);
  db.tx(() => {
    persistListenSecondReceipts(db, {
      did: row!.did,
      operationId: row!.id,
      receipts: receipts.slice(start, end),
    });
    const partial = receipts.length > end;
    db.run(
      'UPDATE linked_pull_receipt_seed SET last_rowid=?,member_offset=?,done=0,updated_at_ms=? WHERE singleton=1',
      row!.rowid,
      partial ? end : 0,
      nowMs,
    );
  });
  const more =
    receipts.length > end ||
    db.one(
      `SELECT 1 AS hit FROM operations WHERE rowid>? AND kind='scrobble.create' AND record_json IS NOT NULL
       AND EXISTS (SELECT 1 FROM listen_keys k WHERE k.did=operations.did AND k.operation_id=operations.id
         AND k.listen_second IS NULL) LIMIT 1`,
      row.rowid,
    ) !== null;
  return { processed: end - start, more };
}

/** Repair hashes whose successful local records have now arrived in the projection. */
export async function seedIndexedListenSecondSlice(
  db: Db,
  did: string,
  nowMs: number,
  limit = LEGACY_PROJECTION_ROW_SLICE,
): Promise<{ processed: number; more: boolean }> {
  if (!hasUnknownListenSecond(db, did)) return { processed: 0, more: false };
  db.run('INSERT OR IGNORE INTO linked_pull_projection_scan(did,rowid_cursor,updated_at_ms) VALUES(?,0,?)', did, nowMs);
  const progress = db.one<{ rowid_cursor: number }>(
    'SELECT rowid_cursor FROM linked_pull_projection_scan WHERE did=?',
    did,
  )!;
  const rows = db.all<{
    rowid: number;
    listened_at: string;
    artist: string;
    track: string;
  }>(
    'SELECT rowid,listened_at,artist,track FROM scrobbles WHERE did=? AND rowid>? ORDER BY rowid LIMIT ?',
    did,
    progress.rowid_cursor,
    Math.max(1, Math.min(limit, LEGACY_PROJECTION_ROW_SLICE)),
  );
  const receipts: Array<{ rowid: number; receipt: ListenSecondReceipt }> = [];
  for (const row of rows) {
    const ns = parseRfc3339(row.listened_at);
    if (ns === null) continue;
    receipts.push({
      rowid: row.rowid,
      receipt: {
        dedupeKey: await listenKey({ did, listenedAtNs: ns, artist: row.artist, track: row.track }),
        second: Number(ns / 1_000_000_000n),
      },
    });
  }
  const lastRowid = rows.at(-1)?.rowid ?? progress.rowid_cursor;
  db.tx(() => {
    for (const { receipt } of receipts)
      db.run(
        'UPDATE listen_keys SET listen_second=? WHERE did=? AND dedupe_key=? AND listen_second IS NULL',
        receipt.second,
        did,
        receipt.dedupeKey,
      );
    db.run('UPDATE linked_pull_projection_scan SET rowid_cursor=?,updated_at_ms=? WHERE did=?', lastRowid, nowMs, did);
  });
  return {
    processed: rows.length,
    more:
      rows.length === Math.max(1, Math.min(limit, LEGACY_PROJECTION_ROW_SLICE)) ||
      db.one('SELECT 1 AS hit FROM scrobbles WHERE did=? AND rowid>? LIMIT 1', did, lastRowid) !== null,
  };
}
