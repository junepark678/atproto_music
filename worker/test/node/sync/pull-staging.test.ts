import { trackKey } from '@atmusic/core/music-key';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import { applyRecordTarget } from '../../../src/do/write/apply-record';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { insertOperation, newOperationId, outboxCollections, prepare } from '../../../src/outbox/operations';
import { hasListenAtSecond, stageLovePage, stagePullPage } from '../../../src/sync/pull-staging';
import { isLoveTombstoned } from '../../../src/sync/tombstones';
import { SCROBBLE, withHarness } from '../outbox/support';

describe('linked pull staging', () => {
  it('covers legacy pending single and batch operation seconds, then rolls back progress when legacy coverage is unreadable', async () => {
    await withHarness(async (h) => {
      const did = 'did:plc:legacyseconds';
      h.seedUser(did);
      h.account(did);
      const linkId = h.link(did, 'listenbrainz');
      h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
      h.db.run(
        "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
        linkId,
      );
      const prefix = h.m.config.prefix!;
      const singleId = newOperationId(h.m.random);
      const single = await prepare({
        $type: `${prefix}.scrobble`,
        artist: 'Legacy',
        track: 'single',
        listenedAt: '1970-01-01T00:01:40Z',
        createdAt: new Date(2).toISOString(),
      });
      insertOperation(
        h.db,
        {
          id: singleId,
          did,
          kind: 'scrobble.create',
          origin: 'web',
          collection: outboxCollections(prefix).scrobble,
          rkey: '3klegacysingle01',
          prepared: single,
          dueAt: 2,
        },
        2,
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,'legacy-single',?,'web',2,NULL)",
        did,
        singleId,
      );
      const batchId = newOperationId(h.m.random);
      const batch = await prepare({
        $type: `${prefix}.scrobbleBatch`,
        createdAt: new Date(2).toISOString(),
        listens: [{ id: '3klegacyentry001', artist: 'Legacy', track: 'batch', listenedAt: '1970-01-01T00:03:20Z' }],
      });
      insertOperation(
        h.db,
        {
          id: batchId,
          did,
          kind: 'scrobble.create',
          origin: 'import',
          collection: outboxCollections(prefix).scrobbleBatch,
          rkey: '3klegacybatch001',
          prepared: batch,
          dueAt: 2,
        },
        2,
      );
      h.db.run(
        "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,'legacy-batch',?,'import',2,NULL)",
        did,
        batchId,
      );
      const args = {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: 'legacy-page',
        proposedWatermarkMs: 400000,
        nowMs: 3,
      };
      expect(
        stagePullPage(h.db, {
          ...args,
          items: [
            { itemKey: 'single-echo', listenedAtMs: 100000, payload: { artist: 'Different', track: 'name' } },
            { itemKey: 'batch-echo', listenedAtMs: 200000, payload: { artist: 'Different', track: 'name' } },
          ],
        }),
      ).toEqual(['duplicate', 'duplicate']);
      h.db.run("UPDATE operations SET record_json='not-json' WHERE id=?", singleId);
      expect(() =>
        stagePullPage(h.db, {
          ...args,
          proposedCursor: 'must-not-advance',
          proposedWatermarkMs: 500000,
          items: [{ itemKey: 'uncertain-coverage', listenedAtMs: 300000, payload: {} }],
        }),
      ).toThrow(/coverage incomplete/);
      expect(h.db.one('SELECT page_cursor,listen_watermark_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual(
        {
          page_cursor: 'legacy-page',
          listen_watermark_ms: 400000,
        },
      );
    });
  });

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
      expect(hasListenAtSecond(h.db, { did, second: 101, linkId, generation: 1 })).toEqual({
        complete: true,
        matches: true,
      });
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

  it('API scrobble deletion durably tombstones its indexed second before pull staging', async () => {
    await withHarness(async (h) => {
      const did = 'did:plc:tombstone';
      h.seedUser(did);
      h.account(did);
      const uri = `at://${did}/${SCROBBLE}/record`;
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      const at = toStorage(100n * NS_PER_SECOND);
      h.db.run(
        `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
        VALUES(?,? ,?,'record','rev','Artist','Track',?,?,?, ?,?)`,
        uri,
        'cid',
        did,
        at,
        at,
        at,
        artistKey,
        trackKeyValue,
      );
      enqueueScrobbleDelete(h.m, { did, uri, origin: 'web' });
      const linkId = h.link(did, 'listenbrainz');
      h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
      h.db.run(
        "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
        linkId,
      );
      expect(
        stagePullPage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: 'next',
          proposedWatermarkMs: 100001,
          nowMs: 2,
          items: [
            {
              itemKey: 'echo',
              listenedAtMs: 100000,
              artistKey,
              trackKey: trackKeyValue,
              payload: { artist: 'Artist', track: 'Track' },
            },
          ],
        }),
      ).toEqual(['tombstoned']);
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='listen'", did)).toEqual({
        n: 1,
      });
    });
  });

  it('an explicit re-love clears the local unlove tombstone while imported loves cannot clear it', async () => {
    await withHarness(async (h) => {
      const did = 'did:plc:lovefence';
      h.seedUser(did);
      h.account(did);
      await enqueueLove(h.m, {
        did,
        input: { artist: 'Artist', track: 'Track', recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        origin: 'web',
      });
      const result = await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Track', origin: 'web' });
      expect(result.ok).toBe(true);
      const tombstone = h.db.one<{ love_key: string }>(
        "SELECT love_key FROM linked_pull_tombstones WHERE did=? AND kind='love'",
        did,
      );
      expect(tombstone).not.toBeNull();
      expect(isLoveTombstoned(h.db, did, tombstone!.love_key, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
      expect(isLoveTombstoned(h.db, did, 'a-different-normalized-key', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(
        true,
      );
      const linkId = h.link(did, 'listenbrainz');
      h.db.run("UPDATE linked_accounts SET remote_user='remote' WHERE id=?", linkId);
      h.db.run(
        "INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,updated_at_ms) VALUES(?,1,'listenbrainz','remote',0,1)",
        linkId,
      );
      h.db.run("DELETE FROM operations WHERE did=? AND kind IN ('love.put','love.delete')", did);
      h.restart();
      expect(
        stageLovePage(h.db, {
          linkId,
          generation: 1,
          sourceService: 'listenbrainz',
          sourceAccount: 'remote',
          did,
          proposedCursor: null,
          proposedBoundaryMs: 10,
          proposedBoundaryKey: null,
          nowMs: 3,
          items: [
            {
              itemKey: 'mbid-alias',
              artist: 'Corrected Artist',
              track: 'Corrected Track',
              recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              payload: { artist: 'Corrected Artist', track: 'Corrected Track' },
            },
          ],
        }),
      ).toEqual(['tombstoned']);
      await enqueueLove(h.m, { did, input: { artist: 'Artist', track: 'Track' }, origin: 'import' });
      expect(isLoveTombstoned(h.db, did, tombstone!.love_key, null)).toBe(true);
      await enqueueLove(h.m, { did, input: { artist: 'Artist', track: 'Track' }, origin: 'web' });
      expect(isLoveTombstoned(h.db, did, tombstone!.love_key, null)).toBe(false);
    });
  });

  it('a live projection removal tombstones before deleting, while snapshot absence does not', async () => {
    await withHarness(async (h) => {
      const did = 'did:plc:projection';
      h.seedUser(did);
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      const at = toStorage(200n * NS_PER_SECOND);
      for (const [owner, rkey] of [
        [did, 'live'],
        ['did:plc:snapshot', 'snapshot'],
      ] as const) {
        if (owner !== did) h.seedUser(owner);
        const uri = `at://${owner}/${SCROBBLE}/${rkey}`;
        h.db.run(
          `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
          VALUES(?, 'cid', ?, ?, 'rev','Artist','Track',?,?,?, ?,?)`,
          uri,
          owner,
          rkey,
          at,
          at,
          at,
          artistKey,
          trackKeyValue,
        );
        applyRecordTarget(
          h.db,
          { did: owner, kind: 'scrobble', collection: SCROBBLE, rkey, uri, rev: '3lbkzzzzzzz22', present: null },
          {
            receiptNs: 200n * NS_PER_SECOND,
            prefix: 'com.example.atmusic',
            nowNs: 200n * NS_PER_SECOND,
            ...(owner === did ? { forwarding: { random: h.m.random } } : {}),
          },
        );
      }
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did=? AND kind='listen'", did)).toEqual({
        n: 1,
      });
      expect(
        h.db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE did='did:plc:snapshot' AND kind='listen'"),
      ).toEqual({ n: 0 });
    });
  });
});
