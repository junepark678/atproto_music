// Last.fm 2.0 write methods (ADR 0005 §7.5, §7.7, §7.8, §12.2; N3-03):
// track.scrobble, track.updateNowPlaying, track.love, track.unlove and
// library.removeScrobble. Every one is POST-only and signed (the runner in
// auth-methods.ts applies both), then, in this order:
//   1. the publication gate: closed (meta without `publication`) → 11
//      "Service Offline" (§5.7, §7.7);
//   2. the session key: missing, malformed, unknown or revoked `sk` → 9;
//   3. 120 calls per minute per session (§13) → 29 with Retry-After.
// An account in `reauth_required` still accepts: its operations wait as
// `blocked` (outbox/operations.ts).
//
// **track.scrobble** (§7.7). Entries are `field[i]` with i in 0–49 or one
// unindexed set; mixing, an index ≥ 50, more than 50 entries, or a missing
// artist, track or timestamp in any entry is 6 and nothing is stored. Each
// entry is mapped with `mapLastfmScrobble` (invalid optional fields are
// dropped) and then ignored with Last.fm's numbering, the request still
// answering status ok:
//   1 artist invalid; 2 track invalid; 3 timestamp before 1033430400
//   (2002-10-01) or not a number; 4 timestamp after receipt + 300 s; 5 over
//   the account's daily_listen_cap (rolling 24 h).
// The rest go through the shared `acceptListens` (outbox/ingress.ts) in one
// transaction: listen key (a resend is accepted again with no new
// operation), `scrobble.create` (origin lastfm, live priority) and the
// forward rows of every active link; the answer is sent after the commit and
// the outbox is kicked. Every entry is echoed as sent, `corrected="0"`; one
// entry answers `scrobbles.scrobble` as an object, several as an array, and
// `@attr.accepted`/`ignored` are numbers (encode.ts).
//
// **track.updateNowPlaying** (§7.8): artist and track required (6). An
// invalid name answers `ignoredMessage` 1 or 2 and stores nothing; otherwise
// the `now_playing` row is upserted (TTL `duration` when 30–5,400 s, else
// 600 s; the same current track only refreshes) and one `nowplaying` forward
// row per link is queued in the same transaction, keyed by started_at_ms so a
// refresh never re-forwards. The answer echoes track, artist, album and
// albumArtist with `corrected="0"` and `ignoredMessage code="0"` (#text "").
//
// **track.love / track.unlove** (§7.5, §7.8): artist and track required (6);
// they queue `love.put` / `love.delete` and their forward rows
// (outbox/love-ops.ts) and answer `<lfm status="ok"/>` / `{}`. An invalid
// name is 6.
//
// **library.removeScrobble** (§7.5, GNU FM): artist, track and timestamp
// (whole UNIX seconds) required (6). At that second it matches, by music key:
//   - the caller's own `scrobble.create` operations not yet indexed, found by
//     the listen key in `listen_keys` (live ingress) and `import_items`
//     (imports): a never-sent one is cancelled (nothing reaches the PDS; its
//     listen key and unsent forward rows go), a running or sent one gets a
//     `scrobble.delete` chained after it (outbox/delete-ops.ts);
//   - the owner's newest indexed record (`scrobbles`): a `scrobble.delete`
//     behind any unsettled operation on that URI.
// A record that already has an unsettled delete counts as matched without a
// second one (a double tap). A create that failed or was cancelled, or whose
// record a delete already removed, matches nothing. No match → 7 "Invalid
// resource specified", which Pano treats as success. The success body is
// `<lfm status="ok"/>` / `{}`, as for love (§20.5 leaves it open; GNU FM
// answers an empty ok).

import { listenKey } from '@atmusic/core/listen-key';
import { MusicKeyError } from '@atmusic/core/music-key';
import { type InvalidListenReason, mapLastfmScrobble, mapLastfmTrack } from '@atmusic/core/protocol-map';
import { reasonText, type ValidationFailure } from '@atmusic/core/scrobble';
import { NS_PER_SECOND, toStorage } from '@atmusic/core/timestamp';
import type { OperationRow } from '../app/rows';
import { verifySessionKey } from '../credentials/lastfm-auth';
import type { ModuleDeps } from '../do/contracts';
import { upsertNowPlaying } from '../do/read/now-playing';
import { visibleScrobblesFrom } from '../do/read/visibility';
import { musicKeyColumns } from '../do/write/keys';
import { batchMemberForListenKey } from '../imports/batch-acceptance';
import {
  commitUnsentBatchListenRemoval,
  enqueueBatchListenDelete,
  prepareUnsentBatchListenRemoval,
} from '../outbox/batch-delete-ops';
import { enqueueScrobbleDelete, removeScrobbleCreate } from '../outbox/delete-ops';
import { enqueueForwards } from '../outbox/forward-enqueue';
import { acceptListens, type ListenResult } from '../outbox/ingress';
import { enqueueLove, enqueueUnlove } from '../outbox/love-ops';
import { loadOperation, outboxCollections, UNSETTLED_SQL } from '../outbox/operations';
import { newerThanUncertain } from '../outbox/removal-fence';
import type { LastfmCall, LastfmMethodDef, LastfmMethodTable } from './auth-methods';
import { authFailure } from './auth-methods';
import { type LfmDocument, type LfmElement, leaf, lfmOk, node } from './encode';
import { LastfmError } from './errors';
import { parseIndexedEntries } from './params';

/** ADR §7.7: a timestamp before 2002-10-01T00:00:00Z is "too old". */
export const MIN_SCROBBLE_TIMESTAMP = 1_033_430_400;
/** ADR §7.7: the lexicon bound, receipt + 300 s. */
export const MAX_FUTURE_SECONDS = 300;

/** Last.fm's ignoredMessage texts. */
export const IGNORED_MESSAGES = {
  1: 'Artist name failed filter',
  2: 'Track name failed filter',
  3: 'Timestamp too old',
  4: 'Timestamp too new',
  5: 'Daily scrobble limit exceeded',
} as const;
export type IgnoredCode = keyof typeof IGNORED_MESSAGES;

/** The per-entry parameters track.scrobble reads; anything else is ignored. */
export const SCROBBLE_FIELDS = [
  'artist',
  'track',
  'timestamp',
  'album',
  'albumArtist',
  'trackNumber',
  'mbid',
  'duration',
  'context',
  'streamId',
  'chosenByUser',
] as const;

const NOW_PLAYING_FIELDS = ['artist', 'track', 'album', 'albumArtist', 'trackNumber', 'mbid', 'duration'] as const;

// ---------------------------------------------------------------------------
// Shared checks

export interface WriteCaller {
  did: string;
  sessionId: string;
  /** The session's client name: the records' submissionClient. */
  clientName: string | null;
}

/** Steps 1–3 of the module comment. */
export function authenticateWrite(call: LastfmCall): WriteCaller {
  if (!call.m.config.publication || call.m.config.prefix === null) throw new LastfmError(11);
  const verified = verifySessionKey(call.m, call.params.get('sk'));
  if (!verified.ok) throw authFailure(verified.code, verified.message);
  const rate = call.services.writeRate.take(verified.value.id);
  if (!rate.allowed) throw new LastfmError(29, undefined, { retryAfterSeconds: rate.retryAfterSeconds });
  const clientName =
    call.m.db.one<{ client_name: string | null }>(
      'SELECT client_name FROM lastfm_sessions WHERE id = ?',
      verified.value.id,
    )?.client_name ?? null;
  return { did: verified.value.did, sessionId: verified.value.id, clientName };
}

function missing(name: string): LastfmError {
  return new LastfmError(6, `Invalid parameters - missing required parameter ${JSON.stringify(name)}`);
}

function requiredParam(call: LastfmCall, name: string): string {
  const value = call.params.get(name);
  if (value === undefined) throw missing(name);
  return value;
}

function invalidName(reason: ValidationFailure): LastfmError {
  return new LastfmError(6, `Invalid parameters - ${reasonText(reason)}`);
}

/** The listed parameters that are present, as one entry. */
function entryOf(call: LastfmCall, fields: readonly string[]): Record<string, string> {
  const entry: Record<string, string> = {};
  for (const field of fields) {
    const value = call.params.get(field);
    if (value !== undefined) entry[field] = value;
  }
  return entry;
}

function corrected(name: string, text: string | undefined): LfmElement {
  return leaf(name, text ?? '', { corrected: '0' });
}

function ignoredMessage(code: 0 | IgnoredCode, text = ''): LfmElement {
  return leaf('ignoredMessage', text, { code });
}

// ---------------------------------------------------------------------------
// track.scrobble

type EntryOutcome = { code: 0 } | { code: IgnoredCode; message: string };

function ignored(code: IgnoredCode, message: string = IGNORED_MESSAGES[code]): EntryOutcome {
  return { code, message };
}

function mappingFailure(reason: InvalidListenReason, timestamp: string): EntryOutcome {
  if (reason === 'artist_invalid') return ignored(1);
  if (reason === 'track_invalid') return ignored(2);
  // An all-digit value past the record datetime range is in the future; anything else is not a time.
  return /^[0-9]+$/.test(timestamp) ? ignored(4) : ignored(3, 'Timestamp is invalid');
}

function acceptedOutcome(result: ListenResult): EntryOutcome {
  switch (result.status) {
    case 'accepted':
      return { code: 0 };
    case 'over_cap':
      return ignored(5);
    default:
      // The mapped input already passed every check; a validator refusal here is a bound.
      if (result.reason.field === 'artist') return ignored(1);
      if (result.reason.field === 'track') return ignored(2);
      return ignored(4);
  }
}

function scrobbleElement(entry: Record<string, string>, outcome: EntryOutcome): LfmElement {
  return node('scrobble', [
    corrected('track', entry.track),
    corrected('artist', entry.artist),
    corrected('album', entry.album),
    corrected('albumArtist', entry.albumArtist),
    leaf('timestamp', entry.timestamp ?? ''),
    outcome.code === 0 ? ignoredMessage(0) : ignoredMessage(outcome.code, outcome.message),
  ]);
}

const scrobbleMethod: LastfmMethodDef = {
  name: 'track.scrobble',
  postOnly: true,
  signed: true,
  async handle(call) {
    const caller = authenticateWrite(call);
    const entries = parseIndexedEntries(call.params, SCROBBLE_FIELDS, { required: ['artist', 'track', 'timestamp'] });
    const receiptMs = call.m.clock.nowMs();
    const outcomes: EntryOutcome[] = [];
    const pending: { index: number; input: unknown; forward: Record<string, string> }[] = [];
    entries.forEach((entry, index) => {
      const options = caller.clientName === null ? {} : { submissionClient: caller.clientName };
      const mapped = mapLastfmScrobble(entry, options);
      if (!mapped.ok) {
        outcomes[index] = mappingFailure(mapped.reason, entry.timestamp ?? '');
      } else if (mapped.listenedAtSeconds < MIN_SCROBBLE_TIMESTAMP) {
        outcomes[index] = ignored(3);
      } else if (mapped.listenedAtSeconds * 1000 > receiptMs + MAX_FUTURE_SECONDS * 1000) {
        outcomes[index] = ignored(4);
      } else {
        pending.push({ index, input: mapped.input, forward: { ...entry } });
      }
    });
    if (pending.length > 0) {
      const accepted = await acceptListens(call.m, {
        did: caller.did,
        origin: 'lastfm',
        listens: pending.map((p) => ({ input: p.input, forward: p.forward })),
        receiptMs,
        kick: call.services.kickOutbox,
      });
      accepted.results.forEach((result, i) => {
        const p = pending[i];
        if (p !== undefined) outcomes[p.index] = acceptedOutcome(result);
      });
    }
    const acceptedCount = outcomes.filter((o) => o.code === 0).length;
    const items = entries.map((entry, i) => scrobbleElement(entry, outcomes[i] ?? ignored(1)));
    return lfmOk(node('scrobbles', items, { accepted: acceptedCount, ignored: entries.length - acceptedCount }));
  },
};

// ---------------------------------------------------------------------------
// track.updateNowPlaying

function nowPlayingDocument(entry: Record<string, string>, code: 0 | 1 | 2): LfmDocument {
  return lfmOk(
    node('nowplaying', [
      corrected('track', entry.track),
      corrected('artist', entry.artist),
      corrected('album', entry.album),
      corrected('albumArtist', entry.albumArtist),
      code === 0 ? ignoredMessage(0) : ignoredMessage(code, IGNORED_MESSAGES[code]),
    ]),
  );
}

const updateNowPlayingMethod: LastfmMethodDef = {
  name: 'track.updateNowPlaying',
  postOnly: true,
  signed: true,
  async handle(call) {
    const caller = authenticateWrite(call);
    requiredParam(call, 'artist');
    requiredParam(call, 'track');
    const entry = entryOf(call, NOW_PLAYING_FIELDS);
    const mapped = mapLastfmTrack(entry, caller.clientName === null ? {} : { submissionClient: caller.clientName });
    if (!mapped.ok) return nowPlayingDocument(entry, mapped.reason === 'artist_invalid' ? 1 : 2);
    const t = mapped.track;
    const m = call.m;
    const now = m.clock.nowMs();
    m.db.tx(() => {
      const { row } = upsertNowPlaying(m, {
        did: caller.did,
        artist: t.artist,
        track: t.track,
        album: t.album ?? null,
        albumArtist: t.albumArtist ?? null,
        durationSeconds: t.durationSeconds ?? null,
        recordingMbid: t.recordingMbid ?? null,
        trackNumber: t.trackNumber ?? null,
        client: caller.clientName,
        source: 'lastfm',
      });
      enqueueForwards(m.db, {
        did: caller.did,
        items: [
          {
            kind: 'nowplaying',
            startedAtMs: row.started_at_ms,
            artist: row.artist,
            track: row.track,
            payload: {
              track: {
                artist: t.artist,
                track: t.track,
                ...(t.album !== undefined ? { album: t.album } : {}),
                ...(t.albumArtist !== undefined ? { albumArtist: t.albumArtist } : {}),
                ...(t.durationSeconds !== undefined ? { durationSeconds: t.durationSeconds } : {}),
                ...(t.recordingMbid !== undefined ? { recordingMbid: t.recordingMbid } : {}),
                ...(t.trackNumber !== undefined ? { trackNumber: t.trackNumber } : {}),
              },
              startedAtMs: row.started_at_ms,
              origin: 'lastfm',
            },
          },
        ],
        now,
        random: m.random,
      });
    });
    call.services.kickForward();
    return nowPlayingDocument(entry, 0);
  },
};

// ---------------------------------------------------------------------------
// track.love, track.unlove

const loveMethod: LastfmMethodDef = {
  name: 'track.love',
  postOnly: true,
  signed: true,
  async handle(call) {
    const caller = authenticateWrite(call);
    const artist = requiredParam(call, 'artist');
    const track = requiredParam(call, 'track');
    const result = await enqueueLove(call.m, {
      did: caller.did,
      input: { artist, track },
      origin: 'lastfm',
      kick: call.services.kickOutbox,
    });
    if (!result.ok) throw invalidName(result.reason);
    return lfmOk();
  },
};

const unloveMethod: LastfmMethodDef = {
  name: 'track.unlove',
  postOnly: true,
  signed: true,
  async handle(call) {
    const caller = authenticateWrite(call);
    const artist = requiredParam(call, 'artist');
    const track = requiredParam(call, 'track');
    const result = await enqueueUnlove(call.m, {
      did: caller.did,
      artist,
      track,
      origin: 'lastfm',
      kick: call.services.kickOutbox,
    });
    if (!result.ok) throw invalidName(result.reason);
    return lfmOk();
  },
};

// ---------------------------------------------------------------------------
// library.removeScrobble

export type RemoveMatch =
  | { kind: 'cancelled'; operationId: string }
  | { kind: 'rewritten'; operationId: string }
  | { kind: 'delete_chained'; operationId: string; deleteId: string }
  | { kind: 'delete_indexed'; uri: string; deleteId: string }
  | { kind: 'delete_pending'; uri: string; deleteId: string };

export const NO_MATCH_MESSAGE = 'Invalid resource specified';

function uriOf(op: Pick<OperationRow, 'did' | 'collection' | 'rkey'>): string {
  return `at://${op.did}/${op.collection}/${op.rkey}`;
}

/** An unsettled scrobble.delete of the DID at `rkey`, if any. */
function pendingDelete(m: ModuleDeps, did: string, collection: string, rkey: string, listenId?: string): string | null {
  return (
    m.db.one<{ id: string }>(
      `SELECT id FROM operations WHERE did = ? AND kind = 'scrobble.delete' AND collection = ? AND rkey = ?
         AND state IN ${UNSETTLED_SQL}
         AND (? != ? OR EXISTS (SELECT 1 FROM batch_delete_listens bdl WHERE bdl.operation_id=operations.id
           AND bdl.listen_id IN (?, '*')))
       ORDER BY rowid DESC LIMIT 1`,
      did,
      collection,
      rkey,
      collection,
      collection.endsWith('.scrobbleBatch') ? collection : '',
      listenId ?? '',
    )?.id ?? null
  );
}

/** True when a delete of ours already removed the record at `rkey`, or the index verified it absent. */
function alreadyRemoved(m: ModuleDeps, did: string, collection: string, rkey: string, listenId?: string): boolean {
  const deleted = m.db.one<{ one: number }>(
    `SELECT 1 AS one FROM operations WHERE did = ? AND kind = 'scrobble.delete' AND collection = ? AND rkey = ?
       AND state = 'succeeded'
       AND (? != ? OR EXISTS (SELECT 1 FROM batch_delete_listens bdl WHERE bdl.operation_id=operations.id
         AND bdl.listen_id IN (?, '*')))
     LIMIT 1`,
    did,
    collection,
    rkey,
    collection,
    collection.endsWith('.scrobbleBatch') ? collection : '',
    listenId ?? '',
  );
  if (deleted !== null) return true;
  const state = m.db.one<{ state: string }>(
    'SELECT state FROM record_state WHERE uri = ?',
    `at://${did}/${collection}/${rkey}`,
  );
  return state !== null && state.state === 'absent';
}

/** The operation ids of the DID's creates whose listen key is `key` (live ingress and imports). */
function createsWithKey(m: ModuleDeps, did: string, key: string): string[] {
  const ids = new Set<string>();
  const live = m.db.one<{ operation_id: string | null }>(
    'SELECT operation_id FROM listen_keys WHERE did = ? AND dedupe_key = ?',
    did,
    key,
  );
  if (live?.operation_id != null) ids.add(live.operation_id);
  for (const row of m.db.all<{ operation_id: string }>(
    `SELECT i.operation_id FROM import_items i JOIN import_jobs j ON j.id = i.job_id
     WHERE j.did = ? AND i.dedupe_key = ? AND i.operation_id IS NOT NULL ORDER BY j.created_at_ms, i.seq`,
    did,
    key,
  )) {
    ids.add(row.operation_id);
  }
  return [...ids];
}

export interface RemoveScrobbleArgs {
  did: string;
  artist: string;
  track: string;
  /** Whole UNIX seconds. */
  timestamp: number;
  kick?: () => void;
}

/**
 * library.removeScrobble's matching (module comment), in one transaction.
 * Returns what was matched; empty means "no match" (7).
 */
export async function removeScrobble(m: ModuleDeps, args: RemoveScrobbleArgs): Promise<RemoveMatch[]> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  const collections = outboxCollections(prefix);
  const collection = collections.scrobble;
  let keys: ReturnType<typeof musicKeyColumns>;
  let key: string;
  try {
    keys = musicKeyColumns(args.artist, args.track, null);
    key = await listenKey({
      did: args.did,
      listenedAtNs: BigInt(args.timestamp) * NS_PER_SECOND,
      artist: args.artist,
      track: args.track,
    });
  } catch (error) {
    // A name that is not a valid display string can never have been stored.
    if (error instanceof MusicKeyError) return [];
    throw error;
  }
  const lower = toStorage(BigInt(args.timestamp) * NS_PER_SECOND);
  const upper = toStorage(BigInt(args.timestamp + 1) * NS_PER_SECOND);
  const unsentBatchPlans = new Map<string, NonNullable<Awaited<ReturnType<typeof prepareUnsentBatchListenRemoval>>>>();
  const batchMembers = new Map<string, { entryId: string; recordJson: string | null }>();
  const staleBatchOperations = new Set<string>();
  const tuple = {
    artistKey: keys.artist_key,
    trackKey: keys.track_key,
    listenedSecond: BigInt(args.timestamp),
  };
  for (const operationId of createsWithKey(m, args.did, key)) {
    const candidate = loadOperation(m.db, operationId);
    if (candidate?.collection !== collections.scrobbleBatch) continue;
    const entryId = await batchMemberForListenKey(m, {
      did: args.did,
      recordJson: candidate.record_json,
      listenKey: key,
      tuple: {
        artistKey: keys.artist_key,
        trackKey: keys.track_key,
        listenedSecond: BigInt(args.timestamp),
      },
    });
    if (entryId === null) continue;
    batchMembers.set(operationId, { entryId, recordJson: candidate.record_json });
    const plan = await prepareUnsentBatchListenRemoval(m, {
      did: args.did,
      operationId,
      listenId: entryId,
      listenKey: key,
      tuple,
    });
    if (plan !== null) unsentBatchPlans.set(operationId, plan);
  }
  const matches = m.db.tx((): RemoveMatch[] => {
    const out: RemoveMatch[] = [];
    const handled = new Set<string>();
    const indexed = m.db.one<{ uri: string; rkey: string; record_uri: string | null; listen_id: string | null }>(
      `SELECT s.uri, s.rkey, s.record_uri, s.listen_id FROM ${visibleScrobblesFrom('s', 'u')}
       WHERE s.did = ? AND s.artist_key = ? AND s.track_key = ?
         AND s.listened_at >= ? AND s.listened_at < ? ORDER BY s.listened_at DESC, s.uri DESC LIMIT 1`,
      args.did,
      keys.artist_key,
      keys.track_key,
      lower,
      upper,
    );
    const rawIndexed =
      indexed ??
      m.db.one<{
        uri: string;
        rkey: string;
        record_uri: string | null;
        listen_id: string | null;
      }>(
        `SELECT uri,rkey,record_uri,listen_id FROM scrobbles WHERE did=? AND artist_key=? AND track_key=?
       AND listened_at>=? AND listened_at<? ORDER BY listened_at DESC,uri DESC LIMIT 1`,
        args.did,
        keys.artist_key,
        keys.track_key,
        lower,
        upper,
      );
    const isIndexed = (uri: string) => m.db.one('SELECT 1 AS one FROM scrobbles WHERE uri = ?', uri) !== null;
    const freshDelete = (row: { uri: string; record_uri: string | null; listen_id: string | null }) =>
      row.record_uri !== null && row.listen_id !== null
        ? enqueueBatchListenDelete(m, {
            did: args.did,
            uri: row.record_uri,
            listenIds: [row.listen_id],
            origin: 'lastfm',
          })
        : enqueueScrobbleDelete(m, { did: args.did, uri: row.uri, origin: 'lastfm' });

    // A visible indexed single wins over a pending batch with the same music
    // key. If the visible row is a batch item, an exact pending single is the
    // cross-format winner and must be removed on its own first.
    const pendingIds = createsWithKey(m, args.did, key);
    const pendingSingleIds = pendingIds.filter((id) => loadOperation(m.db, id)?.collection === collection);
    const preferredPendingSingle = pendingSingleIds[0];
    const indexedSingle = indexed !== null && indexed.record_uri === null;
    const pendingSingleWins = indexed !== null && indexed.record_uri !== null && preferredPendingSingle !== undefined;

    for (const id of pendingIds) {
      const op = loadOperation(m.db, id);
      if (op === null || op.did !== args.did || op.kind !== 'scrobble.create' || op.rkey === null) continue;
      if (op.collection !== collection && op.collection !== collections.scrobbleBatch) continue;
      if (indexedSingle) continue;
      if (pendingSingleWins && id !== preferredPendingSingle) continue;
      if (!pendingSingleWins && indexed !== null) continue;
      if (indexed === null && preferredPendingSingle !== undefined && id !== preferredPendingSingle) continue;
      if (op.state === 'failed' || op.state === 'cancelled') continue;
      const uri = uriOf(op);
      if (handled.has(uri) || isIndexed(uri)) continue; // the indexed path below handles it
      handled.add(uri);
      const batchEntry =
        op.collection === collections.scrobbleBatch
          ? (() => {
              const member = batchMembers.get(op.id);
              return member !== undefined && member.recordJson === op.record_json ? member.entryId : undefined;
            })()
          : undefined;
      if (op.collection === collections.scrobbleBatch && batchEntry === undefined) {
        if (batchMembers.has(op.id)) staleBatchOperations.add(op.id);
        continue;
      }
      const waiting = pendingDelete(m, args.did, op.collection, op.rkey, batchEntry);
      if (waiting !== null) {
        out.push({ kind: 'delete_pending', uri, deleteId: waiting });
        continue;
      }
      if (alreadyRemoved(m, args.did, op.collection, op.rkey, batchEntry)) continue;
      const plan = unsentBatchPlans.get(op.id);
      const batchRemoval = plan === undefined ? null : commitUnsentBatchListenRemoval(m, plan);
      if (batchRemoval !== null) {
        out.push({ kind: batchRemoval.state === 'cancelled' ? 'cancelled' : 'rewritten', operationId: op.id });
        continue;
      }
      if (plan !== undefined && loadOperation(m.db, op.id)?.record_json !== plan.snapshot.record_json) {
        staleBatchOperations.add(op.id);
        continue;
      }
      const removed = removeScrobbleCreate(m, {
        did: args.did,
        operationId: op.id,
        origin: 'lastfm',
        ...(batchEntry ? { listenId: batchEntry } : {}),
      });
      if (removed.status === 'cancelled') out.push({ kind: 'cancelled', operationId: op.id });
      else if (removed.status === 'delete_chained') {
        out.push({ kind: 'delete_chained', operationId: op.id, deleteId: removed.delete.id });
      }
    }

    if (indexed !== null && !handled.has(indexed.uri) && !pendingSingleWins) {
      const targetCollection = indexed.record_uri !== null ? collections.scrobbleBatch : collection;
      const targetRkey = indexed.record_uri !== null ? indexed.record_uri.split('/').at(-1)! : indexed.rkey;
      // No historical receipt short-circuits a visible row: the shared
      // overlay already hides every incarnation a delete of ours still covers
      // (pending, or its swap/evidence CIDs), so a visible row is a newer
      // verified incarnation (e.g. the owner restored the same listen id at a
      // new CID) and needs a fresh delete intent.
      const waiting = pendingDelete(m, args.did, targetCollection, targetRkey, indexed.listen_id ?? undefined);
      if (waiting !== null && !newerThanUncertain(m.db, waiting, indexed.uri)) {
        out.push({ kind: 'delete_pending', uri: indexed.uri, deleteId: waiting });
      } else {
        out.push({ kind: 'delete_indexed', uri: indexed.uri, deleteId: freshDelete(indexed).id });
      }
    }
    // A pending batch item is hidden from the shared read overlay immediately.
    // Keep its exact intent discoverable to a repeated protocol delete without
    // allowing a sibling item in that same container to satisfy the request.
    if (indexed === null && rawIndexed !== null) {
      const targetCollection = rawIndexed.record_uri !== null ? collections.scrobbleBatch : collection;
      const targetRkey = rawIndexed.record_uri !== null ? rawIndexed.record_uri.split('/').at(-1)! : rawIndexed.rkey;
      const waiting = pendingDelete(m, args.did, targetCollection, targetRkey, rawIndexed.listen_id ?? undefined);
      // A removal holding an unknown send never writes into a later
      // incarnation (outbox/removal-fence.ts). When the verified projection
      // is provably newer than its fence, this request is a fresh intent, not
      // a repeat of that one: admit it (it supersedes the old one when it
      // covers its targets). Otherwise it is the same intent: absorbed.
      if (waiting !== null && newerThanUncertain(m.db, waiting, rawIndexed.uri)) {
        out.push({ kind: 'delete_indexed', uri: rawIndexed.uri, deleteId: freshDelete(rawIndexed).id });
      } else if (waiting !== null) out.push({ kind: 'delete_pending', uri: rawIndexed.uri, deleteId: waiting });
    }
    return out;
  });
  const admitRetryFallback = (snapshot: OperationRow | null, listenId: string): RemoveMatch | null => {
    if (snapshot === null || snapshot.rkey === null) return null;
    return m.db.tx(() => {
      const current = loadOperation(m.db, snapshot.id);
      const collection = current?.collection;
      const rkey = current?.rkey;
      if (
        current === null ||
        current.did !== args.did ||
        current.kind !== 'scrobble.create' ||
        collection !== collections.scrobbleBatch ||
        rkey === null ||
        rkey !== snapshot.rkey ||
        current.record_json !== snapshot.record_json
      )
        return null;
      const waiting = pendingDelete(m, args.did, collection, rkey, listenId);
      if (waiting !== null) return { kind: 'delete_pending', uri: uriOf(current), deleteId: waiting };
      if (alreadyRemoved(m, args.did, collection, rkey, listenId)) return null;
      const fallback = removeScrobbleCreate(m, {
        did: args.did,
        operationId: current.id,
        origin: 'lastfm',
        listenId,
      });
      if (fallback.status === 'cancelled') return { kind: 'cancelled', operationId: current.id };
      if (fallback.status === 'delete_chained')
        return { kind: 'delete_chained', operationId: current.id, deleteId: fallback.delete.id };
      return null;
    });
  };
  for (const operationId of staleBatchOperations) {
    // A sibling may have committed a rewrite after the initial lookup. Retry
    // against the current payload, with a fixed bound if writers keep racing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = loadOperation(m.db, operationId);
      if (current === null || current.collection !== collections.scrobbleBatch || current.rkey === null) break;
      const entryId = await batchMemberForListenKey(m, {
        did: args.did,
        recordJson: current.record_json,
        listenKey: key,
        tuple,
      });
      if (entryId === null) break;
      const plan = await prepareUnsentBatchListenRemoval(m, {
        did: args.did,
        operationId,
        listenId: entryId,
        listenKey: key,
        tuple,
      });
      const removed = plan === null ? null : commitUnsentBatchListenRemoval(m, plan);
      if (removed !== null) {
        matches.push({ kind: removed.state === 'cancelled' ? 'cancelled' : 'rewritten', operationId });
        break;
      }
      const after = loadOperation(m.db, operationId);
      if (after?.record_json !== current.record_json) {
        if (attempt < 2) continue;
        // Keep the request durable if the bounded optimistic retries were
        // repeatedly overtaken: resolve once more, then admit an exact-member
        // delete through the synchronous removal transaction.
        const latestEntry = await batchMemberForListenKey(m, {
          did: args.did,
          recordJson: after?.record_json ?? null,
          listenKey: key,
          tuple,
        });
        if (latestEntry !== null) {
          const fallback = admitRetryFallback(after, latestEntry);
          if (fallback !== null) matches.push(fallback);
        }
        break;
      }
      const fallback = admitRetryFallback(current, entryId);
      if (fallback !== null) matches.push(fallback);
      break;
    }
  }
  if (matches.some((match) => match.kind !== 'delete_pending')) args.kick?.();
  return matches;
}

const removeScrobbleMethod: LastfmMethodDef = {
  name: 'library.removeScrobble',
  postOnly: true,
  signed: true,
  async handle(call) {
    const caller = authenticateWrite(call);
    const artist = requiredParam(call, 'artist');
    const track = requiredParam(call, 'track');
    const timestamp = requiredParam(call, 'timestamp');
    const seconds = /^[0-9]{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
    if (!Number.isSafeInteger(seconds)) {
      throw new LastfmError(6, 'Invalid parameters - timestamp must be whole UNIX seconds');
    }
    const matches = await removeScrobble(call.m, {
      did: caller.did,
      artist,
      track,
      timestamp: seconds,
      kick: call.services.kickOutbox,
    });
    if (matches.length === 0) throw new LastfmError(7, NO_MATCH_MESSAGE);
    return lfmOk();
  },
};

/** The ADR §7.5 write methods. */
export const writeMethods: LastfmMethodTable = Object.freeze({
  [scrobbleMethod.name]: scrobbleMethod,
  [updateNowPlayingMethod.name]: updateNowPlayingMethod,
  [loveMethod.name]: loveMethod,
  [unloveMethod.name]: unloveMethod,
  [removeScrobbleMethod.name]: removeScrobbleMethod,
});
