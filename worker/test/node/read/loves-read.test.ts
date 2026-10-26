// N2-06: loved-track reads (ADR 0005 §6.3, §7.9 user.getLovedTracks,
// track.getInfo userloved, extended=1 loved, §8.6 get-feedback).
//
// The love projection (apply-record for <p>.love) arrives with N3-11, so the
// `loves` rows are seeded directly, with keys from the production music-key
// functions exactly as the projection will store them.

import { artistKey, trackKey } from '@atmusic/core/music-key';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { isLoved, isLovedKey, lovedKeyIds, lovedTracks, loveKeyId } from '../../../src/do/read/loves';
import { withMigratedDb } from '../support/node-db';

const LOVE = 'com.example.atmusic.love';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const NOW = toStorage(fromMs(Date.parse('2026-01-15T12:00:00Z')));

function seedUser(db: Db, did: string): void {
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', 1)`,
    did,
    NOW,
  );
}

function seedLove(db: Db, did: string, rkey: string, artist: string, track: string, createdAt: string): string {
  const uri = `at://${did}/${LOVE}/${rkey}`;
  db.run(
    `INSERT INTO loves(uri, did, rkey, cid, artist, track, album, artist_key, track_key, recording_mbid, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    uri,
    did,
    rkey,
    `bafyrei${rkey}`,
    artist,
    track,
    artistKey(artist),
    trackKey(artist, track)[1],
    toStorage(fromMs(Date.parse(createdAt))),
    NOW,
  );
  return rkey;
}

const rkeys = (rows: ReadonlyArray<{ rkey: string }>) => rows.map((r) => r.rkey);

describe('loved tracks', () => {
  it('loved tracks are newest first and isLoved matches by (artist_key, track_key) across spelling variants', async () => {
    await withMigratedDb((db) => {
      seedUser(db, ALICE);
      seedUser(db, BOB);
      seedLove(db, ALICE, '3laaaaaaaaaa1', 'Björk', 'Jóga', '2026-01-10T09:00:00Z');
      seedLove(db, ALICE, '3laaaaaaaaaa2', 'Radiohead', 'Reckoner', '2026-01-12T09:00:00Z');
      // Same instant as …a2: uri DESC puts …a3 first.
      seedLove(db, ALICE, '3laaaaaaaaaa3', 'Kate Bush', 'Cloudbusting', '2026-01-12T09:00:00Z');
      seedLove(db, ALICE, '3laaaaaaaaaa4', 'Massive Attack', 'Angel', '2025-12-01T09:00:00Z');
      seedLove(db, BOB, '3lbbbbbbbbbb1', 'Portishead', 'Roads', '2026-01-14T09:00:00Z');
      const m = { db };

      const page1 = lovedTracks(m, { did: ALICE, limit: 3 })!;
      expect(rkeys(page1.rows)).toEqual(['3laaaaaaaaaa3', '3laaaaaaaaaa2', '3laaaaaaaaaa1']);
      expect([page1.total, page1.totalPages, page1.page, page1.perPage]).toEqual([4, 2, 1, 3]);
      const page2 = lovedTracks(m, { did: ALICE, limit: 3, page: 2 })!;
      expect([rkeys(page2.rows), page2.offset]).toEqual([['3laaaaaaaaaa4'], 3]);
      expect(page1.rows[0]).toMatchObject({ artist: 'Kate Bush', track: 'Cloudbusting', did: ALICE });
      expect(rkeys(lovedTracks(m, { did: BOB, limit: 50 })!.rows)).toEqual(['3lbbbbbbbbbb1']);

      // Spelling variants share the music key.
      expect(isLoved(m, { did: ALICE, artist: 'Björk', track: 'Jóga' })).toBe(true);
      expect(isLoved(m, { did: ALICE, artist: '  BJÖRK ', track: 'JÓGA' })).toBe(true);
      expect(isLoved(m, { did: ALICE, artist: 'radiohead', track: ' reckoner ' })).toBe(true);
      expect(isLoved(m, { did: ALICE, artist: 'Björk', track: 'Army of Me' })).toBe(false);
      // Another user's love is not Alice's; a name without a key is loved by nobody.
      expect(isLoved(m, { did: ALICE, artist: 'Portishead', track: 'Roads' })).toBe(false);
      expect(isLoved(m, { did: BOB, artist: 'portishead', track: 'ROADS' })).toBe(true);
      expect(isLoved(m, { did: ALICE, artist: '   ', track: 'Jóga' })).toBe(false);
      expect(isLovedKey(m, ALICE, artistKey('BJÖRK'), trackKey('BJÖRK', 'jóga')[1])).toBe(true);

      // Batch form for a page of recent tracks (extended=1).
      const ids = lovedKeyIds(m, ALICE, [
        { artistKey: 'björk', trackKey: 'jóga' },
        { artistKey: 'björk', trackKey: 'army of me' },
        { artistKey: 'portishead', trackKey: 'roads' },
        { artistKey: 'kate bush', trackKey: 'cloudbusting' },
      ]);
      expect([...ids].sort()).toEqual([loveKeyId('björk', 'jóga'), loveKeyId('kate bush', 'cloudbusting')].sort());
      expect(lovedKeyIds(m, ALICE, []).size).toBe(0);

      // Unknown and inactive users have no loved tracks and love nothing.
      expect(lovedTracks(m, { did: CAROL, limit: 10 })).toBeNull();
      db.run('UPDATE users SET active = 0 WHERE did = ?', ALICE);
      expect(lovedTracks(m, { did: ALICE, limit: 10 })).toBeNull();
      expect(isLoved(m, { did: ALICE, artist: 'Björk', track: 'Jóga' })).toBe(false);
      expect(lovedKeyIds(m, ALICE, [{ artistKey: 'björk', trackKey: 'jóga' }]).size).toBe(0);
    });
  });
});
