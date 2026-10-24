// Cursor traversal over current state, through HTTP, with mutations applied
// between pages through verify → apply (W3-01; M3.1.3 between_pages, M3.4.2
// cursor_faults, M4.3.3 arrival_boundary / external_delete_update, M4.3.2
// scope_security). The documented rules (docs/cursors.md):
// - later pages contain current records at or below the first page's upper
//   tuple and strictly below the last returned tuple;
// - an arrival above the anchor appears only on a fresh traversal;
// - a record deleted before it is returned disappears;
// - an update that moves an unreturned record above the anchor can omit it,
//   and one that moves an already returned record below `last` can return
//   that URI again;
// - a cursor bound to another query, DID, scope or viewer is 400 invalid_cursor.

import { followRkey } from '@atmusic/atproto/test-support/read-models';
import { describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  CAROL,
  ctxFor,
  expectError,
  get,
  NOW_DTO,
  pageRkeys,
  readFixture,
  SCROBBLE,
  traverse,
  uriOf,
} from './scrobble-read-support';

const historyPath = (did: string, q = '') => `/api/v1/users/${did}/scrobbles${q}`;
const withCursor = (path: string, cursor: string) =>
  `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;

/** Follow nextCursor from an existing cursor to the end; returns the pages. */
async function continueFrom(ctx: Awaited<ReturnType<typeof ctxFor>>, path: string, cursor: string) {
  const pages: string[][] = [];
  let next: string | null = cursor;
  while (next !== null) {
    const r = await get(ctx, withCursor(path, next));
    pages.push(pageRkeys(r));
    expect(r.body.asOf).toBe(NOW_DTO);
    next = r.body.nextCursor;
    expect(pages.length).toBeLessThan(20);
  }
  return pages;
}

const scrobble = (track: string, listenedAt: string, extra: Record<string, unknown> = {}) => ({
  $type: SCROBBLE,
  artist: 'Radiohead',
  track,
  listenedAt,
  createdAt: listenedAt,
  ...extra,
});

describe('cursor traversal over HTTP', () => {
  it('arrival above anchor absent until fresh traversal; deleted unreturned record disappears', async () => {
    const f = await readFixture('cursor-arrival');
    const ctx = await ctxFor(f.index);

    const h1 = await get(ctx, historyPath(ALICE, '?limit=2'));
    expect(pageRkeys(h1)).toEqual(['r07', 'r01']);
    const g1 = await get(ctx, '/api/v1/feed?limit=3');
    expect(pageRkeys(g1)).toEqual(['r09', 'r10', 'r07']);

    // Between pages: a newer arrival r11 (above both anchors) and the deletion
    // of r03 (not yet returned by either traversal), both verified and applied.
    await f.kit.externalPut('Alice', SCROBBLE, 'r11', scrobble('Reckoner', '2026-01-15T11:55:00Z'));
    await f.kit.externalDelete('Alice', SCROBBLE, 'r03');
    expect(await f.drain()).toEqual([
      { uri: uriOf(ALICE, 'r11'), rev: expect.any(String), outcome: 'applied' },
      { uri: uriOf(ALICE, 'r03'), rev: expect.any(String), outcome: 'absent' },
    ]);
    const stored = await f.inDb((d) => ({
      r11: d.one<{ listened_at: string }>('SELECT listened_at FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11')),
      r03: d.one('SELECT uri FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r03')),
    }));
    expect(stored).toEqual({ r11: { listened_at: '2026-01-15T11:55:00.000000000Z' }, r03: null });

    // Continued traversals: no r11 (above the anchor), no r03 (deleted), no duplicate.
    const hRest = await continueFrom(ctx, historyPath(ALICE, '?limit=2'), h1.body.nextCursor);
    expect(hRest).toEqual([
      ['r02', 'r04'],
      ['r05', 'r06'],
    ]);
    const hAll = ['r07', 'r01', ...hRest.flat()];
    expect(new Set(hAll).size).toBe(hAll.length);
    const gRest = await continueFrom(ctx, '/api/v1/feed?limit=3', g1.body.nextCursor);
    expect(gRest).toEqual([
      ['r01', 'r02', 'r04'],
      ['r05', 'r06'],
    ]);

    // The continuation pages kept the original anchors.
    const historyCalls = f.index.calls.filter((c) => c.method === 'history').map((c) => c.args[0]);
    for (const q of historyCalls.slice(1)) {
      expect(q).toMatchObject({ upper: { t: '2026-01-15T11:00:00.000000000Z', uri: uriOf(ALICE, 'r07') } });
    }
    const feedCalls = f.index.calls.filter((c) => c.method === 'feed').map((c) => c.args[0]);
    for (const q of feedCalls.slice(1)) {
      expect(q).toMatchObject({ upper: { t: '2026-01-15T11:30:00.000000000Z', uri: uriOf(BOB, 'r09') } });
    }

    // A fresh traversal sees the arrival first, and still not the deletion.
    expect((await traverse(ctx, historyPath(ALICE, '?limit=2'))).flat()).toEqual([
      'r11',
      'r07',
      'r01',
      'r02',
      'r04',
      'r05',
      'r06',
    ]);
    expect((await traverse(ctx, '/api/v1/feed?limit=3')).flat()).toEqual([
      'r11',
      'r09',
      'r10',
      'r07',
      'r01',
      'r02',
      'r04',
      'r05',
      'r06',
    ]);
  });

  it('cursor from history used on feed or with different viewer → 400 invalid_cursor', async () => {
    const f = await readFixture('cursor-binding');
    const ctx = await ctxFor(f.index);
    // A second followed owner so Alice's following feed has a second page.
    await f.kit.createRecord('Alice', f.kit.collections.follow, await followRkey(CAROL), {
      $type: f.kit.collections.follow,
      subject: CAROL,
      createdAt: '2025-01-02T00:00:00Z',
    });
    expect((await f.drain()).map((o) => o.outcome)).toEqual(['applied']);

    const following = (viewer: string, q = '') =>
      `/api/v1/feed?scope=following&viewer=${encodeURIComponent(viewer)}${q}`;
    const historyCursor: string = (await get(ctx, historyPath(ALICE, '?limit=1'))).body.nextCursor;
    const globalCursor: string = (await get(ctx, '/api/v1/feed?limit=1')).body.nextCursor;
    const followingCursor: string = (await get(ctx, following(ALICE, '&limit=1'))).body.nextCursor;
    for (const c of [historyCursor, globalCursor, followingCursor]) expect(typeof c).toBe('string');

    const flip = (token: string) => {
      const k = Math.floor(token.indexOf('.') / 2);
      const swapped = token[k] === 'A' ? 'B' : 'A';
      return `${token.slice(0, k)}${swapped}${token.slice(k + 1)}`;
    };
    const calls = f.index.calls.length;
    const misuse: Array<[string, string]> = [
      ['/api/v1/feed', historyCursor],
      ['/api/v1/feed?scope=global', historyCursor],
      [following(ALICE), historyCursor],
      [historyPath(BOB), historyCursor],
      [following(BOB), followingCursor],
      [following(CAROL), followingCursor],
      ['/api/v1/feed', followingCursor],
      [historyPath(ALICE), followingCursor],
      [following(ALICE), globalCursor],
      [historyPath(ALICE), globalCursor],
      [historyPath(ALICE), flip(historyCursor)],
      [following(ALICE), flip(followingCursor)],
      [historyPath(ALICE), `${historyCursor}=`],
      [historyPath(ALICE), 'not-a-cursor'],
      [historyPath(ALICE), ''],
    ];
    for (const [path, cursor] of misuse) {
      const r = await get(ctx, withCursor(path, cursor));
      expectError(r, 400, 'invalid_cursor');
      expect(r.body.error.message).toBe('The pagination cursor is invalid for this request.');
    }
    // Two cursors are 422 fields.cursor, never a silent choice.
    expectError(
      await get(ctx, withCursor(withCursor(historyPath(ALICE), historyCursor), historyCursor)),
      422,
      'validation_failed',
      { cursor: 'Parameter must occur only once.' },
    );
    // No rejected cursor reached the index or restarted a traversal.
    expect(f.index.calls).toHaveLength(calls);

    // Each cursor still continues its own traversal; a global cursor ignores a supplied viewer.
    expect(pageRkeys(await get(ctx, withCursor(historyPath(ALICE, '?limit=1'), historyCursor)))).toEqual(['r01']);
    expect(pageRkeys(await get(ctx, withCursor(following(ALICE, '&limit=1'), followingCursor)))).toEqual(['r10']);
    const globalNext = await get(
      ctx,
      withCursor(`/api/v1/feed?viewer=${encodeURIComponent(BOB)}&limit=1`, globalCursor),
    );
    expect(pageRkeys(globalNext)).toEqual(['r10']);
  });

  it('record whose listenedAt moves across the anchor between pages follows the documented moved-row rule', async () => {
    const f = await readFixture('cursor-moved');
    const ctx = await ctxFor(f.index);

    const h1 = await get(ctx, historyPath(ALICE, '?limit=2'));
    expect(pageRkeys(h1)).toEqual(['r07', 'r01']);

    // r02 (not yet returned) moves above the anchor r07; r07 (already returned)
    // moves below the last tuple r01. Both are verified updates at newer revs.
    const r02 = f.seed.records.get(uriOf(ALICE, 'r02'))!;
    const r07 = f.seed.records.get(uriOf(ALICE, 'r07'))!;
    await f.kit.externalPut('Alice', SCROBBLE, 'r02', {
      ...(r02.record as object),
      listenedAt: '2026-01-15T11:50:00Z',
    });
    await f.kit.externalPut('Alice', SCROBBLE, 'r07', {
      ...(r07.record as object),
      listenedAt: '2025-06-01T00:00:00Z',
    });
    const moved = await f.drain();
    expect(moved.map((o) => [o.uri, o.outcome])).toEqual([
      [uriOf(ALICE, 'r02'), 'applied'],
      [uriOf(ALICE, 'r07'), 'applied'],
    ]);
    const rows = await f.inDb((d) =>
      d.all<{ rkey: string; listened_at: string; revision: string }>(
        `SELECT rkey, listened_at, revision FROM scrobbles WHERE rkey IN ('r02','r07') ORDER BY rkey`,
      ),
    );
    expect(rows.map((r) => [r.rkey, r.listened_at])).toEqual([
      ['r02', '2026-01-15T11:50:00.000000000Z'],
      ['r07', '2025-06-01T00:00:00.000000000Z'],
    ]);
    expect(rows.map((r) => r.revision)).toEqual(moved.map((o) => o.rev));

    // Continued traversal: r02 is omitted (now above the anchor) and r07 is
    // returned again (now below `last`), in its new position.
    const rest = await continueFrom(ctx, historyPath(ALICE, '?limit=2'), h1.body.nextCursor);
    expect(rest).toEqual([['r03', 'r04'], ['r07', 'r05'], ['r06']]);
    const page2 = rest.flat();
    expect(page2).not.toContain('r02');
    expect(page2.filter((k) => k === 'r07')).toHaveLength(1);

    // A fresh traversal sees every current record exactly once in the new order.
    const fresh = await traverse(ctx, historyPath(ALICE, '?limit=2'));
    expect(fresh.flat()).toEqual(['r02', 'r01', 'r03', 'r04', 'r07', 'r05', 'r06']);
    const r07Now = (await get(ctx, historyPath(ALICE))).body.items.find(
      (i: { uri: string }) => i.uri === uriOf(ALICE, 'r07'),
    );
    expect(r07Now.listenedAt).toBe('2025-06-01T00:00:00.000000000Z');
    expect(r07Now.revision).toBe(moved[1]!.rev);
  });
});
