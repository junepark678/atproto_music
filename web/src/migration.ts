/** Remove databases left by the browser OAuth/outbox client. */
export async function removeLegacyDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
  let databases: Array<{ name?: string }>;
  try {
    databases = await indexedDB.databases();
  } catch {
    return;
  }
  await Promise.all(databases
    .map(({ name }) => name)
    .filter((name): name is string => typeof name === 'string' && name.startsWith('atmusic'))
    .map((name) => new Promise<void>((resolve) => {
      let request: IDBOpenDBRequest;
      try { request = indexedDB.deleteDatabase(name); } catch { resolve(); return; }
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    })));
}
