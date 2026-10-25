// N2-06: the now-playing store (ADR 0005 §7.8, §8.3, §8.4, §8.6).
//
// now_playing is local, non-derived state (never a PDS record), so the users and
// accounts rows are seeded directly and every entry is written by the module
// under test. Times come from a frozen clock that only moves when stepped.

import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import type { NowPlayingRow } from '../../../src/app/rows';
import type { Db } from '../../../src/do/db';
import {
  clearNowPlaying,
  currentNowPlaying,
  deleteExpiredNowPlaying,
  nowPlayingTtlSeconds,
  ownNowPlaying,
  upsertNowPlaying,
} from '../../../src/do/read/now-playing';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = Date.parse('2026-01-15T12:00:00Z');

function seedAccount(db: Db, did: string, username: string, o: { account?: boolean } = {}): void {
  db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, ?, 1, 'active', 'current', 1)`,
    did,
    toStorage(fromMs(T0)),
  );
  if (o.account ?? true) {
    db.run(
      'INSERT INTO accounts(did, username, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
      did,
      username,
      T0,
      T0,
    );
  }
}

const rowOf = (db: Db, did: string) => db.one<NowPlayingRow>('SELECT * FROM now_playing WHERE did = ?', did);
const count = (db: Db) => db.one<{ n: number }>('SELECT count(*) AS n FROM now_playing')!.n;

describe('now playing', () => {
  it('an entry expires at started+duration (or +600 s without duration); the same track refreshes it; share_now_playing=0 hides it', async () => {
    await withMigratedDb((db) => {
      seedAccount(db, ALICE, 'alice');
      const clock = fixedClock();
      const m = { db, clock };

      // started + duration.
      const stored = upsertNowPlaying(m, {
        did: ALICE,
        artist: 'Radiohead',
        track: 'Reckoner',
        album: 'In Rainbows',
        durationSeconds: 290,
        client: 'pano',
        source: 'lastfm',
      });
      expect(stored.outcome).toBe('stored');
      expect(rowOf(db, ALICE)).toEqual({
        did: ALICE,
        artist: 'Radiohead',
        track: 'Reckoner',
        album: 'In Rainbows',
        album_artist: null,
        duration_seconds: 290,
        recording_mbid: null,
        client: 'pano',
        source: 'lastfm',
        started_at_ms: T0,
        expires_at_ms: T0 + 290_000,
      });
      expect(currentNowPlaying(m, ALICE)?.track).toBe('Reckoner');

      // The same track (another spelling) while current: refreshed, started kept, expiry now + ttl.
      clock.advance(100_000);
      const refreshed = upsertNowPlaying(m, {
        did: ALICE,
        artist: ' RADIOHEAD ',
        track: 'reckoner',
        durationSeconds: 290,
        source: 'lastfm',
      });
      expect(refreshed.outcome).toBe('refreshed');
      expect(rowOf(db, ALICE)).toMatchObject({
        artist: 'Radiohead',
        track: 'Reckoner',
        album: 'In Rainbows',
        started_at_ms: T0,
        expires_at_ms: T0 + 100_000 + 290_000,
      });
      // ListenBrainz's "identical current track is ignored" leaves the row as it is.
      const kept = upsertNowPlaying(m, {
        did: ALICE,
        artist: 'Radiohead',
        track: 'Reckoner',
        source: 'listenbrainz',
        sameTrack: 'keep',
      });
      expect(kept.outcome).toBe('unchanged');
      expect(rowOf(db, ALICE)!.expires_at_ms).toBe(T0 + 390_000);
      expect(count(db)).toBe(1);

      // Current up to the last millisecond, gone at started + duration.
      clock.set('2026-01-15T12:06:29.999Z');
      expect(currentNowPlaying(m, ALICE)).not.toBeNull();
      clock.set('2026-01-15T12:06:30.000Z');
      expect(currentNowPlaying(m, ALICE)).toBeNull();
      expect(ownNowPlaying(m, ALICE)).toBeNull();

      // The same track after expiry is a new entry; without a duration it lives 600 s.
      const again = upsertNowPlaying(m, { did: ALICE, artist: 'Radiohead', track: 'Reckoner', source: 'lastfm' });
      const t1 = Date.parse('2026-01-15T12:06:30Z');
      expect(again.outcome).toBe('stored');
      expect(rowOf(db, ALICE)).toMatchObject({
        started_at_ms: t1,
        expires_at_ms: t1 + 600_000,
        duration_seconds: null,
        album: null,
      });
      // A different track replaces the entry at once.
      clock.advance(5_000);
      expect(
        upsertNowPlaying(m, { did: ALICE, artist: 'Björk', track: 'Jóga', durationSeconds: 305, source: 'web' })
          .outcome,
      ).toBe('stored');
      expect(rowOf(db, ALICE)).toMatchObject({
        track: 'Jóga',
        started_at_ms: t1 + 5_000,
        expires_at_ms: t1 + 5_000 + 305_000,
      });
      expect(count(db)).toBe(1);

      // Last.fm uses the duration only within 30–5,400 s; ListenBrainz uses any stored duration.
      expect([20, 30, 5400, 6000, null].map((d) => nowPlayingTtlSeconds('lastfm', d))).toEqual([
        600, 30, 5400, 600, 600,
      ]);
      expect([20, 6000, null, 0, 90_000].map((d) => nowPlayingTtlSeconds('listenbrainz', d))).toEqual([
        20, 6000, 600, 600, 600,
      ]);

      // share_now_playing = 0 hides the entry from others; the owner still sees it.
      db.run('UPDATE accounts SET share_now_playing = 0 WHERE did = ?', ALICE);
      expect(currentNowPlaying(m, ALICE)).toBeNull();
      expect(ownNowPlaying(m, ALICE)?.track).toBe('Jóga');
      db.run('UPDATE accounts SET share_now_playing = 1 WHERE did = ?', ALICE);
      expect(currentNowPlaying(m, ALICE)?.track).toBe('Jóga');
      // An inactive owner shows nothing either.
      db.run('UPDATE users SET active = 0 WHERE did = ?', ALICE);
      expect(currentNowPlaying(m, ALICE)).toBeNull();
    });
  });

  it('playing-now/delete clears in ListenBrainz order and the sweep removes only expired entries', async () => {
    await withMigratedDb((db) => {
      seedAccount(db, ALICE, 'alice');
      seedAccount(db, BOB, 'bob', { account: false });
      const clock = fixedClock();
      const m = { db, clock };
      expect(clearNowPlaying(m, ALICE, 'pano')).toBe('already_cleared');

      upsertNowPlaying(m, {
        did: ALICE,
        artist: 'Radiohead',
        track: 'Reckoner',
        client: 'Web Scrobbler',
        source: 'listenbrainz',
      });
      expect(clearNowPlaying(m, ALICE, 'Navidrome')).toBe('client_mismatch');
      expect(clearNowPlaying(m, ALICE)).toBe('client_mismatch');
      expect(count(db)).toBe(1);
      expect(clearNowPlaying(m, ALICE, 'Web Scrobbler')).toBe('cleared');
      expect(count(db)).toBe(0);

      // An entry stored without a client is cleared for any client value.
      upsertNowPlaying(m, { did: ALICE, artist: 'Radiohead', track: 'Reckoner', source: 'listenbrainz' });
      expect(clearNowPlaying(m, ALICE, 'anything')).toBe('cleared');

      // A DID without an account row never shows an entry.
      upsertNowPlaying(m, {
        did: BOB,
        artist: 'Massive Attack',
        track: 'Teardrop',
        durationSeconds: 60,
        source: 'lastfm',
      });
      expect(currentNowPlaying(m, BOB)).toBeNull();
      upsertNowPlaying(m, { did: ALICE, artist: 'Björk', track: 'Jóga', source: 'lastfm' });
      clock.advance(60_000);
      expect(deleteExpiredNowPlaying(m)).toBe(1);
      expect(db.all<{ did: string }>('SELECT did FROM now_playing').map((r) => r.did)).toEqual([ALICE]);
    });
  });
});
