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
    VALUES(?,?,'pending',0,?,?) ON CONFLICT(release_mbid) DO UPDATE SET release_group_mbid=excluded.release_group_mbid,
      status=CASE WHEN mb_cover_art_jobs.status='complete' AND NOT EXISTS(SELECT 1 FROM mb_cover_art WHERE release_mbid=excluded.release_mbid) THEN 'pending' ELSE mb_cover_art_jobs.status END,
      next_due_ms=CASE WHEN mb_cover_art_jobs.status='complete' AND NOT EXISTS(SELECT 1 FROM mb_cover_art WHERE release_mbid=excluded.release_mbid) THEN excluded.next_due_ms ELSE mb_cover_art_jobs.next_due_ms END`,
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
      db.run('UPDATE mb_cover_art_usage SET used_bytes=? WHERE singleton=1', used);
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

export interface CoverArtJob {
  releaseMbid: string;
  releaseGroupMbid: string | null;
  attempts: number;
}
export function dueCoverArtJobs(db: Db, nowMs: number, limit: number): CoverArtJob[] {
  const jobs = db.all<CoverArtJob>(
    "SELECT release_mbid AS releaseMbid,release_group_mbid AS releaseGroupMbid,attempts FROM mb_cover_art_jobs WHERE status IN ('pending','failed') AND next_due_ms<=? ORDER BY next_due_ms,release_mbid LIMIT ?",
    nowMs,
    limit,
  );
  db.run("UPDATE mb_cover_art_jobs SET status='pending',attempts=0 WHERE status='failed' AND next_due_ms<=?", nowMs);
  return jobs;
}
export function completeCoverArtJob(db: Db, releaseMbid: string): void {
  db.run("UPDATE mb_cover_art_jobs SET status='complete' WHERE release_mbid=?", releaseMbid);
}
export function retryCoverArtJob(db: Db, job: CoverArtJob, nowMs: number): number {
  const attempts = job.attempts + 1;
  const nextDue = attempts >= 8 ? nowMs + 30 * 86_400_000 : nowMs + Math.min(60_000 * 2 ** (attempts - 1), 86_400_000);
  db.run(
    'UPDATE mb_cover_art_jobs SET status=?,attempts=?,next_due_ms=? WHERE release_mbid=?',
    attempts >= 8 ? 'failed' : 'pending',
    attempts,
    nextDue,
    job.releaseMbid,
  );
  return nextDue;
}
export function nextCoverArtDue(db: Db): number | null {
  return (
    db.one<{ due: number | null }>(
      "SELECT MIN(next_due_ms) AS due FROM mb_cover_art_jobs WHERE status IN ('pending','failed')",
    )?.due ?? null
  );
}

export function deleteCoverArt(db: Db, releaseMbid: string): void {
  db.tx(() => {
    const row = db.one<{ byte_size: number }>('SELECT byte_size FROM mb_cover_art WHERE release_mbid=?', releaseMbid);
    if (!row) return;
    db.run('DELETE FROM mb_cover_art WHERE release_mbid=?', releaseMbid);
    db.run('UPDATE mb_cover_art_usage SET used_bytes=used_bytes-? WHERE singleton=1', row.byte_size);
  });
}
