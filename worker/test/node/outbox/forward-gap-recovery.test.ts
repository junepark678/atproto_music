import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fromMs } from '@atmusic/core/timestamp';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { reconcileSignInPolicy } from '../../../src/bff/reconcile';
import { createBox } from '../../../src/crypto/box';
import type { Db, SqlParam } from '../../../src/do/db';
import { readLiveEvidence, recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { runLinkBackfill } from '../../../src/forward/backfill';
import { openLinkGap, ownsAdmissionInGap } from '../../../src/forward/coverage';
import { expireRows, holdLinkRows, resumeHeldRows, settleRows } from '../../../src/forward/forward-outbox';
import { patchLink, revokeLink, saveLink } from '../../../src/forward/links';
import { lateAccept } from '../../../src/forward/live-acceptance';
import { storedForwardDedupeKey } from '../../../src/outbox/forward-key';
import { FORWARD_RECEIPT_LOOKUP_SQL } from '../../../src/outbox/forward-receipts';
import { acceptListens } from '../../../src/outbox/ingress';
import { cancelUnsent, insertOperation } from '../../../src/outbox/operations';
import { authorizedLiveOptions, fixtureScrobble, putProof } from '../../write/support';
import { type Harness, listenInput, T0, withHarness } from './support';

const box = createBox([{ id: 'e1', key: new Uint8Array(32).fill(60) }], {
  bytes: (size) => new Uint8Array(size).fill(3),
  float: () => 0,
});

async function accept(h: Harness, index: number) {
  const result = await acceptListens(h.m, {
    did: h.alice,
    origin: 'web',
    listens: [{ input: listenInput(index) }],
    receiptMs: T0,
  });
  const item = result.results[0];
  if (item?.status !== 'accepted' || item.listenKey === null || item.operationId === null)
    throw new Error(`listen ${index} was not accepted`);
  return { ...item, listenKey: item.listenKey, operationId: item.operationId };
}

async function publishAndProject(h: Harness, checkpoint?: () => void): Promise<void> {
  await h.runUntilIdle();
  checkpoint?.();
  for (const operation of h.ops("state='succeeded' AND kind='scrobble.create'")) {
    if (operation.collection === null || operation.rkey === null)
      throw new Error('published scrobble lacks record identity');
    const car = await h.kit.repos.Alice.getRecordCar(operation.collection, operation.rkey);
    const proof = await verifyRecordProof(car, {
      did: h.alice,
      collection: operation.collection,
      rkey: operation.rkey,
      signingKey: h.kit.users.Alice.key.didKey,
    });
    if (proof.state !== 'present') throw new Error(`expected published proof for ${operation.rkey}`);
    const nowNs = fromMs(T0);
    h.db.tx(() =>
      applyRecordProof(h.db, proof, {
        prefix: 'com.example.atmusic',
        nowNs,
        receiptNs: nowNs,
        live: authorizedLiveOptions(h.db, proof, h.m.random).live,
      }),
    );
    checkpoint?.();
  }
}

function saveSameLink(h: Harness, remoteUser = 'recovery') {
  return saveLink(
    { db: h.db, clock: h.m.clock, random: h.m.random, box },
    { did: h.alice, service: 'listenbrainz', remoteUser, credential: 'test-token' },
  );
}

async function drainBackfill(h: Harness) {
  let work = 0;
  for (let index = 0; index < 10; index++) work += await runLinkBackfill(h.db, h.m.random, T0);
  return work;
}

describe('forward coverage gap recovery', () => {
  it('recovers admissions from a pre-55 revoked link after real publish, reopen, and same-account relink', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const created = saveSameLink(h);
      h.db.run("UPDATE linked_accounts SET status='revoked',backfill_state='done' WHERE id=?", created.link.id);

      const accepted = await accept(h, 31);
      expect(accepted.listenKey).toBeTruthy();
      await publishAndProject(h);
      h.restart();
      const relinked = saveSameLink(h);
      expect(relinked.link).toMatchObject({ id: created.link.id, generation: 1, status: 'active' });
      await drainBackfill(h);

      expect(
        h.db.one(
          'SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          created.link.id,
          accepted.listenKey,
        ),
      ).toEqual({ n: 1 });
      expect(
        h.db.all(
          'SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq',
          created.link.id,
        ),
      ).toEqual([{ from_seq: 0, to_seq: 1, reason: 'legacy' }]);
    });
  });

  it('preserves one revoked interval through disabled flag toggles and recovers both accepted listens', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const created = saveSameLink(h);
      expect(revokeLink(h.db, created.link, 'credential_revoked', T0)).toBe(true);
      const first = await accept(h, 32);
      await publishAndProject(h);
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, created.link.id, { forwardScrobbles: false });
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, created.link.id, { forwardScrobbles: true });
      const second = await accept(h, 33);
      await publishAndProject(h);
      h.restart();
      saveSameLink(h);
      await drainBackfill(h);

      expect(
        h.db
          .all<{ dedupe_key: string }>(
            'SELECT dedupe_key FROM forward_outbox WHERE link_id=? ORDER BY dedupe_key',
            created.link.id,
          )
          .map((row) => row.dedupe_key)
          .sort(),
      ).toEqual([first.listenKey, second.listenKey].sort());
      expect(
        h.db.all(
          'SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq',
          created.link.id,
        ),
      ).toEqual([{ from_seq: 0, to_seq: 2, reason: 'revoked' }]);
    });
  });

  it('keeps one interval across disabled-then-revoked transitions and journals bulk revokes independently', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const created = saveSameLink(h);
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, created.link.id, { forwardScrobbles: false });
      const first = await accept(h, 34);
      await publishAndProject(h);
      expect(revokeLink(h.db, created.link, 'credential_revoked', T0)).toBe(true);
      const second = await accept(h, 35);
      await publishAndProject(h);
      saveSameLink(h); // remains disabled, so the revocation interval must stay open
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, created.link.id, { forwardScrobbles: true });
      await drainBackfill(h);

      expect(
        h.db
          .all<{ dedupe_key: string }>(
            'SELECT dedupe_key FROM forward_outbox WHERE link_id=? ORDER BY dedupe_key',
            created.link.id,
          )
          .map((row) => row.dedupe_key)
          .sort(),
      ).toEqual([first.listenKey, second.listenKey].sort());
      expect(h.db.all('SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=?', created.link.id)).toEqual([
        { from_seq: 0, to_seq: 2 },
      ]);

      const bulkLink = saveSameLink(h).link;
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, bulkLink.id, { forwardScrobbles: false });
      const revocations = new MemoryRevocations(h.m.clock);
      await reconcileSignInPolicy(
        {
          db: h.db,
          clock: h.m.clock,
          log: h.m.log,
          revocations,
          oauth: { revoke: async () => 'revoked' },
        },
        { signinPolicy: 'allowlist', signinDids: [] },
      );
      expect(h.db.one('SELECT status FROM linked_accounts WHERE id=?', bulkLink.id)).toEqual({ status: 'revoked' });
      expect(revocations.entries()).toContainEqual({ kind: 'linked_account', id: bulkLink.id, did: h.alice, at: T0 });
      expect(
        h.db.all('SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', bulkLink.id),
      ).toEqual([
        { from_seq: 0, to_seq: 2 },
        { from_seq: 2, to_seq: null },
      ]);
    });
  });

  it('uses the durable admission clock after a cancelled admission is released', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const link = saveSameLink(h).link;
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: false });
      const cancelled = await accept(h, 36);
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: true });
      expect(cancelUnsent(h.db, cancelled.operationId, T0)).toBe(true);
      expect(h.db.one('SELECT max(admission_seq) AS maximum FROM forward_admissions')).toEqual({ maximum: null });
      expect(h.db.one('SELECT next_seq FROM forward_admission_clock WHERE singleton=1')).toEqual({ next_seq: 1 });

      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: false });
      const accepted = await accept(h, 37);
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: true });
      await publishAndProject(h);
      h.restart();
      saveSameLink(h);
      await drainBackfill(h);

      expect(
        h.db.one(
          'SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          link.id,
          accepted.listenKey,
        ),
      ).toEqual({ n: 1 });
      expect(
        h.db.all('SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', link.id),
      ).toEqual([
        { from_seq: 0, to_seq: 1 },
        { from_seq: 1, to_seq: 2 },
      ]);
    });
  });

  it('does no gap reconciliation without selected work and touches only the selected link', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const selected = saveSameLink(h).link;
      h.db.run("UPDATE linked_accounts SET backfill_state='done' WHERE id=?", selected.id);
      openLinkGap(h.db, selected, 'disabled', T0, 0);
      for (let index = 0; index < 20; index++) {
        const did = `did:plc:coverage${String(index).padStart(20, '0')}`;
        const id = `done-coverage-${index}`;
        h.db.run(
          "INSERT INTO users(did,joined_at,active,account_status,indexing_state,generation) VALUES(?,?,1,'active','current',?)",
          did,
          T0,
          index + 1,
        );
        h.db.run(
          `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,status,forward_scrobbles,
             generation,generation_start_seq,created_at_ms,updated_at_ms,backfill_state,pull_enabled)
           VALUES(?,?,'lastfm',?,X'00','fixture','active',1,1,0,1,1,'done',0)`,
          id,
          did,
          `remote-${index}`,
        );
        h.db.run(
          `INSERT INTO forward_link_gaps(link_id,generation,from_seq,reason,opened_at_ms)
           VALUES(?,1,0,'disabled',1)`,
          id,
        );
      }

      const gapStatements: Array<{ sql: string; params: SqlParam[] }> = [];
      const traced: Db = {
        all<T>(sql: string, ...params: SqlParam[]): T[] {
          if (sql.includes('forward_link_gaps')) gapStatements.push({ sql, params });
          return h.db.all<T>(sql, ...params);
        },
        one<T>(sql: string, ...params: SqlParam[]): T | null {
          if (sql.includes('forward_link_gaps')) gapStatements.push({ sql, params });
          return h.db.one<T>(sql, ...params);
        },
        run(sql: string, ...params: SqlParam[]) {
          if (sql.includes('forward_link_gaps')) gapStatements.push({ sql, params });
          return h.db.run(sql, ...params);
        },
        tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
          return h.db.tx(fn);
        },
      };

      expect(await runLinkBackfill(traced, h.m.random, T0)).toBe(0);
      expect(gapStatements).toEqual([]);
      expect(h.db.one('SELECT count(*) AS n FROM forward_link_gaps WHERE to_seq IS NULL')).toEqual({ n: 21 });

      h.db.run("UPDATE linked_accounts SET backfill_state='pending' WHERE id=?", selected.id);
      gapStatements.length = 0;
      await runLinkBackfill(traced, h.m.random, T0);
      expect(gapStatements.length).toBeGreaterThan(0);
      expect(gapStatements.every(({ params }) => params.includes(selected.id))).toBe(true);
      expect(h.db.one('SELECT 1 FROM forward_link_gaps WHERE link_id=? AND to_seq IS NULL', selected.id)).toBeNull();
      expect(h.db.one('SELECT count(*) AS n FROM forward_link_gaps WHERE to_seq IS NULL')).toEqual({ n: 20 });
    });
  });

  it('checks receipt and row invariants through mixed production settlement and same-link rotation', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const link = saveSameLink(h).link;
      type Expected = { payload: unknown; state: string; attempts: number; last_error: string | null };
      const expected = new Map<string, Expected>();
      const identity = (generation: number, kind: string, storedKey: string) =>
        JSON.stringify([generation, kind, storedKey]);
      const assertCoverage = () => {
        const receipts = h.db.all<{
          generation: number;
          kind: string;
          dedupe_key: string;
          retired_at_ms: number | null;
        }>('SELECT generation,kind,dedupe_key,retired_at_ms FROM forward_receipts WHERE link_id=?', link.id);
        const rows = h.db.all<{
          generation: number;
          kind: string;
          dedupe_key: string;
          state: string;
          attempts: number;
          last_error: string | null;
          payload_json: string;
        }>(
          'SELECT generation,kind,dedupe_key,state,attempts,last_error,payload_json FROM forward_outbox WHERE link_id=?',
          link.id,
        );
        for (const receipt of receipts) {
          const tuple = identity(
            receipt.generation,
            receipt.kind,
            storedForwardDedupeKey(receipt.generation, receipt.dedupe_key),
          );
          expect(expected.has(tuple), `unexpected receipt ${tuple}`).toBe(true);
          const matches = rows.filter((row) => identity(row.generation, row.kind, row.dedupe_key) === tuple);
          if (receipt.retired_at_ms === null) expect(matches, `live receipt ${tuple}`).toHaveLength(1);
        }
        for (const row of rows) {
          const tuple = identity(row.generation, row.kind, row.dedupe_key);
          expect(
            receipts.filter(
              (receipt) =>
                identity(
                  receipt.generation,
                  receipt.kind,
                  storedForwardDedupeKey(receipt.generation, receipt.dedupe_key),
                ) === tuple,
            ),
            `receipt for ${tuple}`,
          ).toHaveLength(1);
          const wanted = expected.get(tuple);
          expect(wanted, `unexpected forward row ${tuple}`).toBeDefined();
          expect(JSON.parse(row.payload_json), tuple).toEqual(wanted!.payload);
          expect({ state: row.state, attempts: row.attempts, last_error: row.last_error }, tuple).toEqual({
            state: wanted!.state,
            attempts: wanted!.attempts,
            last_error: wanted!.last_error,
          });
        }
      };
      const trackedAccept = async (index: number, generation = 1) => {
        const item = await accept(h, index);
        const tuple = identity(generation, 'scrobble', storedForwardDedupeKey(generation, item.listenKey));
        expected.set(tuple, {
          payload: { listen: listenInput(index), origin: 'web' },
          state: 'queued',
          attempts: 0,
          last_error: null,
        });
        assertCoverage();
        return { ...item, tuple };
      };
      const transition = (tuple: string, state: string, attempts: number, last_error: string | null = null) => {
        expected.set(tuple, { ...expected.get(tuple)!, state, attempts, last_error });
      };

      const cancelled = await trackedAccept(45);
      expect(cancelUnsent(h.db, cancelled.operationId, T0 + 1)).toBe(true);
      expected.delete(cancelled.tuple);
      expect(
        h.db.one('SELECT 1 FROM forward_outbox WHERE link_id=? AND dedupe_key=?', link.id, cancelled.listenKey),
      ).toBeNull();
      expect(
        h.db.one('SELECT 1 FROM forward_receipts WHERE link_id=? AND dedupe_key=?', link.id, cancelled.listenKey),
      ).toBeNull();
      assertCoverage();

      const finish = async (index: number, terminal: 'sent' | 'ignored' | 'failed') => {
        const item = await trackedAccept(index);
        await publishAndProject(h, assertCoverage);
        const row = h.db.one<{ id: string }>(
          'SELECT id FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          link.id,
          item.listenKey,
        )!;
        expect(row).not.toBeNull();
        const error = terminal === 'ignored' ? 'ignored' : terminal === 'failed' ? 'retry_exhausted' : null;
        transition(item.tuple, terminal, 1, error);
        settleRows(h.db, [row.id], terminal, T0 + index, error, true, link.generation);
        assertCoverage();
        return { item, row };
      };
      await finish(46, 'sent');
      await finish(47, 'ignored');
      const failed = await finish(48, 'failed');

      const held = await trackedAccept(49);
      await publishAndProject(h, assertCoverage);
      transition(held.tuple, 'held', 0);
      expect(holdLinkRows(h.db, link.id, T0 + 49, link.generation)).toBeGreaterThan(0);
      assertCoverage();
      transition(held.tuple, 'queued', 0);
      expect(resumeHeldRows(h.db, link.id, T0 + 50, link.generation)).toBeGreaterThan(0);
      assertCoverage();
      transition(held.tuple, 'held', 0);
      expect(holdLinkRows(h.db, link.id, T0 + 51, link.generation)).toBeGreaterThan(0);
      assertCoverage();
      h.db.run('UPDATE forward_outbox SET updated_at_ms=0 WHERE link_id=? AND dedupe_key=?', link.id, held.listenKey);
      assertCoverage();
      transition(held.tuple, 'expired', 0, 'held_expired');
      expect(expireRows(h.db, T0 + 31 * 24 * 60 * 60 * 1000).held).toBeGreaterThan(0);
      assertCoverage();

      const pending = await trackedAccept(51);
      await publishAndProject(h, assertCoverage);
      const oldRow = h.db.one<{ id: string }>(
        'SELECT id FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
        link.id,
        pending.listenKey,
      )!;
      const rotated = saveSameLink(h, 'recovery-rotated').link;
      expect(rotated).toMatchObject({ id: link.id, generation: 2, remote_user: 'recovery-rotated' });
      transition(pending.tuple, 'expired', 0, 'account_changed');
      assertCoverage();
      // This old row is already terminal: its queued-state guard is sufficient.
      settleRows(h.db, [oldRow.id], 'sent', T0 + 60, null, true, link.generation);
      assertCoverage();
      expect(h.db.one('SELECT state,last_error FROM forward_outbox WHERE id=?', failed.row.id)).toEqual({
        state: 'failed',
        last_error: 'retry_exhausted',
      });
      expect(h.db.one('SELECT count(*) AS n FROM forward_receipts WHERE link_id=? AND generation=1', link.id)).toEqual({
        n: 5,
      });
      expect(h.db.one('SELECT count(*) AS n FROM forward_receipts WHERE link_id=? AND generation=2', link.id)).toEqual({
        n: 0,
      });

      const current = await trackedAccept(50, 2);
      await publishAndProject(h, assertCoverage);
      const gen2Row = h.db.one<{ id: string; dedupe_key: string }>(
        'SELECT id,dedupe_key FROM forward_outbox WHERE link_id=? AND generation=2 AND did=?',
        link.id,
        h.alice,
      )!;
      expect(gen2Row.dedupe_key).toBe(`g2:${current.listenKey}`);
      // An adversarial settlement argument exercises the generation fence on a
      // live queued row; it does not claim an old job actually owns this new ID.
      settleRows(h.db, [gen2Row.id], 'sent', T0 + 61, null, true, link.generation);
      assertCoverage();
      transition(current.tuple, 'sent', 1);
      settleRows(h.db, [gen2Row.id], 'sent', T0 + 62, null, true, rotated.generation);
      assertCoverage();
    });
  });

  it('stops imported and consumed late-accept candidates before receipt lookup', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      saveSameLink(h);
      const prepareCandidate = async (rkey: string) => {
        const proof = await putProof(
          h.kit.repos.Alice,
          'com.example.atmusic.scrobble',
          rkey,
          fixtureScrobble(rkey === 'late-import' ? 'r02' : 'r03'),
        );
        if (proof.state !== 'present') throw new Error('expected signed present proof');
        const uri = `at://${h.alice}/com.example.atmusic.scrobble/${rkey}`;
        const args = {
          uri,
          did: h.alice,
          collection: 'com.example.atmusic.scrobble',
          rkey,
          nowMs: T0,
          random: h.m.random,
        };
        h.db.tx(() =>
          applyRecordProof(h.db, proof, {
            prefix: 'com.example.atmusic',
            nowNs: fromMs(T0),
            receiptNs: fromMs(T0),
            live: { random: h.m.random, evidence: null, legacyRev: null },
            liveCandidates: true,
          }),
        );
        h.db.tx(() =>
          recordLiveEvidence(
            h.db,
            {
              uri,
              did: h.alice,
              collection: args.collection,
              rkey,
              rev: proof.commit.rev,
              action: 'create',
              cid: proof.cid,
            },
            T0,
          ),
        );
        return { args, evidence: readLiveEvidence(h.db, uri, T0) };
      };

      const imported = await prepareCandidate('late-import');
      insertOperation(
        h.db,
        {
          id: 'import-late-candidate',
          did: h.alice,
          kind: 'scrobble.create',
          origin: 'import',
          collection: imported.args.collection,
          rkey: imported.args.rkey,
          dueAt: T0,
        },
        T0,
      );
      expect(lateAccept(h.db, { ...imported.args, evidence: imported.evidence })).toBe(0);
      expect(h.db.all('SELECT 1 FROM forward_outbox')).toEqual([]);

      const cleanup = await prepareCandidate('late-cleanup');
      expect(lateAccept(h.db, { ...cleanup.args, evidence: cleanup.evidence })).toBe(1);
      const row = h.db.one<{ link_id: string; dedupe_key: string }>('SELECT link_id,dedupe_key FROM forward_outbox');
      expect(row).not.toBeNull();
      h.db.run(
        'UPDATE forward_receipts SET retired_at_ms=? WHERE link_id=? AND dedupe_key=?',
        T0 + 1,
        row!.link_id,
        row!.dedupe_key,
      );
      h.db.run('DELETE FROM forward_outbox WHERE link_id=? AND dedupe_key=?', row!.link_id, row!.dedupe_key);
      const originalOne = h.db.one.bind(h.db);
      let receiptLookups = 0;
      h.db.one = <T>(sql: string, ...params: SqlParam[]): T | null => {
        if (sql === FORWARD_RECEIPT_LOOKUP_SQL) receiptLookups++;
        return originalOne<T>(sql, ...params);
      };
      try {
        expect(lateAccept(h.db, { ...cleanup.args, evidence: cleanup.evidence })).toBe(0);
        // The acceptance candidate was consumed on the first call, so the receipt layer is unreachable here.
        expect(receiptLookups).toBe(0);
      } finally {
        h.db.one = originalOne;
      }
      expect(
        h.db.one(
          'SELECT retired_at_ms FROM forward_receipts WHERE link_id=? AND dedupe_key=?',
          row!.link_id,
          row!.dedupe_key,
        ),
      ).toEqual({
        retired_at_ms: T0 + 1,
      });
    });
  });

  it('settles a rollback-stale interval on disable before backfill can select it', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.account(h.alice);
      const link = saveSameLink(h).link;
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: false });
      const disabled = await accept(h, 38);
      await publishAndProject(h);

      // Exact supported schema-54 re-enable shape: flag and floor reset, old gap left open.
      h.db.run(
        "UPDATE linked_accounts SET forward_scrobbles=1,generation_start_seq=1,backfill_state='pending' WHERE id=?",
        link.id,
      );
      const enabled = await accept(h, 39);
      await publishAndProject(h);
      expect(
        h.db.one(
          'SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND dedupe_key=?',
          link.id,
          enabled.listenKey,
        ),
      ).toEqual({ n: 1 });

      // The current producer disables before backfill selects and settles the stale interval.
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: false });
      const afterDisable = await accept(h, 40);
      await publishAndProject(h);
      patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: true });

      expect(disabled.listenKey).not.toBe(enabled.listenKey);
      expect(afterDisable.listenKey).not.toBe(enabled.listenKey);
      expect(
        h.db.all('SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', link.id),
      ).toEqual([
        { from_seq: 0, to_seq: 1 },
        { from_seq: 2, to_seq: 3 },
      ]);
      expect(ownsAdmissionInGap(h.db, link, 2)).toBe(false);
      expect(ownsAdmissionInGap(h.db, link, 3)).toBe(true);
    });
  });

  it('settles a rollback-stale interval on credential and bulk policy revocation', async () => {
    for (const mode of ['credential', 'bulk'] as const) {
      await withHarness(async (h) => {
        h.seedUser(h.alice);
        h.account(h.alice);
        const link = saveSameLink(h).link;
        patchLink({ db: h.db, clock: h.m.clock }, h.alice, link.id, { forwardScrobbles: false });
        await accept(h, mode === 'credential' ? 41 : 43);
        await publishAndProject(h);
        h.db.run(
          "UPDATE linked_accounts SET forward_scrobbles=1,generation_start_seq=1,backfill_state='pending' WHERE id=?",
          link.id,
        );
        const enabled = await accept(h, mode === 'credential' ? 42 : 44);
        await publishAndProject(h);

        if (mode === 'credential') {
          expect(revokeLink(h.db, link, 'credential_revoked', T0)).toBe(true);
        } else {
          const revocations = new MemoryRevocations(h.m.clock);
          await reconcileSignInPolicy(
            {
              db: h.db,
              clock: h.m.clock,
              log: h.m.log,
              revocations,
              oauth: { revoke: async () => 'revoked' },
            },
            { signinPolicy: 'allowlist', signinDids: [] },
          );
          expect(h.db.one('SELECT status FROM linked_accounts WHERE id=?', link.id)).toEqual({ status: 'revoked' });
        }
        const admittedSeq = h.db.one<{ admission_seq: number }>(
          'SELECT admission_seq FROM forward_admissions WHERE did=? AND identity_key=?',
          h.alice,
          enabled.listenKey,
        )?.admission_seq;
        expect(admittedSeq).toBeDefined();
        expect(ownsAdmissionInGap(h.db, link, admittedSeq!)).toBe(false);
        expect(
          h.db.all('SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', link.id),
        ).toEqual([
          { from_seq: 0, to_seq: 1 },
          { from_seq: 2, to_seq: null },
        ]);
      });
    }
  });
});
