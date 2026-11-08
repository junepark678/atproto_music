import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { MIGRATIONS, SCHEMA_VERSION, TABLE_CLASS, TABLES } from '../../src/do/schema';
import { deleteCoverArt, enqueueCoverArt, getCoverArt, putCoverArt } from '../../src/musicbrainz/cover-art-store';
import { openSqliteDb } from '../../src/node/sqlite-db';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(path: string) {
  return openSqliteDb(path, { create: true, busyTimeoutMs: 200 });
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cover-art-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = open(path);
  migrate(db);
  return { db, path };
}
const bytes = (n: number) => new Uint8Array(n).fill(7);
describe('cover art durable cache', () => {
  it('keeps M4 at migration 21 before the additive S1 migrations and classifies its tables as non-derived', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    expect(MIGRATIONS[20]?.name).toBe('cover_art_cache_and_jobs');
    expect(SCHEMA_VERSION).toBe(31);
    for (const table of ['mb_cover_art', 'mb_cover_art_jobs', 'mb_cover_art_usage'] as const) {
      expect(TABLES).toContain(table);
      expect(TABLE_CLASS[table]).toBe('non-derived');
    }
    expect(TABLES).toContain('link_backfill_items');
    expect(TABLE_CLASS.link_backfill_items).toBe('non-derived');
  });
  it('accounts for insert, replacement, LRU access and delete exactly', () => {
    const { db } = setup();
    try {
      enqueueCoverArt(db, 'a', 'g', 1);
      expect(
        putCoverArt(db, { releaseMbid: 'a', mimeType: 'image/png', bytes: bytes(4), nowMs: 2, budgetBytes: 10 }),
      ).toBe(true);
      expect(
        putCoverArt(db, { releaseMbid: 'a', mimeType: 'image/jpeg', bytes: bytes(6), nowMs: 3, budgetBytes: 10 }),
      ).toBe(true);
      expect(db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes).toBe(6);
      expect(getCoverArt(db, 'a', 9)?.lastAccessMs).toBe(3);
      expect(
        db.one<{ last_access_ms: number }>('SELECT last_access_ms FROM mb_cover_art WHERE release_mbid=?', 'a')
          ?.last_access_ms,
      ).toBe(9);
      deleteCoverArt(db, 'a');
      expect(db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes).toBe(0);
    } finally {
      db.close();
    }
  });
  it('rejects over-budget images and evicts stable oldest rows in bounded batches across reopen', () => {
    const { db, path } = setup();
    try {
      for (const [key, at] of [
        ['a', 1],
        ['b', 1],
        ['c', 2],
      ] as const)
        putCoverArt(db, { releaseMbid: key, mimeType: 'image/webp', bytes: bytes(4), nowMs: at, budgetBytes: 12 });
      expect(
        putCoverArt(db, { releaseMbid: 'huge', mimeType: 'image/png', bytes: bytes(11), nowMs: 4, budgetBytes: 10 }),
      ).toBe(false);
      expect(
        putCoverArt(db, { releaseMbid: 'd', mimeType: 'image/png', bytes: bytes(4), nowMs: 5, budgetBytes: 8 }),
      ).toBe(true);
      expect(
        db
          .all<{ release_mbid: string }>('SELECT release_mbid FROM mb_cover_art ORDER BY release_mbid')
          .map((r) => r.release_mbid),
      ).toEqual(['c', 'd']);
    } finally {
      db.close();
    }
    const reopened = open(path);
    try {
      expect(reopened.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes).toBe(8);
    } finally {
      reopened.close();
    }
  });
  it('rolls back image and usage counter together', () => {
    const { db } = setup();
    try {
      expect(() =>
        db.tx(() => {
          putCoverArt(db, {
            releaseMbid: 'rollback',
            mimeType: 'image/png',
            bytes: bytes(5),
            nowMs: 1,
            budgetBytes: 10,
          });
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(db.one('SELECT release_mbid FROM mb_cover_art WHERE release_mbid=?', 'rollback')).toBeNull();
      expect(db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes).toBe(0);
    } finally {
      db.close();
    }
  });
});
