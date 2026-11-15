// Large legacy-import fixture kept out of worker-node's 5 s unit-test budget.
// This preserves the full 833-item recovery scenario from the node writer suite.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '@atmusic/atproto/transport';
import { describe, expect, it } from 'vitest';
import type { ImportJobRow, OperationRow } from '../../src/app/rows';
import { createJob, IMPORT_FETCH_CAPS, type ImportRuntime, intervalPacer, runImports } from '../../src/imports/jobs';
import { rebatchUnsentImports } from '../../src/imports/rebatch';
import { fsUploadStore } from '../../src/imports/uploads';
import { bindPolicyFetch, createPolicyFetch } from '../../src/node/policy-fetch';
import { insertScrobbleCreate, prepareScrobble } from '../../src/outbox/scrobble-ops';
import { CREATE, type Harness, remoteRecords, SCROBBLE, T0, withHarness } from '../node/outbox/support';

const SCROBBLE_BATCH = 'com.example.atmusic.scrobbleBatch';

const T0S = Math.floor(T0 / 1000);
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

const listen = (i: number): Row => ({ artist: `Artist ${i}`, track: `Track ${i}`, uts: T0S - 86_400 - i * 60 });

describe('legacy import writer fixture', () => {
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
});
