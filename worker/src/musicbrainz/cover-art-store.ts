import type { Db } from '../do/db';

export const COVER_ART_EVICTION_BATCH = 8;
export interface CoverArtRow {
  releaseMbid: string;
  mimeType: string;
  bytes: Uint8Array;
  byteSize: number;
  createdAtMs: number;
  fetchedAtMs: number;
  lastAccessMs: number;
}

/** Persistent local cover image cache and enqueue-only fetch jobs. LRU eviction is bounded per operation. */
export function enqueueCoverArt(db: Db, releaseMbid: string, releaseGroupMbid: string | null, nowMs: number): void {
  db.run(
    `INSERT INTO mb_cover_art_jobs(release_mbid,release_group_mbid,status,attempts,next_due_ms,created_at_ms)
    VALUES(?,?,'pending',0,?,?) ON CONFLICT(release_mbid) DO UPDATE SET release_group_mbid=excluded.release_group_mbid`,
    releaseMbid,
    releaseGroupMbid,
    nowMs,
    nowMs,
  );
}

export function getCoverArt(db: Db, releaseMbid: string, nowMs: number): CoverArtRow | null {
  return db.tx(() => {
    const row = db.one<Omit<CoverArtRow, 'bytes'> & { image_bytes: Uint8Array }>(
      'SELECT release_mbid AS releaseMbid,mime_type AS mimeType,image_bytes,byte_size AS byteSize,created_at_ms AS createdAtMs,fetched_at_ms AS fetchedAtMs,last_access_ms AS lastAccessMs FROM mb_cover_art WHERE release_mbid=?',
      releaseMbid,
    );
    if (!row) return null;
    db.run('UPDATE mb_cover_art SET last_access_ms=? WHERE release_mbid=?', nowMs, releaseMbid);
    return { ...row, bytes: new Uint8Array(row.image_bytes) };
  });
}

/** Inserts or replaces only when a bounded SQL eviction batch makes room. False means capacity defers this image. */
export function putCoverArt(
  db: Db,
  input: { releaseMbid: string; mimeType: string; bytes: Uint8Array; nowMs: number; budgetBytes: number },
): boolean {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType) ||
    input.bytes.byteLength > 512 * 1024 ||
    !Number.isSafeInteger(input.budgetBytes) ||
    input.budgetBytes < 0
  )
    return false;
  if (input.bytes.byteLength > input.budgetBytes) return false;
  return db.tx(() => {
    const prior =
      db.one<{ byte_size: number }>('SELECT byte_size FROM mb_cover_art WHERE release_mbid=?', input.releaseMbid)
        ?.byte_size ?? 0;
    let used =
      db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage WHERE singleton=1')?.used_bytes ?? 0;
    let needed = used - prior + input.bytes.byteLength - input.budgetBytes;
    if (needed > 0) {
      const victims = db.all<{ release_mbid: string; byte_size: number }>(
        'SELECT release_mbid,byte_size FROM mb_cover_art WHERE release_mbid<>? ORDER BY last_access_ms,release_mbid LIMIT ?',
        input.releaseMbid,
        COVER_ART_EVICTION_BATCH,
      );
      for (const victim of victims) {
        db.run('DELETE FROM mb_cover_art WHERE release_mbid=?', victim.release_mbid);
        used -= victim.byte_size;
        needed -= victim.byte_size;
        if (needed <= 0) break;
      }
      if (needed > 0) return false;
    }
    db.run(
      `INSERT INTO mb_cover_art(release_mbid,mime_type,image_bytes,byte_size,created_at_ms,fetched_at_ms,last_access_ms)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(release_mbid) DO UPDATE SET mime_type=excluded.mime_type,image_bytes=excluded.image_bytes,byte_size=excluded.byte_size,fetched_at_ms=excluded.fetched_at_ms,last_access_ms=excluded.last_access_ms`,
      input.releaseMbid,
      input.mimeType,
      input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer,
      input.bytes.byteLength,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    );
    db.run('UPDATE mb_cover_art_usage SET used_bytes=? WHERE singleton=1', used - prior + input.bytes.byteLength);
    return true;
  });
}

export function deleteCoverArt(db: Db, releaseMbid: string): void {
  db.tx(() => {
    const row = db.one<{ byte_size: number }>('SELECT byte_size FROM mb_cover_art WHERE release_mbid=?', releaseMbid);
    if (!row) return;
    db.run('DELETE FROM mb_cover_art WHERE release_mbid=?', releaseMbid);
    db.run('UPDATE mb_cover_art_usage SET used_bytes=used_bytes-? WHERE singleton=1', row.byte_size);
  });
}
