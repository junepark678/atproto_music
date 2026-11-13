import { expect, it } from 'vitest';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { hasOrphanLiveEvidence, scheduleDrainTimer } from '../../../src/do/ingest/verify-drain';
import { ALICE } from '../../write/support';
import { withMigratedDb } from '../support/node-db';
import { indexCore } from '../support/with-index';

const URI = `at://${ALICE}/com.example.atmusic.scrobble/orphan`;
const NOW = Date.parse('2026-01-15T12:00:00Z');

it('startup schedules a bounded orphan-evidence drain without hints or pending removals', async () => {
  await withMigratedDb((db) => {
    recordLiveEvidence(
      db,
      {
        uri: URI,
        did: ALICE,
        collection: 'com.example.atmusic.scrobble',
        rkey: 'orphan',
        rev: '3mchjvhag2322',
        action: 'create',
        cid: 'orphan-cid',
      },
      NOW,
    );
    expect(db.all('SELECT uri FROM hints')).toEqual([]);
    expect(db.all('SELECT uri FROM live_pending_removals')).toEqual([]);
    expect(hasOrphanLiveEvidence(db, NOW)).toBe(true);

    const fixture = indexCore(db);
    fixture.core.start();
    expect(db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name='drain'")?.due_at).toBe(NOW);

    enqueueHints(db, [
      {
        did: ALICE,
        collection: 'com.example.atmusic.scrobble',
        rkey: 'orphan',
        source: 'reconcile',
        hintRev: '3mchjvhag2322',
        receiptMs: NOW,
      },
    ]);
    expect(hasOrphanLiveEvidence(db, NOW)).toBe(false);
    expect(scheduleDrainTimer(db, NOW, true)).toBe(NOW + 2_000);
  });
});
