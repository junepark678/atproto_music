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
