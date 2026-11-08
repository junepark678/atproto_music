import type { Db } from '../do/db';
import { loveKeyOf } from '../outbox/love-ops';

/** Requeue the current love state for a bounded number of matched track keys. */
export function enqueueRevivedLoves(
  db: Db,
  key: { artistKey: string; trackKey: string },
  matchedMbid: string,
  now: number,
  limit: number,
): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('invalid revival limit');
  const ignored = db.all<{ link_id: string; did: string; payload_json: string; dedupe_key: string }>(
    `SELECT f.link_id,f.did,f.payload_json,f.dedupe_key FROM forward_outbox f
     JOIN linked_accounts l ON l.id=f.link_id AND l.service='listenbrainz'
     WHERE f.state='ignored' AND f.last_error IN ('mbid_unresolved','no_recording_mbid')
     ORDER BY f.created_at_ms DESC,f.rowid DESC`,
  );
  let enqueued = 0;
  let considered = 0;
  const processed = new Set<string>();
  for (const candidate of ignored) {
    let old: Record<string, unknown>;
    try {
      old = JSON.parse(candidate.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof old.artist !== 'string' ||
      typeof old.track !== 'string' ||
      loveKeyOf(old.artist, old.track) !== `${key.artistKey}\u0000${key.trackKey}`
    )
      continue;
    const candidateKey = `${candidate.link_id}\u0000${key.artistKey}\u0000${key.trackKey}`;
    if (processed.has(candidateKey)) continue;
    const rows = db.all<{ id: string; payload_json: string; state: string; last_error: string | null }>(
      `SELECT id,payload_json,state,last_error FROM forward_outbox WHERE link_id=? AND kind IN ('love','unlove') ORDER BY created_at_ms DESC,rowid DESC`,
      candidate.link_id,
    );
    const latest = rows.find((row) => {
      try {
        const body = JSON.parse(row.payload_json) as Record<string, unknown>;
        return (
          typeof body.artist === 'string' &&
          typeof body.track === 'string' &&
          loveKeyOf(body.artist, body.track) === `${key.artistKey}\u0000${key.trackKey}`
        );
      } catch {
        return false;
      }
    });
    if (
      !latest ||
      latest.id !==
        db.one<{ id: string }>(
          'SELECT id FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          candidate.link_id,
          candidate.dedupe_key,
        )?.id ||
      latest.state !== 'ignored' ||
      !['mbid_unresolved', 'no_recording_mbid'].includes(latest.last_error ?? '')
    )
      continue;
    const loveKey = `${key.artistKey}\u0000${key.trackKey}`;
    const operation = db
      .all<{ id: string; kind: string; record_json: string | null }>(
        `SELECT id,kind,record_json FROM operations WHERE did=? AND kind IN ('love.put','love.delete') AND state='succeeded' ORDER BY rowid DESC`,
        candidate.did,
      )
      .find((op) => {
        if (!op.record_json) return false;
        try {
          const body = JSON.parse(op.record_json) as Record<string, unknown>;
          return (
            typeof body.artist === 'string' &&
            typeof body.track === 'string' &&
            loveKeyOf(body.artist, body.track) === loveKey
          );
        } catch {
          return false;
        }
      });
    if (!operation) continue;
    const body = JSON.parse(operation.record_json!) as Record<string, unknown>;
    const kind = operation.kind === 'love.put' ? 'love' : 'unlove';
    const payload =
      kind === 'love'
        ? { ...body, recordingMbid: body.recordingMbid || matchedMbid, origin: 'listenbrainz' }
        : { artist: body.artist, track: body.track, recordingMbid: matchedMbid, origin: 'listenbrainz' };
    const dedupe = `mb-match:${matchedMbid}:${candidate.link_id}:${key.artistKey}:${key.trackKey}`;
    if (
      db.one(
        'SELECT 1 AS found FROM forward_outbox WHERE link_id=? AND kind=? AND dedupe_key=?',
        candidate.link_id,
        kind,
        dedupe,
      )
    )
      continue;
    if (considered >= limit) break;
    processed.add(candidateKey);
    considered++;
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 32);
    enqueued += db.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,'queued',0,?,?,?) ON CONFLICT(link_id,kind,dedupe_key) DO NOTHING`,
      id,
      candidate.link_id,
      candidate.did,
      kind,
      dedupe,
      JSON.stringify(payload),
      now,
      now,
      now,
    ).rowsWritten;
  }
  return enqueued;
}
