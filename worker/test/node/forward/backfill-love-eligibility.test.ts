import { albumKey } from '@atmusic/core/music-key';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { resolveLoveRecording } from '../../../src/forward/love-recording';

const TRACK = { artist: 'Example Artist', track: 'Example Song', album: 'Example Album' };
const MBID = '123e4567-e89b-42d3-a456-426614174000';

function lookupDb(statuses: Record<string, string>, matches: Record<string, string> = {}): Db {
  return {
    all: () => [],
    run: () => ({ rowsWritten: 0 }),
    tx: (fn) => fn(),
    one: (sql: string, ...params: (string | number | null | ArrayBuffer)[]) => {
      const album = String(params[2] ?? '');
      if (sql.includes('recording_mbid')) {
        const recording = matches[album];
        return recording ? { status: 'matched', recording_mbid: recording } : null;
      }
      const status = statuses[album];
      return status ? { status } : null;
    },
  } as Db;
}

const primaryAlbumKey = '';
const fallbackAlbumKey = albumKey(TRACK.artist, TRACK.album)?.[1] ?? '';
describe('backfill love recording eligibility', () => {
  it('uses a matched album-less projection tuple before the album fallback', () => {
    expect(
      resolveLoveRecording(
        lookupDb(
          { [primaryAlbumKey]: 'matched', [fallbackAlbumKey]: 'matched' },
          {
            [primaryAlbumKey]: MBID,
            [fallbackAlbumKey]: '223e4567-e89b-42d3-a456-426614174000',
          },
        ),
        TRACK,
      ),
    ).toEqual({ mbid: MBID });
  });

  it('uses a compatible matched album tuple when the primary tuple has no match', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'unmatched' }, { [fallbackAlbumKey]: MBID }), TRACK),
    ).toEqual({ mbid: MBID });
  });

  it('keeps a pending primary unresolved even when its album fallback is terminal', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'pending', [fallbackAlbumKey]: 'unmatched' }), TRACK),
    ).toEqual({ pending: true });
  });

  it('is terminal only after both primary and album tuples are unmatched', () => {
    expect(
      resolveLoveRecording(lookupDb({ [primaryAlbumKey]: 'unmatched', [fallbackAlbumKey]: 'unmatched' }), TRACK),
    ).toEqual({ terminal: true });
  });

  it('queries the canonical track keys with primary first', () => {
    const queried: string[] = [];
    const db = lookupDb({ [primaryAlbumKey]: 'pending' });
    const originalOne = db.one.bind(db);
    db.one = ((sql: string, ...params: (string | number | null | ArrayBuffer)[]) => {
      if (sql.includes('recording_mbid')) queried.push(String(params[2]));
      return originalOne(sql, ...params);
    }) as Db['one'];
    resolveLoveRecording(db, TRACK);
    expect(queried).toEqual(['', fallbackAlbumKey]);
  });
});
