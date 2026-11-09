import type { Db } from '../do/db';

/** Latest explicit API love decision for this normalized canonical key. */
export function latestExplicitLoveIntent(
  db: Db,
  did: string,
  artistKey: string,
  trackKey: string,
): string | null {
  return (
    db.one<{ intent: string }>(
      'SELECT intent FROM linked_love_intents WHERE did=? AND love_key=?',
      did,
      `${artistKey}\0${trackKey}`,
    )?.intent ?? null
  );
}
