// GET /api/v1/users/{did}/scrobbles and GET /api/v1/scrobbles/{id} over the
// shared read-model fixture, seeded through verify → apply (W3-01; M3.1.2
// history_exact_order / visibility / lookup_and_limits, M3.1.3
// equal_timestamp). Expected orders are hardcoded from TESTING.md.

import { cursorBindings, decodeCursor } from '@atmusic/core/cursor';
import { describe, expect, it } from 'vitest';
import { markInactive } from '../../src/do/write/account-state';
import {
  ALICE,
  BOB,
  ctxFor,
  expectError,
  get,
  HARNESS_INDEXING,
  harnessCursorKey,
  NOW_DTO,
  pageRkeys,
  readFixture,
  rkeyOf,
  SCROBBLE,
  schemas,
  traverse,
  uriOf,
} from './scrobble-read-support';

const historyPath = (did: string, query = '') => `/api/v1/users/${did}/scrobbles${query}`;
const lookupPath = (uri: string) => `/api/v1/scrobbles/${encodeURIComponent(uri)}`;

describe('history', () => {
  it('Alice history r07,r01,r02,r03,r04,r05,r06 (equal timestamps by URI desc)', async () => {
    const f = await readFixture('history-order');
    const ctx = await ctxFor(f.index);

    const r = await get(ctx, historyPath(ALICE));
    expect(pageRkeys(r)).toEqual(['r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.asOf).toBe(NOW_DTO);
    expect(r.body.indexing).toEqual(HARNESS_INDEXING);

    // r07 and r01 share listenedAt; the full AT URI descending puts r07 first.
    const [r07, r01] = r.body.items;
    expect(r07.listenedAt).toBe('2026-01-15T11:00:00.000000000Z');
    expect(r01.listenedAt).toBe('2026-01-15T11:00:00.000000000Z');
    expect(r07.uri > r01.uri).toBe(true);

    // The exact public DTO: Rust field order, stored timestamps verbatim, no private columns.
    const seeded = f.seed.records.get(uriOf(ALICE, 'r07'))!;
    expect(Object.keys(r07)).toEqual([
      'uri',
      'cid',
      'did',
      'revision',
      'artist',
      'track',
      'album',
      'listenedAt',
      'createdAt',
      'indexedAt',
    ]);
    expect(r07).toEqual({
      uri: uriOf(ALICE, 'r07'),
      cid: seeded.cid,
      did: ALICE,
      revision: seeded.rev,
      artist: 'Radiohead',
      track: 'No Surprises',
      album: 'OK Computer',
      listenedAt: '2026-01-15T11:00:00.000000000Z',
      createdAt: '2026-01-15T11:00:00.000000000Z',
      indexedAt: NOW_DTO,
    });
    // r05 has no album: the field is omitted, never null.
    const r05 = r.body.items.find((i: { uri: string }) => rkeyOf(i.uri) === 'r05');
    expect('album' in r05).toBe(false);

    // One RPC, a first page: no keyset bounds.
    expect(f.index.calls).toEqual([{ method: 'history', args: [{ did: ALICE, limit: 20 }] }]);

    // Storage: seven visible Alice rows, r08 only as an absent record_state.
    const db = await f.inDb((d) => ({
      rows: d.all<{ rkey: string }>('SELECT rkey FROM scrobbles WHERE did = ? ORDER BY rkey', ALICE).map((x) => x.rkey),
      r08: d.one<{ state: string }>('SELECT state FROM record_state WHERE uri = ?', uriOf(ALICE, 'r08')),
    }));
    expect(db.rows).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07']);
    expect(db.r08).toEqual({ state: 'absent' });

    // A path value that is not a DID is 422 fields.did, with no RPC.
    for (const bad of ['alice.test', 'did:plc', 'not%20a%20did']) {
      expectError(await get(ctx, historyPath(bad)), 422, 'validation_failed', { did: 'Expected a DID.' });
    }
    expect(f.index.calls).toHaveLength(1);

    // Bob's history is his own record only.
    expect(pageRkeys(await get(ctx, historyPath(BOB)))).toEqual(['r09']);
  });

  it('limit 2 pages [r07,r01],[r02,r03],[r04,r05],[r06] then nextCursor null', async () => {
    const f = await readFixture('history-pages');
    const ctx = await ctxFor(f.index);

    const pages = await traverse(ctx, historyPath(ALICE, '?limit=2'));
    expect(pages).toEqual([['r07', 'r01'], ['r02', 'r03'], ['r04', 'r05'], ['r06']]);
    const union = pages.flat();
    expect(new Set(union).size).toBe(union.length);

    // The traversal kept the first page's anchor (r07) and advanced `last` each page.
    const r07 = { t: '2026-01-15T11:00:00.000000000Z', uri: uriOf(ALICE, 'r07') };
    expect(f.index.calls.map((c) => c.args[0])).toEqual([
      { did: ALICE, limit: 2 },
      { did: ALICE, upper: r07, last: { t: '2026-01-15T11:00:00.000000000Z', uri: uriOf(ALICE, 'r01') }, limit: 2 },
      { did: ALICE, upper: r07, last: { t: '2026-01-08T12:00:00.000000000Z', uri: uriOf(ALICE, 'r03') }, limit: 2 },
      { did: ALICE, upper: r07, last: { t: '2025-01-15T12:00:00.000000000Z', uri: uriOf(ALICE, 'r05') }, limit: 2 },
    ]);

    // The first nextCursor is a signed history(Alice) cursor: anchor r07, last r01, asOf frozen.
    const first = await get(ctx, historyPath(ALICE, '?limit=2'));
    const decoded = await decodeCursor(await harnessCursorKey(), first.body.nextCursor, cursorBindings.history(ALICE));
    expect(decoded.binding).toEqual({ query: 'history', did: ALICE, scope: null, viewer: null });
    expect(decoded.upper).toEqual({ timestamp: r07.t, uri: r07.uri });
    expect(decoded.last).toEqual({ timestamp: '2026-01-15T11:00:00.000000000Z', uri: uriOf(ALICE, 'r01') });
    expect(decoded.asOf).toBe(NOW_DTO);

    // Page size may change between requests within 1..=100.
    const rest = await get(
      ctx,
      `${historyPath(ALICE, '?limit=5')}&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(pageRkeys(rest)).toEqual(['r02', 'r03', 'r04', 'r05', 'r06']);
    expect(rest.body.nextCursor).toBeNull();

    // Limits are never clamped: 422 fields.limit and no RPC.
    const before = f.index.calls.length;
    for (const limit of ['0', '101', '1.5', '-1', 'abc']) {
      expectError(await get(ctx, historyPath(ALICE, `?limit=${limit}`)), 422, 'validation_failed', {
        limit: 'Expected an integer between 1 and 100.',
      });
    }
    expect(f.index.calls).toHaveLength(before);
  });

  it('r08 deleted never appears; lookup of r08 is 404', async () => {
    const f = await readFixture('history-r08');
    const ctx = await ctxFor(f.index);
    const r08 = uriOf(ALICE, 'r08');

    // r08 was verified present at its create commit, then proven absent at the delete commit.
    expect(f.outcomes.filter((o) => o.uri === r08).map((o) => o.outcome)).toEqual(['applied', 'absent']);
    const state = await f.inDb((d) => ({
      row: d.one('SELECT uri FROM scrobbles WHERE uri = ?', r08),
      rs: d.one<{ state: string; revision: string; cid: string | null }>(
        'SELECT state, revision, cid FROM record_state WHERE uri = ?',
        r08,
      ),
    }));
    expect(state.row).toBeNull();
    expect(state.rs).toEqual({ state: 'absent', revision: f.seed.records.get(r08)!.rev, cid: null });

    // Not in any history page, nor in the global feed, at any page size.
    for (const limit of [1, 2, 3, 100]) {
      expect((await traverse(ctx, historyPath(ALICE, `?limit=${limit}`))).flat()).not.toContain('r08');
      expect((await traverse(ctx, `/api/v1/feed?limit=${limit}`)).flat()).not.toContain('r08');
    }

    const before = f.index.calls.length;
    const res = await get(ctx, lookupPath(r08));
    expectError(res, 404, 'not_found');
    expect(res.body.error.message).toBe('The resource is absent or inactive.');
    expect(f.index.calls.slice(before)).toEqual([{ method: 'lookup', args: [r08] }]);
  });

  it('lookup of encoded r01 AT URI returns the exact Scrobble; unknown URI → 404', async () => {
    const f = await readFixture('history-lookup');
    const ctx = await ctxFor(f.index);
    const r01 = uriOf(ALICE, 'r01');
    const seeded = f.seed.records.get(r01)!;

    const ok = await get(ctx, lookupPath(r01));
    expect(ok.status).toBe(200);
    expect(schemas.ScrobbleResult(ok.body)).toBe('valid');
    expect(ok.res.headers.get('cache-control')).toBe('no-store');
    expect(ok.body).toEqual({
      scrobble: {
        uri: r01,
        cid: seeded.cid,
        did: ALICE,
        revision: seeded.rev,
        artist: 'Björk',
        track: 'Jóga',
        album: 'Homogenic',
        listenedAt: '2026-01-15T11:00:00.000000000Z',
        createdAt: '2026-01-15T11:00:00.000000000Z',
        indexedAt: NOW_DTO,
      },
    });
    // It is the same DTO the history page serves.
    const page = await get(ctx, historyPath(ALICE));
    expect(page.body.items.find((i: { uri: string }) => i.uri === r01)).toEqual(ok.body.scrobble);
    expect(f.index.calls[0]).toEqual({ method: 'lookup', args: [r01] });

    // Unknown URIs (well-formed, never indexed) are 404.
    for (const unknown of [uriOf(ALICE, 'absent'), uriOf(BOB, 'r01'), `at://${ALICE}/${SCROBBLE}.other/r01`]) {
      expectError(await get(ctx, lookupPath(unknown)), 404, 'not_found');
    }
    // A follow record URI is not a scrobble.
    const followUri = [...f.seed.records.keys()].find((u) => u.includes('.follow/'))!;
    expectError(await get(ctx, lookupPath(followUri)), 404, 'not_found');

    // An excluded record (verified, but invalid) is 404 and lives only in record_state.
    await f.kit.externalPut('Alice', SCROBBLE, 'r12', {
      $type: SCROBBLE,
      artist: '   ',
      track: 'Blank Artist',
      listenedAt: '2026-01-15T10:00:00Z',
      createdAt: '2026-01-15T10:00:00Z',
    });
    expect((await f.drain()).map((o) => o.outcome)).toEqual(['excluded']);
    expectError(await get(ctx, lookupPath(uriOf(ALICE, 'r12'))), 404, 'not_found');
    expect(
      await f.inDb((d) =>
        d.one<{ state: string }>('SELECT state FROM record_state WHERE uri = ?', uriOf(ALICE, 'r12')),
      ),
    ).toEqual({ state: 'excluded' });

    // A value that is not a record AT URI, or does not percent-decode, is 422 fields.id; no RPC.
    const calls = f.index.calls.length;
    for (const bad of [
      'r01',
      encodeURIComponent(`at://${ALICE}`),
      '%E0%A4%A',
      encodeURIComponent('https://x.test/a'),
    ]) {
      expectError(await get(ctx, `/api/v1/scrobbles/${bad}`), 422, 'validation_failed', {
        id: 'Expected a URL-encoded AT URI.',
      });
    }
    expect(f.index.calls).toHaveLength(calls);

    // An inactive owner hides the record: 404, and the history is empty.
    await f.inDb((d) => d.tx(() => markInactive(d, ALICE, 'deactivated')));
    expectError(await get(ctx, lookupPath(r01)), 404, 'not_found');
    expect(pageRkeys(await get(ctx, historyPath(ALICE)))).toEqual([]);
    expect(await f.inDb((d) => d.one('SELECT uri FROM scrobbles WHERE uri = ?', r01))).toEqual({ uri: r01 });
  });
});
