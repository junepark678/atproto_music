// The /api/v1 Scrobble `handle`: the actor's handle verified exactly as
// Profile.handle, resolved once per distinct actor on a page, null when the
// resolver did not verify it (or failed).
import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import { describe, expect, it } from 'vitest';
import { ALICE, BOB, ctxFor, get, readFixture, schemas } from '../read/scrobble-read-support';

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
    const first = f.db.db.one<{
      uri: string;
      artist_key: string;
      track_key: string;
      album_key: string | null;
      artist: string;
      track: string;
    }>(
      'SELECT uri,artist_key,track_key,album_key,artist,track FROM scrobbles WHERE did=? ORDER BY uri LIMIT 1',
      ALICE,
    )!;
    f.db.db.run(
      `INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,title,artist_credit,artist_mbids,
      release_mbid,release_title,release_group_mbid,duration_ms,isrcs,matched_by,score,synced_at_ms,created_at_ms)
      VALUES(?,?,?,'matched','3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10','MB title','MB artist','[]',
      NULL,'Album','3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',123000,'[]','search',95,1768478400000,1)
      ON CONFLICT(artist_key,track_key,album_key) DO UPDATE SET status='matched',recording_mbid=excluded.recording_mbid,title=excluded.title,
        artist_credit=excluded.artist_credit,artist_mbids=excluded.artist_mbids,release_title=excluded.release_title,
        release_group_mbid=excluded.release_group_mbid,duration_ms=excluded.duration_ms,matched_by=excluded.matched_by,synced_at_ms=excluded.synced_at_ms`,
      first.artist_key,
      first.track_key,
      first.album_key ?? '',
    );
    const ctx = await ctxFor(f.index);

    const r = await get(ctx, '/api/v1/feed?scope=global');
    expect(r.status).toBe(200);
    expect(schemas.ScrobblePage(r.body)).toBe('valid');
    const byDid = new Map<string, unknown>();
    for (const item of r.body.items as { did: string; handle: unknown }[]) byDid.set(item.did, item.handle);
    expect(byDid.get(ALICE)).toBe('alice.test');
    expect(byDid.get(BOB)).toBeNull();
    const enriched = (
      r.body.items as Array<{
        did: string;
        artist: string;
        track: string;
        recordingMbid: string | null;
        musicbrainz?: Record<string, unknown>;
      }>
    ).find((item) => item.did === ALICE && item.artist === first.artist && item.track === first.track)!;
    expect(enriched).toMatchObject({
      musicbrainz: {
        recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
        title: 'MB title',
        artistCredit: 'MB artist',
        artistMbids: [],
        releaseTitle: 'Album',
        releaseGroupMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
        durationSeconds: 123,
        matchedBy: 'search',
        syncedAt: '2026-01-15T12:00:00.000000000Z',
      },
    });
    expect(enriched.artist).toBe(first.artist);
    for (const [did, handle] of byDid) if (did !== ALICE) expect(handle).toBeNull();
    expect(calls.sort()).toEqual([...byDid.keys()].sort());
    expect(f.index.calls.filter((c) => c.method === 'verifiedHandles')).toHaveLength(1);

    const lookup = await get(ctx, `/api/v1/scrobbles/${encodeURIComponent(first.uri)}`);
    expect(schemas.ScrobbleResult(lookup.body)).toBe('valid');
    expect(lookup.body.scrobble.handle).toBe('alice.test');
    expect(lookup.body.scrobble.musicbrainz).toMatchObject({
      recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      title: 'MB title',
    });
    const history = await get(ctx, `/api/v1/users/${ALICE}/scrobbles`);
    expect(
      (history.body.items as Array<{ uri: string; musicbrainz?: unknown }>).find((item) => item.uri === first.uri)
        ?.musicbrainz,
    ).toMatchObject({
      recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
    });
    const bobHistory = await get(ctx, `/api/v1/users/${BOB}/scrobbles`);
    expect(bobHistory.body.items.every((i: { handle: unknown }) => i.handle === null)).toBe(true);
  });
});
