// The import writer (ADR 0005 §11.2 step 4, §11.4; N3-09): staged items
// become outbox operations, and the outcomes of those operations flow back
// into the job's counters.
//
// `writeSlice` takes the next WRITE_SLICE (1,000) staged items of a job, in
// staging order, and in ONE transaction:
// - a listen whose key is now in `listen_keys`, or that the index now holds
//   at the same second, is `duplicate` (a live listen or another import got
//   there first); it is never written;
// - otherwise its `listen_keys` row (source `import`) and a `scrobble.create`
//   operation with origin `import` and priority 1 (IMPORT_PRIORITY) are
//   written, the TID rkey allocated now and never recomputed
//   (scrobble-ops.ts), and the item becomes `queued` with its operation id;
// - a love (ListenBrainz feedback score 1) becomes a `love.put` operation with
//   origin `import`, FIFO behind any unsettled love intent of the same track;
//   imports never queue forward rows;
// - an item whose record no longer builds is `invalid`;
// - the job's counters and `updated_at_ms` change, and its crash-loop counter
//   is reset (the slice completed).
// The record's `createdAt` is the operation's creation time. The outbox then
// sends the operations as applyWrites batches within the import share of the
// PDS point budget (outbox/budget.ts). A crash before the commit leaves
// nothing behind; after it, the operations and their rkeys are durable and the
// outbox retries them with the same rkeys.
//
// Back-pressure: a slice is only taken while fewer than WRITE_SLICE items of
// the job are queued (`outstanding`), so cancelling a job stops new
// operations promptly while the queued ones finish.
//
// `syncOutcomes` moves queued items whose operation has settled to `written`
// (succeeded) or `failed` (failed or withdrawn) and adds them to the job's
// `written` and `failed_items` counters.

import { buildLoveRecord } from '@atmusic/core/love';
import { newTid } from '@atmusic/core/record-key';
import { NS_PER_SECOND, parseRfc3339 } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { loveKeyOf } from '../outbox/love-ops';
import {
  IMPORT_PRIORITY,
  insertOperation,
  newOperationId,
  outboxCollections,
  type Prepared,
  prepare,
  recordOf,
  unsettledOfKinds,
} from '../outbox/operations';
import { insertScrobbleCreate, prepareScrobble } from '../outbox/scrobble-ops';
import { addReasons, indexedAtSecond, knownListenKey, type StagedRecord } from './staging';

/** Staged items turned into operations per slice (ADR §3.3 `import` bound). */
export const WRITE_SLICE = 1_000;

interface ItemRow {
  seq: number;
  dedupe_key: string;
  record_json: string;
}

export interface WriteSliceReport {
  /** Operations created. */
  created: number;
  duplicates: number;
  invalid: number;
  /** Items looked at. */
  taken: number;
}

/** Queued items of the job (operations created and not yet settled). */
export function outstanding(db: Db, jobId: string): number {
  return (
    db.one<{ n: number }>("SELECT count(*) AS n FROM import_items WHERE job_id = ? AND state = 'queued'", jobId)?.n ?? 0
  );
}

/** Items still to be turned into operations. */
export function stagedLeft(db: Db, jobId: string): number {
  return (
    db.one<{ n: number }>("SELECT count(*) AS n FROM import_items WHERE job_id = ? AND state = 'staged'", jobId)?.n ?? 0
  );
}

function parseRecord(json: string): StagedRecord | null {
  try {
    const value = JSON.parse(json) as StagedRecord;
    if (value !== null && typeof value === 'object' && (value.kind === 'listen' || value.kind === 'love')) return value;
  } catch {
    // fall through
  }
  return null;
}

type Plan =
  | {
      seq: number;
      kind: 'listen';
      key: string;
      prepared: Prepared<object>;
      seconds: number;
      artist: string;
      track: string;
    }
  | { seq: number; kind: 'love'; prepared: Prepared<object>; loveKey: string }
  | { seq: number; kind: 'invalid' };

/**
 * One writer slice for `job` (see the header). `limit` defaults to WRITE_SLICE.
 * Returns what it did; nothing is created while WRITE_SLICE items are queued.
 */
export async function writeSlice(
  m: ModuleDeps,
  job: { id: string; did: string },
  now: number,
  limit: number = WRITE_SLICE,
): Promise<WriteSliceReport> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const db = m.db;
  const room = Math.max(0, Math.min(limit, WRITE_SLICE) - outstanding(db, job.id));
  const items =
    room === 0
      ? []
      : db.all<ItemRow>(
          `SELECT seq, dedupe_key, record_json FROM import_items WHERE job_id = ? AND state = 'staged'
           ORDER BY seq LIMIT ?`,
          job.id,
          room,
        );

  // Everything async (canonical digests) happens before the transaction.
  const plans: Plan[] = [];
  const clock = { nowMs: () => now };
  for (const item of items) {
    const record = parseRecord(item.record_json);
    if (record === null) {
      plans.push({ seq: item.seq, kind: 'invalid' });
      continue;
    }
    if (record.kind === 'listen') {
      const built = await prepareScrobble(record.input, prefix, now);
      const ns = built.ok ? parseRfc3339(built.prepared.record.listenedAt) : null;
      if (!built.ok || ns === null) {
        plans.push({ seq: item.seq, kind: 'invalid' });
        continue;
      }
      plans.push({
        seq: item.seq,
        kind: 'listen',
        key: item.dedupe_key,
        prepared: built.prepared,
        seconds: Number(ns / NS_PER_SECOND),
        artist: built.prepared.record.artist,
        track: built.prepared.record.track,
      });
    } else {
      const built = buildLoveRecord(record.input, prefix, clock);
      const loveKey = built.ok ? loveKeyOf(built.record.artist, built.record.track) : null;
      if (!built.ok || loveKey === null) {
        plans.push({ seq: item.seq, kind: 'invalid' });
        continue;
      }
      plans.push({ seq: item.seq, kind: 'love', loveKey, prepared: await prepare(built.record) });
    }
  }

  const report: WriteSliceReport = { created: 0, duplicates: 0, invalid: 0, taken: plans.length };
  db.tx(() => {
    // Cancelled (or paused, failed) while the digests were computed: nothing new.
    const state = db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', job.id)?.state;
    if (state !== 'writing') {
      report.taken = 0;
      return;
    }
    // Unsettled love intents of the DID by track key, read once per slice.
    const cache: { loves: Map<string, string[]> | null } = { loves: null };
    const loveIndex = (): Map<string, string[]> => {
      if (cache.loves === null) {
        const map = new Map<string, string[]>();
        for (const op of unsettledOfKinds(db, job.did, ['love.put', 'love.delete'])) {
          const r = recordOf(op);
          const k = r === null ? null : loveKeyOf(r.artist, r.track);
          if (k !== null) map.set(k, [...(map.get(k) ?? []), op.id]);
        }
        cache.loves = map;
      }
      return cache.loves;
    };
    const setState = (seq: number, state: string, operationId: string | null) => {
      db.run(
        'UPDATE import_items SET state = ?, operation_id = ? WHERE job_id = ? AND seq = ?',
        state,
        operationId,
        job.id,
        seq,
      );
    };
    for (const plan of plans) {
      if (plan.kind === 'invalid') {
        setState(plan.seq, 'invalid', null);
        report.invalid += 1;
        continue;
      }
      if (plan.kind === 'listen') {
        if (
          knownListenKey(db, job.did, plan.key) ||
          indexedAtSecond(db, job.did, plan.seconds, plan.artist, plan.track)
        ) {
          setState(plan.seq, 'duplicate', null);
          report.duplicates += 1;
          continue;
        }
        const operationId = newOperationId(m.random);
        db.run(
          `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, ?, 'import', ?)`,
          job.did,
          plan.key,
          operationId,
          now,
        );
        insertScrobbleCreate(
          { ...m, clock },
          { id: operationId, did: job.did, origin: 'import', prepared: plan.prepared, dueAt: now, importJobId: job.id },
          now,
        );
        setState(plan.seq, 'queued', operationId);
        report.created += 1;
        continue;
      }
      const op = insertOperation(
        db,
        {
          id: newOperationId(m.random),
          did: job.did,
          kind: 'love.put',
          origin: 'import',
          priority: IMPORT_PRIORITY,
          collection: outboxCollections(prefix).love,
          rkey: newTid(clock, m.random),
          prepared: plan.prepared,
          dueAt: now,
          importJobId: job.id,
          predecessors: loveIndex().get(plan.loveKey) ?? [],
        },
        now,
      );
      loveIndex().set(plan.loveKey, [...(loveIndex().get(plan.loveKey) ?? []), op.id]);
      setState(plan.seq, 'queued', op.id);
      report.created += 1;
    }
    const row = db.one<{ invalid_reasons: string }>('SELECT invalid_reasons FROM import_jobs WHERE id = ?', job.id);
    db.run(
      `UPDATE import_jobs SET duplicates = duplicates + ?, invalid = invalid + ?, invalid_reasons = ?,
         attempts = 0, updated_at_ms = ? WHERE id = ?`,
      report.duplicates,
      report.invalid,
      addReasons(row?.invalid_reasons ?? '{}', report.invalid > 0 ? { record_invalid: report.invalid } : {}),
      now,
      job.id,
    );
  });
  return report;
}

export interface SyncReport {
  written: number;
  failed: number;
}

/** Settled operations of the job's queued items → `written` / `failed` (see the header). */
export function syncOutcomes(db: Db, jobId: string, now: number): SyncReport {
  return db.tx((): SyncReport => {
    const rows = db.all<{ state: string }>(
      `UPDATE import_items SET state = CASE o.state WHEN 'succeeded' THEN 'written' ELSE 'failed' END
       FROM operations AS o
       WHERE import_items.job_id = ? AND import_items.state = 'queued' AND o.id = import_items.operation_id
         AND o.state IN ('succeeded', 'failed', 'cancelled')
       RETURNING import_items.state AS state`,
      jobId,
    );
    const report: SyncReport = { written: 0, failed: 0 };
    for (const row of rows) {
      if (row.state === 'written') report.written += 1;
      else report.failed += 1;
    }
    if (rows.length > 0) {
      db.run(
        `UPDATE import_jobs SET written = written + ?, failed_items = failed_items + ?, updated_at_ms = ? WHERE id = ?`,
        report.written,
        report.failed,
        now,
        jobId,
      );
    }
    return report;
  });
}
