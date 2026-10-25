// The revocation journal (ADR 0005 §14.5, B8; N1-08): every credential
// deletion is appended to $STATE_DIRECTORY/revocations.log before the deleting
// transaction commits, and a restore replays it onto the restored copy.
//
// The tests run the file implementation on a temporary directory and a real
// node:sqlite database. Faults come only through the injected JournalFs.
// Migration 2 (N1-10) is not a dependency of this package, so the credential
// tables are created here with the ADR §6.4 columns the replay touches.

import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileRevocations,
  type JournalFs,
  MemoryRevocations,
  parseRevocationLog,
  REVOCATION_LOG_NAME,
  RevocationJournalError,
  revocationLogPath,
} from '../../src/app/revocations';
import { hashTokenBlob, hashTokenHex } from '../../src/crypto/tokens';
import { checkParams, type Db, type SqlParam } from '../../src/do/db';

const nodeSqlite = sqlite as typeof sqlite & { Database?: typeof sqlite.DatabaseSync };
const SqliteDatabase = nodeSqlite.Database ?? sqlite.DatabaseSync;
type RawDb = InstanceType<typeof sqlite.DatabaseSync>;

const T0 = Date.parse('2026-01-15T12:00:00Z');
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';

const tempDirs: string[] = [];
const openDbs: RawDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-revocations-'));
  tempDirs.push(dir);
  return dir;
}

const bind = (p: SqlParam[]): (string | number | null | Uint8Array)[] =>
  p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));

/** A minimal `Db` over node:sqlite for this suite (N1-01's adapter is a sibling package). */
function openDb(path: string): Db & { raw: RawDb } {
  const raw = new SqliteDatabase(path);
  openDbs.push(raw);
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    raw,
    all<T>(sql: string, ...p: SqlParam[]): T[] {
      checkParams(p);
      return raw.prepare(sql).all(...bind(p)) as T[];
    },
    one<T>(sql: string, ...p: SqlParam[]): T | null {
      checkParams(p);
      return (raw.prepare(sql).get(...bind(p)) as T | undefined) ?? null;
    },
    run(sql: string, ...p: SqlParam[]) {
      checkParams(p);
      return { rowsWritten: Number(raw.prepare(sql).run(...bind(p)).changes) };
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      if (depth > 0) return fn() as T;
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn() as T;
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      } finally {
        depth--;
      }
    },
  };
}

/** The credential tables replay touches, with the ADR 0005 §6.4 columns. */
const SCHEMA = `
CREATE TABLE accounts (did TEXT PRIMARY KEY, username TEXT UNIQUE, oauth_status TEXT NOT NULL);
CREATE TABLE web_sessions (token_hash BLOB PRIMARY KEY, did TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
CREATE TABLE oauth_sessions (did TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, key_id TEXT NOT NULL,
  client_kid TEXT, generation INTEGER NOT NULL, last_refresh_ms INTEGER, status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE lastfm_tokens (token_hash TEXT PRIMARY KEY, api_key TEXT NOT NULL, did TEXT, state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
CREATE TABLE lastfm_sessions (id TEXT PRIMARY KEY, sk_hash TEXT UNIQUE NOT NULL, did TEXT NOT NULL,
  api_key TEXT NOT NULL, client_name TEXT, created_at_ms INTEGER NOT NULL, last_used_ms INTEGER);
CREATE TABLE lastfm_apps (api_key TEXT PRIMARY KEY, did TEXT NOT NULL, name TEXT NOT NULL,
  secret_ciphertext BLOB NOT NULL, key_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE app_passwords (id TEXT PRIMARY KEY, did TEXT NOT NULL, label TEXT NOT NULL, hash TEXT UNIQUE NOT NULL,
  created_at_ms INTEGER NOT NULL, last_used_ms INTEGER);
CREATE TABLE lb_tokens (id TEXT PRIMARY KEY, did TEXT NOT NULL, label TEXT NOT NULL, hash TEXT UNIQUE NOT NULL,
  created_at_ms INTEGER NOT NULL, last_used_ms INTEGER);
CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, did TEXT NOT NULL, service TEXT NOT NULL, remote_user TEXT,
  credential_ciphertext BLOB NOT NULL, key_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE (did, service));
CREATE TABLE forward_outbox (id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES linked_accounts (id) ON DELETE CASCADE, did TEXT NOT NULL, kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE scrobbles (uri TEXT PRIMARY KEY, did TEXT NOT NULL);
`;

const CIPHER = new Uint8Array([1, 2, 3]);

/** Two rows per credential table (alice and bob), one link each with a forward row, and unrelated rows. */
function seed(db: Db & { raw: RawDb }, writtenAt = T0 - 60_000): void {
  db.raw.exec(SCHEMA);
  const blob = CIPHER.slice().buffer;
  for (const [did, who] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
  ] as const) {
    db.run('INSERT INTO accounts VALUES (?, ?, ?)', did, who, 'active');
    db.run(
      'INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)',
      hashTokenBlob(`web-${who}-1`),
      did,
      writtenAt,
      T0 + 1,
      writtenAt,
    );
    db.run(
      'INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)',
      hashTokenBlob(`web-${who}-2`),
      did,
      writtenAt,
      T0 + 1,
      writtenAt,
    );
    db.run(
      'INSERT INTO oauth_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      did,
      blob,
      'e1',
      'k1',
      1,
      writtenAt,
      'active',
      writtenAt,
      writtenAt,
    );
    db.run(
      'INSERT INTO lastfm_tokens VALUES (?, ?, ?, ?, ?, ?)',
      `tok-${who}`,
      'K',
      did,
      'authorized',
      writtenAt,
      T0 + 1,
    );
    for (const n of [1, 2]) {
      db.run(
        'INSERT INTO lastfm_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
        `ls-${who}-${n}`,
        `skh-${who}-${n}`,
        did,
        'K',
        'Pano',
        writtenAt,
        null,
      );
      db.run(
        'INSERT INTO lastfm_apps VALUES (?, ?, ?, ?, ?, ?)',
        `app-${who}-${n}`,
        did,
        'mine',
        blob,
        'e1',
        writtenAt,
      );
      db.run(
        'INSERT INTO app_passwords VALUES (?, ?, ?, ?, ?, ?)',
        `ap-${who}-${n}`,
        did,
        'phone',
        `aph-${who}-${n}`,
        writtenAt,
        null,
      );
      db.run(
        'INSERT INTO lb_tokens VALUES (?, ?, ?, ?, ?, ?)',
        `lb-${who}-${n}`,
        did,
        'pc',
        `lbh-${who}-${n}`,
        writtenAt,
        null,
      );
    }
    for (const service of ['lastfm', 'listenbrainz']) {
      db.run(
        'INSERT INTO linked_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        `link-${who}-${service}`,
        did,
        service,
        who,
        blob,
        'e1',
        'active',
        writtenAt,
        writtenAt,
      );
      db.run(
        'INSERT INTO forward_outbox VALUES (?, ?, ?, ?, ?, ?)',
        `fw-${who}-${service}`,
        `link-${who}-${service}`,
        did,
        'scrobble',
        'd1',
        'queued',
      );
    }
    db.run('INSERT INTO scrobbles VALUES (?, ?)', `at://${did}/s/1`, did);
  }
}

/** Every row of every table, as sorted key strings, for whole-database comparisons. */
function snapshot(db: Db): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  for (const { name } of tables) {
    out[name] = db
      .all<Record<string, unknown>>(`SELECT * FROM ${name}`)
      .map((row) => JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)))
      .sort();
  }
  return out;
}

function ids(db: Db, table: string, column = 'id'): string[] {
  return db
    .all<Record<string, unknown>>(`SELECT ${column} AS v FROM ${table} ORDER BY 1`)
    .map((r) => (r.v instanceof Uint8Array ? Buffer.from(r.v).toString('hex') : String(r.v)));
}

/** node:fs with call logging, so a test can see every write and fsync and their order. */
function spyFs(overrides: Partial<JournalFs> = {}): { fs: JournalFs; calls: string[] } {
  const calls: string[] = [];
  const base: JournalFs = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    readFileSync: fs.readFileSync,
    writeSync: fs.writeSync,
    fsyncSync: fs.fsyncSync,
    ftruncateSync: fs.ftruncateSync,
    fchmodSync: fs.fchmodSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    constants: fs.constants,
  };
  const merged = { ...base, ...overrides };
  const spied: JournalFs = {
    ...merged,
    writeSync: ((...args: Parameters<typeof fs.writeSync>) => {
      calls.push(`write:${args[0]}`);
      return (merged.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof fs.writeSync,
    fsyncSync: (fd: number) => {
      calls.push(`fsync:${fd}`);
      merged.fsyncSync(fd);
    },
    ftruncateSync: (fd: number, len?: number) => {
      calls.push(`ftruncate:${fd}:${len}`);
      merged.ftruncateSync(fd, len);
    },
  };
  return { fs: spied, calls };
}

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').slice(0, -1);
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('revocation journal', () => {
  it('each record() appends one fsynced 0600 JSON line holding only kind, hash or id, DID and time, and a record() that fails to write throws before the caller commits', () => {
    const dir = tempDir();
    const path = revocationLogPath(dir);
    expect(path).toBe(join(dir, REVOCATION_LOG_NAME));
    expect(REVOCATION_LOG_NAME).toBe('revocations.log');
    const clock = fixedClock();
    const { fs: spied, calls } = spyFs();
    const journal = new FileRevocations({ path, clock, fs: spied });
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('');

    const secretToken = 'web-alice-1';
    const events = [
      // An extra property (here a raw secret) never reaches the file.
      { kind: 'web_session', hash: hashTokenHex(secretToken), did: ALICE, token: secretToken },
      { kind: 'lastfm_session', id: 'ls-alice-1', did: ALICE, sk: 'raw-session-key' },
      { kind: 'app_password', id: 'ap-alice-1', did: ALICE },
      { kind: 'lb_token', id: 'lb-alice-1', did: ALICE },
      { kind: 'lastfm_app', id: 'app-alice-1', did: ALICE, sharedSecret: 'raw-shared-secret' },
      { kind: 'linked_account', id: 'link-alice-lastfm', did: ALICE },
      { kind: 'oauth_session', did: ALICE },
      { kind: 'account_disconnect', did: BOB },
    ] as const;
    const expectedKeys: Record<string, string[]> = {
      web_session: ['kind', 'hash', 'did', 'at'],
      oauth_session: ['kind', 'did', 'at'],
      account_disconnect: ['kind', 'did', 'at'],
    };
    events.forEach((event, index) => {
      calls.length = 0;
      journal.record(event as never);
      const written = lines(path);
      expect(written).toHaveLength(index + 1);
      // Exactly one write sequence then an fsync of the same descriptor, last.
      const writes = calls.filter((c) => c.startsWith('write:'));
      expect(writes.length).toBeGreaterThanOrEqual(1);
      const fd = writes[0]?.split(':')[1];
      expect(calls.at(-1)).toBe(`fsync:${fd}`);
      const line = JSON.parse(written[index] as string) as Record<string, unknown>;
      expect(Object.keys(line)).toEqual(expectedKeys[event.kind] ?? ['kind', 'id', 'did', 'at']);
      expect(line.kind).toBe(event.kind);
      expect(line.did).toBe(event.did);
      expect(line.at).toBe(T0 + index * 1000);
      if ('hash' in event) expect(line.hash).toBe(event.hash);
      if ('id' in event) expect(line.id).toBe(event.id);
      clock.advance(1000);
    });
    const text = readFileSync(path, 'utf8');
    for (const secret of [secretToken, 'raw-session-key', 'raw-shared-secret']) expect(text).not.toContain(secret);
    expect(mode(path)).toBe(0o600);
    expect(journal.entries().map((e) => e.kind)).toEqual(events.map((e) => e.kind));

    // Invalid events are refused before anything is written.
    for (const bad of [
      { kind: 'web_session', hash: secretToken, did: ALICE },
      { kind: 'web_session', hash: hashTokenHex('x').toUpperCase(), did: ALICE },
      { kind: 'app_password', id: '', did: ALICE },
      { kind: 'app_password', id: 'a\nb', did: ALICE },
      { kind: 'app_password', id: 'ap', did: 'alice' },
      { kind: 'password_reset', id: 'x', did: ALICE },
    ]) {
      expect(() => journal.record(bad as never)).toThrow(RevocationJournalError);
    }
    expect(lines(path)).toHaveLength(events.length);
    journal.close();

    // A journal whose write fails (EIO) or whose fsync fails: record() throws
    // inside the caller's transaction, the DELETE rolls back, and the file
    // keeps no partial line.
    const db = openDb(join(dir, 'live.db'));
    seed(db);
    const before = snapshot(db);
    const failures: Partial<JournalFs>[] = [
      {
        writeSync: (() => {
          throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
        }) as unknown as typeof fs.writeSync,
      },
      {
        // A short write of 10 bytes, then EIO on the rest.
        writeSync: ((fd: number, buffer: Uint8Array, offset: number, _length: number, position: number) => {
          if (offset === 0) return fs.writeSync(fd, buffer, 0, 10, position);
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }) as unknown as typeof fs.writeSync,
      },
      {
        fsyncSync: (() => {
          throw Object.assign(new Error('EIO: fsync'), { code: 'EIO' });
        }) as unknown as typeof fs.fsyncSync,
      },
    ];
    for (const override of failures) {
      const sizeBefore = statSync(path).size;
      // Open with the real fs, then make writes fail.
      const real = spyFs();
      const failing = new FileRevocations({ path, clock, fs: real.fs });
      Object.assign(real.fs, override);
      let caught: unknown;
      try {
        db.tx(() => {
          db.run('DELETE FROM app_passwords WHERE id = ?', 'ap-bob-2');
          failing.record({ kind: 'app_password', id: 'ap-bob-2', did: BOB });
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RevocationJournalError);
      expect((caught as RevocationJournalError).reason).toBe('write_failed');
      // The deletion did not commit, and nothing else changed.
      expect(snapshot(db)).toEqual(before);
      expect(ids(db, 'app_passwords')).toContain('ap-bob-2');
      // The journal holds no torn line: exactly the earlier complete lines.
      expect(statSync(path).size).toBe(sizeBefore);
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
      expect(lines(path)).toHaveLength(events.length);
      Object.assign(real.fs, spyFs().fs);
      failing.close();
    }

    // With a healthy journal the same transaction commits, journal line first.
    const healthy = new FileRevocations({ path, clock });
    db.tx(() => {
      healthy.record({ kind: 'app_password', id: 'ap-bob-2', did: BOB });
      db.run('DELETE FROM app_passwords WHERE id = ?', 'ap-bob-2');
    });
    expect(ids(db, 'app_passwords')).not.toContain('ap-bob-2');
    expect(JSON.parse(lines(path).at(-1) as string)).toEqual({
      kind: 'app_password',
      id: 'ap-bob-2',
      did: BOB,
      at: clock.nowMs(),
    });
    healthy.close();
    expect(() => healthy.record({ kind: 'oauth_session', did: BOB })).toThrow(RevocationJournalError);

    // An existing journal with a wider mode is narrowed to 0600 when opened.
    const wide = join(dir, 'wide.log');
    writeFileSync(wide, '', { mode: 0o644 });
    fs.chmodSync(wide, 0o644);
    new FileRevocations({ path: wide, clock }).close();
    expect(mode(wide)).toBe(0o600);
  });

  it('replay() on a database copy deletes exactly the journaled web session, Last.fm session, app password, ListenBrainz token, issued app, linked account and OAuth session rows and leaves every other row', () => {
    const dir = tempDir();
    const livePath = join(dir, 'live.db');
    const live = openDb(livePath);
    seed(live);
    live.raw.close();
    const copyPath = join(dir, 'restore.tmp.db');
    fs.copyFileSync(livePath, copyPath);

    const clock = fixedClock();
    const journal = new FileRevocations({ path: revocationLogPath(dir), clock });
    journal.record({ kind: 'web_session', hash: hashTokenHex('web-alice-1'), did: ALICE });
    journal.record({ kind: 'lastfm_session', id: 'ls-alice-1', did: ALICE });
    journal.record({ kind: 'app_password', id: 'ap-alice-2', did: ALICE });
    journal.record({ kind: 'lb_token', id: 'lb-bob-1', did: BOB });
    journal.record({ kind: 'lastfm_app', id: 'app-bob-2', did: BOB });
    journal.record({ kind: 'linked_account', id: 'link-alice-lastfm', did: ALICE });
    journal.record({ kind: 'oauth_session', did: BOB });
    // A revocation of a row the copy never had deletes nothing.
    journal.record({ kind: 'lb_token', id: 'lb-created-after-backup', did: BOB });

    const copy = openDb(copyPath);
    const before = snapshot(copy);
    const summary = journal.replay(copy);
    expect(summary).toEqual({
      entries: 8,
      deleted: {
        web_sessions: 1,
        lastfm_sessions: 1,
        app_passwords: 1,
        lb_tokens: 1,
        lastfm_apps: 1,
        linked_accounts: 1,
        oauth_sessions: 1,
      },
    });

    const after = snapshot(copy);
    const removed = (table: string): string[] => before[table]?.filter((row) => !after[table]?.includes(row)) ?? [];
    // Every table either lost exactly the journaled row or is unchanged.
    expect(ids(copy, 'web_sessions', 'token_hash')).toEqual(
      ['web-alice-2', 'web-bob-1', 'web-bob-2'].map(hashTokenHex).sort(),
    );
    expect(ids(copy, 'lastfm_sessions')).toEqual(['ls-alice-2', 'ls-bob-1', 'ls-bob-2']);
    expect(ids(copy, 'app_passwords')).toEqual(['ap-alice-1', 'ap-bob-1', 'ap-bob-2']);
    expect(ids(copy, 'lb_tokens')).toEqual(['lb-alice-1', 'lb-alice-2', 'lb-bob-2']);
    expect(ids(copy, 'lastfm_apps', 'api_key')).toEqual(['app-alice-1', 'app-alice-2', 'app-bob-1']);
    expect(ids(copy, 'linked_accounts')).toEqual([
      'link-alice-listenbrainz',
      'link-bob-lastfm',
      'link-bob-listenbrainz',
    ]);
    expect(ids(copy, 'oauth_sessions', 'did')).toEqual([ALICE]);
    // The deleted link's forward rows cascade with it (ON DELETE CASCADE).
    expect(ids(copy, 'forward_outbox')).toEqual(['fw-alice-listenbrainz', 'fw-bob-lastfm', 'fw-bob-listenbrainz']);
    expect(removed('forward_outbox')).toHaveLength(1);
    for (const table of ['accounts', 'lastfm_tokens', 'scrobbles']) {
      expect(after[table], table).toEqual(before[table]);
    }
    for (const table of Object.keys(before)) {
      const expected = table === 'scrobbles' || table === 'accounts' || table === 'lastfm_tokens' ? 0 : 1;
      expect(removed(table), table).toHaveLength(expected);
    }

    // The live database the copy came from is untouched.
    const reopened = openDb(livePath);
    expect(snapshot(reopened)).toEqual(before);

    // Replaying again is idempotent.
    expect(journal.replay(copy).deleted).toEqual({
      web_sessions: 0,
      lastfm_sessions: 0,
      app_passwords: 0,
      lb_tokens: 0,
      lastfm_apps: 0,
      linked_accounts: 0,
      oauth_sessions: 0,
    });
    expect(snapshot(copy)).toEqual(after);
    journal.close();
  });

  it('replay keeps an OAuth session and a relinked account written after their revocation, and account_disconnect removes only the DID rows written before it', () => {
    const dir = tempDir();
    const clock = fixedClock();
    const journal = new MemoryRevocations(clock);
    journal.record({ kind: 'oauth_session', did: ALICE });
    journal.record({ kind: 'linked_account', id: 'link-alice-lastfm', did: ALICE });
    journal.record({ kind: 'account_disconnect', did: BOB });

    const db = openDb(join(dir, 'copy.db'));
    seed(db);
    // Alice signed in and relinked after the revocations; bob signed in again after his disconnect.
    db.run('UPDATE oauth_sessions SET updated_at_ms = ? WHERE did = ?', T0 + 5000, ALICE);
    db.run('UPDATE linked_accounts SET updated_at_ms = ? WHERE id = ?', T0 + 5000, 'link-alice-lastfm');
    db.run(
      'INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)',
      hashTokenBlob('web-bob-new'),
      BOB,
      T0 + 5000,
      T0 + 9000,
      T0 + 5000,
    );
    db.run('INSERT INTO app_passwords VALUES (?, ?, ?, ?, ?, ?)', 'ap-bob-new', BOB, 'new', 'aph-new', T0 + 5000, null);

    const summary = journal.replay(db);
    expect(summary.entries).toBe(3);
    expect(ids(db, 'oauth_sessions', 'did')).toEqual([ALICE]);
    expect(ids(db, 'linked_accounts')).toEqual(['link-alice-lastfm', 'link-alice-listenbrainz']);
    expect(ids(db, 'web_sessions', 'token_hash')).toEqual(
      ['web-alice-1', 'web-alice-2', 'web-bob-new'].map(hashTokenHex).sort(),
    );
    expect(ids(db, 'app_passwords')).toEqual(['ap-alice-1', 'ap-alice-2', 'ap-bob-new']);
    for (const table of ['lastfm_sessions', 'lb_tokens']) {
      expect(db.all<{ did: string }>(`SELECT DISTINCT did FROM ${table}`).map((r) => r.did)).toEqual([ALICE]);
    }
    expect(ids(db, 'lastfm_apps', 'api_key')).toEqual(['app-alice-1', 'app-alice-2']);
    expect(ids(db, 'lastfm_tokens', 'token_hash')).toEqual(['tok-alice']);
    expect(summary.deleted).toMatchObject({ oauth_sessions: 1, linked_accounts: 2, web_sessions: 2, app_passwords: 2 });
    // bob's index rows and account row are not credentials and stay.
    expect(ids(db, 'scrobbles', 'uri')).toEqual([`at://${ALICE}/s/1`, `at://${BOB}/s/1`]);
    expect(ids(db, 'accounts', 'did')).toEqual([ALICE, BOB]);

    // A copy without the credential tables fails as a whole and deletes nothing.
    const bare = openDb(join(dir, 'bare.db'));
    bare.raw.exec('CREATE TABLE web_sessions (token_hash BLOB PRIMARY KEY, did TEXT, created_at_ms INTEGER)');
    bare.run('INSERT INTO web_sessions VALUES (?, ?, ?)', hashTokenBlob('w'), ALICE, 0);
    const partial = new MemoryRevocations(clock);
    partial.record({ kind: 'web_session', hash: hashTokenHex('w'), did: ALICE });
    partial.record({ kind: 'app_password', id: 'ap', did: ALICE });
    expect(() => partial.replay(bare)).toThrow(/no such table/);
    expect(ids(bare, 'web_sessions', 'token_hash')).toEqual([hashTokenHex('w')]);
  });

  it('truncateBefore(t) keeps the events at or after t and a journal with a torn last line replays every complete line', () => {
    const dir = tempDir();
    const path = revocationLogPath(dir);
    const clock = fixedClock();
    const journal = new FileRevocations({ path, clock });
    journal.record({ kind: 'app_password', id: 'ap-alice-1', did: ALICE }); // T0
    clock.advance(1000);
    journal.record({ kind: 'lb_token', id: 'lb-alice-1', did: ALICE }); // T0 + 1000
    clock.advance(1000);
    journal.record({ kind: 'oauth_session', did: BOB }); // T0 + 2000

    expect(journal.truncateBefore(T0 + 1000)).toBe(1);
    expect(journal.entries()).toEqual([
      { kind: 'lb_token', id: 'lb-alice-1', did: ALICE, at: T0 + 1000 },
      { kind: 'oauth_session', did: BOB, at: T0 + 2000 },
    ]);
    expect(lines(path)).toHaveLength(2);
    expect(mode(path)).toBe(0o600);
    expect(fs.existsSync(`${path}.tmp`)).toBe(false);
    // Appends continue after the truncation, on the new file.
    clock.advance(1000);
    journal.record({ kind: 'lastfm_session', id: 'ls-bob-1', did: BOB }); // T0 + 3000
    expect(lines(path)).toHaveLength(3);
    // A boundary exactly at an entry's time keeps it; a later one drops everything earlier.
    expect(journal.truncateBefore(T0 + 2000)).toBe(1);
    expect(journal.entries().map((e) => e.at)).toEqual([T0 + 2000, T0 + 3000]);
    expect(journal.truncateBefore(T0)).toBe(0);
    expect(journal.entries()).toHaveLength(2);
    journal.close();

    // The in-memory journal truncates the same way.
    const memory = new MemoryRevocations(clock);
    memory.record({ kind: 'app_password', id: 'a', did: ALICE });
    clock.advance(10);
    memory.record({ kind: 'app_password', id: 'b', did: ALICE });
    expect(memory.truncateBefore(clock.nowMs())).toBe(1);
    expect(memory.entries().map((e) => ('id' in e ? e.id : null))).toEqual(['b']);

    // A crash mid-append leaves a torn last line.
    const tornPath = join(dir, 'torn.log');
    const complete =
      `${JSON.stringify({ kind: 'web_session', hash: hashTokenHex('web-alice-1'), did: ALICE, at: T0 })}\n` +
      `${JSON.stringify({ kind: 'app_password', id: 'ap-bob-1', did: BOB, at: T0 + 1 })}\n`;
    writeFileSync(tornPath, `${complete}{"kind":"lb_token","id":"lb-al`, { mode: 0o600 });
    expect(parseRevocationLog(readFileSync(tornPath, 'utf8'))).toMatchObject({ torn: true });

    const torn = new FileRevocations({ path: tornPath, clock });
    // Opening cut off the torn tail; every complete line is kept.
    expect(readFileSync(tornPath, 'utf8')).toBe(complete);
    expect(torn.entries()).toHaveLength(2);

    const db = openDb(join(dir, 'copy.db'));
    seed(db);
    const summary = torn.replay(db);
    expect(summary.entries).toBe(2);
    expect(summary.deleted).toEqual({ web_sessions: 1, app_passwords: 1 });
    expect(ids(db, 'app_passwords')).toEqual(['ap-alice-1', 'ap-alice-2', 'ap-bob-2']);
    // The torn line's token was never journaled completely, so it is not deleted.
    expect(ids(db, 'lb_tokens')).toContain('lb-alice-1');
    // The next append starts on a clean line.
    torn.record({ kind: 'lb_token', id: 'lb-alice-1', did: ALICE });
    expect(lines(tornPath).map((l) => JSON.parse(l).kind)).toEqual(['web_session', 'app_password', 'lb_token']);
    torn.close();

    // A torn line read without repair (a copy of the file) is ignored by the parser too.
    expect(parseRevocationLog(`${complete}{"kind":"lb`).entries).toHaveLength(2);
    // A complete line that is not a valid entry is corruption, never silently skipped.
    const corruptPath = join(dir, 'corrupt.log');
    writeFileSync(corruptPath, `${complete}{"kind":"lb_token","did":"${ALICE}","at":1}\n`, { mode: 0o600 });
    let caught: unknown;
    try {
      new FileRevocations({ path: corruptPath, clock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RevocationJournalError);
    expect((caught as RevocationJournalError).reason).toBe('corrupt');
    expect(() =>
      parseRevocationLog(`${complete}{"kind":"oauth_session","did":"${ALICE}","at":1,"token":"x"}\n`),
    ).toThrow(/unknown field/);
  });
});
