import { trackKey } from '@atmusic/core/music-key';
import { describe, expect, it } from 'vitest';
import { applyRecordTarget } from '../../../src/do/write/apply-record';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { stageLovePage } from '../../../src/sync/pull-staging';
import { tombstoneLove } from '../../../src/sync/tombstones';
import { withHarness } from '../outbox/support';

async function setup(h: Parameters<Parameters<typeof withHarness>[0]>[0]) {
  const did = 'did:plc:lovepull';
  h.seedUser(did);
  h.account(did);
  const linkId = h.link(did, 'listenbrainz');
  h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
  h.db.run(
    "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
    linkId,
  );
  return { did, linkId };
}

describe('linked love staging', () => {
  it('dedupes normalized keys and staged MBIDs, settles unresolved metadata, and persists across restart', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      const args = {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'l2',
        proposedBoundaryMs: 100,
        proposedBoundaryKey: 'tie',
        nowMs: 2,
      };
      expect(
        stageLovePage(h.db, {
          ...args,
          items: [
            {
              itemKey: 'a',
              artist: ' Artist ',
              track: 'Track',
              recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              payload: { artist: 'Artist', track: 'Track' },
            },
            { itemKey: 'b', artist: 'artist', track: 'track', payload: { artist: 'artist', track: 'track' } },
            { itemKey: 'c', artist: null, track: null, payload: { recordingMbid: 'x' } },
          ],
        }),
      ).toEqual(['accepted', 'duplicate', 'unresolved']);
      expect(
        stageLovePage(h.db, {
          ...args,
          proposedCursor: 'l3',
          items: [
            {
              itemKey: 'd',
              artist: 'Else',
              track: 'Song',
              recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              payload: {},
            },
          ],
        }),
      ).toEqual(['duplicate']);
      h.restart();
      expect(h.db.one("SELECT item_key FROM linked_pull_items WHERE link_id=? AND kind='love'", linkId)).toEqual({
        item_key: 'a',
      });
      expect(
        h.db.one(
          'SELECT love_boundary_ms,love_boundary_key,love_cursor FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toEqual({ love_boundary_ms: 100, love_boundary_key: 'tie', love_cursor: 'l3' });
    });
  });

  it('tombstoned MBID variants and pending unlove block stale pull; only explicit local re-love clears', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      const key = `${trackKey('Artist', 'Track')[0]}\u0000${trackKey('Artist', 'Track')[1]}`;
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      const oldUri = `at://${did}/com.example.atmusic.love/old`;
      h.db.run(
        "INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,created_at,indexed_at) VALUES(?,?,'old','cid','Artist','Track',?,?,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z')",
        oldUri,
        did,
        artistKey,
        trackKeyValue,
      );
      tombstoneLove(h.db, {
        did,
        identity: 'mbid:old',
        loveKey: key,
        recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        nowMs: 1,
      });
      const base = {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'p',
        proposedBoundaryMs: 100,
        proposedBoundaryKey: '',
        nowMs: 2,
      };
      expect(
        stageLovePage(h.db, {
          ...base,
          items: [
            {
              itemKey: 'mbid-echo',
              artist: 'Other',
              track: 'Name',
              recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              payload: {},
            },
          ],
        }),
      ).toEqual(['tombstoned']);
      const unlove = await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Track', origin: 'web' });
      expect(unlove.ok).toBe(true);
      expect(
        stageLovePage(h.db, {
          ...base,
          items: [{ itemKey: 'pending-unlove', artist: 'Artist', track: 'Track', payload: {} }],
        }),
      ).toEqual(['tombstoned']);
      await enqueueLove(h.m, { did, input: { artist: 'Artist', track: 'Track' }, origin: 'import' });
      expect(
        stageLovePage(h.db, {
          ...base,
          items: [{ itemKey: 'import-love', artist: 'Artist', track: 'Track', payload: {} }],
        }),
      ).toEqual(['tombstoned']);
      await enqueueLove(h.m, { did, input: { artist: 'Artist', track: 'Track' }, origin: 'web' });
      h.db.run("DELETE FROM operations WHERE did=? AND kind IN ('love.put','love.delete')", did);
      expect(
        stageLovePage(h.db, {
          ...base,
          items: [{ itemKey: 'local-relove', artist: 'Artist', track: 'Track', payload: {} }],
        }),
      ).toEqual(['duplicate']);
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='love'", did)).toEqual({
        n: 0,
      });
      applyRecordTarget(
        h.db,
        {
          did,
          kind: 'love',
          collection: 'com.example.atmusic.love',
          rkey: 'old',
          uri: oldUri,
          rev: '3lbkzzzzzzz22',
          present: null,
        },
        {
          receiptNs: 1_800_000_000_000_000_000n,
          prefix: 'com.example.atmusic',
          nowNs: 1_800_000_000_000_000_000n,
        },
      );
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='love'", did)).toEqual({
        n: 0,
      });
    });
  });

  it('capacity failure rolls back the love page boundary and cursor', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.db.run(
        "INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,payload_json,payload_bytes,staged_at_ms) VALUES(?,1,'full','listen','listenbrainz','remote','{}',?,1)",
        linkId,
        32 * 1024 * 1024,
      );
      expect(() =>
        stageLovePage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: 'overflow',
          proposedBoundaryMs: 900,
          proposedBoundaryKey: 'z',
          nowMs: 2,
          items: [{ itemKey: 'new', artist: 'A', track: 'B', payload: {} }],
        }),
      ).toThrow(/capacity/);
      expect(h.db.one('SELECT page_cursor,love_boundary_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        page_cursor: null,
        love_boundary_ms: null,
      });
    });
  });
});
