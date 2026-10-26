// GET /api/v1/feed over the shared read-model fixture, seeded through
// verify → apply (W3-01; M4.3.1 global_order, M4.3.2 following_membership and
// scope_security as amended by A8). Expected orders are hardcoded from
// TESTING.md.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { cursorBindings, decodeCursor } from '@atmusic/core/cursor';
import { describe, expect, it } from 'vitest';
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
  readFixture,
  traverse,
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
    expect(f.index.calls).toEqual([
      { method: 'feed', args: [{ scope: 'global', limit: 20 }] },
      { method: 'feed', args: [{ scope: 'global', limit: 20 }] },
    ]);

    // A viewer neither filters nor binds the global feed.
    const withViewer = await get(ctx, `/api/v1/feed?scope=global&viewer=${encodeURIComponent(ALICE)}&limit=4`);
    expect(pageRkeys(withViewer)).toEqual(['r09', 'r10', 'r07', 'r01']);
    expect(f.index.calls.at(-1)).toEqual({ method: 'feed', args: [{ scope: 'global', limit: 4 }] });
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
    expect(f.index.calls).toEqual([{ method: 'feed', args: [{ scope: 'following', viewer: ALICE, limit: 20 }] }]);

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
    expect(f.index.calls).toEqual([]);

    // With the viewer the same request succeeds.
    expect(pageRkeys(await get(ctx, `/api/v1/feed?scope=following&viewer=${encodeURIComponent(ALICE)}`))).toEqual([
      'r09',
    ]);
    expect(f.index.calls).toHaveLength(1);
  });
});
