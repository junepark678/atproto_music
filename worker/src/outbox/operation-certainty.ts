import type { OperationRow } from '../app/rows';

/** The existing operation send-certainty predicate, kept in a dependency-free leaf. */
export function explicitlyUnsent(
  op: Pick<OperationRow, 'send_state' | 'attempts' | 'send_started_at_ms' | 'legacy_absent_at_ms'>,
): boolean {
  return (
    op.send_state === 'unsent' && op.attempts === 0 && op.send_started_at_ms === null && op.legacy_absent_at_ms === null
  );
}

/** `explicitlyUnsent` as SQL over the operations alias `o`. */
export function explicitlyUnsentSql(o = 'o'): string {
  if (!/^[a-z_]+$/.test(o)) throw new RangeError('invalid alias');
  return `(${o}.send_state = 'unsent' AND ${o}.attempts = 0 AND ${o}.send_started_at_ms IS NULL AND ${o}.legacy_absent_at_ms IS NULL)`;
}

/** An unsent operation: queued or blocked and explicitly never sent. */
export function isUnsent(
  op: Pick<OperationRow, 'state' | 'attempts' | 'send_state' | 'send_started_at_ms' | 'legacy_absent_at_ms'>,
): boolean {
  return (op.state === 'queued' || op.state === 'blocked') && explicitlyUnsent(op);
}
