import type { Db } from '../do/db';

export type LinkGapReason = 'disabled' | 'revoked' | 'legacy';
export type CoverageLink = { id: string; generation: number };

export const ADMISSION_HIGH_WATER_SQL = `SELECT max(
     coalesce((SELECT next_seq FROM forward_admission_clock WHERE singleton=1),0),
     coalesce((SELECT max(admission_seq) FROM forward_admissions),0)
   ) AS boundary`;
export const NEWEST_LINK_GAP_SQL =
  'SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? AND generation=? ORDER BY from_seq DESC LIMIT 1';
export const GAP_ADMISSION_OWNER_SQL = `SELECT to_seq FROM forward_link_gaps
     WHERE link_id=? AND generation=? AND from_seq<? ORDER BY from_seq DESC LIMIT 1`;

/** Low-cardinality diagnostics for receipt and gap reconciliation. */
export function countLinkCoverage(db: Db, label: string, amount = 1): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('coverage counter amount must be non-negative');
  if (amount === 0) return;
  db.run(
    `INSERT INTO counters(name,label,value) VALUES('link_coverage',?,?)
     ON CONFLICT(name,label) DO UPDATE SET value=value+excluded.value`,
    label,
    amount,
  );
}

export function admissionHighWater(db: Db): number {
  return db.one<{ boundary: number }>(ADMISSION_HIGH_WATER_SQL)?.boundary ?? 0;
}

export function openLinkGap(
  db: Db,
  link: CoverageLink,
  reason: LinkGapReason,
  now: number,
  fromSeq = admissionHighWater(db),
): void {
  const newest = db.one<{ from_seq: number; to_seq: number | null }>(NEWEST_LINK_GAP_SQL, link.id, link.generation);
  if (newest?.to_seq === null) return;
  const safeFromSeq = Math.max(fromSeq, newest?.to_seq ?? newest?.from_seq ?? 0);
  db.run(
    `INSERT OR IGNORE INTO forward_link_gaps(link_id,generation,from_seq,reason,opened_at_ms)
     VALUES(?,?,?,?,?)`,
    link.id,
    link.generation,
    safeFromSeq,
    reason,
    now,
  );
}

export function closeOpenLinkGap(db: Db, link: CoverageLink, toSeq: number, now: number): boolean {
  const newest = db.one<{ from_seq: number; to_seq: number | null }>(NEWEST_LINK_GAP_SQL, link.id, link.generation);
  if (newest === null || newest.to_seq !== null) return false;
  if (toSeq <= newest.from_seq) {
    db.run(
      'DELETE FROM forward_link_gaps WHERE link_id=? AND generation=? AND from_seq=? AND to_seq IS NULL',
      link.id,
      link.generation,
      newest.from_seq,
    );
    return true;
  }
  db.run(
    `UPDATE forward_link_gaps SET to_seq=?,closed_at_ms=?
     WHERE link_id=? AND generation=? AND from_seq=? AND to_seq IS NULL`,
    toSeq,
    now,
    link.id,
    link.generation,
    newest.from_seq,
  );
  return true;
}

/** Close a real interval, or reconstruct a legacy interval after the last durable boundary. */
export function closeOrReconstructLinkGap(
  db: Db,
  link: CoverageLink & { generation_start_seq: number },
  toSeq: number,
  now: number,
): boolean {
  if (closeOpenLinkGap(db, link, toSeq, now)) return true;
  const newest = db.one<{ to_seq: number | null }>(NEWEST_LINK_GAP_SQL, link.id, link.generation);
  const fromSeq = Math.max(link.generation_start_seq, newest?.to_seq ?? 0);
  if (toSeq <= fromSeq) return false;
  openLinkGap(db, link, 'legacy', now, fromSeq);
  return closeOpenLinkGap(db, link, toSeq, now);
}

export function ownsAdmissionInGap(db: Db, link: CoverageLink, admissionSeq: number): boolean {
  const candidate = db.one<{ to_seq: number | null }>(GAP_ADMISSION_OWNER_SQL, link.id, link.generation, admissionSeq);
  return candidate !== null && candidate.to_seq !== null && admissionSeq <= candidate.to_seq;
}
