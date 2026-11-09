// Shared import-origin batch packing and per-member acceptance. Both explicit
// imports and linked pull staging use this seam, so the byte boundary,
// provenance admission, forwarding exclusion and import budget are identical.
import { measureScrobbleBatch, scrobbleBatchSizer } from '@atmusic/atproto/scrobble-batch-size';
import { newTid } from '@atmusic/core/record-key';
import {
  newBatchPrefix,
  type ScrobbleBatchEntry,
  type ScrobbleBatchRecord,
  scrobbleBatchCollection,
  verifyBatchBoundary,
} from '@atmusic/core/scrobble-batch';
import type { ModuleDeps } from '../do/contracts';
import { admitForwardIdentity } from '../forward/projection';
import { enqueueForwards } from '../outbox/forward-enqueue';
import {
  IMPORT_PRIORITY,
  insertOperation,
  newOperationId,
  outboxCollections,
  type Prepared,
  prepare,
} from '../outbox/operations';

export interface BatchCandidate<T> {
  member: T;
  entry: ScrobbleBatchEntry;
}

export interface PackedBatch<T> {
  rkey: string;
  entries: ScrobbleBatchEntry[];
  members: T[];
  overflowMember: T | null;
  prepared: Prepared<ScrobbleBatchRecord> | null;
}

/** Pack and prepare the maximal exact-body prefix, stopping before overflow. */
export async function prepareImportBatchPrefix<T>(
  m: ModuleDeps,
  args: { did: string; now: number; candidates: readonly BatchCandidate<T>[] },
): Promise<PackedBatch<T>> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const collection = scrobbleBatchCollection(prefix);
  const rkey = newTid(m.clock, m.random);
  const envelope = { $type: collection, createdAt: new Date(args.now).toISOString() };
  const request = { repo: args.did, collection, rkey };
  const group = newBatchPrefix(scrobbleBatchSizer(envelope, request));
  let count = 0;
  for (const candidate of args.candidates) {
    if (!group.tryAdd(candidate.entry)) {
      if (count === 0) throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
      break;
    }
    count++;
  }
  const entries = [...group.entries];
  const overflow = args.candidates[count] ?? null;
  verifyBatchBoundary(entries, group.sizes(), overflow?.entry, {
    measure: (candidate) => measureScrobbleBatch({ ...envelope, listens: [...candidate] }, request),
  });
  const prepared =
    entries.length === 0 ? null : await prepare({ ...envelope, listens: entries } as ScrobbleBatchRecord);
  return {
    rkey,
    entries,
    members: args.candidates.slice(0, count).map((candidate) => candidate.member),
    overflowMember: overflow?.member ?? null,
    prepared,
  };
}

export interface BatchAdmissionMember {
  listenKey: string;
  listenSecond: number;
  forward: Record<string, unknown>;
  sourceService: 'lastfm' | 'listenbrainz' | null;
}

/** Insert the durable import batch and all member identity/provenance rows in the caller's transaction. */
export function acceptImportBatch(
  m: ModuleDeps,
  args: {
    did: string;
    now: number;
    rkey: string;
    prepared: Prepared<ScrobbleBatchRecord>;
    members: readonly BatchAdmissionMember[];
    operationId?: string;
    importJobId?: string | null;
  },
): string {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const operationId = args.operationId ?? newOperationId(m.random);
  const collection = outboxCollections(prefix).scrobbleBatch;
  insertOperation(
    m.db,
    {
      id: operationId,
      did: args.did,
      kind: 'scrobble.create',
      origin: 'import',
      priority: IMPORT_PRIORITY,
      collection,
      rkey: args.rkey,
      prepared: args.prepared,
      dueAt: args.now,
      importJobId: args.importJobId ?? null,
    },
    args.now,
  );
  for (const member of args.members) {
    m.db.run(
      `INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'import',?,?)`,
      args.did,
      member.listenKey,
      operationId,
      args.now,
      member.listenSecond,
    );
    const firstAdmission = admitForwardIdentity(m.db, {
      did: args.did,
      identityKey: member.listenKey,
      path: 'import',
      ...(member.sourceService === null ? {} : { sourceService: member.sourceService }),
      now: args.now,
    });
    if (firstAdmission && member.sourceService !== null)
      enqueueForwards(m.db, {
        did: args.did,
        items: [
          { kind: 'scrobble', listenKey: member.listenKey, payload: { listen: member.forward, origin: 'import' } },
        ],
        excludeSourceService: member.sourceService,
        now: args.now,
        random: m.random,
      });
  }
  return operationId;
}
