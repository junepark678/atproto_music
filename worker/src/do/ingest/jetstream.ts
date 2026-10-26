// The Jetstream message handler (ADR 0004 §5.4). Synchronous, no await.
//
// `onMessage(m, text, receiptMs)`:
// 1. Parses with the bounded W1-06 parser (`@atmusic/atproto/jetstream/events`).
//    Messages over 64 KiB, malformed JSON and malformed events are dropped and
//    counted (`counters('jetstream_invalid', reason)`); they carry no cursor
//    we can trust, so the checkpoint does not move.
// 2. A commit in a configured collection (scrobble, follow, settings or love)
//    becomes one untrusted hint
//    `(did, collection, rkey)` with the claimed revision and the receipt time
//    (the +300 s validation bound the drain applies later).
// 3. `enqueueHints` upserts the hint and advances the checkpoint
//    (`recordEvent`: cursor, last_event_time_us) in one transaction, so the
//    cursor can never run ahead of a durable hint. Jetstream's inclusive cursor
//    and at-least-once delivery are harmless because the hint upsert is
//    idempotent (one row per URI) and the drain applies by per-URI revision.
// 4. Ignored events that carry a cursor (other collections, other kinds,
//    unknown operations) still advance the cursor in that same way, with no
//    hint. Frames without a cursor (server info/error notices) are returned to
//    the caller (the socket treats an `OutdatedCursor` error as a rejected
//    cursor) and counted.
//
// A storage failure throws out of `onMessage` with nothing written; the socket
// then drops the connection and resumes from the unchanged checkpoint, so the
// failed event is replayed rather than skipped by a later one.

import { type JetstreamNotice, parseJetstreamMessage } from '@atmusic/atproto/jetstream/events';
import type { ModuleDeps } from '../contracts';
import { incrementCounter } from '../write/keys';
import { enqueueHints } from './hints';

export const JETSTREAM_INVALID_COUNTER = 'jetstream_invalid';
export const JETSTREAM_NOTICE_COUNTER = 'jetstream_notice';

export type MessageOutcome =
  | { kind: 'hint'; uri: string; seq: number; timeUs: number }
  | { kind: 'ignored'; seq: number; timeUs: number }
  | { kind: 'notice'; notice: JetstreamNotice }
  | { kind: 'invalid'; reason: string }
  /** The namespace gate is closed: nothing is subscribed, nothing is written. */
  | { kind: 'disabled' };

/**
 * The four subscribed collections (Jetstream `wantedCollections`), in a fixed
 * order: scrobble, follow, settings, love (ADR 0005 §6.3, B12).
 */
export function configuredCollections(m: Pick<ModuleDeps, 'config'>): string[] {
  const c = m.config.collections;
  return c === null ? [] : [c.scrobble, c.follow, c.settings, c.love];
}

export function onMessage(m: ModuleDeps, text: string, receiptMs: number): MessageOutcome {
  const collections = configuredCollections(m);
  if (collections.length === 0) return { kind: 'disabled' };
  const parsed = parseJetstreamMessage(text, collections);
  switch (parsed.kind) {
    case 'hint': {
      const checkpoint = { cursor: parsed.seq, timeUs: parsed.timeUs };
      let uri: string;
      try {
        [uri] = enqueueHints(
          m.db,
          [
            {
              did: parsed.did,
              collection: parsed.collection,
              rkey: parsed.rkey,
              source: 'jetstream',
              hintRev: parsed.rev,
              receiptMs,
            },
          ],
          checkpoint,
        ) as [string];
      } catch (error) {
        // The URI syntax check of the hint queue (stricter than the parser's)
        // rejected it: such a URI can never name a valid record. Skip the event
        // but keep its cursor, or it would be replayed forever.
        if (!(error instanceof RangeError)) throw error;
        m.db.tx(() => {
          incrementCounter(m.db, JETSTREAM_INVALID_COUNTER, 'uri');
          enqueueHints(m.db, [], checkpoint);
        });
        return { kind: 'invalid', reason: 'uri' };
      }
      return { kind: 'hint', uri, seq: parsed.seq, timeUs: parsed.timeUs };
    }
    case 'ignore': {
      if (parsed.seq !== undefined && parsed.timeUs !== undefined) {
        enqueueHints(m.db, [], { cursor: parsed.seq, timeUs: parsed.timeUs });
        return { kind: 'ignored', seq: parsed.seq, timeUs: parsed.timeUs };
      }
      const notice = parsed.notice ?? { type: 'info' as const, name: 'unknown' };
      m.db.tx(() => incrementCounter(m.db, JETSTREAM_NOTICE_COUNTER, `${notice.type}:${notice.name}`));
      m.log.log(notice.type === 'error' ? 'warn' : 'info', 'jetstream_notice', {
        type: notice.type,
        name: notice.name,
      });
      return { kind: 'notice', notice };
    }
  }
  m.db.tx(() => incrementCounter(m.db, JETSTREAM_INVALID_COUNTER, parsed.reason));
  return { kind: 'invalid', reason: parsed.reason };
}

/** A non-text frame (we never ask for compression): dropped and counted, no cursor. */
export function onBinaryMessage(m: ModuleDeps): MessageOutcome {
  m.db.tx(() => incrementCounter(m.db, JETSTREAM_INVALID_COUNTER, 'binary'));
  return { kind: 'invalid', reason: 'binary' };
}
