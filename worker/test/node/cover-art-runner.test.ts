import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/do/migrate';
import { runCoverArtJobs } from '../../src/musicbrainz/cover-art-runner';
import { enqueueCoverArt, getCoverArt, putCoverArt } from '../../src/musicbrainz/cover-art-store';
import { openSqliteDb } from '../../src/node/sqlite-db';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cover-runner-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = openSqliteDb(path, { create: true, busyTimeoutMs: 200 });
  migrate(db);
  return { db, path };
}
const fixedClock = (at: number) => ({ nowMs: () => at, now: () => new Date(at) }) as never;
const art = { bytes: new Uint8Array([4, 5]), mimeType: 'image/png' };
describe('Cover Art background runner', () => {
  it('processes a due persisted job and stores validated image bytes', async () => {
    const { db } = setup();
    try {
      enqueueCoverArt(db, 'release', 'group', 1);
      const client = vi.fn().mockResolvedValue(art);
      expect(
        await runCoverArtJobs({ db, clock: fixedClock(2), client, cacheBudgetBytes: 10, enabled: true }),
      ).toMatchObject({ processed: 1 });
      expect(client).toHaveBeenCalledWith('release', 'group');
      expect(getCoverArt(db, 'release', 3)?.mimeType).toBe('image/png');
      expect(
        db.one<{ status: string }>('SELECT status FROM mb_cover_art_jobs WHERE release_mbid=?', 'release')?.status,
      ).toBe('complete');
    } finally {
      db.close();
    }
  });
  it('persists exponential retry due time across restart and skips network before due', async () => {
    const { db, path } = setup();
    enqueueCoverArt(db, 'r', null, 10);
    try {
      const fail = vi.fn().mockRejectedValue(new Error('network'));
      await runCoverArtJobs({ db, clock: fixedClock(10), client: fail, cacheBudgetBytes: 100, enabled: true });
      expect(
        db.one<{ next_due_ms: number }>('SELECT next_due_ms FROM mb_cover_art_jobs WHERE release_mbid=?', 'r')
          ?.next_due_ms,
      ).toBe(60_010);
    } finally {
      db.close();
    }
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      const client = vi.fn().mockResolvedValue(art);
      const result = await runCoverArtJobs({
        db: reopened,
        clock: fixedClock(60_009),
        client,
        cacheBudgetBytes: 100,
        enabled: true,
      });
      expect(client).not.toHaveBeenCalled();
      expect(result.nextDueAt).toBe(60_010);
    } finally {
      reopened.close();
    }
  });
  it('after eight failures waits 30 days, then resumes at attempt one across restart', async () => {
    const { db, path } = setup();
    enqueueCoverArt(db, 'cycle', null, 0);
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const due =
          db.one<{ next_due_ms: number }>('SELECT next_due_ms FROM mb_cover_art_jobs WHERE release_mbid=?', 'cycle')
            ?.next_due_ms ?? 0;
        await runCoverArtJobs({
          db,
          clock: fixedClock(due),
          client: vi.fn().mockRejectedValue(new Error('network')),
          cacheBudgetBytes: 100,
          enabled: true,
        });
      }
      expect(
        db.one<{ status: string; attempts: number }>(
          'SELECT status,attempts FROM mb_cover_art_jobs WHERE release_mbid=?',
          'cycle',
        ),
      ).toEqual({ status: 'failed', attempts: 8 });
    } finally {
      db.close();
    }
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      const due = reopened.one<{ next_due_ms: number }>(
        'SELECT next_due_ms FROM mb_cover_art_jobs WHERE release_mbid=?',
        'cycle',
      )!.next_due_ms;
      await runCoverArtJobs({
        db: reopened,
        clock: fixedClock(due),
        client: vi.fn().mockRejectedValue(new Error('again')),
        cacheBudgetBytes: 100,
        enabled: true,
      });
      expect(
        reopened.one<{ status: string; attempts: number; next_due_ms: number }>(
          'SELECT status,attempts,next_due_ms FROM mb_cover_art_jobs WHERE release_mbid=?',
          'cycle',
        ),
      ).toEqual({ status: 'pending', attempts: 1, next_due_ms: due + 60_000 });
    } finally {
      reopened.close();
    }
  });
  it('disabled is egress-free and capacity defers work without exceeding byte budget', async () => {
    const { db } = setup();
    try {
      enqueueCoverArt(db, 'r', null, 0);
      const client = vi.fn().mockResolvedValue({ bytes: new Uint8Array(10), mimeType: 'image/png' });
      await runCoverArtJobs({ db, clock: fixedClock(0), client, cacheBudgetBytes: 5, enabled: false });
      expect(client).not.toHaveBeenCalled();
      await runCoverArtJobs({ db, clock: fixedClock(0), client, cacheBudgetBytes: 5, enabled: true });
      expect(
        db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes,
      ).toBeLessThanOrEqual(5);
      expect(db.one<{ status: string }>('SELECT status FROM mb_cover_art_jobs WHERE release_mbid=?', 'r')?.status).toBe(
        'pending',
      );
    } finally {
      db.close();
    }
  });
  it('trims an over-budget idle cache in bounded batches while disabled and with no jobs', async () => {
    const { db, path } = setup();
    try {
      for (let i = 0; i < 20; i++)
        putCoverArt(db, {
          releaseMbid: `idle-${i}`,
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          nowMs: i,
          budgetBytes: 100,
        });
      const client = vi.fn();
      for (let pass = 0; pass < 2; pass++) {
        const result = await runCoverArtJobs({
          db,
          clock: fixedClock(pass * 60_000),
          client,
          cacheBudgetBytes: 4,
          enabled: false,
        });
        expect(result.cleanupPending).toBe(pass === 0);
        expect(
          db.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes,
        ).toBeLessThanOrEqual(pass === 0 ? 12 : 4);
      }
      expect(client).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      expect(reopened.one<{ used_bytes: number }>('SELECT used_bytes FROM mb_cover_art_usage')?.used_bytes).toBe(4);
    } finally {
      reopened.close();
    }
  });
});
