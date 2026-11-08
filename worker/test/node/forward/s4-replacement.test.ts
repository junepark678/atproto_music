import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueListenDelete } from '../../../src/forward/delete-enqueue';
import { projectionListenKey } from '../../../src/forward/projection';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { ALICE, NOW_MS, OPTS, putProof, repoFor, SCROBBLE, scrobble, seedUser } from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = { ...OPTS, forwarding: { random: seededRandom(619) } };
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
        expect(db.tx(() => applyRecordProof(db, replacement, live)).outcome).toBe('applied');
        expect(db.all('SELECT identity_key,listened_at,artist,track FROM listenbrainz_deletes')).toEqual([
          { identity_key: identity, listened_at: second, artist: 'Björk', track: 'Jóga' },
        ]);
        expect(db.all('SELECT listen_second FROM linked_pull_tombstones')).toEqual([{ listen_second: second }]);
        db.tx(() => applyRecordProof(db, replacement, live));
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
      db.tx(() => applyRecordProof(db, replacement, mode === 'snapshot' ? OPTS : live));
      expect(db.all('SELECT id FROM listenbrainz_deletes')).toHaveLength(0);
      expect(db.all('SELECT identity_key FROM linked_pull_tombstones')).toHaveLength(0);
    });
  });
});
