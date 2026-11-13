import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import {
  ensureOwnerResnapshotTimer,
  OWNER_RESNAPSHOT_INTERVAL_MS,
  OWNER_RESNAPSHOT_TIMER,
  runOwnerResnapshot,
} from '../../../src/do/ingest/owner-resnapshot';
import { dueAt } from '../../../src/do/timers';
import { withMigratedDb } from '../support/node-db';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'did:plc:cccccccccccccccccccccccc';

function owner(db: Db, did: string, username: string): void {
  db.run('INSERT INTO accounts(did,username,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', did, username, NOW, NOW);
}
function user(db: Db, did: string, active = 1, status = 'active'): void {
  db.run(
    `INSERT INTO users(did,joined_at,active,account_status,indexing_state,generation)
     VALUES(?, '2026-11-13T00:00:00Z', ?, ?, 'current', 1)`,
    did,
    active,
    status,
  );
}

describe('owner signed resnapshot scheduler', () => {
  it('accepts exactly at the hourly boundary, stores a durable receipt, and preserves an in-flight frontier', async () => {
    await withMigratedDb((db) => {
      owner(db, A, 'alice');
      user(db, A);
      db.run(
        "INSERT INTO repo_jobs(did,kind,state,generation,reason,due_at,frontier_json,updated_at_ms) VALUES(?,'snapshot','running',1,'existing',?,?,?)",
        A,
        NOW,
        '{"frontier":1}',
        NOW,
      );
      const first = runOwnerResnapshot(db, NOW);
      expect(first).toMatchObject({ accepted: 1, refused: 0 });
      expect(db.one("SELECT frontier_json,reason,state FROM repo_jobs WHERE did=? AND kind='snapshot'", A)).toEqual({
        frontier_json: '{"frontier":1}',
        reason: 'existing',
        state: 'running',
      });
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", A)).toEqual({
        value: NOW,
      });
      expect(runOwnerResnapshot(db, NOW + OWNER_RESNAPSHOT_INTERVAL_MS - 1).examined).toBe(0);
      expect(runOwnerResnapshot(db, NOW + OWNER_RESNAPSHOT_INTERVAL_MS).accepted).toBe(1);
    });
  });

  it('admits missing local owners, leaves suppressed and inactive owners untouched, and retries capacity refusal', async () => {
    await withMigratedDb((db) => {
      owner(db, A, 'alice');
      owner(db, B, 'bobby');
      owner(db, C, 'carol');
      user(db, B, 0, 'deactivated');
      db.run("INSERT INTO suppression(did,suppressed_at) VALUES(?, '2026-11-13T00:00:00Z')", C);
      const report = runOwnerResnapshot(db, NOW);
      expect(report.accepted).toBe(1);
      expect(db.one('SELECT active,account_status FROM users WHERE did=?', A)).toEqual({
        active: 0,
        account_status: 'unknown',
      });
      expect(db.one("SELECT 1 AS x FROM repo_jobs WHERE did=? AND kind='snapshot'", B)).toBeNull();
      expect(db.one('SELECT 1 AS x FROM users WHERE did=?', C)).toBeNull();
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", B)).toBeNull();
    });
  });

  it('bounds a pass and preserves startup deadlines and running-timer recovery', async () => {
    await withMigratedDb((db) => {
      ensureOwnerResnapshotTimer(db, NOW, true);
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBe(NOW);
      db.run('UPDATE timers SET due_at=? WHERE name=?', NOW + 12_345, OWNER_RESNAPSHOT_TIMER);
      ensureOwnerResnapshotTimer(db, NOW + 1, true);
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBe(NOW + 12_345);
      db.run('UPDATE timers SET name=? WHERE name=?', `~running:${OWNER_RESNAPSHOT_TIMER}`, OWNER_RESNAPSHOT_TIMER);
      ensureOwnerResnapshotTimer(db, NOW + 2, true);
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBeNull();
      ensureOwnerResnapshotTimer(db, NOW + 2, false);
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBeNull();
    });
  });

  it('retries the remaining owners after its 50-owner batch instead of waiting an hour', async () => {
    await withMigratedDb((db) => {
      for (let i = 0; i < 51; i++) {
        const suffix = String(i).padStart(24, '0');
        const did = `did:plc:${suffix}`;
        owner(db, did, `owner${String(i).padStart(2, '0')}`);
        user(db, did);
      }
      const first = runOwnerResnapshot(db, NOW);
      expect(first).toMatchObject({ examined: 50, accepted: 50, refused: 0, nextAt: NOW + 60_000 });
      const second = runOwnerResnapshot(db, NOW + 60_000);
      expect(second).toMatchObject({ examined: 1, accepted: 1, refused: 0 });
    });
  });

  it('does not receipt a budget-refused owner and admits it when the next window opens', async () => {
    await withMigratedDb((db) => {
      owner(db, A, 'alice');
      db.run('INSERT INTO admission(window_start_ms,admitted) VALUES(?,50)', NOW - (NOW % 3_600_000));
      const refused = runOwnerResnapshot(db, NOW);
      expect(refused).toMatchObject({ accepted: 0, refused: 1, nextAt: NOW + 60_000 });
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", A)).toBeNull();
      expect(db.one('SELECT 1 AS x FROM users WHERE did=?', A)).toBeNull();

      const recovered = runOwnerResnapshot(db, NOW + OWNER_RESNAPSHOT_INTERVAL_MS);
      expect(recovered.accepted).toBe(1);
      expect(db.one('SELECT active,account_status FROM users WHERE did=?', A)).toEqual({
        active: 0,
        account_status: 'unknown',
      });
    });
  });

  it('does not receipt a queue-refused known owner and schedules it after capacity returns', async () => {
    await withMigratedDb((db) => {
      owner(db, A, 'alice');
      user(db, A);
      for (let i = 0; i < 1024; i++) {
        db.run(
          `INSERT INTO repo_jobs(did,kind,state,generation,reason,due_at,updated_at_ms)
           VALUES(?, 'snapshot', 'pending', 1, 'fixture', ?, ?)`,
          `did:plc:${String(i).padStart(24, '0')}`,
          NOW,
          NOW,
        );
      }
      const refused = runOwnerResnapshot(db, NOW);
      expect(refused).toMatchObject({ accepted: 0, refused: 1, nextAt: NOW + 60_000 });
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", A)).toBeNull();

      db.run("DELETE FROM repo_jobs WHERE reason='fixture'");
      const recovered = runOwnerResnapshot(db, NOW + 60_000);
      expect(recovered.accepted).toBe(1);
      expect(db.one("SELECT reason,state FROM repo_jobs WHERE did=? AND kind='snapshot'", A)).toEqual({
        reason: 'owner_resnapshot',
        state: 'pending',
      });
    });
  });
});
