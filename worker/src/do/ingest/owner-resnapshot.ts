// Periodic signed snapshots for locally owned accounts (G15).
//
// This deliberately reuses the existing full namespace snapshot walk. An
// hourly walk therefore gives the hot window hourly coverage and also sweeps
// old records hourly; that over-scan trades some PDS bandwidth for one simple,
// signed source of truth. No relay or remote endpoint is consulted here.

import type { Db } from '../db';
import { dueAt, schedule } from '../timers';
import { isSuppressed } from '../write/account-state';
import { admit, scheduleSnapshot } from './admission';
import { scheduleSnapshotTimer } from './snapshot-job';

export const OWNER_RESNAPSHOT_TIMER = 'owner-resnapshot' as const;
export const OWNER_RESNAPSHOT_INTERVAL_MS = 3_600_000;
export const OWNER_RESNAPSHOT_RETRY_MS = 60_000;
export const OWNER_RESNAPSHOT_BATCH = 50;
export const OWNER_RESNAPSHOT_REASON = 'owner_resnapshot';
const RECEIPT_COUNTER = 'owner_resnapshot_receipt';

export type OwnerResnapshotReport = { examined: number; accepted: number; refused: number; nextAt: number };

/** Seed the periodic wake only when one is missing; preserve recovered deadlines. */
export function ensureOwnerResnapshotTimer(db: Db, now: number, enabled: boolean): void {
  if (
    !enabled ||
    dueAt(db, OWNER_RESNAPSHOT_TIMER) !== null ||
    db.one('SELECT 1 AS x FROM timers WHERE name=?', `~running:${OWNER_RESNAPSHOT_TIMER}`) !== null
  )
    return;
  schedule(db, OWNER_RESNAPSHOT_TIMER, now);
}

/** One bounded, local-only admission/scheduling pass. Caller owns timer eligibility. */
export function runOwnerResnapshot(db: Db, now: number): OwnerResnapshotReport {
  return db.tx(() => {
    const owners = db.all<{ did: string; receipt: number | null }>(
      `SELECT a.did, c.value AS receipt
         FROM accounts a
         LEFT JOIN counters c ON c.name=? AND c.label=a.did
         LEFT JOIN users u ON u.did=a.did
        WHERE a.oauth_status='active'
          AND (u.did IS NULL OR (u.active=1 AND u.account_status='active'))
          AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.did=a.did)
          AND (c.value IS NULL OR c.value + ? <= ?)
        -- Known active owners need no admission token; let them progress even
        -- when older unknown owners are repeatedly refused by the shared cap.
        ORDER BY CASE WHEN u.did IS NOT NULL THEN 0 ELSE 1 END, COALESCE(c.value,0), a.did
        LIMIT ?`,
      RECEIPT_COUNTER,
      OWNER_RESNAPSHOT_INTERVAL_MS,
      now,
      OWNER_RESNAPSHOT_BATCH,
    );
    let accepted = 0;
    let refused = 0;
    for (const owner of owners) {
      let result: 'accepted' | 'refused' = 'refused';
      if (isSuppressed(db, owner.did)) continue;
      const user = db.one<{ did: string; active: number; account_status: string }>(
        'SELECT did, active, account_status FROM users WHERE did=?',
        owner.did,
      );
      if (user === null) {
        const admission = admit(db, owner.did, 'reconcile', now);
        result = admission.status === 'admitted' ? 'accepted' : 'refused';
      } else if (user.active === 1 && user.account_status === 'active') {
        const scheduled = scheduleSnapshot(db, owner.did, OWNER_RESNAPSHOT_REASON, now);
        result = scheduled.status === 'scheduled' || scheduled.status === 'already' ? 'accepted' : 'refused';
      }
      if (result === 'accepted') {
        accepted++;
        db.run(
          `INSERT INTO counters(name,label,value) VALUES(?,?,?)
           ON CONFLICT(name,label) DO UPDATE SET value=excluded.value`,
          RECEIPT_COUNTER,
          owner.did,
          now,
        );
      } else refused++;
    }

    // A refusal or the batch cap may leave due owners behind. Retry shortly;
    // otherwise wake at the next eligible owner's receipt deadline.
    const remainingDue =
      db.one<{ n: number }>(
        `SELECT count(*) AS n FROM accounts a
         LEFT JOIN counters c ON c.name=? AND c.label=a.did
         LEFT JOIN users u ON u.did=a.did
        WHERE a.oauth_status='active'
          AND (u.did IS NULL OR (u.active=1 AND u.account_status='active'))
          AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.did=a.did)
          AND (c.value IS NULL OR c.value + ? <= ?)`,
        RECEIPT_COUNTER,
        OWNER_RESNAPSHOT_INTERVAL_MS,
        now,
      )?.n ?? 0;
    const nextDue =
      db.one<{ next: number | null }>(
        `SELECT min(CASE WHEN c.value IS NULL THEN ? ELSE c.value + ? END) AS next
         FROM accounts a LEFT JOIN counters c ON c.name=? AND c.label=a.did
         LEFT JOIN users u ON u.did=a.did
        WHERE a.oauth_status='active'
          AND (u.did IS NULL OR (u.active=1 AND u.account_status='active'))
          AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.did=a.did)`,
        now + OWNER_RESNAPSHOT_INTERVAL_MS,
        OWNER_RESNAPSHOT_INTERVAL_MS,
        RECEIPT_COUNTER,
      )?.next ?? now + OWNER_RESNAPSHOT_INTERVAL_MS;
    const nextAt = refused > 0 || remainingDue > 0 ? now + OWNER_RESNAPSHOT_RETRY_MS : Math.max(now + 1, nextDue);
    schedule(db, OWNER_RESNAPSHOT_TIMER, nextAt, { force: true });
    if (accepted > 0) scheduleSnapshotTimer(db, now);
    return { examined: owners.length, accepted, refused, nextAt };
  });
}
