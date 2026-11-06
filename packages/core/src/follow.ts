// Schema-v1 music follows, ported from crates/core/src/follow.rs. Verdicts,
// fields and messages equal tests/goldens/validation.json (followRecord and
// followSubject vectors).
//
// - The subject must have DID syntax (`validate_did_syntax`). That is syntax,
//   not identity resolution or repository verification.
// - Self-follows: the oracle rejects them on the write path (422 "self",
//   crates/server/src/http/follows/write.rs; `self_follow` in the PDS client),
//   and the projection table forbids them (`CHECK(actor != subject)`). So
//   `buildFollowRecord` always rejects one, and `validateFollowRecord` rejects
//   one whenever the caller supplies the repository DID (`actor`), which the
//   ingestion path always knows.
// - The deterministic follow rkey lives in record-key.ts (W1-03).

import type { Clock } from './deps';
import { collectionsFor, isValidPrefix } from './namespace';
import {
  type Build,
  fail,
  MSG_NOT_OBJECT,
  recordObject,
  requiredString,
  type Validation,
  type ValidationFailure,
} from './scrobble';
import { isDid } from './syntax';
import { nowNs, toRecordDatetime, toStorage, validateTimestamp } from './timestamp';

export interface FollowRecord {
  $type: string;
  subject: string;
  createdAt: string;
}

/** A validated remote follow, shaped for the `follows` table. */
export interface FollowRow {
  /** Known fields only, remote spelling kept. */
  record: FollowRecord;
  subject: string;
  /** 30-character storage form. */
  createdAt: string;
  createdAtNs: bigint;
}

export interface FollowInput {
  /** The signed-in repository DID that will own the record. */
  actor: string;
  subject: string;
}

export const MSG_DID = 'expected a DID';
export const MSG_FOLLOW_TYPE = 'record type does not match the configured music-follow collection';
export const MSG_SELF_FOLLOW = 'cannot follow yourself';

/** validate_did_syntax with the oracle's field name and message. */
export function validateDidSyntax(subject: unknown): { ok: true } | { ok: false; reason: ValidationFailure } {
  return typeof subject === 'string' && isDid(subject) ? { ok: true } : fail('subject', MSG_DID);
}

/**
 * FollowRecord::from_json for a remote record (unknown fields ignored), plus
 * the self-follow rule when `actor` (the repository DID) is given.
 */
export function validateFollowRecord(
  json: unknown,
  prefix: string,
  receiptNs: bigint,
  actor?: string,
): Validation<FollowRow> {
  const collection = collectionsFor(prefix).follow;
  if (typeof receiptNs !== 'bigint') throw new TypeError('receiptNs must be a bigint (nanoseconds since the epoch)');
  const object = recordObject(json);
  if (object === null) return fail('body', MSG_NOT_OBJECT);
  const type = requiredString(object, '$type');
  if (!type.ok) return type;
  if (type.value !== collection) return fail('$type', MSG_FOLLOW_TYPE);
  const subject = requiredString(object, 'subject');
  if (!subject.ok) return subject;
  const did = validateDidSyntax(subject.value);
  if (!did.ok) return did;
  const createdAt = requiredString(object, 'createdAt');
  if (!createdAt.ok) return createdAt;
  const created = validateTimestamp('createdAt', createdAt.value, receiptNs);
  if (!created.ok) return created;
  if (actor !== undefined && subject.value === actor) return fail('subject', MSG_SELF_FOLLOW);
  return {
    ok: true,
    row: {
      record: { $type: type.value, subject: subject.value, createdAt: createdAt.value },
      subject: subject.value,
      createdAt: toStorage(created.ns),
      createdAtNs: created.ns,
    },
  };
}

/**
 * FollowRecord::new for the SPA: subject DID syntax, no self-follow,
 * `createdAt` from the clock. Publishing additionally requires
 * `requirePublication` (namespace.ts).
 */
export function buildFollowRecord(input: FollowInput, prefix: string, clock: Clock): Build<FollowRecord> {
  if (!isValidPrefix(prefix)) throw new RangeError(`invalid lexicon prefix ${JSON.stringify(prefix)}`);
  if (typeof input.actor !== 'string' || !isDid(input.actor)) throw new TypeError('actor must be the session DID');
  const did = validateDidSyntax(input.subject);
  if (!did.ok) return did;
  if (input.subject === input.actor) return fail('subject', MSG_SELF_FOLLOW);
  return {
    ok: true,
    record: {
      $type: collectionsFor(prefix).follow,
      subject: input.subject,
      createdAt: toRecordDatetime(nowNs(clock)),
    },
  };
}
