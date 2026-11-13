import { expect, it, vi } from 'vitest';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  drainState,
  hasOrphanLiveEvidence,
  orphanRecoveryPending,
  scheduleDrainTimer,
} from '../../../src/do/ingest/verify-drain';
import { ALICE } from '../../write/support';
import { withMigratedDb } from '../support/node-db';
import { indexCore, runAlarmNow } from '../support/with-index';

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

it('evidence retained after the startup orphan scan does not keep rearming empty drains', async () => {
  await withMigratedDb(async (db) => {
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
    const fixture = indexCore(db);
    fixture.core.start();
    expect(db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name='drain'")?.due_at).toBe(NOW);

    // The startup drain finishes its single-page orphan scan and re-hints the evidence.
    await runAlarmNow(fixture.core);
    expect(db.all<{ uri: string }>('SELECT uri FROM hints')).toEqual([{ uri: URI }]);

    // The proof is applied: the hint is gone, but the evidence is deliberately retained
    // (as `applyVerified` does for evidence with a conflict) and still matches the orphan predicate.
    db.run('DELETE FROM hints WHERE uri=?', URI);
    expect(hasOrphanLiveEvidence(db, NOW)).toBe(true);

    // The next drain has nothing to do; neither it nor the core lane's timer reconciliation
    // may arm another drain for evidence the completed scan already covered.
    fixture.clock.advance(2_000);
    await runAlarmNow(fixture.core);
    expect(db.one("SELECT due_at FROM timers WHERE name='drain'")).toBeNull();
    fixture.clock.advance(60_000);
    await runAlarmNow(fixture.core);
    expect(db.one("SELECT due_at FROM timers WHERE name='drain'")).toBeNull();
  });
});

it('orphan discovery reads live evidence once at start-up and never on per-hint reconciliation', async () => {
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
    const one = vi.spyOn(db, 'one');
    const all = vi.spyOn(db, 'all');
    const discoveryReads = () =>
      [...one.mock.calls, ...all.mock.calls].filter(([sql]) => /FROM live_record_evidence e\b/.test(String(sql)))
        .length;

    const fixture = indexCore(db);
    fixture.core.start();
    expect(discoveryReads()).toBe(1);
    expect(db.one<{ due_at: number }>("SELECT due_at FROM timers WHERE name='drain'")?.due_at).toBe(NOW);

    // Hints keep arriving before the first drain (no drain state yet) and while it is in
    // flight (state allocated, no committed cursor): the start-up answer holds, query-free.
    for (let i = 0; i < 1000; i++) expect(orphanRecoveryPending(db)).toBe(true);
    const state = drainState(db, { concurrentFetches: 1, perHostConcurrency: 1 });
    for (let i = 0; i < 1000; i++) expect(orphanRecoveryPending(db)).toBe(true);
    // A paged scan under way, then a completed one.
    state.orphanCursor = URI;
    for (let i = 0; i < 1000; i++) expect(orphanRecoveryPending(db)).toBe(true);
    state.orphanReconciled = true;
    for (let i = 0; i < 1000; i++) expect(orphanRecoveryPending(db)).toBe(false);
    expect(discoveryReads()).toBe(1);
  });
});

it('a start-up without orphan evidence never arms orphan recovery', async () => {
  await withMigratedDb((db) => {
    const fixture = indexCore(db);
    fixture.core.start();
    expect(orphanRecoveryPending(db)).toBe(false);
    expect(db.one("SELECT due_at FROM timers WHERE name='drain'")).toBeNull();
  });
});
