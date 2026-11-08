import { createHash } from 'node:crypto';
import type { Db } from '../do/db';

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
  return (
    db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms) VALUES (?,?,?,?,?)
     ON CONFLICT(did,identity_key) DO NOTHING`,
      args.did,
      args.identityKey,
      args.path,
      args.sourceService ?? null,
      args.now,
    ).rowsWritten === 1
  );
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
