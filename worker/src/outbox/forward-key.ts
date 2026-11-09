import type { ForwardKind } from '../app/rows';
import type { Db } from '../do/db';

/** Stores generation 1 unchanged and namespaces later generations in the legacy unique key. */
export function storedForwardDedupeKey(generation: number, canonicalKey: string): string {
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new RangeError('generation must be a positive integer');
  return generation === 1 ? canonicalKey : `g${generation}:${canonicalKey}`;
}

/** Returns the canonical key only when the stored namespace matches this row's trusted generation. */
export function canonicalForwardDedupeKey(generation: number, storedKey: string): string | null {
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  if (generation === 1) return storedKey;
  const prefix = `g${generation}:`;
  return storedKey.startsWith(prefix) ? storedKey.slice(prefix.length) : null;
}

/** Removes an explicitly unsent identity from every current destination generation. */
export function deleteQueuedForwardIdentity(
  db: Db,
  did: string,
  kinds: readonly ForwardKind[],
  canonicalKey: string,
): void {
  if (kinds.length === 0) return;
  const links = db.all<{ id: string; generation: number }>(
    'SELECT id,generation FROM linked_accounts WHERE did=? ORDER BY id',
    did,
  );
  const kindSlots = kinds.map(() => '?').join(',');
  for (const link of links) {
    db.run(
      `DELETE FROM forward_outbox WHERE link_id=? AND generation=? AND kind IN (${kindSlots})
         AND dedupe_key=? AND state IN ('queued','held')`,
      link.id,
      link.generation,
      ...kinds,
      storedForwardDedupeKey(link.generation, canonicalKey),
    );
  }
}
