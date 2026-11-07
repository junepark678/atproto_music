// The /api/v1 Scrobble `handle`: the actor's handle verified exactly as
// Profile.handle, resolved once per distinct actor on a page, null when the
// resolver did not verify it (or failed).
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import { describe, expect, it } from 'vitest';
import { ALICE, BOB, ctxFor, get, readFixture, schemas, uriOf } from '../read/scrobble-read-support';

function identity(calls: string[]): IdentityResolver {
  return {
    async resolveDid(did) {
      calls.push(did);
      if (did === BOB) throw new Error('resolver unavailable');
      return {
        did,
        pds: 'https://pds.test',
        signingKey: 'did:key:z',
        handle: did === ALICE ? 'Alice.Test' : null,
        fetchedAtMs: 0,
      };
    },
    async resolveHandle(handle) {
      throw new Error(`unexpected ${handle}`);
    },
  };
}

describe('scrobble handles', () => {
  it('feed items carry the verified handle, null otherwise, with one lookup per distinct actor', async () => {
    const calls: string[] = [];
    const f = await readFixture('scrobble-handles', { identity: identity(calls) });
    const ctx = await ctxFor(f.index);

    const r = await get(ctx, '/api/v1/feed?scope=global');
    expect(r.status).toBe(200);
    expect(schemas.ScrobblePage(r.body)).toBe('valid');
    const byDid = new Map<string, unknown>();
    for (const item of r.body.items as { did: string; handle: unknown }[]) byDid.set(item.did, item.handle);
    expect(byDid.get(ALICE)).toBe('alice.test');
    expect(byDid.get(BOB)).toBeNull();
    for (const [did, handle] of byDid) if (did !== ALICE) expect(handle).toBeNull();
    expect(calls.sort()).toEqual([...byDid.keys()].sort());
    expect(f.index.calls.filter((c) => c.method === 'verifiedHandles')).toHaveLength(1);

    const lookup = await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(uriOf(ALICE, 'r01'))}`);
    expect(schemas.ScrobbleResult(lookup.body)).toBe('valid');
    expect(lookup.body.scrobble.handle).toBe('alice.test');
    const history = await get(ctx, `/api/v1/users/${BOB}/scrobbles`);
    expect(history.body.items.every((i: { handle: unknown }) => i.handle === null)).toBe(true);
  });
});
