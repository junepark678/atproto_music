import type { Clock } from '@atmusic/core/deps';
import type { Db } from '../do/db';
import { CoverArtTransientError } from '../node/cover-art-client';
import {
  completeCoverArtJob,
  dueCoverArtJobs,
  nextCoverArtDue,
  putCoverArt,
  retryCoverArtJob,
} from './cover-art-store';

export interface CoverArtImage {
  bytes: Uint8Array;
  mimeType: string;
}
export type CoverArtFetcher = (releaseMbid: string, releaseGroupMbid?: string) => Promise<CoverArtImage | null>;

/** Bounded background slice. Network errors persist exponential retry state; capacity waits for a later cleanup slice. */
export async function runCoverArtJobs(
  options: {
    db: Db;
    clock: Clock;
    client: CoverArtFetcher;
    cacheBudgetBytes: number;
    enabled: boolean;
  },
  maxJobs = 2,
): Promise<{ processed: number; nextDueAt: number | null; cleanupPending: boolean }> {
  const { db, clock } = options;
  if (!options.enabled) return { processed: 0, nextDueAt: nextCoverArtDue(db), cleanupPending: false };
  const now = clock.nowMs();
  const jobs = dueCoverArtJobs(db, now, Math.max(0, Math.min(2, Math.trunc(maxJobs))));
  let processed = 0;
  let cleanupPending = false;
  for (const job of jobs) {
    try {
      const image = await options.client(job.releaseMbid, job.releaseGroupMbid ?? undefined);
      if (!image) {
        completeCoverArtJob(db, job.releaseMbid);
        processed++;
        continue;
      }
      const stored = putCoverArt(db, {
        releaseMbid: job.releaseMbid,
        mimeType: image.mimeType,
        bytes: image.bytes,
        nowMs: clock.nowMs(),
        budgetBytes: options.cacheBudgetBytes,
      });
      if (stored) {
        completeCoverArtJob(db, job.releaseMbid);
        processed++;
      } else {
        // A failed put can have evicted one fixed batch. Requeue without incrementing network attempts.
        db.run('UPDATE mb_cover_art_jobs SET next_due_ms=? WHERE release_mbid=?', now + 60_000, job.releaseMbid);
        cleanupPending = true;
      }
    } catch (error) {
      const due = retryCoverArtJob(db, job, clock.nowMs());
      if (error instanceof CoverArtTransientError && error.retryAfterMs !== undefined) {
        db.run(
          'UPDATE mb_cover_art_jobs SET next_due_ms=? WHERE release_mbid=?',
          Math.max(due, clock.nowMs() + error.retryAfterMs),
          job.releaseMbid,
        );
      }
      processed++;
    }
  }
  return { processed, nextDueAt: nextCoverArtDue(db), cleanupPending };
}
