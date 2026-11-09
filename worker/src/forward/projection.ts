import { createHash } from 'node:crypto';
import type { Db } from '../do/db';

export interface ForwardProvenance {
  path: 'api' | 'import' | 'live' | 'snapshot';
  sourceService: string | null;
}

function sourceServiceOf(source: string | null | undefined): string | null {
  if (source === 'lastfm_api' || source === 'lastfm_json') return 'lastfm';
  if (source === 'listenbrainz_api' || source === 'listenbrainz_zip') return 'listenbrainz';
  return null;
}

/** Existing durable acceptance/provenance, if this canonical identity predates the S1 admission migration. */
export function retainedForwardProvenance(db: Db, did: string, identityKey: string): ForwardProvenance | null {
  const admission = db.one<ForwardProvenance>(
    'SELECT path,source_service AS sourceService FROM forward_admissions WHERE did=? AND identity_key=?',
    did,
    identityKey,
  );
  if (admission !== null) return admission;

  const accepted = db.one<{ source: string; operation_id: string | null }>(
    'SELECT source,operation_id FROM listen_keys WHERE did=? AND dedupe_key=?',
    did,
    identityKey,
  );
  if (accepted !== null) {
    if (accepted.source !== 'import') return { path: 'api', sourceService: null };
    const job = accepted.operation_id
      ? db.one<{ source: string }>(
          `SELECT jobs.source FROM operations AS op JOIN import_jobs AS jobs ON jobs.id=op.import_job_id
           WHERE op.id=?`,
          accepted.operation_id,
        )
      : null;
    return { path: 'import', sourceService: sourceServiceOf(job?.source) };
  }
  return null;
}

/** Trusted path from a retained operation at one exact repository record. */
export function retainedRecordProvenance(
  db: Db,
  did: string,
  collection: string,
  rkey: string,
): ForwardProvenance | null {
  const operation = db.one<{ origin: string; source: string | null }>(
    `SELECT op.origin,jobs.source FROM operations AS op
     LEFT JOIN import_jobs AS jobs ON jobs.id=op.import_job_id
     WHERE op.did=? AND op.collection=? AND op.rkey=? ORDER BY op.created_at_ms DESC LIMIT 1`,
    did,
    collection,
    rkey,
  );
  if (operation === null) return null;
  return operation.origin === 'import'
    ? { path: 'import', sourceService: sourceServiceOf(operation.source) }
    : { path: 'api', sourceService: null };
}

/**
 * Seed a legacy projection identity before replacing its row. The caller passes
 * the old canonical key when available; absent provenance is conservatively
 * classified as snapshot whenever the URI/member already existed.
 */
export function admitProjectedIdentity(
  db: Db,
  args: {
    did: string;
    identityKey: string;
    priorIdentityKey?: string;
    provenance?: ForwardProvenance | null;
    legacyPresent: boolean;
    path: 'live' | 'snapshot';
    now: number;
  },
): boolean {
  const prior = args.priorIdentityKey ? retainedForwardProvenance(db, args.did, args.priorIdentityKey) : null;
  const retained = retainedForwardProvenance(db, args.did, args.identityKey);
  const conservative: ForwardProvenance = prior ??
    retained ??
    args.provenance ?? {
      path: args.legacyPresent ? 'snapshot' : args.path,
      sourceService: null,
    };
  if (args.priorIdentityKey && prior === null && args.priorIdentityKey !== args.identityKey)
    admitForwardIdentity(db, {
      did: args.did,
      identityKey: args.priorIdentityKey,
      path: conservative.path,
      sourceService: conservative.sourceService ?? undefined,
      now: args.now,
    });
  return admitForwardIdentity(db, {
    did: args.did,
    identityKey: args.identityKey,
    path: conservative.path,
    sourceService: conservative.sourceService ?? undefined,
    now: args.now,
  });
}

/** Synchronous equivalent of core listenKey, for use inside a projection transaction. */
export function projectionListenKey(did: string, listenedAt: string, artistKey: string, trackKey: string): string {
  const seconds = String(Math.floor(Date.parse(listenedAt) / 1000));
  const framed = [did, seconds, artistKey, trackKey].map((part) => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return createHash('sha256').update('atmusic:listen-key:v1', 'utf8').update(Buffer.concat(framed)).digest('hex');
}

export function admitForwardIdentity(
  db: Db,
  args: {
    did: string;
    identityKey: string;
    path: 'api' | 'import' | 'live' | 'snapshot';
    sourceService?: string;
    now: number;
  },
): boolean {
  return db.tx(() => {
    if (db.one('SELECT 1 AS hit FROM forward_admissions WHERE did=? AND identity_key=?', args.did, args.identityKey))
      return false;
    db.run('INSERT OR IGNORE INTO forward_admission_clock(singleton,next_seq) VALUES (1,0)');
    const sequence = db.one<{ next_seq: number }>(
      'UPDATE forward_admission_clock SET next_seq=next_seq+1 WHERE singleton=1 RETURNING next_seq',
    );
    if (sequence === null) throw new Error('forward admission sequence clock is missing');
    return (
      db.run(
        `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
         VALUES (?,?,?,?,?,?) ON CONFLICT(did,identity_key) DO NOTHING`,
        args.did,
        args.identityKey,
        args.path,
        args.sourceService ?? null,
        args.now,
        sequence.next_seq,
      ).rowsWritten === 1
    );
  });
}

/**
 * Release a listen admission when a never-sent local acceptance is withdrawn.
 * Live/snapshot admissions may represent an indexed identity or tombstone, and
 * removed batch import items retain their own tombstone in import_items.
 */
export function releaseForwardAdmission(db: Db, did: string, identityKey: string): boolean {
  const admission = db.one<{ path: string }>(
    'SELECT path FROM forward_admissions WHERE did=? AND identity_key=?',
    did,
    identityKey,
  );
  if (admission === null) return false;
  if (admission.path === 'live' || admission.path === 'snapshot') return false;
  if (db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND dedupe_key=? LIMIT 1', did, identityKey) !== null)
    return false;
  const lovePrefix = `love-uri:${did}:`;
  if (identityKey.startsWith(lovePrefix)) {
    const marker = identityKey.slice(lovePrefix.length);
    const separator = marker.lastIndexOf(':');
    if (separator > 0) {
      const uri = `at://${did}/${marker.slice(0, separator)}/${marker.slice(separator + 1)}`;
      if (
        db.one('SELECT 1 AS hit FROM record_state WHERE uri=? LIMIT 1', uri) !== null ||
        db.one('SELECT 1 AS hit FROM loves WHERE uri=? LIMIT 1', uri) !== null
      )
        return false;
    }
  }
  if (
    db.one(
      'SELECT 1 AS hit FROM import_items WHERE dedupe_key=? AND removed_at_ms IS NOT NULL LIMIT 1',
      identityKey,
    ) !== null
  )
    return false;
  return db.run('DELETE FROM forward_admissions WHERE did=? AND identity_key=?', did, identityKey).rowsWritten === 1;
}

/** Drop projection-only admission state during a DID opt-out, keeping local acceptance receipts. */
export function cleanupForwardAdmissionsForSuppression(db: Db, did: string): void {
  db.run(
    `DELETE FROM forward_admissions AS admission
     WHERE did=? AND NOT EXISTS (
       SELECT 1 FROM listen_keys AS key
       WHERE key.did=admission.did AND key.dedupe_key=admission.identity_key
     ) AND NOT EXISTS (
       SELECT 1 FROM import_items AS item
       WHERE item.dedupe_key=admission.identity_key AND item.removed_at_ms IS NOT NULL
     ) AND NOT EXISTS (
       SELECT 1 FROM operations AS op
       WHERE op.did=admission.did AND op.state!='cancelled' AND admission.identity_key=
         'love-uri:' || op.did || ':' || op.collection || ':' || coalesce(op.rkey,'')
     )`,
    did,
  );
  db.run(
    `DELETE FROM love_incarnations AS incarnation
     WHERE incarnation.uri LIKE ? AND NOT EXISTS (
       SELECT 1 FROM operations AS op WHERE op.did=? AND op.state!='cancelled'
         AND incarnation.uri='at://' || op.did || '/' || op.collection || '/' || coalesce(op.rkey,'')
     )`,
    `at://${did}/%`,
    did,
  );
  db.run(
    `DELETE FROM love_delete_bridges AS bridge
     WHERE bridge.did=? AND NOT EXISTS (
       SELECT 1 FROM operations AS op WHERE op.id=bridge.operation_id AND op.state!='cancelled'
     )`,
    did,
  );
  db.run(
    `DELETE FROM love_import_bridges AS bridge WHERE bridge.did=? AND NOT EXISTS (
       SELECT 1 FROM operations AS op WHERE op.id=bridge.operation_id AND op.state!='cancelled'
     )`,
    did,
  );
}
