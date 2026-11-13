import { listenKey } from '@atmusic/core/listen-key';
import { newTid } from '@atmusic/core/record-key';
import { scrobbleBatchCollection } from '@atmusic/core/scrobble-batch';
import { toStorage } from '@atmusic/core/timestamp';
import { expect, it, vi } from 'vitest';
import { removeScrobble } from '../../../src/lastfm/write-methods';
import { insertOperation, prepare } from '../../../src/outbox/operations';
import { withHarness } from './support';

async function seedBatch(h: Parameters<Parameters<typeof withHarness>[0]>[0], explicit: boolean) {
  const did = h.alice;
  h.seedUser(did);
  h.account(did);
  const now = h.m.clock.nowMs();
  const listens = [0, 1].map((index) => ({
    id: newTid(h.m.clock, h.m.random),
    artist: 'Artist',
    track: `Track ${index}`,
    listenedAt: new Date((100 + index) * 1000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }));
  const record = {
    $type: scrobbleBatchCollection(h.m.config.prefix!),
    createdAt: new Date(now).toISOString(),
    listens,
  };
  insertOperation(
    h.db,
    {
      id: 'batch-create',
      did,
      kind: 'scrobble.create',
      origin: 'import',
      collection: record.$type,
      rkey: newTid(h.m.clock, h.m.random),
      prepared: await prepare(record),
      dueAt: now,
      importJobId: explicit ? 'batch-job' : null,
    },
    now,
  );
  if (explicit) {
    h.db.run(
      "INSERT INTO import_jobs(id,did,source,created_at_ms,updated_at_ms) VALUES('batch-job',?,'lastfm_api',?,?)",
      did,
      now,
      now,
    );
  }
  for (let index = 0; index < listens.length; index++) {
    const member = listens[index]!;
    const second = 100 + index;
    const key = await listenKey({
      did,
      artist: member.artist,
      track: member.track,
      listenedAtNs: BigInt(second) * 1_000_000_000n,
    });
    h.db.run(
      "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,'batch-create','import',?,?)",
      did,
      key,
      now,
      second,
    );
    if (explicit) {
      h.db.run(
        "INSERT INTO import_items(job_id,seq,dedupe_key,listened_at,record_json,state,operation_id) VALUES('batch-job',?,?,?,?,'queued','batch-create')",
        index,
        key,
        toStorage(BigInt(second) * 1_000_000_000n),
        JSON.stringify(member),
      );
      h.db.run(
        "INSERT INTO batch_entry_items(operation_id,entry_id,job_id,seq) VALUES('batch-create',?,'batch-job',?)",
        member.id,
        index,
      );
    }
  }
  return { did, listens };
}

it.each([
  [false, 'pending'],
  [true, 'pending'],
  [false, 'unknown'],
  [true, 'unknown'],
  [false, 'completed'],
  [true, 'completed'],
] as const)('retry absorbs intervening coverage (explicit=%s, mode=%s)', async (explicit, mode) =>
  withHarness(async (h) => {
    const { did } = await seedBatch(h, explicit);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let releaseFirst!: () => void, reachedFirst!: () => void, releaseRetry!: () => void, reachedRetry!: () => void;
    const firstReached = new Promise<void>((r) => (reachedFirst = r)),
      firstRelease = new Promise<void>((r) => (releaseFirst = r));
    const retryReached = new Promise<void>((r) => (reachedRetry = r)),
      retryRelease = new Promise<void>((r) => (releaseRetry = r));
    let phase = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (a, d) => {
      const text = new TextDecoder().decode(d as ArrayBuffer);
      if (phase === 0 && text.startsWith('{') && text.includes('Track 0') && !text.includes('Track 1')) {
        phase = 1;
        reachedFirst();
        await firstRelease;
        phase = 2;
      } else if (phase === 2) {
        phase = 3;
        reachedRetry();
        await retryRelease;
      }
      return original(a, d);
    });
    try {
      const request = { did, artist: 'Artist', track: 'Track 1', timestamp: 101 };
      const outstanding = removeScrobble(h.m, request);
      await firstReached;
      expect(await removeScrobble(h.m, { did, artist: 'Artist', track: 'Track 0', timestamp: 100 })).toMatchObject([
        { kind: 'rewritten' },
      ]);
      releaseFirst();
      await retryReached;
      h.db.run("UPDATE operations SET attempts=1,send_started_at_ms=? WHERE id='batch-create'", h.m.clock.nowMs());
      const earlier = await removeScrobble(h.m, request);
      expect(earlier).toMatchObject([{ kind: 'delete_chained' }]);
      const deleteId = (earlier[0] as { deleteId: string }).deleteId;
      if (mode === 'unknown')
        h.db.run(
          "UPDATE operations SET attempts=1,removal_send_state='pending',removal_send_at_ms=?,last_error='removal_send_uncertain' WHERE id=?",
          h.m.clock.nowMs(),
          deleteId,
        );
      if (mode === 'completed') h.db.run("UPDATE operations SET state='succeeded' WHERE id=?", deleteId);
      releaseRetry();
      const result = await outstanding;
      const deletes = h.db.all("SELECT id,state,removal_superseded_by FROM operations WHERE kind='scrobble.delete'");
      expect(deletes).toHaveLength(1);
      if (mode === 'completed') expect(result).toEqual([]);
      else expect(result).toMatchObject([{ kind: 'delete_pending' }]);
    } finally {
      releaseFirst();
      releaseRetry();
      spy.mockRestore();
    }
  }),
);
