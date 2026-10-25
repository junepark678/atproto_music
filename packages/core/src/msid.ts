// ListenBrainz `recording_msid` (ADR 0005 §8.4; N1-12).
//
// recording_msid = UUIDv5(namespace 5d1f3e2a-8b47-4c6e-9f10-2a7c3b9d0e45,
//                         UTF-8(artist_key ‖ U+0000 ‖ normalized track))
// where both components come from `trackKey` (music-key.ts): NFKC, full case
// folding, White_Space trim and collapse. It is a pure function of the grouping
// keys, so it is stable across runs and equal for every listen with the same
// normalised artist and track, matching ListenBrainz's per-metadata MSIDs.
// UUIDv5 is RFC 9562 §5.5: SHA-1 over namespace bytes ‖ name, first 16 bytes,
// version nibble 5, variant 10.

import { type TrackKey, trackKey } from './music-key';

export const RECORDING_MSID_NAMESPACE = '5d1f3e2a-8b47-4c6e-9f10-2a7c3b9d0e45';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidBytes(uuid: string): Uint8Array {
  if (!UUID.test(uuid)) throw new RangeError(`expected a lowercase hyphenated UUID, got ${uuid}`);
  const hex = uuid.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 9562 UUIDv5 of `name` (bytes) under `namespace`, lowercase hyphenated. */
export async function uuidV5(namespace: string, name: Uint8Array): Promise<string> {
  const ns = uuidBytes(namespace);
  const input = new Uint8Array(ns.length + name.length);
  input.set(ns, 0);
  input.set(name, ns.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** The MSID of an already computed track key. */
export async function recordingMsidOfKey(key: TrackKey): Promise<string> {
  const [artist, track] = key;
  if (!artist.isWellFormed() || !track.isWellFormed()) throw new RangeError('track key contains a lone surrogate');
  return uuidV5(RECORDING_MSID_NAMESPACE, new TextEncoder().encode(`${artist}\u0000${track}`));
}

/**
 * The MSID of a listen's artist and track display strings. Throws `MusicKeyError`
 * when either is not a valid display string (the track is checked first).
 */
export async function recordingMsid(artist: string, track: string): Promise<string> {
  return recordingMsidOfKey(trackKey(artist, track));
}
