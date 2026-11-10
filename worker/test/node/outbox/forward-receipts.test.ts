import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { forwardCoverage } from '../../../src/outbox/forward-receipts';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { deleteQueuedForwardIdentity } from '../../../src/outbox/forward-key';
import { withMigratedDb } from '../support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const LINK = { id: 'link-receipt-test', generation: 1 };
const ITEM = { kind: 'scrobble' as const, listenKey: 'listen-1', payload: { listen: { artist: 'Artist', track: 'Track' } } };

async function withLink(run: Parameters<typeof withMigratedDb>[0]) {
  await withMigratedDb((db) => {
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES(?,?,'lastfm','remote',X'00','key',1,1)`,
      LINK.id,
      DID,
    );
    run(db);
  });
}

describe('forward enqueue coverage receipts', () => {
  it('records a legacy outbox identity lazily and releases it before explicit unsent withdrawal', async () => {
    await withLink((db) => {
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 10, random: seededRandom(7) })).toBe(1);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
      expect(db.one('SELECT generation,kind,dedupe_key FROM forward_receipts')).toEqual({
        generation: 1,
        kind: 'scrobble',
        dedupe_key: ITEM.listenKey,
      });

      deleteQueuedForwardIdentity(db, DID, ['scrobble'], ITEM.listenKey);
      expect(db.one('SELECT 1 FROM forward_outbox')).toBeNull();
      expect(db.one('SELECT 1 FROM forward_receipts')).toBeNull();
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 11, random: seededRandom(8) })).toBe(1);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
    });
  });

  it('keeps cleanup-retired coverage and lazily releases a rollback-era stale receipt', async () => {
    await withLink((db) => {
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 20, random: seededRandom(9) })).toBe(1);
      db.run("UPDATE forward_outbox SET state='sent' WHERE link_id=?", LINK.id);
      db.run('UPDATE forward_receipts SET retired_at_ms=21 WHERE link_id=?', LINK.id);
      db.run('DELETE FROM forward_outbox WHERE link_id=?', LINK.id);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('retired');
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 22, random: seededRandom(10) })).toBe(0);
      expect(db.one('SELECT retired_at_ms FROM forward_receipts WHERE link_id=?', LINK.id)).toEqual({ retired_at_ms: 21 });

      db.run('DELETE FROM forward_receipts WHERE link_id=?', LINK.id);
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 23, random: seededRandom(11) })).toBe(1);
      db.run('DELETE FROM forward_outbox WHERE link_id=?', LINK.id);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('stale');
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 24, random: seededRandom(12) })).toBe(1);
      expect(db.one("SELECT value FROM counters WHERE name='link_coverage' AND label='receipt_stale_released'")).toEqual({
        value: 1,
      });
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
    });
  });
});
