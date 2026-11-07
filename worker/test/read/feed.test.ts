// GET /api/v1/feed over the shared read-model fixture, seeded through
// verify → apply (W3-01; M4.3.1 global_order, M4.3.2 following_membership and
// scope_security as amended by A8). Expected orders are hardcoded from
// TESTING.md.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { cursorBindings, decodeCursor } from '@atmusic/core/cursor';
import { fromMs } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import { statsWithCache } from '../../src/do/read/stats';
import {
  ALICE,
  BOB,
  CAROL,
  ctxFor,
  expectError,
  get,
  HARNESS_INDEXING,
  harnessCursorKey,
  NOW_DTO,
  pageRkeys,
  readCalls,
  readFixture,
  SCROBBLE,
  traverse,
  uriOf,
} from './scrobble-read-support';

const GLOBAL = ['r09', 'r10', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06'];

describe('feed', () => {
  it('global feed r09,r10,r07,r01,r02,r03,r04,r05,r06', async () => {
    const f = await readFixture('feed-global');
    const ctx = await ctxFor(f.index);

    for (const path of ['/api/v1/feed', '/api/v1/feed?scope=global']) {
      const r = await get(ctx, path);
      expect(pageRkeys(r)).toEqual(GLOBAL);
      expect(r.body.nextCursor).toBeNull();
      expect(r.body.asOf).toBe(NOW_DTO);
      expect(r.body.indexing).toEqual(HARNESS_INDEXING);
      // Cross-user: Bob's r09, Carol's external r10, then Alice's own records.
      expect(r.body.items.map((i: { did: string }) => i.did)).toEqual([BOB, CAROL, ...Array(7).fill(ALICE)]);
    }
    expect(readCalls(f.index)).toEqual([
      { method: 'feed', args: [{ scope: 'global', limit: 20 }] },
      { method: 'feed', args: [{ scope: 'global', limit: 20 }] },
    ]);

    // A viewer neither filters nor binds the global feed.
    const withViewer = await get(ctx, `/api/v1/feed?scope=global&viewer=${encodeURIComponent(ALICE)}&limit=4`);
    expect(pageRkeys(withViewer)).toEqual(['r09', 'r10', 'r07', 'r01']);
    expect(readCalls(f.index).at(-1)).toEqual({ method: 'feed', args: [{ scope: 'global', limit: 4 }] });
    const token = await decodeCursor(await harnessCursorKey(), withViewer.body.nextCursor, cursorBindings.globalFeed());
    expect(token.binding).toEqual({ query: 'feed', did: null, scope: 'global', viewer: null });

    // Every page size traverses the exact order once.
    for (const limit of [1, 2, 4, 9, 10]) {
      const pages = await traverse(ctx, `/api/v1/feed?limit=${limit}`);
      expect(pages.flat()).toEqual(GLOBAL);
      expect(pages.length).toBe(Math.ceil(GLOBAL.length / limit));
    }

    // The deleted r08 has no row; the stored rows are exactly the feed's.
    const stored = await f.inDb((d) => d.all<{ rkey: string }>('SELECT rkey FROM scrobbles ORDER BY rkey'));
    expect(stored.map((x) => x.rkey)).toEqual([...GLOBAL].sort());
  });

  it('a durable local delete hides a scrobble while queued, running, blocked, or failed, but cancellation restores visibility', async () => {
    const f = await readFixture('feed-local-delete');
    const ctx = await ctxFor(f.index);
    const uri = uriOf(ALICE, 'r01');
    const now = Date.parse('2026-01-15T12:00:00Z');
    const statQuery = { did: ALICE, window: 'all' as const, limit: 100, asOfNs: fromMs(now) };
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 7 },
    });
    await f.inDb((db) => {
      db.tx(() => {
        db.run(
          `INSERT INTO operations
             (id, did, kind, origin, priority, collection, rkey, state, due_at, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'scrobble.delete', 'web', 0, ?, ?, 'queued', ?, ?, ?)`,
          'local-delete-r01',
          ALICE,
          SCROBBLE,
          'r01',
          now,
          now,
          now,
        );
        db.run('UPDATE users SET stats_version = stats_version + 1 WHERE did = ?', ALICE);
      });
    });

    const assertHidden = async () => {
      expect(pageRkeys(await get(ctx, '/api/v1/feed?scope=global'))).not.toContain('r01');
      expect(pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`))).not.toContain('r01');
      expect((await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(404);
    };
    await assertHidden();
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 6 },
    });
    for (const state of ['running', 'blocked', 'failed'] as const) {
      await f.inDb((db) => db.run('UPDATE operations SET state = ? WHERE id = ?', state, 'local-delete-r01'));
      await assertHidden();
    }
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'hit',
      statistics: { totalScrobbles: 6 },
    });

    // A never-sent deletion cancelled by its owner no longer suppresses the row.
    await f.inDb((db) =>
      db.tx(() => {
        db.run("UPDATE operations SET state = 'cancelled' WHERE id = ?", 'local-delete-r01');
        db.run('UPDATE users SET stats_version = stats_version + 1 WHERE did = ?', ALICE);
      }),
    );
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 7 },
    });
    expect(pageRkeys(await get(ctx, '/api/v1/feed?scope=global'))).toEqual(GLOBAL);
    expect(pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`))).toEqual([
      'r07',
      'r01',
      'r02',
      'r03',
      'r04',
      'r05',
      'r06',
    ]);
    expect((await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(200);
  });

  it('a succeeded PDS delete remains hidden by its swap CID until absence proof, without hiding a recreated CID', async () => {
    const f = await readFixture('feed-delete-ack-before-proof');
    const ctx = await ctxFor(f.index);
    const uri = uriOf(ALICE, 'r01');
    const now = Date.parse('2026-01-15T12:00:00Z');
    const statQuery = { did: ALICE, window: 'all' as const, limit: 100, asOfNs: fromMs(now) };
    const original = await f.inDb((db) => db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri = ?', uri));
    if (original === null) throw new Error(`missing verified row ${uri}`);
    expect((await get(ctx, '/api/v1/feed?scope=global')).status).toBe(200);
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 7 },
    });

    // This is the durable state after deleteRecord succeeded and its proof hint was queued.
    await f.inDb((db) =>
      db.tx(() => {
        db.run(
          `INSERT INTO operations
             (id, did, kind, origin, priority, collection, rkey, swap_cid, state, due_at, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'scrobble.delete', 'web', 0, ?, ?, ?, 'succeeded', ?, ?, ?)`,
          'acked-delete-r01',
          ALICE,
          SCROBBLE,
          'r01',
          original.cid,
          now,
          now,
          now,
        );
        db.run('UPDATE users SET stats_version = stats_version + 1 WHERE did = ?', ALICE);
      }),
    );
    expect(pageRkeys(await get(ctx, '/api/v1/feed?scope=global'))).not.toContain('r01');
    expect(pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`))).not.toContain('r01');
    expect((await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(404);
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 6 },
    });
    expect(
      await f.inDb((db) =>
        db.one<{ state: string; cid: string }>('SELECT state, cid FROM record_state WHERE uri = ?', uri),
      ),
    ).toEqual({ state: 'present', cid: original.cid });

    // The fake PDS deletion is followed by the ordinary production verifier/apply path.
    await f.kit.deleteRecord('Alice', SCROBBLE, 'r01', original.cid);
    expect(await f.drain()).toMatchObject([{ uri, outcome: 'absent' }]);
    expect(
      await f.inDb((db) => db.one<{ state: string }>('SELECT state FROM record_state WHERE uri = ?', uri)),
    ).toEqual({
      state: 'absent',
    });
    expect(pageRkeys(await get(ctx, '/api/v1/feed?scope=global'))).not.toContain('r01');
    expect(pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`))).not.toContain('r01');
    expect((await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(404);
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 6 },
    });

    // A legitimate later recreation at the same URI has a new CID and is visible despite
    // the retained successful-delete receipt for the older swap CID.
    const recreated = {
      $type: SCROBBLE,
      artist: 'Björk',
      track: 'Recreated at same rkey',
      album: 'Post',
      listenedAt: '2026-01-15T11:59:00Z',
      createdAt: '2026-01-15T12:00:00Z',
    };
    await f.kit.createRecord('Alice', SCROBBLE, 'r01', recreated);
    const recreatedRemote = await f.kit.repos.Alice.getRecord(SCROBBLE, 'r01');
    expect(recreatedRemote?.cid).not.toBe(original.cid);
    expect(await f.drain()).toMatchObject([{ uri, outcome: 'applied' }]);
    expect(pageRkeys(await get(ctx, '/api/v1/feed?scope=global'))).toContain('r01');
    expect(pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`))).toContain('r01');
    expect((await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(200);
    expect(await f.inDb((db) => statsWithCache(db, statQuery))).toMatchObject({
      cache: 'miss',
      statistics: { totalScrobbles: 7 },
    });
  });

  it('Alice following feed is r09 only and excludes self', async () => {
    const f = await readFixture('feed-following');
    const ctx = await ctxFor(f.index);
    const following = (viewer: string, q = '') =>
      `/api/v1/feed?scope=following&viewer=${encodeURIComponent(viewer)}${q}`;

    const r = await get(ctx, following(ALICE));
    expect(pageRkeys(r)).toEqual(['r09']);
    expect(r.body.items[0].did).toBe(BOB);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.asOf).toBe(NOW_DTO);
    expect(r.body.indexing).toEqual(HARNESS_INDEXING);
    expect(readCalls(f.index)).toEqual([{ method: 'feed', args: [{ scope: 'following', viewer: ALICE, limit: 20 }] }]);

    // The edge is Alice→Bob only; Alice's own seven records and Carol's r10 are not followed.
    const edges = await f.inDb((d) => d.all<{ actor: string; subject: string }>('SELECT actor, subject FROM follows'));
    expect(edges).toEqual([{ actor: ALICE, subject: BOB }]);
    const global = pageRkeys(await get(ctx, '/api/v1/feed'));
    expect(global).toContain('r07');
    expect(global).toContain('r10');

    // Bob and Carol follow nobody; an unknown viewer gets 200 with an empty page.
    for (const viewer of [BOB, CAROL, 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', 'did:web:unknown.example.test']) {
      const empty = await get(ctx, following(viewer));
      expect(pageRkeys(empty)).toEqual([]);
      expect(empty.body.nextCursor).toBeNull();
    }

    // The following cursor binds the viewer.
    await f.kit.createRecord('Alice', f.kit.collections.follow, await followRkey(CAROL), {
      $type: f.kit.collections.follow,
      subject: CAROL,
      createdAt: '2025-01-02T00:00:00Z',
    });
    expect((await f.drain()).map((o) => o.outcome)).toEqual(['applied']);
    const page1 = await get(ctx, following(ALICE, '&limit=1'));
    expect(pageRkeys(page1)).toEqual(['r09']);
    const token = await decodeCursor(
      await harnessCursorKey(),
      page1.body.nextCursor,
      cursorBindings.followingFeed(ALICE),
    );
    expect(token.binding).toEqual({ query: 'feed', did: null, scope: 'following', viewer: ALICE });
    expect((await traverse(ctx, following(ALICE, '&limit=1'))).flat()).toEqual(['r09', 'r10']);
  });

  it('an existing following cursor continues after a verified unfollow between pages', async () => {
    const f = await readFixture('feed-unfollow-between-pages');
    const ctx = await ctxFor(f.index);
    const following = (q = '') => `/api/v1/feed?scope=following&viewer=${encodeURIComponent(ALICE)}${q}`;

    // Add a second followed author so the initial page has a continuation after Bob's newer record.
    await f.kit.createRecord('Alice', f.kit.collections.follow, await followRkey(CAROL), {
      $type: f.kit.collections.follow,
      subject: CAROL,
      createdAt: '2025-01-02T00:00:00Z',
    });
    expect(await f.drain()).toHaveLength(1);
    const first = await get(ctx, following('&limit=1'));
    expect(pageRkeys(first)).toEqual(['r09']);
    const cursor = first.body.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    // Remove the Bob edge from Alice's PDS and apply the verified commit while retaining the old cursor.
    const bobRkey = await followRkey(BOB);
    const bobFollow = f.seed.records.get(`at://${ALICE}/${f.kit.collections.follow}/${bobRkey}`)!;
    await f.kit.deleteRecord('Alice', f.kit.collections.follow, bobRkey, bobFollow.cid);
    expect(await f.drain()).toHaveLength(1);

    const continued = await get(ctx, following(`&limit=1&cursor=${encodeURIComponent(cursor!)}`));
    expect(pageRkeys(continued)).toEqual(['r10']);
    expect(continued.body.nextCursor).toBeNull();
    expect((await traverse(ctx, following('&limit=1'))).flat()).toEqual(['r10']);
  });

  it('missing viewer for following → 422 fields.viewer', async () => {
    const f = await readFixture('feed-viewer');
    const ctx = await ctxFor(f.index);

    expectError(await get(ctx, '/api/v1/feed?scope=following'), 422, 'validation_failed', {
      viewer: 'Required for scope=following.',
    });
    expectError(await get(ctx, '/api/v1/feed?scope=following&limit=5'), 422, 'validation_failed', {
      viewer: 'Required for scope=following.',
    });
    // Invalid (for either scope) and repeated viewers are 422 fields.viewer too.
    for (const q of [
      'scope=following&viewer=alice.test',
      'scope=following&viewer=',
      'viewer=not-a-did',
      `scope=following&viewer=${encodeURIComponent(ALICE)}&viewer=${encodeURIComponent(BOB)}`,
    ]) {
      const r = await get(ctx, `/api/v1/feed?${q}`);
      expect(r.status).toBe(422);
      expect(Object.keys(r.body.error.fields)).toEqual(['viewer']);
      expectError(r, 422, 'validation_failed', r.body.error.fields);
    }
    // Scope is checked first: an unknown scope is 422 fields.scope.
    expectError(await get(ctx, '/api/v1/feed?scope=friends'), 422, 'validation_failed', {
      scope: 'Expected global or following.',
    });
    // No rejected request reached the index.
    expect(readCalls(f.index)).toEqual([]);

    // With the viewer the same request succeeds.
    expect(pageRkeys(await get(ctx, `/api/v1/feed?scope=following&viewer=${encodeURIComponent(ALICE)}`))).toEqual([
      'r09',
    ]);
    expect(readCalls(f.index)).toHaveLength(1);
  });
});
