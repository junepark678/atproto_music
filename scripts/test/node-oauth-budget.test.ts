import {
  createDeadline,
  OAUTH_LIVE_BUDGETS,
  OAUTH_LIVE_CAPTURE_TTL_MS,
  withBoundedRecovery,
} from '@atmusic/core/oauth-live-budget';
import { expect, test, vi } from 'vitest';
import { assertNoExistingFollow } from '../live/node_oauth_check.ts';

const MINUTE = 60_000;
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const PEER = 'did:plc:bcdefghijklmnopqrstuvwxy';
const COLLECTION = 'dev.pythonplayer123.music.follow';

test('capture TTL equals the sum of enforced app, recovery, CRUD, sign-out and handoff budgets', () => {
  expect(OAUTH_LIVE_BUDGETS.followEnumerationMs).toBe(20 * MINUTE);
  expect(OAUTH_LIVE_CAPTURE_TTL_MS).toBe(
    OAUTH_LIVE_BUDGETS.appPhaseMs +
      OAUTH_LIVE_BUDGETS.appCleanupMs +
      OAUTH_LIVE_BUDGETS.crudMs +
      OAUTH_LIVE_BUDGETS.crudCleanupMs +
      OAUTH_LIVE_BUDGETS.signOutMs +
      OAUTH_LIVE_BUDGETS.handoffMs,
  );
});

test('the aggregate maximum path stops writes at its shared deadline and still runs bounded recovery', async () => {
  let now = 0;
  const writes: string[] = [];
  let recoveryAttempted = false;
  await expect(
    withBoundedRecovery(
      async (deadline) => {
        const enumeration = createDeadline(20 * MINUTE, () => now);
        now += 19 * MINUTE;
        enumeration.assertActive();
        for (let operation = 0; operation < 8; operation++) {
          deadline.assertActive();
          writes.push(`operation-${operation}`);
          now += 4 * MINUTE;
        }
        // Independent proofs share the same phase budget. The final proof is
        // refused once the enumeration plus app-operation allowance is spent.
        for (let proof = 0; proof < 9; proof++) {
          deadline.assertActive();
          now += MINUTE;
        }
        deadline.assertActive();
      },
      async (deadline, runError) => {
        recoveryAttempted = true;
        expect(runError).toBeInstanceOf(Error);
        deadline.assertActive();
      },
      { appPhaseMs: 60 * MINUTE, appCleanupMs: 10 * MINUTE },
      () => now,
    ),
  ).rejects.toThrow('OAuth live phase deadline exceeded');
  expect(writes).toHaveLength(8);
  expect(recoveryAttempted).toBe(true);
});

test('fractional timeout budgets round up for Node timers but still expire exactly at the deadline', () => {
  let now = 1000;
  const deadline = createDeadline(10.5, () => now);

  expect(deadline.timeoutMs(30)).toBe(11);
  now = 1010;
  expect(deadline.timeoutMs(30)).toBe(1);
  now = 1010.5;
  expect(() => deadline.timeoutMs(30)).toThrow('OAuth live phase deadline exceeded');
});

test('a late run callback cannot pass and recovery gets a fresh bounded deadline', async () => {
  let now = 1000;
  const writes: string[] = [];
  let recoveryDeadline: ReturnType<typeof createDeadline> | undefined;
  await expect(
    withBoundedRecovery(
      async (deadline) => {
        deadline.assertActive();
        writes.push('before expiry');
        now = 1500;
        return 'late result';
      },
      async (deadline, runError) => {
        recoveryDeadline = deadline;
        expect(runError).toBeInstanceOf(Error);
        expect((runError as Error).message).toBe('OAuth live phase deadline exceeded');
        deadline.assertActive();
        now += 250;
        deadline.assertActive();
      },
      { appPhaseMs: 400, appCleanupMs: 400 },
      () => now,
    ),
  ).rejects.toThrow('OAuth live phase deadline exceeded');
  expect(writes).toEqual(['before expiry']);
  expect(recoveryDeadline?.remainingMs()).toBe(150);
});

test('recovery that resolves after its fresh cleanup budget fails closed', async () => {
  let now = 1000;
  await expect(
    withBoundedRecovery(
      async () => 'on time',
      async (deadline) => {
        deadline.assertActive();
        now = 1500;
      },
      { appPhaseMs: 400, appCleanupMs: 400 },
      () => now,
    ),
  ).rejects.toThrow('OAuth live phase deadline exceeded');
});

test('slow follow enumeration stops inside its phase deadline', async () => {
  let now = 0;
  let requests = 0;
  const fetch = vi.fn(async () => {
    requests += 1;
    now += MINUTE;
    return Response.json({ records: [], cursor: `cursor-${requests}` });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(
      assertNoExistingFollow(
        'https://pds.test',
        DID,
        COLLECTION,
        PEER,
        createDeadline(60 * MINUTE, () => now),
      ),
    ).rejects.toThrow('OAuth live phase deadline exceeded');
    expect(now).toBe(20 * MINUTE);
    expect(requests).toBe(20);
  } finally {
    vi.unstubAllGlobals();
  }
});
