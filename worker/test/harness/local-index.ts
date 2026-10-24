// Test-only IndexRpc adapter for HTTP handler tests (ADR 0004 §10.1).
//
// `makeLocalIndex(state, impl)` returns an IndexRpc whose methods run the given
// DO module functions inside the harness DO via runInDurableObject, against
// real DO SQLite, with deterministic dependencies (frozen clock, seeded
// random, a transport that refuses all network). Methods without an
// implementation reject, so a handler test cannot silently call something it
// did not wire.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type { Clock, Random } from '@atmusic/core/deps';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { type AppConfig, parseConfig } from '../../src/config';
import type { IndexRpc, Logger, LogLevel, ModuleDeps } from '../../src/do/contracts';
import { doDb } from '../../src/do/db';
import type { HarnessDO } from './harness-do';

/** A DO module function: `(m: ModuleDeps, ...rpcArgs)`, sync or async. */
export type ModuleImpl = {
  [K in keyof IndexRpc]?: (
    m: ModuleDeps,
    ...args: Parameters<IndexRpc[K]>
  ) => Awaited<ReturnType<IndexRpc[K]>> | ReturnType<IndexRpc[K]>;
};

export interface LocalIndexState {
  stub: DurableObjectStub<HarnessDO>;
  clock?: Clock;
  random?: Random;
  transport?: Transport;
  identity?: IdentityResolver;
  config?: AppConfig;
  log?: Logger;
}

export interface LocalIndexCall {
  method: keyof IndexRpc;
  args: unknown[];
}

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export type LocalIndex = IndexRpc & {
  /** Every RPC call, in order, implemented or not. */
  readonly calls: LocalIndexCall[];
  /** Every log line written by module functions through the default logger. */
  readonly logs: LogEntry[];
  /** Outbound requests attempted through the default (refusing) transport. */
  readonly networkAttempts: string[];
  readonly deps: Omit<ModuleDeps, 'db'>;
};

const METHODS: Record<keyof IndexRpc, true> = {
  ready: true,
  indexing: true,
  history: true,
  feed: true,
  lookup: true,
  recordStatus: true,
  stats: true,
  profile: true,
  following: true,
  followers: true,
  exportUser: true,
  resolveHandle: true,
  notify: true,
  ensureRunning: true,
  adminStatus: true,
  adminPitr: true,
};

export const INDEX_RPC_METHODS = Object.keys(METHODS) as (keyof IndexRpc)[];

export class NotWiredError extends Error {
  constructor(method: string) {
    super(`IndexRpc.${method} is not implemented by this local index`);
    this.name = 'NotWiredError';
  }
}

export function makeLocalIndex(state: LocalIndexState, impl: ModuleImpl): LocalIndex {
  const calls: LocalIndexCall[] = [];
  const logs: LogEntry[] = [];
  const networkAttempts: string[] = [];

  const refusingTransport: Transport = async (req) => {
    networkAttempts.push(req.url);
    throw new Error(`no network in tests: ${req.method} ${req.url}`);
  };
  const deps: Omit<ModuleDeps, 'db'> = {
    clock: state.clock ?? fixedClock(),
    random: state.random ?? seededRandom(1),
    transport: state.transport ?? refusingTransport,
    identity: state.identity ?? {
      resolveDid: async (did) => {
        throw new Error(`identity resolution not wired in this test: ${did}`);
      },
      resolveHandle: async (handle) => {
        throw new Error(`handle resolution not wired in this test: ${handle}`);
      },
    },
    config: state.config ?? parseConfig(env, { allowFixturePrefix: true }),
    log: state.log ?? {
      log(level, event, fields) {
        logs.push(fields === undefined ? { level, event } : { level, event, fields });
      },
    },
  };

  const index: Record<string, unknown> = { calls, logs, networkAttempts, deps };
  for (const method of INDEX_RPC_METHODS) {
    index[method] = async (...args: unknown[]) => {
      calls.push({ method, args });
      const fn = impl[method] as ((m: ModuleDeps, ...a: unknown[]) => unknown) | undefined;
      if (fn === undefined) throw new NotWiredError(method);
      return runInDurableObject(state.stub, async (_instance: HarnessDO, doState: DurableObjectState) =>
        fn({ ...deps, db: doDb(doState.storage) }, ...args),
      );
    };
  }
  return index as unknown as LocalIndex;
}
