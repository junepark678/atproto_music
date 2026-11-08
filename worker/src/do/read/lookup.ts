// Single-record lookup (API.md `GET /api/v1/scrobbles/{id}`; Rust
// crates/storage/src/repositories/public.rs `scrobble`).
//
// `lookup(m, uri)` returns the visible scrobble row with exactly that AT URI,
// or null. Null covers every 404 case: an unknown URI, a record proven absent
// (deleted) or excluded (invalid remote record) — neither has a `scrobbles`
// row, only record_state — and a row whose owner is inactive or suppressed
// (./visibility.ts). Follow and settings URIs are never in `scrobbles`.

import { parseScrobbleBatchListenUri } from '@atmusic/core/scrobble-batch';
import type { ModuleDeps, ScrobbleRow } from '../contracts';
import { visibleScrobblesFrom } from './visibility';
import { MUSICBRAINZ_SCROBBLE_COLUMNS, MUSICBRAINZ_SCROBBLE_JOIN } from './musicbrainz-join';

export function lookup(m: ModuleDeps, uri: string): ScrobbleRow | null {
  if (typeof uri !== 'string') throw new RangeError('lookup needs an AT URI string');
  const parsedBatch = parseScrobbleBatchListenUri(uri);
  if (uri.includes('#') && parsedBatch === null) return null;
  return m.db.one<ScrobbleRow>(`SELECT s.*, ${MUSICBRAINZ_SCROBBLE_COLUMNS} FROM ${visibleScrobblesFrom('s', 'u')} ${MUSICBRAINZ_SCROBBLE_JOIN} WHERE s.uri = ?`, uri);
}
