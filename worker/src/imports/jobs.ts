// Import jobs and the `import` extension timer (ADR 0005 §11; N3-09).
//
// States: waiting_index → fetching → writing → done, plus paused, failed and
// cancelled. A DID has at most one active job (waiting_index, fetching,
// writing or paused): a second is ImportActiveError (409 `import_active`).
//
// One timer run (`runImports`) does the cheap bookkeeping for every job and
// then at most ONE slice (ADR §3.3: one upstream page, one bounded upload
// parse slice, or one staging→operations slice of 1,000 items):
//
// - **waiting_index.** The job waits until the DID's `indexing_state` is
//   `current`, so that dedupe against its existing PDS records means
//   something. Sign-in admits the DID; if it still has no `users` row
//   (admission answered queue_full), the run retries `admit(…, 'notify', …)`
//   with backoff (ADMISSION_RETRY_BASE_MS · 2^n, capped at 1 h) until it is
//   admitted; the admission snapshot then sets `indexing_state`, also for a
//   DID with zero records. At most MAX_FETCHING (2) jobs fetch at once
//   server-wide; a job beyond that waits here.
// - **fetching.** API sources fetch one page per slice, through policyFetch,
//   after taking the source's pacer slot (Last.fm: one global request per
//   second shared with forwarding; ListenBrainz: one per second, held until
//   `X-RateLimit-Reset-In` when the window is spent). Transient failures back
//   off 30 s·2^n, capped at 1 h; the upstream rate limit pauses the job
//   (`rate_limited`) until it resets; an upstream 401 pauses it
//   (`upstream_unauthorized`) until the user resumes. Uploads are parsed
//   PARSE_SLICE entries per slice; a resumed parse skips the entries it
//   already staged. Each page or batch is staged with its cursor in one
//   transaction (staging.ts); the upload file is deleted once fully parsed.
// - **writing.** writer.ts turns staged items into import-priority operations
//   (1,000 per slice, while fewer than 1,000 are queued). While `diskLow()`
//   is true no operation is created and the job is paused with `low_disk`; it
//   continues from the same item when space returns. While the account needs
//   a new sign-in it is paused with `reauth_required`. Settled operations
//   flow back into `written`/`failed` every run; the job is `done` when
//   nothing is staged or queued.
// - **Crash-loop guard.** `attempts` is incremented in its own committed
//   transaction before each slice and reset to 0 when the slice commits; a
//   job found with attempts ≥ 3 (three slices that never completed, e.g. an
//   out-of-memory kill) becomes `failed` with `crash_loop` and its upload is
//   deleted.
// - **Retention.** Staging rows of a job are deleted 7 days after it finished.
//
// Cancel stops new operations (already queued ones finish) and deletes the
// upload; resume continues a paused job where it stopped.
//
// Fault injection is only through the injected interfaces of ImportRuntime
// (the transport behind `fetch`, the pacers, `diskLow`, the UploadStore).

import type { ImportJob } from '@atmusic/core/api-types';
import { fromMs, toDto } from '@atmusic/core/timestamp';
import type { CoreExtension } from '../app/host';
import { errorName } from '../app/index-core';
import type { ImportJobRow, ImportSource } from '../app/rows';
import { type Box, linkedAad } from '../crypto/box';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { admit } from '../do/ingest/admission';
import type { BoundPolicyFetch } from '../node/policy-fetch';
import { budgetWindows, importSharePercent, WRITE_COST } from '../outbox/budget';
import { accountNeedsSignIn } from '../outbox/operations';
import { fetchLastfmPage, initialLastfmCursor, type LastfmCursor } from './lastfm-source';
import { fetchListenBrainzPage, initialListenBrainzCursor, type ListenBrainzCursor } from './listenbrainz-source';
import { type ParsedEntry, stageEntries } from './staging';
import { deleteUpload, parseUpload, sweepOrphanUploads, UploadParseError, type UploadStore } from './uploads';
import { outstanding, stagedLeft, syncOutcomes, WRITE_SLICE, writeSlice } from './writer';
import { ZipBoundError } from './zip';

export const ACTIVE_STATES = ['waiting_index', 'fetching', 'writing', 'paused'] as const;
const ACTIVE_SQL = `('waiting_index','fetching','writing','paused')`;
const FINISHED_SQL = `('done','failed','cancelled')`;

export const MAX_FETCHING = 2;
export const CRASH_LOOP_ATTEMPTS = 3;
export const STAGING_RETENTION_MS = 7 * 24 * 3_600_000;
export const UPSTREAM_BACKOFF_BASE_MS = 30_000;
export const UPSTREAM_BACKOFF_CAP_MS = 3_600_000;
export const ADMISSION_RETRY_BASE_MS = 60_000;
export const ADMISSION_RETRY_CAP_MS = 3_600_000;
/** How often a job that waits on something outside the import timer is looked at again. */
export const POLL_MS = 60_000;
/** Upload entries staged per parse slice. */
export const PARSE_SLICE = 5_000;
/** Entries per staging transaction. */
export const STAGE_BATCH = 1_000;
/** Upstream response cap for one import page (policyFetch). */
export const IMPORT_FETCH_CAPS = Object.freeze({ maxRequestBytes: 4096, maxResponseBytes: 8 * 1024 * 1024 });

/** A second active job for the DID (409 `import_active`). */
export class ImportActiveError extends Error {
  override readonly name = 'ImportActiveError';
  constructor(readonly activeJobId: string) {
    super('an import job is already active');
  }
}

/**
 * Upstream pacing (ADR §11.3). The Last.fm pacer is one per process, shared
 * with forwarding (N3-08's upstream-pacing implements the same interface);
 * the import timer never sends a request without a slot.
 */
export interface Pacer {
  /** Takes the next request slot at `nowMs` and returns null, or returns when to ask again (nothing taken). */
  take(nowMs: number): number | null;
  /** No slot is granted before `untilMs` (an upstream's rate-limit reset). */
  holdUntil(untilMs: number): void;
}

/** A pacer granting one slot per `intervalMs` (default 1 s). */
export function intervalPacer(intervalMs = 1_000): Pacer {
  let nextMs = Number.NEGATIVE_INFINITY;
  return {
    take(nowMs) {
      if (nowMs < nextMs) return nextMs;
      nextMs = nowMs + intervalMs;
      return null;
    },
    holdUntil(untilMs) {
      nextMs = Math.max(nextMs, untilMs);
    },
  };
}

/** What one source request produced. */
export type FetchOutcome<C> =
  | { kind: 'page'; entries: ParsedEntry[]; cursor: C; done: boolean }
  | { kind: 'retry'; reason: string }
  | { kind: 'rate_limited'; untilMs?: number }
  | { kind: 'pause'; error: string }
  | { kind: 'fail'; error: string };

/** The source cursor and control state in `import_jobs.cursor_json`. */
export interface JobCursor {
  fetchDone?: boolean;
  lastfm?: LastfmCursor;
  listenbrainz?: ListenBrainzCursor;
  upload?: { consumed: number };
  retry?: { failures: number; notBeforeMs: number };
  admission?: { failures: number; notBeforeMs: number };
  pausedFrom?: 'waiting_index' | 'fetching' | 'writing';
}

export interface ImportRuntime {
  m: ModuleDeps;
  /** ATMUSIC_UPLOAD_DIR. */
  uploadDir: string;
  /** Null without the owner's Last.fm pair: `lastfm_api` jobs cannot start. */
  lastfm: { apiRoot: string; apiKey: string; sharedSecret: string } | null;
  listenbrainzApiRoot: string;
  /** policyFetch bound to IMPORT_FETCH_CAPS over the pinned transport. */
  fetch: BoundPolicyFetch;
  pacers: { lastfm: Pacer; listenbrainz: Pacer };
  /** True while free space is below ATMUSIC_MIN_FREE_BYTES (node/disk.ts). */
  diskLow: () => boolean;
  uploads: UploadStore;
  /** Opens linked credentials (sk, ListenBrainz token); null when none can be opened. */
  box: Box | null;
  /** Kicks the outbox after a writer slice. */
  kickOutbox?: () => void;
}

export type JobAction =
  | 'admitted'
  | 'admission_busy'
  | 'admission_backoff'
  | 'waiting_index'
  | 'waiting_fetch_slot'
  | 'started'
  | 'resumed'
  | 'page'
  | 'parsed'
  | 'wrote'
  | 'paced'
  | 'backoff'
  | 'paused'
  | 'done'
  | 'failed';

export interface ImportRunReport {
  /** Per job, what this run did, in order. */
  actions: Array<{ jobId: string; action: JobAction; atMs?: number; detail?: string }>;
  /** Slices run (0 or 1). */
  slices: number;
  /** When the timer should run next; null when nothing is left to do. */
  nextDueMs: number | null;
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Rows

export function parseCursor(row: Pick<ImportJobRow, 'cursor_json'>): JobCursor {
  if (row.cursor_json === null) return {};
  try {
    const value: unknown = JSON.parse(row.cursor_json);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JobCursor) : {};
  } catch {
    return {};
  }
}

export function loadJob(db: Db, id: string): ImportJobRow | null {
  return db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', id);
}

export function activeJob(db: Db, did: string): ImportJobRow | null {
  return db.one<ImportJobRow>(
    `SELECT * FROM import_jobs WHERE did = ? AND state IN ${ACTIVE_SQL} ORDER BY created_at_ms LIMIT 1`,
    did,
  );
}

export function listJobs(db: Db, did: string): ImportJobRow[] {
  return db.all<ImportJobRow>(
    'SELECT * FROM import_jobs WHERE did = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 100',
    did,
  );
}

export interface NewJob {
  id: string;
  did: string;
  source: ImportSource;
  remoteUser: string | null;
  uploadPath?: string | null;
  uploadBytes?: number | null;
  now: number;
}

/** Inserts a job in `waiting_index` with its initial cursor; throws ImportActiveError when one is active. */
export function createJob(db: Db, job: NewJob): ImportJobRow {
  return db.tx(() => {
    const active = activeJob(db, job.did);
    if (active !== null) throw new ImportActiveError(active.id);
    const cursor: JobCursor =
      job.source === 'lastfm_api'
        ? { lastfm: initialLastfmCursor(job.now) }
        : job.source === 'listenbrainz_api'
          ? { listenbrainz: initialListenBrainzCursor(job.now) }
          : { upload: { consumed: 0 } };
    db.run(
      `INSERT INTO import_jobs(id, did, source, remote_user, state, cursor_json, upload_path, upload_bytes,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'waiting_index', ?, ?, ?, ?, ?)`,
      job.id,
      job.did,
      job.source,
      job.remoteUser,
      JSON.stringify(cursor),
      job.uploadPath ?? null,
      job.uploadBytes ?? null,
      job.now,
      job.now,
    );
    return loadJob(db, job.id) as ImportJobRow;
  });
}

/** Items still to be written: staged or queued. */
export function remainingItems(db: Db, jobId: string): number {
  return (
    db.one<{ n: number }>(
      "SELECT count(*) AS n FROM import_items WHERE job_id = ? AND state IN ('staged','queued')",
      jobId,
    )?.n ?? 0
  );
}

/**
 * ETA (ADR §11.4) = remaining items × 3 points ÷ the current import points
 * per hour: the account's import share of the tighter of the hour window and
 * the day window spread over 24 h. Null for a finished job or nothing left.
 */
export function etaSeconds(db: Db, job: ImportJobRow, now: number): number | null {
  if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return null;
  const remaining = remainingItems(db, job.id);
  if (remaining === 0) return null;
  const share = importSharePercent(db, job.did);
  const windows = budgetWindows(db, job.did, now);
  const hour = windows.find((w) => w.window === 'hour')?.limit ?? 5_000;
  const day = windows.find((w) => w.window === 'day')?.limit ?? 35_000;
  const points = remaining * WRITE_COST.create;
  // points / (hour·share/100) h, or points / (day·share/100) days, whichever is longer.
  const byHour = Math.ceil((points * 3_600 * 100) / (hour * share));
  const byDay = Math.ceil((points * 86_400 * 100) / (day * share));
  return Math.max(byHour, byDay);
}

/** The contract's ImportJob DTO. */
export function jobDto(db: Db, job: ImportJobRow, now: number): ImportJob {
  return {
    id: job.id,
    source: job.source,
    remoteUser: job.remote_user,
    state: job.state,
    fetched: job.fetched,
    staged: job.staged,
    duplicates: job.duplicates,
    invalid: job.invalid,
    written: job.written,
    failed: job.failed_items,
    etaSeconds: etaSeconds(db, job, now),
    error: job.error,
    createdAt: toDto(fromMs(job.created_at_ms)),
    updatedAt: toDto(fromMs(job.updated_at_ms)),
  };
}

function setCursor(db: Db, id: string, cursor: JobCursor, now: number, extra = ''): void {
  db.run(
    `UPDATE import_jobs SET cursor_json = ?, updated_at_ms = ?${extra} WHERE id = ?`,
    JSON.stringify(cursor),
    now,
    id,
  );
}

/** Fails the job with `error` and deletes its upload. */
export async function failJob(rt: Pick<ImportRuntime, 'm' | 'uploads'>, id: string, error: string, now: number) {
  rt.m.db.run(
    `UPDATE import_jobs SET state = 'failed', error = ?, finished_at_ms = ?, updated_at_ms = ?
     WHERE id = ? AND state IN ${ACTIVE_SQL}`,
    error,
    now,
    now,
    id,
  );
  await deleteUpload(rt.m.db, rt.uploads, id, now);
}

/** Cancels the job (owned by `did`): no new operations; queued ones finish; the upload is deleted. */
export async function cancelJob(
  rt: Pick<ImportRuntime, 'm' | 'uploads'>,
  did: string,
  id: string,
  now: number,
): Promise<ImportJobRow | null> {
  const db = rt.m.db;
  const job = db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ? AND did = ?', id, did);
  if (job === null) return null;
  if ((ACTIVE_STATES as readonly string[]).includes(job.state)) {
    db.run(
      `UPDATE import_jobs SET state = 'cancelled', finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      now,
      now,
      id,
    );
  }
  await deleteUpload(db, rt.uploads, id, now);
  return loadJob(db, id);
}

/** Resumes a paused job (owned by `did`) where it stopped; any other state is returned unchanged. */
export function resumeJob(db: Db, did: string, id: string, now: number): ImportJobRow | null {
  const job = db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ? AND did = ?', id, did);
  if (job === null) return null;
  if (job.state === 'paused') resumePaused(db, job, now);
  return loadJob(db, id);
}

function resumePaused(db: Db, job: ImportJobRow, now: number): void {
  const cursor = parseCursor(job);
  const to = cursor.pausedFrom ?? (cursor.fetchDone === true ? 'writing' : 'fetching');
  delete cursor.pausedFrom;
  db.run(
    `UPDATE import_jobs SET state = ?, error = NULL, cursor_json = ?, attempts = 0, updated_at_ms = ? WHERE id = ?`,
    to,
    JSON.stringify(cursor),
    now,
    job.id,
  );
}

function pauseJob(db: Db, job: ImportJobRow, cursor: JobCursor, error: string, now: number): void {
  const from = job.state === 'paused' ? cursor.pausedFrom : job.state;
  const next: JobCursor = { ...cursor };
  if (from === 'waiting_index' || from === 'fetching' || from === 'writing') next.pausedFrom = from;
  db.run(
    `UPDATE import_jobs SET state = 'paused', error = ?, cursor_json = ?, attempts = 0, updated_at_ms = ?
     WHERE id = ? AND state IN ${ACTIVE_SQL}`,
    error,
    JSON.stringify(next),
    now,
    job.id,
  );
}

function backoffMs(base: number, cap: number, failures: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1));
}

/** Deletes staging rows of jobs that finished more than 7 days ago. Returns the rows deleted. */
export function purgeStaging(db: Db, now: number): number {
  return db.run(
    `DELETE FROM import_items WHERE job_id IN (
       SELECT id FROM import_jobs WHERE state IN ${FINISHED_SQL} AND finished_at_ms IS NOT NULL AND finished_at_ms <= ?)`,
    now - STAGING_RETENTION_MS,
  ).rowsWritten;
}

// ---------------------------------------------------------------------------
// Linked credentials

function linkedSecret(rt: ImportRuntime, did: string, service: 'lastfm' | 'listenbrainz'): string | null {
  if (rt.box === null) return null;
  const row = rt.m.db.one<{ credential_ciphertext: ArrayBuffer }>(
    `SELECT credential_ciphertext FROM linked_accounts WHERE did = ? AND service = ? AND status = 'active'`,
    did,
    service,
  );
  if (row === null) return null;
  try {
    return rt.box.openText(
      service === 'lastfm' ? 'linked-lastfm' : 'linked-listenbrainz',
      new Uint8Array(row.credential_ciphertext),
      linkedAad(did, service),
    );
  } catch {
    rt.m.log.log('warn', 'import.linked_credential_unreadable', { did, service });
    return null;
  }
}

// ---------------------------------------------------------------------------
// The run

const inFlight = new WeakSet<Db>();

/** One `import` timer run (see the header). */
export async function runImports(rt: ImportRuntime, now: number): Promise<ImportRunReport> {
  const db = rt.m.db;
  if (inFlight.has(db)) return { actions: [], slices: 0, nextDueMs: null, skipped: true };
  inFlight.add(db);
  try {
    return await new ImportRun(rt, now).run();
  } finally {
    inFlight.delete(db);
  }
}

class ImportRun {
  readonly report: ImportRunReport = { actions: [], slices: 0, nextDueMs: null, skipped: false };
  private readonly db: Db;
  private readonly waits: number[] = [];
  private moreReady = false;

  constructor(
    private readonly rt: ImportRuntime,
    private readonly now: number,
  ) {
    this.db = rt.m.db;
  }

  private act(jobId: string, action: JobAction, extra: { atMs?: number; detail?: string } = {}): void {
    this.report.actions.push({ jobId, action, ...extra });
  }

  private wait(atMs: number): void {
    this.waits.push(Math.max(atMs, this.now));
  }

  private jobs(): ImportJobRow[] {
    return this.db.all<ImportJobRow>(
      `SELECT * FROM import_jobs j WHERE state IN ${ACTIVE_SQL}
         OR (state = 'cancelled' AND EXISTS (SELECT 1 FROM import_items i WHERE i.job_id = j.id AND i.state = 'queued'))
       ORDER BY updated_at_ms, created_at_ms, id`,
    );
  }

  private fetchingCount(): number {
    return this.db.one<{ n: number }>("SELECT count(*) AS n FROM import_jobs WHERE state = 'fetching'")?.n ?? 0;
  }

  async run(): Promise<ImportRunReport> {
    purgeStaging(this.db, this.now);
    // 1. Bookkeeping for every job.
    for (const job of this.jobs()) await this.bookkeep(job);
    // 2. At most one slice: the least recently touched job that can make progress.
    for (const job of this.jobs()) {
      if (this.report.slices > 0) break;
      await this.slice(job);
    }
    // 3. When to run next: at once when a slice ran and another job (or the
    // next phase of the same one) can take one; else the earliest wait.
    const after = this.jobs();
    if (this.report.slices > 0 && after.some((job) => this.ready(job))) this.moreReady = true;
    for (const job of after) {
      if (job.state === 'fetching') {
        // A backoff end, or the next pacer slot (at most one per second).
        this.wait(parseCursor(job).retry?.notBeforeMs ?? this.now + 1_000);
      } else if (
        job.state === 'writing' ||
        job.state === 'waiting_index' ||
        job.state === 'paused' ||
        job.state === 'cancelled'
      ) {
        this.wait(this.now + POLL_MS);
      }
    }
    if (this.moreReady) this.report.nextDueMs = this.now;
    else this.report.nextDueMs = this.waits.length === 0 ? null : Math.min(...this.waits);
    return this.report;
  }

  /** Cheap per-job work: outcome sync, waiting_index, auto-resume, completion. */
  private async bookkeep(row: ImportJobRow): Promise<void> {
    const db = this.db;
    let job = row;
    if (job.state === 'writing' || job.state === 'paused' || job.state === 'cancelled') {
      syncOutcomes(db, job.id, this.now);
      job = loadJob(db, job.id) as ImportJobRow;
    }
    const cursor = parseCursor(job);
    if (job.state === 'waiting_index') {
      await this.waitingIndex(job, cursor);
      return;
    }
    if (job.state === 'paused') {
      const resume =
        (job.error === 'low_disk' && !this.rt.diskLow()) ||
        (job.error === 'reauth_required' && !accountNeedsSignIn(db, job.did)) ||
        (job.error === 'rate_limited' && (cursor.retry?.notBeforeMs ?? 0) <= this.now);
      if (resume) {
        resumePaused(db, job, this.now);
        this.act(job.id, 'resumed', { detail: job.error ?? '' });
      } else if (job.error === 'rate_limited' && cursor.retry !== undefined) {
        this.wait(cursor.retry.notBeforeMs);
      }
      return;
    }
    if (job.state === 'fetching' && cursor.fetchDone === true) {
      db.run(
        `UPDATE import_jobs SET state = 'writing', updated_at_ms = ? WHERE id = ? AND state = 'fetching'`,
        this.now,
        job.id,
      );
      job = loadJob(db, job.id) as ImportJobRow;
    }
    if (job.state === 'writing' && stagedLeft(db, job.id) === 0 && outstanding(db, job.id) === 0) {
      db.run(
        `UPDATE import_jobs SET state = 'done', error = NULL, attempts = 0, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        this.now,
        this.now,
        job.id,
      );
      await deleteUpload(db, this.rt.uploads, job.id, this.now);
      this.act(job.id, 'done');
    }
  }

  private async waitingIndex(job: ImportJobRow, cursor: JobCursor): Promise<void> {
    const db = this.db;
    const user = db.one<{ indexing_state: string }>('SELECT indexing_state FROM users WHERE did = ?', job.did);
    if (user === null) {
      const notBefore = cursor.admission?.notBeforeMs ?? 0;
      if (notBefore > this.now) {
        this.act(job.id, 'admission_backoff', { atMs: notBefore });
        this.wait(notBefore);
        return;
      }
      const result = admit(db, job.did, 'notify', this.now);
      if (result.status === 'admitted' || result.status === 'known') {
        const next = { ...cursor };
        delete next.admission;
        setCursor(db, job.id, next, this.now);
        this.act(job.id, 'admitted');
        this.wait(this.now + POLL_MS);
        return;
      }
      if (result.status === 'suppressed') {
        await failJob(this.rt, job.id, 'indexing_suppressed', this.now);
        this.act(job.id, 'failed', { detail: 'indexing_suppressed' });
        return;
      }
      const failures = (cursor.admission?.failures ?? 0) + 1;
      const at = this.now + backoffMs(ADMISSION_RETRY_BASE_MS, ADMISSION_RETRY_CAP_MS, failures);
      setCursor(db, job.id, { ...cursor, admission: { failures, notBeforeMs: at } }, this.now);
      this.act(job.id, 'admission_busy', { atMs: at, detail: result.reason });
      this.wait(at);
      return;
    }
    if (user.indexing_state === 'suppressed') {
      await failJob(this.rt, job.id, 'indexing_suppressed', this.now);
      this.act(job.id, 'failed', { detail: 'indexing_suppressed' });
      return;
    }
    if (user.indexing_state !== 'current') {
      this.act(job.id, 'waiting_index');
      return;
    }
    if (this.fetchingCount() >= MAX_FETCHING) {
      this.act(job.id, 'waiting_fetch_slot');
      return;
    }
    db.run(`UPDATE import_jobs SET state = 'fetching', updated_at_ms = ? WHERE id = ?`, this.now, job.id);
    this.act(job.id, 'started');
  }

  /** Whether `job` could take a slice now (used only to decide whether to run again at once). */
  private ready(job: ImportJobRow): boolean {
    const cursor = parseCursor(job);
    if (job.state === 'fetching') return (cursor.retry?.notBeforeMs ?? 0) <= this.now;
    if (job.state === 'writing') {
      return !this.rt.diskLow() && stagedLeft(this.db, job.id) > 0 && outstanding(this.db, job.id) < WRITE_SLICE;
    }
    return false;
  }

  /** Crash-loop guard: false (and the job failed) at CRASH_LOOP_ATTEMPTS; else attempts + 1, committed. */
  private async beginSlice(job: ImportJobRow): Promise<boolean> {
    const current = loadJob(this.db, job.id) as ImportJobRow;
    if (current.attempts >= CRASH_LOOP_ATTEMPTS) {
      await failJob(this.rt, job.id, 'crash_loop', this.now);
      this.act(job.id, 'failed', { detail: 'crash_loop' });
      return false;
    }
    this.db.run('UPDATE import_jobs SET attempts = attempts + 1 WHERE id = ?', job.id);
    this.report.slices += 1;
    return true;
  }

  private async slice(row: ImportJobRow): Promise<void> {
    const job = loadJob(this.db, row.id) as ImportJobRow;
    if (job.state === 'fetching') {
      const cursor = parseCursor(job);
      if (cursor.retry !== undefined && cursor.retry.notBeforeMs > this.now) {
        this.act(job.id, 'backoff', { atMs: cursor.retry.notBeforeMs });
        this.wait(cursor.retry.notBeforeMs);
        return;
      }
      if (job.source === 'lastfm_api' || job.source === 'listenbrainz_api') await this.fetchSlice(job, cursor);
      else await this.parseSlice(job, cursor);
      return;
    }
    if (job.state === 'writing') await this.writeSliceFor(job);
  }

  private async fetchSlice(job: ImportJobRow, cursor: JobCursor): Promise<void> {
    const rt = this.rt;
    const lastfm = job.source === 'lastfm_api';
    if (lastfm && rt.lastfm === null) {
      await failJob(rt, job.id, 'lastfm_not_configured', this.now);
      this.act(job.id, 'failed', { detail: 'lastfm_not_configured' });
      return;
    }
    const pacer = lastfm ? rt.pacers.lastfm : rt.pacers.listenbrainz;
    const until = pacer.take(this.now);
    if (until !== null) {
      this.act(job.id, 'paced', { atMs: until });
      this.wait(until);
      return;
    }
    if (!(await this.beginSlice(job))) return;
    const user = job.remote_user ?? '';
    try {
      if (lastfm) {
        const conf = rt.lastfm as NonNullable<ImportRuntime['lastfm']>;
        const outcome = await fetchLastfmPage(
          { fetch: rt.fetch, apiRoot: conf.apiRoot, apiKey: conf.apiKey, sharedSecret: conf.sharedSecret },
          {
            user,
            sk: linkedSecret(rt, job.did, 'lastfm'),
            cursor: cursor.lastfm ?? initialLastfmCursor(job.created_at_ms),
          },
        );
        await this.applyFetch(job, cursor, outcome, (c) => ({ lastfm: c }));
      } else {
        const outcome = await fetchListenBrainzPage(
          { fetch: rt.fetch, apiRoot: rt.listenbrainzApiRoot },
          {
            user,
            token: linkedSecret(rt, job.did, 'listenbrainz'),
            cursor: cursor.listenbrainz ?? initialListenBrainzCursor(job.created_at_ms),
            nowMs: this.now,
          },
        );
        // Spent window: no further request before it resets.
        if (outcome.rate !== null && outcome.rate.remaining === 0 && outcome.rate.resetInSeconds !== null) {
          pacer.holdUntil(this.now + outcome.rate.resetInSeconds * 1000);
        }
        if (outcome.kind === 'rate_limited' && outcome.untilMs !== undefined) pacer.holdUntil(outcome.untilMs);
        await this.applyFetch(job, cursor, outcome, (c) => ({ listenbrainz: c }));
      }
    } catch (error) {
      // An unexpected failure: the slice did not complete (attempts stays raised).
      rt.m.log.log('error', 'import.slice_error', { jobId: job.id, error: errorName(error) });
      this.retryLater(job, cursor, 'internal');
    }
  }

  private retryLater(job: ImportJobRow, cursor: JobCursor, reason: string, resetAttempts = false): number {
    const failures = (cursor.retry?.failures ?? 0) + 1;
    const at = this.now + backoffMs(UPSTREAM_BACKOFF_BASE_MS, UPSTREAM_BACKOFF_CAP_MS, failures);
    setCursor(
      this.db,
      job.id,
      { ...cursor, retry: { failures, notBeforeMs: at } },
      this.now,
      resetAttempts ? ', attempts = 0' : '',
    );
    this.act(job.id, 'backoff', { atMs: at, detail: reason });
    this.wait(at);
    return at;
  }

  private async applyFetch<C>(
    job: ImportJobRow,
    cursor: JobCursor,
    outcome: FetchOutcome<C>,
    store: (c: C) => JobCursor,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'page': {
        const next: JobCursor = { ...cursor, ...store(outcome.cursor) };
        delete next.retry;
        if (outcome.done) next.fetchDone = true;
        await stageEntries(this.rt.m, job, outcome.entries, {
          cursorJson: JSON.stringify(next),
          completeSlice: true,
          now: this.now,
        });
        if (outcome.done) {
          this.db.run(
            `UPDATE import_jobs SET state = 'writing', updated_at_ms = ? WHERE id = ? AND state = 'fetching'`,
            this.now,
            job.id,
          );
        } else {
          this.moreReady = true;
        }
        this.act(job.id, 'page', { detail: `${outcome.entries.length}` });
        return;
      }
      case 'retry':
        this.retryLater(job, cursor, outcome.reason, true);
        return;
      case 'rate_limited': {
        const failures = (cursor.retry?.failures ?? 0) + 1;
        const at = outcome.untilMs ?? this.now + backoffMs(UPSTREAM_BACKOFF_BASE_MS, UPSTREAM_BACKOFF_CAP_MS, failures);
        pauseJob(this.db, job, { ...cursor, retry: { failures, notBeforeMs: at } }, 'rate_limited', this.now);
        this.act(job.id, 'paused', { atMs: at, detail: 'rate_limited' });
        this.wait(at);
        return;
      }
      case 'pause':
        pauseJob(this.db, job, cursor, outcome.error, this.now);
        this.act(job.id, 'paused', { detail: outcome.error });
        return;
      case 'fail':
        await failJob(this.rt, job.id, outcome.error, this.now);
        this.act(job.id, 'failed', { detail: outcome.error });
        return;
    }
  }

  private async parseSlice(job: ImportJobRow, cursor: JobCursor): Promise<void> {
    const rt = this.rt;
    const path = job.upload_path;
    if (path === null) {
      await failJob(rt, job.id, 'upload_missing', this.now);
      this.act(job.id, 'failed', { detail: 'upload_missing' });
      return;
    }
    if (!(await this.beginSlice(job))) return;
    const consumedBefore = cursor.upload?.consumed ?? 0;
    let seen = 0;
    let consumed = consumedBefore;
    let batch: ParsedEntry[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const entries = batch;
      batch = [];
      consumed += entries.length;
      await stageEntries(rt.m, job, entries, {
        cursorJson: JSON.stringify({ ...cursor, upload: { consumed } }),
        now: this.now,
      });
    };
    let complete: boolean;
    try {
      complete = await parseUpload(job.source as 'lastfm_json' | 'listenbrainz_zip', rt.uploads.read(path), {
        nowSeconds: Math.floor(this.now / 1000),
        emit: async (entry) => {
          seen += 1;
          if (seen <= consumedBefore) return true;
          batch.push(entry);
          if (batch.length >= STAGE_BATCH) await flush();
          return consumed + batch.length - consumedBefore < PARSE_SLICE;
        },
      });
      await flush();
    } catch (error) {
      if (error instanceof ZipBoundError || error instanceof UploadParseError) {
        const code = error instanceof ZipBoundError ? `zip_${error.bound}` : error.code;
        await failJob(rt, job.id, code, this.now);
        this.act(job.id, 'failed', { detail: code });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await failJob(rt, job.id, 'upload_missing', this.now);
        this.act(job.id, 'failed', { detail: 'upload_missing' });
        return;
      }
      rt.m.log.log('error', 'import.parse_error', { jobId: job.id, error: errorName(error) });
      this.retryLater(job, cursor, 'internal');
      return;
    }
    const after = parseCursor(loadJob(this.db, job.id) as ImportJobRow);
    if (complete) {
      after.fetchDone = true;
      setCursor(this.db, job.id, after, this.now, ', attempts = 0');
      this.db.run(
        `UPDATE import_jobs SET state = 'writing', updated_at_ms = ? WHERE id = ? AND state = 'fetching'`,
        this.now,
        job.id,
      );
      await deleteUpload(this.db, rt.uploads, job.id, this.now);
    } else {
      setCursor(this.db, job.id, after, this.now, ', attempts = 0');
      this.moreReady = true;
    }
    this.act(job.id, 'parsed', { detail: `${consumed - consumedBefore}` });
  }

  private async writeSliceFor(job: ImportJobRow): Promise<void> {
    const rt = this.rt;
    const db = this.db;
    if (rt.diskLow()) {
      pauseJob(db, job, parseCursor(job), 'low_disk', this.now);
      this.act(job.id, 'paused', { detail: 'low_disk' });
      return;
    }
    if (accountNeedsSignIn(db, job.did)) {
      pauseJob(db, job, parseCursor(job), 'reauth_required', this.now);
      this.act(job.id, 'paused', { detail: 'reauth_required' });
      return;
    }
    if (stagedLeft(db, job.id) === 0 || outstanding(db, job.id) >= WRITE_SLICE) return;
    if (!(await this.beginSlice(job))) return;
    try {
      const report = await writeSlice(rt.m, job, this.now);
      if (report.created > 0) rt.kickOutbox?.();
      this.act(job.id, 'wrote', { detail: `${report.created}` });
      if (this.ready(loadJob(db, job.id) as ImportJobRow)) this.moreReady = true;
    } catch (error) {
      rt.m.log.log('error', 'import.write_error', { jobId: job.id, error: errorName(error) });
      this.retryLater(job, parseCursor(job), 'internal');
    }
  }
}

// ---------------------------------------------------------------------------
// The extension timer

/**
 * The `import` extension timer. `runtime()` is read on every run, so the
 * composition can build the runtime after IndexCore (feature services) and
 * before the timers start. At start the orphan uploads are swept.
 */
export function importExtension(runtime: () => ImportRuntime | null): CoreExtension {
  return {
    name: 'import',
    timers: {
      import: async (now, ctx) => {
        const rt = runtime();
        if (rt === null) return;
        const report = await runImports({ ...rt, kickOutbox: () => ctx.kick('outbox') }, now);
        if (report.skipped) return;
        if (report.nextDueMs !== null) ctx.schedule('import', report.nextDueMs, { force: true });
      },
    },
    start(ctx, now) {
      const rt = runtime();
      if (rt !== null) {
        void sweepOrphanUploads(rt.m.db, rt.uploads, rt.uploadDir, now).catch((error: unknown) => {
          rt.m.log.log('error', 'import.sweep_failed', { error: errorName(error) });
        });
      }
      ctx.schedule('import', now);
    },
  };
}
