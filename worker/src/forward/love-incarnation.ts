import type { Db } from '../do/db';
import {
  admitForwardIdentity,
  retainedForwardProvenance,
  retainedRecordProvenance,
} from './projection';

/** Reconstruct the durable identity for a legacy projected love. */
export function ensureLegacyLoveIncarnation(
  db: Db,
  args: {
    did: string;
    uri: string;
    collection: string;
    rkey: string;
    cid: string;
    nowMs: number;
    admitMarker: boolean;
  },
): { incarnation_key: string; state: string; path: string; source_service: string | null } | null {
  const retained =
    retainedForwardProvenance(db, args.did, `love-uri:${args.did}:${args.collection}:${args.rkey}`) ??
    retainedRecordProvenance(db, args.did, args.collection, args.rkey);
  const path = retained?.path ?? 'snapshot';
  const sourceService = retained?.sourceService ?? null;
  const incarnationKey = `love:${args.uri}:legacy:${args.cid}`;
  if (args.admitMarker)
    admitForwardIdentity(db, {
      did: args.did,
      identityKey: incarnationKey,
      path,
      sourceService: sourceService ?? undefined,
      now: args.nowMs,
    });
  db.run(
    `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
     VALUES (?,?,'present',?,?,?) ON CONFLICT(uri) DO NOTHING`,
    args.uri,
    incarnationKey,
    path,
    sourceService,
    args.nowMs,
  );
  return db.one(
    'SELECT incarnation_key,state,path,source_service FROM love_incarnations WHERE uri=?',
    args.uri,
  );
}
