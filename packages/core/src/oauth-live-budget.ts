/** Hard limits shared by the host capture and the Node OAuth live gate. */
export const OAUTH_LIVE_BUDGETS = {
  appPhaseMs: 60 * 60_000,
  followEnumerationMs: 20 * 60_000,
  appCleanupMs: 10 * 60_000,
  crudMs: 10 * 60_000,
  crudCleanupMs: 4 * 60_000,
  signOutMs: 5 * 60_000,
  handoffMs: 60_000,
} as const;

/** Capture lifetime is the sum of enforced post-capture phases and a handoff margin. */
export const OAUTH_LIVE_CAPTURE_TTL_MS =
  OAUTH_LIVE_BUDGETS.appPhaseMs +
  OAUTH_LIVE_BUDGETS.appCleanupMs +
  OAUTH_LIVE_BUDGETS.crudMs +
  OAUTH_LIVE_BUDGETS.crudCleanupMs +
  OAUTH_LIVE_BUDGETS.signOutMs +
  OAUTH_LIVE_BUDGETS.handoffMs;

export interface Deadline {
  remainingMs(): number;
  limited(timeoutMs: number): Deadline;
  assertActive(): void;
  timeoutMs(maxMs: number): number;
  timeout(ms: number): AbortSignal;
}

/** An in-flight operation could not be stopped, so starting recovery may be unsafe. */
export class UnsafeRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRecoveryError';
  }
}

/** A phase deadline that can only shorten nested request timers. */
export function createDeadline(timeoutMs: number, now: () => number = () => performance.now()): Deadline {
  const expiresAt = now() + timeoutMs;
  const remainingMs = () => Math.max(0, expiresAt - now());
  return {
    remainingMs,
    limited(limitMs) {
      const remaining = remainingMs();
      if (remaining <= 0) throw new Error('OAuth live phase deadline exceeded');
      return createDeadline(Math.min(limitMs, remaining), now);
    },
    assertActive() {
      if (remainingMs() <= 0) throw new Error('OAuth live phase deadline exceeded');
    },
    timeoutMs(maxMs) {
      const remaining = remainingMs();
      if (remaining <= 0) throw new Error('OAuth live phase deadline exceeded');
      return Math.max(1, Math.min(maxMs, Math.ceil(remaining)));
    },
    timeout(ms) {
      const remaining = remainingMs();
      if (remaining <= 0) throw new Error('OAuth live phase deadline exceeded');
      return AbortSignal.timeout(Math.max(1, Math.min(ms, Math.ceil(remaining))));
    },
  };
}

/** Run acceptance and, when safe, recovery against a fresh cleanup budget. */
export async function withBoundedRecovery<T>(
  run: (deadline: Deadline) => Promise<T>,
  recover: (deadline: Deadline, runError: unknown | null) => Promise<void>,
  budgets: Pick<typeof OAUTH_LIVE_BUDGETS, 'appPhaseMs' | 'appCleanupMs'> = OAUTH_LIVE_BUDGETS,
  now: () => number = () => performance.now(),
): Promise<T> {
  let result: T;
  let runError: unknown | null = null;
  try {
    const runDeadline = createDeadline(budgets.appPhaseMs, now);
    result = await run(runDeadline);
    // A callback may resolve after its last awaited operation and otherwise
    // make a late result look like a successful acceptance phase.
    runDeadline.assertActive();
  } catch (error) {
    runError = error;
    result = undefined as T;
  }
  let recoveryError: unknown | null = null;
  if (!(runError instanceof UnsafeRecoveryError)) {
    const recoveryDeadline = createDeadline(budgets.appCleanupMs, now);
    try {
      await recover(recoveryDeadline, runError);
      recoveryDeadline.assertActive();
    } catch (error) {
      recoveryError = error;
    }
  }
  if (runError !== null) throw runError;
  if (recoveryError !== null) throw recoveryError;
  return result;
}
