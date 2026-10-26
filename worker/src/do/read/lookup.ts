// Single-record lookup (API.md `GET /api/v1/scrobbles/{id}`; Rust
// crates/storage/src/repositories/public.rs `scrobble`).
//
// `lookup(m, uri)` returns the visible scrobble row with exactly that AT URI,
// or null. Null covers every 404 case: an unknown URI, a record proven absent
// (deleted) or excluded (invalid remote record) — neither has a `scrobbles`
// row, only record_state — and a row whose owner is inactive or suppressed
// (./visibility.ts). Follow and settings URIs are never in `scrobbles`.

import type { ModuleDeps, ScrobbleRow } from '../contracts';
import { visibleScrobblesFrom } from './visibility';

export function lookup(m: ModuleDeps, uri: string): ScrobbleRow | null {
  if (typeof uri !== 'string') throw new RangeError('lookup needs an AT URI string');
  return m.db.one<ScrobbleRow>(`SELECT s.* FROM ${visibleScrobblesFrom('s', 'u')} WHERE s.uri = ?`, uri);
}
