// N1-12: ListenBrainz recording_msid (ADR 0005 §8.4). The expected UUIDs were
// computed independently with CPython's uuid.uuid5 over
// NFKC+casefold(artist) U+0000 NFKC+casefold(track) and are hardcoded here.

import { RECORDING_MSID_NAMESPACE, recordingMsid, recordingMsidOfKey, uuidV5 } from '@atmusic/core/msid';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { expect, it } from 'vitest';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/;

it('recording_msid has version nibble 5, is stable across runs, and is equal for Björk/Jóga and BJÖRK/JÓGA', async () => {
  expect(RECORDING_MSID_NAMESPACE).toBe('5d1f3e2a-8b47-4c6e-9f10-2a7c3b9d0e45');

  const bjork = await recordingMsid('Björk', 'Jóga');
  // Hardcoded value: identical in every run and on every host.
  expect(bjork).toBe('c323db7c-fb8f-548b-a5bb-570fa7e22e48');
  const match = UUID.exec(bjork);
  expect(match).not.toBeNull();
  expect(match![1]).toBe('5'); // version nibble
  expect(['8', '9', 'a', 'b']).toContain(match![2]); // RFC 9562 variant 10xx

  // Case, NFKC (fullwidth, decomposed ö) and White_Space variants share the MSID.
  expect(await recordingMsid('BJÖRK', 'JÓGA')).toBe(bjork);
  expect(await recordingMsid('ＢＪÖＲＫ', 'Jóga')).toBe(bjork);
  expect(await recordingMsid('  Björk ', 'jóga ')).toBe(bjork);
  expect(await recordingMsidOfKey(trackKey('Björk', 'Jóga'))).toBe(bjork);
  // Recomputing gives the same value (pure function of the keys).
  expect(await recordingMsid('Björk', 'Jóga')).toBe(bjork);

  // Other metadata gives another MSID; the U+0000 separator keeps artist and track apart.
  expect(await recordingMsid('Radiohead', 'Airbag')).toBe('0505b0a2-fbf8-5ed9-ad0a-1156b93a0b40');
  expect(await recordingMsid('Björk', 'Joga')).not.toBe(bjork);
  expect(await recordingMsid('Jóga', 'Björk')).not.toBe(bjork);

  // RFC 9562 Appendix A.4 test vector: UUIDv5(DNS namespace, "www.example.com").
  expect(await uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', new TextEncoder().encode('www.example.com'))).toBe(
    '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  );

  // Invalid display strings never get an MSID.
  await expect(recordingMsid('   ', 'Jóga')).rejects.toBeInstanceOf(MusicKeyError);
  await expect(recordingMsid('Björk', 'x'.repeat(257))).rejects.toMatchObject({ field: 'track' });
});
