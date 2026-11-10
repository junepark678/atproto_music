import type { Db } from '../do/db';
import { storedForwardDedupeKey } from './forward-key';

export type ReceiptKind = 'scrobble' | 'love' | 'unlove';
export type LinkGeneration = { id: string; generation: number };

/** Distinguishes a live legacy row from coverage preserved after cleanup. */
export function forwardCoverage(
  db: Db,
  link: LinkGeneration,
  kind: ReceiptKind,
  canonicalKey: string,
): 'row' | 'retired' | 'stale' | 'none' {
  const receipt = db.one<{ retired_at_ms: number | null }>(
    'SELECT retired_at_ms FROM forward_receipts WHERE link_id=? AND generation=? AND kind=? AND dedupe_key=?',
    link.id,
    link.generation,
    kind,
    canonicalKey,
  );
  const row = db.one<{ present: number }>(
    'SELECT 1 AS present FROM forward_outbox WHERE link_id=? AND kind=? AND dedupe_key=?',
    link.id,
    kind,
    storedForwardDedupeKey(link.generation, canonicalKey),
  );
  if (row !== null) return 'row';
  if (receipt === null) return 'none';
  return receipt.retired_at_ms === null ? 'stale' : 'retired';
}

export function noteForwardReceipt(
  db: Db,
  link: LinkGeneration,
  kind: ReceiptKind,
  canonicalKey: string,
  now: number,
): void {
  db.run(
    `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
     VALUES(?,?,?,?,?) ON CONFLICT(link_id,generation,kind,dedupe_key) DO NOTHING`,
    link.id,
    link.generation,
    kind,
    canonicalKey,
    now,
  );
}

export function dropStaleReceipt(db: Db, link: LinkGeneration, kind: ReceiptKind, canonicalKey: string): void {
  db.run(
    'DELETE FROM forward_receipts WHERE link_id=? AND generation=? AND kind=? AND dedupe_key=? AND retired_at_ms IS NULL',
    link.id,
    link.generation,
    kind,
    canonicalKey,
  );
}

/** Release receipts before deleting an explicitly withdrawn queued/held outbox row. */
export function releaseUnsentReceipts(
  db: Db,
  link: LinkGeneration,
  kinds: readonly ReceiptKind[],
  canonicalKey: string,
): number {
  if (kinds.length === 0) return 0;
  const slots = kinds.map(() => '?').join(',');
  return db.run(
    `DELETE FROM forward_receipts WHERE link_id=? AND generation=? AND kind IN (${slots}) AND dedupe_key=?
     AND EXISTS (SELECT 1 FROM forward_outbox o WHERE o.link_id=forward_receipts.link_id AND o.kind=forward_receipts.kind
       AND o.dedupe_key=? AND o.state IN ('queued','held'))`,
    link.id,
    link.generation,
    ...kinds,
    canonicalKey,
    storedForwardDedupeKey(link.generation, canonicalKey),
  ).rowsWritten;
}
