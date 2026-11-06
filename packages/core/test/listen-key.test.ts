// N1-12: listen keys (ADR 0005 §7.7). The expected digests were computed
// independently with CPython hashlib over the documented framing
// ("atmusic:listen-key:v1" then each field as u32 BE byte length + UTF-8) and are
// hardcoded here.

import { floorSeconds, LISTEN_KEY_DOMAIN, listenKey, listenKeyOf } from '@atmusic/core/listen-key';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { fromMs, NS_PER_SECOND } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER_DID = 'did:plc:bbcdefghijklmnopqrstuvwx';
const NOW_NS = fromMs(fixedClock().nowMs()); // 2026-01-15T12:00:00Z = 1768478400 s

it('the listen key is equal for case and NFKC variants in the same second and differs for +1 s or another DID', async () => {
  expect(LISTEN_KEY_DOMAIN).toBe('atmusic:listen-key:v1');
  const base = await listenKey({ did: DID, listenedAtNs: NOW_NS, artist: 'Björk', track: 'Jóga' });
  expect(base).toBe('23db81cfdebc2ba75a96e6f665b9954bdc71a61baaa744ddc4be9eab03c38816');

  // Same second (floor), case and NFKC variants: one key.
  const sameSecond = [
    { artist: 'BJÖRK', track: 'JÓGA', listenedAtNs: NOW_NS + 999_999_999n },
    { artist: 'ＢＪÖＲＫ', track: 'Jóga', listenedAtNs: NOW_NS + 500_000_000n },
    { artist: ' Björk  ', track: 'jóga', listenedAtNs: NOW_NS + 1n },
  ];
  for (const variant of sameSecond) expect(await listenKey({ did: DID, ...variant })).toBe(base);
  expect(await listenKeyOf(DID, 1_768_478_400n, trackKey('björk', 'jóga'))).toBe(base);

  // The next second differs, and so does the previous nanosecond (previous second).
  const plusOne = await listenKey({ did: DID, listenedAtNs: NOW_NS + NS_PER_SECOND, artist: 'Björk', track: 'Jóga' });
  expect(plusOne).toBe('fa8e3479a2645993bc33356d8f269b528a759ecd36bb9f48a8f347b6f32ad914');
  expect(plusOne).not.toBe(base);
  expect(await listenKey({ did: DID, listenedAtNs: NOW_NS - 1n, artist: 'Björk', track: 'Jóga' })).not.toBe(base);

  // Another DID differs.
  const other = await listenKey({ did: OTHER_DID, listenedAtNs: NOW_NS, artist: 'Björk', track: 'Jóga' });
  expect(other).toBe('75a15e85bdd176d0477fce042100dc1ae50a1d90eb096d023a70b296f361287b');

  // Another track or swapped fields differ (length framing, not plain concatenation).
  expect(await listenKey({ did: DID, listenedAtNs: NOW_NS, artist: 'Björk', track: 'Joga' })).not.toBe(base);
  expect(await listenKey({ did: DID, listenedAtNs: NOW_NS, artist: 'Jóga', track: 'Björk' })).not.toBe(base);
  expect(await listenKeyOf(DID, 1n, ['ab', 'c'])).not.toBe(await listenKeyOf(DID, 1n, ['a', 'bc']));

  expect(floorSeconds(1_999_999_999n)).toBe(1n);
  expect(floorSeconds(-1n)).toBe(-1n);
  await expect(listenKey({ did: 'not-a-did', listenedAtNs: NOW_NS, artist: 'a', track: 'b' })).rejects.toBeInstanceOf(
    RangeError,
  );
  await expect(listenKey({ did: DID, listenedAtNs: NOW_NS, artist: '', track: 'b' })).rejects.toBeInstanceOf(
    MusicKeyError,
  );
});
