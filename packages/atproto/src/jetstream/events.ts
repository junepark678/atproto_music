// Bounded Jetstream event parser (ADR 0004 §5.4, §5.5; amendments A6, A17).
//
// Every Jetstream event is an untrusted *hint* naming only (did, collection,
// rkey). Authority comes later from a signed getRecord proof or a range
// snapshot, so this module never trusts a record body, never retains one and
// never performs I/O: it is a pure function of its arguments.
//
// Wire formats accepted (both strictly shape-checked, unknown extra fields
// tolerated because the server may add them):
//
// 1. Jetstream v2, `network.bsky.jetstream.subscribeEvents` over the
//    `xrpc.v1.json` subprotocol (the shape @atcute/jetstream 2.2.0 types):
//      {"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit",
//        "did","seq","time","operation","collection","rkey","rev","cid"?,"record"?}}
//    `seq` is the stream cursor; `timeUs` is derived from the microsecond
//    `time` datetime. `{"$type":"error",...}` frames and `#info` payloads are
//    ignored with a `notice` (e.g. OutdatedCursor feeds gap detection).
// 2. The flat Jetstream event shape:
//      {"did","time_us","kind":"commit","seq"?,"commit":{"rev","operation","collection","rkey","cid"?,"record"?}}
//    `seq`, when absent, is `time_us` (that shape's cursor is its timestamp,
//    and v2 interprets cursors >= 1e15 as unix microseconds).
//
// Only `commit` events with create/update/delete in a configured collection
// become hints. identity/account/sync (and any unknown kind) are ignored: they
// are not subscribed (buildSubscribeUrl always sends kinds=commit) and account
// state comes from errors and the getRepoStatus sweep (ADR F1, A17).

/** Messages over 64 KiB (UTF-8 bytes) are dropped and counted (ADR §5.4). */
export const MAX_JETSTREAM_MESSAGE_BYTES = 64 * 1024;

export const JETSTREAM_SUBSCRIBE_NSID = 'network.bsky.jetstream.subscribeEvents';

/** Jetstream v2 rejects more than 100 collections pre-upgrade (lexicon maxLength). */
export const MAX_SUBSCRIBE_COLLECTIONS = 100;

export type JetstreamOperation = 'create' | 'update' | 'delete';

export interface JetstreamHint {
  kind: 'hint';
  did: string;
  collection: string;
  rkey: string;
  operation: JetstreamOperation;
  rev: string;
  /** Present for create/update only. Untrusted: the proof decides the real CID. */
  cid?: string;
  /** Stream cursor of this event. */
  seq: number;
  /** Event time in unix microseconds. */
  timeUs: number;
}

/** A server advisory carried by an ignored frame. */
export interface JetstreamNotice {
  type: 'info' | 'error';
  name: string;
  message?: string;
}

export interface JetstreamIgnore {
  kind: 'ignore';
  /** Present when the frame carried a valid cursor; the caller still advances to it. */
  seq?: number;
  timeUs?: number;
  notice?: JetstreamNotice;
}

export type JetstreamInvalidReason =
  | 'oversize'
  | 'malformed_json'
  | 'shape'
  | 'unsafe_integer'
  | 'time'
  | 'did'
  | 'rkey'
  | 'rev'
  | 'cid';

export interface JetstreamInvalid {
  kind: 'invalid';
  reason: JetstreamInvalidReason;
}

export type JetstreamParseResult = JetstreamHint | JetstreamIgnore | JetstreamInvalid;

export type CollectionSet = ReadonlySet<string> | readonly string[];

// --- Minimal local syntax validators -----------------------------------------
// TODO(W2 consolidation): these copy the W1-01 `@atmusic/core/syntax` rules
// (themselves mirroring crates/core/src/follow.rs `validate_did_syntax` and
// crates/atproto/src/sync/frames.rs `valid_rkey`/`validate_revision`). W1-06 is
// deliberately independent of W1-01; a W2 test must assert both agree on the
// golden vectors, then replace these with imports from core.

/** Generic DID syntax: lowercase method, `%XX` escapes, no trailing ':' (≤ 2048 bytes, ASCII). */
const DID_RE = /^did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$/;
const MAX_DID_LENGTH = 2048;
/** Record key: 1..512 of [A-Za-z0-9._~:-], never "." or "..". */
const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;
/** TID revision: 13 base32-sortable chars, first char limits the top bit. */
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
/** Lexicon `cid` string format (lenient syntax; the proof checks the real CID). */
const CID_RE = /^[A-Za-z0-9+=]{8,256}$/;
/** atproto datetime with an explicit zone; fraction up to nanoseconds. */
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const NSID_SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const NSID_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,62}$/;

export function isJetstreamDid(value: string): boolean {
  return value.length <= MAX_DID_LENGTH && DID_RE.test(value);
}

export function isJetstreamRkey(value: string): boolean {
  return value !== '.' && value !== '..' && RKEY_RE.test(value);
}

function isNsid(value: string): boolean {
  if (value.length > 317) return false;
  const segments = value.split('.');
  if (segments.length < 3) return false;
  const name = segments.pop()!;
  if (!NSID_NAME_RE.test(name)) return false;
  if (!/^[A-Za-z]/.test(segments[0]!)) return false;
  return segments.every((segment) => NSID_SEGMENT_RE.test(segment));
}

// --- Helpers ------------------------------------------------------------------

type Json = Record<string, unknown>;

const V2_COMMIT = `${JETSTREAM_SUBSCRIBE_NSID}#commit`;
const V2_INFO = `${JETSTREAM_SUBSCRIBE_NSID}#info`;
const V2_PREFIX = `${JETSTREAM_SUBSCRIBE_NSID}#`;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length with an early exit once `limit` is exceeded. Lone surrogates count as U+FFFD (3 bytes). */
function exceedsUtf8Bytes(text: string, limit: number): boolean {
  if (text.length > limit) return true; // every UTF-16 unit is at least one byte
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

class Invalid {
  constructor(readonly reason: JetstreamInvalidReason) {}
}

/** A required non-negative safe integer (`min` 1 for sequences, as the Rust oracle rejects seq 0). */
function safeInt(value: unknown, min: number): number {
  if (typeof value !== 'number') throw new Invalid('shape');
  if (!Number.isSafeInteger(value) || value < min) throw new Invalid('unsafe_integer');
  return value;
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Invalid('shape');
  return value;
}

function optStr(value: unknown): string | undefined {
  return value === undefined ? undefined : str(value);
}

/** Strict atproto datetime → unix microseconds (fraction beyond µs truncated). */
function datetimeToMicros(value: unknown): number {
  const text = str(value);
  const m = DATETIME_RE.exec(text);
  if (!m) throw new Invalid('time');
  const [, y, mo, d, h, mi, s, frac, z, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new Invalid('time');
  }
  let offsetMinutes = 0;
  if (z === undefined) {
    const offH = Number(oh);
    const offM = Number(om);
    if (offH > 23 || offM > 59) throw new Invalid('time');
    offsetMinutes = (offH * 60 + offM) * (sign === '-' ? -1 : 1);
    if (offsetMinutes === 0 && sign === '-') throw new Invalid('time'); // -00:00 is "unknown zone"
  }
  const micros = ms * 1000 + Number((frac ?? '').padEnd(6, '0').slice(0, 6)) - offsetMinutes * 60_000_000;
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Invalid('time');
  return micros;
}

interface CommitFields {
  did: unknown;
  operation: unknown;
  collection: unknown;
  rkey: unknown;
  rev: unknown;
  cid: unknown;
}

function commitResult(
  fields: CommitFields,
  seq: number,
  timeUs: number,
  allowed: (collection: string) => boolean,
): JetstreamParseResult {
  // Shape first, for every commit: all required fields must have their types.
  const did = str(fields.did);
  const operation = str(fields.operation);
  const collection = str(fields.collection);
  const rkey = str(fields.rkey);
  const rev = str(fields.rev);
  const cid = optStr(fields.cid);

  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
    return { kind: 'ignore', seq, timeUs };
  }
  if (!allowed(collection)) return { kind: 'ignore', seq, timeUs };

  // Syntax for configured collections only: these values key a durable hint.
  if (!isJetstreamDid(did)) return { kind: 'invalid', reason: 'did' };
  if (!isJetstreamRkey(rkey)) return { kind: 'invalid', reason: 'rkey' };
  if (!TID_RE.test(rev)) return { kind: 'invalid', reason: 'rev' };
  if (operation === 'delete') {
    if (cid !== undefined) return { kind: 'invalid', reason: 'cid' };
    return { kind: 'hint', did, collection, rkey, operation, rev, seq, timeUs };
  }
  if (cid === undefined || !CID_RE.test(cid)) return { kind: 'invalid', reason: 'cid' };
  return { kind: 'hint', did, collection, rkey, operation, rev, cid, seq, timeUs };
}

function parseV2Frame(frame: Json, allowed: (collection: string) => boolean): JetstreamParseResult {
  if (frame.$type === 'error') {
    const notice: JetstreamNotice = { type: 'error', name: str(frame.error) };
    const message = optStr(frame.message);
    if (message !== undefined) notice.message = message;
    return { kind: 'ignore', notice };
  }
  if (frame.$type !== 'message' || !isObject(frame.payload)) throw new Invalid('shape');
  const payload = frame.payload;
  const type = str(payload.$type);
  if (!type.startsWith(V2_PREFIX)) throw new Invalid('shape');
  if (type === V2_INFO) {
    const notice: JetstreamNotice = { type: 'info', name: str(payload.name) };
    const message = optStr(payload.message);
    if (message !== undefined) notice.message = message;
    return { kind: 'ignore', notice };
  }
  const seq = safeInt(payload.seq, 1);
  const timeUs = datetimeToMicros(payload.time);
  if (type !== V2_COMMIT) return { kind: 'ignore', seq, timeUs }; // account, identity, sync, future kinds
  return commitResult(payload as unknown as CommitFields, seq, timeUs, allowed);
}

function parseFlatEvent(event: Json, allowed: (collection: string) => boolean): JetstreamParseResult {
  const kind = str(event.kind);
  const timeUs = safeInt(event.time_us, 0);
  const seq = event.seq === undefined ? timeUs : safeInt(event.seq, 1);
  if (kind !== 'commit') return { kind: 'ignore', seq, timeUs }; // identity, account, sync, future kinds
  if (!isObject(event.commit)) throw new Invalid('shape');
  const commit = event.commit;
  return commitResult(
    {
      did: event.did,
      operation: commit.operation,
      collection: commit.collection,
      rkey: commit.rkey,
      rev: commit.rev,
      cid: commit.cid,
    },
    seq,
    timeUs,
    allowed,
  );
}

/**
 * Parse one Jetstream text message into a hint, an ignorable frame or an
 * invalid frame. Pure and synchronous; never throws for any string input.
 */
export function parseJetstreamMessage(text: string, allowedCollections: CollectionSet): JetstreamParseResult {
  if (typeof text !== 'string') return { kind: 'invalid', reason: 'shape' };
  if (exceedsUtf8Bytes(text, MAX_JETSTREAM_MESSAGE_BYTES)) return { kind: 'invalid', reason: 'oversize' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'malformed_json' };
  }
  if (!isObject(value)) return { kind: 'invalid', reason: 'shape' };
  const allowed = Array.isArray(allowedCollections)
    ? (collection: string) => (allowedCollections as readonly string[]).includes(collection)
    : (collection: string) => (allowedCollections as ReadonlySet<string>).has(collection);
  try {
    if (typeof value.$type === 'string') return parseV2Frame(value, allowed);
    if (typeof value.kind === 'string') return parseFlatEvent(value, allowed);
    return { kind: 'invalid', reason: 'shape' };
  } catch (error) {
    if (error instanceof Invalid) return { kind: 'invalid', reason: error.reason };
    throw error;
  }
}

/**
 * The subscribe URL for `fetch(url, {headers:{Upgrade:'websocket'}})` (ADR §5.5).
 *
 * Always exactly one `kinds=commit` (never identity/account/sync: those are not
 * narrowed by `collections` and would deliver the whole network, ADR F1), one
 * `collections=` per configured collection, and `cursor` when resuming
 * (omitted means the live tail). `host` is a bare host[:port] or a
 * `wss://`/`https://` origin; the result is always `https://`.
 */
export function buildSubscribeUrl(host: string, collections: readonly string[], cursor?: number): string {
  const origin = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`invalid Jetstream host: ${host}`);
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Jetstream host must be wss:// or https://: ${host}`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === ''
  ) {
    throw new TypeError(`Jetstream host must be a bare origin: ${host}`);
  }
  const unique = [...new Set(collections)];
  if (unique.length === 0) throw new TypeError('at least one collection is required');
  if (unique.length > MAX_SUBSCRIBE_COLLECTIONS) {
    throw new TypeError(`at most ${MAX_SUBSCRIBE_COLLECTIONS} collections are allowed`);
  }
  for (const collection of unique) {
    if (!isNsid(collection)) throw new TypeError(`invalid collection NSID: ${collection}`);
  }
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    throw new TypeError(`cursor must be a non-negative safe integer: ${cursor}`);
  }
  const url = new URL(`https://${parsed.host}/xrpc/${JETSTREAM_SUBSCRIBE_NSID}`);
  url.searchParams.append('kinds', 'commit');
  for (const collection of unique) url.searchParams.append('collections', collection);
  if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));
  return url.toString();
}
