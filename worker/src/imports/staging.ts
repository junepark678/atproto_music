// Import staging and dedupe (ADR 0005 §11.2 steps 2–3; N3-09).
//
// Every source (the Last.fm and ListenBrainz APIs, the two upload formats)
// hands its parsed entries to `stageEntries`, which writes them into
// `import_items` with their listen key and updates the job's counters, all
// in ONE transaction together with the source's cursor, so a crash between
// two pages never stages a page twice or loses one.
//
// Entries:
// - `listen`: a mapped scrobble input (packages/core/src/protocol-map.ts).
//   It must build with `buildScrobbleRecord` at the staging time (the +300 s
//   bound), else it is invalid. Its listen key is
//   sha256(did ‖ floor(listenedAt s) ‖ artist_key ‖ track_key)
//   (packages/core/src/listen-key.ts).
// - `love`: a ListenBrainz feedback row resolved to (artist, track); it
//   becomes a `love.put` with origin import (writer.ts). Its dedupe key is
//   `love:` + sha256(artist_key U+0000 track_key), so one feedback per track
//   is kept.
// - `invalid`: counted in `invalid` and `invalid_reasons[reason]`, never stored.
//
// Dedupe of a listen, exact to the second (no ±120 s window):
// - earlier items of the same job (UNIQUE(job_id, dedupe_key));
// - `listen_keys` of the DID: anything already accepted through /2.0, /1, the
//   web form or another import;
// - the DID's indexed scrobbles at the same second with the same artist_key
//   and track_key (`scrobbles_stats` index).
// A duplicate is counted in `duplicates` and never stored. The writer checks
// listen_keys and scrobbles again before it creates an operation, because a
// live listen may arrive between staging and writing.
//
// `fetched` counts every entry a source produced (invalid ones included).

import { createHash } from 'node:crypto';
import { listenKey } from '@atmusic/core/listen-key';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { ScrobbleInput } from '@atmusic/core/scrobble';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';

export interface ListenEntry {
  kind: 'listen';
  input: ScrobbleInput;
  /** Whole UNIX seconds of `input.listenedAt`. */
  listenedAtSeconds: number;
}

export interface LoveEntry {
  kind: 'love';
  artist: string;
  track: string;
  recordingMbid?: string;
  /** When the feedback was given (UNIX seconds); the item's `listened_at`. */
  createdAtSeconds: number;
}

export interface InvalidEntry {
  kind: 'invalid';
  /** `^[a-z0-9_]{1,64}$`, e.g. `artist_invalid`, `feedback_unresolved`. */
  reason: string;
}

export type ParsedEntry = ListenEntry | LoveEntry | InvalidEntry;

/** What `import_items.record_json` holds. */
export type StagedRecord =
  | { kind: 'listen'; input: ScrobbleInput }
  | { kind: 'love'; input: { artist: string; track: string; recordingMbid?: string } };

export interface StageResult {
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  invalidReasons: Record<string, number>;
}

export interface StageTarget {
  id: string;
  did: string;
}

const REASON = /^[a-z0-9_]{1,64}$/;

/** sha256 hex of `text` (node:crypto; synchronous, for keys computed inside a loop). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The dedupe key of a love: one per (artist_key, track_key). Null when a name is not a valid display string. */
export function loveDedupeKey(artist: string, track: string): string | null {
  try {
    const [a, t] = trackKey(artist, track);
    return `love:${sha256Hex(`${a}\u0000${t}`)}`;
  } catch (error) {
    if (error instanceof MusicKeyError) return null;
    throw error;
  }
}

/**
 * The boundary second of a backward walk (ADR §11.1): the next request's
 * exclusive upper bound is `second + 1`, so the upstream answers the rows at
 * `second` again; `seen` holds the identities (with multiplicity) of those
 * this job has already taken.
 */
export interface Boundary {
  second: number;
  seen: string[];
}

export interface BoundaryStep<T> {
  /** The rows of this page not taken before. */
  keep: Set<T>;
  next: { bound: number; boundary: Boundary | null };
}

/**
 * The boundary dedupe and progress rule shared by the Last.fm (`to`) and
 * ListenBrainz (`max_ts`) walks: rows at the previous boundary second whose
 * identity was already taken are dropped; the next bound is the page's
 * oldest second + 1 with that second as the new boundary, or, when the page
 * brought nothing older than the previous boundary, the oldest second itself
 * (so the walk always moves).
 */
export function pageBoundary<T extends { second: number; id: string }>(
  prev: Boundary | null,
  rows: readonly T[],
  bound: number,
): BoundaryStep<T> {
  const remaining = new Map<string, number>();
  for (const id of prev?.seen ?? []) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const keep = new Set<T>();
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    oldest = Math.min(oldest, row.second);
    if (prev !== null && row.second === prev.second) {
      const n = remaining.get(row.id) ?? 0;
      if (n > 0) {
        remaining.set(row.id, n - 1);
        continue;
      }
    }
    keep.add(row);
  }
  if (rows.length === 0) return { keep, next: { bound, boundary: prev } };
  if (prev !== null && oldest >= prev.second) return { keep, next: { bound: oldest, boundary: null } };
  const seen = rows.filter((row) => row.second === oldest).map((row) => row.id);
  return { keep, next: { bound: oldest + 1, boundary: { second: oldest, seen } } };
}

/** [lower, upper) storage-timestamp bounds of one whole second. */
export function secondBounds(seconds: number): [string, string] {
  const ns = BigInt(seconds) * NS_PER_SECOND;
  return [toStorage(ns), toStorage(ns + NS_PER_SECOND)];
}

/** True when `did` has an indexed scrobble at `seconds` with the same artist and track keys. */
export function indexedAtSecond(db: Db, did: string, seconds: number, artist: string, track: string): boolean {
  let key: readonly [string, string];
  try {
    key = trackKey(artist, track);
  } catch (error) {
    if (error instanceof MusicKeyError) return false;
    throw error;
  }
  const [lower, upper] = secondBounds(seconds);
  return (
    db.one(
      `SELECT 1 AS hit FROM scrobbles
       WHERE did = ? AND artist_key = ? AND track_key = ? AND listened_at >= ? AND listened_at < ? LIMIT 1`,
      did,
      key[0],
      key[1],
      lower,
      upper,
    ) !== null
  );
}

/** True when the DID already accepted this listen key through any ingress (or an import). */
export function knownListenKey(db: Db, did: string, key: string): boolean {
  return db.one('SELECT 1 AS hit FROM listen_keys WHERE did = ? AND dedupe_key = ?', did, key) !== null;
}

type Prepared =
  | { kind: 'item'; key: string; listenedAt: string; record: StagedRecord; seconds: number; listen: ListenEntry | null }
  | { kind: 'invalid'; reason: string };

async function prepareEntry(m: ModuleDeps, did: string, prefix: string, entry: ParsedEntry): Promise<Prepared> {
  switch (entry.kind) {
    case 'invalid':
      return { kind: 'invalid', reason: REASON.test(entry.reason) ? entry.reason : 'invalid' };
    case 'listen': {
      const built = buildScrobbleRecord(entry.input, prefix, m.clock);
      if (!built.ok) {
        return {
          kind: 'invalid',
          reason: built.reason.field === 'listenedAt' ? 'timestamp_invalid' : 'record_invalid',
        };
      }
      let key: string;
      try {
        key = await listenKey({
          did,
          listenedAtNs: BigInt(entry.listenedAtSeconds) * NS_PER_SECOND,
          artist: entry.input.artist,
          track: entry.input.track,
        });
      } catch (error) {
        if (error instanceof MusicKeyError) return { kind: 'invalid', reason: 'record_invalid' };
        throw error;
      }
      return {
        kind: 'item',
        key,
        listenedAt: toStorage(BigInt(entry.listenedAtSeconds) * NS_PER_SECOND),
        record: { kind: 'listen', input: entry.input },
        seconds: entry.listenedAtSeconds,
        listen: entry,
      };
    }
    case 'love': {
      const key = loveDedupeKey(entry.artist, entry.track);
      if (key === null) return { kind: 'invalid', reason: 'record_invalid' };
      const input: { artist: string; track: string; recordingMbid?: string } = {
        artist: entry.artist,
        track: entry.track,
      };
      if (entry.recordingMbid !== undefined) input.recordingMbid = entry.recordingMbid;
      const seconds = Math.max(0, Math.min(entry.createdAtSeconds, 253_402_300_799));
      return {
        kind: 'item',
        key,
        listenedAt: toStorage(BigInt(seconds) * NS_PER_SECOND),
        record: { kind: 'love', input },
        seconds,
        listen: null,
      };
    }
  }
}

/** Adds `delta` to a JSON object of counts by reason. */
export function addReasons(json: string, delta: Readonly<Record<string, number>>): string {
  let base: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      base = parsed as Record<string, number>;
  } catch {
    base = {};
  }
  const out: Record<string, number> = { ...base };
  for (const [reason, n] of Object.entries(delta)) out[reason] = (out[reason] ?? 0) + n;
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key] as number;
  return JSON.stringify(sorted);
}

export interface StageOptions {
  /** The source's new cursor, stored in the same transaction (`cursor_json`). */
  cursorJson?: string;
  /** Reset the crash-loop counter in the same commit (the slice completed). */
  completeSlice?: boolean;
  now: number;
}

/**
 * Stages `entries` for `job` (see the header). Returns what this call
 * counted. The job row's counters, cursor and `updated_at_ms` change in the
 * same transaction as the items.
 */
export async function stageEntries(
  m: ModuleDeps,
  job: StageTarget,
  entries: readonly ParsedEntry[],
  options: StageOptions,
): Promise<StageResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const prepared: Prepared[] = [];
  for (const entry of entries) prepared.push(await prepareEntry(m, job.did, prefix, entry));

  const db = m.db;
  return db.tx((): StageResult => {
    const result: StageResult = { fetched: entries.length, staged: 0, duplicates: 0, invalid: 0, invalidReasons: {} };
    let seq =
      db.one<{ next: number }>('SELECT coalesce(max(seq), -1) + 1 AS next FROM import_items WHERE job_id = ?', job.id)
        ?.next ?? 0;
    for (const p of prepared) {
      if (p.kind === 'invalid') {
        result.invalid += 1;
        result.invalidReasons[p.reason] = (result.invalidReasons[p.reason] ?? 0) + 1;
        continue;
      }
      const inJob =
        db.one('SELECT 1 AS hit FROM import_items WHERE job_id = ? AND dedupe_key = ?', job.id, p.key) !== null;
      const listen = p.listen;
      const duplicate =
        inJob ||
        (listen !== null &&
          (knownListenKey(db, job.did, p.key) ||
            indexedAtSecond(db, job.did, p.seconds, listen.input.artist, listen.input.track)));
      if (duplicate) {
        result.duplicates += 1;
        continue;
      }
      db.run(
        `INSERT INTO import_items(job_id, seq, dedupe_key, listened_at, record_json, state) VALUES (?, ?, ?, ?, ?, 'staged')`,
        job.id,
        seq,
        p.key,
        p.listenedAt,
        JSON.stringify(p.record),
      );
      seq += 1;
      result.staged += 1;
    }
    const row = db.one<{ invalid_reasons: string }>('SELECT invalid_reasons FROM import_jobs WHERE id = ?', job.id);
    if (row === null) throw new RangeError(`no import job ${job.id}`);
    db.run(
      `UPDATE import_jobs SET fetched = fetched + ?, staged = staged + ?, duplicates = duplicates + ?,
         invalid = invalid + ?, invalid_reasons = ?, cursor_json = coalesce(?, cursor_json),
         attempts = CASE WHEN ? THEN 0 ELSE attempts END, updated_at_ms = ?
       WHERE id = ?`,
      result.fetched,
      result.staged,
      result.duplicates,
      result.invalid,
      addReasons(row.invalid_reasons, result.invalidReasons),
      options.cursorJson ?? null,
      options.completeSlice === true ? 1 : 0,
      options.now,
      job.id,
    );
    return result;
  });
}
