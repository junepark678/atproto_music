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
import { isRecordKey, parseRecordUri } from '@atmusic/core/syntax';
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

/**
 * Trusted input owned by the future L2 binding leaf. This describes one
 * accepted API love operation and the immutable projection it corresponded
 * to; it is not constructed from current incarnation/import history.
 */
export interface AcceptedApiLoveRecipientEnvelope {
  readonly did: string;
  readonly recordUri: string;
  readonly incarnationKey: string;
  readonly apiOperationId: string;
  readonly projectionRkey: string;
  readonly source: Exclude<Origin, 'import'>;
  /** Captured with API acceptance; current API-love admission supplies an empty list. */
  readonly sourceExclusions: readonly ('lastfm' | 'listenbrainz')[];
  readonly projection: {
    readonly artist: string;
    readonly track: string;
    readonly album?: string;
    readonly recordingMbid?: string;
  };
  readonly authorization: { readonly uri: string; readonly rev: string };
}

export interface ApiRecipientUnloveArgs {
  did: string;
  linkId: string;
  generation: number;
  broadOperationId: string;
  operationId: string;
  envelope: AcceptedApiLoveRecipientEnvelope;
  now: number;
  random: Random;
}

interface ResolvedApiRecipientUnloveArgs extends ApiRecipientUnloveArgs {
  payload: Record<string, unknown>;
  authorization: { uri: string; rev: string };
  source: Exclude<Origin, 'import'>;
  excludeSourceServices: readonly ('lastfm' | 'listenbrainz')[];
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

export const API_RECIPIENT_EXACT_EFFECT_SQL = `SELECT id,did,generation,kind,dedupe_key,state,love_artist_key,love_track_key,payload_json,
       authorization_uri,authorization_rev FROM forward_outbox WHERE link_id=? AND kind=? AND dedupe_key=?`;

const API_RECIPIENT_EFFECT_KINDS: readonly ForwardKind[] = ['unlove', 'love', 'scrobble', 'nowplaying'];

function apiRecipientPayload(envelope: AcceptedApiLoveRecipientEnvelope): Record<string, unknown> {
  return {
    artist: envelope.projection.artist,
    track: envelope.projection.track,
    ...(envelope.projection.album === undefined ? {} : { album: envelope.projection.album }),
    ...(envelope.projection.recordingMbid === undefined ? {} : { recordingMbid: envelope.projection.recordingMbid }),
    origin: envelope.source,
  };
}

function acceptedApiEnvelopeValid(envelope: AcceptedApiLoveRecipientEnvelope, did: string): boolean {
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    envelope.projection === null ||
    typeof envelope.projection !== 'object' ||
    !Array.isArray(envelope.sourceExclusions) ||
    envelope.authorization === null ||
    typeof envelope.authorization !== 'object' ||
    typeof envelope.recordUri !== 'string'
  )
    return false;
  const parsed = parseRecordUri(envelope.recordUri);
  const exclusionSet = new Set(envelope.sourceExclusions);
  const projectionKeys = Object.keys(envelope.projection);
  return (
    envelope.did === did &&
    parsed !== null &&
    parsed.did === did &&
    parsed.rkey === envelope.projectionRkey &&
    envelope.authorization.uri === envelope.recordUri &&
    typeof envelope.incarnationKey === 'string' &&
    envelope.incarnationKey.length > 0 &&
    typeof envelope.apiOperationId === 'string' &&
    envelope.apiOperationId.length > 0 &&
    isRecordKey(envelope.projectionRkey) &&
    typeof envelope.authorization.uri === 'string' &&
    typeof envelope.authorization.rev === 'string' &&
    (envelope.source === 'web' || envelope.source === 'lastfm' || envelope.source === 'listenbrainz') &&
    exclusionSet.size === envelope.sourceExclusions.length &&
    envelope.sourceExclusions.every((service) => service === 'lastfm' || service === 'listenbrainz') &&
    typeof envelope.projection.artist === 'string' &&
    typeof envelope.projection.track === 'string' &&
    (envelope.projection.album === undefined || typeof envelope.projection.album === 'string') &&
    (envelope.projection.recordingMbid === undefined || typeof envelope.projection.recordingMbid === 'string') &&
    projectionKeys.every((key) => ['artist', 'track', 'album', 'recordingMbid'].includes(key))
  );
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
  args: ResolvedApiRecipientUnloveArgs,
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
  const effects = API_RECIPIENT_EFFECT_KINDS.map((kind) =>
    db.one<ApiRecipientEffect>(API_RECIPIENT_EXACT_EFFECT_SQL, link.id, kind, storedKey),
  );
  const wrongKind = effects.slice(1).some((row) => row !== null);
  if (wrongKind) return { status: 'refused', reason: 'identity_collision' };
  const row = effects[0] ?? null;
  if (row !== null) {
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
  if (row?.state === 'queued' || row?.state === 'held') return { status: 'queued' };
  if (row !== null) return { status: 'replay' };

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
    const envelope = args.envelope;
    if (!acceptedApiEnvelopeValid(envelope, args.did))
      return { status: 'refused', reason: 'accepted_envelope_invalid' };
    const authorization = envelope.authorization;
    const payload = apiRecipientPayload(envelope);
    const link = db.one<ApiRecipientLink>(
      `SELECT id,did,generation,service,status,forward_scrobbles FROM linked_accounts WHERE id=? AND did=?`,
      args.linkId,
      args.did,
    );
    if (link === null || !Number.isSafeInteger(args.generation) || args.generation < 1)
      return { status: 'refused', reason: 'link_missing_or_generation_invalid' };
    if (link.generation !== args.generation) return { status: 'refused', reason: 'stale_generation' };

    if (
      !Number.isSafeInteger(args.now) ||
      args.now < 0 ||
      args.operationId !== `${args.broadOperationId}:api-recipient` ||
      args.broadOperationId !== `love-delete:${envelope.incarnationKey}:rev:${authorization.rev}`
    )
      return { status: 'refused', reason: 'recipient_identity_or_payload_invalid' };

    if (envelope.sourceExclusions.includes(link.service)) return { status: 'refused', reason: 'source_excluded' };

    let artistKey: string;
    let trackKeyValue: string;
    try {
      [artistKey, trackKeyValue] = trackKey(envelope.projection.artist, envelope.projection.track);
    } catch (error) {
      if (error instanceof MusicKeyError) return { status: 'refused', reason: 'invalid_track' };
      throw error;
    }
    if (hasPresentTrackLove(db, args.did, artistKey, trackKeyValue))
      return { status: 'refused', reason: 'canonical_survivor' };

    const resolved: ResolvedApiRecipientUnloveArgs = {
      ...args,
      authorization,
      source: envelope.source,
      payload,
      excludeSourceServices: envelope.sourceExclusions,
    };

    const existingWitness = db.one<ApiRecipientWitness>(
      `SELECT kind,love_artist_key,love_track_key,authorization_uri,authorization_rev
       FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=? AND operation_id=?`,
      link.id,
      link.generation,
      args.operationId,
    );
    if (existingWitness !== null) {
      const accepted = ackFromDurableState(db, link, resolved, artistKey, trackKeyValue);
      if (accepted.status === 'refused' && accepted.reason !== 'no_durable_acceptance') {
        countLinkCoverage(db, 'deferred_rebind_rejected');
        return accepted;
      }
      if (accepted.status !== 'refused') {
        const authority = materializeLoveAuthority(db, authorization, args.now);
        if (authority === 'active' && deferredAuthorityValid(db, authorization)) return accepted;
        const missing = authority === 'missing';
        countLinkCoverage(db, missing ? 'deferred_authority_unmaterialized' : 'deferred_authority_conflicted');
        return { status: 'refused', reason: missing ? 'authority_missing' : 'authority_conflicted' };
      }
      return accepted;
    }

    const ownCoverage = forwardCoverage(db, link, 'unlove', args.operationId);
    const oppositeCoverage = forwardCoverage(db, link, 'love', args.operationId);
    const storedKey = storedForwardDedupeKey(link.generation, args.operationId);
    const otherKindCollision = (['scrobble', 'nowplaying'] as const).some(
      (kind) => db.one<ApiRecipientEffect>(API_RECIPIENT_EXACT_EFFECT_SQL, link.id, kind, storedKey) !== null,
    );
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
      otherKindCollision ||
      oppositeCoverage === 'row' ||
      oppositeCoverage === 'retired' ||
      ownCoverage === 'row' ||
      ownCoverage === 'retired'
    ) {
      countLinkCoverage(db, 'deferred_rebind_rejected');
      return { status: 'refused', reason: 'identity_collision' };
    }
    const authority = materializeLoveAuthority(db, authorization, args.now);
    if (authority !== 'active' || !deferredAuthorityValid(db, authorization)) {
      countLinkCoverage(
        db,
        authority === 'missing' ? 'deferred_authority_unmaterialized' : 'deferred_authority_conflicted',
      );
      return { status: 'refused', reason: authority === 'missing' ? 'authority_missing' : 'authority_conflicted' };
    }

    enqueueForwards(db, {
      did: args.did,
      linkId: args.linkId,
      items: [{ kind: 'unlove', operationId: args.operationId, payload, authorization }],
      excludeSourceServices: envelope.sourceExclusions,
      now: args.now,
      random: args.random,
    });
    const result = ackFromDurableState(db, link, resolved, artistKey, trackKeyValue);
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
