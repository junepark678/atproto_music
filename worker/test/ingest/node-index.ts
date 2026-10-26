// The Node harness of the ingest suites (ADR 0005 §15.1 step 2, N4-05).
// TEST-ONLY.
//
// The ingest suites ran inside the harness Durable Object (runInDurableObject
// over real DO SQLite). On Node they run over the production storage adapter
// directly: `withIngestIndex(fn)` opens a fresh, migrated temporary-file
// database through withMigratedDb (worker/test/node/support/node-db.ts, N1-01)
// and hands `fn` an IngestIndex:
//
//   i.db        the open SqliteDb (the frozen Db facade over node:sqlite);
//   i.storage   the AlarmStorage the timer multiplexer (runDue, armAlarm) arms,
//               standing in for the DO storage the suites passed before. It is
//               the object runDue keys its re-entrancy guard on, so it is one
//               object per "process" and is replaced by restart();
//   i.restart() the old evictDurableObject: closes the connection and opens
//               the same file again through reopen() (migrate runs again, as a
//               process restart does). Storage persists; in-memory state (the
//               open socket registry keyed by the old handle, the armed alarm)
//               does not.
//
// The database file, its WAL and the temporary directory are removed after
// `fn`, also when it throws. Each call gets its own file.
//
// INGEST_TEST_ENV is the environment the suites parse their AppConfig and
// cursor key from: the vars of the old test entry (wrangler.harness.jsonc),
// spelled out here so these suites read no Workers configuration.

import type { AlarmStorage } from '../../src/do/timers';
import type { EnvSecrets, EnvVars } from '../../src/env';
import type { SqliteDb } from '../../src/node/sqlite-db';
import { reopen, withMigratedDb } from '../node/support/node-db';

/** The test entry's vars and test-only cursor key (fixture prefix; never production values). */
export const INGEST_TEST_ENV: Readonly<EnvVars & Pick<EnvSecrets, 'CURSOR_KEY'>> = Object.freeze({
  PUBLIC_ORIGIN: 'https://music.example.test',
  LEXICON_PREFIX: 'com.example.atmusic',
  NAMESPACE_OWNERSHIP_REF: '',
  INGEST_MODE: 'off',
  JETSTREAM_URLS: 'wss://jetstream.example.test',
  JETSTREAM_LOOKBACK_HOURS: '24',
  RELAY_URL: 'https://relay.example.test',
  PLAN: 'paid',
  DO_LOCATION_HINT: '',
  // Test-only key material (32 bytes); never a production secret.
  CURSOR_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
});

/** An AlarmStorage that records what the timer multiplexer arms; nothing fires on its own. */
export class RecordingAlarm implements AlarmStorage {
  /** The armed alarm (epoch ms), or null. */
  at: number | null = null;
  /** Every setAlarm value, in order. */
  readonly armed: number[] = [];

  setAlarm(scheduledTime: number | Date): void {
    const ms = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    this.at = ms;
    this.armed.push(ms);
  }

  deleteAlarm(): void {
    this.at = null;
  }
}

export interface IngestIndex {
  /** The current handle (replaced by restart). */
  readonly db: SqliteDb;
  /** The current alarm storage (replaced by restart). */
  readonly storage: RecordingAlarm;
  /** Times restart() ran. */
  readonly restarts: number;
  /** Close the connection and reopen the same file, as a process restart does. */
  restart(): void;
}

/** Runs `fn` over a fresh migrated database file; see the header. */
export function withIngestIndex<T>(fn: (i: IngestIndex) => T | Promise<T>): Promise<T> {
  return withMigratedDb((first) => {
    let db = first;
    let storage = new RecordingAlarm();
    let restarts = 0;
    const index: IngestIndex = {
      get db() {
        return db;
      },
      get storage() {
        return storage;
      },
      get restarts() {
        return restarts;
      },
      restart() {
        db = reopen(db);
        storage = new RecordingAlarm();
        restarts++;
      },
    };
    return fn(index);
  });
}
