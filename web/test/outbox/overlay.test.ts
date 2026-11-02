import { expect, it } from 'vitest';
import { overlayScrobbles, type OutboxOperation } from '../../src/outbox/overlay';
import { DID, example } from '../routes/support';

const base = {
  id: 'op-delete', did: DID, kind: 'scrobble_delete' as const,
  uri: `at://${DID}/com.example.atmusic.scrobble/r01`, seq: 1, dueAt: Date.now(),
  attempts: 0, notified: true, polls: 0, createdAt: Date.now(), updatedAt: Date.now(),
};

it('pending owner delete hides the record, while a failed delete stays visible with its failure', () => {
  const page = example<{ items: Array<{ uri: string; did: string; artist: string; track: string; listenedAt: string }> }>('scrobble-page').items as never[];
  const pending: OutboxOperation = { ...base, state: 'queued' };
  expect(overlayScrobbles(page, [pending], DID).items).toHaveLength(0);
  const failed: OutboxOperation = { ...base, state: 'failed', dueAt: null, failureCode: 'upstream_error' };
  const result = overlayScrobbles(page, [failed], DID);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.local).toMatchObject({ state: 'failed', failureCode: 'upstream_error' });
});
