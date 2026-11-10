import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import {
  ADMISSION_HIGH_WATER_SQL,
  GAP_ADMISSION_OWNER_SQL,
  NEWEST_OPEN_LINK_GAP_SQL,
} from '../../../src/forward/coverage';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { deleteQueuedForwardIdentity } from '../../../src/outbox/forward-key';
import {
  FORWARD_OUTBOX_COVERAGE_SQL,
  FORWARD_RECEIPT_LOOKUP_SQL,
  forwardCoverage,
  releaseUnsentReceiptsSql,
} from '../../../src/outbox/forward-receipts';
import { withMigratedDb } from '../support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const LINK = { id: 'link-receipt-test', generation: 1 };
const ITEM = {
  kind: 'scrobble' as const,
  listenKey: 'listen-1',
  payload: { listen: { artist: 'Artist', track: 'Track' } },
};

async function withLink(run: (db: Db) => void) {
  await withMigratedDb((db) => {
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES(?,?,'lastfm','remote',X'00','key',1,1)`,
      LINK.id,
      DID,
    );
    run(db);
  });
}

describe('forward enqueue coverage receipts', () => {
  it('records a legacy outbox identity lazily and releases it before explicit unsent withdrawal', async () => {
    await withLink((db) => {
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 10, random: seededRandom(7) })).toBe(1);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
      expect(db.one('SELECT generation,kind,dedupe_key FROM forward_receipts')).toEqual({
        generation: 1,
        kind: 'scrobble',
        dedupe_key: ITEM.listenKey,
      });

      deleteQueuedForwardIdentity(db, DID, ['scrobble'], ITEM.listenKey);
      expect(db.one('SELECT 1 FROM forward_outbox')).toBeNull();
      expect(db.one('SELECT 1 FROM forward_receipts')).toBeNull();
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 11, random: seededRandom(8) })).toBe(1);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
    });
  });

  it('keeps cleanup-retired coverage and lazily releases a rollback-era stale receipt', async () => {
    await withLink((db) => {
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 20, random: seededRandom(9) })).toBe(1);
      db.run("UPDATE forward_outbox SET state='sent' WHERE link_id=?", LINK.id);
      db.run('UPDATE forward_receipts SET retired_at_ms=21 WHERE link_id=?', LINK.id);
      db.run('DELETE FROM forward_outbox WHERE link_id=?', LINK.id);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('retired');
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 22, random: seededRandom(10) })).toBe(0);
      expect(db.one('SELECT retired_at_ms FROM forward_receipts WHERE link_id=?', LINK.id)).toEqual({
        retired_at_ms: 21,
      });

      db.run('DELETE FROM forward_receipts WHERE link_id=?', LINK.id);
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 23, random: seededRandom(11) })).toBe(1);
      db.run('DELETE FROM forward_outbox WHERE link_id=?', LINK.id);
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('stale');
      expect(enqueueForwards(db, { did: DID, items: [ITEM], now: 24, random: seededRandom(12) })).toBe(1);
      expect(
        db.one("SELECT value FROM counters WHERE name='link_coverage' AND label='receipt_stale_released'"),
      ).toEqual({
        value: 1,
      });
      expect(forwardCoverage(db, LINK, 'scrobble', ITEM.listenKey)).toBe('row');
    });
  });

  it('keeps receipts for final terminal outcomes, including expiry and rejection details', async () => {
    await withLink((db) => {
      const outcomes = [
        ['sent', null],
        ['ignored', 'ignored'],
        ['failed', 'retry_exhausted'],
        ['expired', 'aged_out'],
        ['expired', 'held_expired'],
        ['expired', 'authorization_conflicted'],
        ['expired', 'account_changed'],
      ] as const;
      for (let index = 0; index < outcomes.length; index++) {
        const key = `terminal-${index}`;
        const item = { ...ITEM, listenKey: key };
        expect(
          enqueueForwards(db, { did: DID, items: [item], now: 30 + index, random: seededRandom(30 + index) }),
        ).toBe(1);
        const [state, error] = outcomes[index]!;
        db.run(
          'UPDATE forward_outbox SET state=?,last_error=? WHERE link_id=? AND dedupe_key=?',
          state,
          error,
          LINK.id,
          key,
        );
        expect(forwardCoverage(db, LINK, 'scrobble', key)).toBe('row');
        expect(db.one('SELECT 1 FROM forward_receipts WHERE link_id=? AND dedupe_key=?', LINK.id, key)).not.toBeNull();
      }
    });
  });

  it('cascades receipts and gaps when a link is removed', async () => {
    await withLink((db) => {
      db.run(
        "INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms) VALUES(?,1,'love','cascade',1)",
        LINK.id,
      );
      db.run(
        "INSERT INTO forward_link_gaps(link_id,generation,from_seq,reason,opened_at_ms) VALUES(?,1,0,'disabled',1)",
        LINK.id,
      );
      db.run('DELETE FROM linked_accounts WHERE id=?', LINK.id);
      expect(db.one('SELECT 1 FROM forward_receipts')).toBeNull();
      expect(db.one('SELECT 1 FROM forward_link_gaps')).toBeNull();
    });
  });

  it('keeps receipt coverage equivalent through a deterministic 200-step enqueue and withdrawal sequence', async () => {
    await withLink((db) => {
      const invariant = () => {
        const rows = db.all<{ dedupe_key: string }>(
          "SELECT dedupe_key FROM forward_outbox WHERE link_id=? AND kind='scrobble'",
          LINK.id,
        );
        const receipts = db.all<{ dedupe_key: string; retired_at_ms: number | null }>(
          "SELECT dedupe_key,retired_at_ms FROM forward_receipts WHERE link_id=? AND generation=? AND kind='scrobble'",
          LINK.id,
          LINK.generation,
        );
        expect(
          receipts.every(
            (receipt) => receipt.retired_at_ms === null && rows.some((row) => row.dedupe_key === receipt.dedupe_key),
          ),
        ).toBe(true);
        expect(rows.every((row) => receipts.some((receipt) => receipt.dedupe_key === row.dedupe_key))).toBe(true);
      };

      for (let step = 0; step < 200; step++) {
        const key = `sequence-${step}`;
        const item = { ...ITEM, listenKey: key };
        expect(
          enqueueForwards(db, { did: DID, items: [item], now: 100 + step, random: seededRandom(1000 + step) }),
        ).toBe(1);
        if (step % 3 === 0) {
          db.run("UPDATE forward_outbox SET state='held' WHERE link_id=? AND dedupe_key=?", LINK.id, key);
          deleteQueuedForwardIdentity(db, DID, ['scrobble'], key);
          expect(
            enqueueForwards(db, { did: DID, items: [item], now: 500 + step, random: seededRandom(2000 + step) }),
          ).toBe(1);
        } else if (step % 3 === 1) {
          db.run("UPDATE forward_outbox SET state='sent' WHERE link_id=? AND dedupe_key=?", LINK.id, key);
          expect(
            enqueueForwards(db, { did: DID, items: [item], now: 500 + step, random: seededRandom(3000 + step) }),
          ).toBe(0);
        }
        invariant();
      }
    });
  });

  it('uses indexed production plans and keeps enqueue receipt statements constant with prior receipt growth', async () => {
    await withLink((db) => {
      const statements = [
        { sql: FORWARD_RECEIPT_LOOKUP_SQL, args: [LINK.id, LINK.generation, 'scrobble', 'missing'] },
        { sql: FORWARD_OUTBOX_COVERAGE_SQL, args: [LINK.id, 'scrobble', 'missing'] },
        {
          sql: releaseUnsentReceiptsSql(2),
          args: [LINK.id, LINK.generation, 'scrobble', 'love', 'missing', 'missing'],
        },
        { sql: GAP_ADMISSION_OWNER_SQL, args: [LINK.id, LINK.generation, 10, 10] },
        { sql: NEWEST_OPEN_LINK_GAP_SQL, args: [LINK.id, LINK.generation] },
        { sql: ADMISSION_HIGH_WATER_SQL, args: [] },
      ];
      for (const { sql, args } of statements) {
        const plan = db
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(args as SqlParam[]))
          .map((row) => row.detail);
        expect(plan.join(' '), sql).not.toMatch(/\bSCAN\b|TEMP B-TREE/i);
      }
      const negative = db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT dedupe_key FROM forward_receipts NOT INDEXED WHERE dedupe_key LIKE '%missing%'",
      );
      expect(negative.map((row) => row.detail).join(' ')).toMatch(/SCAN forward_receipts/i);

      const countReceiptStatements = (key: string, randomSeed: number) => {
        let count = 0;
        const traced: Db = {
          all<T>(sql: string, ...params: SqlParam[]): T[] {
            if (sql.includes('forward_receipts')) count++;
            return db.all<T>(sql, ...params);
          },
          one<T>(sql: string, ...params: SqlParam[]): T | null {
            if (sql.includes('forward_receipts')) count++;
            return db.one<T>(sql, ...params);
          },
          run(sql: string, ...params: SqlParam[]) {
            if (sql.includes('forward_receipts')) count++;
            return db.run(sql, ...params);
          },
          tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
            return db.tx(fn);
          },
        };
        enqueueForwards(traced, {
          did: DID,
          items: [{ ...ITEM, listenKey: key }],
          now: 900,
          random: seededRandom(randomSeed),
        });
        return count;
      };
      const smallCount = countReceiptStatements('small-prior-count', 900);
      for (let i = 0; i < 20; i++)
        db.run(
          "INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms) VALUES(?,1,'scrobble',?,?)",
          LINK.id,
          `prior-${i}`,
          i,
        );
      const grownCount = countReceiptStatements('grown-prior-count', 901);
      expect(smallCount).toBe(2);
      expect(grownCount).toBe(smallCount);
    });
  });
});
