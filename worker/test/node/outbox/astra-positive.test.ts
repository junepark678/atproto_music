import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Box } from '../../../src/crypto/box';
import type { ModuleDeps } from '../../../src/do/contracts';
import type { Db } from '../../../src/do/db';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from '../../../src/forward/delete-enqueue';
import type { DeleteForwardDeps } from '../../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import type { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { projectionListenKey } from '../../../src/forward/projection';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { hasListenRemovalTombstones, isListenTombstoned, tombstoneListen } from '../../../src/sync/tombstones';
import {
  ALICE,
  authorizedLiveOptions,
  deleteProof,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedSnapshotJob,
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) => authorizedLiveOptions(db, proof, rng);
function seedLink(db: Db) {
  seedUser(db, ALICE);
  const accountDeps: Pick<CredentialDeps, 'db' | 'clock'> = { db, clock: { nowMs: () => NOW_MS } };
  ensureAccount(accountDeps, { did: ALICE, verifiedHandle: null });
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
    VALUES ('replacement-link',?,'listenbrainz','alice',X'00','fixture',?,?)`,
    ALICE,
    NOW_MS,
    NOW_MS,
  );
}
function delivered(db: Db) {
  enqueueForwards(db, {
    did: ALICE,
    items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
    now: NOW_MS,
    random: seededRandom(
      620 +
        db.one<{ generation: number }>("SELECT generation FROM linked_accounts WHERE id='replacement-link'")!
          .generation,
    ),
  });
  db.run("UPDATE forward_outbox SET state='sent'");
}
const deletion = {
  did: ALICE,
  identityKey: identity,
  eventKey: 'same-event',
  listenedAt: second,
  artistKey,
  trackKey: musicTrackKey,
  artist: 'Björk',
  track: 'Jóga',
  sourcePath: 'live',
  now: NOW_MS,
};

const BATCH = `${SCROBBLE}Batch`;
const uri = (key: string, batch = false) => `at://${ALICE}/${batch ? BATCH : SCROBBLE}/${key}`;
const batchRecord = (ids = ['2222222222222'], track = record.track) => {
  const { $type, ...entry } = record;
  return { $type: BATCH, createdAt: record.createdAt, listens: ids.map((id) => ({ ...entry, id, track })) };
};
const opRandom = seededRandom(123);
const moduleOf = (db: Db) =>
  ({
    db,
    config: { prefix: 'com.example.atmusic' },
    clock: { nowMs: () => NOW_MS },
    random: opRandom,
  }) as unknown as ModuleDeps;
const apiSingle = (db: Db, key: string) =>
  enqueueScrobbleDelete(moduleOf(db), { did: ALICE, uri: uri(key), origin: 'web' });
const apiBatch = (db: Db, key: string, ids: string[]) =>
  enqueueBatchListenDelete(moduleOf(db), { did: ALICE, uri: uri(key, true), listenIds: ids, origin: 'web' });
async function drain(db: Db) {
  let now = NOW_MS,
    deletes = 0,
    lookups = 0;
  const clock = { nowMs: () => now };
  const deps: DeleteForwardDeps = {
    db,
    clock,
    random: seededRandom(9),
    box: { openText: () => 'fixture' } as unknown as Box,
    pacing: new UpstreamPacing(clock as Clock),
    client: {
      listWindowPage: async () => {
        lookups++;
        return {
          ok: true,
          rate: { remaining: 100, resetInS: 0 },
          value: [{ listenedAt: second, artist: 'Björk', track: 'Jóga', recordingMsid: 'fixture-msid' }],
        };
      },
      deleteListen: async () => {
        deletes++;
        return { ok: true, accepted: true, rate: { remaining: 100, resetInS: 0 } };
      },
    } as unknown as ListenbrainzClient,
  };
  for (let i = 0; i < 12; i++) {
    await runDeleteSlice(deps);
    now += 1000;
  }
  return { deletes, lookups };
}

import { enqueueHints } from '../../../src/do/ingest/hints';
import { LIVE_EVIDENCE_TTL_MS, readLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  recordPendingRemoval,
} from '../../../src/do/ingest/live-pending-removals';

const rng = seededRandom(888);
const sweep = (db: Db, nowMs = NOW_MS) => db.tx(() => executeAuthorizedRemovals(db, { nowMs, random: rng, limit: 10 }));

it('fresh positive: genuine 10000 duplicate-key batch absence runs one real delete', async () => {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  const ids = Array.from({ length: 10000 }, (_, i) => {
    let n = i,
      s = '';
    do {
      s = alphabet[n % 32] + s;
      n = Math.floor(n / 32);
    } while (n);
    return s.padStart(13, '2');
  });
  const repo = await repoFor('alice');
  const first = await putProof(repo, BATCH, 'b', batchRecord(ids));
  const gone = await deleteProof(repo, BATCH, 'b');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    expect(db.one('SELECT count(*) n FROM scrobbles')).toEqual({ n: 10000 });
    db.tx(() => applyRecordProof(db, gone, OPTS));
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 10000 });
    enqueueHints(db, [
      {
        did: ALICE,
        collection: BATCH,
        rkey: 'b',
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 0 });
    expect((await drain(db)).deletes).toBe(1);
  });
});
it.each([0, 1])('fresh positive: exact expiration boundary cannot execute offset=%s', async (offset) => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'a',
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS + LIVE_EVIDENCE_TTL_MS - 1,
      },
    ]);
    sweep(db, NOW_MS + LIVE_EVIDENCE_TTL_MS + offset);
    expect((await drain(db)).deletes).toBe(0);
    expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({ n: 0 });
  });
});
it('fresh positive: same CID recreation has no tombstone and remains visible', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const again = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
    db.tx(() => applyRecordProof(db, again, live(db, again)));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: SCROBBLE,
        rkey: 'a',
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect(db.one('SELECT count(*) n FROM linked_pull_tombstones')).toEqual({ n: 0 });
    expect(db.one(`SELECT count(*) n FROM ${visibleScrobblesFrom()}`)).toEqual({ n: 1 });
    expect((await drain(db)).deletes).toBe(0);
  });
});
it('fresh positive: newer canonical love at different URI protects against old unlove', async () => {
  const LOVE = 'com.example.atmusic.love';
  const key = '2222222222222';
  const other = '3333333333333';
  const loved = { $type: LOVE, artist: 'Björk', track: 'Jóga', createdAt: '2026-01-15T11:00:00Z' };
  const repo = await repoFor('alice');
  const first = await putProof(repo, LOVE, key, loved);
  const gone = await deleteProof(repo, LOVE, key);
  const again = await putProof(repo, LOVE, other, loved);
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    db.run("UPDATE forward_outbox SET state='sent'");
    db.tx(() => applyRecordProof(db, gone, OPTS));
    db.tx(() => applyRecordProof(db, again, live(db, again)));
    enqueueHints(db, [
      {
        did: ALICE,
        collection: LOVE,
        rkey: key,
        source: 'jetstream',
        hintRev: gone.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW_MS,
      },
    ]);
    sweep(db);
    expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) n FROM linked_pull_tombstones')).toEqual({ n: 0 });
  });
});
