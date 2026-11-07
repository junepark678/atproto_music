/**
 * Pure contract and identity helpers for the unpublished scrobbleBatch
 * collection. Entries retain all single-record fields, including createdAt.
 * Remote entry errors are isolated; envelope shape, bounds, and duplicate ids
 * reject the whole container.
 */
import type { Clock } from './deps';
import { isValidPrefix } from './namespace';
import {
  type Build,
  buildScrobbleRecord,
  fail,
  recordObject,
  type ScrobbleInput,
  type ScrobbleRecord,
  type ScrobbleRow,
  type Validation,
  type ValidationFailure,
  validateScrobbleRecord,
} from './scrobble';
import { isDid, isNsid, isTid } from './syntax';
import { nowNs, toRecordDatetime, validateTimestamp } from './timestamp';

// Size limits (ADR 0006 "Capacity"; docs/verification/batch-capacity.md).
//
// The reference PDS (bluesky-social/atproto fe343a1b, @atproto/pds 0.5.40)
// sets `jsonLimit: 1_000_000` on createRecord, putRecord and applyWrites; the
// xrpc-server passes it to body-parser, which answers 413 only for a body of
// MORE than that many bytes. It has no separate per-record byte cap; a commit's
// relevant blocks are capped at 2,000,000 bytes (actor-store transactor).

/** The reference PDS's JSON request body limit (decimal bytes, inclusive). */
export const PDS_JSON_BODY_LIMIT_BYTES = 1_000_000;
/** Safety margin (1 %) kept below that limit for every batch write request we send. */
export const WRITE_SAFETY_MARGIN_BYTES = 10_000;
/** No scrobbleBatch createRecord or putRecord body we send exceeds this (exact UTF-8 bytes). */
export const MAX_WRITE_BODY_BYTES = PDS_JSON_BODY_LIMIT_BYTES - WRITE_SAFETY_MARGIN_BYTES;
/** Longest CID string a removal may send as swapCommit/swapRecord (`/^b[a-z2-7]{8,256}$/`). */
export const MAX_SWAP_CID_CHARS = 257;
/**
 * Bytes a partial-removal putRecord body adds to the create body of the same
 * record: `,"swapCommit":"<cid>"` and `,"swapRecord":"<cid>"` (16 bytes plus
 * the CID each). Removing at least one entry only shrinks the rest.
 */
export const PUT_SWAP_RESERVE_BYTES = 2 * (16 + MAX_SWAP_CID_CHARS);
/**
 * Packing target for a new container's exact createRecord JSON body, so a
 * later partial-removal putRecord of it (swaps included) still fits
 * MAX_WRITE_BODY_BYTES.
 */
export const MAX_CREATE_BODY_BYTES = MAX_WRITE_BODY_BYTES - PUT_SWAP_RESERVE_BYTES;
/**
 * DAG-CBOR record bound for writes. A container of validated entries encodes
 * to less DAG-CBOR than its JSON (every field's CBOR key and value headers are
 * shorter than its JSON quotes, colon and comma; property-checked in
 * packages/atproto/test/scrobble-batch-size.test.ts), so for our containers
 * this never binds before the body limit. It is checked exactly anyway, also
 * for retained owner bytes a removal puts back, where that need not hold.
 */
export const MAX_CBOR_BYTES = MAX_WRITE_BODY_BYTES;
/**
 * Ingest bound on a verified container's DAG-CBOR: the PDS caps one commit's
 * relevant blocks (record included) at 2,000,000 bytes, so no committed record
 * is larger. Read caps (SafeFetch) bound what is fetched before this.
 */
export const MAX_INGEST_CBOR_BYTES = 2_000_000;
/**
 * Shortest JSON a valid entry can have: a 13-character TID id, a one-byte
 * artist and track, and two 20-character RFC 3339 datetimes:
 * `{"id":"…","artist":"a","track":"a","listenedAt":"…","createdAt":"…"}`.
 */
export const MIN_ENTRY_JSON_BYTES = 118;
/**
 * A resource ceiling on entries, not a packing bound. Any record written
 * through the JSON write API is under 1,000,000 bytes, and its entries are
 * MIN_ENTRY_JSON_BYTES plus a comma each at least, so a container whose
 * entries are all valid holds at most 8,403 of them (ours, packed to
 * MAX_CREATE_BODY_BYTES, at most 8,314): the byte limit always binds first.
 */
export const BATCH_MAX_LISTENS = 10_000;
export const SCROBBLE_BATCH_COLLECTION_SUFFIX = '.scrobbleBatch';

export interface ScrobbleBatchEntry extends Omit<ScrobbleRecord, '$type'> {
  id: string;
}

export interface ScrobbleBatchRecord {
  $type: string;
  createdAt: string;
  listens: ScrobbleBatchEntry[];
}

export interface ScrobbleBatchListen {
  id: string;
  row: ScrobbleRow;
}

export interface ScrobbleBatchRow {
  record: ScrobbleBatchRecord;
  createdAt: string;
  listens: ScrobbleBatchListen[];
  dropped: Array<{ id: string | null; reason: ValidationFailure }>;
}

export interface ScrobbleBatchInput {
  id: string;
  listen: ScrobbleInput;
}

export function scrobbleBatchCollection(prefix: string): string {
  if (!isValidPrefix(prefix)) throw new RangeError(`invalid lexicon prefix ${JSON.stringify(prefix)}`);
  return `${prefix}${SCROBBLE_BATCH_COLLECTION_SUFFIX}`;
}

/** Format an AppView listen identity; the fragment is not a repository record URI. */
export function formatScrobbleBatchListenUri(containerUri: string, listenId: string): string {
  const parsed = parseScrobbleBatchListenUri(`${containerUri}#${listenId}`);
  if (!parsed) throw new RangeError('invalid scrobbleBatch container URI or listen id');
  return `${parsed.containerUri}#${parsed.listenId}`;
}

/** Parse a listen identity and return a fragment-free container URI for proof operations. */
export function parseScrobbleBatchListenUri(value: string): { containerUri: string; listenId: string } | null {
  if (typeof value !== 'string' || !value.startsWith('at://')) return null;
  const hash = value.indexOf('#');
  if (hash < 0 || hash !== value.lastIndexOf('#')) return null;
  const containerUri = value.slice(0, hash);
  const listenId = value.slice(hash + 1);
  if (!isTid(listenId)) return null;
  const parts = containerUri.slice(5).split('/');
  if (parts.length !== 3 || !isDid(parts[0] ?? '') || !isNsid(parts[1] ?? '') || !isTid(parts[2] ?? '')) return null;
  if (!parts[1]?.endsWith(SCROBBLE_BATCH_COLLECTION_SUFFIX)) return null;
  const prefix = parts[1].slice(0, -SCROBBLE_BATCH_COLLECTION_SUFFIX.length);
  if (!isValidPrefix(prefix)) return null;
  return { containerUri, listenId };
}

export function validateScrobbleBatchRecord(
  json: unknown,
  prefix: string,
  receiptNs: bigint,
): Validation<ScrobbleBatchRow> {
  const collection = scrobbleBatchCollection(prefix);
  if (typeof receiptNs !== 'bigint') throw new TypeError('receiptNs must be a bigint (nanoseconds since the epoch)');
  const object = recordObject(json);
  if (object === null) return fail('body', 'expected a JSON object');
  if (object.$type !== collection)
    return fail('$type', 'record type does not match the configured scrobbleBatch collection');
  if (typeof object.createdAt !== 'string') return fail('createdAt', 'required string field');
  const envelopeTime = validateTimestamp('createdAt', object.createdAt, receiptNs);
  if (!envelopeTime.ok) return { ok: false, reason: envelopeTime.reason };
  if (!Array.isArray(object.listens) || object.listens.length < 1 || object.listens.length > BATCH_MAX_LISTENS) {
    return fail('listens', `expected an array of 1–${BATCH_MAX_LISTENS} entries`);
  }
  const seen = new Set<string>();
  for (const value of object.listens) {
    const entry = recordObject(value);
    if (entry === null || typeof entry.id !== 'string' || !isTid(entry.id)) continue;
    if (seen.has(entry.id)) return fail('listens', 'duplicate listen id');
    seen.add(entry.id);
  }
  const listens: ScrobbleBatchListen[] = [];
  const dropped: ScrobbleBatchRow['dropped'] = [];
  for (const value of object.listens) {
    const entry = recordObject(value);
    const id = entry !== null && typeof entry.id === 'string' ? entry.id : null;
    if (id === null || !isTid(id)) {
      dropped.push({ id, reason: { field: 'id', code: 'invalid_field', message: 'expected a TID' } });
      continue;
    }
    const single = { ...entry, $type: `${prefix}.scrobble` };
    delete (single as Record<string, unknown>).id;
    const result = validateScrobbleRecord(single, prefix, receiptNs);
    if (!result.ok) dropped.push({ id, reason: result.reason });
    else listens.push({ id, row: result.row });
  }
  const record: ScrobbleBatchRecord = {
    $type: collection,
    createdAt: object.createdAt,
    listens: listens.map(({ id, row }) => {
      const { $type: _singleType, ...fields } = row.record;
      return { id, ...fields };
    }),
  };
  return { ok: true, row: { record, createdAt: object.createdAt, listens, dropped } };
}

/** Build a batch while preserving stable entry ids and all normalized single-record fields. */
export function buildScrobbleBatchRecord(
  entries: readonly ScrobbleBatchInput[],
  prefix: string,
  clock: Clock,
): Build<ScrobbleBatchRecord> {
  const collection = scrobbleBatchCollection(prefix);
  if (entries.length < 1 || entries.length > BATCH_MAX_LISTENS) {
    return fail('listens', `expected an array of 1–${BATCH_MAX_LISTENS} entries`);
  }
  const seen = new Set<string>();
  const listens: ScrobbleBatchEntry[] = [];
  for (const entry of entries) {
    if (!isTid(entry.id)) return fail('id', 'expected a TID');
    if (seen.has(entry.id)) return fail('id', 'duplicate listen id');
    seen.add(entry.id);
    const built = buildScrobbleRecord(entry.listen, prefix, clock);
    if (!built.ok) return built;
    const { $type: _type, ...fields } = built.record;
    listens.push({ id: entry.id, ...fields });
  }
  return { ok: true, record: { $type: collection, createdAt: toRecordDatetime(nowNs(clock)), listens } };
}

export interface BatchSizes {
  cborBytes: number;
  createBodyBytes: number;
}

/**
 * An exact additive decomposition of `measure`: for every group `xs`,
 * `measure(xs)` equals `frame(xs.length)` plus the sum of `entry(x)`. That
 * holds for DAG-CBOR (an array is its header followed by its items) and for
 * JSON (items joined by commas inside fixed text) when entries encode
 * independently of their neighbours.
 */
export interface AdditiveBatchSizer<T> {
  /** Sizes of everything but the entries' own bytes, for `count` entries (array header, commas). */
  frame(count: number): BatchSizes;
  /** One entry's own encoded bytes. */
  entry(item: T): BatchSizes;
}

export interface BatchPackOptions<T> {
  maxCount?: number;
  maxCborBytes?: number;
  maxCreateBodyBytes?: number;
  /** Return exact encoded byte sizes for one candidate group. */
  measure(entries: readonly T[]): BatchSizes;
  /**
   * Exact additive sizes of the same encoding. When given, packing is linear:
   * candidates are sized by their sum, and each group boundary is checked
   * with `measure` (the group fits and equals the sum; the group plus the
   * next entry does not fit). A disagreement throws. Without it every
   * candidate group is measured whole (quadratic; small inputs only), and no
   * monotonicity of `measure` is assumed.
   */
  sizer?: AdditiveBatchSizer<T>;
}

export interface PackedBatch<T> {
  entries: T[];
  cborBytes: number;
  createBodyBytes: number;
}

interface PackLimits {
  maxCount: number;
  maxCborBytes: number;
  maxCreateBodyBytes: number;
}

function packLimits<T>(options: BatchPackOptions<T>): PackLimits {
  const maxCount = options.maxCount ?? BATCH_MAX_LISTENS;
  const maxCborBytes = options.maxCborBytes ?? MAX_CBOR_BYTES;
  const maxCreateBodyBytes = options.maxCreateBodyBytes ?? MAX_CREATE_BODY_BYTES;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > BATCH_MAX_LISTENS)
    throw new RangeError('invalid maxCount');
  if (!Number.isInteger(maxCborBytes) || maxCborBytes < 1 || maxCborBytes > MAX_CBOR_BYTES)
    throw new RangeError('maxCborBytes may only lower the hard limit');
  if (!Number.isInteger(maxCreateBodyBytes) || maxCreateBodyBytes < 1 || maxCreateBodyBytes > MAX_CREATE_BODY_BYTES)
    throw new RangeError('maxCreateBodyBytes may only lower the hard limit');
  return { maxCount, maxCborBytes, maxCreateBodyBytes };
}

function checkedSizes(sizes: BatchSizes, what: string): BatchSizes {
  if (
    !Number.isSafeInteger(sizes.cborBytes) ||
    sizes.cborBytes < 0 ||
    !Number.isSafeInteger(sizes.createBodyBytes) ||
    sizes.createBodyBytes < 0
  ) {
    throw new RangeError(`${what} must return non-negative safe integer byte counts`);
  }
  return sizes;
}

function within(sizes: BatchSizes, count: number, limits: PackLimits): boolean {
  return (
    count <= limits.maxCount &&
    sizes.cborBytes <= limits.maxCborBytes &&
    sizes.createBodyBytes <= limits.maxCreateBodyBytes
  );
}

/**
 * Greedy stable-order packer: each group is the longest run of the remaining
 * entries that fits, so every group but the last is full (its next entry did
 * not fit). An entry that cannot fit by itself is an error.
 */
export function packScrobbleBatchEntries<T>(entries: readonly T[], options: BatchPackOptions<T>): PackedBatch<T>[] {
  const limits = packLimits(options);
  const measure = (candidate: readonly T[]) => checkedSizes(options.measure(candidate), 'measure');
  if (options.sizer !== undefined) return packAdditive(entries, limits, measure, options.sizer);
  const packed: PackedBatch<T>[] = [];
  let current: T[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    const sizes = measure(candidate);
    if (!within(sizes, candidate.length, limits)) {
      if (current.length === 0) throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
      const previous = measure(current);
      packed.push({ entries: current, ...previous });
      current = [entry];
      if (!within(measure(current), 1, limits))
        throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
    } else current = candidate;
  }
  if (current.length > 0) packed.push({ entries: current, ...measure(current) });
  return packed;
}

/** Incremental exact sizing of one growing group (AdditiveBatchSizer). */
export class BatchPrefix<T> {
  private readonly items: T[] = [];
  private cbor = 0;
  private body = 0;

  constructor(
    private readonly sizer: AdditiveBatchSizer<T>,
    private readonly limits: PackLimits,
  ) {}

  get entries(): readonly T[] {
    return this.items;
  }

  /** Sizes of the group as it stands. */
  sizes(): BatchSizes {
    const frame = checkedSizes(this.sizer.frame(this.items.length), 'frame');
    return { cborBytes: frame.cborBytes + this.cbor, createBodyBytes: frame.createBodyBytes + this.body };
  }

  /** Appends `item` when the group with it still fits; otherwise leaves the group unchanged. */
  tryAdd(item: T): boolean {
    const own = checkedSizes(this.sizer.entry(item), 'entry');
    const count = this.items.length + 1;
    const frame = checkedSizes(this.sizer.frame(count), 'frame');
    const next = {
      cborBytes: frame.cborBytes + this.cbor + own.cborBytes,
      createBodyBytes: frame.createBodyBytes + this.body + own.createBodyBytes,
    };
    if (!within(next, count, this.limits)) return false;
    this.items.push(item);
    this.cbor += own.cborBytes;
    this.body += own.createBodyBytes;
    return true;
  }
}

/** A BatchPrefix under the default (or lowered) hard limits of `options`. */
export function newBatchPrefix<T>(
  sizer: AdditiveBatchSizer<T>,
  options: Omit<BatchPackOptions<T>, 'measure' | 'sizer'> = {},
): BatchPrefix<T> {
  return new BatchPrefix(sizer, packLimits({ ...options, measure: () => ({ cborBytes: 0, createBodyBytes: 0 }) }));
}

/**
 * Checks one group boundary with the whole-group `measure`: `group` fits and
 * has exactly the additive `sizes`; with `next` appended it does not fit.
 */
export function verifyBatchBoundary<T>(
  group: readonly T[],
  sizes: BatchSizes,
  next: T | undefined,
  options: Pick<BatchPackOptions<T>, 'measure' | 'maxCount' | 'maxCborBytes' | 'maxCreateBodyBytes'>,
): BatchSizes {
  const limits = packLimits({ ...options });
  const whole = checkedSizes(options.measure(group), 'measure');
  if (whole.cborBytes !== sizes.cborBytes || whole.createBodyBytes !== sizes.createBodyBytes)
    throw new Error('additive batch sizes disagree with the encoded group');
  if (!within(whole, group.length, limits)) throw new Error('packed batch exceeds its limits');
  if (next !== undefined && group.length + 1 <= limits.maxCount) {
    const grown = checkedSizes(options.measure([...group, next]), 'measure');
    if (within(grown, group.length + 1, limits)) throw new Error('packed batch stopped before a fitting entry');
  }
  return whole;
}

function packAdditive<T>(
  entries: readonly T[],
  limits: PackLimits,
  measure: (candidate: readonly T[]) => BatchSizes,
  sizer: AdditiveBatchSizer<T>,
): PackedBatch<T>[] {
  const packed: PackedBatch<T>[] = [];
  const options = { ...limits, measure };
  let prefix = new BatchPrefix(sizer, limits);
  const flush = (next: T | undefined) => {
    const group = [...prefix.entries];
    packed.push({ entries: group, ...verifyBatchBoundary(group, prefix.sizes(), next, options) });
  };
  for (const entry of entries) {
    if (prefix.tryAdd(entry)) continue;
    if (prefix.entries.length === 0) throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
    flush(entry);
    prefix = new BatchPrefix(sizer, limits);
    if (!prefix.tryAdd(entry)) throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
  }
  if (prefix.entries.length > 0) flush(undefined);
  return packed;
}
