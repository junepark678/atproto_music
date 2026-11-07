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
import { measureScrobbleBatch } from '@atmusic/atproto/scrobble-batch-size';
import type { Transport } from '@atmusic/atproto/transport';
import { listenKey } from '@atmusic/core/listen-key';
import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { ImportItemRow, ImportJobRow, OperationRow } from '../../../src/app/rows';
import {
  cancelJob,
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRuntime,
  intervalPacer,
  jobDto,
  runImports,
} from '../../../src/imports/jobs';
import { rebatchUnsentImports } from '../../../src/imports/rebatch';
import { fsUploadStore } from '../../../src/imports/uploads';
import { WRITE_SLICE, writeSlice } from '../../../src/imports/writer';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import {
  commitUnsentBatchListenRemoval,
  enqueueBatchListenDelete,
  prepareUnsentBatchListenRemoval,
} from '../../../src/outbox/batch-delete-ops';
import { newOperationId, unblockOperations } from '../../../src/outbox/operations';
import { insertScrobbleCreate, prepareScrobble } from '../../../src/outbox/scrobble-ops';
import { APPLY, CREATE, GET, type Harness, remoteRecords, SCROBBLE, T0, withHarness } from '../outbox/support';

const SCROBBLE_BATCH = 'com.example.atmusic.scrobbleBatch';

const T0S = Math.floor(T0 / 1000);
const HOUR = 3_600_000;
const DAY = 86_400_000;

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

function uploadJob(h: Harness, id: string, rows: Row[], did = h.alice): void {
  const dir = join(h.ctx.dir, 'imports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.upload`);
  const body = lastfmExport(rows);
  writeFileSync(path, body, { mode: 0o600 });
  createJob(h.db, {
    id,
    did,
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

async function stageLegacySingles(
  h: Harness,
  rt: ImportRuntime,
  id: string,
  rows: Row[],
  convert = rows.length,
): Promise<OperationRow[]> {
  uploadJob(h, id, rows);
  await parse(h, rt, id);
  const items = h.db.all<{ seq: number; dedupe_key: string; record_json: string }>(
    "SELECT seq, dedupe_key, record_json FROM import_items WHERE job_id = ? AND state = 'staged' ORDER BY seq LIMIT ?",
    id,
    convert,
  );
  const operations: OperationRow[] = [];
  for (const item of items) {
    const staged = JSON.parse(item.record_json) as { input: unknown };
    const prepared = await prepareScrobble(staged.input, h.m.config.prefix!, h.kit.clock.nowMs());
    if (!prepared.ok) throw new Error('fixture listen did not validate');
    const operation = insertScrobbleCreate(
      h.m,
      { did: h.alice, origin: 'import', prepared: prepared.prepared, importJobId: id },
      h.kit.clock.nowMs(),
    );
    h.db.run(
      "INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, ?, 'import', ?)",
      h.alice,
      item.dedupe_key,
      operation.id,
      h.kit.clock.nowMs(),
    );
    h.db.run(
      "UPDATE import_items SET state = 'queued', operation_id = ? WHERE job_id = ? AND seq = ?",
      operation.id,
      id,
      item.seq,
    );
    operations.push(operation);
  }
  return operations;
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
  it('rewrites a never-sent batch after async preparation, keeping siblings and releasing only the removed listen key', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-unsent-remove', [listen(31), listen(32)]);
      await parse(h, rt, 'job-unsent-remove');
      await runImports(rt, h.kit.clock.nowMs());
      const parent = h.ops()[0]!;
      const original = JSON.parse(parent.record_json!) as { listens: Array<{ id: string }> };
      const removedId = original.listens[0]!.id;
      const plan = await prepareUnsentBatchListenRemoval(h.m, {
        did: h.alice,
        operationId: parent.id,
        listenId: removedId,
      });
      expect(plan).not.toBeNull();
      const rewritten = commitUnsentBatchListenRemoval(h.m, plan!);
      expect(rewritten).toMatchObject({ state: 'queued', attempts: 0, send_started_at_ms: null });
      expect(JSON.parse(rewritten!.record_json!).listens).toHaveLength(1);
      expect(
        h.db.one<{ removed_at_ms: number | null }>(
          'SELECT removed_at_ms FROM import_items WHERE job_id = ? AND seq = 0',
          'job-unsent-remove',
        )?.removed_at_ms,
      ).toBe(T0);
      expect(h.db.all('SELECT entry_id FROM batch_entry_items WHERE operation_id = ?', parent.id)).toHaveLength(1);
      expect(h.db.all('SELECT operation_id FROM listen_keys WHERE operation_id = ?', parent.id)).toHaveLength(1);

      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.op(parent.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(1);
      expect(job(h, 'job-unsent-remove')).toMatchObject({ written: 1, failed_items: 0 });
    });
  });

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

      // One writer slice: 1,000 listens are packed into five durable records.
      const wrote = await runImports(rt, h.kit.clock.nowMs());
      expect(wrote.actions).toContainEqual({ jobId: 'job-w', action: 'wrote', detail: String(WRITE_SLICE) });
      expect(WRITE_SLICE).toBe(1_000);
      const ops = h.ops();
      expect(ops).toHaveLength(5);
      expect(
        ops.every(
          (o) =>
            o.kind === 'scrobble.create' &&
            o.origin === 'import' &&
            o.priority === 1 &&
            o.import_job_id === 'job-w' &&
            o.state === 'queued' &&
            o.collection === SCROBBLE_BATCH,
        ),
      ).toBe(true);
      expect(itemStates(h, 'job-w')).toEqual({ queued: 1_000, staged: 10 });
      // Each batch record holds 200 listens, and item rows preserve their shared operation mapping.
      const queued = h.db.all<ImportItemRow>(
        "SELECT * FROM import_items WHERE job_id = 'job-w' AND state = 'queued' ORDER BY seq",
      );
      expect(new Set(queued.map((i) => i.operation_id))).toEqual(new Set(ops.map((o) => o.id)));
      expect(ops.map((o) => (JSON.parse(o.record_json as string) as { listens: unknown[] }).listens.length)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(ops.length * 3).toBe(15);
      for (const op of ops) {
        const record = JSON.parse(op.record_json as string) as Parameters<typeof measureScrobbleBatch>[0];
        const sizes = measureScrobbleBatch(record, {
          repo: h.alice,
          collection: SCROBBLE_BATCH,
          rkey: op.rkey as string,
        });
        expect(sizes.cborBytes).toBeLessThanOrEqual(64_000);
        expect(sizes.createBodyBytes).toBeLessThanOrEqual(100_000);
      }
      expect(new Set(ops.map((o) => o.rkey)).size).toBe(5);
      expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 0 });

      // A second run makes no operation while 1,000 are queued.
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(5);

      // The outbox sends what the import share allows: one batch of 3, then nothing
      // more this hour. (Explicit runs: with more than 250 due operations of one DID
      // the N2-05 runner reports itself due again at once even when the budget parks
      // them, so runUntilIdle would not settle; see the package report.)
      expect((await h.run()).attempted).toBe(3);
      for (let i = 0; i < 3; i++) expect((await h.run()).attempted).toBe(0);
      expect(h.writers.count(CREATE)).toBe(3);
      // The next run counts them and refills exactly the room they freed.
      const refill = await runImports(rt, h.kit.clock.nowMs());
      expect(refill.actions).toContainEqual({ jobId: 'job-w', action: 'wrote', detail: '10' });
      expect(job(h, 'job-w')).toMatchObject({
        written: 600,
        failed_items: 0,
        duplicates: 3,
        invalid: 2,
        state: 'writing',
      });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(3);
      expect(jobDto(h.db, job(h, 'job-w'), h.kit.clock.nowMs())).toMatchObject({ written: 600, staged: 1_010 });
      expect(h.ops()).toHaveLength(6);
      expect(itemStates(h, 'job-w')).toEqual({ written: 600, queued: 410 });

      // Cancel: no new operation, ever; the queued ones are not withdrawn.
      expect((await cancelJob(rt, h.alice, 'job-w', h.kit.clock.nowMs()))?.state).toBe('cancelled');
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(6);
      expect(opStates(h, "origin = 'import'")).toEqual({ succeeded: 3, queued: 3 });
      // The next hour: the queued operations keep going and keep counting, and
      // the room they free is never refilled.
      h.kit.clock.advance(HOUR);
      const next = await h.run();
      expect(next.attempted).toBe(3);
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.ops()).toHaveLength(6);
      expect(itemStates(h, 'job-w')).toEqual({ written: 1_010 });
      expect(job(h, 'job-w')).toMatchObject({ state: 'cancelled', written: 1_010, staged: 1_010 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(6);
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
      expect(before).toHaveLength(1);
      const rkeys = before.map((o) => o.rkey);

      // The applyWrites batch reaches the PDS, then the process dies before the answer is read.
      const crashed = h.writers.crashOn(CREATE, 'after_commit');
      void h.run();
      await crashed;
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(1);

      h.restart();
      rt = runtime(h);
      const resumed = h.ops();
      expect(resumed.map((o) => o.rkey)).toEqual(rkeys);
      expect(resumed.every((o) => o.state === 'running' && o.attempts === 1)).toBe(true);

      await h.runUntilIdle();
      for (let i = 0; i < 5 && job(h, 'job-r').state !== 'done'; i++) await runImports(rt, h.kit.clock.nowMs());

      const records = await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH);
      expect(records.map((r) => r.rkey).sort()).toEqual([...rkeys].sort());
      expect((records[0]!.value as { listens: Array<{ track: string }> }).listens.map((r) => r.track).sort()).toEqual([
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
      expect(h.ops()).toHaveLength(1);
      expect(itemStates(h, 'job-d')).toEqual({ queued: 2, staged: 3 });

      low = false;
      h.kit.clock.advance(60_000);
      const back = await runImports(rt, h.kit.clock.nowMs());
      expect(back.actions.map((a) => a.action)).toEqual(['resumed', 'wrote']);
      expect(back.actions[1]).toMatchObject({ detail: '3' });
      expect(job(h, 'job-d')).toMatchObject({ state: 'writing', error: null });
      const items = h.db.all<ImportItemRow>("SELECT * FROM import_items WHERE job_id = 'job-d' ORDER BY seq");
      const ops = h.ops();
      expect(ops).toHaveLength(2);
      expect(new Set(items.map((i) => i.operation_id))).toEqual(new Set(ops.map((o) => o.id)));
      expect(
        ops
          .flatMap((o) =>
            (JSON.parse(o.record_json as string) as { listens: Array<{ track: string }> }).listens.map((r) => r.track),
          )
          .sort(),
      ).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5']);
    });
  });

  it('rebatches only queued never-sent import singles after rechecking all item and key links', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.m.config = { ...h.m.config, batchPublication: false };
      const rt = runtime(h);
      uploadJob(h, 'job-rebatch', [listen(1), listen(2), listen(3), listen(4), listen(5)]);
      await parse(h, rt, 'job-rebatch');
      const staged = h.db.all<{ seq: number; dedupe_key: string; record_json: string }>(
        "SELECT seq, dedupe_key, record_json FROM import_items WHERE job_id = 'job-rebatch' AND state = 'staged' ORDER BY seq",
      );
      for (const item of staged) {
        const stagedRecord = JSON.parse(item.record_json) as { kind: 'listen'; input: unknown };
        const prepared = await prepareScrobble(stagedRecord.input, h.m.config.prefix as string, h.kit.clock.nowMs());
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) continue;
        const id = newOperationId(h.m.random);
        const op = insertScrobbleCreate(
          h.m,
          {
            id,
            did: h.alice,
            origin: 'import',
            prepared: prepared.prepared,
            importJobId: 'job-rebatch',
          },
          h.kit.clock.nowMs(),
        );
        h.db.run(
          "INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, ?, 'import', ?)",
          h.alice,
          item.dedupe_key,
          id,
          h.kit.clock.nowMs(),
        );
        h.db.run(
          "UPDATE import_items SET state = 'queued', operation_id = ? WHERE job_id = 'job-rebatch' AND seq = ?",
          op.id,
          item.seq,
        );
      }
      const singles = h.ops();
      expect(singles).toHaveLength(5);
      h.db.run(
        "UPDATE operations SET state = 'succeeded', result_uri = ? WHERE id = ?",
        `at://${h.alice}/${SCROBBLE}/${singles[0]!.rkey}`,
        singles[0]!.id,
      );
      h.db.run('UPDATE operations SET attempts = 1 WHERE id = ?', singles[1]!.id);
      h.db.run('INSERT INTO operation_deps(op_id, pred_id) VALUES (?, ?)', singles[2]!.id, singles[1]!.id);
      h.m.config = { ...h.m.config, batchPublication: true };

      expect(await rebatchUnsentImports(h.m, 'job-rebatch', h.alice, h.kit.clock.nowMs())).toBe(2);
      const batches = h.db.all<{ id: string; collection: string; record_json: string }>(
        "SELECT id, collection, record_json FROM operations WHERE collection = ? AND origin = 'import'",
        SCROBBLE_BATCH,
      );
      expect(batches).toHaveLength(1);
      expect((JSON.parse(batches[0]?.record_json ?? '{}') as { listens: unknown[] }).listens).toHaveLength(2);
      expect(
        h.db.one("SELECT count(*) AS n FROM operations WHERE state = 'cancelled' AND last_error = 'rebatched'"),
      ).toEqual({ n: 2 });
      expect(
        h.db.one(
          "SELECT count(*) AS n FROM import_items WHERE job_id = 'job-rebatch' AND state = 'queued' AND operation_id = ?",
          batches[0]!.id,
        ),
      ).toEqual({ n: 2 });
      expect(
        h.db.one("SELECT count(*) AS n FROM listen_keys WHERE operation_id = ? AND source = 'import'", batches[0]!.id),
      ).toEqual({ n: 2 });
      expect(h.db.one('SELECT state FROM operations WHERE id = ?', singles[0]!.id)).toEqual({ state: 'succeeded' });
      expect(h.db.one('SELECT attempts FROM operations WHERE id = ?', singles[1]!.id)).toEqual({ attempts: 1 });
      expect(h.db.one('SELECT state FROM operations WHERE id = ?', singles[2]!.id)).toEqual({ state: 'queued' });
    });
  });

  it('keeps staged imported listens dormant without attempts or a polling alarm while publication is closed', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-held', [listen(1), listen(2)]);
      await parse(h, rt, 'job-held');
      h.m.config = { ...h.m.config, batchPublication: false };

      const held = await runImports(rt, h.kit.clock.nowMs());
      expect(held.nextDueMs).toBeNull();
      expect(h.ops()).toEqual([]);
      expect(itemStates(h, 'job-held')).toEqual({ staged: 2 });

      h.m.config = { ...h.m.config, batchPublication: true };
      const resumed = await runImports(rt, h.kit.clock.nowMs());
      expect(resumed.actions).toContainEqual({ jobId: 'job-held', action: 'wrote', detail: '2' });
      expect(h.ops()).toHaveLength(1);
    });
  });

  it('splits a definitely rejected container into durable children and keeps entry identities and per-item removal outcomes', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-split', [listen(21), listen(22)]);
      await parse(h, rt, 'job-split');
      await runImports(rt, h.kit.clock.nowMs());
      const parent = h.ops()[0]!;
      const parentRecord = JSON.parse(parent.record_json!) as { listens: Array<{ id: string; artist: string }> };
      expect(parentRecord.listens).toHaveLength(2);
      const removal = enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE_BATCH}/${parent.rkey}`,
        listenIds: [parentRecord.listens[0]!.id],
        origin: 'web',
      });

      h.kit.pds.Alice.serverError(CREATE, 413, 1);
      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(parent.id)).toMatchObject({ state: 'cancelled', last_error: 'batch_split' });
      const children = h.ops(`kind = 'scrobble.create' AND collection = '${SCROBBLE_BATCH}' AND id != '${parent.id}'`);
      expect(children).toHaveLength(2);
      const childEntries = children.flatMap(
        (child) => (JSON.parse(child.record_json!) as { listens: Array<{ id: string; artist: string }> }).listens,
      );
      expect(childEntries).toEqual(parentRecord.listens);
      expect(new Set(children.map((child) => child.rkey)).size).toBe(2);
      const removedChild = children.find((child) => child.record_json?.includes(parentRecord.listens[0]!.id));
      expect(removedChild).toBeDefined();
      expect(h.op(removal.id)).toMatchObject({ state: 'succeeded', rkey: parent.rkey });
      expect(
        h.ops(`kind = 'scrobble.delete' AND collection = '${SCROBBLE_BATCH}' AND id != '${removal.id}'`),
      ).toHaveLength(1);
      expect(
        h.db.one('SELECT record_uri FROM listen_removals WHERE listen_id = ?', parentRecord.listens[0]!.id),
      ).toEqual({
        record_uri: `at://${h.alice}/${SCROBBLE_BATCH}/${removedChild!.rkey}`,
      });
      expect(
        h.db.all<{ state: string; removed_at_ms: number | null; record_json: string }>(
          'SELECT state, removed_at_ms, record_json FROM import_items WHERE job_id = ? ORDER BY seq',
          'job-split',
        ),
      ).toEqual([
        { state: 'queued', removed_at_ms: T0, record_json: '{}' },
        { state: 'written', removed_at_ms: null, record_json: expect.any(String) },
      ]);
      expect(job(h, 'job-split')).toMatchObject({ written: 1, failed_items: 0 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(1);
    });
  });

  it.each([
    { name: 'wildcard', all: true },
    { name: 'explicit ids spanning both children', all: false },
  ])('partitions $name removal intent when a batch splits', async ({ all }) => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-split-removal', [listen(41), listen(42)]);
      await parse(h, rt, 'job-split-removal');
      await runImports(rt, h.kit.clock.nowMs());
      const parentBatch = h.ops()[0]!;
      const entries = (JSON.parse(parentBatch.record_json!) as { listens: Array<{ id: string }> }).listens;
      const intent = all ? ['*'] : entries.map((entry) => entry.id);
      const receipt = enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE_BATCH}/${parentBatch.rkey}`,
        listenIds: intent,
        origin: 'web',
      });
      h.kit.pds.Alice.serverError(CREATE, 413, 1);

      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(receipt.id).state).toBe('succeeded');
      const removals = h.ops(`kind = 'scrobble.delete' AND collection = '${SCROBBLE_BATCH}' AND id != '${receipt.id}'`);
      expect(removals).toHaveLength(2);
      expect(removals.every((operation) => operation.state === 'succeeded')).toBe(true);
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(0);
      expect(itemStates(h, 'job-split-removal')).toEqual({ queued: 2 });
    });
  });

  it('does not settle a split-delete receipt or item timestamp when one child removal fails', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-split-removal-failure', [listen(51), listen(52), listen(53), listen(54)]);
      await parse(h, rt, 'job-split-removal-failure');
      await runImports(rt, h.kit.clock.nowMs());
      const batch = h.ops()[0]!;
      const entries = (JSON.parse(batch.record_json!) as { listens: Array<{ id: string }> }).listens;
      const receipt = enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE_BATCH}/${batch.rkey}`,
        listenIds: [entries[0]!.id, entries[2]!.id],
        origin: 'web',
      });
      h.kit.pds.Alice.serverError(CREATE, 413, 1);
      h.kit.pds.Alice.fail(
        { nsid: 'com.atproto.repo.putRecord' },
        { kind: 'status', status: 422, error: 'Rejected', message: 'rejected child update' },
      );

      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(receipt.id)).toMatchObject({ state: 'failed', last_error: 'batch_delete_child_failed' });
      const items = h.db.all<{ removed_at_ms: number | null }>(
        'SELECT removed_at_ms FROM import_items WHERE job_id=? ORDER BY seq',
        'job-split-removal-failure',
      );
      expect(items.filter((item) => item.removed_at_ms !== null)).toHaveLength(1);
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(2);
    });
  });

  it('preserves wildcard deletion through repeated recursive batch splits', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-recursive-split-removal', [listen(61), listen(62), listen(63), listen(64)]);
      await parse(h, rt, 'job-recursive-split-removal');
      await runImports(rt, h.kit.clock.nowMs());
      const batch = h.ops()[0]!;
      const receipt = enqueueBatchListenDelete(h.m, {
        did: h.alice,
        uri: `at://${h.alice}/${SCROBBLE_BATCH}/${batch.rkey}`,
        listenIds: ['*'],
        origin: 'web',
      });
      h.kit.pds.Alice.serverError(CREATE, 413, 3);

      await h.runUntilIdle(20);
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(receipt.id).state).toBe('succeeded');
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(0);
      expect(
        h.db.all('SELECT child_operation_id FROM batch_delete_children WHERE parent_operation_id=?', receipt.id),
      ).toHaveLength(2);
    });
  });

  it('does not split a transient 500 carrying InvalidRecord text', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-transient-invalid-record', [listen(81), listen(82)]);
      await parse(h, rt, 'job-transient-invalid-record');
      await runImports(rt, h.kit.clock.nowMs());
      const parent = h.ops()[0]!;
      h.kit.pds.Alice.fail(
        { nsid: CREATE },
        { kind: 'status', status: 500, error: 'InvalidRecord', message: 'temporary backend failure' },
      );

      await h.run();

      expect(h.op(parent.id)).toMatchObject({ state: 'queued' });
      expect(h.op(parent.id).last_error).not.toBe('batch_split');
      expect(h.ops(`kind = 'scrobble.create' AND collection = '${SCROBBLE_BATCH}'`)).toHaveLength(1);
      expect(h.db.all('SELECT entry_id FROM batch_entry_items WHERE operation_id = ?', parent.id)).toHaveLength(2);
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(0);
    });
  });

  it('reconciles a legacy zero-attempt reauth row before rebatching or resending it', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      const [legacy] = await stageLegacySingles(h, rt, 'job-legacy-uncertain', [listen(91)]);
      const payload = JSON.parse(legacy!.record_json!) as Record<string, unknown>;
      await h.kit.externalPut('Alice', legacy!.collection, legacy!.rkey!, payload);
      h.db.run(
        "UPDATE operations SET state='blocked',attempts=0,send_started_at_ms=NULL,send_state='unknown',last_error='reauth_required' WHERE id=?",
        legacy!.id,
      );
      unblockOperations(h.db, h.alice, h.kit.clock.nowMs());

      await runImports(rt, h.kit.clock.nowMs());
      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(legacy!.id)).toMatchObject({ state: 'succeeded', send_state: 'unknown' });
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toHaveLength(0);
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toHaveLength(1);
      expect(job(h, 'job-legacy-uncertain')).toMatchObject({ written: 1, failed_items: 0 });
    });
  });

  it('preserves 833 written items, finishes the uncertain legacy singles at their original rkeys and batches the staged rest', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      const id = 'job-legacy-live-shape';
      // The live shape: 836 legacy singles queued before the upgrade (833
      // written, 3 with unknown send history) and listens still staged.
      const ops = await stageLegacySingles(
        h,
        rt,
        id,
        Array.from({ length: 846 }, (_, i) => listen(i)),
        836,
      );
      h.db.tx(() => {
        for (const op of ops.slice(0, 833)) {
          h.db.run(
            "UPDATE operations SET state='succeeded', attempts=1, result_uri=?, result_cid='legacy-written', send_state='unknown' WHERE id=?",
            `at://${h.alice}/${SCROBBLE}/${op.rkey}`,
            op.id,
          );
          h.db.run("UPDATE import_items SET state='written' WHERE operation_id=?", op.id);
        }
        h.db.run('UPDATE import_jobs SET written=833 WHERE id=?', id);
        for (const op of ops.slice(833)) h.db.run("UPDATE operations SET send_state='unknown' WHERE id=?", op.id);
      });
      const writtenBefore = h.db.all("SELECT * FROM operations WHERE state='succeeded' ORDER BY id");
      const uncertain = ops[833]!;
      // One pre-upgrade send had already committed remotely.
      await h.kit.externalPut('Alice', uncertain.collection, uncertain.rkey!, JSON.parse(uncertain.record_json!));
      expect(await rebatchUnsentImports(h.m, id, h.alice, h.kit.clock.nowMs())).toBe(0);

      for (let i = 0; i < 6 && job(h, id).state !== 'done'; i++) {
        await runImports(rt, h.kit.clock.nowMs());
        await h.runUntilIdle();
        h.kit.clock.advance(60_000);
      }
      await runImports(rt, h.kit.clock.nowMs());

      expect(
        job(h, id),
        JSON.stringify(
          h.db.all(
            "SELECT id,state,attempts,send_state,send_started_at_ms,last_error FROM operations WHERE state != 'succeeded'",
          ),
        ),
      ).toMatchObject({ state: 'done', written: 846, failed_items: 0 });
      expect(h.db.all("SELECT * FROM operations WHERE result_cid='legacy-written' ORDER BY id")).toEqual(writtenBefore);
      // The uncertain three finish as singles at their persisted keys: the
      // committed one is only read, the absent two are created there.
      for (const op of ops.slice(833)) expect(h.op(op.id)).toMatchObject({ state: 'succeeded', last_error: null });
      expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey).sort()).toEqual(
        ops
          .slice(833)
          .map((op) => op.rkey)
          .sort(),
      );
      expect(
        h.writers.sent
          .filter((send) => send.nsid === CREATE && send.body?.collection === SCROBBLE)
          .map((send) => send.body?.rkey),
      ).toEqual(ops.slice(834).map((op) => op.rkey));
      // The staged majority is batched automatically.
      const batches = await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH);
      expect(batches).toHaveLength(1);
      expect((batches[0]!.value as { listens: unknown[] }).listens).toHaveLength(10);
      expect(itemStates(h, id)).toEqual({ written: 846 });
      expect((await h.run()).nextDueMs).toBeNull();
    });
  });

  it('finishes an attempted legacy single at its original rkey and never rebatches it', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      const id = 'job-legacy-attempted';
      const [legacy, sibling] = await stageLegacySingles(h, rt, id, [listen(93), listen(94)]);
      h.db.run(
        "UPDATE operations SET state='queued', attempts=3, send_started_at_ms=?, send_state='unknown' WHERE import_job_id=?",
        T0 - HOUR,
        id,
      );
      expect(await rebatchUnsentImports(h.m, id, h.alice, h.kit.clock.nowMs())).toBe(0);

      for (let i = 0; i < 4 && job(h, id).state !== 'done'; i++) {
        await runImports(rt, h.kit.clock.nowMs());
        await h.runUntilIdle();
      }

      expect(job(h, id)).toMatchObject({ state: 'done', written: 2, failed_items: 0 });
      for (const op of [legacy!, sibling!]) expect(h.op(op.id)).toMatchObject({ state: 'succeeded', attempts: 4 });
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
      // One read, then one create, per listen, at the persisted key.
      expect(
        h.writers.sent.filter((send) => send.nsid === CREATE).map((send) => [send.body?.collection, send.body?.rkey]),
      ).toEqual([
        [SCROBBLE, legacy!.rkey],
        [SCROBBLE, sibling!.rkey],
      ]);
      expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey).sort()).toEqual(
        [legacy!.rkey, sibling!.rkey].sort(),
      );
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toEqual([]);
      expect((await h.run()).nextDueMs).toBeNull();
    });
  });

  it('only reads an interrupted tenth legacy attempt: present settles, absent fails without an eleventh send or a batch', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      const id = 'job-legacy-tenth';
      const [landed, absent] = await stageLegacySingles(h, rt, id, [listen(95), listen(96)]);
      h.db.run(
        "UPDATE operations SET state='running', attempts=10, send_started_at_ms=?, send_state='unknown' WHERE import_job_id=?",
        T0 - HOUR,
        id,
      );
      await h.kit.externalPut('Alice', landed!.collection, landed!.rkey!, JSON.parse(landed!.record_json!));
      expect(await rebatchUnsentImports(h.m, id, h.alice, h.kit.clock.nowMs())).toBe(0);

      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());

      expect(h.op(landed!.id)).toMatchObject({ state: 'succeeded', attempts: 10 });
      expect(h.op(absent!.id)).toMatchObject({ state: 'failed', attempts: 10, last_error: 'attempts_exhausted' });
      expect(h.writers.count(CREATE)).toBe(0);
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
      expect(job(h, id)).toMatchObject({ state: 'done', written: 1, failed_items: 1 });
      expect((await h.run()).nextDueMs).toBeNull();
    });
  });

  it.each([
    { landing: 'before the reconciliation read' },
    { landing: 'between the read and the create' },
    { landing: 'after the original-key create' },
  ] as const)(
    'an accepted pre-upgrade request that outlives its client abort and any delay, landing $landing, leaves one record at the original rkey',
    async ({ landing }) => {
      await withHarness(async (h) => {
        h.seedUser(h.alice);
        const rt = runtime(h);
        const id = 'job-legacy-accepted';
        const [legacy] = await stageLegacySingles(h, rt, id, [listen(97)]);
        h.db.run("UPDATE operations SET attempts=1, send_state='unknown' WHERE id=?", legacy!.id);
        const record = JSON.parse(legacy!.record_json!) as Record<string, unknown>;
        // The PDS accepts the pre-upgrade createRecord but holds its commit.
        let accepted!: () => void;
        const began = new Promise<void>((resolve) => {
          accepted = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let committed!: () => void;
        const done = new Promise<void>((resolve) => {
          committed = resolve;
        });
        h.kit.pds.Alice.fail(
          { nsid: CREATE },
          {
            kind: 'respond',
            respond: async () => {
              accepted();
              await gate;
              const commit = await h.kit.repos.Alice.put(legacy!.collection, legacy!.rkey!, record);
              committed();
              return Response.json({
                uri: `at://${h.alice}/${legacy!.collection}/${legacy!.rkey}`,
                cid: commit.ops[0]!.cid,
              });
            },
          },
        );
        const writer = (await h.writers.writerFor(h.alice))!;
        const abort = new AbortController();
        const old = writer
          .fetchHandler(`/xrpc/${CREATE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ repo: h.alice, collection: legacy!.collection, rkey: legacy!.rkey, record }),
            signal: abort.signal,
          })
          .then(
            () => 'answered',
            () => 'aborted',
          );
        await began;
        abort.abort(new DOMException('old process ended', 'AbortError'));
        expect(await old).toBe('aborted');
        const mark = h.writers.sent.length;
        // Far beyond any client deadline or recheck window.
        h.kit.clock.advance(10 * 60_000);
        if (landing === 'before the reconciliation read') {
          release();
          await done;
        }
        if (landing === 'between the read and the create') {
          const writerFor = h.writers.writerFor.bind(h.writers);
          h.writers.writerFor = async (did: string) => {
            const inner = (await writerFor(did))!;
            return {
              ...inner,
              fetchHandler: async (path: string, init: RequestInit) => {
                const response = await inner.fetchHandler(path, init);
                if (path.includes(GET)) {
                  release();
                  await done;
                }
                return response;
              },
            };
          };
        }

        for (let i = 0; i < 4 && job(h, id).state !== 'done'; i++) {
          expect(await rebatchUnsentImports(h.m, id, h.alice, h.kit.clock.nowMs())).toBe(0);
          await runImports(rt, h.kit.clock.nowMs());
          await h.runUntilIdle();
        }
        if (landing === 'after the original-key create') {
          release();
          await done;
        }

        const singles = await remoteRecords(h.kit, 'Alice', SCROBBLE);
        expect(singles.map((r) => r.rkey)).toEqual([legacy!.rkey]);
        expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toEqual([]);
        expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
        expect(h.op(legacy!.id)).toMatchObject({ state: 'succeeded', result_cid: singles[0]!.cid });
        expect(job(h, id)).toMatchObject({ state: 'done', written: 1, failed_items: 0 });
        // Every create the outbox sent named the original key.
        expect(
          h.writers.sent
            .slice(mark)
            .filter((send) => send.nsid === CREATE)
            .map((send) => send.body?.rkey),
        ).toEqual(landing === 'before the reconciliation read' ? [] : [legacy!.rkey]);
      });
    },
  );

  it('holds uncertain legacy creates when their reconciliation read is unavailable, then finishes them at their original rkey', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      const [legacy] = await stageLegacySingles(h, rt, 'job-legacy-read-failed', [listen(92)]);
      h.db.run("UPDATE operations SET send_state='unknown' WHERE id=?", legacy!.id);
      await runImports(rt, h.kit.clock.nowMs());
      h.kit.pds.Alice.fail({ nsid: GET }, { kind: 'status', status: 503, error: 'Unavailable' });

      const report = await h.run();

      expect(h.op(legacy!.id)).toMatchObject({
        state: 'queued',
        attempts: 0,
        send_state: 'unknown',
        last_error: 'remote_state_unavailable',
        due_at: T0 + 5_000,
      });
      expect(report.nextDueMs).toBe(T0 + 5_000);
      expect(h.writers.count(CREATE)).toBe(0);
      expect(await rebatchUnsentImports(h.m, 'job-legacy-read-failed', h.alice, h.kit.clock.nowMs())).toBe(0);
      h.kit.clock.advance(5_000);
      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.op(legacy!.id)).toMatchObject({ state: 'succeeded', attempts: 1, send_state: 'unknown' });
      expect((await remoteRecords(h.kit, 'Alice', SCROBBLE)).map((r) => r.rkey)).toEqual([legacy!.rkey]);
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
      expect(job(h, 'job-legacy-read-failed')).toMatchObject({ state: 'done', written: 1, failed_items: 0 });
    });
  });

  it.each([
    { window: 'hour', used: 2_499, resetMs: T0 + HOUR },
    { window: 'day', used: 17_499, resetMs: T0 + DAY },
  ] as const)(
    'parks a partial batch delete with one import point left in the $window window',
    async ({ window, used, resetMs }) => {
      await withHarness(async (h) => {
        h.seedUser(h.alice);
        const rt = runtime(h);
        uploadJob(h, `job-budget-${window}-partial-delete`, [listen(101), listen(102)]);
        await parse(h, rt, `job-budget-${window}-partial-delete`);
        await runImports(rt, h.kit.clock.nowMs());
        const batch = h.ops()[0]!;
        await h.runUntilIdle();
        const entries = (JSON.parse(batch.record_json!) as { listens: Array<{ id: string }> }).listens;
        const windowStart = window === 'hour' ? T0 : T0;
        h.db.run(
          `INSERT INTO pds_budget(did,window,window_start_ms,points) VALUES (?,?,?,?)
         ON CONFLICT(did,window) DO UPDATE SET window_start_ms=excluded.window_start_ms,points=excluded.points,
           limit_hint=NULL,remaining_hint=NULL,reset_at_ms=NULL`,
          h.alice,
          window,
          windowStart,
          used,
        );
        const partial = enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri: `at://${h.alice}/${SCROBBLE_BATCH}/${batch.rkey}`,
          listenIds: [entries[0]!.id],
          origin: 'import',
        });

        const parked = await h.run();

        expect(parked.nextDueMs).toBe(resetMs);
        expect(h.op(partial.id)).toMatchObject({ state: 'queued', attempts: 0 });
        h.kit.clock.set(new Date(resetMs).toISOString());
        await h.runUntilIdle();
        expect(h.op(partial.id).state).toBe('succeeded');

        const nextStart = h.kit.clock.nowMs();
        h.db.run(
          `INSERT INTO pds_budget(did,window,window_start_ms,points) VALUES (?,?,?,?)
         ON CONFLICT(did,window) DO UPDATE SET window_start_ms=excluded.window_start_ms,points=excluded.points,
           limit_hint=NULL,remaining_hint=NULL,reset_at_ms=NULL`,
          h.alice,
          window,
          nextStart,
          used,
        );
        const whole = enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri: `at://${h.alice}/${SCROBBLE_BATCH}/${batch.rkey}`,
          listenIds: ['*'],
          origin: 'import',
        });
        await h.runUntilIdle();

        expect(h.op(whole.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
        expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(0);
      });
    },
  );

  it('rolls back child insertion and item repointing together when the split transaction faults', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-split-fault', [listen(61), listen(62)]);
      await parse(h, rt, 'job-split-fault');
      await runImports(rt, h.kit.clock.nowMs());
      const parent = h.ops()[0]!;
      h.kit.pds.Alice.serverError(CREATE, 413, 2);
      const paused = h.writers.pauseOn(CREATE);
      const firstRun = h.run();
      await paused.reached;
      const originalTx = h.db.tx.bind(h.db);
      let fail = true;
      h.db.tx = (fn) =>
        originalTx(() => {
          const result = fn();
          if (fail) {
            fail = false;
            throw new Error('injected split commit failure');
          }
          return result;
        });
      paused.release();
      await expect(firstRun).rejects.toThrow('injected split commit failure');
      h.db.tx = originalTx;

      expect(h.op(parent.id)).toMatchObject({ state: 'running', attempts: 1 });
      expect(
        h.db.one(
          'SELECT count(*) AS n FROM operations WHERE import_job_id = ? AND id != ?',
          'job-split-fault',
          parent.id,
        ),
      ).toEqual({ n: 0 });
      expect(itemStates(h, 'job-split-fault')).toEqual({ queued: 2 });
      await h.runUntilIdle();
      await runImports(rt, h.kit.clock.nowMs());
      expect(h.op(parent.id)).toMatchObject({ state: 'cancelled', last_error: 'batch_split' });
      expect(job(h, 'job-split-fault')).toMatchObject({ written: 2, failed_items: 0 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(2);
    });
  });

  it('rechecks a single that starts sending while async rebatch preparation is in flight', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.m.config = { ...h.m.config, batchPublication: true };
      const rt = runtime(h);
      const [single] = await stageLegacySingles(h, rt, 'job-rebatch-race', [listen(71)]);
      const migration = rebatchUnsentImports(h.m, 'job-rebatch-race', h.alice, h.kit.clock.nowMs());
      // rebatch yields in digest preparation; a concurrent dispatcher wins first.
      h.db.run(
        "UPDATE operations SET state = 'running', attempts = 1, send_started_at_ms = ? WHERE id = ?",
        T0,
        single!.id,
      );

      expect(await migration).toBe(0);
      expect(h.op(single!.id)).toMatchObject({ state: 'running', attempts: 1, send_started_at_ms: T0 });
      expect(
        h.db.one('SELECT state, operation_id FROM import_items WHERE job_id = ? AND seq = 0', 'job-rebatch-race'),
      ).toEqual({ state: 'queued', operation_id: single!.id });
      expect(
        h.db.one(
          'SELECT operation_id FROM listen_keys WHERE did = ? AND dedupe_key = ?',
          h.alice,
          h.db.one<{ dedupe_key: string }>('SELECT dedupe_key FROM import_items WHERE job_id = ?', 'job-rebatch-race')!
            .dedupe_key,
        ),
      ).toEqual({ operation_id: single!.id });
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
    });
  });

  it('rolls back old operations and mappings together when the rebatch transaction faults', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.m.config = { ...h.m.config, batchPublication: true };
      const rt = runtime(h);
      const [single] = await stageLegacySingles(h, rt, 'job-rebatch-fault', [listen(81)]);
      const migration = rebatchUnsentImports(h.m, 'job-rebatch-fault', h.alice, h.kit.clock.nowMs());
      const originalTx = h.db.tx.bind(h.db);
      h.db.tx = (fn) =>
        originalTx(() => {
          fn();
          throw new Error('injected rebatch commit failure');
        });
      await expect(migration).rejects.toThrow('injected rebatch commit failure');
      h.db.tx = originalTx;

      expect(h.op(single!.id)).toMatchObject({ state: 'queued', attempts: 0 });
      expect(
        h.db.one('SELECT state, operation_id FROM import_items WHERE job_id = ? AND seq = 0', 'job-rebatch-fault'),
      ).toEqual({ state: 'queued', operation_id: single!.id });
      expect(
        h.db.one(
          'SELECT operation_id FROM listen_keys WHERE did = ? AND dedupe_key = ?',
          h.alice,
          h.db.one<{ dedupe_key: string }>('SELECT dedupe_key FROM import_items WHERE job_id = ?', 'job-rebatch-fault')!
            .dedupe_key,
        ),
      ).toEqual({ operation_id: single!.id });
      expect(h.ops(`collection = '${SCROBBLE_BATCH}'`)).toEqual([]);
    });
  });

  it('packs 1,000 listens into five three-point containers and preserves a one-listen remainder container', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.seedUser(h.bob);
      const rt = runtime(h);
      uploadJob(
        h,
        'job-thousand',
        Array.from({ length: 1_000 }, (_, i) => listen(i)),
      );
      await parse(h, rt, 'job-thousand');
      await runImports(rt, h.kit.clock.nowMs());
      const ops = h.ops("import_job_id = 'job-thousand'");
      expect(ops).toHaveLength(5);
      expect(ops.map((op) => (JSON.parse(op.record_json!) as { listens: unknown[] }).listens.length)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(jobDto(h.db, job(h, 'job-thousand'), h.kit.clock.nowMs()).etaSeconds).toBe(75);

      uploadJob(
        h,
        'job-remainder',
        Array.from({ length: 201 }, (_, i) => listen(i + 2_000)),
        h.bob,
      );
      await parse(h, rt, 'job-remainder');
      await runImports(rt, h.kit.clock.nowMs());
      const remainder = h.ops("import_job_id = 'job-remainder'");
      expect(remainder).toHaveLength(2);
      expect(remainder.map((op) => (JSON.parse(op.record_json!) as { listens: unknown[] }).listens.length)).toEqual([
        200, 1,
      ]);
    });
  });

  it('holds a batch lane on a missing-scope response without failing its imported listens', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-scope', [listen(31), listen(32)]);
      await parse(h, rt, 'job-scope');
      await runImports(rt, h.kit.clock.nowMs());
      h.kit.pds.Alice.fail(
        { nsid: CREATE },
        { kind: 'status', status: 403, error: 'ScopeMissing', message: 'missing scope' },
      );

      await h.run();
      await runImports(rt, h.kit.clock.nowMs());
      expect(job(h, 'job-scope')).toMatchObject({ state: 'paused', error: 'batch_scope_required', failed_items: 0 });
      expect(itemStates(h, 'job-scope')).toEqual({ queued: 2 });
      expect(
        h
          .ops("import_job_id = 'job-scope'")
          .every((op) => op.last_error === 'batch_scope_required' && op.state === 'blocked'),
      ).toBe(true);
    });
  });

  it('checks the granted token scope before starting a batch write', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-scope-precheck', [listen(41), listen(42)]);
      await parse(h, rt, 'job-scope-precheck');
      await runImports(rt, h.kit.clock.nowMs());
      h.writers.grantedScope = 'atproto';

      const report = await h.run();
      await runImports(rt, h.kit.clock.nowMs());
      expect(report.attempted).toBe(0);
      expect(h.writers.count(CREATE)).toBe(0);
      expect(job(h, 'job-scope-precheck')).toMatchObject({
        state: 'paused',
        error: 'batch_scope_required',
        failed_items: 0,
      });
      expect(
        h.ops("import_job_id = 'job-scope-precheck'").every((op) => op.attempts === 0 && op.state === 'blocked'),
      ).toBe(true);
    });
  });

  it('reads an attempted batch after a lost create success and never resends it', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const rt = runtime(h);
      uploadJob(h, 'job-lost-success', [listen(51), listen(52)]);
      await parse(h, rt, 'job-lost-success');
      await runImports(rt, h.kit.clock.nowMs());
      const parent = h.ops()[0]!;
      const crashed = h.writers.crashOn(CREATE, 'after_commit');
      void h.run();
      await crashed;
      h.restart();

      const mark = h.writers.sent.length;
      await h.runUntilIdle();
      const retried = h.writers.sent.slice(mark);
      expect(retried.map((request) => request.nsid)).toEqual([GET]);
      expect(h.op(parent.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE_BATCH)).toHaveLength(1);
    });
  });
});
