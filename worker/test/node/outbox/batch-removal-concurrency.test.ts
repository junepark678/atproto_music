import { listenKey } from '@atmusic/core/listen-key';
import { newTid } from '@atmusic/core/record-key';
import { scrobbleBatchCollection } from '@atmusic/core/scrobble-batch';
import { toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it, vi } from 'vitest';
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

describe('concurrent batch member removals', () => {
  it.each([false, true])(
    're-resolves the surviving target after a sibling rewrite (explicit import=%s)',
    async (explicit) =>
      withHarness(async (h) => {
        const { did, listens } = await seedBatch(h, explicit);
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        let releaseTarget: (() => void) | undefined;
        let reachedTarget: (() => void) | undefined;
        const targetReached = new Promise<void>((resolve) => (reachedTarget = resolve));
        const release = new Promise<void>((resolve) => (releaseTarget = resolve));
        const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
          const encoded = new TextDecoder().decode(data as ArrayBuffer);
          if (encoded.includes('Track 0') && !encoded.includes('Track 1')) {
            reachedTarget?.();
            await release;
          }
          return originalDigest(algorithm, data);
        });
        try {
          const secondRemoval = removeScrobble(h.m, { did, artist: 'Artist', track: 'Track 1', timestamp: 101 });
          await targetReached;
          const firstRemoval = await removeScrobble(h.m, { did, artist: 'Artist', track: 'Track 0', timestamp: 100 });
          expect(firstRemoval).toEqual([{ kind: 'rewritten', operationId: 'batch-create' }]);
          releaseTarget?.();
          const retriedRemoval = await secondRemoval;
          expect(retriedRemoval).toEqual([{ kind: 'cancelled', operationId: 'batch-create' }]);
          expect(
            h.db.one<{ state: string; record_json: string }>(
              "SELECT state,record_json FROM operations WHERE id='batch-create'",
            ),
          ).toMatchObject({ state: 'cancelled' });
          expect(h.db.all("SELECT dedupe_key FROM listen_keys WHERE operation_id='batch-create'")).toEqual([]);
          expect(h.db.all("SELECT id FROM operations WHERE did=? AND kind='scrobble.delete'", did)).toEqual([]);
          expect(listens).toHaveLength(2);
        } finally {
          releaseTarget?.();
          digest.mockRestore();
        }
      }),
  );
});
