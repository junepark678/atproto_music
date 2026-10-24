// The screens' handle on one signed-in DID's outbox (ADR 0004 §5.2, A12).
//
// It owns the `OutboxRunner` for the session and forwards every persisted
// change to subscribers, so a screen re-reads its rows when the runner moves
// an operation (queued → running → published → indexed, or failed). Every
// enqueue goes through the W2-07 builders (`enqueueScrobble`, …), which
// validate with @atmusic/core and persist the row before any attempt; a
// rejected input therefore never creates a row. After an enqueue the runner
// is woken so the write starts without waiting for its next timer.
//
// `autoStart` (the default in production) elects this tab as the DID's runner
// through Web Locks. Tests pass `autoStart: false` and drive
// `runner.runDue()` with the frozen clock themselves.

import type { AtUri, Did } from '@atmusic/core/api-types';
import type { Clock, Random } from '@atmusic/core/deps';
import type { PdsSession } from '../oauth/types';
import { type EnqueueDeleteResult, enqueueScrobbleDelete } from '../outbox/delete-ops';
import { enqueueFollow, enqueueUnfollow } from '../outbox/follow-ops';
import { type AppViewApi, type OutboxLocks, OutboxRunner, type Scheduler } from '../outbox/runner';
import { type EnqueueResult, enqueueScrobble } from '../outbox/scrobble-ops';
import { enqueueDisconnect, enqueueReconnect } from '../outbox/settings-ops';
import type { OutboxOperation, OutboxStore } from '../outbox/store';

export interface OutboxServiceDeps {
  store: OutboxStore;
  session: PdsSession;
  api: AppViewApi;
  clock: Clock;
  random: Random;
  /** The deployment's owned lexicon prefix (meta.lexiconPrefix). */
  prefix: string;
  /** Start the background runner now (default true). */
  autoStart?: boolean;
  locks?: OutboxLocks;
  scheduler?: Scheduler;
  onError?: (error: unknown) => void;
}

export class OutboxService {
  readonly did: Did;
  readonly prefix: string;
  readonly session: PdsSession;
  readonly store: OutboxStore;
  readonly runner: OutboxRunner;
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #onError: (error: unknown) => void;
  readonly #listeners = new Set<() => void>();

  constructor(deps: OutboxServiceDeps) {
    this.did = deps.session.did;
    this.prefix = deps.prefix;
    this.session = deps.session;
    this.store = deps.store;
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#onError = deps.onError ?? ((error) => console.error('outbox runner error', error));
    this.runner = new OutboxRunner({
      store: deps.store,
      session: deps.session,
      api: deps.api,
      clock: deps.clock,
      random: deps.random,
      prefix: deps.prefix,
      ...(deps.locks ? { locks: deps.locks } : {}),
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
      onChange: () => this.#emit(),
      onError: this.#onError,
    });
    if (deps.autoStart ?? true) this.start();
  }

  /** Elects this tab as the DID's runner (waits while another tab holds the lock). */
  start(): void {
    try {
      this.runner.start().catch(this.#onError);
    } catch (error) {
      // No Web Locks: rows stay queued; the screens show them as queued.
      this.#onError(error);
    }
  }

  /** Calls `listener` after every persisted change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The DID's operations, oldest first. */
  list(): Promise<OutboxOperation[]> {
    return this.store.list(this.did);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #enqueued<T extends { ok: boolean }>(result: T): T {
    if (result.ok) {
      this.#emit();
      this.runner.wake();
    }
    return result;
  }

  #base() {
    return { store: this.store, did: this.did, prefix: this.prefix, clock: this.#clock, random: this.#random };
  }

  /** Validates the form input with @atmusic/core and persists the create. */
  async scrobble(input: unknown): Promise<EnqueueResult> {
    return this.#enqueued(await enqueueScrobble({ ...this.#base(), input }));
  }

  async deleteScrobble(uri: AtUri): Promise<EnqueueDeleteResult> {
    return this.#enqueued(await enqueueScrobbleDelete({ ...this.#base(), uri }));
  }

  async follow(subject: Did): Promise<EnqueueResult> {
    return this.#enqueued(await enqueueFollow({ ...this.#base(), subject }));
  }

  async unfollow(subject: Did): Promise<EnqueueResult> {
    return this.#enqueued(await enqueueUnfollow({ ...this.#base(), subject }));
  }

  /** Writes `settings/self {indexing: "disabled"}` (the public opt-out record). */
  async disconnect(): Promise<EnqueueResult> {
    return this.#enqueued(await enqueueDisconnect(this.#base()));
  }

  /** Writes `settings/self {indexing: "enabled"}`. */
  async reconnect(): Promise<EnqueueResult> {
    return this.#enqueued(await enqueueReconnect(this.#base()));
  }

  /** Stops the runner (a running attempt finishes first). */
  async stop(): Promise<void> {
    await this.runner.stop();
    this.#listeners.clear();
  }
}

export function createOutboxService(deps: OutboxServiceDeps): OutboxService {
  return new OutboxService(deps);
}
