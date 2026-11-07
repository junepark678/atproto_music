/** Exact size helpers for scrobbleBatch writes; kept in atproto because core is I/O-free. */
import { encode } from '@atcute/cbor';
import { MAX_CBOR_BYTES, MAX_CREATE_BODY_BYTES, type ScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';

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

/** True only when both independent write limits are satisfied. */
export function fitsScrobbleBatch(sizes: ScrobbleBatchSizes): boolean {
  return sizes.cborBytes <= MAX_CBOR_BYTES && sizes.createBodyBytes <= MAX_CREATE_BODY_BYTES;
}
