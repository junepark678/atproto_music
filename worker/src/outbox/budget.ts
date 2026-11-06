// The per-DID PDS point budget (ADR 0005 §5.8 "PDS point budget"; N2-05).
//
// A PDS limits repository writes per account: Bluesky documents 5,000 points
// per hour and 35,000 per day, with create 3, update 2 and delete 1 points.
// The budget is shared with the user's own activity in other apps, so the
// outbox keeps a ledger (`pds_budget`, one row per DID and window) and never
// sends what the ledger cannot afford:
//
// - Every write request is charged before it is sent (`chargePoints`), in the
//   same step that persists the attempt. A window starts at its first charge
//   and resets when it has run its length.
// - When a PDS answers with `RateLimit-Limit`, `-Remaining`, `-Reset` (and
//   `-Policy`), those headers win over the ledger (`observeRateLimit`): the
//   window named by the policy (`w=86400` the day, anything shorter the hour)
//   is set to `limit − remaining` points used, ending at the reset instant.
// - A 429 without those headers pauses the DID until `Retry-After`.
// - Live writes may use up to 90% of a window's limit. Imports may use the
//   account's `import_share_pct` (default 50%); that is the same rule as
//   "imports pause when RateLimit-Remaining < (1 − share) × limit", because
//   the ledger then holds `limit − remaining`.
// - `checkBudget` answers whether a write of `cost` points may be sent now,
//   or when the binding window ends. Nothing is ever sent before its
//   operation's `due_at` either (the runner selects only due rows).
//
// Synchronous; each writer is one statement or runs inside the caller's tx.

import type { PdsBudgetRow, PdsBudgetWindow } from '../app/rows';
import type { Db } from '../do/db';
import { IMPORT_PRIORITY } from './operations';

export const WRITE_COST = { create: 3, update: 2, delete: 1 } as const;

export const BUDGET_WINDOWS: readonly PdsBudgetWindow[] = ['hour', 'day'];
export const WINDOW_MS: Readonly<Record<PdsBudgetWindow, number>> = { hour: 3_600_000, day: 86_400_000 };
/** Bluesky's documented repository write limits. */
export const DEFAULT_LIMITS: Readonly<Record<PdsBudgetWindow, number>> = { hour: 5_000, day: 35_000 };

/** Live writes may use up to this share of a window's limit. */
export const LIVE_SHARE_PERCENT = 90;
export const DEFAULT_IMPORT_SHARE_PERCENT = 50;

/** One window as the budget sees it now. */
export interface WindowView {
  window: PdsBudgetWindow;
  limit: number;
  used: number;
  /** When the window ends (it restarts at the next charge); null when no window is open. */
  endsAtMs: number | null;
}

function windowRow(db: Db, did: string, window: PdsBudgetWindow): PdsBudgetRow | null {
  return db.one<PdsBudgetRow>('SELECT * FROM pds_budget WHERE did = ? AND window = ?', did, window);
}

function endOf(row: PdsBudgetRow): number {
  return row.reset_at_ms ?? row.window_start_ms + WINDOW_MS[row.window];
}

/** Both windows of `did` at `now`; an ended window counts as empty. */
export function budgetWindows(db: Db, did: string, now: number): WindowView[] {
  return BUDGET_WINDOWS.map((window) => {
    const row = windowRow(db, did, window);
    if (row === null || now >= endOf(row)) {
      return { window, limit: DEFAULT_LIMITS[window], used: 0, endsAtMs: null };
    }
    return { window, limit: row.limit_hint ?? DEFAULT_LIMITS[window], used: row.points, endsAtMs: endOf(row) };
  });
}

/** The account's import share of the budget, 10–90 % (default 50 %). */
export function importSharePercent(db: Db, did: string): number {
  const row = db.one<{ import_share_pct: number }>('SELECT import_share_pct FROM accounts WHERE did = ?', did);
  return row?.import_share_pct ?? DEFAULT_IMPORT_SHARE_PERCENT;
}

export function sharePercent(db: Db, did: string, priority: number): number {
  return priority >= IMPORT_PRIORITY ? importSharePercent(db, did) : LIVE_SHARE_PERCENT;
}

export type BudgetCheck = { ok: true; available: number } | { ok: false; available: number; resumeAtMs: number };

/**
 * May `cost` points be spent now by an operation of `priority`? `available`
 * is what the tightest window still allows that priority (a batch is sized
 * by it); when it is short, `resumeAtMs` is the end of the latest binding window.
 */
export function checkBudget(db: Db, did: string, priority: number, cost: number, now: number): BudgetCheck {
  const share = sharePercent(db, did, priority);
  let available = Number.POSITIVE_INFINITY;
  let resumeAtMs: number | null = null;
  for (const w of budgetWindows(db, did, now)) {
    const left = Math.floor((w.limit * share) / 100) - w.used;
    available = Math.min(available, left);
    if (left < cost) {
      // A window with no open row can only bind when its whole share is below the cost.
      const end = w.endsAtMs ?? now + WINDOW_MS[w.window];
      resumeAtMs = resumeAtMs === null ? end : Math.max(resumeAtMs, end);
    }
  }
  const avail = Math.max(0, available);
  return resumeAtMs === null ? { ok: true, available: avail } : { ok: false, available: avail, resumeAtMs };
}

/** Charges `points` to every window of `did` (opening a window that has ended). */
export function chargePoints(db: Db, did: string, points: number, now: number): void {
  if (!Number.isSafeInteger(points) || points <= 0) return;
  db.tx(() => {
    for (const window of BUDGET_WINDOWS) {
      const row = windowRow(db, did, window);
      if (row === null || now >= endOf(row)) {
        db.run(
          `INSERT INTO pds_budget(did, window, window_start_ms, points, limit_hint, remaining_hint, reset_at_ms)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT(did, window) DO UPDATE SET window_start_ms = excluded.window_start_ms,
             points = excluded.points, limit_hint = NULL, remaining_hint = NULL, reset_at_ms = NULL`,
          did,
          window,
          now,
          points,
        );
      } else {
        db.run(
          `UPDATE pds_budget SET points = points + ?,
             remaining_hint = CASE WHEN remaining_hint IS NULL THEN NULL ELSE max(0, remaining_hint - ?) END
           WHERE did = ? AND window = ?`,
          points,
          points,
          did,
          window,
        );
      }
    }
  });
}

const INTEGER = /^\s*(\d{1,15})\s*$/;

function headerInt(headers: Headers, name: string): number | null {
  const m = INTEGER.exec(headers.get(name) ?? '');
  return m === null ? null : Number(m[1]);
}

/** `RateLimit-Policy: 5000;w=3600` → the window it describes (hour unless w ≥ 1 day). */
function policyWindow(headers: Headers): PdsBudgetWindow {
  const m = /;\s*w=(\d{1,10})/.exec(headers.get('ratelimit-policy') ?? '');
  const seconds = m === null ? null : Number(m[1]);
  return seconds !== null && seconds * 1000 >= WINDOW_MS.day ? 'day' : 'hour';
}

/** RateLimit-Reset: epoch seconds (atproto PDSs) or, when small, delta seconds (the IETF draft). */
function resetMs(value: number, now: number): number {
  return value >= 1_000_000_000 ? value * 1000 : now + value * 1000;
}

function setWindow(
  db: Db,
  did: string,
  window: PdsBudgetWindow,
  limit: number,
  remaining: number,
  reset: number,
): void {
  db.run(
    `INSERT INTO pds_budget(did, window, window_start_ms, points, limit_hint, remaining_hint, reset_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(did, window) DO UPDATE SET window_start_ms = excluded.window_start_ms, points = excluded.points,
       limit_hint = excluded.limit_hint, remaining_hint = excluded.remaining_hint, reset_at_ms = excluded.reset_at_ms`,
    did,
    window,
    Math.max(0, reset - WINDOW_MS[window]),
    Math.max(0, limit - remaining),
    limit,
    remaining,
    reset,
  );
}

/**
 * Applies a PDS write response's rate-limit headers to the ledger (they win
 * over it). A 429 with only `retryAfterMs` exhausts the hour window until then.
 */
export function observeRateLimit(
  db: Db,
  did: string,
  response: { status: number; headers: Headers },
  now: number,
  retryAfterMs?: number,
): void {
  const limit = headerInt(response.headers, 'ratelimit-limit');
  const remaining = headerInt(response.headers, 'ratelimit-remaining');
  const reset = headerInt(response.headers, 'ratelimit-reset');
  if (limit !== null && remaining !== null && limit > 0) {
    const window = policyWindow(response.headers);
    const until = reset !== null ? resetMs(reset, now) : now + WINDOW_MS[window];
    if (until > now) setWindow(db, did, window, limit, Math.min(remaining, limit), until);
    return;
  }
  if (response.status === 429 && retryAfterMs !== undefined && retryAfterMs > 0) {
    const row = windowRow(db, did, 'hour');
    const lim = row?.limit_hint ?? DEFAULT_LIMITS.hour;
    setWindow(db, did, 'hour', lim, 0, now + retryAfterMs);
  }
}
