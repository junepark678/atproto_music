import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeLegacyDatabases } from '../src/migration';

describe('legacy storage migration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deletes only atmusic databases and settles on blocked deletes', async () => {
    const removed: string[] = [];
    const db = {
      databases: vi.fn().mockResolvedValue([{ name: 'atmusic-oauth' }, { name: 'other' }, { name: 'atmusic-outbox' }]),
      deleteDatabase: vi.fn((name: string) => {
        removed.push(name);
        const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => request.onblocked?.());
        return request;
      }),
    };
    vi.stubGlobal('indexedDB', db);
    await removeLegacyDatabases();
    expect(removed).toEqual(['atmusic-oauth', 'atmusic-outbox']);
    expect(db.databases).toHaveBeenCalledOnce();
  });

  it('does nothing when database enumeration is unavailable', async () => {
    const db = { deleteDatabase: vi.fn() };
    vi.stubGlobal('indexedDB', db);
    await expect(removeLegacyDatabases()).resolves.toBeUndefined();
    expect(db.deleteDatabase).not.toHaveBeenCalled();
  });
});
