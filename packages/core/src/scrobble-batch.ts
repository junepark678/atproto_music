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

export const BATCH_MAX_LISTENS = 200;
export const MAX_CBOR_BYTES = 64_000;
export const MAX_CREATE_BODY_BYTES = 100_000;
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

export interface BatchPackOptions<T> {
  maxCount?: number;
  maxCborBytes?: number;
  maxCreateBodyBytes?: number;
  /** Return exact encoded byte sizes for one candidate group. */
  measure(entries: readonly T[]): { cborBytes: number; createBodyBytes: number };
}

export interface PackedBatch<T> {
  entries: T[];
  cborBytes: number;
  createBodyBytes: number;
}

/** Greedy stable-order packer. An entry that cannot fit by itself is an error. */
export function packScrobbleBatchEntries<T>(entries: readonly T[], options: BatchPackOptions<T>): PackedBatch<T>[] {
  const maxCount = options.maxCount ?? BATCH_MAX_LISTENS;
  const maxCborBytes = options.maxCborBytes ?? MAX_CBOR_BYTES;
  const maxCreateBodyBytes = options.maxCreateBodyBytes ?? MAX_CREATE_BODY_BYTES;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > BATCH_MAX_LISTENS)
    throw new RangeError('invalid maxCount');
  if (!Number.isInteger(maxCborBytes) || maxCborBytes < 1 || maxCborBytes > MAX_CBOR_BYTES)
    throw new RangeError('maxCborBytes may only lower the hard limit');
  if (!Number.isInteger(maxCreateBodyBytes) || maxCreateBodyBytes < 1 || maxCreateBodyBytes > MAX_CREATE_BODY_BYTES)
    throw new RangeError('maxCreateBodyBytes may only lower the hard limit');
  const measure = (candidate: readonly T[]) => {
    const sizes = options.measure(candidate);
    if (
      !Number.isSafeInteger(sizes.cborBytes) ||
      sizes.cborBytes < 0 ||
      !Number.isSafeInteger(sizes.createBodyBytes) ||
      sizes.createBodyBytes < 0
    ) {
      throw new RangeError('measure must return non-negative safe integer byte counts');
    }
    return sizes;
  };
  const packed: PackedBatch<T>[] = [];
  let current: T[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    const sizes = measure(candidate);
    if (candidate.length > maxCount || sizes.cborBytes > maxCborBytes || sizes.createBodyBytes > maxCreateBodyBytes) {
      if (current.length === 0) throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
      const previous = measure(current);
      packed.push({ entries: current, ...previous });
      current = [entry];
      const single = measure(current);
      if (single.cborBytes > maxCborBytes || single.createBodyBytes > maxCreateBodyBytes) {
        throw new RangeError('one listen exceeds the scrobbleBatch byte limits');
      }
    } else current = candidate;
  }
  if (current.length > 0) packed.push({ entries: current, ...measure(current) });
  return packed;
}
