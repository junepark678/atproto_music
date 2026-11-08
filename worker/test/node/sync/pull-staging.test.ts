import { describe, expect, it } from 'vitest';
import { hasListenAtSecond, stagePullPage } from '../../../src/sync/pull-staging';
import { withHarness } from '../outbox/support';

describe('linked pull staging', () => {
  it('stages atomically, dedupes by second across retained keys and prior staging, and rejects stale generations', async () => {
    await withHarness(async (h) => {
      const did = 'did:plc:pulltest';
      h.seedUser(did);
      const linkId = h.link(did, 'listenbrainz');
      h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
      h.db.run(
        "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
        linkId,
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,source,created_at_ms,listen_second) VALUES(?,'known','web',1,100)",
        did,
      );
      const args = {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'next',
        proposedWatermarkMs: 120000,
        nowMs: 2,
      };
      expect(
        stagePullPage(h.db, {
          ...args,
          items: [
            { itemKey: 'a', listenedAtMs: 100001, payload: { artist: 'corrected', track: 'name' } },
            { itemKey: 'b', listenedAtMs: 101001, payload: { artist: 'new', track: 'track' } },
          ],
        }),
      ).toEqual(['duplicate', 'accepted']);
      expect(
        stagePullPage(h.db, {
          ...args,
          items: [{ itemKey: 'c', listenedAtMs: 101999, payload: { artist: 'changed', track: 'again' } }],
        }),
      ).toEqual(['duplicate']);
      expect(hasListenAtSecond(h.db, { did, second: 101, linkId, generation: 1 })).toBe(true);
      expect(() =>
        stagePullPage(h.db, { ...args, generation: 2, proposedCursor: 'bad', proposedWatermarkMs: 999, items: [] }),
      ).toThrow(/stale/);
      expect(h.db.one('SELECT page_cursor,listen_watermark_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual(
        { page_cursor: 'next', listen_watermark_ms: 120000 },
      );
      h.restart();
      expect(h.db.one('SELECT item_key FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ item_key: 'b' });
      h.db.run("UPDATE linked_accounts SET remote_user='changed' WHERE id=?", linkId);
      expect(() =>
        stagePullPage(h.db, {
          ...args,
          proposedCursor: 'wrong-source',
          proposedWatermarkMs: 200000,
          items: [{ itemKey: 'd', listenedAtMs: 102000, payload: {} }],
        }),
      ).toThrow(/stale/);
      expect(h.db.one('SELECT page_cursor,listen_watermark_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual(
        { page_cursor: 'next', listen_watermark_ms: 120000 },
      );
      h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
      h.db.run(
        "INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,payload_json,payload_bytes,staged_at_ms) VALUES(?,1,'near-cap','listen','listenbrainz','remote','{}',?,3)",
        linkId,
        32 * 1024 * 1024,
      );
      expect(() =>
        stagePullPage(h.db, {
          ...args,
          proposedCursor: 'cap',
          proposedWatermarkMs: 300000,
          items: [{ itemKey: 'cap-trigger', listenedAtMs: 102000, payload: {} }],
        }),
      ).toThrow(/capacity/);
      expect(h.db.one('SELECT page_cursor,listen_watermark_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual(
        { page_cursor: 'next', listen_watermark_ms: 120000 },
      );
    });
  });
});
