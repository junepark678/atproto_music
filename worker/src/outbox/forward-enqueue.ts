// Forward rows for linked accounts (ADR 0005 §12.2; N2-05). N3-08 delivers
// them; this module only queues them, inside the caller's acceptance
// transaction, so forwarding never waits for the PDS write.
//
// Forwarded: scrobbles, now playing and love/unlove received through our
// server (the Last.fm and ListenBrainz APIs and the web form). Never
// forwarded: imports, records other apps wrote, deletes.
//
// One row per active link of the DID whose flag allows the kind:
// `forward_scrobbles` for scrobble, love and unlove, `forward_now_playing`
// for nowplaying. The legacy UNIQUE(link_id,kind,dedupe_key) remains in place;
// generation > 1 stores a generation-prefixed key while the logical key stays
// canonical (ADR §12.2):
//
// | kind               | dedupe_key                                             |
// |--------------------|--------------------------------------------------------|
// | scrobble           | the listen key (§7.7): a client resend never re-forwards|
// | nowplaying         | nowPlayingKey(did, started_at_ms, artist, track)       |
// | love, unlove       | the love.put / love.delete operation id                |
//
// so a same-track now-playing refresh (which keeps `started_at_ms`) gives no
// new row, the same track playing again later does, and love, unlove, love
// gives three rows in order.
//
// nowPlayingKey = lowercase hex SHA-256 over "atmusic:nowplaying-key:v1" ‖
// field(did) ‖ field(started_at_ms, decimal) ‖ field(artist_key) ‖
// field(normalized track), with field(x) = 4-byte big-endian UTF-8 length ‖
// bytes, like the listen key (packages/core/src/listen-key.ts) but over ms
// and under its own domain tag. Synchronous (node:crypto), so it runs inside
// the transaction.
//
// Payloads (payload_json), read by the forward clients (N3-08):
// - scrobble:   {listen: <the accepted input, uncorrected>, origin}
// - nowplaying: {track: <the now-playing fields>, startedAtMs, origin}
// - love/unlove: {artist, track, album?, recordingMbid?, origin}

import { createHash } from 'node:crypto';
import type { Random } from '@atmusic/core/deps';
import { MusicKeyError, trackKey } from '@atmusic/core/music-key';
import { parseRecordUri } from '@atmusic/core/syntax';
import type { ForwardKind, Origin } from '../app/rows';
import type { Db } from '../do/db';
import { countLinkCoverage } from '../forward/coverage';
import { deferredAuthorityValid, materializeLoveAuthority } from '../forward/love-coverage-authority';
import { recordDeferredLoveIntents } from '../forward/love-deferral-storage';
import { noteForwardLoveCurrent, touchLoveLane } from '../forward/love-lanes';
import { indexForwardLoveTarget } from '../forward/love-recording-targets';
import { storedForwardDedupeKey } from './forward-key';
import { dropStaleReceipt, forwardCoverage, noteForwardReceipt } from './forward-receipts';
import { hasPresentTrackLove } from './live-track-survivor';
import { newOperationId } from './operations';

export const NOW_PLAYING_KEY_DOMAIN = 'atmusic:nowplaying-key:v1';

function framed(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** The nowplaying dedupe key (see the header). Throws MusicKeyError for an invalid artist or track. */
export function nowPlayingKey(did: string, startedAtMs: number, artist: string, track: string): string {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new RangeError('startedAtMs must be epoch ms');
  const [a, t] = trackKey(artist, track);
  return createHash('sha256')
    .update(NOW_PLAYING_KEY_DOMAIN, 'utf8')
    .update(framed([did, String(startedAtMs), a, t]))
    .digest('hex');
}

export type ForwardItem =
  | { kind: 'scrobble'; listenKey: string; payload: unknown }
  | { kind: 'nowplaying'; startedAtMs: number; artist: string; track: string; payload: unknown }
  | { kind: 'love' | 'unlove'; operationId: string; payload: unknown; authorization?: { uri: string; rev: string } };

function dedupeKey(did: string, item: ForwardItem): string {
  switch (item.kind) {
    case 'scrobble':
      return item.listenKey;
    case 'nowplaying':
      return nowPlayingKey(did, item.startedAtMs, item.artist, item.track);
    default:
      return item.operationId;
  }
}

function flagColumn(kind: ForwardKind): 'forward_scrobbles' | 'forward_now_playing' {
  return kind === 'nowplaying' ? 'forward_now_playing' : 'forward_scrobbles';
}

export interface EnqueueForwardsArgs {
  did: string;
  items: readonly ForwardItem[];
  /** Excludes the known import source without changing the account's link settings. */
  excludeSourceService?: 'lastfm' | 'listenbrainz';
  /** Excludes every known source bound to one love incarnation. */
  excludeSourceServices?: readonly ('lastfm' | 'listenbrainz')[];
  /** Earliest delivery time (epoch ms); defaults to receipt time. */
  dueAt?: number;
  /** Targets one link when backfill admits historical rows. */
  linkId?: string;
  /** Low-priority historical row; live admissions always use 0. */
  priority?: 0 | 1;
  now: number;
  /** Ids for new rows (the injected randomness). */
  random: Random;
}

export type ApiRecipientUnloveAck =
  | { status: 'queued' }
  | { status: 'deferred' }
  | { status: 'replay' }
  | { status: 'refused'; reason: string };

export interface ApiRecipientUnloveArgs {
  did: string;
  linkId: string;
  generation: number;
  broadOperationId: string;
  operationId: string;
  payload: Record<string, unknown>;
  authorization: { uri: string; rev: string };
  source: Exclude<Origin, 'import'>;
  excludeSourceServices?: readonly ('lastfm' | 'listenbrainz')[];
  now: number;
  random: Random;
}

interface ApiRecipientLink {
  id: string;
  did: string;
  generation: number;
  service: 'lastfm' | 'listenbrainz';
  status: string;
  forward_scrobbles: number;
}

interface ApiRecipientWitness {
  kind: string;
  love_artist_key: string;
  love_track_key: string;
  authorization_uri: string | null;
  authorization_rev: string | null;
}

interface ApiRecipientEffect {
  id: string;
  did: string;
  generation: number;
  kind: string;
  dedupe_key: string;
  state: string;
  love_artist_key: string | null;
  love_track_key: string | null;
  payload_json: string;
  authorization_uri: string | null;
  authorization_rev: string | null;
}

interface ApiRecipientIntent {
  kind: string;
  operation_id: string;
  love_artist_key: string;
  love_track_key: string;
  payload_json: string;
  authorization_uri: string | null;
  authorization_rev: string | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function samePayloadJson(stored: string, expected: unknown): boolean {
  try {
    return stableJson(JSON.parse(stored)) === stableJson(expected ?? null);
  } catch {
    return false;
  }
}

function ackFromDurableState(
  db: Db,
  link: ApiRecipientLink,
  args: ApiRecipientUnloveArgs,
  artistKey: string,
  trackKeyValue: string,
): ApiRecipientUnloveAck {
  const witness = db.one<ApiRecipientWitness>(
    `SELECT kind,love_artist_key,love_track_key,authorization_uri,authorization_rev
     FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? AND operation_id=?`,
    link.id,
    link.generation,
    args.operationId,
  );
  if (
    witness === null ||
    witness.kind !== 'unlove' ||
    witness.love_artist_key !== artistKey ||
    witness.love_track_key !== trackKeyValue ||
    witness.authorization_uri !== args.authorization.uri ||
    witness.authorization_rev !== args.authorization.rev
  )
    return { status: 'refused', reason: 'witness_missing_or_mismatched' };

  const storedKey = storedForwardDedupeKey(link.generation, args.operationId);
  const rows = db.all<ApiRecipientEffect>(
    `SELECT id,did,generation,kind,dedupe_key,state,love_artist_key,love_track_key,payload_json,
       authorization_uri,authorization_rev FROM forward_outbox
     WHERE link_id=? AND dedupe_key=? ORDER BY rowid`,
    link.id,
    storedKey,
  );
  for (const row of rows) {
    if (
      row.did !== args.did ||
      row.generation !== link.generation ||
      row.kind !== 'unlove' ||
      row.dedupe_key !== storedKey ||
      row.love_artist_key !== artistKey ||
      row.love_track_key !== trackKeyValue ||
      row.authorization_uri !== args.authorization.uri ||
      row.authorization_rev !== args.authorization.rev ||
      !samePayloadJson(row.payload_json, args.payload)
    )
      return { status: 'refused', reason: 'effect_mismatch' };
  }
  if (rows.some((row) => row.state === 'queued' || row.state === 'held')) return { status: 'queued' };
  if (rows.length > 0) return { status: 'replay' };

  const intent = db.one<ApiRecipientIntent>(
    `SELECT kind,operation_id,love_artist_key,love_track_key,payload_json,authorization_uri,authorization_rev
     FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND operation_id=?`,
    link.id,
    link.generation,
    args.operationId,
  );
  if (
    intent !== null &&
    intent.kind === 'unlove' &&
    intent.operation_id === args.operationId &&
    intent.love_artist_key === artistKey &&
    intent.love_track_key === trackKeyValue &&
    intent.authorization_uri === args.authorization.uri &&
    intent.authorization_rev === args.authorization.rev &&
    samePayloadJson(intent.payload_json, args.payload)
  )
    return { status: 'deferred' };

  if (forwardCoverage(db, link, 'unlove', args.operationId) === 'retired') return { status: 'replay' };
  return { status: 'refused', reason: 'no_durable_acceptance' };
}

/**
 * Narrow internal handoff for an API-origin love incarnation. Its identity is
 * distinct from the broad live-delete identity and its ack is derived only
 * from exact current-generation B2 state. The ordinary enqueue API is unchanged.
 */
export function enqueueApiRecipientUnlove(db: Db, args: ApiRecipientUnloveArgs): ApiRecipientUnloveAck {
  return db.tx(() => {
    const uri = args.authorization.uri;
    const link = db.one<ApiRecipientLink>(
      `SELECT id,did,generation,service,status,forward_scrobbles FROM linked_accounts WHERE id=? AND did=?`,
      args.linkId,
      args.did,
    );
    if (link === null || !Number.isSafeInteger(args.generation) || args.generation < 1)
      return { status: 'refused', reason: 'link_missing_or_generation_invalid' };
    if (link.generation !== args.generation) return { status: 'refused', reason: 'stale_generation' };

    const [artist, track] = [args.payload.artist, args.payload.track];
    if (
      typeof artist !== 'string' ||
      typeof track !== 'string' ||
      args.payload.origin !== args.source ||
      !Number.isSafeInteger(args.now) ||
      args.now < 0 ||
      args.operationId !== `${args.broadOperationId}:api-recipient` ||
      !args.broadOperationId.startsWith('love-delete:') ||
      !args.broadOperationId.endsWith(`:rev:${args.authorization.rev}`)
    )
      return { status: 'refused', reason: 'recipient_identity_or_payload_invalid' };

    const incarnationKey = args.broadOperationId.slice('love-delete:'.length, -`:rev:${args.authorization.rev}`.length);
    if (incarnationKey.length === 0) return { status: 'refused', reason: 'incarnation_missing' };
    const incarnation = db.one<{ incarnation_key: string; path: string; source_service: string | null }>(
      'SELECT incarnation_key,path,source_service FROM love_incarnations WHERE uri=?',
      uri,
    );
    if (
      incarnation === null ||
      incarnation.incarnation_key !== incarnationKey ||
      incarnation.path !== 'api' ||
      (incarnation.source_service !== null &&
        incarnation.source_service !== 'lastfm' &&
        incarnation.source_service !== 'listenbrainz')
    )
      return { status: 'refused', reason: 'api_incarnation_mismatch' };

    const expectedExclusions = new Set<'lastfm' | 'listenbrainz'>();
    if (incarnation.source_service !== null) expectedExclusions.add(incarnation.source_service);
    const parsedUri = parseRecordUri(uri);
    if (parsedUri === null || parsedUri.did !== args.did) return { status: 'refused', reason: 'record_uri_mismatch' };
    const operationOrigin = db.one<{ origin: Origin }>(
      `SELECT origin FROM operations WHERE did=? AND collection=? AND rkey=? AND kind='love.put'
       ORDER BY created_at_ms DESC,rowid DESC LIMIT 1`,
      args.did,
      parsedUri.collection,
      parsedUri.rkey,
    );
    if (operationOrigin === null || operationOrigin.origin !== args.source)
      return { status: 'refused', reason: 'api_source_mismatch' };
    const bridges = db.all<{ source_service: string | null }>(
      `SELECT source_service FROM love_import_bridges WHERE did=? AND uri=? AND incarnation_key=? AND state IN ('bound','consumed')`,
      args.did,
      uri,
      incarnationKey,
    );
    for (const bridge of bridges) {
      if (bridge.source_service !== 'lastfm' && bridge.source_service !== 'listenbrainz')
        return { status: 'refused', reason: 'unknown_source_exclusion' };
      expectedExclusions.add(bridge.source_service);
    }
    if (args.source === 'lastfm' || args.source === 'listenbrainz') expectedExclusions.add(args.source);
    const suppliedExclusions = new Set(args.excludeSourceServices ?? []);
    if (
      suppliedExclusions.size !== (args.excludeSourceServices ?? []).length ||
      suppliedExclusions.size !== expectedExclusions.size ||
      [...expectedExclusions].some((service) => !suppliedExclusions.has(service))
    )
      return { status: 'refused', reason: 'source_exclusion_mismatch' };
    if (suppliedExclusions.has(link.service)) return { status: 'refused', reason: 'source_excluded' };

    let artistKey: string;
    let trackKeyValue: string;
    try {
      [artistKey, trackKeyValue] = trackKey(artist, track);
    } catch (error) {
      if (error instanceof MusicKeyError) return { status: 'refused', reason: 'invalid_track' };
      throw error;
    }
    if (hasPresentTrackLove(db, args.did, artistKey, trackKeyValue))
      return { status: 'refused', reason: 'canonical_survivor' };

    const existingWitness = db.one<ApiRecipientWitness>(
      `SELECT kind,love_artist_key,love_track_key,authorization_uri,authorization_rev
       FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? AND operation_id=?`,
      link.id,
      link.generation,
      args.operationId,
    );
    if (existingWitness !== null) {
      const accepted = ackFromDurableState(db, link, args, artistKey, trackKeyValue);
      if (accepted.status === 'refused' && accepted.reason !== 'no_durable_acceptance') {
        countLinkCoverage(db, 'deferred_rebind_rejected');
        return accepted;
      }
      if (accepted.status !== 'refused') {
        const authority = materializeLoveAuthority(db, args.authorization, args.now);
        if (authority === 'active' && deferredAuthorityValid(db, args.authorization)) return accepted;
        const missing = authority === 'missing';
        countLinkCoverage(db, missing ? 'deferred_authority_unmaterialized' : 'deferred_authority_conflicted');
        return { status: 'refused', reason: missing ? 'authority_missing' : 'authority_conflicted' };
      }
      return accepted;
    }

    const ownCoverage = forwardCoverage(db, link, 'unlove', args.operationId);
    const oppositeCoverage = forwardCoverage(db, link, 'love', args.operationId);
    const orphanIntent = db.one(
      `SELECT 1 AS present FROM forward_deferred_love_intents WHERE link_id=? AND generation=? AND operation_id=?`,
      link.id,
      link.generation,
      args.operationId,
    );
    const collision = db.one(
      `SELECT 1 AS present FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? AND operation_id=?`,
      link.id,
      link.generation,
      args.operationId,
    );
    if (
      orphanIntent !== null ||
      collision !== null ||
      oppositeCoverage === 'row' ||
      oppositeCoverage === 'retired' ||
      ownCoverage === 'row' ||
      ownCoverage === 'retired'
    ) {
      countLinkCoverage(db, 'deferred_rebind_rejected');
      return { status: 'refused', reason: 'identity_collision' };
    }
    const authority = materializeLoveAuthority(db, args.authorization, args.now);
    if (authority !== 'active' || !deferredAuthorityValid(db, args.authorization)) {
      countLinkCoverage(
        db,
        authority === 'missing' ? 'deferred_authority_unmaterialized' : 'deferred_authority_conflicted',
      );
      return { status: 'refused', reason: authority === 'missing' ? 'authority_missing' : 'authority_conflicted' };
    }

    enqueueForwards(db, {
      did: args.did,
      linkId: args.linkId,
      items: [
        { kind: 'unlove', operationId: args.operationId, payload: args.payload, authorization: args.authorization },
      ],
      excludeSourceServices: args.excludeSourceServices,
      now: args.now,
      random: args.random,
    });
    const result = ackFromDurableState(db, link, args, artistKey, trackKeyValue);
    return result.status === 'refused' && result.reason === 'no_durable_acceptance'
      ? { status: 'refused', reason: 'enqueue_not_accepted' }
      : result;
  });
}

/** Queue a live unlove only with the immutable repository event that authorized it. */
export function enqueueLiveUnlove(
  db: Db,
  args: Omit<EnqueueForwardsArgs, 'items'> & {
    operationId: string;
    payload: unknown;
    authorization: { uri: string; rev: string };
  },
): number {
  return enqueueForwards(db, {
    ...args,
    items: [
      { kind: 'unlove', operationId: args.operationId, payload: args.payload, authorization: args.authorization },
    ],
  });
}

/**
 * Queues one row per (item, active link generation with the matching flag); an existing
 * (link, kind, stored generation key) is left alone. Returns the number of rows created.
 * Runs inside the caller's transaction (or as its own).
 */
export function enqueueForwards(db: Db, args: EnqueueForwardsArgs): number {
  if (args.items.length === 0) return 0;
  const dueAt = args.dueAt ?? args.now;
  if (!Number.isSafeInteger(dueAt) || dueAt < 0) {
    throw new RangeError('dueAt must be a non-negative safe integer of epoch ms');
  }
  return db.tx(() => {
    const items = args.items.filter((item) => {
      if (item.kind !== 'unlove' || item.authorization === undefined) return true;
      const body = item.payload;
      if (body === null || typeof body !== 'object') return true;
      const payload = body as Record<string, unknown>;
      if (typeof payload.artist !== 'string' || typeof payload.track !== 'string') return true;
      try {
        const [artistKey, trackKeyValue] = trackKey(payload.artist, payload.track);
        return !hasPresentTrackLove(db, args.did, artistKey, trackKeyValue);
      } catch (error) {
        if (error instanceof MusicKeyError) return true;
        throw error;
      }
    });
    if (items.length === 0) return 0;
    const eligibleArgs = items.length === args.items.length ? args : { ...args, items };
    recordDeferredLoveIntents(db, eligibleArgs);
    const links = db.all<{
      id: string;
      generation: number;
      service: 'lastfm' | 'listenbrainz';
      forward_scrobbles: number;
      forward_now_playing: number;
    }>(
      `SELECT id,generation,service,forward_scrobbles,forward_now_playing FROM linked_accounts
       WHERE did = ? AND status = 'active'${args.linkId === undefined ? '' : ' AND id=?'} ORDER BY created_at_ms, id`,
      ...(args.linkId === undefined ? [args.did] : [args.did, args.linkId]),
    );
    let created = 0;
    for (const item of items) {
      const key = dedupeKey(args.did, item);
      const payload = JSON.stringify(item.payload ?? null);
      let loveArtistKey: string | null = null;
      let loveTrackKey: string | null = null;
      if (
        (item.kind === 'love' || item.kind === 'unlove') &&
        item.payload !== null &&
        typeof item.payload === 'object'
      ) {
        const body = item.payload as Record<string, unknown>;
        if (typeof body.artist === 'string' && typeof body.track === 'string') {
          try {
            [loveArtistKey, loveTrackKey] = trackKey(body.artist, body.track);
          } catch (error) {
            if (!(error instanceof MusicKeyError)) throw error;
          }
        }
      }
      for (const link of links) {
        if (
          (args.excludeSourceService !== undefined && link.service === args.excludeSourceService) ||
          args.excludeSourceServices?.includes(link.service) === true
        )
          continue;
        if (link[flagColumn(item.kind)] !== 1) continue;
        if (item.kind !== 'nowplaying') {
          const coverage = forwardCoverage(db, link, item.kind, key);
          if (coverage === 'retired') continue;
          if (coverage === 'stale') {
            dropStaleReceipt(db, link, item.kind, key);
            countLinkCoverage(db, 'receipt_stale_released');
          }
        }
        const id = newOperationId(args.random);
        const insertSql =
          args.priority === undefined
            ? `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
               created_at_ms, updated_at_ms, love_artist_key, love_track_key, love_lane,authorization_uri,authorization_rev)
             VALUES (?,?,?,?,?,?,?,'queued',0,?,?,?,?,?,?,?,?)
             ON CONFLICT(link_id,kind,dedupe_key) DO NOTHING`
            : `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
               created_at_ms, updated_at_ms, love_artist_key, love_track_key,priority,love_lane,authorization_uri,authorization_rev)
             VALUES (?,?,?,?,?,?,?,'queued',0,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(link_id,kind,dedupe_key) DO NOTHING`;
        const params = [
          id,
          link.id,
          link.generation,
          args.did,
          item.kind,
          storedForwardDedupeKey(link.generation, key),
          payload,
          dueAt,
          args.now,
          args.now,
          loveArtistKey,
          loveTrackKey,
          ...(args.priority === undefined ? [] : [args.priority]),
          loveArtistKey === null || item.kind === 'scrobble' || item.kind === 'nowplaying' ? null : 1,
          item.kind === 'unlove' ? (item.authorization?.uri ?? null) : null,
          item.kind === 'unlove' ? (item.authorization?.rev ?? null) : null,
        ];
        const inserted = db.run(insertSql, ...params).rowsWritten;
        created += inserted;
        if (item.kind !== 'nowplaying') noteForwardReceipt(db, link, item.kind, key, args.now);
        if (inserted === 1 && loveArtistKey !== null && loveTrackKey !== null) {
          const row = db.one<{ rowid: number }>('SELECT rowid FROM forward_outbox WHERE id=?', id);
          if (row && (item.kind === 'love' || item.kind === 'unlove')) {
            if (item.kind === 'love')
              indexForwardLoveTarget(db, {
                rowid: row.rowid,
                linkId: link.id,
                generation: link.generation,
                createdAtMs: args.now,
                payloadJson: payload,
              });
            noteForwardLoveCurrent(db, link.id, loveArtistKey, loveTrackKey, row.rowid);
            touchLoveLane(db, {
              linkId: link.id,
              generation: link.generation,
              artistKey: loveArtistKey,
              trackKey: loveTrackKey,
              priority: args.priority ?? 0,
              dueAt,
              createdAtMs: args.now,
            });
          }
        }
      }
    }
    return created;
  });
}
