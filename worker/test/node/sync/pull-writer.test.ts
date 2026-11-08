import { describe, expect, it } from 'vitest';
import type { LinkedAccountRow } from '../../../src/app/rows';
import { linkDto } from '../../../src/forward/links';
import { enqueueUnlove } from '../../../src/outbox/love-ops';
import { stageLovePage, stagePullPage } from '../../../src/sync/pull-staging';
import { writePullSlice } from '../../../src/sync/pull-writer';
import { tombstoneListen } from '../../../src/sync/tombstones';
import { withHarness } from '../outbox/support';

async function setup(h: Parameters<Parameters<typeof withHarness>[0]>[0]) {
  const did = 'did:plc:pullwriter';
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

describe('linked pull staged writer', () => {
  it('holds staged pages on absent session and resumes once when the real writer becomes available', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const unavailable = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => ({ available: false, reason: 'session_missing' }),
      });
      expect(unavailable.held).toBe('session_missing');
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1 });
      expect(h.db.one('SELECT hold_reason FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        hold_reason: 'session_missing',
      });
      const linked = h.db.one<LinkedAccountRow>('SELECT * FROM linked_accounts WHERE id=?', linkId)!;
      expect(linkDto(linked, h.db).sync).toMatchObject({ holdReason: 'session_missing', needsReauth: true });
      h.restart();
      const available = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => ({ available: true }),
      });
      expect(available.accepted).toBe(1);
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
      expect(h.db.one("SELECT origin,state FROM operations WHERE did=? AND kind='scrobble.create'", did)).toMatchObject(
        { origin: 'import' },
      );
      const again = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(again.accepted).toBe(0);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 1,
      });
    });
  });

  it('rechecks account generation and dedupe in the acceptance transaction, and accepts a linked love through import operations', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 10,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [{ itemKey: 'love', artist: 'Artist', track: 'Track', payload: { artist: 'Artist', track: 'Track' } }],
      });
      const originalRestore = async () => {
        h.db.run("UPDATE linked_accounts SET generation=2,remote_user='new-account' WHERE id=?", linkId);
        return { available: true as const };
      };
      await writePullSlice(h.m, { linkId, generation: 1, available: originalRestore });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1 });
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({ n: 0 });
      h.db.run("UPDATE linked_accounts SET generation=1,remote_user='remote' WHERE id=?", linkId);
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.accepted).toBe(1);
      expect(h.db.one("SELECT origin FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({
        origin: 'import',
      });
    });
  });

  it('does not create an operation when a tombstone appears during async session restoration', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => {
          tombstoneListen(h.db, { did, identity: 'withdrawn', second: 100, artistKey: null, trackKey: null, nowMs: 3 });
          return { available: true };
        },
      });
      expect(result.tombstoned).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 0,
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('settles a listen as duplicate when another writer accepts its second during async preparation', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      const result = await writePullSlice(h.m, {
        linkId,
        generation: 1,
        available: async () => {
          h.db.run(
            "INSERT INTO listen_keys(did,dedupe_key,source,created_at_ms,listen_second) VALUES(?,'racing','web',3,100)",
            did,
          );
          return { available: true };
        },
      });
      expect(result.duplicate).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='scrobble.create'", did)).toEqual({
        n: 0,
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
    });
  });

  it('routes imported linked listens through the scrobbleBatch collection when batch publication is enabled', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      h.m.config.batchPublication = true;
      stagePullPage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedWatermarkMs: 100000,
        nowMs: 2,
        items: [
          {
            itemKey: 'listen',
            listenedAtMs: 100000,
            payload: { artist: 'Artist', track: 'Track', listenedAt: '1970-01-01T00:01:40Z' },
          },
        ],
      });
      await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      const operation = h.db.one<{ collection: string; record_json: string }>(
        "SELECT collection,record_json FROM operations WHERE did=? AND kind='scrobble.create'",
        did,
      )!;
      expect(operation.collection).toBe(`${h.m.config.prefix}.scrobbleBatch`);
      expect(JSON.parse(operation.record_json)).toMatchObject({ listens: [{ artist: 'Artist', track: 'Track' }] });
    });
  });

  it('settles a staged love when a local unlove wins before operation acceptance', async () => {
    await withHarness(async (h) => {
      const { did, linkId } = await setup(h);
      stageLovePage(h.db, {
        linkId,
        generation: 1,
        sourceService: 'listenbrainz',
        sourceAccount: 'remote',
        did,
        proposedCursor: null,
        proposedBoundaryMs: 10,
        proposedBoundaryKey: null,
        nowMs: 2,
        items: [{ itemKey: 'love', artist: 'Artist', track: 'Track', payload: { artist: 'Artist', track: 'Track' } }],
      });
      await enqueueUnlove(h.m, { did, artist: 'Artist', track: 'Track', origin: 'web' });
      const result = await writePullSlice(h.m, { linkId, generation: 1, available: async () => ({ available: true }) });
      expect(result.tombstoned).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.put'", did)).toEqual({ n: 0 });
      expect(h.db.one("SELECT count(*) AS n FROM operations WHERE did=? AND kind='love.delete'", did)).toEqual({
        n: 1,
      });
    });
  });
});
