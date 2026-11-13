import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from '../../../src/forward/delete-enqueue';
import { projectionListenKey } from '../../../src/forward/projection';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { tombstoneListen } from '../../../src/sync/tombstones';
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
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) =>
  authorizedLiveOptions(db, proof, seededRandom(619));
function seedLink(db: Db) {
  seedUser(db, ALICE);
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

describe('S4 generation and single replacement', () => {
  it('does not let an old replacement tombstone hide a recreated same-URI survivor', async () => {
    const repo = await repoFor('alice');
    const original = await putProof(repo, SCROBBLE, 'recreated', record);
    const recreated = await putProof(repo, SCROBBLE, 'recreated', { ...record, album: 'Recreated album' });
    const uri = `at://${ALICE}/${SCROBBLE}/recreated`;
    await withMigratedDb((db) => {
      seedLink(db);
      db.tx(() => applyRecordProof(db, original, OPTS));
      const oldCid = db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri=?', uri)!.cid;
      tombstoneListen(db, {
        did: ALICE,
        identity: `batch-replaced:${uri}:${oldCid}`,
        second,
        artistKey,
        trackKey: musicTrackKey,
        nowMs: NOW_MS,
      });
      db.tx(() => applyRecordProof(db, recreated, OPTS));
      expect(db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri=?', uri)!.cid).not.toBe(oldCid);
      expect(
        hasCanonicalListenSurvivor(db, { did: ALICE, listenedAt: second, artistKey, trackKey: musicTrackKey }),
      ).toBe(true);
    });
  });

  it('retains independent deletion evidence for a replacement destination generation', async () => {
    await withMigratedDb((db) => {
      seedLink(db);
      delivered(db);
      expect(enqueueListenDelete(db, deletion)).toBe(1);
      expect(enqueueListenDelete(db, deletion)).toBe(0);
      db.run("UPDATE linked_accounts SET generation=2 WHERE id='replacement-link'");
      expect(enqueueListenDelete(db, deletion)).toBe(0);
      delivered(db);
      expect(enqueueListenDelete(db, deletion)).toBe(1);
      expect(enqueueListenDelete(db, deletion)).toBe(0);
      expect(db.all('SELECT generation FROM listenbrainz_deletes ORDER BY generation')).toEqual([
        { generation: 1 },
        { generation: 2 },
      ]);
    });
  });

  it.each(['track', 'listenedAt'] as const)(
    'captures the removed %s identity before a live single replacement',
    async (field) => {
      const repo = await repoFor('alice');
      const original = await putProof(repo, SCROBBLE, 'replace', record);
      const replacement = await putProof(repo, SCROBBLE, 'replace', {
        ...record,
        [field]: field === 'track' ? 'Hyperballad' : '2026-01-15T11:01:00Z',
      });
      await withMigratedDb((db) => {
        seedLink(db);
        db.tx(() => applyRecordProof(db, original, OPTS));
        delivered(db);
        expect(db.tx(() => applyRecordProof(db, replacement, live(db, replacement))).outcome).toBe('applied');
        expect(db.all('SELECT identity_key,listened_at,artist,track FROM listenbrainz_deletes')).toEqual([
          { identity_key: identity, listened_at: second, artist: 'Björk', track: 'Jóga' },
        ]);
        expect(db.all('SELECT listen_second FROM linked_pull_tombstones')).toEqual([{ listen_second: second }]);
        db.tx(() => applyRecordProof(db, replacement, live(db, replacement)));
        expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(1);
      });
    },
  );

  it.each(['snapshot', 'retained', 'metadata'] as const)('does not delete upstream for %s updates', async (mode) => {
    const repo = await repoFor('alice');
    const original = await putProof(repo, SCROBBLE, 'replace', record);
    const copy = await putProof(repo, SCROBBLE, 'copy', record);
    const replacement = await putProof(repo, SCROBBLE, 'replace', {
      ...record,
      ...(mode === 'metadata' ? { album: 'Homogenic' } : { track: 'Hyperballad' }),
    });
    await withMigratedDb((db) => {
      seedLink(db);
      db.tx(() => applyRecordProof(db, original, OPTS));
      if (mode === 'retained') db.tx(() => applyRecordProof(db, copy, OPTS));
      delivered(db);
      db.tx(() => applyRecordProof(db, replacement, mode === 'snapshot' ? OPTS : live(db, replacement)));
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
      expect(db.all('SELECT identity_key FROM linked_pull_tombstones')).toHaveLength(0);
    });
  });

  it('does not enqueue deletion of one single record while an equal canonical batch member survives', async () => {
    const repo = await repoFor('alice');
    const single = await putProof(repo, SCROBBLE, 'same-single', record);
    const { $type, ...entry } = record;
    const batch = await putProof(repo, `${SCROBBLE}Batch`, 'same-batch', {
      $type: `${SCROBBLE}Batch`,
      createdAt: record.createdAt,
      listens: [{ ...entry, id: '2222222222222' }],
    });
    const gone = await deleteProof(repo, SCROBBLE, 'same-single');
    await withMigratedDb((db) => {
      seedLink(db);
      db.tx(() => applyRecordProof(db, single, OPTS));
      db.tx(() => applyRecordProof(db, batch, OPTS));
      delivered(db);
      db.tx(() => applyRecordProof(db, gone, live(db, gone)));
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
    });
  });
});

describe('S4 canonical batch replacement', () => {
  it.each(['changed-canonical', 'retained-copy', 'renamed-id'] as const)('%s', async (mode) => {
    const repo = await repoFor('alice');
    const BATCH = `${SCROBBLE}Batch`;
    const { $type, ...entry } = record;
    const batch = { $type: BATCH, createdAt: record.createdAt, listens: [{ ...entry, id: '2222222222222' }] };
    const original = await putProof(repo, BATCH, 'batchreplace', batch);
    const copy = await putProof(repo, SCROBBLE, 'copy', record);
    const replacement = await putProof(repo, BATCH, 'batchreplace', {
      ...batch,
      listens: [
        {
          ...entry,
          id: mode === 'changed-canonical' ? '2222222222222' : '3333333333333',
          track: mode === 'renamed-id' ? record.track : 'Hyperballad',
        },
      ],
    });
    await withMigratedDb((db) => {
      seedLink(db);
      expect(db.tx(() => applyRecordProof(db, original, OPTS)).outcome).toBe('applied');
      if (mode === 'retained-copy') db.tx(() => applyRecordProof(db, copy, OPTS));
      delivered(db);
      expect(db.tx(() => applyRecordProof(db, replacement, live(db, replacement))).outcome).toBe('applied');
      const expected = mode === 'changed-canonical' ? 1 : 0;
      expect(db.all('SELECT identity_key FROM listenbrainz_deletes')).toHaveLength(expected);
      expect(db.all('SELECT identity_key FROM linked_pull_tombstones')).toHaveLength(expected);
    });
  });
});
