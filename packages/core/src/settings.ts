// The `<prefix>.settings` record (ADR 0004 §5.3, A10, lexicons/settings.json):
// the owner's repo-signed indexing choice at the literal record key `self`.
// `indexing: "disabled"` asks this AppView to drop its local copy and keep a
// suppression marker; it erases nothing on the PDS. The record is public.
//
// Validation follows the scrobble and follow rules: an open lexicon object
// (unknown fields ignored), `$type` equal to the configured collection, and
// `createdAt` within 1970-01-01 .. receipt + 300 s.

import type { Clock } from './deps';
import { collectionsFor, isValidPrefix } from './namespace';
import { type Build, fail, MSG_NOT_OBJECT, recordObject, requiredString, type Validation } from './scrobble';
import { nowNs, toRecordDatetime, toStorage, validateTimestamp } from './timestamp';

/** `key: "literal:self"` in lexicons/settings.json. */
export const SETTINGS_RKEY = 'self';
export const INDEXING_VALUES = ['enabled', 'disabled'] as const;
export type Indexing = (typeof INDEXING_VALUES)[number];

export interface SettingsRecord {
  $type: string;
  indexing: Indexing;
  createdAt: string;
}

export interface SettingsRow {
  record: SettingsRecord;
  indexing: Indexing;
  /** 30-character storage form. */
  createdAt: string;
  createdAtNs: bigint;
}

export const MSG_SETTINGS_TYPE = 'record type does not match the configured settings collection';
export const MSG_SETTINGS_RKEY = 'expected the literal record key self';
export const MSG_INDEXING = 'expected enabled or disabled';

function isIndexing(value: string): value is Indexing {
  return (INDEXING_VALUES as readonly string[]).includes(value);
}

/** Validate a remote settings record stored at `rkey` in the owner's repository. */
export function validateSettingsRecord(
  json: unknown,
  prefix: string,
  receiptNs: bigint,
  rkey: string,
): Validation<SettingsRow> {
  const collection = collectionsFor(prefix).settings;
  if (typeof receiptNs !== 'bigint') throw new TypeError('receiptNs must be a bigint (nanoseconds since the epoch)');
  if (rkey !== SETTINGS_RKEY) return fail('rkey', MSG_SETTINGS_RKEY);
  const object = recordObject(json);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const type = requiredString(object, '$type');
  if (!type.ok) return type;
  if (type.value !== collection) return fail('$type', MSG_SETTINGS_TYPE);
  const indexing = requiredString(object, 'indexing');
  if (!indexing.ok) return indexing;
  if (!isIndexing(indexing.value)) return fail('indexing', MSG_INDEXING);
  const createdAt = requiredString(object, 'createdAt');
  if (!createdAt.ok) return createdAt;
  const created = validateTimestamp('createdAt', createdAt.value, receiptNs);
  if (!created.ok) return created;
  return {
    ok: true,
    row: {
      record: { $type: type.value, indexing: indexing.value, createdAt: createdAt.value },
      indexing: indexing.value,
      createdAt: toStorage(created.ns),
      createdAtNs: created.ns,
    },
  };
}

/** The SPA's settings record, always written at `SETTINGS_RKEY`. */
export function buildSettingsRecord(indexing: unknown, prefix: string, clock: Clock): Build<SettingsRecord> {
  if (!isValidPrefix(prefix)) throw new RangeError(`invalid lexicon prefix ${JSON.stringify(prefix)}`);
  if (typeof indexing !== 'string' || !isIndexing(indexing)) return fail('indexing', MSG_INDEXING);
  return {
    ok: true,
    record: { $type: collectionsFor(prefix).settings, indexing, createdAt: toRecordDatetime(nowNs(clock)) },
  };
}
