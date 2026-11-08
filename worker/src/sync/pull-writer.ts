// Bounded local acceptance of durable linked-service pull staging.
// This deliberately stops before any upstream polling: accepted records enter
// the ordinary origin=import outbox and are sent by the existing outbox lane.

import { buildLoveRecord } from '@atmusic/core/love';
import { trackKey } from '@atmusic/core/music-key';
import { newTid } from '@atmusic/core/record-key';
import type { ScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import { NS_PER_SECOND, parseRfc3339 } from '@atmusic/core/timestamp';
import type { ModuleDeps } from '../do/contracts';
import { admitForwardIdentity } from '../forward/projection';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { loveKeyOf } from '../outbox/love-ops';
import {
  IMPORT_PRIORITY,
  insertOperation,
  newOperationId,
  outboxCollections,
  type Prepared,
  prepare,
  recordOf,
  unsettledOfKinds,
} from '../outbox/operations';
import { insertScrobbleCreate, prepareScrobble } from '../outbox/scrobble-ops';
import { isListenTombstoned, isLoveTombstoned } from './tombstones';

export type PullHoldReason =
  | 'session_missing'
  | 'reauth_required'
  | 'publication_disabled'
  | 'scope_insufficient'
  | 'session_restore_transient';
export type PullWriterAvailability = { available: true } | { available: false; reason: PullHoldReason };
export type PullWriterAvailabilitySource = (did: string) => Promise<PullWriterAvailability>;
export const PULL_WRITE_SLICE = 100;

type Staged = {
  item_key: string;
  kind: 'listen' | 'love';
  source_service: string;
  source_account: string;
  listened_at_ms: number | null;
  love_key: string | null;
  recording_mbid: string | null;
  payload_json: string;
  payload_bytes: number;
  staged_at_ms: number;
};
type Link = {
  did: string;
  generation: number;
  status: string;
  pull_enabled: number;
  service: string;
  remote_user: string;
};

function linkSnapshot(db: ModuleDeps['db'], linkId: string): Link | null {
  return db.one<Link>(
    'SELECT did,generation,status,pull_enabled,service,remote_user FROM linked_accounts WHERE id=?',
    linkId,
  );
}

function stillCurrent(
  m: ModuleDeps,
  linkId: string,
  generation: number,
  did: string,
  service: string,
  account: string,
): boolean {
  const link = linkSnapshot(m.db, linkId);
  const state = m.db.one<{ source_service: string; source_account: string }>(
    'SELECT source_service,source_account FROM linked_pull_state WHERE link_id=? AND generation=?',
    linkId,
    generation,
  );
  return (
    !!link &&
    link.did === did &&
    link.generation === generation &&
    link.status === 'active' &&
    link.pull_enabled === 1 &&
    link.service === service &&
    link.remote_user === account &&
    !!state &&
    state.source_service === service &&
    state.source_account === account
  );
}

function setHold(m: ModuleDeps, linkId: string, generation: number, reason: PullHoldReason | null, now: number): void {
  m.db.run(
    'UPDATE linked_pull_state SET hold_reason=?,updated_at_ms=? WHERE link_id=? AND generation=?',
    reason,
    now,
    linkId,
    generation,
  );
}

function loveWasUnloved(db: ModuleDeps['db'], did: string, key: string): boolean {
  const intent = db.one<{ intent: string }>(
    'SELECT intent FROM linked_love_intents WHERE did=? AND love_key=?',
    did,
    key,
  );
  return intent?.intent === 'unlove';
}

function hasLocalLoveIntent(db: ModuleDeps['db'], did: string, key: string): boolean {
  return (
    db.one("SELECT 1 AS hit FROM linked_love_intents WHERE did=? AND love_key=? AND intent='love'", did, key) !== null
  );
}

/** Process at most one bounded slice. A durable hold leaves every staged item intact. */
export async function writePullSlice(
  m: ModuleDeps,
  args: { linkId: string; generation: number; available: PullWriterAvailabilitySource; limit?: number },
): Promise<{ accepted: number; duplicate: number; tombstoned: number; invalid: number; held: PullHoldReason | null }> {
  const now = m.clock.nowMs();
  const link = linkSnapshot(m.db, args.linkId);
  if (!link || link.generation !== args.generation || link.status !== 'active' || link.pull_enabled !== 1)
    return { accepted: 0, duplicate: 0, tombstoned: 0, invalid: 0, held: null };
  const state = m.db.one<{ source_service: string; source_account: string }>(
    'SELECT source_service,source_account FROM linked_pull_state WHERE link_id=? AND generation=?',
    args.linkId,
    args.generation,
  );
  if (!state || state.source_service !== link.service || state.source_account !== link.remote_user)
    return { accepted: 0, duplicate: 0, tombstoned: 0, invalid: 0, held: null };
  const availability = await args.available(link.did);
  if (!availability.available) {
    setHold(m, args.linkId, args.generation, availability.reason, now);
    return { accepted: 0, duplicate: 0, tombstoned: 0, invalid: 0, held: availability.reason };
  }
  const rows = m.db.all<Staged>(
    'SELECT item_key,kind,source_service,source_account,listened_at_ms,love_key,recording_mbid,payload_json,payload_bytes,staged_at_ms FROM linked_pull_items WHERE link_id=? AND generation=? ORDER BY staged_at_ms,item_key LIMIT ?',
    args.linkId,
    args.generation,
    Math.max(1, Math.min(args.limit ?? PULL_WRITE_SLICE, PULL_WRITE_SLICE)),
  );
  const prefix = m.config.prefix;
  if (prefix === null || rows.length === 0) {
    setHold(m, args.linkId, args.generation, null, now);
    return { accepted: 0, duplicate: 0, tombstoned: 0, invalid: 0, held: null };
  }
  const plans: Array<{
    row: Staged;
    prepared?: Prepared<object>;
    batchPrepared?: Prepared<object>;
    batchRkey?: string;
    loveKey?: string;
    second?: number;
    artistKey?: string;
    trackKey?: string;
    forward?: Record<string, unknown>;
    invalid?: boolean;
  }> = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      plans.push({ row, invalid: true });
      continue;
    }
    if (row.kind === 'listen') {
      const built = await prepareScrobble(payload, prefix, now);
      const second = built.ok ? parseRfc3339(built.prepared.record.listenedAt) : null;
      if (!built.ok || second === null) {
        plans.push({ row, invalid: true });
        continue;
      }
      const [artistKey, trackKeyValue] = trackKey(built.prepared.record.artist, built.prepared.record.track);
      plans.push({
        row,
        prepared: built.prepared,
        ...(m.config.batchPublication
          ? {
              batchPrepared: await prepare({
                $type: outboxCollections(prefix).scrobbleBatch,
                createdAt: built.prepared.record.createdAt,
                listens: [
                  {
                    id: newTid(m.clock, m.random),
                    ...Object.fromEntries(Object.entries(built.prepared.record).filter(([key]) => key !== '$type')),
                  },
                ],
              } as ScrobbleBatchRecord),
              batchRkey: newTid(m.clock, m.random),
            }
          : {}),
        second: Number(second / NS_PER_SECOND),
        artistKey,
        trackKey: trackKeyValue,
        forward: {
          artist: built.prepared.record.artist,
          track: built.prepared.record.track,
          listenedAt: built.prepared.record.listenedAt,
          ...(typeof built.prepared.record.album === 'string' ? { album: built.prepared.record.album } : {}),
          ...(typeof built.prepared.record.recordingMbid === 'string'
            ? { recordingMbid: built.prepared.record.recordingMbid }
            : {}),
        },
      });
    } else {
      const value = payload as { artist?: unknown; track?: unknown; recordingMbid?: unknown };
      if (typeof value?.artist !== 'string' || typeof value?.track !== 'string') {
        plans.push({ row, invalid: true });
        continue;
      }
      const built = buildLoveRecord(
        {
          artist: value.artist,
          track: value.track,
          ...(typeof value.recordingMbid === 'string' ? { recordingMbid: value.recordingMbid } : {}),
        },
        prefix,
        { nowMs: () => now },
      );
      const key = loveKeyOf(value.artist, value.track);
      if (!built.ok || !key) {
        plans.push({ row, invalid: true });
        continue;
      }
      plans.push({ row, prepared: await prepare(built.record), loveKey: key });
    }
  }
  const report = { accepted: 0, duplicate: 0, tombstoned: 0, invalid: 0, held: null as PullHoldReason | null };
  m.db.tx(() => {
    if (!stillCurrent(m, args.linkId, args.generation, link.did, link.service, link.remote_user)) return;
    for (const plan of plans) {
      const current = m.db.one<Staged>(
        'SELECT item_key,kind,source_service,source_account,listened_at_ms,love_key,recording_mbid,payload_json,payload_bytes,staged_at_ms FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
        args.linkId,
        args.generation,
        plan.row.item_key,
      );
      if (
        !current ||
        current.payload_json !== plan.row.payload_json ||
        current.payload_bytes !== plan.row.payload_bytes
      )
        continue;
      if (current.source_service !== link.service || current.source_account !== link.remote_user) continue;
      if (plan.invalid) {
        m.db.run(
          'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
          args.linkId,
          args.generation,
          plan.row.item_key,
        );
        report.invalid++;
        continue;
      }
      if (current.kind === 'listen') {
        const second = plan.second!;
        if (isListenTombstoned(m.db, link.did, second, plan.artistKey, plan.trackKey)) {
          m.db.run(
            'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
            args.linkId,
            args.generation,
            plan.row.item_key,
          );
          report.tombstoned++;
          continue;
        }
        const indexed = m.db.one(
          "SELECT 1 FROM scrobbles WHERE did=? AND substr(listened_at,1,19)=strftime('%Y-%m-%dT%H:%M:%S',?,'unixepoch') LIMIT 1",
          link.did,
          second,
        );
        const accepted = m.db.one(
          'SELECT 1 FROM listen_keys WHERE did=? AND listen_second=? LIMIT 1',
          link.did,
          second,
        );
        if (indexed || accepted) {
          m.db.run(
            'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
            args.linkId,
            args.generation,
            plan.row.item_key,
          );
          report.duplicate++;
          continue;
        }
        const key = `linked-pull:${args.linkId}:${args.generation}:${current.item_key}`;
        const opid = newOperationId(m.random);
        m.db.run(
          "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms,listen_second) VALUES(?,?,?,'import',?,?)",
          link.did,
          key,
          opid,
          now,
          second,
        );
        const first = admitForwardIdentity(m.db, {
          did: link.did,
          identityKey: key,
          path: 'import',
          sourceService: current.source_service as 'lastfm' | 'listenbrainz',
          now,
        });
        if (plan.batchPrepared && plan.batchRkey) {
          insertOperation(
            m.db,
            {
              id: opid,
              did: link.did,
              kind: 'scrobble.create',
              origin: 'import',
              priority: IMPORT_PRIORITY,
              collection: outboxCollections(prefix).scrobbleBatch,
              rkey: plan.batchRkey,
              prepared: plan.batchPrepared,
              dueAt: now,
            },
            now,
          );
        } else {
          insertScrobbleCreate(
            m,
            { id: opid, did: link.did, origin: 'import', prepared: plan.prepared!, dueAt: now },
            now,
          );
        }
        if (first)
          enqueueForwards(m.db, {
            did: link.did,
            items: [{ kind: 'scrobble', listenKey: key, payload: { listen: plan.forward!, origin: 'import' } }],
            excludeSourceService: current.source_service as 'lastfm' | 'listenbrainz',
            now,
            random: m.random,
          });
      } else {
        const key = plan.loveKey!;
        if (isLoveTombstoned(m.db, link.did, key, current.recording_mbid) || loveWasUnloved(m.db, link.did, key)) {
          m.db.run(
            'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
            args.linkId,
            args.generation,
            plan.row.item_key,
          );
          report.tombstoned++;
          continue;
        }
        if (hasLocalLoveIntent(m.db, link.did, key)) {
          m.db.run(
            'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
            args.linkId,
            args.generation,
            plan.row.item_key,
          );
          report.duplicate++;
          continue;
        }
        const rec = JSON.parse(current.payload_json) as { artist: string; track: string; recordingMbid?: string };
        const [artistKey, trackKeyValue] = trackKey(rec.artist, rec.track);
        const duplicate =
          m.db.one(
            'SELECT 1 FROM loves WHERE did=? AND ((artist_key=? AND track_key=?) OR (? IS NOT NULL AND recording_mbid=?)) LIMIT 1',
            link.did,
            artistKey,
            trackKeyValue,
            current.recording_mbid,
            current.recording_mbid,
          ) ||
          m.db.one(
            "SELECT 1 FROM operations WHERE did=? AND kind IN ('love.put','love.delete') AND state IN ('queued','blocked','running','uncertain') AND ((json_extract(record_json,'$.artist')=? AND json_extract(record_json,'$.track')=?) OR (? IS NOT NULL AND json_extract(record_json,'$.recordingMbid')=?)) LIMIT 1",
            link.did,
            rec.artist,
            rec.track,
            current.recording_mbid,
            current.recording_mbid,
          );
        if (duplicate) {
          m.db.run(
            'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
            args.linkId,
            args.generation,
            plan.row.item_key,
          );
          report.duplicate++;
          continue;
        }
        const predecessors = unsettledOfKinds(m.db, link.did, ['love.put', 'love.delete'])
          .filter((op) => {
            const r = recordOf(op);
            return r && loveKeyOf(r.artist, r.track) === key;
          })
          .map((op) => op.id);
        const id = newOperationId(m.random);
        const op = insertOperation(
          m.db,
          {
            id,
            did: link.did,
            kind: 'love.put',
            origin: 'import',
            priority: IMPORT_PRIORITY,
            collection: outboxCollections(prefix).love,
            rkey: newTid(m.clock, m.random),
            prepared: plan.prepared!,
            dueAt: now,
            predecessors,
          },
          now,
        );
        const identityKey = `love-uri:${link.did}:${op.collection}:${op.rkey}`;
        const first = admitForwardIdentity(m.db, {
          did: link.did,
          identityKey,
          path: 'import',
          sourceService: current.source_service as 'lastfm' | 'listenbrainz',
          now,
        });
        const { $type: _type, createdAt: _createdAt, ...body } = plan.prepared! as unknown as Record<string, unknown>;
        if (first)
          enqueueForwards(m.db, {
            did: link.did,
            items: [{ kind: 'love', operationId: id, payload: { ...body, origin: 'import' } }],
            excludeSourceService: current.source_service as 'lastfm' | 'listenbrainz',
            now,
            random: m.random,
          });
      }
      m.db.run(
        'DELETE FROM linked_pull_items WHERE link_id=? AND generation=? AND item_key=?',
        args.linkId,
        args.generation,
        plan.row.item_key,
      );
      report.accepted++;
    }
    setHold(m, args.linkId, args.generation, null, now);
  });
  return report;
}
