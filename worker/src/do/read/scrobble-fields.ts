import type { Scrobble } from '@atmusic/core/api-types';
import type { ScrobbleRow } from '../contracts';

/** SQL columns needed to preserve the batch container and entry id on public DTOs. */
export const SCROBBLE_PROVENANCE_COLUMNS = 's.record_uri, s.listen_id';

/** Optional public provenance shared by API and export DTO mapping. */
export function scrobbleProvenance(
  row: Pick<ScrobbleRow, 'record_uri' | 'listen_id'>,
): Pick<Scrobble, 'recordUri' | 'listenId'> {
  return {
    ...(row.record_uri ? { recordUri: row.record_uri } : {}),
    ...(row.listen_id ? { listenId: row.listen_id } : {}),
  };
}
