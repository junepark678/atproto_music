import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../src/credentials/accounts';
import { ensureAccount } from '../../src/credentials/accounts';
import type { Box } from '../../src/crypto/box';
import type { ModuleDeps } from '../../src/do/contracts';
import type { Db } from '../../src/do/db';
import { applyRecordProof } from '../../src/do/write/apply-record';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from '../../src/forward/delete-enqueue';
import type { DeleteForwardDeps } from '../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../src/forward/delete-forwarder';
import type { ListenbrainzClient } from '../../src/forward/listenbrainz-client';
import { projectionListenKey } from '../../src/forward/projection';
import { UpstreamPacing } from '../../src/forward/upstream-pacing';
import { enqueueBatchListenDelete } from '../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../src/outbox/delete-ops';
import { enqueueForwards } from '../../src/outbox/forward-enqueue';
import { isListenTombstoned, tombstoneListen } from '../../src/sync/tombstones';
import {
  ALICE,
  deleteProof,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedUser,
} from '../../test/write/support';
import { withMigratedDb } from './support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = { ...OPTS, forwarding: { random: seededRandom(619) } };
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
it.each(['single', 'member', 'full', 'live-single', 'live-batch'])(
  'survivor then final removal sends exactly once: %s',
  async (mode) => {
    const repo = await repoFor('alice');
    const a = await putProof(repo, SCROBBLE, 'a', record);
    const b = await putProof(repo, BATCH, 'b', batchRecord());
    const ga = await deleteProof(repo, SCROBBLE, 'a');
    const gb = await deleteProof(repo, BATCH, 'b');
    await withMigratedDb(async (db) => {
      seedLink(db);
      expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
      expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
      delivered(db);
      if (mode === 'single') apiSingle(db, 'a');
      else if (mode === 'member' || mode === 'full') apiBatch(db, 'b', mode === 'full' ? ['*'] : ['2222222222222']);
      else expect(db.tx(() => applyRecordProof(db, mode === 'live-single' ? ga : gb, live)).outcome).toBe('absent');
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
      if (mode === 'single' || mode === 'live-single') apiBatch(db, 'b', ['*']);
      else apiSingle(db, 'a');
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
      expect(await drain(db)).toMatchObject({ deletes: 1 });
    });
  },
);
it('queued delete is suppressed when survivor appears before dispatch', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, BATCH, 'b', batchRecord());
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    delivered(db);
    apiSingle(db, 'a');
    db.tx(() => applyRecordProof(db, b, OPTS));
    expect(await drain(db)).toEqual({ deletes: 0, lookups: 0 });
  });
});
it('batch replacement removes all duplicate canonical members', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, BATCH, 'a', batchRecord(['2222222222222', '3333333333333']));
  const b = await putProof(repo, BATCH, 'a', batchRecord(['2222222222222'], 'Other'));
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    delivered(db);
    expect(db.tx(() => applyRecordProof(db, b, live)).outcome).toBe('applied');
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('new replacement identity remains a survivor despite old-identity tombstone with same CID', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', { ...record, track: 'Old' });
  const b = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    db.tx(() => applyRecordProof(db, b, live));
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
  });
});
it('replacing the last active copy after an outstanding API removal enqueues its delete', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, SCROBBLE, 'b', { ...record, album: 'Different CID' });
  const c = await putProof(repo, SCROBBLE, 'b', { ...record, track: 'Other' });
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    db.tx(() => applyRecordProof(db, b, OPTS));
    delivered(db);
    apiSingle(db, 'a');
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
    db.tx(() => applyRecordProof(db, c, live));
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('same-byte recreation at same URI is a current survivor', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const again = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    delivered(db);
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(db.tx(() => applyRecordProof(db, again, OPTS)).outcome).toBe('applied');
    const history = db.all<{ identity_key: string }>('SELECT identity_key FROM linked_pull_tombstones');
    expect(history).toHaveLength(1);
    expect(history[0]!.identity_key).toMatch(/^history:live:/);
    expect(isListenTombstoned(db, ALICE, second, artistKey, musicTrackKey)).toBe(true);
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
    expect(await drain(db)).toEqual({ deletes: 0, lookups: 0 });
  });
});
it('two outstanding removals do not suppress the final deletion', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, SCROBBLE, 'b', { ...record, album: 'Different CID' });
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    db.tx(() => applyRecordProof(db, b, OPTS));
    delivered(db);
    apiSingle(db, 'a');
    apiSingle(db, 'b');
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it.each(['api-full', 'live-full'])(
  'full batch removes duplicate canonical members with exactly one dispatch: %s',
  async (mode) => {
    const repo = await repoFor('alice');
    const a = await putProof(repo, BATCH, 'a', batchRecord(['2222222222222', '3333333333333']));
    const gone = await deleteProof(repo, BATCH, 'a');
    await withMigratedDb(async (db) => {
      seedLink(db);
      expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
      delivered(db);
      if (mode === 'api-full') apiBatch(db, 'a', ['*']);
      else expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
      expect(await drain(db)).toMatchObject({ deletes: 1 });
    });
  },
);
it('member removal preserves a sibling canonical copy within the same batch', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, BATCH, 'a', batchRecord(['2222222222222', '3333333333333']));
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    delivered(db);
    apiBatch(db, 'a', ['2222222222222']);
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
    apiBatch(db, 'a', ['3333333333333']);
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('helper scopes did, canonical tuple, whole nanosecond storage second and exact excluded URI', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', { ...record, listenedAt: '2026-01-15T11:00:00.123456789Z' });
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
    for (const override of [
      { did: 'did:plc:other' },
      { artistKey: 'other' },
      { trackKey: 'other' },
      { listenedAt: second - 1 },
      { listenedAt: second + 1 },
      { excluding: new Set([uri('a')]) },
    ])
      expect(hasCanonicalListenSurvivor(db, { ...deletion, ...override })).toBe(false);
    expect(hasCanonicalListenSurvivor(db, { ...deletion, excluding: new Set([`${uri('a')}other`]) })).toBe(true);
  });
});
it.each(['uri', 'live', 'single-replaced', 'batch-replaced'])(
  'historical %s tombstone with a different CID does not hide a current row',
  async (kind) => {
    const repo = await repoFor('alice');
    const a = await putProof(repo, SCROBBLE, 'a', record);
    await withMigratedDb((db) => {
      seedLink(db);
      db.tx(() => applyRecordProof(db, a, OPTS));
      tombstoneListen(db, {
        did: ALICE,
        identity: `${kind}:${uri('a')}:old-cid`,
        second,
        artistKey,
        trackKey: musicTrackKey,
        nowMs: NOW_MS,
      });
      expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
    });
  },
);
it('SQL wildcard in historical identity is literal', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb((db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    const cid = db.one<{ cid: string }>('SELECT cid FROM scrobbles')!.cid;
    tombstoneListen(db, {
      did: ALICE,
      identity: `uri:at://${ALICE}/${SCROBBLE}/%:${cid}`,
      second,
      artistKey,
      trackKey: musicTrackKey,
      nowMs: NOW_MS,
    });
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
  });
});
it('old-identity replacement tombstone must not allow deleting another copy while the replacement survives', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', { ...record, track: 'Old' });
  const b = await putProof(repo, SCROBBLE, 'a', record);
  const c = await putProof(repo, SCROBBLE, 'c', { ...record, album: 'C' });
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    db.tx(() => applyRecordProof(db, b, live));
    db.tx(() => applyRecordProof(db, c, OPTS));
    delivered(db);
    apiSingle(db, 'c');
    expect(await drain(db)).toEqual({ deletes: 0, lookups: 0 });
  });
});
it('multiple outstanding canonical deletes dispatch only once after the final copy is removed', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, SCROBBLE, 'a', { ...record, album: 'New bytes' });
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, a, OPTS));
    delivered(db);
    apiSingle(db, 'a');
    expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
    apiSingle(db, 'a');
    expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(2);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('a later re-forward can enqueue a fresh canonical delete after prior events settle', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    delivered(db);
    expect(enqueueListenDelete(db, { ...deletion, eventKey: 'first-incarnation' })).toBe(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
    // A new delivery has new removal provenance; settled siblings must not
    // permanently reserve the canonical listen key.
    expect(enqueueListenDelete(db, { ...deletion, eventKey: 'later-incarnation' })).toBe(1);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
