import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import { ADMISSION_HIGH_WATER_SQL, GAP_ADMISSION_OWNER_SQL, NEWEST_LINK_GAP_SQL } from '../../../src/forward/coverage';
import {
  expireRows,
  holdLinkRows,
  resumeHeldRows,
  settleRows,
  settleRowsReturning,
} from '../../../src/forward/forward-outbox';
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

describe('settlement returning contract', () => {
  it('returns only generation-fenced changed rows and preserves the SENT ledger', async () => {
    await withLink((db) => {
      enqueueForwards(db, {
        did: DID,
        items: [{ kind: 'love', operationId: 'returning-love', payload: { artist: 'Artist', track: 'Track' } }],
        now: 100,
        random: seededRandom(7),
      });
      const row = db.one<{ id: string; generation: number }>(
        'SELECT id,generation FROM forward_outbox WHERE link_id=?',
        LINK.id,
      )!;
      const observed: string[] = [];
      expect(
        settleRowsReturning(db, [row.id, 'missing-id'], 'sent', 101, null, true, row.generation, (rows) => {
          observed.push(...rows.map((changed) => changed.id));
        }),
      ).toEqual([
        expect.objectContaining({
          id: row.id,
          link_id: LINK.id,
          generation: row.generation,
          did: DID,
          kind: 'love',
          state: 'sent',
        }),
      ]);
      expect(observed).toEqual([row.id]);
      expect(db.one('SELECT last_sent_kind FROM forward_love_delivery WHERE link_id=?', LINK.id)).toEqual({
        last_sent_kind: 'love',
      });
      expect(settleRowsReturning(db, [row.id], 'failed', 102, null, true, row.generation)).toEqual([]);
    });
  });

  it('passes age and held expiry rows through the same synchronous contract', async () => {
    await withLink((db) => {
      enqueueForwards(db, { did: DID, items: [ITEM], now: 1, random: seededRandom(8) });
      const observed: Array<{ id: string; state: string }> = [];
      const report = expireRows(db, 15 * 24 * 60 * 60 * 1000, (rows) => {
        observed.push(...rows.map((changed) => ({ id: changed.id, state: changed.state })));
      });
      expect(report.aged).toBe(1);
      expect(observed).toEqual([{ id: db.one<{ id: string }>('SELECT id FROM forward_outbox')?.id, state: 'expired' }]);
    });
  });
});

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

  it('keeps receipt parity through production settlement, hold, resume, expiry, and generation fencing', async () => {
    await withLink((db) => {
      const add = (key: string, now: number) => {
        expect(
          enqueueForwards(db, { did: DID, items: [{ ...ITEM, listenKey: key }], now, random: seededRandom(now) }),
        ).toBe(1);
        return db.one<{ id: string }>('SELECT id FROM forward_outbox WHERE link_id=? AND dedupe_key=?', LINK.id, key)!
          .id;
      };

      const sent = add('machine-sent', 100);
      settleRows(db, [sent], 'sent', 101, null, true, LINK.generation);
      expect(forwardCoverage(db, LINK, 'scrobble', 'machine-sent')).toBe('row');

      const ignored = add('machine-ignored', 102);
      settleRows(db, [ignored], 'ignored', 103, 'ignored', true, LINK.generation);
      expect(forwardCoverage(db, LINK, 'scrobble', 'machine-ignored')).toBe('row');

      const failed = add('machine-failed', 104);
      settleRows(db, [failed], 'failed', 105, 'retry_exhausted', true, LINK.generation);
      expect(forwardCoverage(db, LINK, 'scrobble', 'machine-failed')).toBe('row');

      const held = add('machine-held', 106);
      expect(holdLinkRows(db, LINK.id, 107, LINK.generation)).toBe(1);
      expect(db.one('SELECT state FROM forward_outbox WHERE id=?', held)).toEqual({ state: 'held' });
      expect(forwardCoverage(db, LINK, 'scrobble', 'machine-held')).toBe('row');
      expect(resumeHeldRows(db, LINK.id, 108, LINK.generation)).toBe(1);
      expect(db.one('SELECT state FROM forward_outbox WHERE id=?', held)).toEqual({ state: 'queued' });

      const expired = add('machine-expired', 109);
      db.run(
        'UPDATE forward_outbox SET created_at_ms=?,due_at=? WHERE link_id=?',
        2 * 24 * 60 * 60 * 1000,
        2 * 24 * 60 * 60 * 1000,
        LINK.id,
      );
      db.run('UPDATE forward_outbox SET created_at_ms=0,due_at=0 WHERE id=?', expired);
      expect(expireRows(db, 14 * 24 * 60 * 60 * 1000).aged).toBe(1);
      expect(forwardCoverage(db, LINK, 'scrobble', 'machine-expired')).toBe('row');

      db.run(
        "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,created_at_ms,updated_at_ms) VALUES('next-gen',?,'listenbrainz','remote-2',X'00','key',2,1,1)",
        DID,
      );
      expect(
        enqueueForwards(db, {
          did: DID,
          items: [{ ...ITEM, listenKey: 'same-logical-key' }],
          now: 110,
          random: seededRandom(110),
        }),
      ).toBe(2);
      expect(
        db.all(
          'SELECT link_id,generation FROM forward_receipts WHERE dedupe_key=? ORDER BY link_id',
          'same-logical-key',
        ),
      ).toEqual([
        { link_id: LINK.id, generation: 1 },
        { link_id: 'next-gen', generation: 2 },
      ]);
      expect(forwardCoverage(db, { id: 'next-gen', generation: 2 }, 'scrobble', 'same-logical-key')).toBe('row');
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
        { sql: GAP_ADMISSION_OWNER_SQL, args: [LINK.id, LINK.generation, 10] },
        { sql: NEWEST_LINK_GAP_SQL, args: [LINK.id, LINK.generation] },
        { sql: ADMISSION_HIGH_WATER_SQL, args: [] },
      ];
      for (const { sql, args } of statements) {
        const plan = db
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(args as SqlParam[]))
          .map((row) => row.detail);
        expect(plan.join(' '), sql).not.toMatch(/\bSCAN (?!CONSTANT ROW)|TEMP B-TREE/i);
      }
      const negative = db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT dedupe_key FROM forward_receipts NOT INDEXED WHERE dedupe_key LIKE '%missing%'",
      );
      expect(negative.map((row) => row.detail).join(' ')).toMatch(/SCAN forward_receipts/i);

      const countReceiptStatements = (key: string, randomSeed: number, linkId = LINK.id) => {
        let receiptStatements = 0;
        let outboxCoverageLookups = 0;
        let receiptMutationRows = 0;
        let outboxMutationRows = 0;
        const countSql = (sql: string) => {
          if (sql.includes('forward_receipts') || sql.includes('link_coverage') || sql === FORWARD_OUTBOX_COVERAGE_SQL)
            receiptStatements++;
          if (sql === FORWARD_OUTBOX_COVERAGE_SQL) outboxCoverageLookups++;
        };
        const traced: Db = {
          all<T>(sql: string, ...params: SqlParam[]): T[] {
            countSql(sql);
            return db.all<T>(sql, ...params);
          },
          one<T>(sql: string, ...params: SqlParam[]): T | null {
            countSql(sql);
            return db.one<T>(sql, ...params);
          },
          run(sql: string, ...params: SqlParam[]) {
            countSql(sql);
            const result = db.run(sql, ...params);
            if (sql.includes('forward_receipts') || sql.includes('link_coverage'))
              receiptMutationRows += result.rowsWritten;
            if (sql.startsWith('INSERT INTO forward_outbox')) outboxMutationRows += result.rowsWritten;
            return result;
          },
          tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
            return db.tx(fn);
          },
        };
        const created = enqueueForwards(traced, {
          did: DID,
          items: [{ ...ITEM, listenKey: key }],
          now: 900,
          random: seededRandom(randomSeed),
          linkId,
        });
        return { receiptStatements, outboxCoverageLookups, receiptMutationRows, outboxMutationRows, created };
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
      expect(smallCount).toEqual({
        receiptStatements: 3,
        outboxCoverageLookups: 1,
        receiptMutationRows: 1,
        outboxMutationRows: 1,
        created: 1,
      });
      expect(grownCount).toEqual(smallCount);
      expect(countReceiptStatements('small-prior-count', 904)).toEqual({
        receiptStatements: 3,
        outboxCoverageLookups: 1,
        receiptMutationRows: 0,
        outboxMutationRows: 0,
        created: 0,
      });

      db.run(
        "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,created_at_ms,updated_at_ms) VALUES('next-gen',?,'listenbrainz','remote-2',X'00','key',2,1,1)",
        DID,
      );
      expect(countReceiptStatements('new-generation-key', 905, 'next-gen')).toEqual({
        receiptStatements: 3,
        outboxCoverageLookups: 1,
        receiptMutationRows: 1,
        outboxMutationRows: 1,
        created: 1,
      });

      db.run(
        "INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms) VALUES(?,1,'scrobble','stale-count',1)",
        LINK.id,
      );
      const stale = countReceiptStatements('stale-count', 902);
      expect(stale).toEqual({
        receiptStatements: 5,
        outboxCoverageLookups: 1,
        receiptMutationRows: 3,
        outboxMutationRows: 1,
        created: 1,
      });

      db.run(
        "INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms,retired_at_ms) VALUES(?,1,'scrobble','retired-count',1,2)",
        LINK.id,
      );
      const retired = countReceiptStatements('retired-count', 903);
      expect(retired).toEqual({
        receiptStatements: 2,
        outboxCoverageLookups: 1,
        receiptMutationRows: 0,
        outboxMutationRows: 0,
        created: 0,
      });
    });
  });
});
