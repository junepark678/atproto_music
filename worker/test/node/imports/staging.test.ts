// Import staging, dedupe and the waiting_index gate (ADR 0005 §11.2; N3-09).
//
// Real pipeline throughout: an upload parsed by the `import` timer run
// (runImports), the writer, the server outbox writing to the fake PDS
// (worker/test/node/outbox/support.ts: signed repositories, policyFetch,
// fixture network), and the core's own admission and snapshot slice for the
// waiting_index gate. Frozen clock 2026-01-15T12:00:00Z; seeded randomness;
// no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '@atmusic/atproto/transport';
import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { ImportJobRow, OperationRow } from '../../../src/app/rows';
import { admissionWindow, admit } from '../../../src/do/ingest/admission';
import { snapshotStep } from '../../../src/do/ingest/snapshot-job';
import {
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRunReport,
  type ImportRuntime,
  intervalPacer,
  runImports,
} from '../../../src/imports/jobs';
import { fsUploadStore } from '../../../src/imports/uploads';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { acceptListens } from '../../../src/outbox/ingress';
import { type Harness, remoteRecords, SCROBBLE, T0, withHarness } from '../outbox/support';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const T0S = Math.floor(T0 / 1000);

function runtime(h: Harness, lb?: FakeListenBrainz): ImportRuntime {
  const transport = Object.assign(
    async (req: Request) =>
      lb !== undefined && new URL(req.url).hostname === 'listenbrainz.test' ? lb.fetch(req) : h.kit.transport(req),
    { fixture: true as const },
  ) as unknown as Transport;
  return {
    m: h.m,
    uploadDir: join(h.ctx.dir, 'imports'),
    lastfm: null,
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
    pacers: { lastfm: intervalPacer(), listenbrainz: intervalPacer() },
    diskLow: () => false,
    uploads: fsUploadStore,
    box: null,
  };
}

interface Row {
  artist: string;
  track: string;
  uts: number;
}

/** A lastfm.ghan.nl-style export: a JSON array of getRecentTracks pages. */
function lastfmExport(pages: Row[][]): string {
  return JSON.stringify(
    pages.map((rows, i) => ({
      recenttracks: {
        track: rows.map((r) => ({
          artist: { '#text': r.artist, mbid: '' },
          name: r.track,
          album: { '#text': '', mbid: '' },
          mbid: '',
          date: { uts: String(r.uts), '#text': '' },
        })),
        '@attr': { user: 'rj', page: String(i + 1), perPage: '200', totalPages: String(pages.length), total: '0' },
      },
    })),
  );
}

function uploadJob(h: Harness, id: string, did: string, body: string): string {
  const dir = join(h.ctx.dir, 'imports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.upload`);
  writeFileSync(path, body, { mode: 0o600 });
  createJob(h.db, {
    id,
    did,
    source: 'lastfm_json',
    remoteUser: null,
    uploadPath: path,
    uploadBytes: body.length,
    now: T0,
  });
  return path;
}

function job(h: Harness, id: string): ImportJobRow {
  return h.db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', id) as ImportJobRow;
}

/** An indexed (proven) scrobble row, as the verify drain leaves it. */
function indexScrobble(h: Harness, did: string, rkey: string, artist: string, track: string, seconds: number): void {
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  const at = toStorage(BigInt(seconds) * NS_PER_SECOND);
  h.db.run(
    `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `at://${did}/${SCROBBLE}/${rkey}`,
    'bafyreib2rxk3rh6kzwqindexedscrobble',
    did,
    rkey,
    rkey,
    artist,
    track,
    at,
    at,
    at,
    artistKey,
    trackKeyValue,
  );
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function runUntil(h: Harness, rt: ImportRuntime, stop: () => boolean, max = 20): Promise<ImportRunReport[]> {
  const reports: ImportRunReport[] = [];
  for (let i = 0; i < max && !stop(); i++) {
    reports.push(await runImports(rt, h.kit.clock.nowMs()));
    h.kit.clock.advance(1_000);
  }
  return reports;
}

describe('import staging', () => {
  it('listens already indexed, already submitted through /2.0 or /1, or repeated in the job are counted as duplicates and never written', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const s = (n: number) => T0S - 3_600 - n * 600;
      // Already indexed (the index row only; the dedupe must not care about case).
      indexScrobble(h, h.alice, '3lb2indexed22a', 'Indexed Artist', 'Indexed Track', s(1));
      // Already submitted through /2.0 (Last.fm) and /1 (ListenBrainz).
      const live = await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        listens: [{ input: { artist: 'Scrobbled Artist', track: 'Via 2.0', listenedAt: iso(s(2)) } }],
        receiptMs: T0,
      });
      const lbLive = await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: [{ input: { artist: 'LB Artist', track: 'Via 1', listenedAt: iso(s(3)) } }],
        receiptMs: T0,
      });
      expect(live.created + lbLive.created).toBe(2);

      const rows: Row[] = [
        { artist: 'INDEXED ARTIST', track: 'indexed track', uts: s(1) },
        { artist: 'Scrobbled Artist', track: 'Via 2.0', uts: s(2) },
        { artist: 'LB Artist', track: 'Via 1', uts: s(3) },
        { artist: 'Repeat Artist', track: 'Twice', uts: s(4) },
        { artist: 'Fresh Artist', track: 'Only Once', uts: s(5) },
        { artist: 'Late Artist', track: 'Arrives Live', uts: s(6) },
      ];
      // The repeat appears again on the next page (overlapping export pages).
      uploadJob(
        h,
        'job-dedupe',
        h.alice,
        lastfmExport([rows, [{ artist: 'repeat artist', track: 'Twice', uts: s(4) }]]),
      );
      const rt = runtime(h);

      // Parse: three staged, four duplicates (indexed, /2.0, /1, the repeat).
      await runUntil(h, rt, () => job(h, 'job-dedupe').state === 'writing');
      expect(job(h, 'job-dedupe')).toMatchObject({
        fetched: 7,
        staged: 3,
        duplicates: 4,
        invalid: 0,
        upload_path: null,
      });
      const staged = h.db.all<{ record_json: string }>(
        "SELECT record_json FROM import_items WHERE job_id = 'job-dedupe' ORDER BY seq",
      );
      expect(staged.map((i) => (JSON.parse(i.record_json) as { input: { track: string } }).input.track)).toEqual([
        'Twice',
        'Only Once',
        'Arrives Live',
      ]);

      // A live /1 listen of a staged item arrives before the writer: a duplicate at write time.
      await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: [{ input: { artist: 'Late Artist', track: 'Arrives Live', listenedAt: iso(s(6)) } }],
        receiptMs: T0,
      });
      await runImports(rt, h.kit.clock.nowMs());
      const imports = h.ops("origin = 'import'");
      expect(imports.map((o) => (JSON.parse(o.record_json as string) as { track: string }).track)).toEqual([
        'Twice',
        'Only Once',
      ]);
      expect(
        imports.every((o) => o.kind === 'scrobble.create' && o.priority === 1 && o.import_job_id === 'job-dedupe'),
      ).toBe(true);
      expect(job(h, 'job-dedupe')).toMatchObject({ staged: 3, duplicates: 5 });
      // Imports never queue forward rows; the earlier live listen keys keep their sources.
      expect(
        h.db.all<{ source: string; n: number }>(
          'SELECT source, count(*) AS n FROM listen_keys WHERE did = ? GROUP BY source ORDER BY source',
          h.alice,
        ),
      ).toEqual([
        { source: 'import', n: 2 },
        { source: 'lastfm', n: 1 },
        { source: 'listenbrainz', n: 2 },
      ]);

      // The outbox writes everything; the job finishes with exact counts.
      await h.runUntilIdle();
      await runUntil(h, rt, () => job(h, 'job-dedupe').state === 'done');
      expect(job(h, 'job-dedupe')).toMatchObject({ state: 'done', written: 2, failed_items: 0, duplicates: 5 });
      const records = (await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => (r.value as { track: string }).track);
      // One record per listen; nothing for the indexed one (never written by us).
      expect(records.sort()).toEqual(['Arrives Live', 'Only Once', 'Twice', 'Via 1', 'Via 2.0']);
      const succeeded = h.db.all<OperationRow>("SELECT * FROM operations WHERE state = 'succeeded'");
      expect(succeeded).toHaveLength(5);
    });
  });

  it("a job stays waiting_index until the DID's indexing_state is current; a newly signed-in DID with zero records reaches current and the job leaves waiting_index", async () => {
    await withHarness(async (h) => {
      const clock = h.kit.clock;
      const lb = new FakeListenBrainz({ clock });
      lb.seedListens('bob_lb', [
        { listened_at: T0S - 7_200, track_metadata: { artist_name: 'B', track_name: 'One' } },
        { listened_at: T0S - 3_600, track_metadata: { artist_name: 'B', track_name: 'Two' } },
      ]);
      const rt = runtime(h, lb);
      // Carol's index is stale (a control that never becomes current here).
      h.seedUser(h.kit.users.Carol.did);
      h.db.run("UPDATE users SET indexing_state = 'stale' WHERE did = ?", h.kit.users.Carol.did);
      // Bob signs in: the OAuth callback admits him (N3-01); his repository holds no record.
      expect(admit(h.db, h.bob, 'notify', clock.nowMs())).toMatchObject({ status: 'admitted' });
      expect(h.db.one('SELECT indexing_state FROM users WHERE did = ?', h.bob)).toEqual({
        indexing_state: 'recovering',
      });
      createJob(h.db, { id: 'job-bob', did: h.bob, source: 'listenbrainz_api', remoteUser: 'bob_lb', now: T0 });
      createJob(h.db, {
        id: 'job-carol',
        did: h.kit.users.Carol.did,
        source: 'listenbrainz_api',
        remoteUser: 'carol_lb',
        now: T0,
      });

      for (let i = 0; i < 3; i++) {
        const report = await runImports(rt, clock.nowMs());
        expect(report.actions).toEqual([
          { jobId: 'job-bob', action: 'waiting_index' },
          { jobId: 'job-carol', action: 'waiting_index' },
        ]);
        expect(report.slices).toBe(0);
        clock.advance(5_000);
      }
      expect(lb.calls.entries).toHaveLength(0);
      expect(job(h, 'job-bob').state).toBe('waiting_index');

      // The admission snapshot of Bob's empty repository runs (the core's snapshot slice).
      for (let i = 0; i < 5; i++) {
        const step = await snapshotStep(h.m, clock.nowMs());
        if (step.did === null && i > 0) break;
        clock.advance(1_000);
      }
      expect(h.db.one('SELECT indexing_state, active FROM users WHERE did = ?', h.bob)).toEqual({
        indexing_state: 'current',
        active: 1,
      });
      expect(h.db.one('SELECT count(*) AS n FROM scrobbles WHERE did = ?', h.bob)).toEqual({ n: 0 });

      const report = await runImports(rt, clock.nowMs());
      expect(report.actions).toEqual([
        { jobId: 'job-bob', action: 'started' },
        { jobId: 'job-carol', action: 'waiting_index' },
        { jobId: 'job-bob', action: 'page', detail: '2' },
      ]);
      expect(job(h, 'job-bob')).toMatchObject({ state: 'writing', fetched: 2, staged: 2 });
      expect(job(h, 'job-carol').state).toBe('waiting_index');
      expect(lb.calls.entries.map((c) => c.path)).toEqual(['/1/user/bob_lb/listens']);
    });
  });

  it('when admission answers queue_full the import timer retries admission with backoff and the job leaves waiting_index once admitted', async () => {
    await withHarness(async (h) => {
      const clock = h.kit.clock;
      const lb = new FakeListenBrainz({ clock });
      lb.seedListens('bob_lb', [{ listened_at: T0S - 60, track_metadata: { artist_name: 'B', track_name: 'Late' } }]);
      const rt = runtime(h, lb);
      // This hour's admission budget is spent: admit() answers busy (queue_full).
      h.db.run('INSERT INTO admission(window_start_ms, admitted) VALUES (?, 50)', admissionWindow(T0));
      createJob(h.db, { id: 'job-q', did: h.bob, source: 'listenbrainz_api', remoteUser: 'bob_lb', now: T0 });
      const usersRow = () => h.db.one('SELECT indexing_state FROM users WHERE did = ?', h.bob);

      const first = await runImports(rt, clock.nowMs());
      expect(first.actions).toEqual([
        { jobId: 'job-q', action: 'admission_busy', atMs: T0 + 60_000, detail: 'hourly_budget' },
      ]);
      expect(first.nextDueMs).toBe(T0 + 60_000);
      expect(usersRow()).toBeNull();

      // Before the backoff ends admission is not asked at all.
      clock.set(new Date(T0 + 30_000).toISOString());
      expect((await runImports(rt, clock.nowMs())).actions).toEqual([
        { jobId: 'job-q', action: 'admission_backoff', atMs: T0 + 60_000 },
      ]);
      // Then retried, still busy: the backoff doubles.
      clock.set(new Date(T0 + 60_000).toISOString());
      expect((await runImports(rt, clock.nowMs())).actions).toEqual([
        { jobId: 'job-q', action: 'admission_busy', atMs: T0 + 180_000, detail: 'hourly_budget' },
      ]);
      expect(h.db.one('SELECT admitted FROM admission WHERE window_start_ms = ?', admissionWindow(T0))).toEqual({
        admitted: 50,
      });
      expect(usersRow()).toBeNull();
      expect(job(h, 'job-q').state).toBe('waiting_index');

      // The next hour's window has room: the retry admits the DID.
      clock.set(new Date(T0 + 3_600_000).toISOString());
      expect((await runImports(rt, clock.nowMs())).actions).toEqual([{ jobId: 'job-q', action: 'admitted' }]);
      expect(usersRow()).toEqual({ indexing_state: 'recovering' });
      expect(h.db.one('SELECT kind, state FROM repo_jobs WHERE did = ?', h.bob)).toEqual({
        kind: 'snapshot',
        state: 'pending',
      });
      expect(job(h, 'job-q').state).toBe('waiting_index');

      // Its admission snapshot completes; the job leaves waiting_index.
      for (let i = 0; i < 5 && (usersRow() as { indexing_state: string }).indexing_state !== 'current'; i++) {
        await snapshotStep(h.m, clock.nowMs());
        clock.advance(1_000);
      }
      expect(usersRow()).toEqual({ indexing_state: 'current' });
      const started = await runImports(rt, clock.nowMs());
      expect(started.actions.map((a) => a.action)).toEqual(['started', 'page']);
      expect(job(h, 'job-q')).toMatchObject({ state: 'writing', staged: 1 });
    });
  });
});
