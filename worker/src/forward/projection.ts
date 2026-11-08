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
