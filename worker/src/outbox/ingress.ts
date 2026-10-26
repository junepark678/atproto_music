// The one listen ingress (ADR 0005 §7.7 "Accepted entries", §8.3, §5.7; N2-05).
// `/2.0` track.scrobble (N3-03), `/1/submit-listens` (N3-05) and web
// scrobbles (N3-02) all call `acceptListens`, so every live listen gets the
// same rules:
//
// 1. Each listen's record is built with `buildScrobbleRecord` (closed input)
//    with `createdAt` = the receipt time, or `notBeforeMs` for a deferred
//    listen (ADR §8.3: a ListenBrainz listen up to an hour ahead is accepted
//    with `due_at = createdAt = listened_at − 300 s`, so it is never sent
//    before it is valid). Its canonical digest and its listen key
//    `sha256(did ‖ floor(listenedAt s) ‖ artist_key ‖ track_key)`
//    (packages/core/src/listen-key.ts) are computed before the transaction.
// 2. In **one transaction**:
//    - a listen key already in `listen_keys` (or twice in the request) is
//      accepted again with no new operation: an idempotent client resend;
//    - the daily cap: listens accepted for the DID through live ingress in
//      the rolling 24 h before the receipt (`accounts.daily_listen_cap`,
//      default 3,000) — an entry over it is reported `over_cap` and creates
//      nothing;
//    - otherwise the `listen_keys` row, a `scrobble.create` operation (TID
//      rkey allocated now, live priority 0, `due_at` = receipt or notBefore)
//      and the forward rows for the DID's active links with forward_scrobbles
//      (`enqueueForwards`, dedupe key = the listen key) are written.
//    A throw anywhere rolls back every row of the request.
// 3. Only after the commit is the outbox kicked and the result returned: an
//    accepted listen is durably queued, not yet on the PDS.
//
// Invalid entries (`invalid`) are reported per listen and never written; the
// protocol layers decide how to answer them. Imports never come through here
// (they are not forwarded and not capped, ADR §11.2).

import { listenKey } from '@atmusic/core/listen-key';
import type { ScrobbleRecord, ValidationFailure } from '@atmusic/core/scrobble';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import type { Origin } from '../app/rows';
import type { ModuleDeps } from '../do/contracts';
import { enqueueForwards } from './forward-enqueue';
import { type Idempotency, idempotentOperation, newOperationId, type Prepared } from './operations';
import { insertScrobbleCreate, prepareScrobble } from './scrobble-ops';

export const DAILY_CAP_WINDOW_MS = 24 * 3_600_000;
export const DEFAULT_DAILY_LISTEN_CAP = 3_000;

export type LiveOrigin = Exclude<Origin, 'import'>;

export interface IngressListen {
  /** The mapped listen (`ScrobbleInput`: artist, track, listenedAt, optional fields); closed. */
  input: unknown;
  /** Deferred listen: not sent before, and `createdAt` equal to, this instant (epoch ms, ≥ receipt). */
  notBeforeMs?: number;
  /** What the forward clients send upstream (the original, uncorrected entry); defaults to `input`. */
  forward?: unknown;
}

export interface AcceptListensArgs {
  did: string;
  origin: LiveOrigin;
  listens: readonly IngressListen[];
  /** When the request was received (epoch ms, injected clock). */
  receiptMs: number;
  /** Web scrobbles (`POST /api/v1/scrobbles`, one listen): the Idempotency-Key and the request hash. */
  idempotency?: Idempotency;
  /** Kicks the outbox timer after the commit. */
  kick?: () => void;
}

export type ListenResult =
  /** Durably queued; `duplicate` when the listen key was already accepted (no new operation). */
  | { status: 'accepted'; operationId: string | null; listenKey: string; duplicate: boolean }
  /** Over the daily cap: nothing was written. */
  | { status: 'over_cap'; listenKey: string }
  /** Refused by the scrobble validator: nothing was written. */
  | { status: 'invalid'; reason: ValidationFailure };

export interface AcceptListensResult {
  results: ListenResult[];
  /** Operations created by this request. */
  created: number;
  /** The DID's daily cap and what is left of it after this request. */
  cap: number;
  remaining: number;
}

type Prep =
  | { ok: true; prepared: Prepared<ScrobbleRecord>; key: string; dueAt: number; forward: unknown }
  | { ok: false; reason: ValidationFailure };

function assertEpochMs(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of epoch ms, got ${value}`);
  }
}

async function prepareListen(did: string, prefix: string, listen: IngressListen, receiptMs: number): Promise<Prep> {
  const notBefore = listen.notBeforeMs;
  if (notBefore !== undefined) {
    assertEpochMs('notBeforeMs', notBefore);
    if (notBefore < receiptMs) throw new RangeError('notBeforeMs must not be before the receipt time');
  }
  const createdAtMs = notBefore ?? receiptMs;
  const built = await prepareScrobble(listen.input, prefix, createdAtMs);
  if (!built.ok) return built;
  const record = built.prepared.record;
  const listenedAtNs = parseRfc3339(record.listenedAt);
  if (listenedAtNs === null) {
    return { ok: false, reason: { field: 'listenedAt', code: 'invalid_field', message: 'invalid listenedAt' } };
  }
  const key = await listenKey({ did, listenedAtNs, artist: record.artist, track: record.track });
  return { ok: true, prepared: built.prepared, key, dueAt: createdAtMs, forward: listen.forward ?? listen.input };
}

/** The DID's daily listen cap (accounts.daily_listen_cap, default 3,000). */
export function dailyListenCap(m: Pick<ModuleDeps, 'db'>, did: string): number {
  const row = m.db.one<{ daily_listen_cap: number }>('SELECT daily_listen_cap FROM accounts WHERE did = ?', did);
  return row?.daily_listen_cap ?? DEFAULT_DAILY_LISTEN_CAP;
}

/** Listens accepted for `did` through live ingress in the 24 h before `receiptMs`. */
export function acceptedInWindow(m: Pick<ModuleDeps, 'db'>, did: string, receiptMs: number): number {
  return (
    m.db.one<{ n: number }>(
      `SELECT count(*) AS n FROM listen_keys WHERE did = ? AND source != 'import' AND created_at_ms > ?`,
      did,
      receiptMs - DAILY_CAP_WINDOW_MS,
    )?.n ?? 0
  );
}

/** Accepts a request's listens (see the header). */
export async function acceptListens(m: ModuleDeps, args: AcceptListensArgs): Promise<AcceptListensResult> {
  const prefix = m.config.prefix;
  if (prefix === null) throw new RangeError('the namespace gate is closed: no lexicon prefix');
  if ((args.origin as Origin) === 'import') throw new RangeError('imports do not go through acceptListens');
  assertEpochMs('receiptMs', args.receiptMs);
  if (args.idempotency !== undefined && args.listens.length !== 1) {
    throw new RangeError('an Idempotency-Key covers exactly one listen');
  }
  const preps: Prep[] = [];
  for (const listen of args.listens) preps.push(await prepareListen(args.did, prefix, listen, args.receiptMs));

  const db = m.db;
  const now = args.receiptMs;
  const outcome = db.tx((): AcceptListensResult => {
    const cap = dailyListenCap(m, args.did);
    let used = acceptedInWindow(m, args.did, now);
    if (args.idempotency !== undefined) {
      const existing = idempotentOperation(db, args.did, args.idempotency);
      const prep = preps[0];
      if (existing !== null && prep !== undefined) {
        return {
          results: [
            prep.ok
              ? { status: 'accepted', operationId: existing.id, listenKey: prep.key, duplicate: true }
              : { status: 'invalid', reason: prep.reason },
          ],
          created: 0,
          cap,
          remaining: Math.max(0, cap - used),
        };
      }
    }
    const seen = new Map<string, string | null>();
    const results: ListenResult[] = [];
    let created = 0;
    for (const prep of preps) {
      if (!prep.ok) {
        results.push({ status: 'invalid', reason: prep.reason });
        continue;
      }
      const earlier = seen.has(prep.key)
        ? { operation_id: seen.get(prep.key) ?? null }
        : db.one<{ operation_id: string | null }>(
            'SELECT operation_id FROM listen_keys WHERE did = ? AND dedupe_key = ?',
            args.did,
            prep.key,
          );
      if (earlier !== null) {
        results.push({ status: 'accepted', operationId: earlier.operation_id, listenKey: prep.key, duplicate: true });
        continue;
      }
      if (used >= cap) {
        results.push({ status: 'over_cap', listenKey: prep.key });
        continue;
      }
      // ADR §7.7 step 3, in order: the listen key, the operation, the forward rows.
      const operationId = newOperationId(m.random);
      db.run(
        `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
        args.did,
        prep.key,
        operationId,
        args.origin,
        now,
      );
      const op = insertScrobbleCreate(
        m,
        {
          id: operationId,
          did: args.did,
          origin: args.origin,
          prepared: prep.prepared,
          dueAt: prep.dueAt,
          idempotency: args.idempotency ?? null,
        },
        now,
      );
      enqueueForwards(db, {
        did: args.did,
        items: [{ kind: 'scrobble', listenKey: prep.key, payload: { listen: prep.forward, origin: args.origin } }],
        now,
        random: m.random,
      });
      seen.set(prep.key, op.id);
      used += 1;
      created += 1;
      results.push({ status: 'accepted', operationId: op.id, listenKey: prep.key, duplicate: false });
    }
    return { results, created, cap, remaining: Math.max(0, cap - used) };
  });
  if (outcome.created > 0) args.kick?.();
  return outcome;
}
