// The revocation journal (ADR 0005 §14.5, B8; N1-08).
//
// Every revocation or deletion of a credential is appended here **before the
// transaction that deletes the row commits**: web session hashes (logout,
// logout-all; expiry is not journaled), Last.fm session ids, app password ids,
// ListenBrainz token ids, issued app keys, linked account ids, OAuth session
// DIDs and account disconnects. The journal lives outside the database, at
// `$STATE_DIRECTORY/revocations.log`, so a backup never contains it, and a
// restore of an older backup over an unreadable live database (`--accept-loss`,
// N4-02) replays it: each journaled revocation deletes its row again from the
// restored copy, and nothing revoked after the backup comes back.
//
// File format: one JSON object per line, holding only `kind`, then `hash` (web
// sessions) or `id` (the other credentials; none for oauth_session and
// account_disconnect), then `did` and `at` (epoch ms from the injected clock).
// It carries hashes and ids only, never a secret: the line is built field by
// field from the typed event, so an extra property on the event never reaches
// the file. Mode 0600, `fsync` after every append. A line torn by a crash (no
// final newline) is ignored on read and cut off when the journal is next
// opened; any complete line that does not parse is a RevocationJournalError,
// because silently skipping a revocation would resurrect a credential.
//
// `record` is synchronous on purpose: callers invoke it inside their `db.tx`
// callback (which must not await), after or before the DELETE, so a journal
// write that fails throws, the transaction rolls back, and the credential is
// never deleted without its journal entry.
//
// Replay time guards: rows that are deleted by a random, never-reused id or
// hash are deleted unconditionally. Rows keyed by something a later sign-in or
// relink can reuse (an OAuth session's DID, a linked account updated in place,
// everything of a DID on account_disconnect) are deleted only when they were
// last written at or before the event's `at`, so replaying an old revocation
// onto a newer backup never deletes a session created after it.

import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '@atmusic/core/deps';
import type { Db } from '../do/db';

export const REVOCATION_KINDS = Object.freeze([
  'web_session',
  'lastfm_session',
  'app_password',
  'lb_token',
  'lastfm_app',
  'linked_account',
  'oauth_session',
  'account_disconnect',
] as const);

export type RevocationKind = (typeof REVOCATION_KINDS)[number];

/** Kinds identified by our own random row id (or, for lastfm_app, the issued api_key). */
export type IdRevocationKind = 'lastfm_session' | 'app_password' | 'lb_token' | 'lastfm_app' | 'linked_account';

export type RevocationEvent =
  /** `hash`: 64 lowercase hex, SHA-256 of the session token (crypto/tokens.ts hashTokenHex). */
  | { kind: 'web_session'; hash: string; did: string }
  | { kind: IdRevocationKind; id: string; did: string }
  | { kind: 'oauth_session' | 'account_disconnect'; did: string };

/** A journaled event: the event plus the time it was recorded. */
export type RevocationEntry = RevocationEvent & { at: number };

/** The port credential and session modules (N2-03, N2-04, N2-09, N3-01, N3-08) depend on. */
export interface Revocations {
  /** Append one event, durably. Throws RevocationJournalError if it cannot; call it inside the deleting tx. */
  record(event: RevocationEvent): void;
  /** Every complete entry, oldest first. */
  entries(): RevocationEntry[];
  /** Delete every journaled row from `db` (a restored database copy), in one transaction. */
  replay(db: Db): ReplaySummary;
  /** Drop entries recorded before `ms`; keeps those at or after it. Returns how many were dropped. */
  truncateBefore(ms: number): number;
}

export type RevocationJournalErrorReason = 'invalid_event' | 'write_failed' | 'corrupt' | 'closed';

export class RevocationJournalError extends Error {
  constructor(
    readonly reason: RevocationJournalErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RevocationJournalError';
  }
}

export const REVOCATION_LOG_NAME = 'revocations.log';

/** `$STATE_DIRECTORY/revocations.log`. */
export function revocationLogPath(stateDirectory: string): string {
  return join(stateDirectory, REVOCATION_LOG_NAME);
}

// --- validation and the line format ----------------------------------------

const HASH_RE = /^[0-9a-f]{64}$/;
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;
const MAX_DID = 2048;
const MAX_ID = 256;
const ID_KINDS: readonly string[] = ['lastfm_session', 'app_password', 'lb_token', 'lastfm_app', 'linked_account'];

function invalid(message: string): RevocationJournalError {
  return new RevocationJournalError('invalid_event', message);
}

function checkDid(did: unknown): string {
  if (typeof did !== 'string' || did.length > MAX_DID || !DID_RE.test(did)) throw invalid('event did is not a DID');
  return did;
}

function checkId(id: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID || /[\u0000-\u001f\u007f]/.test(id)) {
    throw invalid(`event id must be 1-${MAX_ID} printable characters`);
  }
  return id;
}

function checkAt(at: unknown): number {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw invalid('event time is not epoch ms');
  return at;
}

/** Normalise an event (or a parsed line) to exactly the journaled fields, in file order. */
function normalise(value: unknown, at: number): RevocationEntry {
  if (typeof value !== 'object' || value === null) throw invalid('event must be an object');
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (typeof kind !== 'string' || !(REVOCATION_KINDS as readonly string[]).includes(kind)) {
    throw invalid('unknown revocation kind');
  }
  if (kind === 'web_session') {
    if (typeof v.hash !== 'string' || !HASH_RE.test(v.hash)) throw invalid('web_session hash must be 64 lowercase hex');
    return { kind, hash: v.hash, did: checkDid(v.did), at: checkAt(at) };
  }
  if (ID_KINDS.includes(kind)) {
    return { kind: kind as IdRevocationKind, id: checkId(v.id), did: checkDid(v.did), at: checkAt(at) };
  }
  return { kind: kind as 'oauth_session' | 'account_disconnect', did: checkDid(v.did), at: checkAt(at) };
}

/** The journal line of an entry: `{"kind",["hash"|"id"],"did","at"}` and a newline. */
export function formatRevocationLine(entry: RevocationEntry): string {
  const e = normalise(entry, entry.at);
  const line: Record<string, string | number> = { kind: e.kind };
  if ('hash' in e) line.hash = e.hash;
  if ('id' in e) line.id = e.id;
  line.did = e.did;
  line.at = e.at;
  return `${JSON.stringify(line)}\n`;
}

const ALLOWED_KEYS = new Set(['kind', 'hash', 'id', 'did', 'at']);

export interface ParsedJournal {
  entries: RevocationEntry[];
  /** True when the text ends with a partial line (a write torn by a crash), which is ignored. */
  torn: boolean;
  /** Byte length of the complete lines (where a repair truncates to). */
  completeBytes: number;
}

/** Parse journal text. Every complete line must be a valid entry; a final partial line is ignored. */
export function parseRevocationLog(text: string): ParsedJournal {
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const torn = complete.length !== text.length;
  const entries: RevocationEntry[] = [];
  const lines = complete.split('\n');
  lines.pop(); // the empty string after the final newline
  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new RevocationJournalError('corrupt', `revocation journal line ${index + 1} is not JSON`, { cause });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RevocationJournalError('corrupt', `revocation journal line ${index + 1} is not an object`);
    }
    for (const key of Object.keys(value)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new RevocationJournalError('corrupt', `revocation journal line ${index + 1} has an unknown field`);
      }
    }
    try {
      entries.push(normalise(value, (value as { at?: unknown }).at as number));
    } catch (cause) {
      throw new RevocationJournalError('corrupt', `revocation journal line ${index + 1} is not a valid entry`, {
        cause,
      });
    }
  });
  return { entries, torn, completeBytes: Buffer.byteLength(complete, 'utf8') };
}

// --- replay ----------------------------------------------------------------

/** Rows deleted per table, and how many entries were applied. */
export interface ReplaySummary {
  entries: number;
  deleted: Record<string, number>;
}

function hexToBlob(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out.buffer;
}

/** Tables a disconnect clears for its DID, with the column that says when each row was last written. */
const DISCONNECT_TABLES: readonly (readonly [table: string, writtenAt: string])[] = [
  ['web_sessions', 'created_at_ms'],
  ['lastfm_tokens', 'created_at_ms'],
  ['lastfm_sessions', 'created_at_ms'],
  ['app_passwords', 'created_at_ms'],
  ['lb_tokens', 'created_at_ms'],
  ['lastfm_apps', 'created_at_ms'],
  ['linked_accounts', 'updated_at_ms'],
  ['oauth_sessions', 'updated_at_ms'],
];

/**
 * Delete every journaled row from `db`, in one transaction (all or nothing).
 * Meant for a restored database copy (N4-02); a missing table is an error, so
 * a copy that was not migrated to the code's schema fails loudly.
 */
export function replayRevocations(db: Db, entries: readonly RevocationEntry[]): ReplaySummary {
  const deleted: Record<string, number> = {};
  const del = (table: string, sql: string, ...params: (string | number | ArrayBuffer)[]): void => {
    const n = db.all<{ one: number }>(`DELETE FROM ${table} WHERE ${sql} RETURNING 1 AS one`, ...params).length;
    deleted[table] = (deleted[table] ?? 0) + n;
  };
  db.tx(() => {
    for (const raw of entries) {
      const e = normalise(raw, raw.at);
      switch (e.kind) {
        case 'web_session':
          del('web_sessions', 'token_hash = ?', hexToBlob(e.hash));
          break;
        case 'lastfm_session':
          del('lastfm_sessions', 'id = ?', e.id);
          break;
        case 'app_password':
          del('app_passwords', 'id = ?', e.id);
          break;
        case 'lb_token':
          del('lb_tokens', 'id = ?', e.id);
          break;
        case 'lastfm_app':
          del('lastfm_apps', 'api_key = ?', e.id);
          break;
        case 'linked_account':
          // A relink may update the same row in place; only the revoked version goes.
          del('linked_accounts', 'id = ? AND updated_at_ms <= ?', e.id, e.at);
          break;
        case 'oauth_session':
          // A later sign-in stores a new session under the same DID; it stays.
          del('oauth_sessions', 'did = ? AND updated_at_ms <= ?', e.did, e.at);
          break;
        case 'account_disconnect':
          for (const [table, writtenAt] of DISCONNECT_TABLES) {
            del(table, `did = ? AND ${writtenAt} <= ?`, e.did, e.at);
          }
          break;
      }
    }
  });
  return { entries: entries.length, deleted };
}

// --- in-memory implementation (tests and callers' unit tests) ---------------

/** The journal held in memory, with the same validation and line format as the file. */
export class MemoryRevocations implements Revocations {
  private readonly lines: string[] = [];

  constructor(private readonly clock: Clock) {}

  record(event: RevocationEvent): void {
    this.lines.push(formatRevocationLine(normalise(event, this.clock.nowMs())));
  }

  entries(): RevocationEntry[] {
    return parseRevocationLog(this.lines.join('')).entries;
  }

  replay(db: Db): ReplaySummary {
    return replayRevocations(db, this.entries());
  }

  truncateBefore(ms: number): number {
    checkAt(ms);
    const kept = this.lines.filter((line) => (JSON.parse(line) as { at: number }).at >= ms);
    const dropped = this.lines.length - kept.length;
    this.lines.splice(0, this.lines.length, ...kept);
    return dropped;
  }

  /** The journal text, as the file implementation would hold it. */
  text(): string {
    return this.lines.join('');
  }
}

// --- file implementation ----------------------------------------------------

/** The node:fs calls the file journal makes; injectable so tests can fail a write or an fsync. */
export type JournalFs = Pick<
  typeof nodeFs,
  | 'openSync'
  | 'closeSync'
  | 'fstatSync'
  | 'readFileSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'ftruncateSync'
  | 'fchmodSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'constants'
>;

export interface FileRevocationsOptions {
  /** Usually revocationLogPath($STATE_DIRECTORY). */
  path: string;
  clock: Clock;
  fs?: JournalFs;
}

export const REVOCATION_LOG_MODE = 0o600;

/** The journal at `$STATE_DIRECTORY/revocations.log`: 0600, one fsynced JSON line per event. */
export class FileRevocations implements Revocations {
  private readonly fs: JournalFs;
  private readonly path: string;
  private readonly clock: Clock;
  private fd: number | null;
  private size: number;
  /** Set by close(); a null fd without it means a reopen is still owed (see requireFd). */
  private closed = false;
  /**
   * The length of the last acknowledged line, kept when a failed append could
   * not be cut off; the reopen cuts the file back to it (see record).
   */
  private cutTo: number | null = null;

  constructor(options: FileRevocationsOptions) {
    this.fs = options.fs ?? nodeFs;
    this.path = options.path;
    this.clock = options.clock;
    const opened = this.openFile();
    this.fd = opened.fd;
    this.size = opened.size;
  }

  /**
   * Open (creating 0600 if missing), force mode 0600, and cut off a torn final
   * line, or everything past `cutTo` (a line boundary) when that is given.
   */
  private openFile(cutTo: number | null = null): { fd: number; size: number } {
    const { O_RDWR, O_CREAT, O_NOFOLLOW } = this.fs.constants;
    const fd = this.fs.openSync(this.path, O_RDWR | O_CREAT | O_NOFOLLOW, REVOCATION_LOG_MODE);
    try {
      this.fs.fchmodSync(fd, REVOCATION_LOG_MODE);
      const text = this.fs.readFileSync(this.path, 'utf8');
      const parsed = parseRevocationLog(text);
      let size = this.fs.fstatSync(fd).size;
      const keep = cutTo === null ? parsed.completeBytes : Math.min(cutTo, parsed.completeBytes);
      if (keep < size) {
        this.fs.ftruncateSync(fd, keep);
        size = keep;
      }
      this.fs.fsyncSync(fd);
      this.syncDirectory();
      return { fd, size };
    } catch (error) {
      this.fs.closeSync(fd);
      throw error;
    }
  }

  private syncDirectory(): void {
    const dirFd = this.fs.openSync(dirname(this.path), 'r');
    try {
      this.fs.fsyncSync(dirFd);
    } finally {
      this.fs.closeSync(dirFd);
    }
  }

  /**
   * The open journal fd. After close() this throws `closed`. After a
   * truncation whose reopen failed (`fd` null, not closed), it reopens the file
   * at the path, so an append lands in the current journal or throws; it never
   * reaches a replaced inode.
   */
  private requireFd(): number {
    if (this.fd !== null) return this.fd;
    if (this.closed) throw new RevocationJournalError('closed', 'revocation journal is closed');
    let opened: { fd: number; size: number };
    try {
      opened = this.openFile(this.cutTo);
    } catch (cause) {
      if (cause instanceof RevocationJournalError) throw cause;
      throw new RevocationJournalError('write_failed', 'revocation journal could not be reopened', { cause });
    }
    this.fd = opened.fd;
    this.size = opened.size;
    this.cutTo = null;
    return opened.fd;
  }

  record(event: RevocationEvent): void {
    const line = Buffer.from(formatRevocationLine(normalise(event, this.clock.nowMs())), 'utf8');
    const fd = this.requireFd();
    let written = 0;
    try {
      while (written < line.length) {
        const n = this.fs.writeSync(fd, line, written, line.length - written, this.size + written);
        if (n <= 0) throw new Error('short write');
        written += n;
      }
      this.fs.fsyncSync(fd);
    } catch (cause) {
      // Cut off whatever part of the line reached the file, so it can never
      // merge with the next append; the caller's transaction rolls back.
      try {
        this.fs.ftruncateSync(fd, this.size);
        this.fs.fsyncSync(fd);
      } catch {
        // The failed bytes may still be in the file past this.size, as a torn
        // tail or as a complete line the caller rolled back. Appending at
        // this.size would then overwrite only their start and leave a non-JSON
        // line, so drop the fd instead: the next use reopens the file, cuts it
        // back to the last acknowledged line, and throws while that fails.
        this.cutTo = this.size;
        this.fd = null;
        try {
          this.fs.closeSync(fd);
        } catch {
          // The descriptor is released either way; it is never used again.
        }
      }
      throw new RevocationJournalError('write_failed', 'revocation journal append failed', { cause });
    }
    this.size += line.length;
  }

  entries(): RevocationEntry[] {
    this.requireFd();
    return parseRevocationLog(this.fs.readFileSync(this.path, 'utf8')).entries;
  }

  replay(db: Db): ReplaySummary {
    return replayRevocations(db, this.entries());
  }

  truncateBefore(ms: number): number {
    checkAt(ms);
    const all = this.entries();
    const kept = all.filter((e) => e.at >= ms);
    const text = kept.map(formatRevocationLine).join('');
    const tmp = `${this.path}.tmp`;
    const failed = (message: string, cause: unknown): RevocationJournalError =>
      new RevocationJournalError('write_failed', message, { cause });
    const removeTmp = (): void => {
      try {
        this.fs.unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
    };

    // 1. Write the kept entries to the tmp file, durably. Any failure removes
    //    it; the live journal is untouched and stays open.
    const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = this.fs.constants;
    let tmpFd: number;
    try {
      tmpFd = this.fs.openSync(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, REVOCATION_LOG_MODE);
    } catch (cause) {
      removeTmp();
      throw failed('revocation journal truncation failed', cause);
    }
    try {
      try {
        this.fs.fchmodSync(tmpFd, REVOCATION_LOG_MODE);
        const bytes = Buffer.from(text, 'utf8');
        let written = 0;
        while (written < bytes.length) {
          const n = this.fs.writeSync(tmpFd, bytes, written, bytes.length - written, written);
          if (n <= 0) throw new Error('short write');
          written += n;
        }
        this.fs.fsyncSync(tmpFd);
      } finally {
        this.fs.closeSync(tmpFd);
      }
    } catch (cause) {
      removeTmp();
      throw failed('revocation journal truncation failed', cause);
    }

    // 2. Replace the journal. A failed rename leaves the old file (and fd) in
    //    place and removes the tmp file.
    try {
      this.fs.renameSync(tmp, this.path);
    } catch (cause) {
      removeTmp();
      throw failed('revocation journal truncation failed', cause);
    }

    // 3. The old fd now refers to the replaced inode: drop it before anything
    //    else can throw, so no later append can reach it.
    const oldFd = this.fd;
    this.fd = null;
    if (oldFd !== null) {
      try {
        this.fs.closeSync(oldFd);
      } catch {
        // The descriptor is released either way; it is never used again.
      }
    }

    // 4. Make the rename durable and open the new file. If this fails the
    //    journal is left with no fd, and the next record() reopens the file at
    //    the path or throws.
    try {
      this.syncDirectory();
      const reopened = this.openFile();
      this.fd = reopened.fd;
      this.size = reopened.size;
    } catch (cause) {
      throw failed('revocation journal was truncated but could not be reopened', cause);
    }
    return all.length - kept.length;
  }

  close(): void {
    this.closed = true;
    if (this.fd === null) return;
    this.fs.closeSync(this.fd);
    this.fd = null;
  }
}
