import { trackKey } from '@atmusic/core/music-key';
import type { ForwardKind } from '../app/rows';
import type { Db } from '../do/db';
import type { EnqueueForwardsArgs, ForwardItem } from '../outbox/forward-enqueue';
import { forwardCoverage, type LinkGeneration } from '../outbox/forward-receipts';
import { countLinkCoverage } from './coverage';
import {
  conflictDeferredLoveAuthority,
  deferredAuthorityValid,
  materializeLoveAuthority,
} from './love-coverage-authority';
import { remoteLoveState } from './love-delivery';
import { classifyDeferredOrigin } from './love-intent-policy';

type Link = LinkGeneration & {
  service: 'lastfm' | 'listenbrainz';
  status: string;
  forward_scrobbles: number;
};
type LoveItem = Extract<ForwardItem, { kind: 'love' | 'unlove' }>;

function safeSeq(text: string | undefined, label: string, min = 1): number {
  if (text === undefined) throw new Error(`deferred love ${label} is missing`);
  const value = BigInt(text);
  if (value < BigInt(min) || value >= BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`deferred love ${label} exhausted`);
  return Number(value);
}

export function allocateDeferredSequence(db: Db, column: 'next_head_seq' | 'next_group_seq'): number {
  db.run('INSERT OR IGNORE INTO forward_deferred_love_maintenance(singleton) VALUES(1)');
  const seq = safeSeq(
    db.one<{ value: string }>(
      `SELECT CAST(${column} AS TEXT) AS value FROM forward_deferred_love_maintenance WHERE singleton=1`,
    )?.value,
    column,
  );
  if (
    db.run(`UPDATE forward_deferred_love_maintenance SET ${column}=? WHERE singleton=1 AND ${column}=?`, seq + 1, seq)
      .rowsWritten !== 1
  )
    throw new Error(`deferred love ${column} changed`);
  return seq;
}

function readTrack(item: LoveItem): { artistKey: string; trackKey: string; origin: string | null } | null {
  if (item.payload === null || typeof item.payload !== 'object') return null;
  const body = item.payload as Record<string, unknown>;
  if (typeof body.artist !== 'string' || typeof body.track !== 'string') return null;
  try {
    const [artistKey, trackKeyValue] = trackKey(body.artist, body.track);
    return { artistKey, trackKey: trackKeyValue, origin: typeof body.origin === 'string' ? body.origin : null };
  } catch {
    return null;
  }
}

function excluded(
  link: Link,
  args: Pick<EnqueueForwardsArgs, 'excludeSourceService' | 'excludeSourceServices'>,
): boolean {
  return args.excludeSourceService === link.service || args.excludeSourceServices?.includes(link.service) === true;
}

function cancelled(db: Db, operationId: string): boolean {
  return db.one<{ state: string }>('SELECT state FROM operations WHERE id=?', operationId)?.state === 'cancelled';
}

function witnessGroup(db: Db, link: Link): number {
  const existing = db.one<{ group_seq: string }>(
    'SELECT CAST(group_seq AS TEXT) AS group_seq FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? LIMIT 1',
    link.id,
    link.generation,
  );
  return existing === null
    ? allocateDeferredSequence(db, 'next_group_seq')
    : safeSeq(existing.group_seq, 'group sequence');
}

function ensureWitness(
  db: Db,
  link: Link,
  item: LoveItem,
  artistKey: string,
  trackKeyValue: string,
  now: number,
): 'new' | 'replay' | 'reject' {
  const authorization = item.kind === 'unlove' ? item.authorization : undefined;
  const current = db.one<{
    kind: string;
    love_artist_key: string;
    love_track_key: string;
    authorization_uri: string | null;
    authorization_rev: string | null;
  }>(
    `SELECT kind,love_artist_key,love_track_key,authorization_uri,authorization_rev
     FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? AND operation_id=?`,
    link.id,
    link.generation,
    item.operationId,
  );
  if (current !== null) {
    const same =
      current.kind === item.kind &&
      current.love_artist_key === artistKey &&
      current.love_track_key === trackKeyValue &&
      current.authorization_uri === (authorization?.uri ?? null) &&
      current.authorization_rev === (authorization?.rev ?? null);
    if (!same) countLinkCoverage(db, 'deferred_rebind_rejected');
    return same ? 'replay' : 'reject';
  }

  const own = forwardCoverage(db, link, item.kind, item.operationId);
  const opposite = forwardCoverage(db, link, item.kind === 'love' ? 'unlove' : 'love', item.operationId);
  if (opposite === 'row' || opposite === 'retired') {
    countLinkCoverage(db, 'deferred_rebind_rejected');
    return 'reject';
  }
  if (own === 'row' || own === 'retired' || cancelled(db, item.operationId)) return 'reject';
  db.run(
    `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
       love_track_key,authorization_uri,authorization_rev,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    link.id,
    link.generation,
    item.operationId,
    witnessGroup(db, link),
    item.kind,
    artistKey,
    trackKeyValue,
    authorization?.uri ?? null,
    authorization?.rev ?? null,
    now,
  );
  return 'new';
}

function existingHead(
  db: Db,
  link: Link,
  artistKey: string,
  trackKeyValue: string,
): { head_seq: number; next_seq: string; live_from_seq: number; armed_seq: number | null } | null {
  const row = db.one<{
    head_seq: string;
    next_seq: string;
    live_from_seq: string;
    armed_seq: string | null;
  }>(
    `SELECT CAST(head_seq AS TEXT) AS head_seq,CAST(next_seq AS TEXT) AS next_seq,CAST(live_from_seq AS TEXT) AS live_from_seq,
       CAST(armed_seq AS TEXT) AS armed_seq FROM forward_deferred_love_heads
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    link.id,
    link.generation,
    artistKey,
    trackKeyValue,
  );
  return row === null
    ? null
    : {
        head_seq: safeSeq(row.head_seq, 'head sequence'),
        next_seq: row.next_seq,
        live_from_seq: safeSeq(row.live_from_seq, 'live floor'),
        armed_seq: row.armed_seq === null ? null : safeSeq(row.armed_seq, 'armed sequence'),
      };
}

export function armLoveCoverage(db: Db, link: LinkGeneration, artistKey: string, trackKeyValue: string): boolean {
  const currentHead = db.one<{ armed_seq: string | null }>(
    `SELECT CAST(armed_seq AS TEXT) AS armed_seq FROM forward_deferred_love_heads
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    link.id,
    link.generation,
    artistKey,
    trackKeyValue,
  );
  if (currentHead === null) return false;
  const resumable = db.one<{ revision: string }>(
    `SELECT CAST(l.backfill_run_revision AS TEXT) AS revision FROM linked_accounts l
     JOIN forward_deferred_love_heads h ON h.link_id=l.id AND h.generation=l.generation
     WHERE l.id=? AND l.generation=? AND l.status='active' AND l.forward_scrobbles=1 AND l.backfill_state='done'
       AND h.love_artist_key=? AND h.love_track_key=?`,
    link.id,
    link.generation,
    artistKey,
    trackKeyValue,
  );
  const revision = resumable === null ? null : safeSeq(resumable.revision, 'backfill run revision', 0) + 1;
  const queuedSeq = currentHead.armed_seq === null ? allocateDeferredSequence(db, 'next_head_seq') : null;
  const armed = db.run(
    `UPDATE forward_deferred_love_heads SET armed_seq=coalesce(armed_seq,?)
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
    queuedSeq,
    link.id,
    link.generation,
    artistKey,
    trackKeyValue,
  ).rowsWritten;
  if (armed === 0) return false;
  if (revision !== null)
    db.run(
      `UPDATE linked_accounts SET backfill_state='running',backfill_next_attempt_ms=NULL,backfill_run_revision=?
     WHERE id=? AND generation=? AND status='active' AND forward_scrobbles=1 AND backfill_state='done'`,
      revision,
      link.id,
      link.generation,
    );
  return true;
}

function addIntent(
  db: Db,
  link: Link,
  item: LoveItem,
  track: NonNullable<ReturnType<typeof readTrack>>,
  now: number,
): boolean {
  const authorization = item.kind === 'unlove' ? item.authorization : undefined;
  const originClass = classifyDeferredOrigin(db, item.kind, item.operationId, authorization !== undefined);
  if (originClass === 'authorized') {
    if (!deferredAuthorityValid(db, authorization!)) return false;
  }

  let head = existingHead(db, link, track.artistKey, track.trackKey);
  if (head === null) {
    const headSeq = allocateDeferredSequence(db, 'next_head_seq');
    db.run(
      `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,created_at_ms)
       VALUES(?,?,?,?,?,?)`,
      link.id,
      link.generation,
      track.artistKey,
      track.trackKey,
      headSeq,
      now,
    );
    head = existingHead(db, link, track.artistKey, track.trackKey);
  }
  if (head === null) throw new Error('deferred love head insert missing');
  const seq = safeSeq(head.next_seq, 'intent sequence');
  const payloadJson = JSON.stringify(item.payload ?? null);
  db.run(
    `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,
       operation_id,origin_class,payload_json,authorization_uri,authorization_rev,intent_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    link.id,
    link.generation,
    track.artistKey,
    track.trackKey,
    seq,
    item.kind,
    item.operationId,
    originClass,
    payloadJson,
    authorization?.uri ?? null,
    authorization?.rev ?? null,
    now,
  );
  const shouldArm = link.status !== 'active' || link.forward_scrobbles !== 1;
  const queueSeq = shouldArm && head.armed_seq === null ? allocateDeferredSequence(db, 'next_head_seq') : null;
  db.run(
    `UPDATE forward_deferred_love_heads SET next_seq=?,
       armed_seq=CASE WHEN ? THEN coalesce(armed_seq,?) ELSE armed_seq END,
       maintenance_seq=CASE WHEN ? THEN coalesce(maintenance_seq,head_seq) ELSE maintenance_seq END
     WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? AND next_seq=?`,
    seq + 1,
    shouldArm ? 1 : 0,
    queueSeq,
    originClass === 'live_love' ? 1 : 0,
    link.id,
    link.generation,
    track.artistKey,
    track.trackKey,
    seq,
  );
  countLinkCoverage(db, item.kind === 'love' ? 'deferred_love_recorded' : 'deferred_unlove_recorded');
  return true;
}

/** Writes ordered deferred intents/witnesses in the producer's existing acceptance transaction. */
export function recordDeferredLoveIntents(
  db: Db,
  args: Pick<
    EnqueueForwardsArgs,
    'did' | 'items' | 'linkId' | 'priority' | 'excludeSourceService' | 'excludeSourceServices' | 'now'
  >,
): void {
  if (args.priority === 1) return;
  const items = args.items.filter((item): item is LoveItem => item.kind === 'love' || item.kind === 'unlove');
  if (items.length === 0) return;
  const links = db.all<Link>(
    `SELECT id,generation,service,status,forward_scrobbles FROM linked_accounts WHERE did=?${args.linkId === undefined ? '' : ' AND id=?'} ORDER BY id`,
    ...(args.linkId === undefined ? [args.did] : [args.did, args.linkId]),
  );
  for (const item of items) {
    const track = readTrack(item);
    if (track === null || (item.kind === 'love' && track.origin === 'import')) continue;
    for (const link of links) {
      if (excluded(link, args)) continue;
      const head = existingHead(db, link, track.artistKey, track.trackKey);
      const enqueueing = link.status === 'active' && link.forward_scrobbles === 1;
      const authorization = item.kind === 'unlove' ? item.authorization : undefined;
      let authorityUsable = true;
      if (authorization !== undefined) {
        const authority = materializeLoveAuthority(db, authorization, args.now);
        authorityUsable = authority === 'active' && deferredAuthorityValid(db, authorization);
        if (authority === 'missing') countLinkCoverage(db, 'deferred_authority_unmaterialized');
      }
      if (item.kind === 'love' && enqueueing && head === null) continue;
      if (ensureWitness(db, link, item, track.artistKey, track.trackKey, args.now) !== 'new') continue;
      if (item.kind === 'unlove' && enqueueing && head === null) continue;
      if (!authorityUsable) continue;
      addIntent(db, link, item, track, args.now);
    }
  }
}

export function withdrawDeferredLoveIntents(
  db: Db,
  link: LinkGeneration,
  kinds: readonly ForwardKind[],
  operationId: string,
): void {
  if (!kinds.includes('love') && !kinds.includes('unlove')) return;
  const rows = db.all<{ generation: number; love_artist_key: string; love_track_key: string; intent_seq: string }>(
    `DELETE FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND operation_id=?
     RETURNING generation,love_artist_key,love_track_key,CAST(intent_seq AS TEXT) AS intent_seq`,
    link.id,
    link.generation,
    operationId,
  );
  for (const row of rows) {
    const head = db.one<{ head_seq: string; live_from_seq: string }>(
      `SELECT CAST(head_seq AS TEXT) AS head_seq,CAST(live_from_seq AS TEXT) AS live_from_seq FROM forward_deferred_love_heads
       WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
      link.id,
      link.generation,
      row.love_artist_key,
      row.love_track_key,
    );
    if (head === null) continue;
    const intentSeq = safeSeq(row.intent_seq, 'withdrawn intent sequence');
    const liveFloor = safeSeq(head.live_from_seq, 'live floor');
    if (
      db.one(
        'SELECT 1 AS present FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=? LIMIT 1',
        link.id,
        link.generation,
        row.love_artist_key,
        row.love_track_key,
      ) === null
    ) {
      db.run(
        'DELETE FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?',
        link.id,
        link.generation,
        row.love_artist_key,
        row.love_track_key,
      );
      continue;
    }
    if (intentSeq >= liveFloor) {
      armLoveCoverage(db, link, row.love_artist_key, row.love_track_key);
      db.run(
        `UPDATE forward_deferred_love_heads SET maintenance_seq=coalesce(maintenance_seq,head_seq)
         WHERE link_id=? AND generation=? AND love_artist_key=? AND love_track_key=?`,
        link.id,
        link.generation,
        row.love_artist_key,
        row.love_track_key,
      );
    }
  }
  if (rows.length > 0) countLinkCoverage(db, 'deferred_withdrawn', rows.length);
}

export function hasArmedLoveCoverage(db: Db, link: LinkGeneration): boolean {
  return (
    db.one(
      'SELECT 1 AS present FROM forward_deferred_love_heads WHERE link_id=? AND generation=? AND armed_seq IS NOT NULL LIMIT 1',
      link.id,
      link.generation,
    ) !== null
  );
}

export function validDeferredAuthorization(db: Db, uri: string, rev: string): boolean {
  return deferredAuthorityValid(db, { uri, rev });
}

export function invalidateDeferredLoveIntents(db: Db, uri: string, rev: string): number {
  const changed = conflictDeferredLoveAuthority(db, uri, rev);
  if (changed) countLinkCoverage(db, 'deferred_authority_conflicted');
  return changed ? 1 : 0;
}

export function remoteLoveForDeferred(
  db: Db,
  link: LinkGeneration,
  artistKey: string,
  trackKeyValue: string,
): 'love' | 'unlove' | 'none' {
  return remoteLoveState(db, link, artistKey, trackKeyValue);
}
