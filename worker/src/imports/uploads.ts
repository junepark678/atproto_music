// Import uploads (ADR 0005 §11.1, §13; N3-09): receiving them on disk,
// their lifetime, and their bounded streaming parse.
//
// Receiving (`receiveUpload`):
// - the body (≤ UPLOAD_LIMIT_BYTES, 64 MiB) is streamed to
//   `ATMUSIC_UPLOAD_DIR/<job>.upload`, created exclusively with mode 0600 in a
//   0700 directory; it is never held in memory;
// - before anything is written: the directory's bytes plus the declared
//   length must stay within ATMUSIC_UPLOAD_MAX_BYTES and the filesystem must
//   keep ATMUSIC_MIN_FREE_BYTES free, else 507 `insufficient_storage`;
// - while streaming, the bytes actually received are counted against the same
//   bounds (free space re-read every FREE_CHECK_BYTES) and against 64 MiB
//   (413); any refusal or a client abort deletes the partial file.
//
// Lifetime: the file is deleted as soon as it is fully parsed into staging,
// and when its job is cancelled or fails (`deleteUpload`, upload_path NULL);
// `sweepOrphanUploads` (at startup) deletes every file of the directory that
// no live job references.
//
// Parsing (`parseUpload`), streaming only, in a deterministic entry order so
// a resumed parse can skip what it already staged:
// - `lastfm_json` (the lastfm.ghan.nl export): a top-level JSON array of
//   getRecentTracks pages, split into pages by a depth-tracking tokenizer
//   (strings and escapes respected); each page (≤ MAX_PAGE_BYTES) is parsed
//   alone and its rows mapped like API rows (lastfm-source.ts).
// - `listenbrainz_zip`: the export ZIP read through zip.ts's bounds. Entries
//   `listens/<YYYY>/<M>.jsonl` are split line by line (a line over 1 MiB is
//   invalid, `line_too_long`); `user.json` is accepted and ignored; anything
//   else is skipped unread. Record MBIDs come from
//   `track_metadata.additional_info` only (mapListenBrainzListen);
//   `mbid_mapping` (null or an object) is used only to resolve feedback.
//   `feedback.jsonl` rows carry no names, so they are resolved after every
//   listens entry: a `recording_msid` maps to the newest archive listen with
//   that msid; otherwise a `recording_mbid` maps to the newest archive listen
//   whose `mbid_mapping.recording_mbid` or `additional_info.recording_mbid`
//   equals it. Score 1 → a love entry; 0 and −1 → skipped; unresolved → invalid
//   `feedback_unresolved`.

import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../do/db';
import { mapLastfmRow, pageTracks } from './lastfm-source';
import { listenedAtSeconds, mapListenBrainzRow } from './listenbrainz-source';
import type { ParsedEntry } from './staging';
import { readZip } from './zip';

export const UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;
export const FREE_CHECK_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const UPLOAD_SUFFIX = '.upload';

export type UploadKind = 'lastfm_json' | 'listenbrainz_zip';

/** Where uploads live; the default reads and deletes real files. Fault injection goes through this interface. */
export interface UploadStore {
  read(path: string): AsyncIterable<Uint8Array>;
  remove(path: string): Promise<void>;
}

export const fsUploadStore: UploadStore = {
  read(path) {
    return createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>;
  },
  async remove(path) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  },
};

export function uploadPathFor(dir: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new RangeError('invalid job id');
  return join(dir, `${jobId}${UPLOAD_SUFFIX}`);
}

/** Bytes of the regular files directly in `dir` (0 when it does not exist). */
export async function uploadDirBytes(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const name of names) {
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) total += s.size;
    } catch {
      // vanished meanwhile
    }
  }
  return total;
}

export interface ReceiveOptions {
  dir: string;
  jobId: string;
  /** ATMUSIC_UPLOAD_MAX_BYTES: the cap on the whole directory. */
  dirMaxBytes: number;
  /** ATMUSIC_MIN_FREE_BYTES. */
  minFreeBytes: number;
  /** Free bytes on the filesystem holding `dir` (disk.ts freeBytes); a throw counts as no space. */
  freeBytes: (path: string) => bigint;
  /** Content-Length, when the client declared one. */
  declaredLength: number | null;
  limitBytes?: number;
}

export type ReceiveResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; status: 413 | 507; code: 'payload_too_large' | 'insufficient_storage' };

const TOO_LARGE = { ok: false, status: 413, code: 'payload_too_large' } as const;
const NO_SPACE = { ok: false, status: 507, code: 'insufficient_storage' } as const;

function freeOf(options: ReceiveOptions): bigint {
  try {
    return options.freeBytes(options.dir);
  } catch {
    return 0n;
  }
}

/** Streams `body` to the job's upload file within the bounds (see the header). */
export async function receiveUpload(
  body: ReadableStream<Uint8Array> | null,
  options: ReceiveOptions,
): Promise<ReceiveResult> {
  const limit = options.limitBytes ?? UPLOAD_LIMIT_BYTES;
  const declared = options.declaredLength ?? 0;
  const cancel = () => {
    if (body !== null) void body.cancel().catch(() => undefined);
  };
  if (declared > limit) {
    cancel();
    return TOO_LARGE;
  }
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const before = await uploadDirBytes(options.dir);
  if (before + declared > options.dirMaxBytes || freeOf(options) - BigInt(declared) < BigInt(options.minFreeBytes)) {
    cancel();
    return NO_SPACE;
  }

  const path = uploadPathFor(options.dir, options.jobId);
  const handle = await open(path, 'wx', 0o600);
  let received = 0;
  let sinceCheck = 0;
  let outcome: ReceiveResult | null = null;
  try {
    await chmod(path, 0o600);
    if (body !== null) {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        sinceCheck += value.byteLength;
        if (received > limit) {
          outcome = TOO_LARGE;
        } else if (before + received > options.dirMaxBytes) {
          outcome = NO_SPACE;
        } else if (sinceCheck >= FREE_CHECK_BYTES) {
          sinceCheck = 0;
          if (freeOf(options) - BigInt(value.byteLength) < BigInt(options.minFreeBytes)) outcome = NO_SPACE;
        }
        if (outcome !== null) {
          void reader.cancel().catch(() => undefined);
          break;
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          offset += bytesWritten;
        }
      }
    }
    if (outcome === null) await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsUploadStore.remove(path);
    throw error;
  }
  await handle.close();
  if (outcome !== null) {
    await fsUploadStore.remove(path);
    return outcome;
  }
  return { ok: true, path, bytes: received };
}

/** Deletes the job's upload (if any) and clears `upload_path`. */
export async function deleteUpload(db: Db, store: UploadStore, jobId: string, now: number): Promise<void> {
  const row = db.one<{ upload_path: string | null }>('SELECT upload_path FROM import_jobs WHERE id = ?', jobId);
  if (row?.upload_path === null || row?.upload_path === undefined) return;
  await store.remove(row.upload_path);
  db.run('UPDATE import_jobs SET upload_path = NULL, updated_at_ms = ? WHERE id = ?', now, jobId);
}

const LIVE = `('waiting_index','fetching','writing','paused')`;

/**
 * Startup sweep: deletes every file in `dir` that no live job references, and
 * the upload of every job that is no longer live. Returns the deleted paths.
 */
export async function sweepOrphanUploads(db: Db, store: UploadStore, dir: string, now: number): Promise<string[]> {
  const deleted: string[] = [];
  for (const row of db.all<{ id: string; upload_path: string }>(
    `SELECT id, upload_path FROM import_jobs WHERE upload_path IS NOT NULL AND state NOT IN ${LIVE}`,
  )) {
    await store.remove(row.upload_path);
    db.run('UPDATE import_jobs SET upload_path = NULL, updated_at_ms = ? WHERE id = ?', now, row.id);
    deleted.push(row.upload_path);
  }
  const live = new Set(
    db
      .all<{ upload_path: string }>(
        `SELECT upload_path FROM import_jobs WHERE upload_path IS NOT NULL AND state IN ${LIVE}`,
      )
      .map((r) => r.upload_path),
  );
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (live.has(path)) continue;
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    await store.remove(path);
    deleted.push(path);
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Parsing

/** The upload is not what its source claims (`export_malformed`, `export_page_too_large`). */
export class UploadParseError extends Error {
  override readonly name = 'UploadParseError';
  constructor(readonly code: 'export_malformed' | 'export_page_too_large') {
    super(code);
  }
}

/** Splits a byte stream into lines without ever holding more than MAX_LINE_BYTES of one. */
export class LineSplitter {
  private parts: Uint8Array[] = [];
  private length = 0;
  private overflow = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

  /** `line` is the decoded line, or null for one that was too long or not UTF-8. */
  constructor(private readonly onLine: (line: string | null) => void) {}

  push(chunk: Uint8Array, final: boolean): void {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
      this.take(chunk.subarray(start, i));
      this.end();
      start = i + 1;
    }
    this.take(chunk.subarray(start));
    if (final) this.end();
  }

  private take(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.overflow) return;
    if (this.length + bytes.length > MAX_LINE_BYTES) {
      this.overflow = true;
      this.parts = [];
      this.length = 0;
      return;
    }
    this.parts.push(bytes.slice());
    this.length += bytes.length;
  }

  private end(): void {
    if (this.overflow) {
      this.overflow = false;
      this.onLine(null);
      return;
    }
    if (this.length === 0) return;
    const all = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      all.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.length = 0;
    let line: string;
    try {
      line = this.decoder.decode(all);
    } catch {
      this.onLine(null);
      return;
    }
    if (line.trim() === '') return;
    this.onLine(line);
  }
}

/**
 * Splits a top-level JSON array into its elements' bytes (Last.fm JSON
 * export). Structural characters are ASCII, so the scan works on bytes; an
 * element over MAX_PAGE_BYTES aborts with `export_page_too_large`.
 */
export class JsonArraySplitter {
  private depth = 0;
  private inString = false;
  private escape = false;
  private started = false;
  private closed = false;
  private parts: Uint8Array[] = [];
  private length = 0;
  private bom = 0;

  constructor(private readonly onElement: (bytes: Uint8Array) => void) {}

  push(chunk: Uint8Array, final: boolean): void {
    let elementStart = this.depth >= 2 ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number;
      if (!this.started) {
        if (this.bom < 3 && b === [0xef, 0xbb, 0xbf][this.bom]) {
          this.bom += 1;
          continue;
        }
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
        if (b !== 0x5b) throw new UploadParseError('export_malformed');
        this.started = true;
        this.depth = 1;
        continue;
      }
      if (this.closed) {
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
        throw new UploadParseError('export_malformed');
      }
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (b === 0x5c) this.escape = true;
        else if (b === 0x22) this.inString = false;
        continue;
      }
      if (this.depth === 1) {
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c) continue;
        if (b === 0x5d) {
          this.depth = 0;
          this.closed = true;
          continue;
        }
        if (b !== 0x7b && b !== 0x5b) throw new UploadParseError('export_malformed');
        elementStart = i;
        this.depth = 2;
        continue;
      }
      if (b === 0x22) this.inString = true;
      else if (b === 0x7b || b === 0x5b) this.depth += 1;
      else if (b === 0x7d || b === 0x5d) {
        this.depth -= 1;
        if (this.depth === 1) {
          this.take(chunk.subarray(elementStart, i + 1));
          this.emit();
          elementStart = -1;
        }
      }
    }
    if (elementStart >= 0 && this.depth >= 2) this.take(chunk.subarray(elementStart));
    if (final && (!this.closed || this.depth !== 0)) throw new UploadParseError('export_malformed');
  }

  private take(bytes: Uint8Array): void {
    if (this.length + bytes.length > MAX_PAGE_BYTES) throw new UploadParseError('export_page_too_large');
    this.parts.push(bytes.slice());
    this.length += bytes.length;
  }

  private emit(): void {
    const all = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      all.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.length = 0;
    this.onElement(all);
  }
}

const LISTENS_ENTRY = /^listens\/[0-9]{4}\/[0-9]{1,2}\.jsonl$/;
const FEEDBACK_ENTRY = 'feedback.jsonl';
const USER_ENTRY = 'user.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function uuidOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return UUID.test(lower) ? lower : null;
}

interface ArchiveListen {
  second: number;
  /** Order in the archive (ties on `second` go to the later one). */
  order: number;
  artist: string;
  track: string;
}

interface FeedbackRow {
  msid: string | null;
  mbid: string | null;
  score: number | null;
  created: number;
}

/** Newest-listen indexes of the archive, for feedback resolution. */
class FeedbackResolver {
  private readonly byMsid = new Map<string, ArchiveListen>();
  private readonly byMbid = new Map<string, ArchiveListen>();
  private order = 0;

  noteListen(raw: Json, second: number | null): void {
    const meta = obj(raw.track_metadata);
    if (meta === null || second === null) return;
    const artist = meta.artist_name;
    const track = meta.track_name;
    if (typeof artist !== 'string' || typeof track !== 'string') return;
    const info = obj(meta.additional_info) ?? {};
    const mapping = obj(meta.mbid_mapping) ?? obj(raw.mbid_mapping);
    const listen: ArchiveListen = { second, order: this.order++, artist, track };
    const newer = (old: ArchiveListen | undefined) => old === undefined || listen.second >= old.second;
    const msid = uuidOf(raw.recording_msid) ?? uuidOf(info.recording_msid);
    if (msid !== null && newer(this.byMsid.get(msid))) this.byMsid.set(msid, listen);
    for (const mbid of [uuidOf(mapping?.recording_mbid), uuidOf(info.recording_mbid)]) {
      if (mbid !== null && newer(this.byMbid.get(mbid))) this.byMbid.set(mbid, listen);
    }
  }

  resolve(row: FeedbackRow): ParsedEntry | null {
    if (row.score !== 1) return null;
    const found =
      (row.msid !== null ? this.byMsid.get(row.msid) : undefined) ??
      (row.mbid !== null ? this.byMbid.get(row.mbid) : undefined);
    if (found === undefined) return { kind: 'invalid', reason: 'feedback_unresolved' };
    return {
      kind: 'love',
      artist: found.artist,
      track: found.track,
      ...(row.mbid !== null ? { recordingMbid: row.mbid } : {}),
      createdAtSeconds: row.created,
    };
  }
}

function feedbackRow(raw: Json, fallbackSeconds: number): FeedbackRow {
  const score = typeof raw.score === 'number' && Number.isInteger(raw.score) ? raw.score : null;
  const created = listenedAtSeconds(raw.created) ?? fallbackSeconds;
  return { msid: uuidOf(raw.recording_msid), mbid: uuidOf(raw.recording_mbid), score, created };
}

export interface ParseControl {
  /** Receives every entry in order; return false to stop the parse (a slice is full). */
  emit(entry: ParsedEntry): Promise<boolean>;
  /** The feedback `created` fallback (UNIX seconds) for a row without one. */
  nowSeconds: number;
}

class StopParse extends Error {}

/**
 * Parses an upload (see the header). Resolves true when the whole file was
 * read, false when `emit` stopped it. Throws ZipBoundError or UploadParseError.
 */
export async function parseUpload(
  kind: UploadKind,
  source: AsyncIterable<Uint8Array>,
  control: ParseControl,
): Promise<boolean> {
  const queue: ParsedEntry[] = [];
  const drain = async () => {
    while (queue.length > 0) {
      const entry = queue.shift() as ParsedEntry;
      if (!(await control.emit(entry))) throw new StopParse();
    }
  };
  try {
    if (kind === 'lastfm_json') {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      const splitter = new JsonArraySplitter((bytes) => {
        let page: unknown;
        try {
          page = JSON.parse(decoder.decode(bytes));
        } catch {
          throw new UploadParseError('export_malformed');
        }
        for (const row of pageTracks(page)) {
          const mapped = mapLastfmRow(row);
          if (mapped.entry !== null) queue.push(mapped.entry);
        }
      });
      let any = false;
      for await (const chunk of source) {
        any = true;
        splitter.push(chunk, false);
        await drain();
      }
      if (!any) throw new UploadParseError('export_malformed');
      splitter.push(new Uint8Array(0), true);
      await drain();
      return true;
    }

    const resolver = new FeedbackResolver();
    const feedback: FeedbackRow[] = [];
    let splitter: LineSplitter | null = null;
    let current = '';
    await readZip(
      source,
      {
        accept: (name) => LISTENS_ENTRY.test(name) || name === FEEDBACK_ENTRY || name === USER_ENTRY,
        data: (name, chunk, final) => {
          if (name === USER_ENTRY) return;
          if (splitter === null || current !== name) {
            current = name;
            splitter = new LineSplitter((line) => {
              if (line === null) {
                if (name !== FEEDBACK_ENTRY) queue.push({ kind: 'invalid', reason: 'line_too_long' });
                return;
              }
              let raw: Json | null;
              try {
                raw = obj(JSON.parse(line));
              } catch {
                raw = null;
              }
              if (name === FEEDBACK_ENTRY) {
                if (raw !== null) feedback.push(feedbackRow(raw, control.nowSeconds));
                return;
              }
              if (raw === null) {
                queue.push({ kind: 'invalid', reason: 'line_invalid' });
                return;
              }
              const row = mapListenBrainzRow(raw);
              resolver.noteListen(raw, row.second);
              queue.push(row.entry);
            });
          }
          (splitter as LineSplitter).push(chunk, final);
          if (final) splitter = null;
        },
      },
      drain,
    );
    await drain();
    // Feedback after every listens entry: resolution needs the whole archive.
    for (const row of feedback) {
      const entry = resolver.resolve(row);
      if (entry !== null) queue.push(entry);
      await drain();
    }
    return true;
  } catch (error) {
    if (error instanceof StopParse) return false;
    throw error;
  }
}
