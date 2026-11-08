// The import writer (ADR 0005 §11.2 step 4, §11.4; N3-09): staged items
// become outbox operations, and the outcomes of those operations flow back
// into the job's counters.
//
// With batch publication closed, `writeSlice` takes the next WRITE_SLICE
// (1,000) staged loves of a job (listens stay staged), in staging order, and
// in ONE transaction:
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
// With batch publication open, listens go into byte-filled scrobbleBatch
// containers instead (ADR 0006 "Capacity"; `writeBatchSlice`): a slice scans
// the staged items in order and creates at most ONE container, the longest
// prefix of the eligible listens whose exact createRecord body fits
// MAX_CREATE_BODY_BYTES. The listen that did not fit, and everything after
// it, stays staged for the next slice, so a container is only short when it
// is the job's last. Invalid items, duplicates and loves (at most the free
// room) met on the way are settled in the same transaction. A scan stops
// after BATCH_SCAN_LIMIT items, more than any container can hold, so a scan
// that ends with an unfilled container has settled something: every slice
// makes progress, and none spins on a window it cannot fill.
//
// `syncOutcomes` moves queued items whose operation has settled to `written`
// (succeeded) or `failed` (failed or withdrawn) and adds them to the job's
// `written` and `failed_items` counters.

import { buildLoveRecord } from '@atmusic/core/love';
import { newTid } from '@atmusic/core/record-key';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { BATCH_MAX_LISTENS, type ScrobbleBatchEntry, type ScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import { NS_PER_SECOND, parseRfc3339 } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { admitForwardIdentity } from '../forward/projection';
import { enqueueForwards } from '../outbox/forward-enqueue';
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
import { acceptImportBatch, prepareImportBatchPrefix } from './batch-acceptance';
import { addReasons, indexedAtSecond, knownListenKey, type StagedRecord } from './staging';

/** Staged items turned into operations per slice (ADR §3.3 `import` bound). */
export const WRITE_SLICE = 1_000;
/**
 * Staged items one batch slice looks at, at most: one more than a container
 * may hold, so a scan this long either filled its container or met an item
 * it settles (writeBatchSlice).
 */
export const BATCH_SCAN_LIMIT = BATCH_MAX_LISTENS + 1;
/** Staged rows read per query while a batch slice scans. */
const SCAN_CHUNK = 1_000;

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
    db.one<{ n: number }>(
      "SELECT count(*) AS n FROM import_items WHERE job_id = ? AND state = 'queued' AND removed_at_ms IS NULL",
      jobId,
    )?.n ?? 0
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
      forward: Record<string, unknown>;
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
  if (m.config.batchPublication) return writeBatchSlice(m, job, now, room, prefix);
  // Publication closed: only loves are written; listens stay staged.
  const items =
    room === 0
      ? []
      : db.all<ItemRow>(
          `SELECT seq, dedupe_key, record_json FROM import_items WHERE job_id = ? AND state = 'staged'
           AND json_extract(record_json, '$.kind') = 'love'
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
        forward: forwardListen(built.prepared.record as unknown as Record<string, unknown>),
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
          `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms, listen_second) VALUES (?, ?, ?, 'import', ?, ?)`,
          job.did,
          plan.key,
          operationId,
          now,
          plan.seconds,
        );
        const sourceService = importService(db, job.id);
        const firstAdmission = admitForwardIdentity(db, {
          did: job.did,
          identityKey: plan.key,
          path: 'import',
          sourceService: sourceService ?? undefined,
          now,
        });
        insertScrobbleCreate(
          { ...m, clock },
          { id: operationId, did: job.did, origin: 'import', prepared: plan.prepared, dueAt: now, importJobId: job.id },
          now,
        );
        if (firstAdmission && sourceService !== null)
          enqueueForwards(db, {
            did: job.did,
            items: [{ kind: 'scrobble', listenKey: plan.key, payload: { listen: plan.forward, origin: 'import' } }],
            excludeSourceService: sourceService,
            now,
            random: m.random,
          });
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
      const sourceService = importService(db, job.id);
      const identityKey = `love-uri:${job.did}:${op.collection}:${op.rkey}`;
      const firstAdmission = admitForwardIdentity(db, {
        did: job.did,
        identityKey,
        path: 'import',
        sourceService: sourceService ?? undefined,
        now,
      });
      const { $type: _type, createdAt: _createdAt, ...lovePayload } = plan.prepared.record as Record<string, unknown>;
      if (firstAdmission && sourceService !== null)
        enqueueForwards(db, {
          did: job.did,
          items: [{ kind: 'love', operationId: op.id, payload: { ...lovePayload, origin: 'import' } }],
          excludeSourceService: sourceService,
          now,
          random: m.random,
        });
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

type ListenMember = {
  seq: number;
  key: string;
  seconds: number;
  artist: string;
  track: string;
  forward: Record<string, unknown>;
};

function importService(db: Db, jobId: string): 'lastfm' | 'listenbrainz' | null {
  const source = db.one<{ source: string }>('SELECT source FROM import_jobs WHERE id=?', jobId)?.source;
  switch (source) {
    case 'lastfm_api':
    case 'lastfm_json':
      return 'lastfm';
    case 'listenbrainz_api':
    case 'listenbrainz_zip':
      return 'listenbrainz';
    default:
      return null;
  }
}

function forwardListen(record: Record<string, unknown>): Record<string, unknown> {
  return {
    artist: record.artist,
    track: record.track,
    ...(typeof record.album === 'string' ? { album: record.album } : {}),
    listenedAt: record.listenedAt,
    ...(typeof record.durationSeconds === 'number' ? { durationSeconds: record.durationSeconds } : {}),
    ...(typeof record.recordingMbid === 'string' ? { recordingMbid: record.recordingMbid } : {}),
  };
}
type Settled =
  | { seq: number; kind: 'invalid' }
  | ({ kind: 'duplicate' } & ListenMember)
  | { seq: number; kind: 'love'; prepared: Prepared<object>; loveKey: string };

/**
 * One batch-publication slice (see the header): at most one container, the
 * longest prefix of the eligible staged listens in staging order whose exact
 * createRecord body fits, emitted only when the next eligible listen did not
 * fit or no staged item is left; plus the invalid items, duplicates and loves
 * (at most `room`) scanned before the scan stopped.
 */
async function writeBatchSlice(
  m: ModuleDeps,
  job: { id: string; did: string },
  now: number,
  room: number,
  prefix: string,
): Promise<WriteSliceReport> {
  const db = m.db;
  const report: WriteSliceReport = { created: 0, duplicates: 0, invalid: 0, taken: 0 };
  if (room === 0) return report;
  const clock = { nowMs: () => now };
  const candidates: Array<{ member: ListenMember; entry: ScrobbleBatchEntry }> = [];
  let members: ListenMember[] = [];
  const settled: Settled[] = [];
  let next: ListenMember | null = null;
  let exhausted = false;
  let loves = 0;
  let scanned = 0;
  let after = -1;
  scan: while (scanned < BATCH_SCAN_LIMIT) {
    const want = Math.min(SCAN_CHUNK, BATCH_SCAN_LIMIT - scanned);
    const items = db.all<ItemRow>(
      `SELECT seq, dedupe_key, record_json FROM import_items WHERE job_id = ? AND state = 'staged' AND seq > ?
       ORDER BY seq LIMIT ?`,
      job.id,
      after,
      want,
    );
    for (const item of items) {
      const record = parseRecord(item.record_json);
      if (record === null) {
        settled.push({ seq: item.seq, kind: 'invalid' });
      } else if (record.kind === 'listen') {
        const built = buildScrobbleRecord(record.input, prefix, clock);
        const ns = built.ok ? parseRfc3339(built.record.listenedAt) : null;
        if (!built.ok || ns === null) {
          settled.push({ seq: item.seq, kind: 'invalid' });
        } else {
          const member: ListenMember = {
            seq: item.seq,
            key: item.dedupe_key,
            seconds: Number(ns / NS_PER_SECOND),
            artist: built.record.artist,
            track: built.record.track,
            forward: forwardListen(built.record as unknown as Record<string, unknown>),
          };
          if (
            knownListenKey(db, job.did, member.key) ||
            indexedAtSecond(db, job.did, member.seconds, member.artist, member.track)
          ) {
            settled.push({ kind: 'duplicate', ...member });
          } else {
            const { $type: _type, ...fields } = built.record;
            const entry: ScrobbleBatchEntry = { id: newTid(m.clock, m.random), ...fields };
            candidates.push({ member, entry });
          }
        }
      } else {
        const built = buildLoveRecord(record.input, prefix, clock);
        const loveKey = built.ok ? loveKeyOf(built.record.artist, built.record.track) : null;
        if (!built.ok || loveKey === null) {
          settled.push({ seq: item.seq, kind: 'invalid' });
        } else {
          settled.push({ seq: item.seq, kind: 'love', loveKey, prepared: await prepare(built.record) });
          loves += 1;
        }
      }
      scanned += 1;
      after = item.seq;
      if (loves >= room) break scan;
    }
    if (items.length < want) {
      exhausted = true;
      break;
    }
  }

  const packed = await prepareImportBatchPrefix(m, { did: job.did, now, candidates });
  members = packed.members;
  next = packed.overflowMember;
  // A container short of full waits for more listens unless none is left.
  const emit = members.length > 0 && (next !== null || exhausted);
  let batch: { operationId: string; entries: ScrobbleBatchEntry[]; prepared: Prepared<ScrobbleBatchRecord> } | null =
    null;
  if (emit) {
    batch = {
      operationId: newOperationId(m.random),
      entries: packed.entries,
      prepared: packed.prepared!,
    };
  }

  db.tx(() => {
    // Cancelled (or paused, failed) while the digests were computed: nothing new.
    const state = db.one<{ state: string }>('SELECT state FROM import_jobs WHERE id = ?', job.id)?.state;
    if (state !== 'writing') return;
    const setState = (seq: number, state: string, operationId: string | null) => {
      db.run(
        'UPDATE import_items SET state = ?, operation_id = ? WHERE job_id = ? AND seq = ?',
        state,
        operationId,
        job.id,
        seq,
      );
      report.taken += 1;
    };
    const eligible = (member: ListenMember) =>
      !knownListenKey(db, job.did, member.key) &&
      !indexedAtSecond(db, job.did, member.seconds, member.artist, member.track);
    // A race that made any member ineligible leaves the whole group staged;
    // the next slice settles that listen as a duplicate and packs the rest.
    if (batch !== null && members.every(eligible)) {
      const sourceService = importService(db, job.id);
      acceptImportBatch(m, {
        did: job.did,
        now,
        rkey: packed.rkey,
        prepared: batch.prepared,
        operationId: batch.operationId,
        importJobId: job.id,
        members: members.map((member) => ({
          listenKey: member.key,
          listenSecond: member.seconds,
          forward: member.forward,
          sourceService,
        })),
      });
      for (const [i, member] of members.entries()) {
        setState(member.seq, 'queued', batch.operationId);
        db.run(
          'INSERT INTO batch_entry_items(operation_id, entry_id, job_id, seq) VALUES (?, ?, ?, ?)',
          batch.operationId,
          (batch.entries[i] as ScrobbleBatchEntry).id,
          job.id,
          member.seq,
        );
        report.created += 1;
      }
    }
    let loveIndex: Map<string, string[]> | null = null;
    for (const plan of settled) {
      if (plan.kind === 'invalid') {
        setState(plan.seq, 'invalid', null);
        report.invalid += 1;
      } else if (plan.kind === 'duplicate') {
        // Still a duplicate (its key could have been released since the scan).
        if (eligible(plan)) continue;
        setState(plan.seq, 'duplicate', null);
        report.duplicates += 1;
      } else {
        if (loveIndex === null) {
          loveIndex = new Map();
          for (const op of unsettledOfKinds(db, job.did, ['love.put', 'love.delete'])) {
            const r = recordOf(op);
            const k = r === null ? null : loveKeyOf(r.artist, r.track);
            if (k !== null) loveIndex.set(k, [...(loveIndex.get(k) ?? []), op.id]);
          }
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
            rkey: newTid(m.clock, m.random),
            prepared: plan.prepared,
            dueAt: now,
            importJobId: job.id,
            predecessors: loveIndex.get(plan.loveKey) ?? [],
          },
          now,
        );
        const sourceService = importService(db, job.id);
        const identityKey = `love-uri:${job.did}:${op.collection}:${op.rkey}`;
        const firstAdmission = admitForwardIdentity(db, {
          did: job.did,
          identityKey,
          path: 'import',
          sourceService: sourceService ?? undefined,
          now,
        });
        const { $type: _type, createdAt: _createdAt, ...lovePayload } = plan.prepared.record as Record<string, unknown>;
        if (firstAdmission && sourceService !== null)
          enqueueForwards(db, {
            did: job.did,
            items: [{ kind: 'love', operationId: op.id, payload: { ...lovePayload, origin: 'import' } }],
            excludeSourceService: sourceService,
            now,
            random: m.random,
          });
        loveIndex.set(plan.loveKey, [...(loveIndex.get(plan.loveKey) ?? []), op.id]);
        setState(plan.seq, 'queued', op.id);
        report.created += 1;
      }
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
       WHERE import_items.job_id = ? AND import_items.state = 'queued' AND import_items.removed_at_ms IS NULL AND o.id = import_items.operation_id
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
