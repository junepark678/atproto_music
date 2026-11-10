import type { Db } from '../do/db';

export type LinkGapReason = 'disabled' | 'revoked' | 'legacy';
export type CoverageLink = { id: string; generation: number };

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
  return db.one<{ boundary: number }>('SELECT coalesce(max(admission_seq),0) AS boundary FROM forward_admissions')?.boundary ?? 0;
}

export function openLinkGap(db: Db, link: CoverageLink, reason: LinkGapReason, now: number, fromSeq = admissionHighWater(db)): void {
  db.run(
    `INSERT OR IGNORE INTO forward_link_gaps(link_id,generation,from_seq,reason,opened_at_ms)
     VALUES(?,?,?,?,?)`,
    link.id,
    link.generation,
    fromSeq,
    reason,
    now,
  );
}

export function closeOpenLinkGap(db: Db, link: CoverageLink, toSeq: number, now: number): boolean {
  const open = db.one<{ from_seq: number }>(
    'SELECT from_seq FROM forward_link_gaps WHERE link_id=? AND generation=? AND to_seq IS NULL ORDER BY from_seq DESC LIMIT 1',
    link.id,
    link.generation,
  );
  if (open === null) return false;
  if (toSeq <= open.from_seq) {
    db.run(
      'DELETE FROM forward_link_gaps WHERE link_id=? AND generation=? AND from_seq=? AND to_seq IS NULL',
      link.id,
      link.generation,
      open.from_seq,
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
    open.from_seq,
  );
  return true;
}

export function ownsAdmissionInGap(db: Db, link: CoverageLink, admissionSeq: number): boolean {
  return db.one<{ found: number }>(
    `SELECT 1 AS found FROM forward_link_gaps
     WHERE link_id=? AND generation=? AND from_seq<? AND (to_seq IS NULL OR to_seq>=?)
     ORDER BY from_seq DESC LIMIT 1`,
    link.id,
    link.generation,
    admissionSeq,
    admissionSeq,
  ) !== null;
}
