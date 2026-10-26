// The cron trigger (`*/5 * * * *`, ADR 0004 §4.2, §5.5, §5.9).
//
// Cron is not load-bearing: the IndexDO alarm drives every background task.
// Each tick calls `ensureRunning()` on the singleton (router.ts passes the
// `index-v1` stub), which
// - makes sure every periodic timer exists and the queue timers agree with
//   their queues,
// - re-arms the alarm at `min(due_at)`, so a lost or deleted alarm is back
//   within one tick, and
// - in `pulse` mode makes the `jetstream-watchdog` timer due now, so every
//   tick starts a pulse (connect from the cursor, drain to the live tail or
//   20 s, close; ADR §5.5). A pulse already in progress is joined, never
//   doubled (ingest-mode.ts). The effective mode is the DO's (the namespace
//   gate forces `off`), so the decision is made there.
// A failure is logged (error name only) and rethrown, so Workers Logs records
// the failed invocation; the next tick tries again.

import type { IndexRpc, Logger } from './do/contracts';

export async function scheduled(controller: ScheduledController, index: IndexRpc, log: Logger): Promise<void> {
  try {
    await index.ensureRunning();
  } catch (error) {
    log.log('error', 'cron.ensure_running_failed', {
      cron: controller.cron,
      error: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}
