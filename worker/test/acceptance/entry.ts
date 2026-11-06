// The acceptance composition factory (W6-01, ported to Node by N4-03; ADR 0005
// §15.1, §15.3). TEST-ONLY.
//
// It replaces the workerd test entry (a TestIndexDO whose only override was
// `buildDeps`): `acceptanceApp(label, …)` builds the production Node
// composition through the composition harness (worker/test/composition/
// support.ts) and overrides dependencies only through compose's options:
// - a frozen clock (each suite passes the fixture kit's fixedClock, which
//   support/seed.ts starts two minutes earlier so that seeding ends before the
//   reads, which all run at exactly 2026-01-15T12:00:00Z unless a test advances
//   it on purpose);
// - a seeded Random;
// - the fixture `routerTransport` (marked `fixture: true`, so the production
//   SafeFetch policy admits only the reserved fixture hosts and still runs its
//   DoH pre-check, redirect refusal and body caps);
// - the memoryLink Jetstream connector (worker/test/composition/jetstream.ts);
// - the fixture prefix: only because the harness passes the test-only
//   `allowFixturePrefix` option to parseNodeConfig, which run() never does
//   unless a test entry asks (security.test.ts shows production refuses it).
// Migration, compose, IndexCore, the timers, the core alarm, every route and
// every module are production code.
//
// What a test reads back from a live composition goes through
// `handle()` (the composition's ModuleDeps, its composition count, the core
// alarm's pending due time, and the statement recorder of the harness Db
// wrapper, which never changes a result). Nothing of it is reachable over
// HTTP: the route table is the production one (security.test.ts asserts it).

import type { Transport } from '@atmusic/atproto/transport';
import type { Random } from '@atmusic/core/deps';
import type { FixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import type { ModuleDeps } from '../../src/do/contracts';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import {
  type Harness,
  type HarnessOptions,
  harness,
  type RecordedStatement,
  resetControl,
} from '../composition/support';

export type { RecordedStatement };

export interface AcceptanceOptions {
  clock: FixedClock;
  transport: Transport;
  connectJetstream: ConnectJetstream;
  random?: Random;
  /** Environment overrides; INGEST_MODE is `socket` unless given. */
  env?: Record<string, string | undefined>;
  harness?: HarnessOptions;
}

/** What `handle()` gives a test about the live composition. */
export interface AcceptanceHandle {
  /** The dependencies the composition's IndexCore runs with (production modules use exactly these). */
  readonly deps: ModuleDeps;
  /** Compositions of this database file (1 + restarts). */
  readonly constructed: number;
  /** The core lane's pending alarm (wall-clock ms), or null. */
  readonly armed: number | null;
  /** Start recording every statement the composition's Db runs; returns the live log. */
  record(): RecordedStatement[];
  /** Stop recording; returns what was recorded. */
  stopRecording(): RecordedStatement[];
}

export interface AcceptanceApp {
  readonly harness: Harness;
  handle(): AcceptanceHandle;
}

export async function acceptanceApp(label: string, o: AcceptanceOptions): Promise<AcceptanceApp> {
  resetControl({
    clock: o.clock,
    random: o.random ?? seededRandom(5),
    transport: o.transport,
    connectJetstream: o.connectJetstream,
    env: { INGEST_MODE: 'socket', ...o.env },
  });
  const h = await harness(`acceptance-${label}`, o.harness);
  return {
    harness: h,
    handle: () => ({
      deps: h.core.deps,
      constructed: h.compositions,
      armed: h.coreAlarm(),
      record: () => h.startRecording(),
      stopRecording: () => h.stopRecording(),
    }),
  };
}
