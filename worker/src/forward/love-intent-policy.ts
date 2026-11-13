import type { OperationRow } from '../app/rows';
import type { Db } from '../do/db';
import { isUnsent } from '../outbox/operation-certainty';
import { deferredAuthorityValid } from './love-coverage-authority';

export type DeferredOrigin = 'operation' | 'authorized' | 'live_love' | 'unclassified';
export interface DeferredIntentPolicyRow {
  operation_id: string;
  origin_class: DeferredOrigin;
  authorization_uri?: string | null;
  authorization_rev?: string | null;
}
type OperationCertainty = Pick<
  OperationRow,
  'state' | 'attempts' | 'send_state' | 'send_started_at_ms' | 'legacy_absent_at_ms'
>;

export function classifyDeferredOrigin(
  db: Db,
  kind: 'love' | 'unlove',
  operationId: string,
  authorized: boolean,
): DeferredOrigin {
  if (authorized) return 'authorized';
  if (db.one('SELECT 1 AS present FROM operations WHERE id=?', operationId) !== null) return 'operation';
  return kind === 'love' ? 'live_love' : 'unclassified';
}

export function deferredIntentValid(db: Db, row: DeferredIntentPolicyRow): boolean {
  if (row.origin_class === 'authorized') {
    return (
      row.authorization_uri !== null &&
      row.authorization_uri !== undefined &&
      row.authorization_rev !== null &&
      row.authorization_rev !== undefined &&
      deferredAuthorityValid(db, { uri: row.authorization_uri, rev: row.authorization_rev })
    );
  }
  if (row.origin_class === 'unclassified') return true;
  const operation = db.one<Pick<OperationCertainty, 'state'>>(
    'SELECT state FROM operations WHERE id=?',
    row.operation_id,
  );
  return operation === null || operation.state !== 'cancelled';
}

/** Barriers are only extant live loves and extant non-withdrawable API operations. */
export function deferredIntentBarrier(db: Db, row: DeferredIntentPolicyRow): boolean {
  if (row.origin_class === 'live_love') return deferredIntentValid(db, row);
  if (row.origin_class !== 'operation') return false;
  const operation = db.one<OperationCertainty>(
    'SELECT state,attempts,send_state,send_started_at_ms,legacy_absent_at_ms FROM operations WHERE id=?',
    row.operation_id,
  );
  return operation !== null && deferredIntentValid(db, row) && !isUnsent(operation);
}

export function liveLoveSettled(db: Db, row: DeferredIntentPolicyRow): boolean {
  return (
    row.origin_class === 'live_love' &&
    db.one<{ state: string }>('SELECT state FROM operations WHERE id=?', row.operation_id)?.state === 'succeeded'
  );
}
