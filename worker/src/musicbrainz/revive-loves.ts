import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import type { Db } from '../do/db';
import { deferredAuthorityStatus } from '../forward/love-coverage-authority';
import { noteForwardLoveCurrent, touchLoveLane } from '../forward/love-lanes';
import { indexForwardLoveTarget } from '../forward/love-recording-targets';
import { canonicalForwardDedupeKey, storedForwardDedupeKey } from '../outbox/forward-identity';

const MAX_SCAN = 100;
type Key = { artistKey: string; trackKey: string };
type RevivalWitness = {
  kind: 'love' | 'unlove';
  group_seq: string;
  love_artist_key: string;
  love_track_key: string;
  authorization_uri: string | null;
  authorization_rev: string | null;
};

export const REVIVAL_WITNESS_LOOKUP_SQL = `SELECT kind,CAST(group_seq AS TEXT) AS group_seq,love_artist_key,love_track_key,
       authorization_uri,authorization_rev FROM forward_deferred_love_witnesses
     WHERE link_id=? AND generation=? AND operation_id=?`;
export const REVIVAL_WITNESS_INSERT_SQL = `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,
       love_artist_key,love_track_key,authorization_uri,authorization_rev,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`;

/** Backfill indexed love identity fields on old outbox rows in bounded rowid order. */
export function backfillLoveReviveKeys(db: Db, limit: number): { scanned: number; complete: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN) throw new RangeError('invalid scan limit');
  return db.tx(() => {
    db.run('INSERT OR IGNORE INTO mb_love_revival_state(singleton,cursor_rowid,complete) VALUES(1,0,0)');
    const state = db.one<{ cursor_rowid: number; complete: number }>(
      'SELECT cursor_rowid,complete FROM mb_love_revival_state WHERE singleton=1',
    );
    if (!state || state.complete === 1) return { scanned: 0, complete: true };
    const rows = db.all<{ rowid: number; link_id: string; payload_json: string }>(
      `SELECT rowid,link_id,payload_json FROM forward_outbox WHERE rowid>? AND kind IN ('love','unlove') ORDER BY rowid LIMIT ?`,
      state.cursor_rowid,
      limit,
    );
    for (const row of rows) {
      try {
        const body: unknown = JSON.parse(row.payload_json);
        if (!body || typeof body !== 'object') continue;
        const payload = body as Record<string, unknown>;
        if (typeof payload.artist !== 'string' || typeof payload.track !== 'string') continue;
        const [artistKey, trackKey] = trackKeyFn(payload.artist, payload.track);
        db.run(
          'UPDATE forward_outbox SET love_artist_key=?,love_track_key=?,love_lane=CASE WHEN love_artist_key IS ? AND love_track_key IS ? THEN love_lane ELSE NULL END WHERE rowid=?',
          artistKey,
          trackKey,
          artistKey,
          trackKey,
          row.rowid,
        );
        noteForwardLoveCurrent(db, row.link_id, artistKey, trackKey, row.rowid);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof MusicKeyError)) throw error;
      }
    }
    const cursor = rows.at(-1)?.rowid ?? state.cursor_rowid;
    const complete = rows.length < limit ? 1 : 0;
    db.run('UPDATE mb_love_revival_state SET cursor_rowid=?,complete=? WHERE singleton=1', cursor, complete);
    return { scanned: rows.length, complete: complete === 1 };
  });
}

function trackKeyFn(artist: string, track: string): readonly [string, string] {
  return trackKey(artist, track);
}

/** Scan latest state per LB link generation, bounded by candidates scanned (not rows revived). */
export function enqueueRevivedLoves(
  db: Db,
  key: Key,
  matchedMbid: string,
  now: number,
  limit: number,
  afterLinkId = '',
): { enqueued: number; scanned: number; cursorLinkId: string; complete: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN) throw new RangeError('invalid revival limit');
  const rows = db.all<{
    rowid: number;
    link_id: string;
    did: string;
    kind: 'love' | 'unlove';
    dedupe_key: string;
    payload_json: string;
    state: string;
    last_error: string | null;
    generation: number;
    authorization_uri: string | null;
    authorization_rev: string | null;
    love_artist_key: string | null;
    love_track_key: string | null;
  }>(
    `SELECT f.rowid,f.link_id,f.did,f.kind,f.dedupe_key,f.payload_json,f.state,f.last_error,f.generation,
            f.authorization_uri,f.authorization_rev,f.love_artist_key,f.love_track_key
       FROM mb_forward_love_current c JOIN forward_outbox f ON f.rowid=c.forward_rowid
       JOIN linked_accounts l ON l.id=c.link_id AND l.service='listenbrainz' AND l.generation=f.generation
      WHERE c.love_artist_key=? AND c.love_track_key=? AND c.link_id>? AND f.kind IN ('love','unlove')
      ORDER BY c.link_id LIMIT ?`,
    key.artistKey,
    key.trackKey,
    afterLinkId,
    limit,
  );
  let enqueued = 0;
  let cursorLinkId = afterLinkId;
  for (const row of rows) {
    cursorLinkId = row.link_id;
    if (row.state !== 'ignored' || !['mbid_unresolved', 'no_recording_mbid'].includes(row.last_error ?? '')) continue;
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (!parsed || typeof parsed !== 'object') continue;
      body = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof body.artist !== 'string' || typeof body.track !== 'string') continue;
    let payloadKeys: readonly [string, string];
    try {
      payloadKeys = trackKey(body.artist, body.track);
    } catch (error) {
      if (error instanceof MusicKeyError) continue;
      throw error;
    }
    if (
      row.love_artist_key !== key.artistKey ||
      row.love_track_key !== key.trackKey ||
      payloadKeys[0] !== key.artistKey ||
      payloadKeys[1] !== key.trackKey
    )
      continue;
    const kind = row.kind;
    const payload =
      kind === 'love'
        ? { ...body, recordingMbid: body.recordingMbid || matchedMbid, origin: 'listenbrainz' }
        : { artist: body.artist, track: body.track, recordingMbid: matchedMbid, origin: 'listenbrainz' };
    const childOperationId = `mb-match:${matchedMbid}:${row.link_id}:${key.artistKey}:${key.trackKey}`;
    const dedupe = storedForwardDedupeKey(row.generation, childOperationId);
    const insertedCount = db.tx(() => {
      if (
        kind === 'unlove' &&
        row.authorization_uri !== null &&
        row.authorization_rev !== null &&
        db.one(
          `SELECT 1 FROM live_pending_removal_events WHERE uri=? AND rev=? AND conflicted=1 LIMIT 1`,
          row.authorization_uri,
          row.authorization_rev,
        ) !== null
      )
        return 0;
      const parentOperationId = canonicalForwardDedupeKey(row.generation, row.dedupe_key);
      if (parentOperationId === null) return 0;
      // Ownership gates protect destructive unlove. Love revival keeps its
      // existing semantics even when a synthetic key has an unlove witness.
      const parentWitness =
        kind === 'unlove'
          ? db.one<RevivalWitness>(REVIVAL_WITNESS_LOOKUP_SQL, row.link_id, row.generation, parentOperationId)
          : null;
      if (
        parentWitness !== null &&
        (parentWitness.kind !== 'unlove' ||
          parentWitness.love_artist_key !== key.artistKey ||
          parentWitness.love_track_key !== key.trackKey ||
          parentWitness.authorization_uri !== row.authorization_uri ||
          parentWitness.authorization_rev !== row.authorization_rev)
      )
        return 0;
      const authorization =
        row.authorization_uri === null || row.authorization_rev === null
          ? null
          : { uri: row.authorization_uri, rev: row.authorization_rev };
      const authorityStatus = authorization === null ? 'missing' : deferredAuthorityStatus(db, authorization);
      if (
        authorityStatus === 'conflicted' ||
        (parentWitness !== null && authorization !== null && authorityStatus !== 'active')
      )
        return 0;
      const childWitness =
        kind === 'unlove'
          ? db.one<RevivalWitness>(REVIVAL_WITNESS_LOOKUP_SQL, row.link_id, row.generation, childOperationId)
          : null;
      if (
        childWitness !== null &&
        (childWitness.kind !== kind ||
          childWitness.love_artist_key !== key.artistKey ||
          childWitness.love_track_key !== key.trackKey ||
          childWitness.authorization_uri !== row.authorization_uri ||
          childWitness.authorization_rev !== row.authorization_rev ||
          (authorization !== null && authorityStatus !== 'active'))
      )
        return 0;
      const inserted = db.run(
        `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,generation,love_lane,authorization_uri,authorization_rev)
         VALUES(?,?,?,?,?,?,'queued',0,?,?,?,?,?,?,1,?,?) ON CONFLICT(link_id,kind,dedupe_key) DO NOTHING`,
        crypto.randomUUID().replaceAll('-', '').slice(0, 32),
        row.link_id,
        row.did,
        kind,
        dedupe,
        JSON.stringify(payload),
        now,
        now,
        now,
        key.artistKey,
        key.trackKey,
        row.generation,
        row.authorization_uri,
        row.authorization_rev,
      ).rowsWritten;
      if (inserted === 1) {
        if (parentWitness !== null && childWitness === null) {
          const group = Number(parentWitness.group_seq);
          if (!Number.isSafeInteger(group) || group < 1) throw new RangeError('revival witness group is unsafe');
          if (
            db.run(
              REVIVAL_WITNESS_INSERT_SQL,
              row.link_id,
              row.generation,
              childOperationId,
              group,
              kind,
              key.artistKey,
              key.trackKey,
              row.authorization_uri,
              row.authorization_rev,
              now,
            ).rowsWritten !== 1
          )
            throw new Error('revival witness ownership was not inserted');
        }
        const created = db.one<{ rowid: number }>(
          'SELECT rowid FROM forward_outbox WHERE link_id=? AND kind=? AND dedupe_key=?',
          row.link_id,
          kind,
          dedupe,
        );
        if (created) {
          if (kind === 'love')
            indexForwardLoveTarget(db, {
              rowid: created.rowid,
              linkId: row.link_id,
              generation: row.generation,
              createdAtMs: now,
              payloadJson: JSON.stringify(payload),
            });
          noteForwardLoveCurrent(db, row.link_id, key.artistKey, key.trackKey, created.rowid);
          touchLoveLane(db, {
            linkId: row.link_id,
            generation: row.generation,
            artistKey: key.artistKey,
            trackKey: key.trackKey,
            priority: 0,
            dueAt: now,
            createdAtMs: now,
          });
        }
      }
      return inserted;
    });
    enqueued += insertedCount;
  }
  return { enqueued, scanned: rows.length, cursorLinkId, complete: rows.length < limit };
}
