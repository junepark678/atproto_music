// Atomically replace definitely-never-sent import single creates with durable
// batch create operations. Async digest/size work is deliberately outside tx;
// all eligibility and memberships are rechecked before any row is changed.
import { measureScrobbleBatch } from '@atmusic/atproto/scrobble-batch-size';
import { newTid } from '@atmusic/core/record-key';
import {
  packScrobbleBatchEntries,
  type ScrobbleBatchEntry,
  type ScrobbleBatchRecord,
  scrobbleBatchCollection,
} from '@atmusic/core/scrobble-batch';
import type { OperationRow } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { IMPORT_PRIORITY, insertOperation, newOperationId, type Prepared, prepare } from '../outbox/operations';

interface Candidate {
  operation: OperationRow;
  jobs: Array<{ jobId: string; seq: number; dedupeKey: string }>;
  entry: ScrobbleBatchEntry;
}
interface PreparedGroup {
  candidates: Candidate[];
  prepared: Prepared<ScrobbleBatchRecord>;
  rkey: string;
  operationId: string;
}

function safeCandidate(db: Db, op: OperationRow): boolean {
  if (
    op.kind !== 'scrobble.create' ||
    op.origin !== 'import' ||
    op.attempts !== 0 ||
    (op.state !== 'queued' && op.state !== 'blocked') ||
    op.result_uri !== null ||
    op.idempotency_key !== null ||
    op.rkey === null ||
    op.record_json === null
  )
    return false;
  if (db.one('SELECT 1 FROM operation_deps WHERE op_id = ? OR pred_id = ? LIMIT 1', op.id, op.id) !== null)
    return false;
  const uri = `at://${op.did}/${op.collection}/${op.rkey}`;
  if (db.one('SELECT 1 FROM scrobbles WHERE uri = ? LIMIT 1', uri) !== null) return false;
  if (db.one('SELECT 1 FROM record_state WHERE uri = ? LIMIT 1', uri) !== null) return false;
  return true;
}

/** Returns the number of listens moved; never changes attempted or succeeded operations. */
export async function rebatchUnsentImports(m: ModuleDeps, jobId: string, did: string, now: number): Promise<number> {
  const prefix = m.config.prefix;
  if (prefix === null || !m.config.batchPublication) return 0;
  const db = m.db;
  const rows = db.all<{ op_id: string; job_id: string; seq: number; dedupe_key: string }>(
    `SELECT DISTINCT o.id AS op_id, i.job_id, i.seq, i.dedupe_key
     FROM import_items i JOIN operations o ON o.id = i.operation_id
     WHERE i.state = 'queued' AND o.did = ? AND o.origin = 'import' AND o.kind = 'scrobble.create'
       AND o.collection = ? AND o.state IN ('queued','blocked') AND o.attempts = 0
       AND o.result_uri IS NULL AND o.idempotency_key IS NULL
       AND NOT EXISTS (SELECT 1 FROM operation_deps d WHERE d.op_id=o.id OR d.pred_id=o.id)
       AND i.job_id = ?
       AND NOT EXISTS (SELECT 1 FROM scrobbles s WHERE s.uri = 'at://' || o.did || '/' || o.collection || '/' || o.rkey)
     ORDER BY o.rowid, i.job_id, i.seq`,
    did,
    `${prefix}.scrobble`,
    jobId,
  );
  const byId = new Map<string, Candidate>();
  for (const row of rows) {
    const op = db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', row.op_id);
    if (op === null || !safeCandidate(db, op)) continue;
    let candidate = byId.get(op.id);
    if (candidate === undefined) {
      let single: Record<string, unknown>;
      try {
        single = JSON.parse(op.record_json as string) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (single.$type !== `${prefix}.scrobble` || typeof single.createdAt !== 'string') continue;
      const { $type: _type, ...fields } = single;
      candidate = { operation: op, jobs: [], entry: { id: op.rkey as string, ...fields } as ScrobbleBatchEntry };
      byId.set(op.id, candidate);
    }
    candidate.jobs.push({ jobId: row.job_id, seq: row.seq, dedupeKey: row.dedupe_key });
  }
  const candidates = [...byId.values()].filter((candidate) => candidate.jobs.length > 0);
  if (candidates.length < 2) return 0;
  const collection = scrobbleBatchCollection(prefix);
  const packed = packScrobbleBatchEntries(
    candidates.map((candidate) => candidate.entry),
    {
      measure: (entries) =>
        measureScrobbleBatch(
          { $type: collection, createdAt: new Date(now).toISOString(), listens: [...entries] as ScrobbleBatchEntry[] },
          { repo: did, collection, rkey: '2222222222222' },
        ),
    },
  );
  const groups: PreparedGroup[] = [];
  let offset = 0;
  for (const part of packed) {
    const members = candidates.slice(offset, offset + part.entries.length);
    offset += part.entries.length;
    if (members.length < 2) continue;
    const record: ScrobbleBatchRecord = {
      $type: collection,
      createdAt: new Date(now).toISOString(),
      listens: [...part.entries] as ScrobbleBatchEntry[],
    };
    const rkey = newTid(m.clock, m.random);
    const sizes = measureScrobbleBatch(record, { repo: did, collection, rkey });
    if (sizes.cborBytes !== part.cborBytes || sizes.createBodyBytes > 100_000) continue;
    groups.push({ candidates: members, prepared: await prepare(record), rkey, operationId: newOperationId(m.random) });
  }
  let moved = 0;
  db.tx(() => {
    for (const group of groups) {
      const valid = group.candidates.every((candidate) => {
        const current = db.one<OperationRow>('SELECT * FROM operations WHERE id = ?', candidate.operation.id);
        if (
          current === null ||
          current.state !== candidate.operation.state ||
          current.attempts !== 0 ||
          !safeCandidate(db, current)
        )
          return false;
        if (
          current.record_json !== candidate.operation.record_json ||
          current.digest !== candidate.operation.digest ||
          current.rkey !== candidate.operation.rkey
        )
          return false;
        const currentItems = db.all<{ job_id: string; seq: number; dedupe_key: string; state: string }>(
          'SELECT job_id, seq, dedupe_key, state FROM import_items WHERE operation_id = ? ORDER BY job_id, seq',
          current.id,
        );
        const expected = candidate.jobs.map(({ jobId, seq, dedupeKey }) => ({
          job_id: jobId,
          seq,
          dedupe_key: dedupeKey,
          state: 'queued',
        }));
        if (JSON.stringify(currentItems) !== JSON.stringify(expected)) return false;
        const keys = db.all<{ dedupe_key: string; source: string }>(
          'SELECT dedupe_key, source FROM listen_keys WHERE operation_id = ? ORDER BY dedupe_key',
          current.id,
        );
        const expectedKeys = candidate.jobs
          .map((item) => item.dedupeKey)
          .sort()
          .map((dedupe_key) => ({ dedupe_key, source: 'import' }));
        return JSON.stringify(keys) === JSON.stringify(expectedKeys);
      });
      if (!valid) continue;
      const batch = insertOperation(
        db,
        {
          id: group.operationId,
          did,
          kind: 'scrobble.create',
          origin: 'import',
          priority: IMPORT_PRIORITY,
          collection,
          rkey: group.rkey,
          prepared: group.prepared,
          dueAt: now,
          importJobId: jobId,
        },
        now,
      );
      for (const candidate of group.candidates) {
        db.run(
          "UPDATE operations SET state = 'cancelled', last_error = 'rebatched', updated_at_ms = ? WHERE id = ? AND state IN ('queued','blocked') AND attempts = 0",
          now,
          candidate.operation.id,
        );
        db.run('UPDATE import_items SET operation_id = ? WHERE operation_id = ?', batch.id, candidate.operation.id);
        db.run('UPDATE listen_keys SET operation_id = ? WHERE operation_id = ?', batch.id, candidate.operation.id);
        moved += candidate.jobs.length;
      }
    }
  });
  return moved;
}
