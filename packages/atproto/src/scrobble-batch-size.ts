/** Exact size helpers for scrobbleBatch writes; kept in atproto because core is I/O-free. */
import { encode } from '@atcute/cbor';
import {
  type AdditiveBatchSizer,
  MAX_CBOR_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_WRITE_BODY_BYTES,
  type ScrobbleBatchEntry,
  type ScrobbleBatchRecord,
} from '@atmusic/core/scrobble-batch';

export interface CreateRecordRequestBody {
  repo: string;
  collection: string;
  rkey: string;
  record: ScrobbleBatchRecord;
}

export interface ScrobbleBatchSizes {
  cborBytes: number;
  createBodyBytes: number;
}

const utf8 = new TextEncoder();

/** Exact UTF-8 byte length of `JSON.stringify(value)`: the body PdsXrpc.procedure sends. */
export function jsonBodyBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

/** Serialize the exact createRecord JSON body whose bytes must fit the cap. */
export function encodeScrobbleBatchCreateBody(
  record: ScrobbleBatchRecord,
  request: Omit<CreateRecordRequestBody, 'record'>,
): Uint8Array {
  return utf8.encode(JSON.stringify({ ...request, record }));
}

/** Measures the record block and exact UTF-8 JSON bytes sent to createRecord. */
export function measureScrobbleBatch(
  record: ScrobbleBatchRecord,
  request: Omit<CreateRecordRequestBody, 'record'>,
): ScrobbleBatchSizes {
  return {
    cborBytes: new Uint8Array(encode(record)).byteLength,
    createBodyBytes: encodeScrobbleBatchCreateBody(record, request).byteLength,
  };
}

/** True only when both independent write limits are satisfied (the packing target). */
export function fitsScrobbleBatch(sizes: ScrobbleBatchSizes): boolean {
  return sizes.cborBytes <= MAX_CBOR_BYTES && sizes.createBodyBytes <= MAX_CREATE_BODY_BYTES;
}

/** True when a durable container may still be sent: within the hard write ceiling. */
export function sendableScrobbleBatch(sizes: ScrobbleBatchSizes): boolean {
  return sizes.cborBytes <= MAX_CBOR_BYTES && sizes.createBodyBytes <= MAX_WRITE_BODY_BYTES;
}

/** Bytes of a DAG-CBOR major-type header for `n` (array length, string length). */
function cborHeaderBytes(n: number): number {
  if (n < 24) return 1;
  if (n < 0x100) return 2;
  if (n < 0x10000) return 3;
  if (n < 0x100000000) return 5;
  return 9;
}

/**
 * The exact additive sizer of `measureScrobbleBatch` for containers with the
 * envelope `{$type, createdAt}` (and any other envelope fields) and the
 * createRecord `request`: DAG-CBOR is the record with an empty `listens`
 * array, with its one-byte empty-array header replaced by the header for the
 * count, plus each entry's own encoding; the JSON body is the body with
 * `"listens":[]` plus each entry's own JSON and a comma between entries.
 * packScrobbleBatchEntries verifies every group boundary against
 * measureScrobbleBatch.
 */
export function scrobbleBatchSizer(
  envelope: Omit<ScrobbleBatchRecord, 'listens'>,
  request: Omit<CreateRecordRequestBody, 'record'>,
): AdditiveBatchSizer<ScrobbleBatchEntry> {
  const empty = measureScrobbleBatch({ ...envelope, listens: [] }, request);
  const emptyHeader = cborHeaderBytes(0);
  return {
    frame: (count) => ({
      cborBytes: empty.cborBytes - emptyHeader + cborHeaderBytes(count),
      createBodyBytes: empty.createBodyBytes + Math.max(0, count - 1),
    }),
    entry: (entry) => ({
      cborBytes: new Uint8Array(encode(entry)).byteLength,
      createBodyBytes: jsonBodyBytes(entry),
    }),
  };
}
