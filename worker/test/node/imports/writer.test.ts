// The import writer (ADR 0005 §11.2 step 4, §11.4, §5.8; N3-09).
//
// Staged items → import-priority outbox operations → PDS records, through the
// real `import` timer run (runImports), the real server outbox (runOutbox) and
// the fake PDS of the fixture network (worker/test/node/outbox/support.ts).
// Fault injection only through injected interfaces: the writers' crash hook,
// the `diskLow` predicate. Frozen clock 2026-01-15T12:00:00Z; seeded
// randomness; no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '@atmusic/atproto/transport';
import { listenKey } from '@atmusic/core/listen-key';
import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { ImportItemRow, ImportJobRow } from '../../../src/app/rows';
import {
  cancelJob,
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRuntime,
  intervalPacer,
  jobDto,
  runImports,
} from '../../../src/imports/jobs';
import { fsUploadStore } from '../../../src/imports/uploads';
import { WRITE_SLICE, writeSlice } from '../../../src/imports/writer';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { APPLY, type Harness, remoteRecords, SCROBBLE, T0, withHarness } from '../outbox/support';

const T0S = Math.floor(T0 / 1000);
const HOUR = 3_600_000;

function runtime(h: Harness, diskLow: () => boolean = () => false): ImportRuntime {
  const transport = Object.assign(async (req: Request) => h.kit.transport(req), {
    fixture: true as const,
  }) as unknown as Transport;
  return {
    m: h.m,
    uploadDir: join(h.ctx.dir, 'imports'),
    lastfm: null,
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
    pacers: { lastfm: intervalPacer(), listenbrainz: intervalPacer() },
    diskLow,
    uploads: fsUploadStore,
    box: null,
  };
}

interface Row {
  artist: string;
  track: string;
  uts: string | number;
}

function lastfmExport(rows: Row[]): string {
  return JSON.stringify([
    {
      recenttracks: {
        track: rows.map((r) => ({
          artist: { '#text': r.artist, mbid: '' },
          name: r.track,
          album: { '#text': '', mbid: '' },
          mbid: '',
          date: { uts: String(r.uts), '#text': '' },
        })),
      },
    },
  ]);
}

function uploadJob(h: Harness, id: string, rows: Row[]): void {
  const dir = join(h.ctx.dir, 'imports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.upload`);
  const body = lastfmExport(rows);
  writeFileSync(path, body, { mode: 0o600 });
  createJob(h.db, {
    id,
    did: h.alice,
    source: 'lastfm_json',
    remoteUser: null,
    uploadPath: path,
    uploadBytes: body.length,
    now: h.kit.clock.nowMs(),
  });
}

function job(h: Harness, id: string): ImportJobRow {
  return h.db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', id) as ImportJobRow;
}

function itemStates(h: Harness, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of h.db.all<{ state: string; n: number }>(
    'SELECT state, count(*) AS n FROM import_items WHERE job_id = ? GROUP BY state',
    id,
  )) {
    out[r.state] = r.n;
  }
  return out;
}

function opStates(h: Harness, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of h.db.all<{ state: string; n: number }>(
    `SELECT state, count(*) AS n FROM operations WHERE ${where} GROUP BY state`,
  )) {
    out[r.state] = r.n;
  }
  return out;
}

async function parse(h: Harness, rt: ImportRuntime, id: string): Promise<void> {
  for (let i = 0; i < 10 && job(h, id).state !== 'writing'; i++) await runImports(rt, h.kit.clock.nowMs());
  expect(job(h, id).state).toBe('writing');
}

/** Writes by the user's other apps, straight to their PDS: `n` Bluesky likes (3 points each). */
async function otherAppLikes(h: Harness, n: number): Promise<void> {
  for (let done = 0; done < n; done += 200) {
    const writes = Array.from({ length: Math.min(200, n - done) }, (_, i) => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: 'app.bsky.feed.like',
      value: {
        $type: 'app.bsky.feed.like',
        subject: {
          uri: `at://${h.bob}/app.bsky.feed.post/3k${String(done + i).padStart(11, '2')}`,
          cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
        },
        createdAt: '2026-01-15T12:00:00Z',
      },
    }));
    const res = await h.kit.transport(
      new Request(`${h.kit.users.Alice.origin}/xrpc/${APPLY}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.kit.users.Alice.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: h.alice, writes }),
      }),
    );
    expect(res.status).toBe(200);
  }
}

const listen = (i: number): Row => ({ artist: `Artist ${i}`, track: `Track ${i}`, uts: T0S - 86_400 - i * 60 });

describe('import writer', () => {
  it('staged items become import-priority operations within the budget; written, duplicates and invalid counts are exact; cancel stops new operations', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rows: Row[] = Array.from({ length: 1_010 }, (_, i) => listen(i));
      // Three duplicates: a repeat in the export, an indexed listen, a listen key from /2.0.
      rows.push({ ...listen(5) });
      const indexed: Row = { artist: 'Indexed', track: 'Already', uts: T0S - 7_200 };
      const keyed: Row = { artist: 'Keyed', track: 'Via 2.0', uts: T0S - 7_260 };
      rows.push(indexed, keyed);
      // Two invalid: an empty artist and a timestamp that is not whole seconds.
      rows.push({ artist: '', track: 'No Artist', uts: T0S - 7_320 });
      rows.push({ artist: 'Bad Time', track: 'Never', uts: 'yesterday' });
      const [ak, tk] = trackKey(indexed.artist, indexed.track);
      const at = toStorage(BigInt(indexed.uts) * NS_PER_SECOND);
      h.db.run(
        `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        `at://${h.alice}/${SCROBBLE}/3lb2indexedaaa`,
        'bafyreib2rxk3rh6kzwqindexed',
        h.alice,
        '3lb2indexedaaa',
        '3lb2indexedaaa',
        indexed.artist,
        indexed.track,
        at,
        at,
        at,
        ak,
        tk,
      );
      h.db.run(
        `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, NULL, 'lastfm', ?)`,
        h.alice,
        await listenKey({
          did: h.alice,
          listenedAtNs: BigInt(keyed.uts) * NS_PER_SECOND,
          artist: keyed.artist,
          track: keyed.track,
        }),
        T0,
      );
      // The PDS budget: the user's other apps already spent 2,490 of the hour's
      // points (830 likes, on the PDS and in the ledger), so the import share
      // (50 % of 5,000) leaves 10 points: three creates.
      await otherAppLikes(h, 830);
      h.db.run(`INSERT INTO pds_budget(did, window, window_start_ms, points) VALUES (?, 'hour', ?, 2490)`, h.alice, T0);

      const rt = runtime(h);
      uploadJob(h, 'job-w', rows);
      await parse(h, rt, 'job-w');
      expect(job(h, 'job-w')).toMatchObject({ fetched: 1_015, staged: 1_010, duplicates: 3, invalid: 2 });
      expect(JSON.parse(job(h, 'job-w').invalid_reasons)).toEqual({ artist_invalid: 1, timestamp_invalid: 1 });

      // One writer slice: exactly 1,000 operations, origin import, priority 1.
      const wrote = await runImports(rt, h.kit.clock.nowMs());
      expect(wrote.actions).toContainEqual({ jobId: 'job-w', action: 'wrote', detail: String(WRITE_SLICE) });
      expect(WRITE_SLICE).toBe(1_000);
      const ops = h.ops();
      expect(ops).toHaveLength(1_000);
      expect(
        ops.every(
          (o) =>
            o.kind === 'scrobble.create' &&
            o.origin === 'import' &&
            o.priority === 1 &&
            o.import_job_id === 'job-w' &&
            o.state === 'queued' &&
            o.collection === SCROBBLE,
        ),
      ).toBe(true);
      expect(itemStates(h, 'job-w')).toEqual({ queued: 1_000, staged: 10 });
      // Each queued item names its own operation; the records keep the item order.
      const queued = h.db.all<ImportItemRow>(
        "SELECT * FROM import_items WHERE job_id = 'job-w' AND state = 'queued' ORDER BY seq",
      );
      expect(queued.map((i) => i.operation_id)).toEqual(ops.map((o) => o.id));
      expect(new Set(ops.map((o) => o.rkey)).size).toBe(1_000);
      expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 0 });

      // A second run makes no operation while 1,000 are queued.
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(1_000);

      // The outbox sends what the import share allows: one batch of 3, then nothing
      // more this hour. (Explicit runs: with more than 250 due operations of one DID
      // the N2-05 runner reports itself due again at once even when the budget parks
      // them, so runUntilIdle would not settle; see the package report.)
      expect((await h.run()).batches).toEqual([3]);
      for (let i = 0; i < 3; i++) expect((await h.run()).attempted).toBe(0);
      expect(h.writers.count(APPLY)).toBe(1);
      // The next run counts them and refills exactly the room they freed.
      const refill = await runImports(rt, h.kit.clock.nowMs());
      expect(refill.actions).toContainEqual({ jobId: 'job-w', action: 'wrote', detail: '3' });
      expect(job(h, 'job-w')).toMatchObject({
        written: 3,
        failed_items: 0,
        duplicates: 3,
        invalid: 2,
        state: 'writing',
      });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(3);
      expect(jobDto(h.db, job(h, 'job-w'), h.kit.clock.nowMs())).toMatchObject({ written: 3, staged: 1_010 });
      expect(h.ops()).toHaveLength(1_003);
      expect(itemStates(h, 'job-w')).toEqual({ written: 3, queued: 1_000, staged: 7 });

      // Cancel: no new operation, ever; the queued ones are not withdrawn.
      expect((await cancelJob(rt, h.alice, 'job-w', h.kit.clock.nowMs()))?.state).toBe('cancelled');
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(1_003);
      expect(opStates(h, "origin = 'import'")).toEqual({ succeeded: 3, queued: 1_000 });
      // The next hour: the queued operations keep going and keep counting, and
      // the room they free is never refilled.
      h.kit.clock.advance(HOUR);
      const next = await h.run();
      expect(next.batches).toEqual([200]);
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(1_003);
      expect(itemStates(h, 'job-w')).toEqual({ written: 203, queued: 800, staged: 7 });
      expect(job(h, 'job-w')).toMatchObject({ state: 'cancelled', written: 203, staged: 1_010 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(203);
    });
  }, 60_000);

  it('a restart mid-batch reuses the allocated rkeys and the PDS ends with exactly one record per unique listen', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rows = [listen(1), listen(2), listen(3), { ...listen(2) }, listen(4), listen(5)];
      let rt = runtime(h);
      uploadJob(h, 'job-r', rows);
      await parse(h, rt, 'job-r');
      await runImports(rt, h.kit.clock.nowMs());
      const before = h.ops();
      expect(before).toHaveLength(5);
      const rkeys = before.map((o) => o.rkey);

      // The applyWrites batch reaches the PDS, then the process dies before the answer is read.
      const crashed = h.writers.crashOn(APPLY, 'after_commit');
      void h.run();
      await crashed;
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(5);

      h.restart();
      rt = runtime(h);
      const resumed = h.ops();
      expect(resumed.map((o) => o.rkey)).toEqual(rkeys);
      expect(resumed.every((o) => o.state === 'running' && o.attempts === 1)).toBe(true);

      await h.runUntilIdle();
      for (let i = 0; i < 5 && job(h, 'job-r').state !== 'done'; i++) await runImports(rt, h.kit.clock.nowMs());

      const records = await remoteRecords(h.kit, 'Alice', SCROBBLE);
      expect(records.map((r) => r.rkey).sort()).toEqual([...rkeys].sort());
      expect(records.map((r) => (r.value as { track: string }).track).sort()).toEqual([
        'Track 1',
        'Track 2',
        'Track 3',
        'Track 4',
        'Track 5',
      ]);
      expect(h.ops().map((o) => [o.rkey, o.state])).toEqual(rkeys.map((r) => [r, 'succeeded']));
      expect(job(h, 'job-r')).toMatchObject({
        state: 'done',
        fetched: 6,
        staged: 5,
        duplicates: 1,
        written: 5,
        failed_items: 0,
      });
    });
  });

  it('while diskLow reports true the writer creates no operations and the job reports paused with low_disk, and it continues from the same item when space returns', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      let low = false;
      const rt = runtime(h, () => low);
      uploadJob(h, 'job-d', [listen(1), listen(2), listen(3), listen(4), listen(5)]);
      await parse(h, rt, 'job-d');
      // An earlier slice wrote the first two items.
      expect((await writeSlice(h.m, { id: 'job-d', did: h.alice }, h.kit.clock.nowMs(), 2)).created).toBe(2);

      low = true;
      const paused = await runImports(rt, h.kit.clock.nowMs());
      expect(paused.actions).toContainEqual({ jobId: 'job-d', action: 'paused', detail: 'low_disk' });
      expect(jobDto(h.db, job(h, 'job-d'), h.kit.clock.nowMs())).toMatchObject({ state: 'paused', error: 'low_disk' });
      h.kit.clock.advance(60_000);
      const still = await runImports(rt, h.kit.clock.nowMs());
      expect(still.slices).toBe(0);
      expect(still.nextDueMs).toBe(h.kit.clock.nowMs() + 60_000);
      expect(h.ops()).toHaveLength(2);
      expect(itemStates(h, 'job-d')).toEqual({ queued: 2, staged: 3 });

      low = false;
      h.kit.clock.advance(60_000);
      const back = await runImports(rt, h.kit.clock.nowMs());
      expect(back.actions.map((a) => a.action)).toEqual(['resumed', 'wrote']);
      expect(back.actions[1]).toMatchObject({ detail: '3' });
      expect(job(h, 'job-d')).toMatchObject({ state: 'writing', error: null });
      const items = h.db.all<ImportItemRow>("SELECT * FROM import_items WHERE job_id = 'job-d' ORDER BY seq");
      const ops = h.ops();
      expect(ops).toHaveLength(5);
      // Item by item in staging order, each with exactly one operation.
      expect(items.map((i) => i.operation_id)).toEqual(ops.map((o) => o.id));
      expect(ops.map((o) => (JSON.parse(o.record_json as string) as { track: string }).track)).toEqual([
        'Track 1',
        'Track 2',
        'Track 3',
        'Track 4',
        'Track 5',
      ]);
    });
  });
});
